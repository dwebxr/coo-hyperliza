import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The loader hands model bytes to the render page and gets them back without textures; here the
// real PuppeteerManager page calls (settlement included) run over a stand-in page whose loads hand
// the bytes back as they are and keep one "texture" each until it is taken back or accepted.
// `returns` replaces what the page hands back; `gate` holds the page's answer until it resolves.
const page = vi.hoisted(() => ({
  glb: [] as number[],
  vrm: [] as [number, string][],
  budgets: [] as number[],
  signals: [] as (AbortSignal | undefined)[],
  returns: null as Uint8Array | null,
  gate: null as Promise<void> | null,
  afterFetch: null as (() => void) | null,
  fail: null as Error | null,
  /** What the page keeps, by load: the op it was filed under */
  kept: new Map<string, string>(),
  undo: new Map<string, () => void>(),
  steps: [] as string[],
}));
vi.mock('../managers/puppeteer-manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../managers/puppeteer-manager.js')>();
  const { RenderWatchdog, RenderBreaker } = await import('../lib/render-watchdog');
  let loads = 0;
  const keep = (op: string | undefined) => {
    const key = `load-${++loads}`;
    page.kept.set(key, op ?? '');
    if (op) page.undo.set(op, () => page.kept.delete(key));
  };
  const answer = async (base64: string, op?: string) => {
    await page.gate;
    if (page.fail) throw page.fail;
    keep(op);
    return page.returns ? Buffer.from(page.returns).toString('base64') : base64;
  };
  const agentPage = {
    loadGlb: async (base64: string, _slots: string[], maxExportBytes: number, op?: string) => {
      page.glb.push(Buffer.from(base64, 'base64').byteLength);
      page.budgets.push(maxExportBytes);
      return answer(base64, op);
    },
    loadVrm: async (url: string, base64: string, maxExportBytes: number, op?: string) => {
      page.vrm.push([Buffer.from(base64, 'base64').byteLength, url]);
      page.budgets.push(maxExportBytes);
      return answer(base64, op);
    },
    settle(op: string, step: 'rollback' | 'forget') {
      page.steps.push(step);
      const undo = page.undo.get(op);
      page.undo.delete(op);
      if (step === 'rollback') undo?.();
    },
  };
  const fakePage = {
    evaluate: async (fn: (...args: unknown[]) => unknown, ...args: unknown[]) => {
      (globalThis as any).window = { agentPage };
      try {
        return await fn(...args);
      } finally {
        delete (globalThis as any).window;
      }
    },
  };
  const manager = Object.create(actual.PuppeteerManager.prototype);
  manager.operations = 0;
  manager.generation = 1;
  manager.pageGeneration = new WeakMap();
  manager.page = fakePage;
  // No browser here: nothing to sample or kill
  manager.watchdog = new RenderWatchdog({ kill: () => {}, table: async () => [], breaker: new RenderBreaker({ log: { warn: () => {} } }) });
  manager.init = async () => fakePage;
  for (const name of ['loadGlbBytes', 'loadVRMBytes'] as const) {
    const real = manager[name];
    manager[name] = (...args: any[]) => {
      page.signals.push(args.at(-1)?.signal);
      return real.apply(manager, args);
    };
  }
  return { ...actual, PuppeteerManager: { getInstance: () => manager } };
});

// The real fetchAssetBytes; `page.afterFetch` runs as it resolves (before the loader continues)
vi.mock('../lib/asset-bytes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/asset-bytes')>();
  return {
    ...actual,
    fetchAssetBytes: async (...args: Parameters<typeof actual.fetchAssetBytes>) => {
      const asset = await actual.fetchAssetBytes(...args);
      page.afterFetch?.();
      return asset;
    },
  };
});

import { AgentLoader, LOADER_LIMITS, type LoaderLimits } from './loader';
import { GLTFLoader } from '../hyperfy/src/core/libs/gltfloader/GLTFLoader.js';
import { RenderPageKilled } from '../lib/render-watchdog';
import { assetMemory, modelReservation } from '../lib/asset-memory';
import { gltfCharge, modelBudget } from '../lib/gltf-budget';
import { NetPolicy, installWorldNet } from '../lib/net-policy';
import { type Handler, type TestServer, closeServers, startServer } from '../test-support/net';

/*
 * The real loader over the real network policy, against a world whose assets are served on
 * loopback (the world's own origin, so the exception applies) and a second loopback server that
 * stands for something inside the agent's network.
 */

afterEach(async () => {
  vi.restoreAllMocks();
  page.glb.length = 0;
  page.vrm.length = 0;
  page.budgets.length = 0;
  page.signals.length = 0;
  page.returns = null;
  page.gate = null;
  page.afterFetch = null;
  page.fail = null;
  page.kept.clear();
  page.undo.clear();
  page.steps.length = 0;
  await closeServers();
});

/** A GLB with one node and `extra` in its JSON, padded with spaces to at least `size` bytes. */
function minimalGlb({ extra = {}, size = 0 }: { extra?: Record<string, unknown>; size?: number } = {}): Uint8Array {
  const json = JSON.stringify({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: 'Root' }], ...extra });
  const text = new TextEncoder().encode(json.padEnd(Math.max(Math.ceil(json.length / 4) * 4, Math.ceil((size - 20) / 4) * 4), ' '));
  const glb = new Uint8Array(12 + 8 + text.length);
  const view = new DataView(glb.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, glb.length, true);
  view.setUint32(12, text.length, true);
  view.setUint32(16, 0x4e4f534a, true);
  glb.set(text, 20);
  return glb;
}

/** A GLB of the given chunks (type, bytes), each padded to 4 bytes. */
function glbOfChunks(chunks: [number, Uint8Array][]): Uint8Array {
  const padded = chunks.map(([type, bytes]): [number, Uint8Array] => {
    const out = new Uint8Array(Math.ceil(bytes.length / 4) * 4).fill(type === 0x4e4f534a ? 0x20 : 0);
    out.set(bytes);
    return [type, out];
  });
  const glb = new Uint8Array(12 + padded.reduce((sum, [, bytes]) => sum + 8 + bytes.length, 0));
  const view = new DataView(glb.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, glb.length, true);
  let offset = 12;
  for (const [type, bytes] of padded) {
    view.setUint32(offset, bytes.length, true);
    view.setUint32(offset + 4, type, true);
    glb.set(bytes, offset + 8);
    offset += 8 + bytes.length;
  }
  return glb;
}
const jsonChunk = (json: unknown): [number, Uint8Array] => [0x4e4f534a, new TextEncoder().encode(JSON.stringify(json))];

const scriptServer: Handler = (request, response) => response.end(`// ${request.url}`);

async function setup({ handler = scriptServer, limits, scripts }: { handler?: Handler; limits?: Partial<LoaderLimits>; scripts?: any } = {}) {
  const assets = await startServer(handler);
  const internal = await startServer((_request, response) => response.end('internal'));
  const origin = `http://127.0.0.1:${assets.port}`;
  const world: any = { assetsUrl: `${origin}/assets` };
  installWorldNet(world, new NetPolicy({ worldOrigin: origin }));
  const loader = new AgentLoader(world, { limits, scripts });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  return { loader, world, assets, internal, origin };
}
const paths = (server: TestServer) => server.hits.map((hit) => hit.url);

describe('AgentLoader', () => {
  it('loads a script from the world and keeps it unevaluated when scripts are off', async () => {
    const { loader, assets } = await setup();

    const script = await loader.load('script', 'asset://app.js');

    expect(script.code).toBe('// /assets/app.js');
    expect(typeof script.exec).toBe('function');
    expect(loader.get('script', 'asset://app.js')).toBe(script);
    expect(loader.has('script', 'asset://app.js')).toBe(true);
    expect(paths(assets)).toEqual(['/assets/app.js']);
  });

  it('hands a script to the sandbox runtime when there is one', async () => {
    const evaluated: string[] = [];
    const { loader } = await setup({ scripts: { evaluate: (code: string) => (evaluated.push(code), { exec() {}, code }) } });
    await loader.load('script', 'asset://app.js');
    expect(evaluated).toEqual(['// /assets/app.js']);
  });

  it('downloads an asset once when it is asked for twice at the same moment', async () => {
    const { loader, assets } = await setup();

    // Before the fix, the second call arrived while the first was still resolving the URL, found
    // nothing registered, and downloaded the file again
    const first = loader.load('script', 'asset://app.js');
    const second = loader.load('script', 'asset://app.js');

    expect(second).toBe(first);
    expect(loader.has('script', 'asset://app.js')).toBe(true);
    expect(await first).toBe(await second);
    expect(await loader.load('script', 'asset://app.js')).toBe(await first);
    expect(paths(assets)).toEqual(['/assets/app.js']);
  });

  it('downloads a model once and passes its bytes to the render page, not its URL', async () => {
    const glb = minimalGlb();
    const { loader, assets } = await setup({ handler: (_request, response) => response.end(Buffer.from(glb)) });

    const [a, b] = await Promise.all([loader.load('model', 'asset://thing.glb'), loader.load('model', 'asset://thing.glb')]);

    expect(a).toBe(b);
    expect(a.gltf.scene.children[0].name).toBe('Root');
    expect(typeof a.toNodes).toBe('function');
    // One request in all: the agent no longer asks first and lets Chromium download it again
    expect(paths(assets)).toEqual(['/assets/thing.glb']);
    expect(page.glb).toEqual([glb.byteLength]);
  });

  it('gives the render page an avatar under its resolved URL', async () => {
    const glb = minimalGlb();
    const { loader, origin } = await setup({ handler: (_request, response) => response.end(Buffer.from(glb)) });
    await loader.load('avatar', 'asset://me.vrm');
    expect(page.vrm).toEqual([[glb.byteLength, `${origin}/assets/me.vrm`]]);
  });

  it.each([
    ['another port on loopback', (internal: TestServer) => `http://127.0.0.1:${internal.port}/internal.glb`],
    ['the same machine by name', (internal: TestServer) => `http://localhost:${internal.port}/internal.glb`],
    ['a private address', () => 'https://10.0.0.8/internal.glb'],
    ['the metadata address', () => 'http://169.254.169.254/latest/meta-data/'],
    ['a URL with credentials', (_internal: TestServer, origin: string) => origin.replace('http://', 'http://user:pw@') + '/assets/app.js'],
    ['a file URL', () => 'file:///etc/hosts'],
    ['a path outside the module directory', () => '../../../../../etc/hosts'],
    ['a blob URL', () => 'blob:nodedata:1234'],
  ])('loads nothing from %s, whoever named it, and asks no server', async (_name, url) => {
    const { loader, assets, internal, origin } = await setup();

    for (const type of ['model', 'script', 'avatar', 'emote']) {
      await expect(loader.load(type, url(internal, origin))).rejects.toThrow();
      expect(loader.has(type, url(internal, origin))).toBe(false);
    }
    expect(internal.connections + assets.connections).toBe(0);
    expect(page.glb).toEqual([]);
  });

  it('follows a redirect inside the world and refuses one that leaves it', async () => {
    let elsewhere = '';
    const { loader, assets, internal } = await setup({
      handler: (request, response) => {
        if (request.url === '/assets/moved.js') response.writeHead(302, { location: '/assets/app.js' }).end();
        else if (request.url === '/assets/away.js') response.writeHead(302, { location: elsewhere }).end();
        else response.end('// ok');
      },
    });
    elsewhere = `http://127.0.0.1:${internal.port}/secret`;

    await expect(loader.load('script', 'asset://moved.js')).resolves.toMatchObject({ code: '// ok' });
    await expect(loader.load('script', 'asset://away.js')).rejects.toThrow("http:// is only allowed on the world's own origin");

    expect(paths(assets)).toEqual(['/assets/moved.js', '/assets/app.js', '/assets/away.js']);
    expect(internal.connections).toBe(0);
  });

  it('asks nothing for the kinds of asset the agent does not use', async () => {
    const { loader, assets, origin } = await setup();
    for (const type of ['image', 'texture', 'hdr', 'video', 'audio', 'constructor', '']) {
      await expect(loader.load(type, `${origin}/assets/a.png`)).resolves.toBeNull();
      expect(loader.has(type, `${origin}/assets/a.png`)).toBe(false);
    }
    expect(assets.connections).toBe(0);
    expect(loader.promises.size).toBe(0);
  });

  it('forgets a failed load, so the next one tries again', async () => {
    let status = 404;
    const { loader, assets } = await setup({ handler: (_request, response) => response.writeHead(status).end('// later') });

    await expect(loader.load('script', 'asset://app.js')).rejects.toThrow('HTTP 404');
    expect(loader.has('script', 'asset://app.js')).toBe(false);
    status = 200;
    await expect(loader.load('script', 'asset://app.js')).resolves.toMatchObject({ code: '// later' });
    expect(assets.hits).toHaveLength(2);
  });

  it('refuses a script larger than the operator cap for scripts', async () => {
    const { loader } = await setup({ handler: (_request, response) => response.writeHead(200, { 'content-length': String(64 * 1024 * 1024) }).end() });
    await expect(loader.load('script', 'asset://huge.js')).rejects.toMatchObject({ kind: 'too-large' });
  });

  it('keeps a bounded number of loaded assets, dropping the least recently used', async () => {
    const { loader, assets } = await setup({ limits: { cacheEntries: 3 } });
    const url = (n: number) => `asset://s${n}.js`;

    for (let n = 1; n <= 3; n++) await loader.load('script', url(n));
    // Using the first again makes the second the oldest
    expect(loader.get('script', url(1))).toBeDefined();
    await loader.load('script', url(4));
    await loader.load('script', url(5));

    expect([1, 2, 3, 4, 5].map((n) => loader.has('script', url(n)))).toEqual([true, false, false, true, true]);
    expect(loader.results.size).toBe(3);
    expect(loader.promises.size).toBe(3);
    // A dropped asset is simply loaded again
    assets.hits.length = 0;
    await loader.load('script', url(2));
    await loader.load('script', url(5));
    expect(paths(assets)).toEqual(['/assets/s2.js']);
    expect(loader.results.size).toBe(3);
  });

  it('keeps a bounded number of downloaded bytes', async () => {
    const { loader } = await setup({ handler: (_request, response) => response.end(Buffer.alloc(40)), limits: { cacheBytes: 100 } });

    for (let n = 1; n <= 5; n++) await loader.load('script', `asset://s${n}.js`);

    // 40 bytes each: two fit under 100
    expect([...loader.results.keys()]).toEqual(['script/asset://s4.js', 'script/asset://s5.js']);
    expect(loader.promises.size).toBe(2);
  });

  it('hands one asset bigger than the whole byte budget to its caller, and keeps it alone', async () => {
    const { loader } = await setup({ handler: (request, response) => response.end(Buffer.alloc(request.url?.includes('big') ? 150 : 40)), limits: { cacheBytes: 100 } });
    await loader.load('script', 'asset://s1.js');
    await loader.load('script', 'asset://s2.js');

    const big = await loader.load('script', 'asset://big.js');

    expect(big.code).toHaveLength(150);
    expect([...loader.results.keys()]).toEqual(['script/asset://big.js']);
    expect([...loader.promises.keys()]).toEqual(['script/asset://big.js']);
    // The next one pushes it out
    await loader.load('script', 'asset://s3.js');
    expect([...loader.results.keys()]).toEqual(['script/asset://s3.js']);
  });

  it('charges a model with the larger of its download and the copy the page handed back', async () => {
    const download = minimalGlb();
    const { loader } = await setup({ handler: (_request, response) => response.end(Buffer.from(download)), limits: { cacheBytes: 1000 } });
    page.returns = minimalGlb({ size: 600 });

    await loader.load('model', 'asset://a.glb');
    await loader.load('model', 'asset://b.glb');

    // 600 each from the page (the download is under 200): one fits under 1000
    expect(download.byteLength).toBeLessThan(200);
    expect([...loader.results.keys()]).toEqual(['model/asset://b.glb']);
  });

  it('counts a load served from the cache as a use, as get() does', async () => {
    const { loader, assets } = await setup({ limits: { cacheEntries: 3 } });
    const url = (n: number) => `asset://s${n}.js`;
    for (let n = 1; n <= 3; n++) await loader.load('script', url(n));

    await loader.load('script', url(1));
    await loader.load('script', url(4));

    expect([1, 2, 3, 4].map((n) => loader.has('script', url(n)))).toEqual([true, false, true, true]);
    expect(paths(assets)).toEqual(['/assets/s1.js', '/assets/s2.js', '/assets/s3.js', '/assets/s4.js']);
  });

  it('by default keeps at most LOADER_LIMITS.cacheEntries assets', async () => {
    const { loader } = await setup();
    for (let n = 0; n < LOADER_LIMITS.cacheEntries + 20; n++) await loader.load('script', `asset://s${n}.js`);
    expect(loader.results.size).toBe(LOADER_LIMITS.cacheEntries);
    expect(loader.promises.size).toBe(LOADER_LIMITS.cacheEntries);
    expect(loader.has('script', 'asset://s0.js')).toBe(false);
  });

  it('downloads a bounded number of assets at once and refuses more than a bounded number of waiting loads', async () => {
    const pending: Array<() => void> = [];
    let open = 0;
    let most = 0;
    const { loader } = await setup({
      handler: (_request, response) => {
        most = Math.max(most, ++open);
        pending.push(() => {
          open--;
          response.end('// ok');
        });
      },
      limits: { concurrent: 2, queued: 3 },
    });

    const loads = [1, 2, 3, 4, 5, 6, 7].map((n) => loader.load('script', `asset://s${n}.js`).then(() => 'loaded', (e: Error) => e.message));
    await expect.poll(() => pending.length).toBe(2);
    // Two are downloading, three are waiting, the rest were refused at once
    expect(await loads[5]).toBe('[AgentLoader] More than 3 loads are waiting');
    expect(await loads[6]).toBe('[AgentLoader] More than 3 loads are waiting');
    expect(loader.has('script', 'asset://s6.js')).toBe(false);

    while (pending.length || open) {
      pending.shift()?.();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(await Promise.all(loads.slice(0, 5))).toEqual(['loaded', 'loaded', 'loaded', 'loaded', 'loaded']);
    expect(most).toBe(2);
  });

  it.each([
    ['an accessor far larger than the file', { accessors: [{ count: 1e9, type: 'VEC3', componentType: 5126 }] }, 'accessor 0 needs 12000000000 bytes'],
    ['a sparse accessor', { buffers: [{ byteLength: 0, uri: 'data:,' }], bufferViews: [{ buffer: 0, byteLength: 0 }], accessors: [{ count: 10, type: 'SCALAR', componentType: 5126, sparse: { count: 1e8, indices: { bufferView: 0, componentType: 5125 }, values: { bufferView: 0 } } }] }, 'accessor 0 has a sparse part that runs past the end of its buffer view'],
    ['many accessors that add up', { accessors: Array.from({ length: 9 }, () => ({ count: 4e6, type: 'VEC3', componentType: 5126 })) }, 'the model needs more than'],
    ['an accessor whose size cannot be told', { accessors: [{ count: -1, type: 'VEC3', componentType: 5126 }] }, 'no usable count'],
  ])('refuses a model with %s before the render page sees it', async (_name, extra, why) => {
    const glb = minimalGlb({ extra });
    const { loader } = await setup({ handler: (_request, response) => response.end(Buffer.from(glb)) });
    await expect(loader.load('model', 'asset://bomb.glb')).rejects.toThrow(why);
    await expect(loader.load('avatar', 'asset://bomb.vrm')).rejects.toThrow(why);
    expect([page.glb, page.vrm]).toEqual([[], []]);
    expect(loader.results.size).toBe(0);
  });

  it.each(['model', 'avatar', 'emote'])('refuses, as a %s, a GLB with a second JSON chunk (the one the page would parse) before the page sees it', async (type) => {
    const harmless = jsonChunk({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: 'Root' }] });
    const bomb = jsonChunk({ asset: { version: '2.0' }, accessors: [{ count: 1e9, type: 'VEC3', componentType: 5126 }] });
    const { loader } = await setup({ handler: (_request, response) => response.end(Buffer.from(glbOfChunks([harmless, bomb]))) });
    await expect(loader.load(type, 'asset://two-json.glb')).rejects.toThrow('the GLB has a second chunk that is not BIN');
    expect([page.glb, page.vrm]).toEqual([[], []]);
    expect(loader.results.size).toBe(0);
  });

  it.each(['model', 'avatar', 'emote'])('refuses, as a %s, buffer views that copy a small BIN chunk again and again', async (type) => {
    const bin = new Uint8Array(1024 * 1024);
    const views = Array.from({ length: 401 }, () => ({ buffer: 0, byteLength: bin.length }));
    const json = jsonChunk({ asset: { version: '2.0' }, buffers: [{ byteLength: bin.length }], bufferViews: views });
    const { loader } = await setup({ handler: (_request, response) => response.end(Buffer.from(glbOfChunks([json, [0x004e4942, bin]]))) });
    await expect(loader.load(type, 'asset://views.glb')).rejects.toThrow(/the model needs more than \d+ bytes to load/);
    expect([page.glb, page.vrm]).toEqual([[], []]);
  });

  it('refuses malformed glTF before the render page sees it, and gives the page the budget for the kind of asset', async () => {
    const { loader } = await setup({ handler: (request, response) => response.end(request.url?.includes('ok') ? Buffer.from(minimalGlb()) : 'not a model') });
    await expect(loader.load('model', 'asset://junk.glb')).rejects.toThrow('the glTF JSON does not parse');
    expect(page.glb).toEqual([]);
    await loader.load('model', 'asset://ok.glb');
    await loader.load('avatar', 'asset://ok.vrm');
    // A model with no animation is no emote; an emote is read here and never goes to the page
    await expect(loader.load('emote', 'asset://ok-emote.glb')).rejects.toThrow('holds no animation: it is not an emote');
    expect(loader.has('emote', 'asset://ok-emote.glb')).toBe(false);
    // The ceiling for this load, which its reservation is sized from (lib/asset-memory.ts): for a
    // file this small, the 1 MiB floor
    const glb = minimalGlb();
    const ceiling = (type: 'model' | 'avatar') => {
      const reservation = modelReservation(type, glb.byteLength, (gltfCharge(glb, modelBudget(type)) as any).charge.exportBytes, modelBudget(type).exportBytes);
      return 'problem' in reservation ? null : reservation.exportBytes;
    };
    expect(page.budgets).toEqual([ceiling('model'), ceiling('avatar')]);
    expect(page.budgets).toEqual([1024 * 1024, 1024 * 1024]);
    expect(page.glb).toHaveLength(1);
  });

  it("gives the page, for a large model, a ceiling lowered so that the reservation fits the pool, and refuses one whose estimated export cannot fit", () => {
    const MiB = 1024 * 1024;
    // 50 MB: 6 x 50 MB sent, the rest of 768 MiB over 7 per returned byte
    const fitted = modelReservation('model', 50 * 1000 * 1000, MiB, modelBudget('model').exportBytes) as { exportBytes: number; workBytes: number };
    expect(fitted.exportBytes).toBe(Math.floor((768 * MiB - 6 * 50 * 1000 * 1000) / 7));
    expect(fitted.workBytes).toBeLessThanOrEqual(768 * MiB);
    expect(modelReservation('model', 50 * 1000 * 1000, 150 * MiB, modelBudget('model').exportBytes)).toMatchObject({ problem: expect.stringContaining("bytes of the agent's memory for assets on their way") });
    // An avatar keeps its textures: room for 8 x its download, up to its export budget
    expect(modelReservation('avatar', 2 * MiB, MiB, modelBudget('avatar').exportBytes)).toEqual({ exportBytes: 16 * MiB, workBytes: 6 * 2 * MiB + 7 * 16 * MiB });
  });

  it('keeps nothing and builds nothing from a model whose page answer came after the world was destroyed', async () => {
    const glb = minimalGlb();
    const { loader } = await setup({ handler: (_request, response) => response.end(Buffer.from(glb)) });
    let release!: () => void;
    page.gate = new Promise<void>((resolve) => (release = resolve));
    const parse = vi.spyOn(loader.gltfLoader, 'parse');

    const loading = loader.load('model', 'asset://a.glb');
    await expect.poll(() => page.glb.length).toBe(1);
    loader.destroy();
    release();

    await expect(loading).rejects.toMatchObject({ name: 'AbortError' });
    // The page call itself was told: what the page kept was taken back
    expect(page.signals[0]?.aborted).toBe(true);
    expect([page.steps, page.kept.size]).toEqual([['rollback'], 0]);
    expect(parse).not.toHaveBeenCalled();
    expect(loader.results.size).toBe(0);
  });

  it('takes back what the page kept when converting its answer fails here (a node whose extras say castShadow: "yes")', async () => {
    const positions = new Uint8Array(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer);
    const glb = glbOfChunks([
      jsonChunk({
        asset: { version: '2.0' },
        buffers: [{ byteLength: positions.length }],
        bufferViews: [{ buffer: 0, byteLength: positions.length }],
        accessors: [{ bufferView: 0, count: 3, type: 'VEC3', componentType: 5126, min: [0, 0, 0], max: [1, 1, 0] }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
        nodes: [{ name: 'Box', mesh: 0, extras: { castShadow: 'yes' } }],
        scenes: [{ nodes: [0] }],
        scene: 0,
      }),
      [0x004e4942, positions],
    ]);
    const { loader } = await setup({ handler: (request, response) => response.end(Buffer.from(request.url?.includes('box') ? glb : minimalGlb())) });
    await expect(loader.load('model', 'asset://box.glb')).rejects.toThrow('castShadow not a boolean');
    // The page parsed it and kept what it keeps; the agent's conversion failed, so all of it went
    expect(page.glb).toHaveLength(1);
    expect([page.steps, page.kept.size, loader.results.size]).toEqual([['rollback'], 0, 0]);
    // A model that converts is accepted: the page keeps it
    await loader.load('model', 'asset://ok.glb');
    expect([page.steps, page.kept.size]).toEqual([['rollback', 'forget'], 1]);
  });

  it('does not load again, for this world, a model that got the render page killed, and says so once', async () => {
    const glb = minimalGlb();
    const { loader, assets } = await setup({ handler: (_request, response) => response.end(Buffer.from(glb)) });
    // The only page call in flight when the kill came
    page.fail = new RenderPageKilled('memory', '[RenderWatchdog] the render page used 2000000000 bytes, more than 1610612736', 2e9, 1, 1);

    await expect(loader.load('model', 'asset://heavy.glb')).rejects.toBeInstanceOf(RenderPageKilled);
    page.fail = null;
    for (let i = 0; i < 3; i++) await expect(loader.load('model', 'asset://heavy.glb')).rejects.toThrow('Not loading model from');

    expect(page.glb).toHaveLength(1);
    expect(assets.hits).toHaveLength(1);
    expect(vi.mocked(console.error).mock.calls.filter(([line]) => String(line).includes('got the render page killed while it was the only page call'))).toHaveLength(1);
    // Another asset, and the same one in another world, load as usual
    await expect(loader.load('model', 'asset://light.glb')).resolves.toMatchObject({ gltf: expect.anything() });
    const other = await setup({ handler: (_request, response) => response.end(Buffer.from(glb)) });
    await expect(other.loader.load('model', 'asset://heavy.glb')).resolves.toMatchObject({ gltf: expect.anything() });
  });

  it("reserves the agent's own memory for a load from before its download to the end of its parse, and gives it all back", async () => {
    const glb = minimalGlb();
    const { loader } = await setup({ handler: (_request, response) => response.end(Buffer.from(glb)) });
    let release!: () => void;
    page.gate = new Promise<void>((resolve) => (release = resolve));
    const loading = loader.load('model', 'asset://a.glb');
    await expect.poll(() => page.glb.length).toBe(1);
    // While the page works: in the work pool, by what the bytes and the export estimate imply
    expect(assetMemory.held.downloads).toBe(0);
    expect(assetMemory.held.work).toBeGreaterThanOrEqual(4 * glb.byteLength);
    release();
    await loading;
    expect(assetMemory.held).toEqual({ downloads: 0, work: 0 });
    await loader.load('script', 'asset://a.js');
    await expect(loader.load('model', 'https://10.0.0.1/refused.glb')).rejects.toThrow();
    expect(assetMemory.held).toEqual({ downloads: 0, work: 0 });
  });

  it('blames no model for a kill that came while other page calls were in flight, and runs page loads one at a time from then on', async () => {
    const glb = minimalGlb();
    const { loader } = await setup({ handler: (_request, response) => response.end(Buffer.from(glb)) });
    page.fail = new RenderPageKilled('memory', '[RenderWatchdog] over the limit', 2e9, 1, 2);
    await expect(loader.load('model', 'asset://a.glb')).rejects.toBeInstanceOf(RenderPageKilled);
    page.fail = null;
    // Not blamed: it loads again
    await expect(loader.load('model', 'asset://a.glb')).resolves.toMatchObject({ gltf: expect.anything() });
    expect(loader.pageWork.serial).toBe(true);
    // One at a time: the second page call starts only when the first has returned
    let release!: () => void;
    page.gate = new Promise<void>((resolve) => (release = resolve));
    const first = loader.load('model', 'asset://b.glb');
    const second = loader.load('model', 'asset://c.glb');
    await expect.poll(() => page.glb.length).toBe(3);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(page.glb).toHaveLength(3);
    release();
    await Promise.all([first, second]);
    expect(page.glb).toHaveLength(4);
  });

  it('blames no model for a kill while the page was being built', async () => {
    const glb = minimalGlb();
    const { loader } = await setup({ handler: (_request, response) => response.end(Buffer.from(glb)) });
    page.fail = new RenderPageKilled('deadline', '[RenderWatchdog] building the page took too long', null, 1, 1, true);
    await expect(loader.load('model', 'asset://a.glb')).rejects.toBeInstanceOf(RenderPageKilled);
    page.fail = null;
    await expect(loader.load('model', 'asset://a.glb')).resolves.toMatchObject({ gltf: expect.anything() });
  });

  it('evaluates and keeps nothing whose download finished just as the world was destroyed', async () => {
    const evaluate = vi.fn((code: string) => ({ exec() {}, code }));
    const { loader } = await setup({ scripts: { evaluate } });
    page.afterFetch = () => loader.destroy();

    await expect(loader.load('script', 'asset://app.js')).rejects.toThrow('The world was destroyed');
    expect(evaluate).not.toHaveBeenCalled();
    expect(loader.results.size).toBe(0);
  });

  it('evaluates no data: or bundled script once the world is destroyed', async () => {
    const evaluate = vi.fn((code: string) => ({ exec() {}, code }));
    const { loader } = await setup({ scripts: { evaluate } });

    const inline = loader.load('script', 'data:text/plain,hello');
    const bundled = loader.load('script', 'emotes/emote-idle.glb');
    loader.destroy();

    await expect(inline).rejects.toMatchObject({ kind: 'aborted' });
    await expect(bundled).rejects.toMatchObject({ kind: 'aborted' });
    expect(evaluate).not.toHaveBeenCalled();
    expect(loader.results.size).toBe(0);
  });

  it('stops downloading and fails what is waiting when the world is destroyed', async () => {
    const { loader, assets } = await setup({ handler: () => {}, limits: { concurrent: 1 } });

    const downloading = loader.load('script', 'asset://a.js').catch((e: Error & { kind?: string }) => e.kind);
    const waiting = loader.load('script', 'asset://b.js').catch((e: Error) => e.message);
    await expect.poll(() => assets.hits.length).toBe(1);
    loader.destroy();

    expect(await downloading).toBe('aborted');
    expect(await waiting).toBe('[AgentLoader] The world was destroyed');
    await expect.poll(() => assets.cutShort).toBe(1);
    await expect(loader.load('script', 'asset://c.js')).rejects.toThrow('The world was destroyed');
    expect(assets.hits).toHaveLength(1);
  });
});

/*
 * Emotes, end to end, with the files the agent ships: served by the world, downloaded under its
 * policy, admitted by the glTF filter, and read here by the engine's own loader and emote factory.
 */
describe('AgentLoader emotes', () => {
  const emotesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../public/emotes');
  const bundled = readdirSync(emotesDir).filter((name) => name.endsWith('.glb')).sort();
  const serveEmotes: Handler = (request, response) => {
    const name = path.basename(request.url ?? '');
    if (!bundled.includes(name)) return void response.writeHead(404).end();
    response.end(readFileSync(path.join(emotesDir, name)));
  };
  /** What the engine's avatar factory asks an emote for: its clip, for an avatar's own bones */
  const retarget = { rootToHips: 1, version: '1', getBoneName: (vrmBoneName: string) => `bone:${vrmBoneName}` };

  it('ships the emotes this is about', () => {
    expect(bundled.length).toBeGreaterThanOrEqual(21);
  });

  it.each(bundled)('loads %s as a clip an avatar can play, without the render page and without leaving anything reserved', async (name) => {
    const { loader } = await setup({ handler: serveEmotes });
    const emote = await loader.load('emote', `asset://${name}`);
    // The render page was not asked: it hands back a scene without its animations
    expect(page.glb).toEqual([]);
    expect(page.kept.size).toBe(0);

    const clip = emote.toClip(retarget);
    expect(clip).toBeInstanceOf((THREE as any).AnimationClip);
    expect(clip.duration).toBeGreaterThan(0.1);
    expect(clip.tracks.length).toBeGreaterThan(10);
    // Retargeted: every track drives a bone of the avatar by the name the avatar gave for it
    for (const track of clip.tracks) {
      expect(track.name).toMatch(/^bone:[A-Za-z]+\.(quaternion|position)$/);
      expect(track.times.length).toBeGreaterThan(0);
      expect(track.values.every(Number.isFinite)).toBe(true);
    }
    expect(clip.tracks.some((track: { name: string }) => track.name === 'bone:hips.quaternion')).toBe(true);
    // A second load is the same emote, from the cache
    expect(await loader.load('emote', `asset://${name}`)).toBe(emote);
    expect(loader.get('emote', `asset://${name}`)).toBe(emote);
    expect(assetMemory.held).toEqual({ downloads: 0, work: 0 });
  });

  it('reserves memory for an emote while it is read, and refuses one the filter does not admit, before parsing anything', async () => {
    const { loader } = await setup({ handler: serveEmotes });
    const parse = vi.spyOn(loader.gltfLoader, 'parse');
    let heldWhileParsing = { downloads: 0, work: 0 };
    parse.mockImplementationOnce(function (this: unknown, ...args: any[]) {
      heldWhileParsing = { ...assetMemory.held };
      return (parse.getMockImplementation() ?? (GLTFLoader.prototype.parse as any)).apply(this, args);
    });
    parse.mockImplementation(function (this: unknown, ...args: any[]) {
      return (GLTFLoader.prototype.parse as any).apply(this, args);
    });
    await loader.load('emote', 'asset://emote-idle.glb');
    const size = readFileSync(path.join(emotesDir, 'emote-idle.glb')).byteLength;
    expect(heldWhileParsing.work).toBeGreaterThanOrEqual(size);
    expect(assetMemory.held).toEqual({ downloads: 0, work: 0 });

    // The same file with a second JSON chunk: refused by the filter, never handed to the parser
    const calls = parse.mock.calls.length;
    const { loader: other } = await setup({ handler: (_request, response) => response.end(Buffer.from(glbOfChunks([jsonChunk({ asset: { version: '2.0' } }), jsonChunk({ asset: { version: '2.0' } })]))) });
    const otherParse = vi.spyOn(other.gltfLoader, 'parse');
    await expect(other.load('emote', 'asset://two-json.glb')).rejects.toThrow();
    expect(otherParse).not.toHaveBeenCalled();
    expect(parse.mock.calls.length).toBe(calls);
  });
});

/*
 * Embedded images. The agent decodes none; the engine's loader would make a blob: URL for each
 * and, as the load fails outside a browser, never revoke it.
 */
describe('AgentLoader and images embedded in a model', () => {
  // A 1x1 PNG in the BIN chunk, used as the base colour texture of the one material
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const texturedGlb = () =>
    glbOfChunks([
      jsonChunk({
        asset: { version: '2.0' },
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes: [{ name: 'Textured', mesh: 0 }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
        materials: [{ name: 'Painted', pbrMetallicRoughness: { baseColorTexture: { index: 0 } }, emissiveTexture: { index: 1 } }],
        textures: [{ source: 0 }, { source: 0 }],
        images: [{ bufferView: 1, mimeType: 'image/png' }],
        accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
        bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: png.byteLength }],
        buffers: [{ byteLength: 36 + png.byteLength }],
      }),
      [0x004e4942, new Uint8Array(Buffer.concat([Buffer.from(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer), png]))],
    ]);

  it('makes no blob: URL for an image in a model it parses: the model loads with that map absent', async () => {
    const created = vi.spyOn(URL, 'createObjectURL');
    const revoked = vi.spyOn(URL, 'revokeObjectURL');
    // As in the agent's process once a world exists (session/create-agent-world.ts): the engine's loader reads self.URL
    vi.stubGlobal('self', globalThis);
    try {
      const glb = texturedGlb();
      const { loader } = await setup({ handler: (_request, response) => response.end(Buffer.from(glb)) });
      const model = await loader.load('model', 'asset://textured.glb');
      const mesh = model.gltf.scene.children[0];
      expect(mesh.name).toBe('Textured');
      expect(mesh.material.name).toBe('Painted');
      expect(mesh.material.map).toBeNull();
      expect(mesh.material.emissiveMap).toBeNull();
      expect(created).not.toHaveBeenCalled();
      expect(revoked).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
