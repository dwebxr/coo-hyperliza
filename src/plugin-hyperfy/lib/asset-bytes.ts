/**
 * The bytes of an asset a world names (a model, avatar, emote, script, image or HDR environment):
 * a bundled file, an inline data: URL, or a download under the world's network policy
 * (lib/net-policy.ts) with the operator's byte cap for that kind of asset.
 */
import { resolveUrl } from '../utils';
import { describeUrl } from './log-url';
import { MAX_EMOTE_BYTES, MAX_IMAGE_BYTES, MAX_MODEL_BYTES, MAX_SCRIPT_BYTES, SafeFetchError, worldNet } from './net-policy';

export type AssetKind = 'model' | 'avatar' | 'emote' | 'script' | 'image' | 'hdr';

export const ASSET_BYTE_CAPS: Readonly<Record<AssetKind, number>> = Object.freeze({
  model: MAX_MODEL_BYTES,
  avatar: MAX_MODEL_BYTES,
  emote: MAX_EMOTE_BYTES,
  script: MAX_SCRIPT_BYTES,
  image: MAX_IMAGE_BYTES,
  hdr: MAX_IMAGE_BYTES,
});

/** One deadline per download; large models get longer. */
const TIMEOUT_MS: Readonly<Record<AssetKind, number>> = Object.freeze({ model: 60_000, avatar: 60_000, emote: 30_000, script: 15_000, image: 30_000, hdr: 30_000 });

export interface AssetBytes {
  bytes: Uint8Array;
  /** The Content-Type the source gave (lower case, without parameters), or '' */
  contentType: string;
  /** Where the bytes came from, as resolveUrl spelled it (the last URL, after redirects) */
  url: string;
}

export { describeUrl } from './log-url';

/** The bytes and type of a data: URL, read without building anything larger than `maxBytes`. */
export function decodeDataUrl(url: string, maxBytes: number): { bytes: Uint8Array; contentType: string } {
  const comma = url.indexOf(',');
  if (!url.startsWith('data:') || comma === -1) throw new Error('not a valid data: URL');
  const meta = url.slice(5, comma).split(';');
  const base64 = meta.at(-1)?.trim().toLowerCase() === 'base64';
  const contentType = (meta[0] ?? '').trim().toLowerCase();
  const payload = url.slice(comma + 1);
  // Base64 is 4 characters for 3 bytes; percent-encoding is never shorter than what it encodes
  const atLeast = base64 ? Math.floor((payload.length * 3) / 4) - 2 : Math.ceil(payload.length / 3);
  if (atLeast > maxBytes) throw new Error(`the data: URL holds more than ${maxBytes} bytes`);
  const bytes = base64 ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload), 'utf8');
  if (bytes.byteLength > maxBytes) throw new Error(`the data: URL holds more than ${maxBytes} bytes`);
  return { bytes: new Uint8Array(bytes), contentType };
}

/**
 * Loads what `url` names for `world`: `asset://` on the world's assets URL, an http(s) URL, a
 * data: URL, or a path inside the module directory (a bundled file). Throws when it cannot be
 * resolved, is refused by the policy, is too large, or is not answered with a 2xx status.
 */
export async function fetchAssetBytes(
  world: { assetsUrl?: string | null },
  url: unknown,
  kind: AssetKind,
  { signal }: { signal?: AbortSignal } = {}
): Promise<AssetBytes> {
  const resolved = await resolveUrl(url, world);
  // Also a data: URL or a bundled file is not handed out once the caller has stopped
  if (signal?.aborted) throw new SafeFetchError('aborted', 'the load was cancelled');
  if (!resolved) throw new Error(`could not resolve ${describeUrl(url)}`);
  const maxBytes = ASSET_BYTE_CAPS[kind];
  if (resolved.startsWith('data:')) return { ...decodeDataUrl(resolved, maxBytes), url: resolved };
  // Nothing in the agent makes object URLs, so a blob: URL can only name nothing
  if (resolved.startsWith('blob:')) throw new Error('blob: URLs cannot be loaded by the agent');
  const answer = await worldNet(world).fetch(resolved, { maxBytes, timeoutMs: TIMEOUT_MS[kind], signal });
  if (answer.status < 200 || answer.status >= 300) throw new Error(`HTTP ${answer.status}`);
  const contentType = (answer.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  return { bytes: answer.body, contentType, url: resolved };
}
