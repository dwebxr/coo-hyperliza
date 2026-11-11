/** The world the agent joins when WS_URL is unset or empty. */
export const DEFAULT_WORLD_WS_URL = 'wss://chill.hyperfy.xyz/ws';

/** Schemes the world socket accepts (the WebSocket constructor maps http(s) to ws(s)). */
export const WORLD_URL_PROTOCOLS: readonly string[] = ['ws:', 'wss:', 'http:', 'https:'];

/**
 * The world's WebSocket URL from WS_URL: the default when unset or empty, otherwise the trimmed
 * value. Throws when it is only whitespace (a value was set, so it is not taken as unset) or not an
 * absolute URL with one of WORLD_URL_PROTOCOLS.
 */
export function resolveWorldWsUrl(raw: string | undefined): string {
  if (raw === undefined || raw === '') return DEFAULT_WORLD_WS_URL;
  const value = raw.trim();
  if (!value) throw new Error('WS_URL is set but blank');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`WS_URL is not a valid URL: "${value}"`);
  }
  if (!WORLD_URL_PROTOCOLS.includes(url.protocol)) {
    throw new Error(`WS_URL must start with ws://, wss://, http:// or https://, not ${url.protocol}//`);
  }
  return value;
}
