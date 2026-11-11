//@ts-nocheck
import path from 'path'
import fs from 'fs'
import { promises as fsPromises } from 'fs';
import puppeteer from 'puppeteer'
import type { IAgentRuntime } from '@elizaos/core'
import type { HyperfyService } from '../service.js'
import { resolveUrl } from '../utils.js';
import { getModuleDirectory } from '../utils.js';
import { childEnv } from '../lib/child-env';
import { modelBudget } from '../lib/gltf-budget';
import { RenderWatchdog, type RenderWatchdogOptions } from '../lib/render-watchdog';

// HyperfyService.serviceType. Not imported as a value: this module must load without the service
// (and the whole engine behind it), which is how scripts/smoke-chromium.mjs runs it.
const HYPERFY_SERVICE = 'hyperfy'

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
const fromBase64 = (text: string) => new Uint8Array(Buffer.from(text, 'base64'))
// The largest model the page returns when the caller names no budget (a model's, lib/gltf-budget.ts)
const DEFAULT_MAX_EXPORT_BYTES = modelBudget('model').exportBytes

/** A page call whose world went away (the caller's signal fired); what it kept in the page was taken back. */
export class PageOperationCancelled extends Error {
  constructor() {
    super('[PuppeteerManager] The page operation was cancelled')
    this.name = 'AbortError'
  }
}

export class PuppeteerManager {
  private static instance: PuppeteerManager | null = null
  private operations = 0
  /**
   * The run-time bound on the page (lib/render-watchdog.ts): every page call below runs under it,
   * and Chromium's tree is killed when it uses too much memory or one call takes too long.
   */
  readonly watchdog: RenderWatchdog
  
  private runtime: IAgentRuntime
  private browser: puppeteer.Browser
  private page: puppeteer.Page
  private browserPromise: Promise<puppeteer.Browser> | null = null
  private initPromise: Promise<puppeteer.Page> | null = null
  private pageScript: Promise<string> | null = null
  private pageBundlePath: string
  private readonly STRIP_SLOTS = [
    'map', 'aoMap', 'alphaMap',
    'bumpMap', 'normalMap',
    'metalnessMap', 'roughnessMap',
    'emissiveMap', 'lightMap'
  ] as const;


  /**
   * `pageBundlePath`: the built render page, when it is not next to this module (the smoke script).
   * `watchdog`: FOR TESTS, a shorter deadline or another process table.
   */
  constructor(runtime: IAgentRuntime, { pageBundlePath, watchdog }: { pageBundlePath?: string; watchdog?: Pick<RenderWatchdogOptions, 'deadlineMs' | 'limitBytes' | 'table'> } = {}) {
    if (PuppeteerManager.instance) {
      throw new Error('PuppeteerManager has already been instantiated.')
    }
    this.watchdog = new RenderWatchdog({
      ...watchdog,
      rootPid: () => this.browser?.process?.()?.pid ?? null,
      kill: (pids) => {
        for (const pid of pids) {
          try {
            process.kill(pid, 'SIGKILL')
          } catch {
            // gone already
          }
        }
        // The next use starts a new browser at once, without waiting for puppeteer to notice
        this.browserPromise = null
        this.browser = null
        this.initPromise = null
        this.page = null
      },
    })
    this.runtime = runtime
    this.pageBundlePath = pageBundlePath ?? path.join(getModuleDirectory(), 'puppeteer', 'page.js')
    PuppeteerManager.instance = this
    // Warm up Chromium in the background; callers await init() themselves.
    this.init().catch(error => {
      console.error('[PuppeteerManager] Failed to launch browser:', error?.message || error)
    })
  }

  public static getInstance(): PuppeteerManager {
    if (!this.instance) {
      throw new Error('PuppeteerManager not yet initialized. Call new PuppeteerManager(runtime) first.')
    }
    return this.instance
  }

  /**
   * Returns the existing manager, so reconnects reuse one Chromium.
   */
  public static getOrCreate(runtime: IAgentRuntime, options?: { pageBundlePath?: string }): PuppeteerManager {
    return this.instance ?? new PuppeteerManager(runtime, options)
  }

  public async close(): Promise<void> {
    if (PuppeteerManager.instance === this) {
      PuppeteerManager.instance = null
    }
    await this.resetPage()
    const browserPromise = this.browserPromise
    this.browserPromise = null
    const browser = await browserPromise?.catch(() => null)
    await browser?.close().catch(error => {
      console.warn('[PuppeteerManager] Error while closing browser:', error?.message || error)
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
    await page?.close().catch(error => {
      console.warn('[PuppeteerManager] Error while closing page:', error?.message || error)
    })
  }

  private getBrowser(): Promise<puppeteer.Browser> {
    if (!this.browserPromise) {
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
          this.browser = browser
          // If Chromium dies, relaunch on the next call instead of reusing a dead handle
          browser.on('disconnected', () => {
            if (this.browserPromise !== browserPromise) return
            this.browserPromise = null
            this.browser = null
            this.initPromise = null
            this.page = null
          })
        },
        // Let a later call retry the launch
        () => { if (this.browserPromise === browserPromise) this.browserPromise = null }
      )
    }
    return this.browserPromise
  }

  private async init(): Promise<puppeteer.Page> {
    // One page per session; reset by resetPage()
    if (!this.initPromise) {
      const initPromise = (async () => {
        const browser = await this.getBrowser()
        const page = await browser.newPage()
        // A page that closed or crashed is rebuilt by the next call. The new one starts without
        // the textures and avatars the old one held; those come back with the next connection.
        const lost = () => {
          if (this.page === page) this.page = null
          if (this.initPromise === initPromise) this.initPromise = null
        }
        page.on('close', lost)
        page.on('error', (error) => {
          console.warn('[PuppeteerManager] The render page crashed and will be rebuilt on next use:', error?.message || error)
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
        this.page = page
        console.info('[PuppeteerManager] Render page ready (Chromium has no network access)')
        return page
      })()
      this.initPromise = initPromise
      // Allow a later call to retry instead of rethrowing the same error forever.
      initPromise.catch(() => {
        if (this.initPromise === initPromise) this.initPromise = null
      })
    }
    return await this.initPromise
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
      console.warn(`[PuppeteerManager] Could not write ${fileName}:`, error?.message || error)
    }
  }

  public async snapshotFacingDirection(
    direction: 'front' | 'back' | 'left' | 'right'
  ): Promise<string> {
    const page = await this.init();
  
    const service = this.getService();
    const world = service.getWorld();
    const player = world.entities.player;
  
    if (!player) {
      throw new Error('Player entity not yet available');
    }

    await world.controls.rotateTo(direction, 500);
    world.controls.stopRotation();  
  
    await this.rehydrateSceneAssets(page);
  
    const playerData = {
      position: player.base.position.toArray() as [number, number, number],
      quaternion: [
        player.base.quaternion.x,
        player.base.quaternion.y,
        player.base.quaternion.z,
        player.base.quaternion.w
      ] as const
    };

    const base64 = await this.watchdog.watch(() => page.evaluate(async (playerData) => {
      return await window.snapshotFacingDirection(playerData);
    }, playerData));
  
    this.saveDebugSnapshot(`scene_facing_${direction}.jpeg`, base64);
  
    return `data:image/jpeg;base64,${base64}`;
  }
  
  public async snapshotViewToTarget(targetPosition: [number, number, number]): Promise<string> {
    const page = await this.init();
  
    const service = this.getService();
    const world = service.getWorld();
    const player = world.entities.player;
  
    if (!player) {
      throw new Error('Player entity not yet available');
    }
  
    await this.rehydrateSceneAssets(page);
  
    const playerData = {
      position: player.base.position.toArray() as [number, number, number]
    };

    const base64 = await this.watchdog.watch(() => page.evaluate(async (playerData, targetPosition) => {
      return await window.snapshotViewToTarget(playerData, targetPosition);
    }, playerData, targetPosition));
  
    this.saveDebugSnapshot('scene_view_to_target.jpeg', base64);
  
    return `data:image/jpeg;base64,${base64}`;
  }
  

  public async snapshotEquirectangular(): Promise<string> {
    const page = await this.init();
  
    const service = this.getService();
    const world = service.getWorld();
    const player = world.entities.player;
  
    if (!player) {
      throw new Error('Player entity not yet available');
    }
  
    await this.rehydrateSceneAssets(page);
  
    const playerData = {
      position: player.base.position.toArray(),
      quaternion: [player.base.quaternion.x, player.base.quaternion.y, player.base.quaternion.z, player.base.quaternion.w] as const
    };
    
    const base64 = await this.watchdog.watch(() => page.evaluate(async (playerData) => {
      return await window.snapshotEquirectangular(playerData);
    }, playerData));
  
    this.saveDebugSnapshot('scene_equirectangular.jpeg', base64);
  
    return `data:image/jpeg;base64,${base64}`;
  }
  
  
  /**
   * The asset loaders below take bytes the agent has already downloaded (lib/asset-bytes.ts): the
   * page cannot fetch anything itself. Bytes cross to the page and back as base64.
   *
   * Each takes a `signal` (the world the asset is for going away): checked once the page is ready
   * and right before the page is asked, so nothing is handed to the page after it fired. A page
   * call cannot be interrupted. With a signal, the page files how to take back what the call kept
   * under the call's id, and every call is then settled: committed when it succeeded and the
   * signal did not fire (the page drops that record at once), taken back otherwise (the call then
   * fails with PageOperationCancelled, or with its own error). No record outlives its call.
   */
  private async pageCall<T>(signal: AbortSignal | undefined, run: (page: puppeteer.Page, op: string[]) => Promise<T>): Promise<T> {
    const page = await this.init()
    if (signal?.aborted) throw new PageOperationCancelled()
    // The id the page files its undo under; only when there is something to cancel
    const op = signal ? [`op-${++this.operations}`] : []
    let result: T
    try {
      result = await this.watchdog.watch(() => run(page, op))
    } catch (error) {
      if (op.length) await this.settle(page, op[0], false)
      throw error
    }
    if (signal?.aborted) {
      await this.settle(page, op[0], false)
      throw new PageOperationCancelled()
    }
    if (op.length) await this.settle(page, op[0], true)
    return result
  }

  /** Commits (`keep`) or takes back what call `op` kept in the page. A page that is gone keeps nothing. */
  private async settle(page: puppeteer.Page, op: string, keep: boolean): Promise<void> {
    await this.watchdog.watch(() => page.evaluate((id, keep) => window.agentPage.settle(id, keep), op, keep)).catch(() => {})
  }

  /**
   * Runs `fn` in the page as a watched page call (the memory limit and the deadline apply). For
   * scripts/smoke-chromium.mjs, which checks the watchdog with it.
   */
  async evaluateWatched<T>(fn: (...args: any[]) => T | Promise<T>, ...args: unknown[]): Promise<T> {
    const page = await this.init()
    return this.watchdog.watch(() => page.evaluate(fn, ...args))
  }

  /**
   * Keeps a model's textures in the page and returns the model without them (GLB). The page
   * refuses to return more than `maxExportBytes` (lib/gltf-budget.ts).
   */
  async loadGlbBytes(bytes: Uint8Array, { maxExportBytes = DEFAULT_MAX_EXPORT_BYTES, signal }: { maxExportBytes?: number; signal?: AbortSignal } = {}): Promise<Uint8Array> {
    const STRIP_SLOTS = this.STRIP_SLOTS;
    const stripped = await this.pageCall(signal, (page, op) =>
      page.evaluate(
        (base64, STRIP_SLOTS, maxExportBytes, op) => window.agentPage.loadGlb(base64, STRIP_SLOTS, maxExportBytes, op),
        toBase64(bytes), STRIP_SLOTS, maxExportBytes, ...op
      )
    );
    return fromBase64(stripped);
  }

  /**
   * Keeps an avatar in the page under `url` (what rehydrateSceneAssets looks players' avatars up
   * by) and returns it as a GLB, of at most `maxExportBytes`.
   */
  async loadVRMBytes(bytes: Uint8Array, url: string, { maxExportBytes = DEFAULT_MAX_EXPORT_BYTES, signal }: { maxExportBytes?: number; signal?: AbortSignal } = {}): Promise<Uint8Array> {
    const exported = await this.pageCall(signal, (page, op) =>
      page.evaluate(
        (url, base64, maxExportBytes, op) => window.agentPage.loadVrm(url, base64, maxExportBytes, op),
        url, toBase64(bytes), maxExportBytes, ...op
      )
    );
    return fromBase64(exported);
  }

  /** Keeps an image in the page as a texture and returns the id to name it by. `url` is where it came from. */
  async registerTexture(image: { bytes: Uint8Array; contentType: string; url: string }, slot: string, { signal }: { signal?: AbortSignal } = {}): Promise<string> {
    // Only the part three's TextureLoader looks at: of a data: URL, that is what comes before the data
    const source = image.url.startsWith('data:') ? image.url.slice(0, image.url.indexOf(',')) : image.url;
    return this.pageCall(signal, (page, op) =>
      page.evaluate(
        (base64, contentType, slot, source, op) => window.agentPage.registerTexture(base64, contentType, slot, source, op),
        toBase64(image.bytes), image.contentType, slot, source, ...op
      )
    );
  }

  public async loadEnvironmentHDR(bytes: Uint8Array, { signal }: { signal?: AbortSignal } = {}): Promise<void> {
    await this.pageCall(signal, (page, op) =>
      page.evaluate(
        (base64, op) => window.agentPage.loadEnvironmentHDR(base64, op),
        toBase64(bytes), ...op
      )
    );
  }

  private async rehydrateSceneAssets(page: puppeteer.Page) {
    const service = this.getService()
    const world = service.getWorld()
    const sceneJson = world.stage.scene.toJSON()

    const agentId = world.entities.player.data.id;
    const players = await Promise.all(
      Array.from(world.entities.players.entries())
        .filter(([_, value]) => value.data.id !== agentId)
        .map(async ([key, value]) => {
          const avatarUrl = await resolveUrl(value.avatarUrl, world);
          return {
            id: key,
            avatarUrl,
            position: value.base.position.toArray(),
            scale: value.base.scale.toArray(),
            quaternion: [
              value.base.quaternion.x,
              value.base.quaternion.y,
              value.base.quaternion.z,
              value.base.quaternion.w,
            ],
          };
        })
    );
    
    const STRIP_SLOTS = this.STRIP_SLOTS;
    await this.watchdog.watch(() => page.evaluate(
      (sceneJson, STRIP_SLOTS, players) => window.agentPage.rehydrate(sceneJson, STRIP_SLOTS, players),
      sceneJson, STRIP_SLOTS, players
    ));
  }

  private getService() {
    return this.runtime.getService<HyperfyService>(HYPERFY_SERVICE)
  }
}
