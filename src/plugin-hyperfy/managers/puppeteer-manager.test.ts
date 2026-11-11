import { afterEach, describe, expect, it, vi } from 'vitest';

/*
 * The manager against a stand-in for puppeteer: what it asks of the browser (how it is started,
 * that the page is never navigated and refuses its requests, when a page is rebuilt). What the
 * real Chromium then does is checked by scripts/smoke-chromium.mjs, by hand.
 */

const launched: any[] = [];
const launchOptions: any[] = [];
let failNextLaunch = false;
// Holds every launch (after its options are recorded) while set
let launchGate: Promise<void> | null = null;
// newPage() never answers while set
let hangNewPage = false;
// Holds every newPage() while set
let newPageGate: Promise<void> | null = null;
// The pid the next browser reports; only above any real pid (macOS stops below 100000), and only with process.kill stubbed
let launchPid: number | undefined;
const writes = vi.hoisted(() => [] as string[]);
vi.mock('puppeteer', () => {
  const makePage = () => {
    const listeners = new Map<string, ((...args: any[]) => void)[]>();
    const page = {
      listeners,
      on: vi.fn((event: string, listener: (...args: any[]) => void) => {
        listeners.set(event, [...(listeners.get(event) ?? []), listener]);
        return page;
      }),
      emit: (event: string, ...args: any[]) => (listeners.get(event) ?? []).forEach((listener) => listener(...args)),
      goto: vi.fn().mockResolvedValue(undefined),
      setRequestInterception: vi.fn().mockResolvedValue(undefined),
      setContent: vi.fn().mockResolvedValue(undefined),
      addScriptTag: vi.fn().mockResolvedValue(undefined),
      waitForFunction: vi.fn().mockResolvedValue(undefined),
      // The page functions answer with base64, as the real ones do
      evaluate: vi.fn(async (_fn: unknown, ...args: any[]) => Buffer.from(`page got ${args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join('|')}`).toString('base64')),
      close: vi.fn(async () => page.emit('close')),
    };
    return page;
  };
  return {
    default: {
      launch: vi.fn(async (options: any) => {
        launchOptions.push(options);
        if (failNextLaunch) {
          failNextLaunch = false;
          throw new Error('no chromium');
        }
        if (launchGate) await launchGate;
        // No pid: the watchdog's kill must never reach a real process from here
        const child = { pid: launchPid, kill: vi.fn() };
        const browser = {
          pages: [] as any[],
          child,
          process: () => child,
          newPage: vi.fn(async () => {
            if (hangNewPage) return new Promise(() => {});
            if (newPageGate) await newPageGate;
            const page = makePage();
            browser.pages.push(page);
            return page;
          }),
          close: vi.fn().mockResolvedValue(undefined),
          on: vi.fn(),
        };
        launched.push(browser);
        return browser;
      }),
    },
  };
});
// The built render page is not there in a source checkout; its content does not matter here.
vi.mock('fs', async (importOriginal) => {
  const actual: any = await importOriginal();
  const mocked = {
    ...actual,
    writeFileSync: vi.fn((file: string) => void writes.push(String(file))),
    promises: { ...actual.promises, readFile: vi.fn().mockResolvedValue('/* render page bundle */') },
  };
  return { ...mocked, default: mocked };
});

import { OFFLINE_CHROMIUM_ARGS, PageOperationCancelled, PuppeteerManager } from './puppeteer-manager';
import { RenderBreaker, RenderPageUnavailable } from '../lib/render-watchdog';

const text = (bytes: Uint8Array) => Buffer.from(bytes).toString();

describe('PuppeteerManager', () => {
  afterEach(async () => {
    await (PuppeteerManager as any).instance?.close();
    launched.length = 0;
    launchOptions.length = 0;
    writes.length = 0;
    vi.unstubAllEnvs();
  });

  it('reuses one browser across sessions and gives each session a fresh page', async () => {
    const manager = PuppeteerManager.getOrCreate({} as any);
    expect(PuppeteerManager.getOrCreate({} as any)).toBe(manager);

    await (manager as any).init();
    await manager.resetPage();
    await (manager as any).init();

    expect(launched).toHaveLength(1);
    const [browser] = launched;
    expect(browser.pages).toHaveLength(2);
    expect(browser.pages[0].close).toHaveBeenCalled();
    expect(browser.pages[1].close).not.toHaveBeenCalled();
  });

  it('close() closes the browser and allows a new manager', async () => {
    const manager = PuppeteerManager.getOrCreate({} as any);
    await (manager as any).init();
    await manager.close();

    expect(launched[0].close).toHaveBeenCalled();
    expect(PuppeteerManager.getOrCreate({} as any)).not.toBe(manager);
  });

  it('retries the launch after a failure instead of rethrowing it forever', async () => {
    failNextLaunch = true;
    const manager = PuppeteerManager.getOrCreate({} as any);
    await vi.waitFor(() => expect((manager as any).initPromise).toBeNull());

    await (manager as any).init();
    expect(launched).toHaveLength(1);
  });

  it('refuses a second constructor call', () => {
    PuppeteerManager.getOrCreate({} as any);
    expect(() => new PuppeteerManager({} as any)).toThrow('already been instantiated');
  });

  it("starts Chromium without the agent's environment, without a way to the network, and without slowMo", async () => {
    const agentOnly = {
      ANTHROPIC_API_KEY: 'value-of-the-anthropic-key',
      ELIZA_SERVER_AUTH_TOKEN: 'value-of-the-api-token',
      TIP_WALLET_PRIVATE_KEY: 'value-of-the-wallet-key',
      POSTGRES_URL: 'value-of-the-database-url',
      HTTPS_PROXY: 'value-of-the-proxy',
      SOMETHING_NEW: 'value-of-a-name-nobody-listed',
    };
    for (const [name, value] of Object.entries(agentOnly)) vi.stubEnv(name, value);
    vi.stubEnv('HOME', '/home/agent');
    await (PuppeteerManager.getOrCreate({} as any) as any).init();

    const [options] = launchOptions;
    expect(options.slowMo).toBeUndefined();
    expect(options.args).toEqual(OFFLINE_CHROMIUM_ARGS);
    expect(options.args).toEqual(['--proxy-server=http://127.0.0.1:9', '--proxy-bypass-list=<-loopback>', '--host-resolver-rules=MAP * ~NOTFOUND']);
    expect(options.env).toMatchObject({ HOME: '/home/agent', PATH: process.env.PATH });
    for (const [name, value] of Object.entries(agentOnly)) {
      expect(Object.keys(options.env)).not.toContain(name);
      expect(Object.values(options.env)).not.toContain(value);
    }
    expect(Object.keys(options.env).filter((name) => /KEY|TOKEN|SECRET|PASSWORD|POSTGRES|PROXY/i.test(name))).toEqual([]);
  });

  it('writes the page into an empty tab, adds its code inline, and refuses every request the page makes', async () => {
    await (PuppeteerManager.getOrCreate({} as any) as any).init();
    const [page] = launched[0].pages;

    expect(page.goto).not.toHaveBeenCalled();
    expect(page.setRequestInterception).toHaveBeenCalledWith(true);
    expect(page.setContent.mock.calls[0][0]).toContain('<!DOCTYPE html>');
    expect(page.setContent.mock.calls[0][0]).not.toMatch(/https?:|<script/);
    expect(page.addScriptTag).toHaveBeenCalledWith({ content: '/* render page bundle */' });
    // Interception was on before any of the page existed
    expect(page.setRequestInterception.mock.invocationCallOrder[0]).toBeLessThan(page.setContent.mock.invocationCallOrder[0]);

    const request = { abort: vi.fn().mockResolvedValue(undefined), continue: vi.fn(), respond: vi.fn() };
    page.emit('request', request);
    expect(request.abort).toHaveBeenCalledTimes(1);
    expect(request.continue).not.toHaveBeenCalled();
    expect(request.respond).not.toHaveBeenCalled();
  });

  it.each(['close', 'error'])('builds a new page on the next use after the page emitted "%s"', async (event) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const manager = PuppeteerManager.getOrCreate({} as any) as any;
    const first = await manager.init();

    first.emit(event, new Error('Page crashed!'));
    expect(manager.page).toBeNull();
    const second = await manager.init();

    expect(second).not.toBe(first);
    expect(launched).toHaveLength(1);
    expect(launched[0].pages).toHaveLength(2);
    expect(await manager.init()).toBe(second);
    vi.restoreAllMocks();
  });

  it('passes asset bytes to the page as base64 and returns bytes', async () => {
    const manager = PuppeteerManager.getOrCreate({} as any);
    const glb = new Uint8Array([103, 108, 84, 70]);

    // With the export budget: a model's unless the caller names one (lib/gltf-budget.ts)
    expect(text(await manager.loadGlbBytes(glb))).toMatch(/^page got Z2xURg==\|\[.*\]\|209715200$/);
    expect(text(await manager.loadVRMBytes(glb, 'https://world.test/assets/me.vrm', { maxExportBytes: 1234 }))).toBe('page got https://world.test/assets/me.vrm|Z2xURg==|1234');
    const [page] = launched[0].pages;
    await manager.registerTexture({ bytes: glb, contentType: 'image/jpeg', url: 'data:image/jpeg;base64,Z2xURg==' }, 'map');
    // Of a data: URL only the part before the data travels again
    expect(page.evaluate.mock.calls.at(-1)!.slice(1)).toEqual(['Z2xURg==', 'image/jpeg', 'map', 'data:image/jpeg;base64']);
    await manager.loadEnvironmentHDR(glb);
    expect(page.evaluate.mock.calls.at(-1)!.slice(1)).toEqual(['Z2xURg==']);
  });

  it('asks the page nothing once the signal fired while the page was being made ready', async () => {
    const manager = PuppeteerManager.getOrCreate({} as any) as any;
    const page = await manager.init();
    const waiting: (() => void)[] = [];
    const ready = () => waiting.splice(0).forEach((go) => go());
    const init = manager.init.bind(manager);
    vi.spyOn(manager, 'init').mockImplementation(() => new Promise((resolve) => waiting.push(() => resolve(init()))));
    const stop = new AbortController();
    const calls = page.evaluate.mock.calls.length;

    const pending = Promise.allSettled([
      manager.loadGlbBytes(new Uint8Array([1]), { signal: stop.signal }),
      manager.loadVRMBytes(new Uint8Array([1]), 'https://world.test/a.vrm', { signal: stop.signal }),
      manager.registerTexture({ bytes: new Uint8Array([1]), contentType: 'image/png', url: 'https://world.test/a.png' }, 'map', { signal: stop.signal }),
      manager.loadEnvironmentHDR(new Uint8Array([1]), { signal: stop.signal }),
    ]);
    stop.abort();
    ready();
    const results = await pending;

    expect(results.map((result) => result.status === 'rejected' && (result.reason as Error).name)).toEqual(['AbortError', 'AbortError', 'AbortError', 'AbortError']);
    expect(results.every((result) => result.status === 'rejected' && result.reason instanceof PageOperationCancelled)).toBe(true);
    expect(page.evaluate.mock.calls.length).toBe(calls);
    vi.restoreAllMocks();
  });

  it('settles a page call whose signal fired while it ran as taken back, under the id it passed (the page side is checked by smoke-chromium)', async () => {
    const manager = PuppeteerManager.getOrCreate({} as any) as any;
    const page = await manager.init();
    const stop = new AbortController();
    page.evaluate.mockImplementationOnce(async (_fn: unknown, ...args: any[]) => {
      stop.abort();
      return `texture id for ${args.at(-1)}`;
    });

    await expect(manager.registerTexture({ bytes: new Uint8Array([1]), contentType: 'image/png', url: 'https://world.test/a.png' }, 'map', { signal: stop.signal })).rejects.toBeInstanceOf(PageOperationCancelled);

    const [loadCall, settleCall] = page.evaluate.mock.calls.slice(-2);
    const op = loadCall.at(-1);
    expect(op).toMatch(/^op-\d+$/);
    expect(settleCall.slice(1)).toEqual([op, 'rollback']);
    // The settle call runs agentPage.settle with that id
    const settled: unknown[][] = [];
    (globalThis as any).window = { agentPage: { settle: (...args: unknown[]) => settled.push(args) } };
    settleCall[0](op, 'rollback');
    expect(settled).toEqual([[op, 'rollback']]);
  });

  it('commits every page call that succeeded with its signal unfired, checks the signal again, then forgets it; and takes back one that failed', async () => {
    const manager = PuppeteerManager.getOrCreate({} as any) as any;
    const page = await manager.init();
    const signal = new AbortController().signal;

    await manager.registerTexture({ bytes: new Uint8Array([1]), contentType: 'image/png', url: 'https://world.test/a.png' }, 'map', { signal });
    const [committedLoad, commit, forget] = page.evaluate.mock.calls.slice(-3);
    expect([commit.slice(1), forget.slice(1)]).toEqual([[committedLoad.at(-1), 'commit'], [committedLoad.at(-1), 'forget']]);

    page.evaluate.mockImplementationOnce(async () => {
      throw new Error('decode failed');
    });
    await expect(manager.loadEnvironmentHDR(new Uint8Array([1]), { signal })).rejects.toThrow('decode failed');
    const [failedLoad, takeBack] = page.evaluate.mock.calls.slice(-2);
    expect(takeBack.slice(1)).toEqual([failedLoad.at(-1), 'rollback']);
  });

  it('takes back what a page call kept when the signal fires while its commit is acknowledged', async () => {
    const manager = PuppeteerManager.getOrCreate({} as any) as any;
    const page = await manager.init();
    const stop = new AbortController();
    const steps: string[] = [];
    page.evaluate.mockImplementation(async (_fn: unknown, ...args: any[]) => {
      if (args.at(-1) === 'commit') stop.abort();
      if (['commit', 'rollback', 'forget'].includes(args.at(-1))) steps.push(args.at(-1));
      return 'texture-id';
    });
    await expect(manager.registerTexture({ bytes: new Uint8Array([1]), contentType: 'image/png', url: 'https://world.test/a.png' }, 'map', { signal: stop.signal })).rejects.toBeInstanceOf(PageOperationCancelled);
    expect(steps).toEqual(['commit', 'rollback']);
  });

  it('fails the page call when its settlement fails, with that error (a kill among them)', async () => {
    const manager = PuppeteerManager.getOrCreate({} as any) as any;
    const page = await manager.init();
    page.evaluate.mockImplementation(async (_fn: unknown, ...args: any[]) => {
      if (args.at(-1) === 'commit') throw new Error('Target closed');
      return 'texture-id';
    });
    await expect(manager.registerTexture({ bytes: new Uint8Array([1]), contentType: 'image/png', url: 'https://world.test/a.png' }, 'map', { signal: new AbortController().signal })).rejects.toThrow('Target closed');
  });

  it('fails a cancelled page call with the error of its take-back when that fails', async () => {
    const manager = PuppeteerManager.getOrCreate({} as any) as any;
    const page = await manager.init();
    const stop = new AbortController();
    page.evaluate.mockImplementation(async (_fn: unknown, ...args: any[]) => {
      if (args.at(-1) === 'rollback') throw new Error('Target closed');
      stop.abort();
      return 'texture-id';
    });
    await expect(manager.registerTexture({ bytes: new Uint8Array([1]), contentType: 'image/png', url: 'https://world.test/a.png' }, 'map', { signal: stop.signal })).rejects.toThrow('Target closed');
  });

  it('ends the generation of a browser that disconnects on its own, and launches another on next use', async () => {
    const manager = new PuppeteerManager({} as any, { watchdog: { table: async () => [], breaker: new RenderBreaker({ log: { warn: () => {} } }) } }) as any;
    await manager.init();
    expect(manager.watchdog.isLive(1)).toBe(true);
    const [, disconnected] = launched[0].on.mock.calls.find(([event]: [string]) => event === 'disconnected');
    disconnected();
    expect(manager.watchdog.isLive(1)).toBe(false);
    await manager.init();
    expect(launched).toHaveLength(2);
  });

  it('stops waiting for the page when the caller\'s signal fires, and fails fast while the render page is down', async () => {
    const breaker = new RenderBreaker({ log: { warn: () => {} } });
    const manager = new PuppeteerManager({} as any, { watchdog: { breaker, table: async () => [] } }) as any;
    const page = await manager.init();
    let built!: () => void;
    // The page is being built (again) for longer than this caller wants to wait
    manager.initPromise = new Promise((resolve) => (built = () => resolve(page)));
    const stop = new AbortController();
    const call = manager.loadEnvironmentHDR(new Uint8Array([1]), { signal: stop.signal }).catch((error: unknown) => error);
    stop.abort();
    expect(await call).toBeInstanceOf(PageOperationCancelled);
    expect(page.evaluate).not.toHaveBeenCalled();
    built();
    for (let i = 0; i < 3; i++) breaker.recordKill();
    await expect(manager.snapshotEquirectangular()).rejects.toBeInstanceOf(RenderPageUnavailable);
  });

  it('runs page calls under its watchdog: a call past the deadline fails with RenderPageKilled, and the next use starts a new browser', async () => {
    const manager = new PuppeteerManager({} as any, { watchdog: { deadlineMs: 100, table: async () => [], breaker: new RenderBreaker({ log: { warn: () => {} } }) } }) as any;
    const page = await manager.init();
    page.evaluate.mockImplementationOnce(() => new Promise(() => {}));
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const error = await manager.loadEnvironmentHDR(new Uint8Array([1])).catch((e: unknown) => e);

    expect(error).toMatchObject({ name: 'RenderPageKilled', reason: 'deadline' });
    expect(launched).toHaveLength(1);
    const next = await manager.init();
    expect(next).not.toBe(page);
    expect(launched).toHaveLength(2);
    vi.restoreAllMocks();
  });

  it('gives building the page a deadline of its own: a page that never gets built fails the wait, and the next use starts again', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    hangNewPage = true;
    const manager = new PuppeteerManager({} as any, { watchdog: { initDeadlineMs: 100, table: async () => [], breaker: new RenderBreaker({ log: { warn: () => {} } }) } }) as any;
    const error = await manager.init().catch((e: unknown) => e);
    hangNewPage = false;
    expect(error).toMatchObject({ name: 'RenderPageKilled', reason: 'deadline', initInFlight: true });
    const page = await manager.init();
    expect(launched).toHaveLength(2);
    expect(launched[1].pages).toEqual([page]);
    vi.restoreAllMocks();
  });

  it("does not let the old browser's late disconnect drop the browser that replaced it", async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const manager = new PuppeteerManager({} as any, { watchdog: { deadlineMs: 100, table: async () => [], breaker: new RenderBreaker({ log: { warn: () => {} } }) } }) as any;
    const first = await manager.init();
    first.evaluate.mockImplementationOnce(() => new Promise(() => {}));
    await expect(manager.loadEnvironmentHDR(new Uint8Array([1]))).rejects.toMatchObject({ name: 'RenderPageKilled' });
    const second = await manager.init();
    // Puppeteer notices only now that the first browser is gone
    const [, disconnected] = launched[0].on.mock.calls.find(([event]: [string]) => event === 'disconnected');
    disconnected();
    expect(await manager.init()).toBe(second);
    expect([launched.length, manager.watchdog.isLive(1), manager.watchdog.isLive(2)]).toEqual([2, false, true]);
    vi.restoreAllMocks();
  });

  it("kills a torn-down browser's process group and every process it was seen to own (process.kill stubbed: nothing is signalled)", async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    launchPid = 4_000_000;
    // The browser leads its group; a helper whose parent exited stays in it
    const rows = [
      { pid: process.pid, ppid: 1, pgid: process.pid, rssBytes: 1 },
      { pid: 4_000_000, ppid: 1, pgid: 4_000_000, rssBytes: 1 },
      { pid: 4_000_001, ppid: 1, pgid: 4_000_000, rssBytes: 1 },
    ];
    const manager = new PuppeteerManager({} as any, { watchdog: { deadlineMs: 100, table: async () => rows, breaker: new RenderBreaker({ log: { warn: () => {} } }) } }) as any;
    const page = await manager.init();
    launchPid = undefined;
    await vi.waitFor(() => expect(manager.watchdog.ownership(1)).toEqual({ pids: [4_000_000, 4_000_001], group: 4_000_000 }));
    page.evaluate.mockImplementationOnce(() => new Promise(() => {}));
    await expect(manager.loadEnvironmentHDR(new Uint8Array([1]))).rejects.toMatchObject({ name: 'RenderPageKilled' });
    // Once from what it knew, once more from a fresh table
    await vi.waitFor(() => expect(kill.mock.calls.length).toBe(6));
    expect(kill.mock.calls.slice(0, 3)).toEqual([[-4_000_000, 'SIGKILL'], [4_000_000, 'SIGKILL'], [4_000_001, 'SIGKILL']]);
    vi.restoreAllMocks();
  });

  it('kills and closes a browser whose launch finishes after its generation was given up, and builds no page on it', async () => {
    let launch!: () => void;
    launchGate = new Promise<void>((resolve) => (launch = resolve));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const manager = new PuppeteerManager({} as any, { watchdog: { table: async () => [], breaker: new RenderBreaker({ log: { warn: () => {} } }) } }) as any;
    const warmUp = manager.initPromise;
    await vi.waitFor(() => expect(launchOptions).toHaveLength(1));
    // What a teardown does: the next use starts another browser
    manager.dropGeneration(manager.generation);
    launchGate = null;
    launch();
    await expect(warmUp).rejects.toThrow('given up');
    const [late] = launched;
    expect([late.close.mock.calls.length > 0, late.child.kill.mock.calls, late.pages.length, manager.watchdog.isLive(1)]).toEqual([true, [['SIGKILL']], 0, false]);
    await manager.init();
    expect(launched).toHaveLength(2);
    vi.restoreAllMocks();
  });

  it('closes a page that finishes building after its browser was given up, and fails that build', async () => {
    let built!: () => void;
    newPageGate = new Promise<void>((resolve) => (built = resolve));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const manager = new PuppeteerManager({} as any, { watchdog: { table: async () => [], breaker: new RenderBreaker({ log: { warn: () => {} } }) } }) as any;
    const warmUp = manager.initPromise;
    await vi.waitFor(() => expect(launched[0]?.newPage).toHaveBeenCalled());
    // What a teardown does
    manager.dropGeneration(manager.generation);
    newPageGate = null;
    built();
    await expect(warmUp).rejects.toThrow('given up');
    expect(launched[0].pages[0].close).toHaveBeenCalled();
    expect(manager.page).toBeNull();
    vi.restoreAllMocks();
  });

  it('a reset while the first page is being built closes that page without calling it a failure; the next use builds another', async () => {
    let launch!: () => void;
    launchGate = new Promise<void>((resolve) => (launch = resolve));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const manager = new PuppeteerManager({} as any, { watchdog: { table: async () => [], breaker: new RenderBreaker({ log: { warn: () => {} } }) } }) as any;
    await vi.waitFor(() => expect(launchOptions).toHaveLength(1));
    // A world that could not be joined is cleaned up while Chromium still starts
    const reset = manager.resetPage();
    launchGate = null;
    launch();
    await reset;
    expect(launched[0].pages[0].close).toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    const next = await manager.init();
    expect([launched.length, launched[0].pages.length, launched[0].pages[1]]).toEqual([1, 2, next]);
    vi.restoreAllMocks();
  });

  it('returns the page\'s bytes in memory of their own, exactly as long (not a view into the buffer pool)', async () => {
    const manager = PuppeteerManager.getOrCreate({} as any);
    const bytes = await manager.loadGlbBytes(new Uint8Array([1, 2, 3]));
    expect([bytes.byteOffset, bytes.buffer.byteLength]).toEqual([0, bytes.byteLength]);
    expect(text(bytes)).toMatch(/^page got /);
  });

  it('writes diagnostic snapshots to disk only when HYPERFY_DEBUG_SNAPSHOTS=true', async () => {
    const vector = { toArray: () => [0, 0, 0], x: 0, y: 0, z: 0, w: 1 };
    const world = {
      stage: { scene: { toJSON: () => ({}) } },
      controls: { rotateTo: async () => {}, stopRotation: () => {} },
      entities: { player: { data: { id: 'coo' }, base: { position: vector, quaternion: vector } }, players: new Map() },
    };
    const manager = PuppeteerManager.getOrCreate({ getService: () => ({ getWorld: () => world }) } as any);

    await manager.snapshotEquirectangular();
    await manager.snapshotFacingDirection('front');
    await manager.snapshotViewToTarget([1, 2, 3]);
    expect(writes).toEqual([]);

    for (const value of ['1', 'yes', 'TRUE', '']) {
      vi.stubEnv('HYPERFY_DEBUG_SNAPSHOTS', value);
      await manager.snapshotEquirectangular();
    }
    expect(writes).toEqual([]);

    vi.stubEnv('HYPERFY_DEBUG_SNAPSHOTS', 'true');
    expect(await manager.snapshotEquirectangular()).toMatch(/^data:image\/jpeg;base64,/);
    await manager.snapshotFacingDirection('front');
    await manager.snapshotViewToTarget([1, 2, 3]);
    expect(writes.map((file) => file.split('/').pop())).toEqual(['scene_equirectangular.jpeg', 'scene_facing_front.jpeg', 'scene_view_to_target.jpeg']);
  });
});
