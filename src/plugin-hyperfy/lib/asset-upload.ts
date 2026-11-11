import { hashFileBuffer, resolveUrl } from '../utils';
import { describeUrl } from './log-url';
import { type NetPolicy, onWorldOrigin, SafeFetchError, toResponse, worldNet } from './net-policy';

/**
 * Asset uploads that work with the world's upload rules.
 *
 * The world only accepts uploads from a connected session: both requests carry the session's
 * bearer token, and posting a file needs builder rank (or, for a .vrm, custom avatars turned on
 * in the world settings). The engine's ClientNetwork.upload does neither: it sends no token and
 * ignores the response, so session/create-agent-world.ts installs uploadAsset in its place.
 *
 * The token goes to the world's own origin only (the one WS_URL names; for a loopback world, any
 * loopback spelling of it: net-policy.ts onWorldOrigin): the API URL arrives from the world, and
 * one on any other origin is refused before anything is sent. A redirect is not
 * followed either, wherever it points. Like every request for a world, these go through the
 * network policy (lib/net-policy.ts) and so never through an HTTP(S)_PROXY, which the runtime's
 * own fetch would use. The world's assets URL gets no token: looking a file up there is an
 * ordinary request under the policy.
 */

const UPLOAD_TIMEOUT_MS = 30_000;
const HEAD_TIMEOUT_MS = 5_000;
// The API answers { exists } or { error }
const API_ANSWER_MAX_BYTES = 64 * 1024;

/** What `check` threw inside the transport, passed through the sender unchanged. */
class GuardStopped {
  constructor(readonly reason: unknown) {}
}

/**
 * fetch() for the world's API, through the policy: the answer is small, and a redirect comes back
 * as it is. The destination and `check` are judged again after the body is encoded (which is
 * awaited), immediately before the request goes out.
 */
function worldApiFetch(net: NetPolicy, timeoutMs: number, check?: () => void): typeof fetch {
  return async (input, init = {}) => {
    const headers = { ...(init.headers as Record<string, string> | undefined) };
    let body: Uint8Array | undefined;
    if (init.body instanceof FormData) {
      // The multipart encoding, boundary included, as the runtime writes it
      const encoded = new Response(init.body);
      headers['content-type'] = encoded.headers.get('content-type') ?? 'multipart/form-data';
      body = new Uint8Array(await encoded.arrayBuffer());
    }
    const url = String(input);
    const problem = apiUrlProblem(url, net.worldOrigin);
    if (problem) throw new AssetUploadError(`Upload refused: ${problem}`, undefined, true);
    try {
      check?.();
    } catch (error) {
      throw new GuardStopped(error);
    }
    const answer = await net.fetch(url, { method: init.method ?? 'GET', headers, body, maxBytes: API_ANSWER_MAX_BYTES, timeoutMs, signal: init.signal ?? undefined, followRedirects: false });
    return toResponse(answer);
  };
}

export class AssetUploadError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** The agent itself will not do this, whatever the world answers */
    readonly refusedHere = false
  ) {
    super(message);
    this.name = 'AssetUploadError';
  }
}

/**
 * Sending it again will not help: the world refused the upload (no session, rank, type, size,
 * shape), or the agent refuses to send it where the world asked.
 */
export function isPermanentRefusal(error: unknown): error is AssetUploadError {
  if (!(error instanceof AssetUploadError)) return false;
  if (error.refusedHere) return true;
  if (error.status === undefined) return false;
  return error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429;
}

const originOf = (url: string): string | null => {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};
// The origin of a URL for a log line; what has none is written as describeUrl writes it
const shownOrigin = (url: string): string => {
  const origin = originOf(url);
  return origin && origin !== 'null' ? origin : describeUrl(url);
};

/**
 * Why the agent will not send its session token to `apiUrl`, or null when that is the world's own
 * origin. The world names its API URL itself, so a world (or anything that can alter its snapshot)
 * could otherwise point the token anywhere.
 */
export function apiUrlProblem(apiUrl: string, worldOrigin: string | null): string | null {
  const origin = originOf(apiUrl);
  if (origin !== null && origin !== 'null' && onWorldOrigin(apiUrl, worldOrigin)) {
    const { username, password } = new URL(apiUrl);
    return username || password ? "the world's API URL carries a user name or password, and the session token is not sent with one" : null;
  }
  return `the world's API URL is on ${origin === null || origin === 'null' ? 'no usable origin' : origin}, not on the world's own origin (${worldOrigin ?? 'unknown'}, from WS_URL), and the session token is only sent there`;
}

/**
 * What to tell the operator when a world's API or assets URL is somewhere the agent will not go,
 * once per connection: a world that serves them from another origin than its socket is not
 * broken silently. (An assets host is also judged by its addresses on every request; that part
 * shows up in the loader's log.)
 */
export function worldEndpointProblems(net: NetPolicy, { apiUrl, assetsUrl }: { apiUrl?: unknown; assetsUrl?: unknown }): string[] {
  const problems: string[] = [];
  if (typeof apiUrl === 'string' && apiUrl) {
    const problem = apiUrlProblem(apiUrl, net.worldOrigin);
    if (problem) problems.push(`Uploads to this world are refused (the avatar, emotes and imported models): ${problem}. If the world really serves its API there, use a WS_URL on that origin.`);
  }
  if (typeof assetsUrl === 'string' && assetsUrl && !net.isWorldOrigin(assetsUrl)) {
    const problem = net.urlProblem(`${assetsUrl.replace(/\/$/, '')}/x`);
    if (problem) {
      problems.push(`This world's assets (models, avatars, emotes, scripts) will not be loaded: its assets URL ${shownOrigin(assetsUrl)} is neither the world's own origin (${net.worldOrigin ?? 'unknown'}, from WS_URL) nor a public https address (${problem}). If it is the same server under another name, use that name in WS_URL.`);
    }
  }
  return problems;
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

/** What a caller of world.network.upload may pass (session/create-agent-world.ts installs uploadAsset there). */
export interface UploadOptions {
  /**
   * Called right before each HTTP request (and so after every await before it); it throws to stop
   * the upload. Scene edits pass their authorization check here; the agent's own avatar and emote
   * uploads pass none. The connection's session adds its own to every upload: none is made once
   * the connection has ended (session/connection-session.ts).
   */
  check?: () => void;
}

/**
 * The one function that sends the session token over HTTP (the socket carries it in its own URL,
 * lib/world-protocol.ts): each call checks its own URL against the world's origin (apiUrlProblem)
 * before anything is sent, then calls `check`, and never follows a redirect.
 * Throws AssetUploadError, or whatever `check` throws.
 */
export function worldApiSender(
  net: NetPolicy,
  { authToken, fetchImpl, signal, check }: { authToken?: string | null; fetchImpl: typeof fetch; signal: AbortSignal; check?: () => void }
): (url: string, init?: RequestInit) => Promise<Response> {
  return async (url, init = {}) => {
    const problem = apiUrlProblem(url, net.worldOrigin);
    if (problem) throw new AssetUploadError(`Upload refused: ${problem}`, undefined, true);
    check?.();
    const headers: Record<string, string> = authToken ? { Authorization: `Bearer ${authToken}` } : {};
    let resp: Response;
    try {
      // Never followed: a redirect would take the token (or the file) wherever the answer says
      resp = await fetchImpl(url, { ...init, headers, signal, redirect: 'manual' });
    } catch (error: any) {
      if (error instanceof GuardStopped) throw error.reason;
      if (error instanceof AssetUploadError) throw error;
      const timedOut = error?.name === 'TimeoutError' || signal.aborted || (error instanceof SafeFetchError && error.kind === 'timeout');
      if (error instanceof SafeFetchError && error.kind === 'refused') throw new AssetUploadError(`Upload refused: ${error.message}`, undefined, true);
      throw new AssetUploadError(`Upload failed: ${timedOut ? 'timed out' : error?.message || error}`);
    }
    if (resp.type === 'opaqueredirect' || (resp.status >= 300 && resp.status < 400)) {
      throw new AssetUploadError(`Upload refused: the world's API answered with a redirect (HTTP ${resp.status}), which is not followed`, resp.status, true);
    }
    if (!resp.ok) throw await uploadError(resp);
    return resp;
  };
}

/**
 * Uploads a file the way the world's own client does: upload-check, then the multipart upload,
 * both with the session's token. Throws AssetUploadError (with the HTTP status when the world
 * answered) instead of failing silently, or whatever `check` throws. The API URL is read once:
 * both requests go to the URL that was checked, whatever the world sends meanwhile.
 */
export async function uploadAsset(
  network: UploadNetwork,
  file: File,
  {
    net,
    authToken,
    timeoutMs = UPLOAD_TIMEOUT_MS,
    check,
    fetchImpl = worldApiFetch(net, timeoutMs, check),
  }: {
    /** The world's policy (worldNet): its world origin is the only place the token is sent */
    net: NetPolicy;
    authToken?: string | null;
    /** Replaces the requests themselves (tests); the checks in worldApiSender stay */
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  } & UploadOptions
): Promise<void> {
  const apiUrl = network.apiUrl;
  if (!apiUrl) throw new AssetUploadError('Upload failed: the world has not sent its API URL yet');
  const problem = apiUrlProblem(apiUrl, net.worldOrigin);
  if (problem) throw new AssetUploadError(`Upload refused: ${problem}`, undefined, true);
  // The world enforces the same cap; refusing here spares a doomed transfer
  const maxMb = Number(network.maxUploadSize);
  if (Number.isFinite(maxMb) && maxMb > 0 && file.size > maxMb * 1024 * 1024) {
    throw new AssetUploadError(`Upload failed: ${file.name} exceeds ${maxMb}MB`, 413);
  }

  // One deadline for the whole upload
  const send = worldApiSender(net, { authToken, fetchImpl, signal: AbortSignal.timeout(timeoutMs), check });

  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  const filename = `${await hashFileBuffer(Buffer.from(await file.arrayBuffer()))}.${ext}`;
  // First check whether the world already has it
  const existing = await send(`${apiUrl}/upload-check?filename=${encodeURIComponent(filename)}`);
  const data: any = await existing.json().catch(() => null);
  if (data?.exists === true) return;

  const form = new FormData();
  form.append('file', file);
  await send(`${apiUrl}/upload`, { method: 'POST', body: form });
}

/**
 * Whether `url` is served: true, false (any other status below 500), or null when that could not
 * be checked (cause logged). Throws AssetUploadError when the network policy does not allow asking at all.
 */
export async function assetServed(url: string, net: NetPolicy): Promise<boolean | null> {
  try {
    const resp = await net.fetch(url, { method: 'HEAD', maxBytes: 0, timeoutMs: HEAD_TIMEOUT_MS });
    if (resp.status >= 200 && resp.status < 300) return true;
    if (resp.status < 500) return false;
    console.warn(`[Assets] Could not check ${describeUrl(url)}: HTTP ${resp.status}`);
    return null;
  } catch (error: any) {
    if (error instanceof SafeFetchError && error.kind === 'refused') {
      throw new AssetUploadError(`the world's assets URL is not allowed by the agent's network policy (${error.message})`, undefined, true);
    }
    console.warn(`[Assets] Could not check ${describeUrl(url)}: ${error?.message || error}`);
    return null;
  }
}

export type EnsureAssetResult =
  | { ok: true; fileName: string; url: string; uploaded: boolean }
  /** retryable: the cause may pass (network, server error, not verified yet); false when the world refused, the agent's policy refuses the assets URL, or the file is not there and was not to be uploaded. */
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

  const net = worldNet(world);
  let before: boolean | null;
  try {
    before = await assetServed(url, net);
  } catch (error: any) {
    return { ok: false, fileName, error: error instanceof Error ? error : new Error(String(error)), retryable: false };
  }
  if (before === true) return { ok: true, fileName, url, uploaded: false };
  if (!upload) {
    return { ok: false, fileName, error: new Error(`${fileName} is not on the server`), retryable: before === null };
  }

  try {
    await world.network.upload(new File([new Uint8Array(buffer)], name, { type }));
  } catch (error: any) {
    const err = error instanceof Error ? error : new Error(String(error));
    return { ok: false, fileName, error: err, retryable: !isPermanentRefusal(err) };
  }
  // Only a file the world is seen serving is handed out: clients do not retry a failed load
  const after = await assetServed(url, net).catch(() => null);
  if (after !== true) {
    const why = after === false ? 'the world does not serve it' : 'it could not be looked up';
    return { ok: false, fileName, error: new Error(`uploaded ${fileName}, but ${why}`), retryable: true };
  }
  return { ok: true, fileName, url, uploaded: true };
}
