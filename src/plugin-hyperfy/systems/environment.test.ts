import { afterEach, describe, expect, it, vi } from 'vitest';

// The real PuppeteerManager methods, over a stand-in page whose agentPage records what it keeps.
// `ready` holds the page's init(); `gate` holds registerTexture inside the page; `acknowledge`
// holds the answer to a settlement step while set.
const page = vi.hoisted(() => ({
  calls: [] as string[],
  textures: new Map<string, string>(),
  environment: null as string | null,
  undo: new Map<string, () => void>(),
  undone: [] as string[],
  committed: [] as string[],
  ready: null as Promise<void> | null,
  gate: null as Promise<void> | null,
  /** What registerTexture fails with, while set */
  fail: null as Error | null,
  acknowledge: null as Promise<void> | null,
  released: [] as string[],
}));
vi.mock('../managers/puppeteer-manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../managers/puppeteer-manager.js')>();
  let textures = 0;
  const agentPage = {
    async registerTexture(_base64: string, _type: string, slot: string, source: string, op?: string) {
      page.calls.push(`registerTexture ${source}`);
      await page.gate;
      if (page.fail) throw page.fail;
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
    settle(op: string, step: 'rollback' | 'forget') {
      const undo = page.undo.get(op);
      page.undo.delete(op);
      if (step === 'forget') page.committed.push(op);
      else {
        page.undone.push(op);
        undo?.();
      }
    },
    releaseTexture(id: string, slot: string) {
      page.released.push(`${id}:${slot}`);
      page.textures.delete(`${id}:${slot}`);
    },
  };
  const fakePage = {
    evaluate: async (fn: (...args: unknown[]) => unknown, ...args: unknown[]) => {
      (globalThis as any).window = { agentPage };
      const out = await fn(...args);
      // A settlement step's answer, held while `acknowledge` is set
      if (args.length === 2 && (args[1] === 'forget' || args[1] === 'rollback')) await page.acknowledge;
      return out;
    },
  };
  const { RenderWatchdog } = await import('../lib/render-watchdog');
  const manager = Object.create(actual.PuppeteerManager.prototype);
  manager.operations = 0;
  manager.generation = 1;
  manager.pageGeneration = new WeakMap();
  // No browser here: nothing to sample or kill
  manager.watchdog = new RenderWatchdog({ kill: () => {}, table: async () => [] });
  manager.page = fakePage;
  manager.init = async () => {
    await page.ready;
    return fakePage;
  };
  return { ...actual, PuppeteerManager: { getInstance: () => manager } };
});

import { AgentEnvironment } from './environment';
import { PuppeteerManager } from '../managers/puppeteer-manager.js';
import { NetPolicy, installWorldNet } from '../lib/net-policy';
import { closeServers, startServer } from '../test-support/net';
import { assetMemory } from '../lib/asset-memory';
import { RenderPageKilled } from '../lib/render-watchdog';

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
    page.fail = null;
    page.acknowledge = null;
    page.released.length = 0;
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

  it('releases a sky texture the page had already been told was accepted when a newer sky came during that acknowledgment', async () => {
    const { env, origin } = await environment();
    let acknowledge!: () => void;
    page.acknowledge = new Promise<void>((resolve) => (acknowledge = resolve));
    env.addSky(sky('asset://first.jpg'));
    // The page has dropped its record (forget); its answer is on the way
    await expect.poll(() => page.committed.length).toBe(1);
    const [first] = [...page.textures.keys()];
    page.acknowledge = null;
    env.addSky(sky('asset://second.jpg'));
    acknowledge();
    await expect.poll(() => env.csm.lightDirection).toBe('direction of asset://second.jpg');
    await expect.poll(() => page.released).toEqual([first]);
    // Only the newer sky's texture is left, and it is the one the sky shows
    const [second] = [...page.textures.keys()];
    expect([...page.textures.values()]).toEqual([`${origin}/assets/second.jpg`]);
    expect(`${env.sky.material.userData.materialId}:map`).toBe(second);
  });

  it('downloads and registers a sky image once: a sky update that asks for the same image and HDR again reuses what the page holds', async () => {
    const { env, assets, origin } = await environment();
    env.addSky(sky('asset://day.jpg', 'asset://day.hdr'));
    await expect.poll(() => env.csm.lightDirection).toBe('direction of asset://day.jpg');
    const shown = env.sky.material.userData.materialId;
    expect(page.calls).toEqual([`registerTexture ${origin}/assets/day.jpg`, 'loadEnvironmentHDR']);

    // Another sky node with the same image and HDR and another sun (what an app's script does when it changes its sky)
    const second = env.addSky({ ...sky('asset://day.jpg', 'asset://day.hdr'), _sunDirection: 'evening' });
    await expect.poll(() => env.csm.lightDirection).toBe('evening');
    // ...and back to the first when that node goes away
    second.destroy();
    await expect.poll(() => env.csm.lightDirection).toBe('direction of asset://day.jpg');

    expect(page.calls).toEqual([`registerTexture ${origin}/assets/day.jpg`, 'loadEnvironmentHDR']);
    expect(assets.hits.map((hit) => hit.url)).toEqual(['/assets/day.jpg', '/assets/day.hdr']);
    expect(page.textures.size).toBe(1);
    expect(env.sky.material.userData.materialId).toBe(shown);
    expect(env.sky.visible).toBe(true);
    expect(env.skyInfo.bgUrl).toBe(`${origin}/assets/day.jpg`);
    expect(page.released).toEqual([]);
  });

  it('releases the texture of the sky image it replaces, so the page holds one sky texture at a time', async () => {
    const { env, origin } = await environment();
    env.addSky(sky('asset://day.jpg'));
    await expect.poll(() => env.csm.lightDirection).toBe('direction of asset://day.jpg');
    const [first] = [...page.textures.keys()];
    for (const image of ['night.jpg', 'dawn.jpg', 'day.jpg']) {
      env.addSky(sky(`asset://${image}`));
      await expect.poll(() => env.csm.lightDirection).toBe(`direction of asset://${image}`);
      expect([...page.textures.values()]).toEqual([`${origin}/assets/${image}`]);
    }
    expect(page.released[0]).toBe(first);
    expect(page.released).toHaveLength(3);
    expect(`${env.sky.material.userData.materialId}:map`).toBe([...page.textures.keys()][0]);
  });

  it('registers the sky image and the HDR again once the render page was rebuilt, and releases nothing in the new page', async () => {
    const { env, origin } = await environment();
    const manager = PuppeteerManager.getInstance() as unknown as { pageEpoch: number };
    manager.pageEpoch = 1;
    try {
      env.addSky(sky('asset://day.jpg', 'asset://day.hdr'));
      await expect.poll(() => env.csm.lightDirection).toBe('direction of asset://day.jpg');
      // A crash or a kill: the next page starts with nothing of the old one
      manager.pageEpoch = 2;
      page.textures.clear();
      page.environment = null;
      env.addSky({ ...sky('asset://day.jpg', 'asset://day.hdr'), _sunDirection: 'after the rebuild' });
      await expect.poll(() => env.csm.lightDirection).toBe('after the rebuild');
      expect(page.calls).toEqual([`registerTexture ${origin}/assets/day.jpg`, 'loadEnvironmentHDR', `registerTexture ${origin}/assets/day.jpg`, 'loadEnvironmentHDR']);
      expect(page.textures.size).toBe(1);
      expect(page.environment).not.toBeNull();
      expect(`${env.sky.material.userData.materialId}:map`).toBe([...page.textures.keys()][0]);
      expect(page.released).toEqual([]);
    } finally {
      delete (manager as { pageEpoch?: number }).pageEpoch;
    }
  });

  it('a sky update that was replaced does not put its image on the sky when the page answers it after the newer sky is in place', async () => {
    const { env, origin } = await environment();
    let acknowledge!: () => void;
    page.acknowledge = new Promise<void>((resolve) => (acknowledge = resolve));
    env.addSky(sky('asset://first.jpg'));
    // The page holds the first image and has dropped its record; its answer is held back
    await expect.poll(() => page.committed.length).toBe(1);
    page.acknowledge = null;
    env.addSky(sky('asset://second.jpg'));
    // The newer sky is fully in place before the first update hears from the page
    await expect.poll(() => env.csm.lightDirection).toBe('direction of asset://second.jpg');
    const shown = env.sky.material.userData.materialId;
    acknowledge();
    await expect.poll(() => page.released.length).toBe(1);
    // The sky still shows the newer image, and that image is the one the page keeps
    expect(env.sky.material.userData.materialId).toBe(shown);
    expect([...page.textures.values()]).toEqual([`${origin}/assets/second.jpg`]);
    expect(`${shown}:map`).toBe([...page.textures.keys()][0]);
    expect(env.csm.lightDirection).toBe('direction of asset://second.jpg');
  });

  it("holds the agent's memory reservation for a sky image while it is on its way, and gives it back", async () => {
    const { env } = await environment();
    let release!: () => void;
    page.gate = new Promise<void>((resolve) => (release = resolve));
    env.addSky(sky('asset://a.jpg'));
    await expect.poll(() => page.calls.length).toBe(1);
    // In the page: the download was exchanged for 6 x its 11 bytes of work (lib/asset-memory.ts SEND_COPIES)
    expect(assetMemory.held).toEqual({ downloads: 0, work: 66 });
    release();
    await expect.poll(() => page.committed.length).toBe(1);
    expect(assetMemory.held).toEqual({ downloads: 0, work: 0 });
  });

  it('does not hand the page again, for this world, a sky image that got it killed while it was the only page call', async () => {
    const { env, assets } = await environment();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    page.fail = new RenderPageKilled('memory', 'killed: too much memory', 4e9, 1, 1);
    env.addSky(sky('asset://heavy.jpg'));
    await expect.poll(() => (console.warn as any).mock.calls.length).toBe(1);
    expect((console.warn as any).mock.calls[0][1]).toBe('killed: too much memory');
    page.fail = null;
    env.addSky(sky('asset://heavy.jpg'));
    await expect.poll(() => (console.warn as any).mock.calls.length).toBe(2);
    expect((console.warn as any).mock.calls[1][1]).toMatch(/Not handing the image .*heavy\.jpg to the render page again: killed: too much memory/);
    // Neither downloaded nor handed to the page again
    expect([page.calls.length, assets.hits.length]).toEqual([1, 1]);
    expect(console.error).toHaveBeenCalledTimes(1);
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
