/**
 * The one outbound network policy. Every download of a URL that the world, the model, a world
 * script or a remote API named goes through NetPolicy.fetch (safeFetch for callers with no world).
 *
 * What a request may reach:
 *   - `https:` URLs on the default port whose host is a public address. A host name is judged by
 *     what it resolves to, at the moment of connecting: the resolver's answer is checked inside the
 *     `lookup` hook of node:http(s), which is where the runtime takes the address it connects to,
 *     so the address that was checked is the address that is dialled (no second resolution to
 *     rebind). A name with several addresses is refused when any of them is not public.
 *   - The world's own origin (WS_URL with wss:->https:, ws:->http:), on any address, any port and
 *     over http: a local or LAN world keeps working. A loopback world's scheme and port count on
 *     every loopback spelling (onWorldOrigin). Nothing else gets this exception, and a redirect
 *     that leaves the origin loses it (every hop is judged from scratch).
 *
 * Also: no credentials in URLs; redirects are followed by hand, at most MAX_REDIRECTS; one
 * deadline covers the whole exchange; the body is read as a stream and the request is destroyed
 * as soon as it exceeds the caller's byte cap; every request uses a connection of its own
 * (`agent: false`), because a pooled connection is reused without `lookup` being asked again.
 *
 * What this does NOT do, so nobody assumes it:
 *   - It trusts the world's origin entirely. Whoever can name a URL (the world, a script, the
 *     model through an import) can make the agent GET any path on that origin, without
 *     credentials. If WS_URL points at a host that also serves something private, that is reachable.
 *   - Requests to public hosts stay possible and are not rate limited here: the agent can be made
 *     to fetch from, and so reveal its address to, any public https host.
 *   - It does not go through HTTP(S)_PROXY (node:http ignores those variables in Node and Bun, and
 *     net-policy.child.test.ts checks that). Where the only way out is a proxy, these requests
 *     fail; and if one were ever routed through a proxy, the proxy would resolve the name and the
 *     address check here would mean nothing.
 *   - Address classes follow the IANA special-purpose registries as of this writing. A private
 *     network that uses public address space is not recognised.
 */

import dns from 'node:dns';
import http, { type IncomingMessage } from 'node:http';
import https from 'node:https';
import net from 'node:net';

const MB = 1024 * 1024;

// ---- operator byte caps ----

/** Models (.glb) and avatars (.vrm): world assets, and files the agent is asked to import. */
export const MAX_MODEL_BYTES = 50 * MB;
/** Emote animations (.glb). */
export const MAX_EMOTE_BYTES = 16 * MB;
/** App scripts. */
export const MAX_SCRIPT_BYTES = 2 * MB;
/** Images (sky) and HDR environments. */
export const MAX_IMAGE_BYTES = 32 * MB;
/** Audio handed to transcription by URL. */
export const MAX_AUDIO_BYTES = 32 * MB;

export const MAX_REDIRECTS = 5;
export const DEFAULT_TIMEOUT_MS = 30_000;

// ---- address classes ----

function ipv4Bytes(text: string): number[] | null {
  if (net.isIP(text) !== 4) return null;
  return text.split('.').map(Number);
}

/** The 16 bytes of an IPv6 address in any textual form net.isIP accepts (a zone id is ignored). */
function ipv6Bytes(input: string): number[] | null {
  const zone = input.indexOf('%');
  let text = zone === -1 ? input : input.slice(0, zone);
  if (net.isIP(text) !== 6) return null;
  let tail: number[] | null = null;
  if (text.includes('.')) {
    const cut = text.lastIndexOf(':');
    tail = ipv4Bytes(text.slice(cut + 1));
    if (!tail) return null;
    text = `${text.slice(0, cut + 1)}0:0`;
  }
  const [head, rest] = text.split('::');
  const groups = (part: string | undefined) => (part ? part.split(':').map((group) => parseInt(group, 16)) : []);
  const left = groups(head);
  const right = rest === undefined ? [] : groups(rest);
  const fill = rest === undefined ? 0 : 8 - left.length - right.length;
  const words = [...left, ...new Array<number>(Math.max(fill, 0)).fill(0), ...right];
  if (words.length !== 8 || words.some((word) => !Number.isInteger(word) || word < 0 || word > 0xffff)) return null;
  const bytes = words.flatMap((word) => [word >> 8, word & 0xff]);
  if (tail) bytes.splice(12, 4, ...tail);
  return bytes;
}

function ipv4Problem([a, b, c, d]: number[]): string | null {
  if (a === 0) return 'an unspecified address (0.0.0.0/8)';
  if (a === 10) return 'a private address (10.0.0.0/8)';
  if (a === 100 && (b & 0xc0) === 64) return b === 100 && c === 100 && d === 200 ? 'a cloud metadata address' : 'a carrier-grade NAT address (100.64.0.0/10)';
  if (a === 127) return 'a loopback address';
  if (a === 169 && b === 254) return c === 169 && d === 254 ? 'a cloud metadata address' : 'a link-local address (169.254.0.0/16)';
  if (a === 172 && (b & 0xf0) === 16) return 'a private address (172.16.0.0/12)';
  if (a === 192 && b === 0 && c === 0) return d === 192 ? 'a cloud metadata address' : 'a protocol-assignment address (192.0.0.0/24)';
  if (a === 192 && b === 0 && c === 2) return 'a documentation address (192.0.2.0/24)';
  if (a === 192 && b === 88 && c === 99) return 'a 6to4 relay address (192.88.99.0/24)';
  if (a === 192 && b === 168) return 'a private address (192.168.0.0/16)';
  if (a === 198 && (b & 0xfe) === 18) return 'a benchmarking address (198.18.0.0/15)';
  if (a === 198 && b === 51 && c === 100) return 'a documentation address (198.51.100.0/24)';
  if (a === 203 && b === 0 && c === 113) return 'a documentation address (203.0.113.0/24)';
  // Azure's platform endpoint sits in public address space
  if (a === 168 && b === 63 && c === 129 && d === 16) return 'a cloud metadata address';
  if (a >= 224 && a <= 239) return 'a multicast address';
  if (a === 255 && b === 255 && c === 255 && d === 255) return 'the broadcast address';
  if (a >= 240) return 'a reserved address (240.0.0.0/4)';
  return null;
}

function ipv6Problem(b: number[]): string | null {
  const zero = (from: number, to: number) => b.slice(from, to).every((byte) => byte === 0);
  const embedded = (from: number, form: string) => {
    const problem = ipv4Problem(b.slice(from, from + 4));
    return problem ? `the ${form} form of ${problem}` : null;
  };
  if (zero(0, 10) && b[10] === 0xff && b[11] === 0xff) return embedded(12, 'IPv4-mapped');
  if (zero(0, 12)) {
    if (zero(12, 16)) return 'the unspecified address';
    if (zero(12, 15) && b[15] === 1) return 'a loopback address';
    return 'an IPv4-compatible address (::/96)';
  }
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) {
    if (zero(4, 12)) return embedded(12, 'NAT64');
    return 'a local-use NAT64 address';
  }
  if ((b[0] & 0xe0) !== 0x20) {
    if ((b[0] & 0xfe) === 0xfc) return b[0] === 0xfd && b[1] === 0x00 && b[2] === 0x0e && b[3] === 0xc2 ? 'a cloud metadata address' : 'a unique local address (fc00::/7)';
    if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return 'a link-local address (fe80::/10)';
    if (b[0] === 0xfe && (b[1] & 0xc0) === 0xc0) return 'a site-local address (fec0::/10)';
    if (b[0] === 0xff) return 'a multicast address';
    return 'not a global unicast address';
  }
  if (b[0] === 0x20 && b[1] === 0x02) return embedded(2, '6to4');
  if (b[0] === 0x20 && b[1] === 0x01) {
    if (b[2] === 0x0d && b[3] === 0xb8) return 'a documentation address (2001:db8::/32)';
    // 2001::/23: Teredo (which hides an IPv4 address), benchmarking, ORCHID and other assignments
    if (b[2] < 0x02) return b[2] === 0 && b[3] === 0 ? 'a Teredo address (2001::/32)' : 'a protocol-assignment address (2001::/23)';
  }
  if (b[0] === 0x3f && b[1] === 0xff && (b[2] & 0xf0) === 0) return 'a documentation address (3fff::/20)';
  return null;
}

/**
 * Why `address` (an IPv4 or IPv6 address as text) must not be connected to, or null when it is a
 * public address. Anything that is not an IP address is a problem too.
 */
export function addressProblem(address: string): string | null {
  const v4 = ipv4Bytes(address);
  if (v4) return ipv4Problem(v4);
  const v6 = ipv6Bytes(address);
  if (v6) return ipv6Problem(v6);
  return 'not an IP address';
}

// ---- errors ----

/**
 * refused: the policy does not allow it (asking again will not help). too-large: the body went over
 * the byte cap. timeout / aborted: the deadline passed, or the caller's signal fired. network:
 * everything else (resolution, connection, TLS, a broken response).
 */
export type SafeFetchFailure = 'refused' | 'too-large' | 'timeout' | 'aborted' | 'network';

export class SafeFetchError extends Error {
  constructor(
    readonly kind: SafeFetchFailure,
    message: string
  ) {
    super(message);
    this.name = 'SafeFetchError';
  }
}

const refuse = (message: string): never => {
  throw new SafeFetchError('refused', message);
};

// ---- the policy ----

export interface ResolvedAddress {
  address: string;
  family: number;
}

/** Every address of a host name. The default asks the system resolver (dns.lookup, all addresses). */
export type Resolver = (hostname: string) => Promise<readonly ResolvedAddress[]>;

export interface NetPolicyOptions {
  /** The world's own origin (worldHttpOrigin in lib/world-url.ts), or null/absent for none. */
  worldOrigin?: string | null;
  resolve?: Resolver;
  /**
   * FOR TESTS; the agent never passes this. Where the connection for a URL's host and port is
   * really made, so a loopback server can stand in for a host on port 443. With only `port`, the
   * connection still goes to the address the lookup hook returns. With `address`, the host's
   * addresses are checked first and then that address is dialled instead: the address checked is
   * then no longer the address dialled.
   */
  dial?: (hostname: string, port: number) => { address?: string; port: number } | undefined;
  /** FOR TESTS. Certificate authorities to trust instead of the runtime's own. */
  ca?: string | Buffer;
}

export interface SafeFetchOptions {
  /** Hard cap on the response body in bytes; the request is destroyed when the body exceeds it. */
  maxBytes: number;
  /** One deadline for the whole exchange, redirects and body included. */
  timeoutMs?: number;
  method?: string;
  /** Sent as given, except the ones this module sets itself (host, connection, lengths, encodings). */
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  signal?: AbortSignal;
  /** false: this request gets no world-origin exception (default true). */
  worldException?: boolean;
  /** false: a redirect is not followed; the 3xx answer itself is returned (default true). */
  followRedirects?: boolean;
}

export interface SafeResponse {
  /** The URL the body came from (the last one, after redirects). */
  url: string;
  status: number;
  statusText: string;
  /** Lower-case names; repeated headers joined with ", ". */
  headers: Record<string, string>;
  body: Uint8Array;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
// Set here, or meaningless on a connection of its own: never taken from a caller
const OWN_HEADERS = new Set(['host', 'connection', 'keep-alive', 'content-length', 'transfer-encoding', 'accept-encoding', 'upgrade', 'te', 'trailer', 'expect', 'proxy-authorization', 'proxy-connection']);
const USER_AGENT = 'Mozilla/5.0 (compatible; hyperfy-agent)';

const systemResolver: Resolver = (hostname) => dns.promises.lookup(hostname, { all: true, order: 'verbatim' });

type LookupCallback = (error: Error | null, address?: string | ResolvedAddress[], family?: number) => void;

interface Target {
  url: URL;
  /** The exception applies: no address, scheme or port check */
  isWorld: boolean;
  /** Host without the brackets of an IPv6 literal */
  hostname: string;
  literal: boolean;
  port: number;
}

interface Exchange {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  /** Absent for a redirect that is going to be followed */
  body?: Uint8Array;
}

export class NetPolicy {
  /** The origin that gets the exception, as URL.origin spells it; null for none. */
  readonly worldOrigin: string | null;
  readonly #resolve: Resolver;
  readonly #dial: NetPolicyOptions['dial'];
  readonly #ca: NetPolicyOptions['ca'];

  constructor({ worldOrigin = null, resolve = systemResolver, dial, ca }: NetPolicyOptions = {}) {
    this.worldOrigin = normalOrigin(worldOrigin);
    this.#resolve = resolve;
    this.#dial = dial;
    this.#ca = ca;
  }

  /** Whether `url` is on the world's own origin (and so gets the exception): see onWorldOrigin. */
  isWorldOrigin(url: string | URL): boolean {
    return onWorldOrigin(url, this.worldOrigin);
  }

  /**
   * Why a request for `url` would be refused before anything is sent, or null. Looks at the URL
   * only: a host name is judged again, by its addresses, when the request is made.
   */
  urlProblem(url: string, { worldException = true }: { worldException?: boolean } = {}): string | null {
    try {
      this.#admit(parseUrl(url), worldException);
      return null;
    } catch (error) {
      if (error instanceof SafeFetchError) return error.message;
      throw error;
    }
  }

  /**
   * Why the voice (LiveKit) server URL the world sends must not be handed to the native client, or
   * null. ws: or wss:, no user name or password. On the world's own host (any scheme and port;
   * loopback spellings count as one host) it is allowed, as the world's own downloads are. Anywhere
   * else: wss: on the default port, on a host whose every address is public. The native client
   * resolves the name again when it connects, and its media (ICE) connections are not checked here.
   */
  async voiceUrlProblem(wsUrl: unknown): Promise<string | null> {
    if (typeof wsUrl !== 'string') return 'the voice server URL is not a string';
    let url: URL;
    try {
      url = new URL(wsUrl);
    } catch {
      return 'the voice server URL is not a valid absolute URL';
    }
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return `${url.protocol}// is not a voice server URL (only ws:// and wss://)`;
    if (url.username !== '' || url.password !== '') return 'the voice server URL carries a user name or password';
    const hostname = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
    if (!hostname) return 'the voice server URL has no host';
    if (this.worldOrigin !== null && sameHost(url.hostname, new URL(this.worldOrigin).hostname)) return null;
    if (url.protocol !== 'wss:') return "ws:// is only allowed on the world's own host (use wss://)";
    if (url.port !== '') return `port ${url.port} is not allowed (only the default port, except on the world's own host)`;
    if (net.isIP(hostname) !== 0) {
      const problem = addressProblem(hostname);
      return problem ? `${hostname} is ${problem}` : null;
    }
    try {
      await this.#addressesOf(hostname, false);
      return null;
    } catch (error) {
      if (error instanceof SafeFetchError) return error.message;
      throw error;
    }
  }

  /**
   * Requests `url` under the policy and returns the whole body. Throws SafeFetchError; an HTTP
   * error status is not an error here (check `status`).
   */
  async fetch(input: string, options: SafeFetchOptions): Promise<SafeResponse> {
    const { maxBytes, timeoutMs = DEFAULT_TIMEOUT_MS, worldException = true, followRedirects = true } = options;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new TypeError('safeFetch: maxBytes must be a non-negative integer');
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('safeFetch: timeoutMs must be a positive number');
    let url = parseUrl(input);
    let method = (options.method ?? 'GET').toUpperCase();
    if (!/^[A-Z]+$/.test(method)) refuse('invalid request method');
    let body = typeof options.body === 'string' ? new TextEncoder().encode(options.body) : options.body;
    const headers = callerHeaders(options.headers);

    // One deadline and the caller's signal, for every hop and the body
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(new SafeFetchError('timeout', `no complete response within ${timeoutMs} ms`)), timeoutMs);
    const onCallerAbort = () => stop.abort(new SafeFetchError('aborted', 'the request was cancelled'));
    if (options.signal?.aborted) onCallerAbort();
    else options.signal?.addEventListener('abort', onCallerAbort, { once: true });

    try {
      for (let hop = 0; ; hop++) {
        const target = this.#admit(url, worldException);
        const answer = await this.#exchange(target, method, headers, body, maxBytes, followRedirects, stop.signal);
        if (answer.body) return { url: url.href, status: answer.status, statusText: answer.statusText, headers: answer.headers, body: answer.body };

        if (hop >= MAX_REDIRECTS) refuse(`more than ${MAX_REDIRECTS} redirects`);
        let next: URL;
        try {
          next = new URL(answer.headers.location, url);
        } catch {
          throw new SafeFetchError('network', 'the server redirected to an invalid URL');
        }
        // RFC 9110 15.4: 303 means "GET this instead" for any method but GET and HEAD, which stay as they are
        if ((answer.status === 303 && method !== 'GET' && method !== 'HEAD') || ((answer.status === 301 || answer.status === 302) && method === 'POST')) {
          method = 'GET';
          body = undefined;
          delete headers['content-type'];
        }
        // A caller's credentials are for the host it named
        if (next.origin !== url.origin) delete headers.authorization;
        url = next;
      }
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onCallerAbort);
    }
  }

  /** The checks that need only the URL. A host name passes here and is judged in #addressesOf. */
  #admit(url: URL, worldException: boolean): Target {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') refuse(`${url.protocol}// URLs are not fetched`);
    if (url.username !== '' || url.password !== '') refuse('URLs that carry a user name or password are not fetched');
    const isWorld = worldException && onWorldOrigin(url, this.worldOrigin);
    if (!isWorld) {
      if (url.protocol !== 'https:') refuse("http:// is only allowed on the world's own origin (use https://)");
      if (url.port !== '') refuse(`port ${url.port} is not allowed (only the default port, except on the world's own origin)`);
    }
    const hostname = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
    if (!hostname) refuse('the URL has no host');
    const literal = net.isIP(hostname) !== 0;
    if (literal && !isWorld) {
      const problem = addressProblem(hostname);
      if (problem) refuse(`${hostname} is ${problem}`);
    }
    return { url, isWorld, hostname, literal, port: url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80 };
  }

  /** Every address of a host name, all of them allowed for this target. */
  async #addressesOf(hostname: string, isWorld: boolean): Promise<ResolvedAddress[]> {
    let answers: readonly ResolvedAddress[];
    try {
      answers = await this.#resolve(hostname);
    } catch (error) {
      throw new SafeFetchError('network', `could not resolve ${hostname} (${errorCode(error)})`);
    }
    const addresses = answers.map(({ address, family }) => ({ address: String(address), family: family === 6 ? 6 : 4 }));
    if (addresses.length === 0) throw new SafeFetchError('network', `could not resolve ${hostname} (no address)`);
    for (const { address } of addresses) {
      if (net.isIP(address) === 0) throw new SafeFetchError('network', `the resolver answered ${hostname} with something that is not an address`);
      if (isWorld) continue;
      const problem = addressProblem(address);
      if (problem) refuse(`${hostname} resolves to ${address}, which is ${problem}`);
    }
    return addresses;
  }

  /** One request and its answer: the body, or (for a redirect to follow) the headers only. */
  async #exchange(target: Target, method: string, headers: Record<string, string>, body: Uint8Array | undefined, maxBytes: number, follow: boolean, signal: AbortSignal): Promise<Exchange> {
    const { url, hostname, isWorld } = target;
    const secure = url.protocol === 'https:';
    const dialled = this.#dial?.(hostname, target.port);
    // Handed an address (tests), the runtime never asks `lookup`: judge the name here instead
    if (dialled?.address && !target.literal) await this.#addressesOf(hostname, isWorld);
    if (signal.aborted) throw signal.reason;

    return new Promise<Exchange>((resolve, reject) => {
      let settled = false;
      // What `lookup` refused. The runtime reports it as the request's error; kept here so the
      // reason survives whatever the runtime wraps it in.
      let refusal: SafeFetchError | undefined;
      const lookup: net.LookupFunction = (name, options, callback) => {
        // (hostname, callback) is the other documented form
        const done = (typeof options === 'function' ? options : callback) as LookupCallback;
        const { all = false, family = 0 } = typeof options === 'function' ? {} : options;
        const wanted = family === 4 || family === 'IPv4' ? 4 : family === 6 || family === 'IPv6' ? 6 : 0;
        this.#addressesOf(name, isWorld).then(
          (addresses) => {
            const usable = wanted ? addresses.filter((entry) => entry.family === wanted) : addresses;
            if (usable.length === 0) return done(Object.assign(new Error(`no IPv${wanted} address for ${name}`), { code: 'ENOTFOUND' }));
            if (all) done(null, usable);
            else done(null, usable[0].address, usable[0].family);
          },
          (error: Error) => {
            if (error instanceof SafeFetchError) refusal = error;
            done(error);
          }
        );
      };

      const request = (secure ? https : http).request({
        protocol: url.protocol,
        host: dialled?.address ?? hostname,
        port: dialled?.port ?? target.port,
        path: `${url.pathname}${url.search}`,
        method,
        headers: {
          'user-agent': USER_AGENT,
          ...headers,
          host: url.host,
          // The byte cap is on what is received; nothing here inflates a compressed body
          'accept-encoding': 'identity',
          ...(body ? { 'content-length': String(body.byteLength) } : {}),
        },
        // A connection of its own: a pooled one is reused without `lookup` being called
        agent: false,
        lookup,
        // The certificate is checked against the URL's host name, whatever address is dialled
        ...(secure && !target.literal ? { servername: hostname } : {}),
        ...(secure && this.#ca ? { ca: this.#ca } : {}),
      });

      const finish = (error: unknown, answer?: Exchange) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        if (answer) resolve(answer);
        else {
          request.destroy();
          reject(error);
        }
      };
      const fail = (error: unknown) => finish(signal.aborted ? signal.reason : (refusal ?? (error instanceof SafeFetchError ? error : new SafeFetchError('network', `the request failed (${errorCode(error)})`))));
      const onAbort = () => fail(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });

      request.on('error', fail);
      request.on('response', (response: IncomingMessage) => {
        const status = response.statusCode ?? 0;
        const answer: Exchange = { status, statusText: response.statusMessage ?? '', headers: plainHeaders(response) };
        if (follow && REDIRECTS.has(status) && answer.headers.location !== undefined) {
          // The redirect's own body is of no use
          finish(null, answer);
          request.destroy();
          return;
        }
        const encoding = (answer.headers['content-encoding'] ?? 'identity').trim().toLowerCase();
        if (encoding !== 'identity' && encoding !== '') return fail(new SafeFetchError('network', `the server sent a ${encoding}-encoded body although none was asked for`));
        const declared = Number(answer.headers['content-length']);
        if (method !== 'HEAD' && Number.isFinite(declared) && declared > maxBytes) return fail(tooLarge(maxBytes));

        const chunks: Buffer[] = [];
        let received = 0;
        response.on('data', (chunk: Buffer) => {
          received += chunk.byteLength;
          if (received > maxBytes) return fail(tooLarge(maxBytes));
          chunks.push(chunk);
        });
        response.on('error', fail);
        response.on('end', () => finish(null, { ...answer, body: new Uint8Array(Buffer.concat(chunks)) }));
        // The connection went away before the body was complete
        response.on('close', () => fail(new SafeFetchError('network', 'the connection closed before the response was complete')));
      });
      request.end(body);
    });
  }
}

const tooLarge = (maxBytes: number) => new SafeFetchError('too-large', `the response is larger than ${maxBytes} bytes`);

function errorCode(error: unknown): string {
  const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
  return typeof code === 'string' && code ? code : typeof message === 'string' && message ? message : 'unknown error';
}

function parseUrl(input: string): URL {
  if (typeof input !== 'string') return refuse('the URL must be a string');
  try {
    return new URL(input);
  } catch {
    return refuse('not a valid absolute URL');
  }
}

/** localhost, 127.0.0.0/8 or ::1, as URL.hostname spells a host */
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname;
  if (host === 'localhost') return true;
  const v4 = ipv4Bytes(host);
  if (v4) return v4[0] === 127;
  const v6 = ipv6Bytes(host);
  return v6 !== null && v6.slice(0, 15).every((byte) => byte === 0) && v6[15] === 1;
}

/** Two host names for the same host: equal, or both a spelling of loopback. */
function sameHost(a: string, b: string): boolean {
  return a === b || (isLoopbackHost(a) && isLoopbackHost(b));
}

/**
 * Whether `url` is on `worldOrigin` (as URL.origin spells it). A loopback world (localhost,
 * 127.0.0.0/8, [::1]) also owns the same scheme and port on the other loopback spellings: a world
 * reached as 127.0.0.1 often names its assets on localhost. No other host gets this.
 */
export function onWorldOrigin(url: string | URL, worldOrigin: string | null): boolean {
  if (worldOrigin === null) return false;
  try {
    const target = new URL(url);
    if (target.origin === worldOrigin) return true;
    const world = new URL(worldOrigin);
    return target.protocol === world.protocol && target.port === world.port && isLoopbackHost(world.hostname) && isLoopbackHost(target.hostname);
  } catch {
    return false;
  }
}

function normalOrigin(origin: string | null | undefined): string | null {
  if (!origin) return null;
  try {
    const url = new URL(origin);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
// No control characters: a header value can never start a new line
const HEADER_VALUE = /^[\t\x20-\x7e\x80-\xff]*$/;

function callerHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    const key = name.toLowerCase();
    if (OWN_HEADERS.has(key) || !HEADER_NAME.test(name) || typeof value !== 'string' || !HEADER_VALUE.test(value)) continue;
    out[key] = value;
  }
  return out;
}

function plainHeaders(response: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(response.headers)) {
    if (value !== undefined) out[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}

/** The policy with no world: public https hosts only. */
export const publicNet = new NetPolicy();

/** NetPolicy.fetch for callers that have no world: public https hosts only. */
export function safeFetch(url: string, options: SafeFetchOptions): Promise<SafeResponse> {
  return publicNet.fetch(url, options);
}

/** A SafeResponse as a standard Response, for code written against fetch(). */
export function toResponse(answer: SafeResponse): Response {
  // 204, 205 and 304 cannot carry a body, and Response refuses one
  const empty = answer.status === 204 || answer.status === 205 || answer.status === 304 || answer.body.byteLength === 0;
  return new Response(empty ? null : new Uint8Array(answer.body), { status: answer.status, statusText: answer.statusText, headers: answer.headers });
}

// ---- one policy per world ----

const worldPolicies = new WeakMap<object, NetPolicy>();

/** Gives `world` its policy (the exception is for `worldOrigin`). Call when the world is created. */
export function installWorldNet(world: object, policy: NetPolicy): NetPolicy {
  worldPolicies.set(world, policy);
  return policy;
}

/** The policy of `world`. A world that was given none gets the one with no exception. */
export function worldNet(world: unknown): NetPolicy {
  return (world !== null && typeof world === 'object' ? worldPolicies.get(world) : undefined) ?? publicNet;
}
