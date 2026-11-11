import { uuid } from '../hyperfy/src/core/utils.js'
import { cloneDeep } from 'lodash-es'
import { importApp } from '../hyperfy/src/core/extras/appTools.js'
import { hashFile } from '../hyperfy/src/core/utils-client.js'
import { resolveUrl } from "../utils.js";
import { SceneEditStopped } from "../lib/authorization";
import { describeUrl } from "../lib/log-url";
import { MAX_MODEL_BYTES, SafeFetchError, worldNet } from "../lib/net-policy";
import type { MoveOutcome } from "../systems/controls";
import { outgoingPacketProblem } from "../lib/world-protocol";

const IMPORT_DOWNLOAD_TIMEOUT_MS = 60_000;

/**
 * How many bytes an import may download: the operator's cap for models, lowered by the world's
 * own upload limit (megabytes; the world sends it as it is configured, usually a string). A world
 * can only lower it. A limit that is missing or not a number means the operator's cap alone.
 */
export function importByteCap(worldMaxUploadMb: unknown): number {
  const mb = typeof worldMaxUploadMb === 'number' ? worldMaxUploadMb : typeof worldMaxUploadMb === 'string' && worldMaxUploadMb.trim() !== '' ? Number(worldMaxUploadMb) : NaN;
  if (!Number.isFinite(mb)) return MAX_MODEL_BYTES;
  return Math.min(MAX_MODEL_BYTES, Math.max(0, Math.floor(mb * 1024 * 1024)));
}

/**
 * What one scene edit request may act on: the world it was authorized for, a check that throws
 * SceneEditStopped once that authorization no longer holds (the turn was cancelled or its
 * connection ended, or the requester may no longer build). Every method acts only on `world` and
 * calls `check()` right before each effect on it (walking there, changing or adding entities,
 * each upload request), which also covers every await before that effect.
 */
export interface EditGuard {
  readonly world: any;
  check(): void;
  /** The request's turn: a walk the edit started stops when it fires. */
  readonly signal?: AbortSignal;
}

/** What one operation did: only `applied` changed the world. `newId`: the entity a duplicate made. */
export type EditResult =
  | { outcome: 'applied'; newId?: string }
  | { outcome: 'skipped'; reason: string }
  | { outcome: 'failed'; reason: string };

const applied: EditResult = { outcome: 'applied' };

/**
 * Why announcing a new app (its blueprint, when it has one of its own, and its entity) would not
 * reach the world, or null: the world drops a packet unread that is over its size, value or depth
 * limit or holds a value its scan refuses (lib/world-protocol.ts outgoingPacketProblem). Asked
 * before anything is added locally, so an edit that cannot reach the world changes nothing here
 * either.
 */
function announcementProblem(blueprint: unknown, entity: unknown): string | null {
  return (blueprint ? outgoingPacketProblem('blueprintAdded', blueprint) : null) ?? outgoingPacketProblem('entityAdded', entity);
}
const skipped = (reason: string): EditResult => ({ outcome: 'skipped', reason });
const failed = (reason: string): EditResult => ({ outcome: 'failed', reason });

const numbers = (value: unknown, length: number): value is number[] =>
  Array.isArray(value) && value.length === length && value.every((n) => typeof n === 'number' && Number.isFinite(n));

// What coo-world accepts in an app's entityAdded and entityModified (src/core/extras/entityModifyPolicy.js)
const TRANSFORM_LIMIT = 1e6;
const QUATERNION_NORM_TOLERANCE = 0.1;
type TransformField = 'position' | 'quaternion' | 'scale';
const ACCEPTED: Record<TransformField, string> = {
  position: 'three finite numbers within ±1e6',
  quaternion: 'four finite numbers of length 1 (±0.1)',
  scale: 'three finite numbers, none of them zero',
};

/**
 * `value` as the world's server would store it for `field` (a quaternion normalized), or null when
 * the server would drop it: then the change would show here and nowhere else.
 */
export function acceptedTransform(field: TransformField, value: unknown): number[] | null {
  if (field === 'quaternion') {
    if (!numbers(value, 4)) return null;
    const norm = Math.hypot(...value);
    return Number.isFinite(norm) && Math.abs(norm - 1) <= QUATERNION_NORM_TOLERANCE ? value.map((v) => v / norm) : null;
  }
  if (!numbers(value, 3)) return null;
  if (field === 'position') return value.every((v) => Math.abs(v) <= TRANSFORM_LIMIT) ? value : null;
  // A scale that vanishes or overflows as a 32-bit float
  return value.every((v) => Number.isFinite(Math.fround(v)) && Math.fround(v) !== 0) ? value : null;
}

/** Where an imported app is put: values acceptedTransform passed */
interface PlacedAt {
  position: number[];
  quaternion: number[];
}

const invalid = (field: TransformField) => failed(`invalid ${field} (${ACCEPTED[field]})`);

/** Why an edit whose walk did not arrive is not made (systems/controls.ts MoveOutcome) */
const NOT_THERE: Record<Exclude<MoveOutcome, 'arrived'>, string> = {
  stopped: 'I was stopped on the way there',
  replaced: 'I was sent somewhere else on the way there',
  cancelled: 'the walk there was cancelled',
  'timed-out': 'I could not get there in time',
  unreachable: 'I could not find a way there',
};

/** What coo-world's isBlueprintURL (src/core/extras/assetURL.js) accepts: asset://<one file name> or an http(s) URL. */
function blueprintReference(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (value.startsWith('asset://')) {
    const name = value.slice('asset://'.length);
    return /^[A-Za-z0-9._-]{1,128}$/.test(name) && name !== '.' && name !== '..';
  }
  if (!/^https?:\/\//.test(value)) return false;
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Why the agent leaves an app as it is, or null. These are the rules of coo-world's own builder
 * (src/core/systems/ClientBuilder.js), which is how a builder edits the world by hand: it selects
 * (to move, rotate or scale) and deletes only apps that are neither pinned nor the world's scene
 * app, and duplicates any app but the scene. coo-world's server does not enforce them (it takes
 * any of these changes to an app from a builder); the agent keeps to what the builder itself can
 * do, and has no operation that unpins.
 */
function untouchable(entity: any, operation: 'transform' | 'duplicate' | 'delete'): EditResult | null {
  if (entity.blueprint?.scene) return skipped("it is the world's scene");
  if (operation !== 'duplicate' && entity.data?.pinned) return skipped('the app is pinned');
  return null;
}

/** Scene edits. Keeps no state: every method acts on the world of the guard it is given. */
export class BuildManager {
  /**
   * Walks next to the target first. Null once the agent stands there (or the world has no
   * controls to walk with); otherwise why the edit is not made: a walk that was stopped, replaced
   * by another, timed out or had nowhere to go did not bring the agent there, and its edit is not
   * applied. The edit itself is checked again afterwards.
   */
  private async walkTo(guard: EditGuard, x: number, z: number): Promise<EditResult | null> {
    const controls = guard.world.controls;
    if (!controls) return null;
    guard.check();
    const outcome: MoveOutcome = await controls.goto(x, z, { signal: guard.signal });
    // First, however the walk ended: a request that may no longer edit stops here (SceneEditStopped)
    guard.check();
    return outcome === 'arrived' ? null : skipped(NOT_THERE[outcome]);
  }

  /**
   * Why the target found before walking over can no longer be acted on, or null: it was removed (or
   * replaced under the same id) while the agent walked.
   */
  private gone(guard: EditGuard, entityId: unknown, entity: any): EditResult | null {
    return guard.world.entities.items.get(entityId) === entity && !entity.destroyed ? null : skipped('the target was removed while I walked over');
  }

  private async transform(guard: EditGuard, entityId: unknown, field: TransformField, value: unknown): Promise<EditResult> {
    const accepted = acceptedTransform(field, value);
    if (!accepted) return invalid(field);
    const entity = guard.world.entities.items.get(entityId);
    if (!entity) return skipped('target not found');
    // The server takes transforms for apps only (a player moves itself)
    if (!entity.isApp) return skipped('only apps can be moved, rotated or scaled');
    const kept = untouchable(entity, 'transform');
    if (kept) return kept;
    const notThere = await this.walkTo(guard, entity.root.position.x, entity.root.position.z);
    if (notThere) return notThere;
    const gone = this.gone(guard, entityId, entity);
    if (gone) return gone;
    // Again: it may have been pinned while the agent walked over
    const keptNow = untouchable(entity, 'transform');
    if (keptNow) return keptNow;
    guard.check();
    entity.root[field].fromArray(accepted);
    this.entityUpdate(guard, entity);
    return applied;
  }

  translate(guard: EditGuard, entityId: unknown, position: unknown): Promise<EditResult> {
    return this.transform(guard, entityId, 'position', position);
  }

  rotate(guard: EditGuard, entityId: unknown, quaternion: unknown): Promise<EditResult> {
    return this.transform(guard, entityId, 'quaternion', quaternion);
  }

  scale(guard: EditGuard, entityId: unknown, scale: unknown): Promise<EditResult> {
    return this.transform(guard, entityId, 'scale', scale);
  }

  async duplicate(guard: EditGuard, entityId: unknown): Promise<EditResult> {
    const world = guard.world;
    const entity = world.entities.items.get(entityId);
    if (!entity) return skipped('target not found');
    if (!entity.isApp) return skipped('only apps can be duplicated');
    const kept = untouchable(entity, 'duplicate');
    if (kept) return kept;
    const notThere = await this.walkTo(guard, entity.root.position.x, entity.root.position.z);
    if (notThere) return notThere;
    const gone = this.gone(guard, entityId, entity);
    if (gone) return gone;
    const keptNow = untouchable(entity, 'duplicate');
    if (keptNow) return keptNow;
    // The copy is added with the original's transform as it is now (a script may have set it to
    // anything): coo-world's sanitizeEntityAdd refuses the whole app when one of them is invalid
    const position = acceptedTransform('position', entity.root.position.toArray());
    const quaternion = acceptedTransform('quaternion', entity.root.quaternion.toArray());
    const scale = acceptedTransform('scale', entity.root.scale.toArray());
    if (!position) return invalid('position');
    if (!quaternion) return invalid('quaternion');
    if (!scale) return invalid('scale');
    // ...and sanitizeBlueprintAdd refuses a new blueprint whose model, script or image is not an asset or an http(s) URL
    if (entity.blueprint.unique) {
      const reference = [entity.blueprint.model, entity.blueprint.script, entity.blueprint.image?.url].find((value) => value != null && !blueprintReference(value));
      if (reference !== undefined) return failed("the app's blueprint names a file the world would refuse in a copy");
    }
    {
      let blueprintId = entity.data.blueprint
      let blueprint: Record<string, unknown> | null = null
      // if unique, we also duplicate the blueprint
      if (entity.blueprint.unique) {
        blueprint = {
          id: uuid(),
          version: 0,
          name: entity.blueprint.name,
          image: entity.blueprint.image,
          author: entity.blueprint.author,
          url: entity.blueprint.url,
          desc: entity.blueprint.desc,
          model: entity.blueprint.model,
          script: entity.blueprint.script,
          props: cloneDeep(entity.blueprint.props),
          preload: entity.blueprint.preload,
          public: entity.blueprint.public,
          locked: entity.blueprint.locked,
          frozen: entity.blueprint.frozen,
          unique: entity.blueprint.unique,
          disabled: entity.blueprint.disabled,
        }
        blueprintId = blueprint.id as string
      }
      const data = {
        id: uuid(),
        type: 'app',
        blueprint: blueprintId,
        position,
        quaternion,
        scale,
        mover: null,
        uploader: null,
        pinned: false,
        state: {},
      }
      const tooLarge = announcementProblem(blueprint, data)
      if (tooLarge) return failed(tooLarge)
      guard.check();
      if (blueprint) world.blueprints.add(blueprint, true)
      world.entities.add(data, true)
      // The copy's id, for whoever asked (a later operation of the same plan can act on it)
      return { outcome: 'applied', newId: data.id };
    }
  }

  async delete(guard: EditGuard, entityId: unknown): Promise<EditResult> {
    const entity = guard.world.entities.items.get(entityId);
    if (!entity) return skipped('target not found');
    if (!entity.isApp) return skipped('only apps can be deleted');
    const kept = untouchable(entity, 'delete');
    if (kept) return kept;
    const notThere = await this.walkTo(guard, entity.root.position.x, entity.root.position.z);
    if (notThere) return notThere;
    const gone = this.gone(guard, entityId, entity);
    if (gone) return gone;
    const keptNow = untouchable(entity, 'delete');
    if (keptNow) return keptNow;
    guard.check();
    entity.destroy(true)
    this.entityUpdate(guard, entity);
    return applied;
  }

  async importEntity(
    guard: EditGuard,
    url: string,
    position?: any,
    quaternion?: any
  ): Promise<EditResult> {
    if (typeof url !== 'string' || !/^(https?|asset):\/\//.test(url)) {
      console.warn(`[BuildManager] importEntity: rejected url (only http://, https:// and asset:// are allowed): ${describeUrl(url)}`)
      return failed('only http(s):// and asset:// URLs can be imported')
    }
    const ext = url.split('?')[0].split('.').pop()?.toLowerCase()
    if (ext !== 'hyp' && ext !== 'glb' && ext !== 'vrm') return failed('only .hyp, .glb and .vrm files can be imported')
    // Left out: the origin, facing forward. Given but not what the server accepts: refused, as the
    // server would refuse the whole app
    position = position == null ? [0, 0, 0] : acceptedTransform('position', position)
    if (!position) return invalid('position')
    quaternion = quaternion == null ? [0, 0, 0, 1] : acceptedTransform('quaternion', quaternion)
    if (!quaternion) return invalid('quaternion')
    const world = guard.world;
    const resolvedUrl = await resolveUrl(url, world, { allowLocal: false });
    if (!resolvedUrl) {
      console.warn(`[BuildManager] importEntity: could not resolve url: ${describeUrl(url)}`)
      return failed('the URL could not be resolved')
    }
    // The file is downloaded under the world's network policy (lib/net-policy.ts): public https
    // hosts or the world's own origin, never an address inside the agent's network, and no more
    // bytes than the cap, however much the server sends.
    const maxBytes = importByteCap(world.network.maxUploadSize)
    guard.check();
    let resp
    try {
      resp = await worldNet(world).fetch(resolvedUrl, { maxBytes, timeoutMs: IMPORT_DOWNLOAD_TIMEOUT_MS })
    } catch (err) {
      if (!(err instanceof SafeFetchError)) throw err
      console.warn(`[BuildManager] importEntity: download of ${describeUrl(url)} failed (${err.kind}): ${err.message}`)
      if (err.kind === 'too-large') return failed(maxBytes < MAX_MODEL_BYTES ? 'the file is too large for the world' : 'the file is too large to import')
      // What a name resolves to stays in the log: the reason given here can end up in chat
      if (err.kind === 'refused') return failed("the URL is not allowed by the agent's network policy")
      return failed(err.kind === 'timeout' ? 'download timed out' : 'download failed')
    }
    if (resp.status < 200 || resp.status >= 300) {
      console.error(`[BuildManager] importEntity: fetch failed with ${resp.status} ${resp.statusText} for ${describeUrl(url)}`)
      return failed(`download failed (HTTP ${resp.status})`)
    }
    const file = new File([new Uint8Array(resp.body)], url.split('?')[0].split('/').pop() ?? '', { type: resp.headers['content-type'] ?? '' })
    
    await new Promise(resolve => setTimeout(resolve, 100))

    const notThere = await this.walkTo(guard, position[0], position[2]);
    if (notThere) return notThere;

    const transform = {
      position,
      quaternion,
    };
    try {
      return ext === 'hyp' ? await this.addApp(guard, file, transform) : await this.addModel(guard, file, transform)
    } catch (err) {
      if (err instanceof SceneEditStopped) throw err
      console.error(`[BuildManager] importEntity: failed to import ${file.name}:`, err)
      return failed(`import failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * Adds the app of a .hyp file. Its files are uploaded first, and only then are its blueprint and
   * the app announced to the world, one right after the other with nothing awaited in between: an
   * import that fails or is stopped has announced nothing, so there is nothing to take back. What
   * a failed import leaves: the files it had uploaded by then, on the world's asset server, with
   * nothing in the world referring to them.
   */
  async addApp(guard: EditGuard, file: File, transform: PlacedAt): Promise<EditResult> {
    const world = guard.world;
    const info = await importApp(file)
    guard.check();
    try {
      await Promise.all(info.assets.map(asset => world.network.upload(asset.file, { check: () => guard.check() })))
    } catch (err) {
      if (err instanceof SceneEditStopped) throw err
      console.error('failed to upload .hyp assets')
      console.error(err)
      return failed(`upload failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    guard.check();

    const blueprint = {
      id: uuid(),
      version: 0,
      name: info.blueprint.name,
      image: info.blueprint.image,
      author: info.blueprint.author,
      url: info.blueprint.url,
      desc: info.blueprint.desc,
      model: info.blueprint.model,
      script: info.blueprint.script,
      props: info.blueprint.props,
      preload: info.blueprint.preload,
      public: info.blueprint.public,
      locked: info.blueprint.locked,
      frozen: info.blueprint.frozen,
      unique: info.blueprint.unique,
      disabled: info.blueprint.disabled,
    }
    const data = {
      id: uuid(),
      type: 'app',
      blueprint: blueprint.id,
      position: transform.position,
      quaternion: transform.quaternion,
      scale: [1, 1, 1],
      mover: null,
      uploader: world.network.id,
      pinned: false,
      state: {},
    }
    const tooLarge = announcementProblem(blueprint, data)
    if (tooLarge) return failed(tooLarge)
    world.blueprints.add(blueprint, true)
    const app = world.entities.add(data, true)
    app.onUploaded()
    return applied
  }

  async addModel(guard: EditGuard, file: File, transform: PlacedAt): Promise<EditResult> {
    const world = guard.world;
    const hash = await hashFile(file)
    const ext = (file.name.split('.').pop() ?? '').toLowerCase()
    const filename = `${hash}.${ext}`
    
    const baseUrl = world.assetsUrl.replace(/\/$/, "");
    const url = `${baseUrl}/${filename}`;
    guard.check();
    const uploadPromise = world.network.upload(file, { check: () => guard.check() });
    const timeoutPromise = new Promise((_resolve, reject) =>
      setTimeout(() => reject(new Error("Upload timed out")), 30000)
    );

    await Promise.race([uploadPromise, timeoutPromise]);
    guard.check();
    
    const blueprint = {
      id: uuid(),
      version: 0,
      name: file.name.split('.')[0],
      image: null,
      author: null,
      url: null,
      desc: null,
      model: url,
      script: null,
      props: {},
      preload: false,
      public: false,
      locked: false,
      unique: false,
      disabled: false,
    }

    const data = {
      id: uuid(),
      type: 'app',
      blueprint: blueprint.id,
      position: transform.position,
      quaternion: transform.quaternion,
      scale: [1, 1, 1],
      mover: null,
      uploader: world.network.id,
      pinned: false,
      state: {},
    }
    const tooLarge = announcementProblem(blueprint, data)
    if (tooLarge) return failed(tooLarge)
    world.blueprints.add(blueprint, true)
    const app = world.entities.add(data, true)
    app.onUploaded()
    return applied
  }
  
  /** Called right after a checked change, with no await in between. */
  entityUpdate(guard: EditGuard, entity: any) {
    guard.world.network.send('entityModified', {
        id: entity.data.id,
        position: entity.root.position.toArray(),
        quaternion: entity.root.quaternion.toArray(),
        scale: entity.root.scale.toArray(),
    })
  }
}
