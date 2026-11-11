import * as THREE from "three";
import { System } from "../hyperfy/src/core/systems/System.js";
import { createNode } from "../hyperfy/src/core/extras/createNode.js";
import { GLTFLoader } from "../hyperfy/src/core/libs/gltfloader/GLTFLoader.js";
import { glbToNodes } from "../hyperfy/src/core/extras/glbToNodes.js";
import { createEmoteFactory } from "../hyperfy/src/core/extras/createEmoteFactory.js";
import { AgentAvatar } from "./avatar.js";
import { PuppeteerManager } from "../managers/puppeteer-manager.js";
import type { WorldScripts } from "../lib/script-api";
import { ASSET_BYTE_CAPS, type AssetBytes, type AssetKind, assetKey, describeUrl, fetchAssetBytes } from "../lib/asset-bytes";
import { SafeFetchError } from "../lib/net-policy";
import { externalUriProblem, gltfCharge, modelBudget } from "../lib/gltf-budget";
import { type AssetLease, PARSE_COPIES, assetMemory, modelReservation, workBytes } from "../lib/asset-memory";
import { PageWork } from "../lib/page-work";

/** What the agent loads. The engine also asks for images, video and audio, which the agent has no use for. */
const LOADABLE: ReadonlySet<string> = new Set<AssetKind>(["model", "avatar", "emote", "script"]);

/**
 * The agent decodes no image: it has no canvas and no GPU, and a model's textures stay in the
 * render page. Without this, the engine's glTF loader makes a blob: URL for every image embedded
 * in a file it parses here (what the render page hands back keeps the textures of the slots it
 * does not strip), fails to load it, as it always does outside a browser, and never revokes the
 * URL: the image's bytes then stay registered with the process for good. Asked for a texture, this
 * answers at once that there is none, which is what the failed load came to (a material without
 * that map), and no blob: URL is ever made.
 */
const NO_TEXTURES = Object.freeze({
  name: 'AGENT_no_textures',
  loadTexture: (): Promise<null> => Promise.resolve(null),
});

/**
 * The engine's glTF loader as the agent uses it: no texture is loaded (NO_TEXTURES), and nothing by
 * URL. A file that names a buffer or an image by URL is refused before it is parsed here
 * (gltf-budget.ts externalUriProblem); should a load by URL still be asked for, its URL is refused
 * here, so the engine's FileLoader (global fetch, outside the network policy) never runs for one.
 */
export function createGltfLoader(): GLTFLoader {
  // (in three, though not in the types the agent builds against)
  const manager = new (THREE as any).LoadingManager();
  manager.setURLModifier((url: string) => {
    if (url.startsWith('data:')) return url;
    throw new Error(`[AgentLoader] Not loading ${describeUrl(url)}: nothing the agent parses loads a file by URL`);
  });
  const loader: any = new GLTFLoader(manager);
  // First, before the loader's own texture extensions (WebP, AVIF, Basis), which load images too
  loader.pluginCallbacks.unshift(() => NO_TEXTURES);
  return loader;
}

/**
 * Bounds on what one world can make the loader do and keep. The cache holds what the loader itself
 * keeps for a repeated load; assets the world's live entities are built from stay referenced by
 * those entities whatever is dropped here.
 */
export interface LoaderLimits {
  cacheEntries: number;
  cacheBytes: number;
  concurrent: number;
  queued: number;
}

export const LOADER_LIMITS: Readonly<LoaderLimits> = Object.freeze({
  /** Loaded assets kept for reuse; the least recently used are dropped first */
  cacheEntries: 256,
  /** What those assets hold: for a model, the larger of its download and the copy the render page returned */
  cacheBytes: 512 * 1024 * 1024,
  /** Downloads (and their parsing) in progress at once */
  concurrent: 8,
  /** Loads waiting for one of those slots; more are refused */
  queued: 1024,
});

export class AgentLoader extends System {
  /** Loads in progress, and loaded assets (the same keys as `results`) */
  promises: Map<string, Promise<any>>;
  /** Loaded assets, least recently used first */
  results: Map<string, any>;
  gltfLoader: GLTFLoader;
  dummyScene: any;
  /** The sandboxed script runtime, or null when world scripts are off (lib/script-sandbox.ts) */
  private scripts: WorldScripts | null;
  private sizes = new Map<string, number>();
  private cachedBytes = 0;
  private active = 0;
  private waiting: Array<{ start: () => void; cancel: (error: Error) => void }> = [];
  /** Fires when the world is destroyed: downloads stop and waiting loads fail */
  private stopped = new AbortController();
  /**
   * This world's page work (lib/page-work.ts): assets blamed for a render page kill fail at once
   * from then on, and after a kill page loads run one at a time. The sky uses it too.
   */
  readonly pageWork = new PageWork();

  private limits: LoaderLimits;

  constructor(world: any, { scripts = null, limits = {} }: { scripts?: WorldScripts | null; limits?: Partial<LoaderLimits> } = {}) {
    super(world);
    this.scripts = scripts;
    this.limits = { ...LOADER_LIMITS, ...limits };
    this.promises = new Map();
    this.results = new Map();
    this.gltfLoader = createGltfLoader();

    this.dummyScene = new THREE.Object3D();
    this.dummyScene.name = "AgentLoaderDummyScene";
  }

  // --- Dummy Preload Methods ---
  preload(_type: string, _url: string) {
    // No-op for agent
  }
  execPreload() {
    // No-op for agent
    // ClientNetwork calls this after snapshot, so it must exist.
    console.log("[AgentLoader] execPreload called (No-op).");
  }
  // ---------------------------

  has(type: string, url: unknown) {
    const key = assetKey(type, url);
    return this.results.has(key) || this.promises.has(key);
  }
  get(type: string, url: unknown) {
    const key = assetKey(type, url);
    const result = this.results.get(key);
    if (result !== undefined) {
      // Most recently used last
      this.results.delete(key);
      this.results.set(key, result);
    }
    return result;
  }

  /**
   * Loads an asset once: a second call for the same type and URL, also while the first is still
   * downloading, gets the same promise. A failed load is forgotten, so it can be tried again.
   */
  load(type: string, url: unknown): Promise<any> {
    if (!LOADABLE.has(type)) {
      // Nothing is requested for these
      console.warn(`[AgentLoader] Unsupported type in load(): ${type}`);
      return Promise.resolve(null);
    }
    const key = assetKey(type, url);
    const refused = this.pageWork.refusal(key);
    if (refused) return Promise.reject(new Error(`[AgentLoader] Not loading ${type} from ${describeUrl(url)} again: ${refused}`));
    const existing = this.promises.get(key);
    if (existing) {
      // A load served from the cache counts as a use, as get() does
      this.get(type, url);
      return existing;
    }
    const promise = this.loadOnce(type as AssetKind, url, key);
    // Registered before anything is awaited: until here, a concurrent load would start a second download
    this.promises.set(key, promise);
    promise.catch(() => {
      if (this.promises.get(key) === promise) this.promises.delete(key);
    });
    return promise;
  }

  destroy() {
    this.stopped.abort();
    const error = new Error("[AgentLoader] The world was destroyed");
    for (const waiter of this.waiting.splice(0)) waiter.cancel(error);
  }

  /**
   * Called after every await of a load: nothing is evaluated, rendered or kept after destroy(). A
   * model the render page has been told is accepted (parseGLB) is kept: its last check was before.
   */
  private throwIfStopped() {
    if (this.stopped.signal.aborted) throw new Error("[AgentLoader] The world was destroyed");
  }

  private async loadOnce(type: AssetKind, url: unknown, key: string) {
    try {
      return await this.inSlot(async () => {
        // The agent's own memory for this load (lib/asset-memory.ts), from before the download to the end of the parse
        const lease = await assetMemory.download(ASSET_BYTE_CAPS[type], this.stopped.signal);
        try {
          const asset = await fetchAssetBytes(this.world, url, type, { signal: this.stopped.signal, lease });
          this.throwIfStopped();
          if (type === "script") {
            await lease.toWork(workBytes('script', asset.bytes.byteLength), this.stopped.signal);
            this.throwIfStopped();
            const code = new TextDecoder().decode(asset.bytes);
            // HYPERFY_WORLD_SCRIPTS=off (the default): the code is kept for the engine's bookkeeping
            // and never evaluated, so the app shows its model and does nothing.
            const script = this.scripts ? this.scripts.evaluate(code) : { exec() { }, code };
            this.keep(key, script, asset.bytes.byteLength);
            return script;
          }
          return await this.parseGLB(type, key, asset, lease);
        } finally {
          lease.release();
        }
      });
    } catch (error) {
      // A refusal or a network failure needs no stack; anything else might
      const detail = error instanceof SafeFetchError ? `${error.message} (${error.kind})` : error;
      console.error(`[AgentLoader] Failed to load ${type} from ${describeUrl(url)}:`, detail);
      throw error;
    }
  }

  /** Runs `task` in one of the `concurrent` slots, waiting for one if need be. */
  private async inSlot<T>(task: () => Promise<T>): Promise<T> {
    if (this.stopped.signal.aborted) throw new Error("[AgentLoader] The world was destroyed");
    if (this.active < this.limits.concurrent) {
      this.active++;
    } else {
      if (this.waiting.length >= this.limits.queued) throw new Error(`[AgentLoader] More than ${this.limits.queued} loads are waiting`);
      // Whoever finishes hands its slot over, so `active` stays as it is
      await new Promise<void>((start, cancel) => this.waiting.push({ start, cancel }));
    }
    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      if (next) next.start();
      else this.active--;
    }
  }

  /** Caches a loaded asset and drops the least recently used ones beyond the limits. */
  private keep(key: string, result: unknown, bytes: number) {
    this.forget(key);
    this.results.set(key, result);
    this.sizes.set(key, bytes);
    this.cachedBytes += bytes;
    for (const oldest of this.results.keys()) {
      if (this.results.size <= this.limits.cacheEntries && this.cachedBytes <= this.limits.cacheBytes) break;
      // Never the one just added: its caller is about to use it
      if (oldest === key) break;
      this.forget(oldest);
    }
  }

  private forget(key: string) {
    if (!this.results.has(key)) return;
    this.results.delete(key);
    this.promises.delete(key);
    this.cachedBytes -= this.sizes.get(key) ?? 0;
    this.sizes.delete(key);
  }

  async parseGLB(type: AssetKind, key: string, asset: AssetBytes, lease?: AssetLease) {
    if (type !== 'model' && type !== 'avatar' && type !== 'emote') throw new Error(`[AgentLoader] Unsupported GLTF type: ${type}`);
    // Refused before the render page (or anything else) parses it: lib/gltf-budget.ts
    const budget = modelBudget(type);
    const admitted = gltfCharge(asset.bytes, budget);
    if ('problem' in admitted) throw new Error(`[AgentLoader] ${admitted.problem}`);
    if (type === 'emote') return this.parseEmote(key, asset, admitted.charge.bytes, lease);
    // The most the page may hand back for this load, and the agent's memory for the rest of the way
    // sized from that (lib/asset-memory.ts); the page is held to the same number
    const reservation = modelReservation(type, asset.bytes.byteLength, admitted.charge.exportBytes, budget.exportBytes);
    if ('problem' in reservation) throw new Error(`[AgentLoader] ${reservation.problem}`);
    await lease?.toWork(reservation.workBytes, this.stopped.signal);
    this.throwIfStopped();
    const puppeteerManager = PuppeteerManager.getInstance()
    // The render page keeps the textures (and the whole avatar) and hands back a copy: a model's
    // without the textures of the stripped slots, an avatar's with its textures.
    // That copy is parsed and converted here before the page is told the load is accepted: if any
    // of it fails, or the world goes away first, what the page kept is taken back (pageCall).
    const accept = async (stripped: Uint8Array) => {
      this.throwIfStopped();
      // From here: the download, the page's answer (its base64 and decoded copy) and the engine's
      // copies of its BIN chunk and buffer views
      lease?.shrink(asset.bytes.byteLength + PARSE_COPIES * stripped.byteLength);
      // The page's copy comes in memory of its own (managers/puppeteer-manager.ts fromBase64): no second copy
      // Parsed here: nothing in it may name a file by URL (the page writes none)
      const external = externalUriProblem(stripped);
      if (external) throw new Error(`[AgentLoader] ${external}`);
      const arrayBuffer = stripped.byteOffset === 0 && stripped.byteLength === stripped.buffer.byteLength ? stripped.buffer : stripped.slice().buffer;
      const gltf: any = await new Promise((ok, bad) => this.gltfLoader.parse(arrayBuffer, '', ok, bad));
      this.throwIfStopped();
      let result: any;
      if (type === 'model') {
        const node = glbToNodes(gltf, this.world);
        result = { gltf, toNodes() { return node.clone(true); } };
      } else {
        const factory = null;
        const root = createNode('group', { id: '$root' });
        root.add(new AgentAvatar({ id: 'avatar' }));
        result = { gltf, factory, toNodes() { return root.clone(true); } };
      }
      // The last check before the page is told: from the acceptance on, the result is this loader's
      this.throwIfStopped();
      return { result, bytes: Math.max(asset.bytes.byteLength, stripped.byteLength) };
    };
    const options = { maxExportBytes: reservation.exportBytes, signal: this.stopped.signal, accept };
    const loaded = await this.pageWork.run(key, `${type} from ${describeUrl(asset.url)}`, () =>
      type === 'avatar' ? puppeteerManager.loadVRMBytes(asset.bytes, asset.url, options) : puppeteerManager.loadGlbBytes(asset.bytes, options)
    );
    // What is held: the parsed copy the page returned (its buffer stays referenced), or the download if larger
    this.keep(key, loaded.result, loaded.bytes);
    return loaded.result;
  }

  /**
   * An emote is its animation clip, read here from the downloaded file itself. The render page has
   * no part in it: it plays no emotes, and what it hands back for a model is the scene alone,
   * without animations. The file has passed the download cap and the glTF filter with an emote's
   * budget by now (parseGLB); `chargedBytes` is what the filter found the parse allocates, which
   * is reserved, with the download, until the parse is over.
   */
  private async parseEmote(key: string, asset: AssetBytes, chargedBytes: number, lease?: AssetLease) {
    // Parsed here, not in the page: nothing in it may name a file by URL
    const external = externalUriProblem(asset.bytes);
    if (external) throw new Error(`[AgentLoader] ${external}`);
    await lease?.toWork(asset.bytes.byteLength + chargedBytes, this.stopped.signal);
    this.throwIfStopped();
    const bytes = asset.bytes;
    const arrayBuffer = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.slice().buffer;
    const gltf: any = await new Promise((ok, bad) => this.gltfLoader.parse(arrayBuffer, '', ok, bad));
    this.throwIfStopped();
    if (!gltf.animations?.length) throw new Error(`[AgentLoader] ${describeUrl(asset.url)} holds no animation: it is not an emote`);
    if (!gltf.scene?.children?.length) throw new Error(`[AgentLoader] ${describeUrl(asset.url)} has no scene to read an emote's skeleton from`);
    // Retargeted onto an avatar by whoever plays it (the engine's createVRMFactory): toClip
    const factory = createEmoteFactory(gltf, asset.url);
    const result = { toClip(options: any) { return factory.toClip(options); } };
    this.throwIfStopped();
    // What stays referenced: the clip's tracks, which view into the parsed file
    this.keep(key, result, asset.bytes.byteLength + chargedBytes);
    return result;
  }
}
