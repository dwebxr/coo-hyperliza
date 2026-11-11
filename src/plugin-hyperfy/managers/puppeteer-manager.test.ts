import { afterEach, describe, expect, it, vi } from 'vitest';

/*
 * The manager against a stand-in for puppeteer: what it asks of the browser (how it is started,
 * that the page is never navigated and refuses its requests, when a page is rebuilt). What the
 * real Chromium then does is checked by scripts/smoke-chromium.mjs, by hand.
 */

const launched: any[] = [];
const launchOptions: any[] = [];
let failNextLaunch = false;
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
        const browser = {
          pages: [] as any[],
          newPage: vi.fn(async () => {
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

  it('takes back what a page call kept when the signal fired while it ran, under the id it passed', async () => {
    const manager = PuppeteerManager.getOrCreate({} as any) as any;
    const page = await manager.init();
    const stop = new AbortController();
    page.evaluate.mockImplementationOnce(async (_fn: unknown, ...args: any[]) => {
      stop.abort();
      return `texture id for ${args.at(-1)}`;
    });

    await expect(manager.registerTexture({ bytes: new Uint8Array([1]), contentType: 'image/png', url: 'https://world.test/a.png' }, 'map', { signal: stop.signal })).rejects.toBeInstanceOf(PageOperationCancelled);

    const [loadCall, undoCall] = page.evaluate.mock.calls.slice(-2);
    const op = loadCall.at(-1);
    expect(op).toMatch(/^op-\d+$/);
    expect(undoCall.slice(1)).toEqual([op]);
    // The undo call runs agentPage.undo with that id
    const undone: string[] = [];
    (globalThis as any).window = { agentPage: { undo: (id: string) => undone.push(id) } };
    undoCall[0](op);
    expect(undone).toEqual([op]);
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
