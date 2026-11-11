import { afterEach, describe, expect, it, vi } from 'vitest';

// The loader hands model bytes to the render page and gets them back without textures; here they
// come back as they are, and what the page was given is recorded.
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
}));
vi.mock('../managers/puppeteer-manager.js', () => ({
  PuppeteerManager: {
    getInstance: () => ({
      loadGlbBytes: async (bytes: Uint8Array, { maxExportBytes, signal }: { maxExportBytes: number; signal?: AbortSignal }) => {
        page.glb.push(bytes.byteLength);
        page.budgets.push(maxExportBytes);
        page.signals.push(signal);
        await page.gate;
        if (page.fail) throw page.fail;
        return page.returns ?? bytes;
      },
      loadVRMBytes: async (bytes: Uint8Array, url: string, { maxExportBytes, signal }: { maxExportBytes: number; signal?: AbortSignal }) => {
        page.vrm.push([bytes.byteLength, url]);
        page.budgets.push(maxExportBytes);
        page.signals.push(signal);
        return page.returns ?? bytes;
      },
    }),
  },
}));

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
import { RenderPageKilled } from '../lib/render-watchdog';
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
    ['a sparse accessor', { buffers: [{ byteLength: 0, uri: 'data:,' }], bufferViews: [{ buffer: 0, byteLength: 0 }], accessors: [{ count: 10, type: 'SCALAR', componentType: 5126, sparse: { count: 1e8, indices: { bufferView: 0, componentType: 5125 }, values: { bufferView: 0 } } }] }, 'accessor 0 needs'],
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
    // An emote's is smaller (lib/gltf-budget.test.ts); a model with no animation is no emote
    await expect(loader.load('emote', 'asset://ok-emote.glb')).rejects.toThrow();
    expect(page.budgets).toEqual([200 * 1024 * 1024, 200 * 1024 * 1024, 64 * 1024 * 1024]);
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

    await expect(loading).rejects.toThrow('The world was destroyed');
    // The page call itself was told (PuppeteerManager takes back what it kept)
    expect(page.signals[0]?.aborted).toBe(true);
    expect(parse).not.toHaveBeenCalled();
    expect(loader.results.size).toBe(0);
  });

  it('does not load again, for this world, a model that got the render page killed, and says so once', async () => {
    const glb = minimalGlb();
    const { loader, assets } = await setup({ handler: (_request, response) => response.end(Buffer.from(glb)) });
    page.fail = new RenderPageKilled('memory', '[RenderWatchdog] the render page used 2000000000 bytes, more than 1610612736', 2e9);

    await expect(loader.load('model', 'asset://heavy.glb')).rejects.toBeInstanceOf(RenderPageKilled);
    page.fail = null;
    for (let i = 0; i < 3; i++) await expect(loader.load('model', 'asset://heavy.glb')).rejects.toThrow('Not loading model from');

    expect(page.glb).toHaveLength(1);
    expect(assets.hits).toHaveLength(1);
    expect(vi.mocked(console.error).mock.calls.filter(([line]) => String(line).includes('got the render page killed'))).toHaveLength(1);
    // Another asset, and the same one in another world, load as usual
    await expect(loader.load('model', 'asset://light.glb')).resolves.toMatchObject({ gltf: expect.anything() });
    const other = await setup({ handler: (_request, response) => response.end(Buffer.from(glb)) });
    await expect(other.loader.load('model', 'asset://heavy.glb')).resolves.toMatchObject({ gltf: expect.anything() });
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
