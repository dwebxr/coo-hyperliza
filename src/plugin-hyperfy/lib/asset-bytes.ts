/**
 * The bytes of an asset a world names (a model, avatar, emote, script, image or HDR environment):
 * a bundled file, an inline data: URL, or a download under the world's network policy
 * (lib/net-policy.ts) with the agent's byte cap for that kind of asset.
 */
import { createHash } from 'node:crypto';
import { resolveUrl } from '../utils';
import type { AssetLease } from './asset-memory';
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
  /**
   * What was asked for, as resolveUrl spelled it: the first URL (redirects do not show); for a
   * data: URL its short name (dataUrlName), never the URL itself, which holds the whole file
   */
  url: string;
}

/**
 * The name of a data: URL wherever it is kept or sent as an identifier: its media type and the
 * SHA-256 of the URL's text (the same text always decodes to the same bytes), as
 * `data:<type>;sha256=<hex>`. The page's image loader still reads the format from the type.
 * Null for any other URL.
 */
export function dataUrlName(url: string): string | null {
  if (!/^data:/i.test(url)) return null;
  const type = url.slice(5, 5 + 100).split(/[;,]/)[0].trim().toLowerCase().replace(/[^a-z0-9.+/-]/g, '');
  return `data:${type};sha256=${createHash('sha256').update(url).digest('hex')}`;
}

/** What names an asset of `kind` at `url` in a cache or a refusal list: data: URLs by dataUrlName */
export function assetKey(kind: string, url: unknown): string {
  const text = typeof url === 'string' ? url : String(url);
  return `${kind}/${dataUrlName(text) ?? text}`;
}

export { describeUrl } from './log-url';

/**
 * The bytes and type of a data: URL. A base64 payload that would decode to more than `maxBytes` is
 * refused before it is decoded; any other payload only when it is longer than 3 × `maxBytes`
 * characters, and after decoding otherwise.
 */
export function decodeDataUrl(url: string, maxBytes: number): { bytes: Uint8Array; contentType: string } {
  const comma = url.indexOf(',');
  if (!url.startsWith('data:') || comma === -1) throw new Error('not a valid data: URL');
  const meta = url.slice(5, comma).split(';');
  const base64 = meta.at(-1)?.trim().toLowerCase() === 'base64';
  const contentType = (meta[0] ?? '').trim().toLowerCase();
  const payload = url.slice(comma + 1);
  // Base64 is 4 characters for 3 bytes; any other payload holds at least one byte per 3 characters (%XX)
  const atLeast = base64 ? Math.floor((payload.length * 3) / 4) - 2 : Math.ceil(payload.length / 3);
  if (atLeast > maxBytes) throw new Error(`the data: URL holds more than ${maxBytes} bytes`);
  const bytes = base64 ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload), 'utf8');
  if (bytes.byteLength > maxBytes) throw new Error(`the data: URL holds more than ${maxBytes} bytes`);
  return { bytes: new Uint8Array(bytes), contentType };
}

/**
 * Loads what `url` names for `world`: `asset://` on the world's assets URL, an http(s) URL, a
 * data: URL, or a bundled file (lib/asset-root.ts). Throws when it cannot be
 * resolved, is refused by the policy, is too large, or is not answered with a 2xx status.
 */
export async function fetchAssetBytes(
  world: { assetsUrl?: string | null },
  url: unknown,
  kind: AssetKind,
  {
    signal,
    lease,
  }: {
    signal?: AbortSignal;
    /** The download's reservation (lib/asset-memory.ts): shrunk to the declared, then the actual size */
    lease?: AssetLease;
  } = {}
): Promise<AssetBytes> {
  const resolved = await resolveUrl(url, world);
  // Also a data: URL or a bundled file is not handed out once the caller has stopped
  if (signal?.aborted) throw new SafeFetchError('aborted', 'the load was cancelled');
  if (!resolved) throw new Error(`could not resolve ${describeUrl(url)}`);
  const maxBytes = ASSET_BYTE_CAPS[kind];
  if (resolved.startsWith('data:')) {
    const decoded = decodeDataUrl(resolved, maxBytes);
    lease?.shrink(2 * decoded.bytes.byteLength);
    return { ...decoded, url: dataUrlName(resolved)! };
  }
  // Nothing in the agent makes object URLs, so a blob: URL can only name nothing
  if (resolved.startsWith('blob:')) throw new Error('blob: URLs cannot be loaded by the agent');
  const answer = await worldNet(world).fetch(resolved, {
    maxBytes,
    timeoutMs: TIMEOUT_MS[kind],
    signal,
    onResponse: (headers) => {
      const declared = Number(headers['content-length']);
      if (Number.isSafeInteger(declared) && declared >= 0) lease?.shrink(2 * Math.min(declared, maxBytes));
    },
  });
  lease?.shrink(2 * answer.body.byteLength);
  if (answer.status < 200 || answer.status >= 300) throw new Error(`HTTP ${answer.status}`);
  const contentType = (answer.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  return { bytes: answer.body, contentType, url: resolved };
}
