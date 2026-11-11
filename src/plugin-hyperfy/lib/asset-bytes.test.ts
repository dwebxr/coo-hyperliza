import { afterEach, describe, expect, it, vi } from 'vitest';
import { ASSET_BYTE_CAPS, decodeDataUrl, describeUrl, fetchAssetBytes } from './asset-bytes';
import { MAX_EMOTE_BYTES, MAX_IMAGE_BYTES, MAX_MODEL_BYTES, MAX_SCRIPT_BYTES, NetPolicy, installWorldNet } from './net-policy';
import { PUBLIC_ADDRESS, closeServers, startServer, testNet } from '../test-support/net';
import { AssetMemory } from './asset-memory';

afterEach(async () => {
  vi.restoreAllMocks();
  await closeServers();
});

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

async function localWorld() {
  const server = await startServer((request, response) => {
    if (request.url?.endsWith('missing.glb')) return void response.writeHead(404).end();
    response.writeHead(200, { 'content-type': 'Image/PNG; charset=binary' }).end(`bytes of ${request.url}`);
  });
  const internal = await startServer((_request, response) => response.end('internal'));
  const origin = `http://127.0.0.1:${server.port}`;
  const world = { assetsUrl: `${origin}/assets/` };
  installWorldNet(world, new NetPolicy({ worldOrigin: origin }));
  return { world, server, internal, origin };
}

describe('fetchAssetBytes', () => {
  it("loads asset:// and absolute URLs on the world's own origin, although it is plain http on loopback", async () => {
    const { world, server, origin } = await localWorld();

    const asset = await fetchAssetBytes(world, 'asset://sky.png', 'image');
    expect([text(asset.bytes), asset.contentType, asset.url]).toEqual(['bytes of /assets/sky.png', 'image/png', `${origin}/assets/sky.png`]);
    expect(text((await fetchAssetBytes(world, `${origin}/other/a.glb`, 'model')).bytes)).toBe('bytes of /other/a.glb');
    expect(server.hits).toHaveLength(2);
  });

  it('loads from a public https host that is not the world (a bucket or CDN)', async () => {
    const cdn = await startServer((_request, response) => response.end('from the cdn'), { tls: true });
    const world = { assetsUrl: 'https://cdn.test/world-assets' };
    installWorldNet(world, testNet({ hosts: { 'cdn.test': PUBLIC_ADDRESS }, routes: { 'cdn.test:443': { port: cdn.port, direct: true } }, worldOrigin: 'https://world.test' }).policy);

    expect(text((await fetchAssetBytes(world, 'asset://a.glb', 'model')).bytes)).toBe('from the cdn');
    expect(cdn.hits[0].url).toBe('/world-assets/a.glb');
  });

  it('loads nothing from anywhere else inside the network, and asks no server', async () => {
    const { world, server, internal } = await localWorld();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    for (const url of [`http://127.0.0.1:${internal.port}/a.glb`, `http://localhost:${internal.port}/a.glb`, 'https://192.168.0.1/a.glb', 'https://[::1]/a.glb', 'blob:nodedata:1', '/etc/hosts', '../../../.env', 42, null]) {
      await expect(fetchAssetBytes(world, url, 'model')).rejects.toThrow();
    }
    expect(server.connections + internal.connections).toBe(0);
  });

  it('a world with no policy of its own gets no exception at all', async () => {
    const server = await startServer((_request, response) => response.end('x'));
    await expect(fetchAssetBytes({ assetsUrl: `http://127.0.0.1:${server.port}` }, 'asset://a.glb', 'model')).rejects.toMatchObject({ kind: 'refused' });
    expect(server.connections).toBe(0);
  });

  it('reads a bundled file and an inline data: URL without any request', async () => {
    const { world, server } = await localWorld();

    const bundled = await fetchAssetBytes(world, 'constants.ts', 'script');
    expect(text(bundled.bytes)).toContain('export');
    const inline = await fetchAssetBytes(world, 'data:model/gltf-binary;base64,Z2xURg==', 'model');
    expect([text(inline.bytes), inline.contentType]).toEqual(['glTF', 'model/gltf-binary']);
    expect(server.connections).toBe(0);
  });

  it('fails on an HTTP error status and when the world has not said where its assets are', async () => {
    const { world } = await localWorld();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(fetchAssetBytes(world, 'asset://missing.glb', 'model')).rejects.toThrow('HTTP 404');
    await expect(fetchAssetBytes({ assetsUrl: null }, 'asset://a.glb', 'model')).rejects.toThrow('could not resolve asset://a.glb');
  });

  it('applies the cap of the kind of asset', async () => {
    expect(ASSET_BYTE_CAPS).toEqual({ model: MAX_MODEL_BYTES, avatar: MAX_MODEL_BYTES, emote: MAX_EMOTE_BYTES, script: MAX_SCRIPT_BYTES, image: MAX_IMAGE_BYTES, hdr: MAX_IMAGE_BYTES });
    const size = MAX_SCRIPT_BYTES + 1;
    const server = await startServer((_request, response) => response.writeHead(200, { 'content-length': String(size) }).end());
    const origin = `http://127.0.0.1:${server.port}`;
    const world = { assetsUrl: origin };
    installWorldNet(world, new NetPolicy({ worldOrigin: origin }));

    // The same answer is too much for a script and fine, as far as its size goes, for a model
    await expect(fetchAssetBytes(world, 'asset://a.js', 'script')).rejects.toMatchObject({ kind: 'too-large' });
    await expect(fetchAssetBytes(world, 'asset://a.glb', 'model')).rejects.toMatchObject({ kind: 'network' });
  });
});

describe("fetchAssetBytes and the download's memory reservation (lib/asset-memory.ts)", () => {
  it('shrinks it to twice the declared size once the answer comes, and to twice the actual size once the bytes are in', async () => {
    let finish!: () => void;
    const server = await startServer((request, response) => {
      if (request.url?.includes('declared')) {
        response.writeHead(200, { 'content-length': '100' });
        response.write(Buffer.alloc(40));
        finish = () => response.end(Buffer.alloc(60));
      } else {
        // Chunked: no declared size
        response.write(Buffer.alloc(30));
        response.end(Buffer.alloc(20));
      }
    });
    const origin = `http://127.0.0.1:${server.port}`;
    const world = { assetsUrl: `${origin}/assets/` };
    installWorldNet(world, new NetPolicy({ worldOrigin: origin }));
    const memory = new AssetMemory();

    const declared = await memory.download(ASSET_BYTE_CAPS.image);
    expect(declared.bytes).toBe(2 * MAX_IMAGE_BYTES);
    const loading = fetchAssetBytes(world, 'asset://declared.png', 'image', { lease: declared });
    await expect.poll(() => declared.bytes).toBe(200);
    finish();
    expect((await loading).bytes.byteLength).toBe(100);
    expect(declared.bytes).toBe(200);

    const chunked = await memory.download(ASSET_BYTE_CAPS.image);
    await fetchAssetBytes(world, 'asset://chunked.png', 'image', { lease: chunked });
    expect(chunked.bytes).toBe(100);

    const inline = await memory.download(ASSET_BYTE_CAPS.image);
    await fetchAssetBytes(world, 'data:image/png;base64,AAECAw==', 'image', { lease: inline });
    expect(inline.bytes).toBe(8);
    for (const lease of [declared, chunked, inline]) lease.release();
    expect(memory.held).toEqual({ downloads: 0, work: 0 });
  });
});

describe('decodeDataUrl', () => {
  it('decodes base64 and percent-encoded data', () => {
    expect(text(decodeDataUrl('data:text/plain;base64,aGVsbG8=', 100).bytes)).toBe('hello');
    expect(decodeDataUrl('data:text/plain;charset=utf-8,hi%20there', 100)).toEqual({ bytes: new TextEncoder().encode('hi there'), contentType: 'text/plain' });
    expect(decodeDataUrl('data:,x', 100).contentType).toBe('');
  });

  it('refuses more than the cap, and what is not a data: URL', () => {
    const big = `data:application/octet-stream;base64,${Buffer.alloc(300).toString('base64')}`;
    expect(() => decodeDataUrl(big, 299)).toThrow('holds more than 299 bytes');
    expect(decodeDataUrl(big, 300).bytes.byteLength).toBe(300);
    expect(() => decodeDataUrl(`data:text/plain,${'a'.repeat(301)}`, 300)).toThrow('holds more than 300 bytes');
    expect(() => decodeDataUrl('https://x.test/', 100)).toThrow('not a valid data: URL');
    expect(() => decodeDataUrl('data:text/plain;base64', 100)).toThrow('not a valid data: URL');
  });
});

describe('describeUrl (lib/log-url.ts)', () => {
  it('is the shared formatter: a data: URL keeps its type and length only', () => {
    expect(describeUrl('asset://a.glb')).toBe('asset://a.glb');
    expect(describeUrl(`data:model/gltf-binary;base64,${'A'.repeat(5000)}`)).toBe('data:model/gltf-binary… (5030 characters)');
  });
});
