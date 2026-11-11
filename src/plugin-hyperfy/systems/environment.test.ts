import { afterEach, describe, expect, it, vi } from 'vitest';

// The real PuppeteerManager methods, over a stand-in page whose agentPage records what it keeps.
// `ready` holds the page's init(); `gate` holds registerTexture inside the page.
const page = vi.hoisted(() => ({
  calls: [] as string[],
  textures: new Map<string, string>(),
  environment: null as string | null,
  undo: new Map<string, () => void>(),
  undone: [] as string[],
  committed: [] as string[],
  ready: null as Promise<void> | null,
  gate: null as Promise<void> | null,
}));
vi.mock('../managers/puppeteer-manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../managers/puppeteer-manager.js')>();
  let textures = 0;
  const agentPage = {
    async registerTexture(_base64: string, _type: string, slot: string, source: string, op?: string) {
      page.calls.push(`registerTexture ${source}`);
      await page.gate;
      const key = `t${++textures}:${slot}`;
      page.textures.set(key, source);
      if (op) page.undo.set(op, () => page.textures.delete(key));
      return `t${textures}`;
    },
    loadEnvironmentHDR(base64: string, op?: string) {
      page.calls.push('loadEnvironmentHDR');
      page.environment = base64;
      if (op) page.undo.set(op, () => (page.environment = null));
    },
    settle(op: string, keep: boolean) {
      const undo = page.undo.get(op);
      page.undo.delete(op);
      if (keep) page.committed.push(op);
      else {
        page.undone.push(op);
        undo?.();
      }
    },
  };
  const fakePage = {
    evaluate: async (fn: (...args: unknown[]) => unknown, ...args: unknown[]) => {
      (globalThis as any).window = { agentPage };
      return fn(...args);
    },
  };
  const { RenderWatchdog } = await import('../lib/render-watchdog');
  const manager = Object.create(actual.PuppeteerManager.prototype);
  manager.operations = 0;
  // No browser here: nothing to sample or kill
  manager.watchdog = new RenderWatchdog({ rootPid: () => null, kill: () => {}, table: async () => [] });
  manager.init = async () => {
    await page.ready;
    return fakePage;
  };
  return { ...actual, PuppeteerManager: { getInstance: () => manager } };
});

import { AgentEnvironment } from './environment';
import { NetPolicy, installWorldNet } from '../lib/net-policy';
import { closeServers, startServer } from '../test-support/net';

const prototype = AgentEnvironment.prototype as any;

function refreshSky(error: Error) {
  const environment = {
    updateSky: vi.fn().mockRejectedValue(error),
    reportRenderError: prototype.reportRenderError,
  };
  prototype.refreshSky.call(environment);
  return new Promise<void>((resolve) => setImmediate(resolve));
}

describe('AgentEnvironment render errors', () => {
  afterEach(() => vi.restoreAllMocks());

  it('handles a closed render page at debug level without an unhandled rejection', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const error = new Error('render page closed');
      error.name = 'TargetCloseError';
      await refreshSky(error);

      expect(debug).toHaveBeenCalledTimes(1);
      expect(debug).toHaveBeenCalledWith('[Environment] sky update stopped: the render page was closed');
      expect(warn).not.toHaveBeenCalled();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('warns about other sky update failures', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await refreshSky(new Error('texture failed'));

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[Environment] Could not update the sky:', 'texture failed');
    expect(debug).not.toHaveBeenCalled();
  });
});

/*
 * Sky updates over the real network policy, against a world whose assets are on loopback. A file
 * whose name contains "held" is never answered.
 */
describe('AgentEnvironment sky updates', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    page.calls.length = 0;
    page.textures.clear();
    page.environment = null;
    page.undo.clear();
    page.undone.length = 0;
    page.committed.length = 0;
    page.ready = null;
    page.gate = null;
    await closeServers();
  });

  async function environment() {
    const assets = await startServer((request, response) => {
      if (!request.url?.includes('held')) response.end('image-bytes');
    });
    const origin = `http://127.0.0.1:${assets.port}`;
    const world: any = { assetsUrl: `${origin}/assets`, settings: { on: vi.fn(), off: vi.fn() }, stage: { scene: { add: vi.fn(), fog: 'untouched' } } };
    installWorldNet(world, new NetPolicy({ worldOrigin: origin }));
    const env = new AgentEnvironment(world) as any;
    env.base = { bg: null, hdr: null, sunDirection: 'base-direction', sunIntensity: 1, sunColor: 0xffffff };
    env.csm = { lights: [], lightDirection: 'untouched' };
    env.sky = { material: { userData: {} }, visible: false };
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    return { env, world, assets, origin };
  }
  const sky = (bg: string, hdr: string | null = null) => ({ _bg: bg, _hdr: hdr, _sunDirection: `direction of ${bg}` });

  it('applies the latest sky and stops the download of the one it replaced', async () => {
    const { env, assets, origin } = await environment();
    env.addSky(sky('asset://first-held.jpg'));
    await expect.poll(() => assets.hits.length).toBe(1);
    env.addSky(sky('asset://second.jpg', 'asset://second.hdr'));

    await expect.poll(() => env.csm.lightDirection).toBe('direction of asset://second.jpg');
    expect([...page.textures.values()]).toEqual([`${origin}/assets/second.jpg`]);
    expect(page.environment).toBe(Buffer.from('image-bytes').toString('base64'));
    // Both page calls were committed: the page keeps no record of either
    expect([page.committed.length, page.undo.size]).toEqual([2, 0]);
    await expect.poll(() => assets.cutShort).toBe(1);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('downloads nothing more and changes nothing once destroyed during a download', async () => {
    const { env, world, assets } = await environment();
    env.addSky(sky('asset://held.jpg', 'asset://a.hdr'));
    await expect.poll(() => assets.hits.length).toBe(1);

    env.destroy();

    await expect.poll(() => assets.cutShort).toBe(1);
    expect([page.calls, env.sky.visible, env.csm.lightDirection, world.stage.scene.fog]).toEqual([[], false, 'untouched', 'untouched']);
    expect(assets.hits).toHaveLength(1);
    expect(world.settings.off).toHaveBeenCalledWith('change', env.onSettingsChange);
    // And nothing starts again
    env.addSky(sky('asset://later.jpg'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(assets.hits).toHaveLength(1);
  });

  it('hands the page nothing once destroyed while the page was still starting', async () => {
    const { env, world, assets } = await environment();
    let ready!: () => void;
    page.ready = new Promise<void>((resolve) => (ready = resolve));
    env.addSky(sky('asset://a.jpg', 'asset://a.hdr'));
    await expect.poll(() => assets.hits.length).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 20));

    env.destroy();
    ready();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(page.calls).toEqual([]);
    expect([page.textures.size, page.environment, env.sky.material.userData.materialId, env.sky.visible, world.stage.scene.fog]).toEqual([0, null, undefined, false, 'untouched']);
  });

  it('takes back the texture the page was decoding when the world was destroyed, and changes nothing else', async () => {
    const { env, world, assets } = await environment();
    let release!: () => void;
    page.gate = new Promise<void>((resolve) => (release = resolve));
    env.addSky(sky('asset://a.jpg', 'asset://a.hdr'));
    await expect.poll(() => page.calls.length).toBe(1);

    env.destroy();
    release();
    await expect.poll(() => page.undone.length).toBe(1);

    // The page did keep it while it ran; it is gone again, and nothing after it was asked for
    expect(page.calls).toEqual([`registerTexture http://127.0.0.1:${assets.port}/assets/a.jpg`]);
    expect([page.textures.size, page.environment]).toEqual([0, null]);
    expect([env.sky.material.userData.materialId, env.sky.visible, env.csm.lightDirection, world.stage.scene.fog]).toEqual([undefined, false, 'untouched', 'untouched']);
    expect(assets.hits).toHaveLength(1);
  });
});
