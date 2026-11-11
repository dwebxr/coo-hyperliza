import net from 'node:net';
import { describeUrl } from './log-url';

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
    throw new Error(`WS_URL is not a valid URL: "${describeUrl(value)}"`);
  }
  if (!WORLD_URL_PROTOCOLS.includes(url.protocol)) {
    throw new Error(`WS_URL must start with ws://, wss://, http:// or https://, not ${url.protocol}//`);
  }
  return value;
}

/**
 * The http(s) origin of the world behind a world socket URL (wss: -> https:, ws: -> http:, an
 * http(s): URL as it is), or null when `wsUrl` is not such a URL. This is the one origin the
 * outbound network policy treats as the world itself (lib/net-policy.ts).
 */
export function worldHttpOrigin(wsUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(wsUrl);
  } catch {
    return null;
  }
  if (!WORLD_URL_PROTOCOLS.includes(url.protocol)) return null;
  const scheme = url.protocol === 'wss:' || url.protocol === 'https:' ? 'https:' : 'http:';
  return new URL(`${scheme}//${url.host}`).origin;
}

// Loopback, the private IPv4 ranges (RFC 1918) and IPv6 unique local addresses: this machine or a
// network the operator runs
const LOCAL_ADDRESSES = new net.BlockList();
LOCAL_ADDRESSES.addSubnet('127.0.0.0', 8);
LOCAL_ADDRESSES.addSubnet('10.0.0.0', 8);
LOCAL_ADDRESSES.addSubnet('172.16.0.0', 12);
LOCAL_ADDRESSES.addSubnet('192.168.0.0', 16);
LOCAL_ADDRESSES.addAddress('::1', 'ipv6');
LOCAL_ADDRESSES.addSubnet('fc00::', 7, 'ipv6');

/**
 * Why the session token must not be put on a world socket URL, or null when it may. The token
 * travels in the URL's query, so it is readable on the way unless the transport is encrypted
 * (wss:, https:). Without encryption it is sent only to a host written as a loopback or private
 * address, or as `localhost`: a world on this machine or on the operator's own network. A name
 * that merely resolves to such an address does not count (what it resolves to can change).
 */
export function sessionTokenProblem(url: URL): string | null {
  if (url.protocol === 'wss:' || url.protocol === 'https:') return null;
  // WHATWG URL writes every IPv4 spelling (hex, a single number) as dotted decimal
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const family = net.isIP(host);
  if (host === 'localhost' || (family !== 0 && LOCAL_ADDRESSES.check(host, family === 6 ? 'ipv6' : 'ipv4'))) return null;
  return `${url.protocol}//${url.host} is not encrypted and is not a loopback or private address`;
}
