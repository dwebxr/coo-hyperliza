import { afterEach, describe, expect, it, vi } from 'vitest';
import { hashFileBuffer } from '../utils';
import { AssetUploadError, assetServed, ensureAsset, isPermanentRefusal, uploadAsset } from './asset-upload';

const TOKEN = 'test-session-token';
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
    await uploadAsset(network, file(), { authToken: TOKEN, fetchImpl });

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
    await uploadAsset(network, file(), { authToken: TOKEN, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reports the world's refusal with its status and reason", async () => {
    const fetchImpl = fakeFetch((url) =>
      url.includes('upload-check') ? json({ exists: false }) : json({ error: 'builder rank required' }, 403)
    );
    const error = await uploadAsset(network, file(), { authToken: TOKEN, fetchImpl }).catch((e) => e);
    expect(error).toBeInstanceOf(AssetUploadError);
    expect(error.status).toBe(403);
    expect(error.message).toContain('builder rank required');
    expect(error.message).not.toContain(TOKEN);
    expect(isPermanentRefusal(error)).toBe(true);
  });

  it('fails on a refused check without uploading', async () => {
    const fetchImpl = fakeFetch(() => json({ error: 'upload requires a connected session' }, 401));
    const error = await uploadAsset(network, file(), { authToken: TOKEN, fetchImpl }).catch((e) => e);
    expect(error.status).toBe(401);
    expect(isPermanentRefusal(error)).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('treats server errors, rate limits and network failures as worth retrying', async () => {
    const html = fakeFetch(() => new Response('<html>Bad Gateway</html>', { status: 502, statusText: 'Bad Gateway' }));
    const badGateway = await uploadAsset(network, file(), { fetchImpl: html }).catch((e) => e);
    expect(badGateway.status).toBe(502);
    expect(badGateway.message).toContain('Bad Gateway');
    expect(isPermanentRefusal(badGateway)).toBe(false);

    const limited = await uploadAsset(network, file(), { fetchImpl: fakeFetch(() => json({ error: 'slow down' }, 429)) }).catch((e) => e);
    expect(isPermanentRefusal(limited)).toBe(false);

    const down = fakeFetch(() => {
      throw new TypeError('fetch failed');
    });
    const offline = await uploadAsset(network, file(), { fetchImpl: down }).catch((e) => e);
    expect(offline).toBeInstanceOf(AssetUploadError);
    expect(offline.status).toBeUndefined();
    expect(isPermanentRefusal(offline)).toBe(false);
  });

  it('gives up after its deadline', async () => {
    const hang = fakeFetch(
      (_url, init) =>
        new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(init.signal!.reason)))
    );
    const error = await uploadAsset(network, file(), { fetchImpl: hang, timeoutMs: 20 }).catch((e) => e);
    expect(error.message).toContain('timed out');
    expect(isPermanentRefusal(error)).toBe(false);
  });

  it('refuses a file over the size cap without contacting the world', async () => {
    const fetchImpl = fakeFetch(() => json({ exists: false }));
    const big = new File([Buffer.alloc(2 * 1024 * 1024)], 'big.vrm');
    const error = await uploadAsset({ ...network, maxUploadSize: '1' }, big, { fetchImpl }).catch((e) => e);
    expect(error.status).toBe(413);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('ignores a missing or unusable size cap', async () => {
    const fetchImpl = fakeFetch(() => json({ exists: true }));
    await uploadAsset({ ...network, maxUploadSize: undefined }, file(), { fetchImpl });
    await uploadAsset({ ...network, maxUploadSize: 'none' }, file(), { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('sends no Authorization header without a token', async () => {
    const fetchImpl = fakeFetch(() => json({ exists: true }));
    await uploadAsset(network, file(), { authToken: null, fetchImpl });
    expect(authOf((fetchImpl.mock.calls[0] as [string, RequestInit])[1])).toBeUndefined();
  });

  it('fails clearly before the world has sent its API URL', async () => {
    const error = await uploadAsset({ apiUrl: null }, file(), { fetchImpl: fakeFetch(() => json({})) }).catch((e) => e);
    expect(error).toBeInstanceOf(AssetUploadError);
    expect(isPermanentRefusal(error)).toBe(false);
  });
});

describe('assetServed', () => {
  afterEach(() => vi.restoreAllMocks());

  it('is true when served, false when missing, null when it cannot tell', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await assetServed('https://a/x', fakeFetch(() => new Response(null, { status: 200 })))).toBe(true);
    expect(await assetServed('https://a/x', fakeFetch(() => new Response(null, { status: 404 })))).toBe(false);
    expect(await assetServed('https://a/x', fakeFetch(() => new Response(null, { status: 503 })))).toBeNull();
    expect(
      await assetServed(
        'https://a/x',
        fakeFetch(() => {
          throw new Error('down');
        })
      )
    ).toBeNull();
  });
});

describe('ensureAsset', () => {
  afterEach(() => vi.restoreAllMocks());

  const asset = { buffer: Buffer.from('glTF-avatar'), name: 'avatar.vrm', type: 'model/gltf-binary' };

  /** HEAD answers from a set of served file names. */
  function serve(served: Set<string>) {
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => {
      const name = String(url).split('/').pop()!;
      return new Response(null, { status: served.has(name) ? 200 : 404 });
    });
  }

  const worldWith = (upload: (file: File) => Promise<unknown>) => ({ assetsUrl: 'https://world.test/assets/', network: { upload } });

  it('uses a file the world already serves without uploading', async () => {
    const served = new Set<string>();
    serve(served);
    const upload = vi.fn();
    served.add(`${await hashFileBuffer(asset.buffer)}.vrm`);

    const result = await ensureAsset(worldWith(upload), asset);
    expect(result).toMatchObject({ ok: true, uploaded: false });
    expect(result.ok && result.url).toMatch(/^https:\/\/world\.test\/assets\/[0-9a-f]{64}\.vrm$/);
    expect(upload).not.toHaveBeenCalled();
  });

  it('uploads a missing file and confirms it is served', async () => {
    const served = new Set<string>();
    serve(served);
    const upload = vi.fn(async (file: File) => {
      served.add(`${await hashFileBuffer(Buffer.from(await file.arrayBuffer()))}.vrm`);
    });
    const result = await ensureAsset(worldWith(upload), asset);
    expect(result).toMatchObject({ ok: true, uploaded: true });
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it('is not ok when an upload "succeeds" but the file never appears', async () => {
    serve(new Set());
    const result = await ensureAsset(worldWith(vi.fn().mockResolvedValue(undefined)), asset);
    expect(result).toMatchObject({ ok: false, retryable: true });
  });

  it("passes the world's refusal through", async () => {
    serve(new Set());
    const refusal = new AssetUploadError('Upload failed (HTTP 403): builder rank required', 403);
    const result = await ensureAsset(worldWith(vi.fn().mockRejectedValue(refusal)), asset);
    expect(result).toEqual({ ok: false, fileName: expect.stringMatching(/\.vrm$/), error: refusal, retryable: false });
  });

  it('retries after a failure that may pass', async () => {
    serve(new Set());
    const outage = new AssetUploadError('Upload failed (HTTP 503): Service Unavailable', 503);
    const result = await ensureAsset(worldWith(vi.fn().mockRejectedValue(outage)), asset);
    expect(result).toMatchObject({ ok: false, retryable: true });
  });

  it('without uploading, retries only when the lookup itself failed', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    serve(new Set());
    expect(await ensureAsset(worldWith(vi.fn()), asset, { upload: false })).toMatchObject({ ok: false, retryable: false });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 503 }));
    expect(await ensureAsset(worldWith(vi.fn()), asset, { upload: false })).toMatchObject({ ok: false, retryable: true });
  });

  it('does not hand out an upload it could not confirm', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let uploaded = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      uploaded ? new Response(null, { status: 503 }) : new Response(null, { status: 404 })
    );
    const result = await ensureAsset(worldWith(async () => { uploaded = true; }), asset);
    expect(result).toMatchObject({ ok: false, retryable: true });
  });
});
