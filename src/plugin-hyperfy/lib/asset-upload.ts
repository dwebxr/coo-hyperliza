import { hashFileBuffer, resolveUrl } from '../utils';

/**
 * Asset uploads that work with the world's upload rules.
 *
 * The world only accepts uploads from a connected session: both requests carry the session's
 * bearer token, and posting a file needs builder rank (or, for a .vrm, custom avatars turned on
 * in the world settings). The engine's ClientNetwork.upload predates this: it sends no token and
 * ignores the response, so service.ts installs uploadAsset in its place.
 */

const UPLOAD_TIMEOUT_MS = 30_000;
const HEAD_TIMEOUT_MS = 5_000;

export class AssetUploadError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = 'AssetUploadError';
  }
}

/** The world refused the upload (no session, rank, type, size, shape): sending it again will not help. */
export function isPermanentRefusal(error: unknown): error is AssetUploadError {
  if (!(error instanceof AssetUploadError) || error.status === undefined) return false;
  return error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429;
}

async function uploadError(resp: Response): Promise<AssetUploadError> {
  let reason = resp.statusText || `HTTP ${resp.status}`;
  try {
    // The world answers { error }; a proxy in front of it may answer with HTML
    const body: any = await resp.json();
    if (typeof body?.error === 'string' && body.error) reason = body.error.slice(0, 200);
  } catch {
    // keep the status text
  }
  return new AssetUploadError(`Upload failed (HTTP ${resp.status}): ${reason}`, resp.status);
}

export interface UploadNetwork {
  apiUrl?: string | null;
  /** In MB; the world sends it as it is configured (usually a string), or not at all. */
  maxUploadSize?: unknown;
}

/**
 * Uploads a file the way the world's own client does: upload-check, then the multipart upload,
 * both with the session's token. Throws AssetUploadError (with the HTTP status when the world
 * answered) instead of failing silently.
 */
export async function uploadAsset(
  network: UploadNetwork,
  file: File,
  {
    authToken,
    fetchImpl = fetch,
    timeoutMs = UPLOAD_TIMEOUT_MS,
  }: { authToken?: string | null; fetchImpl?: typeof fetch; timeoutMs?: number } = {}
): Promise<void> {
  if (!network.apiUrl) throw new AssetUploadError('Upload failed: the world has not sent its API URL yet');
  // The world enforces the same cap; refusing here spares a doomed transfer
  const maxMb = Number(network.maxUploadSize);
  if (Number.isFinite(maxMb) && maxMb > 0 && file.size > maxMb * 1024 * 1024) {
    throw new AssetUploadError(`Upload failed: ${file.name} exceeds ${maxMb}MB`, 413);
  }

  const headers: Record<string, string> = authToken ? { Authorization: `Bearer ${authToken}` } : {};
  // One deadline for the whole upload
  const signal = AbortSignal.timeout(timeoutMs);
  const send = async (url: string, init: RequestInit = {}): Promise<Response> => {
    let resp: Response;
    try {
      resp = await fetchImpl(url, { ...init, headers, signal });
    } catch (error: any) {
      throw new AssetUploadError(`Upload failed: ${error?.name === 'TimeoutError' ? 'timed out' : error?.message || error}`);
    }
    if (!resp.ok) throw await uploadError(resp);
    return resp;
  };

  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  const filename = `${await hashFileBuffer(Buffer.from(await file.arrayBuffer()))}.${ext}`;
  // First check whether the world already has it
  const check = await send(`${network.apiUrl}/upload-check?filename=${encodeURIComponent(filename)}`);
  const data: any = await check.json().catch(() => null);
  if (data?.exists === true) return;

  const form = new FormData();
  form.append('file', file);
  await send(`${network.apiUrl}/upload`, { method: 'POST', body: form });
}

/** Whether `url` is served: true, false (4xx), or null when that could not be checked (cause logged). */
export async function assetServed(url: string, fetchImpl: typeof fetch = fetch): Promise<boolean | null> {
  try {
    const resp = await fetchImpl(url, { method: 'HEAD', signal: AbortSignal.timeout(HEAD_TIMEOUT_MS) });
    if (resp.ok) return true;
    if (resp.status < 500) return false;
    console.warn(`[Assets] Could not check ${url}: HTTP ${resp.status}`);
    return null;
  } catch (error: any) {
    console.warn(`[Assets] Could not check ${url}: ${error?.message || error}`);
    return null;
  }
}

export type EnsureAssetResult =
  | { ok: true; fileName: string; url: string; uploaded: boolean }
  /** retryable: the cause may pass (network, server error, not verified yet); false when the world refused. */
  | { ok: false; fileName: string; error: Error; retryable: boolean };

/**
 * Makes sure the world serves this file. Files are stored under their content hash, so one that is
 * already there is used as-is (no upload rights needed); otherwise it is uploaded (unless `upload`
 * is false) and then looked up again.
 */
export async function ensureAsset(
  world: { assetsUrl?: string | null; network: { upload(file: File): Promise<unknown> } },
  { buffer, name, type }: { buffer: Buffer; name: string; type: string },
  { upload = true }: { upload?: boolean } = {}
): Promise<EnsureAssetResult> {
  const ext = name.split('.').pop()?.toLowerCase() || 'bin';
  const fileName = `${await hashFileBuffer(buffer)}.${ext}`;
  const url = await resolveUrl(`asset://${fileName}`, world);
  if (!url) return { ok: false, fileName, error: new Error('the world has not sent its assets URL yet'), retryable: true };

  const before = await assetServed(url);
  if (before === true) return { ok: true, fileName, url, uploaded: false };
  if (!upload) {
    return { ok: false, fileName, error: new Error(`${fileName} is not on the server`), retryable: before === null };
  }

  try {
    await world.network.upload(new File([buffer], name, { type }));
  } catch (error: any) {
    const err = error instanceof Error ? error : new Error(String(error));
    return { ok: false, fileName, error: err, retryable: !isPermanentRefusal(err) };
  }
  // Only a file the world is seen serving is handed out: clients do not retry a failed load
  const after = await assetServed(url);
  if (after !== true) {
    const why = after === false ? 'the world does not serve it' : 'it could not be looked up';
    return { ok: false, fileName, error: new Error(`uploaded ${fileName}, but ${why}`), retryable: true };
  }
  return { ok: true, fileName, url, uploaded: true };
}
