import { afterEach, describe, expect, it, vi } from 'vitest';
import { hashFileBuffer } from '../utils';
import { AssetUploadError, apiUrlProblem, assetServed, ensureAsset, isPermanentRefusal, uploadAsset, worldEndpointProblems } from './asset-upload';
import { NetPolicy, installWorldNet } from './net-policy';
import { PUBLIC_ADDRESS, type TestServer, closeServers, startServer, testNet } from '../test-support/net';

const TOKEN = 'test-session-token';
const net = new NetPolicy({ worldOrigin: 'https://world.test' });
const network = { apiUrl: 'https://world.test/api', maxUploadSize: '12' };
const file = () => new File([Buffer.from('glTF-avatar')], 'avatar.vrm', { type: 'model/gltf-binary' });

type Route = (url: string, init: RequestInit) => Response | Promise<Response>;

function fakeFetch(route: Route) {
  return vi.fn(async (url: any, init: any = {}) => route(String(url), init)) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const authOf = (init: RequestInit) => (init.headers as Record<string, string> | undefined)?.Authorization;

describe('uploadAsset', () => {
  it('sends the session token on the check and the upload', async () => {
    const fetchImpl = fakeFetch((url) => (url.includes('upload-check') ? json({ exists: false }) : new Response(null, { status: 200 })));
    await uploadAsset(network, file(), { net, authToken: TOKEN, fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [[checkUrl, checkInit], [uploadUrl, uploadInit]] = fetchImpl.mock.calls as [string, RequestInit][];
    expect(checkUrl).toMatch(/^https:\/\/world\.test\/api\/upload-check\?filename=[0-9a-f]{64}\.vrm$/);
    expect(uploadUrl).toBe('https://world.test/api/upload');
    expect(uploadInit.method).toBe('POST');
    expect(uploadInit.body).toBeInstanceOf(FormData);
    expect(authOf(checkInit)).toBe(`Bearer ${TOKEN}`);
    expect(authOf(uploadInit)).toBe(`Bearer ${TOKEN}`);
  });

  it('does not upload a file the world already has', async () => {
    const fetchImpl = fakeFetch(() => json({ exists: true }));
    await uploadAsset(network, file(), { net, authToken: TOKEN, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reports the world's refusal with its status and reason", async () => {
    const fetchImpl = fakeFetch((url) =>
      url.includes('upload-check') ? json({ exists: false }) : json({ error: 'builder rank required' }, 403)
    );
    const error = await uploadAsset(network, file(), { net, authToken: TOKEN, fetchImpl }).catch((e) => e);
    expect(error).toBeInstanceOf(AssetUploadError);
    expect(error.status).toBe(403);
    expect(error.message).toContain('builder rank required');
    expect(error.message).not.toContain(TOKEN);
    expect(isPermanentRefusal(error)).toBe(true);
  });

  it('fails on a refused check without uploading', async () => {
    const fetchImpl = fakeFetch(() => json({ error: 'upload requires a connected session' }, 401));
    const error = await uploadAsset(network, file(), { net, authToken: TOKEN, fetchImpl }).catch((e) => e);
    expect(error.status).toBe(401);
    expect(isPermanentRefusal(error)).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('treats server errors, rate limits and network failures as worth retrying', async () => {
    const html = fakeFetch(() => new Response('<html>Bad Gateway</html>', { status: 502, statusText: 'Bad Gateway' }));
    const badGateway = await uploadAsset(network, file(), { net, fetchImpl: html }).catch((e) => e);
    expect(badGateway.status).toBe(502);
    expect(badGateway.message).toContain('Bad Gateway');
    expect(isPermanentRefusal(badGateway)).toBe(false);

    const limited = await uploadAsset(network, file(), { net, fetchImpl: fakeFetch(() => json({ error: 'slow down' }, 429)) }).catch((e) => e);
    expect(isPermanentRefusal(limited)).toBe(false);

    const down = fakeFetch(() => {
      throw new TypeError('fetch failed');
    });
    const offline = await uploadAsset(network, file(), { net, fetchImpl: down }).catch((e) => e);
    expect(offline).toBeInstanceOf(AssetUploadError);
    expect(offline.status).toBeUndefined();
    expect(isPermanentRefusal(offline)).toBe(false);
  });

  it('gives up after its deadline', async () => {
    const hang = fakeFetch(
      (_url, init) =>
        new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(init.signal!.reason)))
    );
    const error = await uploadAsset(network, file(), { net, fetchImpl: hang, timeoutMs: 20 }).catch((e) => e);
    expect(error.message).toContain('timed out');
    expect(isPermanentRefusal(error)).toBe(false);
  });

  it('refuses a file over the size cap without contacting the world', async () => {
    const fetchImpl = fakeFetch(() => json({ exists: false }));
    const big = new File([Buffer.alloc(2 * 1024 * 1024)], 'big.vrm');
    const error = await uploadAsset({ ...network, maxUploadSize: '1' }, big, { net, fetchImpl }).catch((e) => e);
    expect(error.status).toBe(413);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('ignores a missing or unusable size cap', async () => {
    const fetchImpl = fakeFetch(() => json({ exists: true }));
    await uploadAsset({ ...network, maxUploadSize: undefined }, file(), { net, fetchImpl });
    await uploadAsset({ ...network, maxUploadSize: 'none' }, file(), { net, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('sends no Authorization header without a token', async () => {
    const fetchImpl = fakeFetch(() => json({ exists: true }));
    await uploadAsset(network, file(), { net, authToken: null, fetchImpl });
    expect(authOf((fetchImpl.mock.calls[0] as [string, RequestInit])[1])).toBeUndefined();
  });

  it('fails clearly before the world has sent its API URL', async () => {
    const error = await uploadAsset({ apiUrl: null }, file(), { net, fetchImpl: fakeFetch(() => json({})) }).catch((e) => e);
    expect(error).toBeInstanceOf(AssetUploadError);
    expect(isPermanentRefusal(error)).toBe(false);
  });
});

// That these requests ignore HTTP(S)_PROXY, which the runtime's own fetch would use, is checked
// where it can fail: in a Bun process, lib/net-policy.child.test.ts
describe('where the session token goes (real requests, against servers on loopback)', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeServers();
  });

  const worldApi = () =>
    startServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(request.url?.includes('upload-check') ? { exists: false } : {}));
    });
  const tokensSeen = (server: TestServer) => server.hits.map((hit) => hit.headers.authorization);

  it("sends the token to the world's own origin, on the check and the upload", async () => {
    const world = await worldApi();
    await uploadAsset({ apiUrl: `http://127.0.0.1:${world.port}/api` }, file(), { net: new NetPolicy({ worldOrigin: `http://127.0.0.1:${world.port}` }), authToken: TOKEN });

    expect(world.hits.map((hit) => `${hit.method} ${hit.url.split('?')[0]}`)).toEqual(['GET /api/upload-check', 'POST /api/upload']);
    expect(tokensSeen(world)).toEqual([`Bearer ${TOKEN}`, `Bearer ${TOKEN}`]);
    // The file arrives as the multipart form the world's upload route reads
    const [, upload] = world.hits;
    expect(upload.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/);
    expect(upload.body).toContain('name="file"; filename="avatar.vrm"');
    expect(upload.body).toContain('glTF-avatar');
  });

  it.each([
    ['another host', (port: number) => `http://localhost:${port}/api`],
    ['another port', (port: number) => `http://127.0.0.1:${port}/api`],
    ['a URL that only starts like the world', (port: number) => `http://127.0.0.1:1@127.0.0.1:${port}/api`],
  ])('refuses an API URL on %s and sends it nothing, token or otherwise', async (_name, apiUrl) => {
    const world = await worldApi();
    const foreign = await worldApi();
    // The world is the first server; its snapshot names the second as its API
    const error = await uploadAsset({ apiUrl: apiUrl(foreign.port) }, file(), { net: new NetPolicy({ worldOrigin: `http://127.0.0.1:${world.port}` }), authToken: TOKEN }).catch((e) => e);

    expect(error).toBeInstanceOf(AssetUploadError);
    expect(error.message).toContain("not on the world's own origin");
    expect(error.message).not.toContain(TOKEN);
    expect(isPermanentRefusal(error)).toBe(true);
    expect(foreign.connections + world.connections).toBe(0);
  });

  it('refuses every API URL when the world origin is unknown, and one that is not a URL', async () => {
    const foreign = await worldApi();
    for (const [apiUrl, origin] of [[`http://127.0.0.1:${foreign.port}/api`, null], ['/api', 'https://world.test'], ['data:text/plain,x', 'null']] as const) {
      const error = await uploadAsset({ apiUrl }, file(), { net: new NetPolicy({ worldOrigin: origin }), authToken: TOKEN }).catch((e) => e);
      expect(isPermanentRefusal(error)).toBe(true);
    }
    expect(foreign.connections).toBe(0);
    expect(apiUrlProblem('https://world.test/api', 'https://world.test')).toBeNull();
    expect(apiUrlProblem('https://world.test:8443/api', 'https://world.test')).toContain('https://world.test:8443');
    expect(apiUrlProblem('http://world.test/api', 'https://world.test')).toContain('http://world.test');
  });

  it.each([301, 302, 303, 307, 308])('does not follow a %i from the world API: the token and the file go nowhere else', async (status) => {
    const elsewhere = await worldApi();
    const world = await startServer((request, response) => {
      // The check passes; the upload itself is redirected
      if (request.url?.includes('upload-check')) return void response.setHeader('content-type', 'application/json').end('{"exists":false}');
      response.writeHead(status, { location: `http://127.0.0.1:${elsewhere.port}/api/upload` }).end();
    });
    const origin = `http://127.0.0.1:${world.port}`;

    const error = await uploadAsset({ apiUrl: `${origin}/api` }, file(), { net: new NetPolicy({ worldOrigin: origin }), authToken: TOKEN }).catch((e) => e);

    expect(error).toBeInstanceOf(AssetUploadError);
    expect(error.message).toContain('answered with a redirect');
    expect(isPermanentRefusal(error)).toBe(true);
    expect(world.hits).toHaveLength(2);
    expect(elsewhere.connections).toBe(0);
  });

  it('does not follow a redirect of the upload-check either', async () => {
    const elsewhere = await worldApi();
    const world = await startServer((_request, response) => response.writeHead(302, { location: `http://127.0.0.1:${elsewhere.port}/api/upload-check` }).end());
    const origin = `http://127.0.0.1:${world.port}`;

    const error = await uploadAsset({ apiUrl: `${origin}/api` }, file(), { net: new NetPolicy({ worldOrigin: origin }), authToken: TOKEN }).catch((e) => e);

    expect(isPermanentRefusal(error)).toBe(true);
    expect(world.hits).toHaveLength(1);
    expect(elsewhere.connections).toBe(0);
  });

  it('tells the operator, once the snapshot is in, when the world names an API or assets URL the agent will not use', () => {
    const net = new NetPolicy({ worldOrigin: 'http://127.0.0.1:3000' });
    expect(worldEndpointProblems(net, { apiUrl: 'http://127.0.0.1:3000/api', assetsUrl: 'http://127.0.0.1:3000/assets' })).toEqual([]);
    // A public https assets host (a bucket or CDN) is fine; the API is not
    expect(worldEndpointProblems(net, { apiUrl: 'https://api.example.com/api', assetsUrl: 'https://cdn.example.com/assets' })).toEqual([
      expect.stringContaining("the world's API URL is on https://api.example.com, not on the world's own origin (http://127.0.0.1:3000, from WS_URL)"),
    ]);
    // The same machine under another name is another origin
    const [api, assets] = worldEndpointProblems(net, { apiUrl: 'http://localhost:3000/api', assetsUrl: 'http://localhost:3000/assets/' });
    expect(api).toContain('Uploads to this world are refused');
    expect(assets).toContain("its assets URL http://localhost:3000 is neither the world's own origin (http://127.0.0.1:3000, from WS_URL) nor a public https address");
    expect(worldEndpointProblems(net, {})).toEqual([]);
  });
});

describe('assetServed', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeServers();
  });

  it('is true when served, false when missing, null when it cannot tell', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const world = await startServer((request, response) => response.writeHead(Number(request.url?.slice(1))).end());
    const origin = `http://127.0.0.1:${world.port}`;
    const net = new NetPolicy({ worldOrigin: origin });

    expect(await assetServed(`${origin}/200`, net)).toBe(true);
    expect(await assetServed(`${origin}/404`, net)).toBe(false);
    expect(await assetServed(`${origin}/503`, net)).toBeNull();
    expect(world.hits.map((hit) => hit.method)).toEqual(['HEAD', 'HEAD', 'HEAD']);
    // No token: this is not the upload API
    expect(world.hits.every((hit) => hit.headers.authorization === undefined)).toBe(true);
    await world.close();
    expect(await assetServed(`${origin}/200`, net)).toBeNull();
  });

  it('refuses to ask an address the policy does not allow, and says that asking again will not help', async () => {
    const internal = await startServer((_request, response) => response.end());
    const net = new NetPolicy({ worldOrigin: 'https://world.test' });

    const error = await assetServed(`http://127.0.0.1:${internal.port}/a.vrm`, net).catch((e) => e);

    expect(error).toBeInstanceOf(AssetUploadError);
    expect(isPermanentRefusal(error)).toBe(true);
    expect(internal.connections).toBe(0);
  });
});

describe('ensureAsset', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeServers();
  });

  const asset = { buffer: Buffer.from('glTF-avatar'), name: 'avatar.vrm', type: 'model/gltf-binary' };

  /** A world whose assets server (on loopback, the world's own origin) answers HEAD from a set of file names, or with `status`. */
  async function world(upload: (file: File) => Promise<unknown>, served = new Set<string>(), status?: () => number | undefined) {
    const server = await startServer((request, response) => {
      const name = String(request.url).split('/').pop()!;
      response.writeHead(status?.() ?? (served.has(name) ? 200 : 404)).end();
    });
    const origin = `http://127.0.0.1:${server.port}`;
    const it = { assetsUrl: `${origin}/assets/`, network: { upload } };
    installWorldNet(it, new NetPolicy({ worldOrigin: origin }));
    return { world: it, served, server, origin };
  }

  it('uses a file the world already serves without uploading', async () => {
    const upload = vi.fn();
    const { world: w, served, origin } = await world(upload);
    served.add(`${await hashFileBuffer(asset.buffer)}.vrm`);

    const result = await ensureAsset(w, asset);
    expect(result).toMatchObject({ ok: true, uploaded: false });
    expect(result.ok && result.url.replace(origin, '')).toMatch(/^\/assets\/[0-9a-f]{64}\.vrm$/);
    expect(upload).not.toHaveBeenCalled();
  });

  it('uploads a missing file and confirms it is served', async () => {
    const served = new Set<string>();
    const upload = vi.fn(async (file: File) => {
      served.add(`${await hashFileBuffer(Buffer.from(await file.arrayBuffer()))}.vrm`);
    });
    const { world: w } = await world(upload, served);
    const result = await ensureAsset(w, asset);
    expect(result).toMatchObject({ ok: true, uploaded: true });
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it('is not ok when an upload "succeeds" but the file never appears', async () => {
    const { world: w } = await world(vi.fn().mockResolvedValue(undefined));
    const result = await ensureAsset(w, asset);
    expect(result).toMatchObject({ ok: false, retryable: true });
  });

  it("passes the world's refusal through", async () => {
    const refusal = new AssetUploadError('Upload failed (HTTP 403): builder rank required', 403);
    const { world: w } = await world(vi.fn().mockRejectedValue(refusal));
    const result = await ensureAsset(w, asset);
    expect(result).toEqual({ ok: false, fileName: expect.stringMatching(/\.vrm$/), error: refusal, retryable: false });
  });

  it('retries after a failure that may pass', async () => {
    const outage = new AssetUploadError('Upload failed (HTTP 503): Service Unavailable', 503);
    const { world: w } = await world(vi.fn().mockRejectedValue(outage));
    const result = await ensureAsset(w, asset);
    expect(result).toMatchObject({ ok: false, retryable: true });
  });

  it('without uploading, retries only when the lookup itself failed', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let status: number | undefined;
    const { world: w } = await world(vi.fn(), new Set(), () => status);
    expect(await ensureAsset(w, asset, { upload: false })).toMatchObject({ ok: false, retryable: false });
    status = 503;
    expect(await ensureAsset(w, asset, { upload: false })).toMatchObject({ ok: false, retryable: true });
  });

  it('does not hand out an upload it could not confirm', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let uploaded = false;
    const { world: w } = await world(async () => { uploaded = true; }, new Set(), () => (uploaded ? 503 : 404));
    const result = await ensureAsset(w, asset);
    expect(result).toMatchObject({ ok: false, retryable: true });
  });

  it('checks assets on another, public https origin without the exception (a bucket or CDN), and gives up on an assets URL the policy refuses', async () => {
    const cdn = await startServer((_request, response) => response.writeHead(200).end(), { tls: true });
    const upload = vi.fn();
    const onCdn = { assetsUrl: 'https://cdn.test/assets', network: { upload } };
    installWorldNet(onCdn, testNet({ hosts: { 'cdn.test': PUBLIC_ADDRESS }, routes: { 'cdn.test:443': { port: cdn.port, direct: true } }, worldOrigin: 'https://world.test' }).policy);
    expect(await ensureAsset(onCdn, asset)).toMatchObject({ ok: true, uploaded: false });
    expect(cdn.hits[0].headers.authorization).toBeUndefined();

    // The same world naming an internal address as its assets host: no request, no upload, no retry
    const internal = await startServer((_request, response) => response.writeHead(200).end());
    const inward = { assetsUrl: `http://127.0.0.1:${internal.port}/assets`, network: { upload } };
    installWorldNet(inward, new NetPolicy({ worldOrigin: 'https://world.test' }));
    const result = await ensureAsset(inward, asset);
    expect(result).toMatchObject({ ok: false, retryable: false });
    expect(result.ok === false && result.error.message).toContain("not allowed by the agent's network policy");
    expect(internal.connections).toBe(0);
    expect(upload).not.toHaveBeenCalled();
  });
});
