/**
 * The network behind a world script's fetch(): lib/net-policy.ts with the narrowest settings.
 *
 *   - public https hosts on the default port only, judged per request and per redirect. No
 *     world-origin exception: a script has no business with whatever else the world's host serves,
 *     and its own world's assets reach it through world.load().
 *   - GET, HEAD and POST; a small set of request headers and the script's own `x-…` ones (not
 *     x-forwarded-…, x-real-ip, x-client-ip); small bodies both ways; a short deadline; a few
 *     requests at a time per world.
 *   - nothing of the agent's is attached: no cookies, no credentials, and Host is always the URL's.
 *
 * What remains: a script can send whatever it can read (player names, ids and positions, what it
 * hears in app events) to any public https host, and read the answers. A request the policy
 * refuses, or that fails on the way, reaches the script as "fetch failed" whatever the reason, so
 * the message does not tell it what a name resolves to; how long the failure took is not hidden.
 * (A request refused here for its method, body, size or count says which.)
 */
import { type NetPolicy, SafeFetchError, publicNet } from './net-policy';
import type { ConsoleTarget, ScriptNetwork } from './script-facades';

export const SCRIPT_FETCH_MAX_RESPONSE_BYTES = 1024 * 1024;
export const SCRIPT_FETCH_MAX_REQUEST_BYTES = 256 * 1024;
export const SCRIPT_FETCH_TIMEOUT_MS = 10_000;
export const SCRIPT_FETCH_MAX_IN_FLIGHT = 4;

const METHODS = new Set(['GET', 'HEAD', 'POST']);
// What a script may send besides the method, URL and body. `authorization` and `x-…` are the
// script's own values for the API it calls (the agent has none to add).
const HEADERS = new Set(['accept', 'accept-language', 'authorization', 'content-type', 'if-modified-since', 'if-none-match']);
const FORWARDING = /^x-(forwarded-|real-ip$|client-ip$)/;

function forwardable(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (HEADERS.has(key) || (key.startsWith('x-') && !FORWARDING.test(key))) out[key] = value;
  }
  return out;
}

export function createScriptNetwork({ policy = publicNet, log = console }: { policy?: NetPolicy; log?: ConsoleTarget } = {}): ScriptNetwork {
  let inFlight = 0;
  return async (url, request, signal) => {
    const method = request.method.toUpperCase();
    if (!METHODS.has(method)) throw new TypeError('fetch: only GET, HEAD and POST are available to world scripts');
    const body = typeof request.body === 'string' ? new TextEncoder().encode(request.body) : request.body;
    if (body && method !== 'POST') throw new TypeError('fetch: only a POST request can have a body');
    if (body && body.byteLength > SCRIPT_FETCH_MAX_REQUEST_BYTES) throw new TypeError('fetch: the request body is too large');
    if (inFlight >= SCRIPT_FETCH_MAX_IN_FLIGHT) throw new TypeError('fetch: too many requests at once');
    inFlight++;
    try {
      const answer = await policy.fetch(url, {
        method,
        headers: forwardable(request.headers),
        body,
        maxBytes: SCRIPT_FETCH_MAX_RESPONSE_BYTES,
        timeoutMs: SCRIPT_FETCH_TIMEOUT_MS,
        signal,
        worldException: false,
      });
      return { status: answer.status, statusText: answer.statusText, headers: answer.headers, body: answer.body };
    } catch (error) {
      // The reason stays on the host's console. An app that was rebuilt or removed is not news.
      if (!(error instanceof SafeFetchError && error.kind === 'aborted')) {
        log.warn(`[script] fetch() failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      throw new TypeError('fetch failed');
    } finally {
      inFlight--;
    }
  };
}
