import path from 'path'
import fs from 'fs'
import { promises as fsPromises } from 'fs';
import puppeteer, { type Browser, type Page } from 'puppeteer'
import { resolveUrl } from '../utils.js';
import { getModuleDirectory } from '../utils.js';
import { childEnv } from '../lib/child-env';
import { modelBudget } from '../lib/gltf-budget';
import { RenderWatchdog, type RenderWatchdogOptions } from '../lib/render-watchdog';
import { ScopedLock } from '../lib/scoped-lock';

// This module loads without the service and the engine behind it (scripts/smoke-chromium.mjs runs
// it that way): what it draws of a world is handed to it (capture), never looked up.

/**
 * How a snapshot looks at the scene: all around the agent, the way it faces (`direction`: the side
 * the caller turned it to first, which only names the diagnostic copy), or toward a point.
 */
export type CaptureView =
  | { kind: 'around' }
  | { kind: 'facing'; direction: 'front' | 'back' | 'left' | 'right' }
  | { kind: 'target'; position: [number, number, number] }

interface Placed {
  position: { toArray(): number[] }
  quaternion: { x: number; y: number; z: number; w: number }
  scale: { toArray(): number[] }
}

interface CapturePlayer {
  data: { id: string }
  base: Placed
  avatarUrl?: unknown
}

/** What a snapshot reads of an engine world. */
export interface CaptureWorld {
  assetsUrl?: string | null
  entities: { player?: CapturePlayer | null; players: Map<string, CapturePlayer> }
  stage: { scene: { toJSON(): unknown } }
}

type PlayerView = { position: number[]; quaternion: number[] }

/** What the render page (public/puppeteer/page.js, assets.js, public/scripts) puts on its window. */
interface RenderPageWindow {
  THREE?: unknown
  scene?: unknown
  camera?: unknown
  snapshotEquirectangular(player: PlayerView): Promise<string>
  snapshotFacingDirection(player: PlayerView): Promise<string>
  snapshotViewToTarget(player: PlayerView, target: number[]): Promise<string>
  agentPage?: {
    loadGlb(base64: string, stripSlots: readonly string[], maxExportBytes: number, op?: string): Promise<string>
    loadVrm(url: string, base64: string, maxExportBytes: number, op?: string): Promise<string>
    registerTexture(base64: string, contentType: string, slot: string, source: string, op?: string): Promise<string>
    loadEnvironmentHDR(base64: string, op?: string): Promise<void>
    rehydrate(sceneJson: unknown, stripSlots: readonly string[], players: unknown[]): unknown
    settle(op: string, step: 'rollback' | 'forget'): unknown
    releaseTexture(id: string, slot: string): unknown
  }
}
// Only inside functions handed to page.evaluate, which run in the render page
declare const window: RenderPageWindow

const debugSnapshotFile = (view: CaptureView) =>
  view.kind === 'around' ? 'scene_equirectangular.jpeg' : view.kind === 'facing' ? `scene_facing_${view.direction}.jpeg` : 'scene_view_to_target.jpeg'

const STRIP_SLOTS: readonly string[] = [
  'map', 'aoMap', 'alphaMap',
  'bumpMap', 'normalMap',
  'metalnessMap', 'roughnessMap',
  'emissiveMap', 'lightMap'
]

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * The page the renderer runs in. It is written into an empty tab, never navigated to, and its
 * code (dist/puppeteer/page.js, built by scripts/build-assets.mjs) is added as one inline script.
 */
const PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Three.js Test (module)</title>
  <style>
    body { margin: 0; overflow: hidden; }
    canvas { display: block; }
  </style>
</head>
<body>
</body>
</html>`

/**
 * Chromium has no way out. Everything the browser itself would send (it contacts update and
 * safe-browsing services on its own when started plainly) goes to a proxy address where nothing
 * listens, loopback included, and no host name resolves. The page's own requests are refused
 * one by one as well (see init). Neither covers WebRTC/UDP, which nothing in the page uses.
 */
export const OFFLINE_CHROMIUM_ARGS = [
  '--proxy-server=http://127.0.0.1:9',
  '--proxy-bypass-list=<-loopback>',
  '--host-resolver-rules=MAP * ~NOTFOUND',
]

const toBase64 = (bytes: Uint8Array) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64')
/** The bytes in an ArrayBuffer of their own, exactly as long (not a view into Node's buffer pool) */
const fromBase64 = (text: string) => {
  const bytes = Buffer.allocUnsafeSlow(Buffer.byteLength(text, 'base64'))
  const written = bytes.write(text, 'base64')
  return written === bytes.length ? new Uint8Array(bytes.buffer, 0, written) : new Uint8Array(bytes.buffer.slice(0, written))
}

/** `promise`, or PageOperationCancelled as soon as `signal` fires (the work itself goes on for others) */
function untilAborted<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(new PageOperationCancelled())
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new PageOperationCancelled())
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
    )
  })
}
// The largest model the page returns when the caller names no budget (a model's, lib/gltf-budget.ts)
const DEFAULT_MAX_EXPORT_BYTES = modelBudget('model').exportBytes

/** What a model or avatar load takes besides its bytes (see PuppeteerManager.pageCall). */
export interface LoadOptions<T, R> {
  maxExportBytes?: number
  signal?: AbortSignal
  /** The caller's work on the result before it is accepted; a failure takes back what the call kept */
  accept?: (result: T) => R | Promise<R>
}

const asIs = <T, R = T>(result: T): R => result as unknown as R

/** A page call whose world went away (the caller's signal fired); what it kept in the page was taken back. */
export class PageOperationCancelled extends Error {
  constructor() {
    super('[PuppeteerManager] The page operation was cancelled')
    this.name = 'AbortError'
  }
}

export interface PuppeteerManagerOptions {
  /** The built render page, when it is not next to this module (the smoke script). */
  pageBundlePath?: string
  /** FOR TESTS: a shorter deadline or another process table. */
  watchdog?: Pick<RenderWatchdogOptions, 'deadlineMs' | 'initDeadlineMs' | 'limitBytes' | 'table' | 'intervalMs' | 'idleIntervalMs' | 'breaker'>
}

/**
 * The render page: one Chromium for the whole process, whatever world the agent is connected to.
 * A connection's textures and avatars live in the page until the connection ends (resetPage).
 */
export class PuppeteerManager {
  private static instance: PuppeteerManager | null = null
  private operations = 0
  /**
   * Counts the render pages built. What a page was given (a texture, an environment) is in that
   * page only: a caller that remembers such a thing remembers this number with it, and takes it
   * as gone once the number has changed (the page was reset, or rebuilt after a crash or a kill).
   */
  pageEpoch = 0
  /** The current browser generation (each launch is one); what the watchdog, kills and launches are bound to */
  private generation = 0
  private readonly pageGeneration = new WeakMap<Page, number>()
  /** One snapshot at a time: the page has one scene, which a snapshot fills and then draws */
  private readonly captures = new ScopedLock()
  /**
   * The run-time bound on the page (lib/render-watchdog.ts): every page call below runs under it,
   * and Chromium's tree is killed when it uses too much memory or one call takes too long.
   */
  readonly watchdog: RenderWatchdog
  
  private browser: Browser | null = null
  private page: Page | null = null
  private browserPromise: Promise<Browser> | null = null
  private initPromise: Promise<Page> | null = null
  private pageScript: Promise<string> | null = null
  private pageBundlePath: string

  constructor({ pageBundlePath, watchdog }: PuppeteerManagerOptions = {}) {
    if (PuppeteerManager.instance) {
      throw new Error('PuppeteerManager has already been instantiated.')
    }
    this.watchdog = new RenderWatchdog({
      ...watchdog,
      kill: (pids, group) => {
        // puppeteer starts Chromium detached, so the browser leads a process group of its own: that
        // takes the helpers whose parent is gone too
        if (group !== null) {
          try {
            process.kill(-group, 'SIGKILL')
          } catch {
            // gone already
          }
        }
        for (const pid of pids) {
          try {
            process.kill(pid, 'SIGKILL')
          } catch {
            // gone already
          }
        }
      },
      // Synchronously, at the teardown: the next use starts a new browser without waiting for puppeteer to notice
      onTornDown: (generation) => this.dropGeneration(generation),
    })
    this.pageBundlePath = pageBundlePath ?? path.join(getModuleDirectory(), 'puppeteer', 'page.js')
    PuppeteerManager.instance = this
    // Warm up Chromium in the background; callers await init() themselves.
    this.init().catch(error => {
      console.error('[PuppeteerManager] Failed to launch browser:', messageOf(error))
    })
  }

  public static getInstance(): PuppeteerManager {
    if (!this.instance) {
      throw new Error('PuppeteerManager not yet initialized. Call PuppeteerManager.getOrCreate() first.')
    }
    return this.instance
  }

  /**
   * Returns the existing manager, so reconnects reuse one Chromium.
   */
  public static getOrCreate(options?: PuppeteerManagerOptions): PuppeteerManager {
    return this.instance ?? new PuppeteerManager(options)
  }

  public async close(): Promise<void> {
    if (PuppeteerManager.instance === this) {
      PuppeteerManager.instance = null
    }
    await this.resetPage()
    const browserPromise = this.browserPromise
    this.browserPromise = null
    const browser = await browserPromise?.catch(() => null)
    await browser?.close().catch((error: unknown) => {
      console.warn('[PuppeteerManager] Error while closing browser:', messageOf(error))
    })
    this.browser = null
  }

  /**
   * Closes the current page so the next session starts with empty texture/avatar caches.
   * The browser stays up and the next init() opens a fresh page.
   */
  public async resetPage(): Promise<void> {
    const pending = this.initPromise
    this.initPromise = null
    const page = await pending?.catch(() => null)
    if (this.page === page) this.page = null
    await page?.close().catch((error: unknown) => {
      console.warn('[PuppeteerManager] Error while closing page:', messageOf(error))
    })
  }

  /** Forgets the browser of `generation` if it is still the current one: the next use launches another. */
  private dropGeneration(generation: number) {
    if (this.generation !== generation) return
    this.browserPromise = null
    this.browser = null
    this.initPromise = null
    this.page = null
  }

  /** Launches a browser (puppeteer's own launch timeout bounds this) as the next generation. */
  private getBrowser(): Promise<Browser> {
    if (!this.browserPromise) {
      const generation = ++this.generation
      const browserPromise = puppeteer.launch({
        // headless: false,
        defaultViewport: null,
        // Not the agent's environment: it holds API keys and tokens (lib/child-env.ts)
        env: childEnv(),
        args: OFFLINE_CHROMIUM_ARGS,
      })
      this.browserPromise = browserPromise
      browserPromise.then(
        browser => {
          // Superseded while it launched (its generation torn down, or the manager closed): nobody's browser
          if (this.generation !== generation || this.browserPromise !== browserPromise) {
            browser.process()?.kill('SIGKILL')
            browser.close().catch(() => { })
            return
          }
          this.browser = browser
          this.watchdog.started(generation, browser.process()?.pid ?? null)
          // If Chromium dies, relaunch on the next call instead of reusing a dead handle
          browser.on('disconnected', () => {
            this.watchdog.ended(generation)
            this.dropGeneration(generation)
          })
        },
        // Let a later call retry the launch
        () => { if (this.browserPromise === browserPromise) this.browserPromise = null }
      )
    }
    return this.browserPromise
  }

  /**
   * The page, built when there is none: under a watched call with a deadline of its own
   * (RENDER_INIT_DEADLINE_MS in lib/render-watchdog.ts), for the browser generation it belongs to.
   * A caller's `signal` stops its wait (PageOperationCancelled); the building goes on for the
   * others. While the render page is down for a cooldown this fails at once with
   * RenderPageUnavailable. The launch itself is bounded by puppeteer's own launch timeout.
   */
  private async init(signal?: AbortSignal): Promise<Page> {
    this.watchdog.breaker.check()
    // One page per session; reset by resetPage()
    if (!this.initPromise) {
      const initPromise: Promise<Page> = (async () => {
        const browserPromise = this.getBrowser()
        const generation = this.generation
        const browser = await browserPromise
        // Given up: its browser's generation is over (torn down, or the browser dropped). A reset
        // meanwhile (resetPage) is not that: it takes the page this returns and closes it.
        const givenUp = () => this.generation !== generation || this.browserPromise !== browserPromise
        const gone = () => new Error('[PuppeteerManager] The render page was given up while it was being built')
        // A launch that finished after that is disposed of by getBrowser(); no page is built on it
        if (givenUp()) throw gone()
        // Nor while the render page is down: the cooldown may have started while this launched
        this.watchdog.breaker.check()
        const page = await this.watchdog.watch(generation, () => this.buildPage(browser, initPromise), { deadlineMs: this.watchdog.initDeadlineMs, init: true })
        if (givenUp()) {
          await page.close().catch(() => { })
          throw gone()
        }
        this.pageGeneration.set(page, generation)
        this.page = page
        this.pageEpoch++
        console.info('[PuppeteerManager] Render page ready (Chromium has no network access)')
        return page
      })()
      this.initPromise = initPromise
      // Allow a later call to retry instead of rethrowing the same error forever.
      initPromise.catch(() => {
        if (this.initPromise === initPromise) this.initPromise = null
      })
    }
    return await untilAborted(this.initPromise, signal)
  }

  /** The page, for page work admitted now: not during a cooldown that started while it was waited for */
  private async ready(signal?: AbortSignal): Promise<Page> {
    const page = await this.init(signal)
    this.watchdog.breaker.check()
    return page
  }

  private async buildPage(browser: Browser, initPromise: Promise<Page>): Promise<Page> {
    const page = await browser.newPage()
    // A page that closed or crashed is rebuilt by the next call. The new one starts without
    // the textures and avatars the old one held; those come back with the next connection.
    const lost = () => {
      if (this.page === page) this.page = null
      if (this.initPromise === initPromise) this.initPromise = null
    }
    page.on('close', lost)
    page.on('error', (error) => {
      console.warn('[PuppeteerManager] The render page crashed and will be rebuilt on next use:', messageOf(error))
      lost()
      page.close().catch(() => { })
    })
    try {
      // The page loads nothing by URL: every request it makes is refused. blob: and data:
      // URLs, which is how assets reach it, never become requests.
      await page.setRequestInterception(true)
      page.on('request', (request) => {
        request.abort('blockedbyclient').catch(() => { })
      })
      await page.setContent(PAGE_HTML, { waitUntil: 'load' })
      await page.addScriptTag({ content: await this.readPageScript() })

      await page.waitForFunction(() =>
        window.THREE !== undefined &&
        window.scene !== undefined &&
        window.camera !== undefined &&
        window.agentPage !== undefined
      )
    } catch (error) {
      await page.close().catch(() => { })
      throw error
    }
    return page
  }

  /** `work` on `page` as a watched page call of the generation the page belongs to */
  private watched<T>(page: Page, work: () => Promise<T>): Promise<T> {
    return this.watchdog.watch(this.pageGeneration.get(page) ?? this.generation, work)
  }

  private readPageScript(): Promise<string> {
    if (!this.pageScript) {
      const reading = fsPromises.readFile(this.pageBundlePath, 'utf8')
      this.pageScript = reading
      // A missing file may be there on the next try (a rebuild)
      reading.catch(() => { if (this.pageScript === reading) this.pageScript = null })
    }
    return this.pageScript
  }

  /** Diagnostic copies of the snapshots, written to the working directory when HYPERFY_DEBUG_SNAPSHOTS=true. */
  private saveDebugSnapshot(fileName: string, base64: string) {
    if (process.env.HYPERFY_DEBUG_SNAPSHOTS !== 'true') return
    try {
      fs.writeFileSync(path.resolve(fileName), Buffer.from(base64, 'base64'))
    } catch (error) {
      console.warn(`[PuppeteerManager] Could not write ${fileName}:`, messageOf(error))
    }
  }

  /**
   * A picture (JPEG data URL) of `world` as the agent sees it from where it stands: the scene and
   * the other players as they are now are put into the page, then drawn as `view` says. One at a
   * time. `signal` (the turn the look is for) ends the wait for the page and for an earlier
   * snapshot; a drawing in progress is not interrupted. Every page call runs under the watchdog.
   */
  public capture(world: CaptureWorld, view: CaptureView, { signal }: { signal?: AbortSignal } = {}): Promise<string> {
    return this.captures.run(signal, async () => {
      const page = await this.ready(signal)
      const player = world.entities.player
      if (!player) {
        throw new Error('Player entity not yet available')
      }
      await this.rehydrateSceneAssets(page, world)
      if (signal?.aborted) throw new PageOperationCancelled()

      const { x, y, z, w } = player.base.quaternion
      const playerData: PlayerView = { position: player.base.position.toArray(), quaternion: [x, y, z, w] }
      const target = view.kind === 'target' ? view.position : []
      const base64 = await this.watched(page, () => page.evaluate((kind, playerData, target) => {
        if (kind === 'around') return window.snapshotEquirectangular(playerData)
        if (kind === 'facing') return window.snapshotFacingDirection(playerData)
        return window.snapshotViewToTarget(playerData, target)
      }, view.kind, playerData, target))

      this.saveDebugSnapshot(debugSnapshotFile(view), base64)
      return `data:image/jpeg;base64,${base64}`
    })
  }

  /**
   * The asset loaders below take bytes the agent has already downloaded (lib/asset-bytes.ts): the
   * page cannot fetch anything itself. Bytes cross to the page and back as base64.
   *
   * Each takes a `signal` (the world the asset is for going away) and an `accept` step (the
   * caller's own work on the result: for a model, parsing and converting it in Node). The signal is
   * checked once the page is ready and right before the page is asked, so nothing is handed to the
   * page after it fired. A page call cannot be interrupted. With a signal or an `accept` step, the
   * page files how to take back what the call kept under the call's id and keeps it until the call
   * is settled:
   *   - the call failed, `accept` failed, or the signal fired before `accept` began or by the time
   *     it finished: taken back ("rollback");
   *   - otherwise the record is dropped ("forget") and what `accept` returned is returned. That is
   *     the acceptance: from here the result is the caller's, and a signal that fires later changes
   *     nothing (a caller that then has no use for it releases it, as environment.ts does a sky
   *     texture with releaseTexture).
   * A settlement that fails fails the call (a RenderPageKilled among them, for PageWork's
   * accounting); only the take-back after a call or an acceptance that already failed ignores its
   * own failure, as that error is what counts and a page that cannot be reached holds nothing.
   * A record lives from the call's return to its settlement: at most one per page call in
   * progress, and a kill or page rebuild discards them all.
   */
  private async pageCall<T, R>(signal: AbortSignal | undefined, run: (page: Page, op: string[]) => Promise<T>, accept: (result: T) => R | Promise<R>, { settled = !!signal }: { settled?: boolean } = {}): Promise<R> {
    const page = await this.ready(signal)
    if (signal?.aborted) throw new PageOperationCancelled()
    // The id the page files its undo under: when there is something to cancel, or a caller's
    // acceptance that may fail (`settled`)
    const op = settled ? [`op-${++this.operations}`] : []
    const takeBack = () => (op.length ? this.settle(page, op[0], 'rollback') : Promise.resolve())
    let result: T
    try {
      result = await this.watched(page, () => run(page, op))
    } catch (error) {
      await takeBack().catch(() => {})
      throw error
    }
    if (signal?.aborted) {
      await takeBack()
      throw new PageOperationCancelled()
    }
    let accepted: R
    try {
      accepted = await accept(result)
    } catch (error) {
      await takeBack().catch(() => {})
      throw error
    }
    if (signal?.aborted) {
      await takeBack()
      throw new PageOperationCancelled()
    }
    if (op.length) await this.settle(page, op[0], 'forget')
    return accepted
  }

  /** One settlement step of call `op` in the page (assets.js settle) */
  private async settle(page: Page, op: string, step: 'rollback' | 'forget'): Promise<void> {
    await this.watched(page, () => page.evaluate((id, step) => { window.agentPage!.settle(id, step) }, op, step))
  }

  /**
   * Runs `fn` in the page as a watched page call (the memory limit and the deadline apply). For
   * scripts/smoke-chromium.mjs, which checks the watchdog with it.
   */
  async evaluateWatched<T>(fn: (...args: any[]) => T | Promise<T>, ...args: unknown[]): Promise<T> {
    const page = await this.ready()
    return this.watched(page, () => page.evaluate(fn, ...args) as Promise<T>)
  }

  /** The current browser generation and its pid (for scripts/smoke-chromium.mjs) */
  currentBrowser(): { generation: number; pid: number | null } {
    return { generation: this.generation, pid: this.browser?.process()?.pid ?? null }
  }

  /**
   * Keeps a model's textures in the page and returns the model without them (GLB), or what
   * `accept` makes of it (see pageCall). The page refuses to return more than `maxExportBytes`.
   */
  async loadGlbBytes<R = Uint8Array>(bytes: Uint8Array, { maxExportBytes = DEFAULT_MAX_EXPORT_BYTES, signal, accept }: LoadOptions<Uint8Array, R> = {}): Promise<R> {
    return this.pageCall(
      signal,
      (page, op) =>
        page.evaluate(
          (base64, STRIP_SLOTS, maxExportBytes, op?: string) => window.agentPage!.loadGlb(base64, STRIP_SLOTS, maxExportBytes, op),
          toBase64(bytes), STRIP_SLOTS, maxExportBytes, ...op
        ),
      (stripped) => (accept ?? asIs<Uint8Array, R>)(fromBase64(stripped)),
      { settled: !!signal || !!accept }
    );
  }

  /**
   * Keeps an avatar in the page under `url` (what rehydrateSceneAssets looks players' avatars up
   * by) and returns it as a GLB of at most `maxExportBytes`, or what `accept` makes of it.
   */
  async loadVRMBytes<R = Uint8Array>(bytes: Uint8Array, url: string, { maxExportBytes = DEFAULT_MAX_EXPORT_BYTES, signal, accept }: LoadOptions<Uint8Array, R> = {}): Promise<R> {
    return this.pageCall(
      signal,
      (page, op) =>
        page.evaluate(
          (url, base64, maxExportBytes, op?: string) => window.agentPage!.loadVrm(url, base64, maxExportBytes, op),
          url, toBase64(bytes), maxExportBytes, ...op
        ),
      (exported) => (accept ?? asIs<Uint8Array, R>)(fromBase64(exported)),
      { settled: !!signal || !!accept }
    );
  }

  /** Keeps an image in the page as a texture and returns the id to name it by. `url` is where it came from. */
  async registerTexture(image: { bytes: Uint8Array; contentType: string; url: string }, slot: string, { signal }: { signal?: AbortSignal } = {}): Promise<string> {
    // Only the part three's TextureLoader looks at: of a data: URL, that is what comes before the data
    const source = image.url.startsWith('data:') ? image.url.slice(0, image.url.indexOf(',')) : image.url;
    return this.pageCall(
      signal,
      (page, op) =>
        page.evaluate(
          (base64, contentType, slot, source, op?: string) => window.agentPage!.registerTexture(base64, contentType, slot, source, op),
          toBase64(image.bytes), image.contentType, slot, source, ...op
        ),
      asIs
    );
  }

  /** Drops a texture registerTexture kept (by its id and slot), for a caller that accepted it and then had no use for it. */
  async releaseTexture(id: string, slot: string): Promise<void> {
    // A page built since holds none of the old one's textures: nothing to release then
    const page = this.page
    if (!page) return
    await this.watched(page, () => page.evaluate((id, slot) => { window.agentPage!.releaseTexture(id, slot) }, id, slot))
  }

  public async loadEnvironmentHDR(bytes: Uint8Array, { signal }: { signal?: AbortSignal } = {}): Promise<void> {
    await this.pageCall(
      signal,
      (page, op) =>
        page.evaluate(
          (base64, op?: string) => window.agentPage!.loadEnvironmentHDR(base64, op),
          toBase64(bytes), ...op
        ),
      asIs
    );
  }

  /** Puts the scene of `world` and its other players, as they are now, into the page for drawing. */
  private async rehydrateSceneAssets(page: Page, world: CaptureWorld) {
    const sceneJson = world.stage.scene.toJSON()

    const agentId = world.entities.player?.data.id;
    const players = await Promise.all(
      Array.from(world.entities.players.entries())
        .filter(([_, value]) => value.data.id !== agentId)
        .map(async ([key, value]) => {
          const avatarUrl = await resolveUrl(value.avatarUrl, world);
          const { x, y, z, w } = value.base.quaternion;
          return {
            id: key,
            avatarUrl,
            position: value.base.position.toArray(),
            scale: value.base.scale.toArray(),
            quaternion: [x, y, z, w],
          };
        })
    );

    await this.watched(page, () => page.evaluate(
      (sceneJson, STRIP_SLOTS, players) => { window.agentPage!.rehydrate(sceneJson, STRIP_SLOTS, players) },
      sceneJson, STRIP_SLOTS, players
    ));
  }
}
