/**
 * The console, fetch and setTimeout handed to world app scripts. These are host functions: they
 * are given to a script only through the membrane (lib/script-membrane.ts), so their arguments
 * arrive here as copies and what they return is converted again on the way out.
 */

import { inspect } from 'node:util';

// ---- console ----

// One bounded line per call. Arguments are copies with string keys only, so no custom-inspect
// hook of a script can be among them; customInspect is switched off regardless.
const INSPECT_OPTIONS = { customInspect: false, depth: 4, breakLength: Infinity, compact: true } as const;
const MAX_LOG_CHARS = 2000;

function render(value: unknown): string {
  let text: string;
  try {
    text = typeof value === 'string' ? value : inspect(value, INSPECT_OPTIONS);
  } catch {
    text = '[unprintable value]';
  }
  return text;
}

function line(args: unknown[]): string {
  const text = args.map(render).join(' ');
  return text.length > MAX_LOG_CHARS ? `${text.slice(0, MAX_LOG_CHARS)}… (${text.length - MAX_LOG_CHARS} more characters)` : text;
}

export type ConsoleTarget = Pick<Console, 'log' | 'warn' | 'error'>;

/**
 * A console whose every call reaches the host console as one string. Bun's console formats an
 * object by calling its Symbol.for('nodejs.util.inspect.custom') method with the host's own
 * inspect function and options, so the host console never sees a script's object.
 */
export function createScriptConsole(target: ConsoleTarget = console) {
  const timers = new Map<string, number>();
  const label = (value: unknown) => line([value ?? 'default']).slice(0, 100);
  return Object.freeze({
    log: (...args: unknown[]) => target.log(`[script] ${line(args)}`),
    warn: (...args: unknown[]) => target.warn(`[script] ${line(args)}`),
    error: (...args: unknown[]) => target.error(`[script] ${line(args)}`),
    time: (name?: unknown) => {
      // Bounded: a script cannot grow this without limit
      if (timers.size < 100) timers.set(label(name), performance.now());
    },
    timeEnd: (name?: unknown) => {
      const key = label(name);
      const started = timers.get(key);
      if (started === undefined) return;
      timers.delete(key);
      target.log(`[script] ${key}: ${(performance.now() - started).toFixed(3)}ms`);
    },
  });
}

// ---- fetch ----

/** What a script may put in a request: plain strings and bytes, nothing else */
export interface ScriptRequest {
  method: string;
  headers: Record<string, string>;
  body?: string | Uint8Array;
}

/** What the network layer hands back: status, string headers and the whole body, already read */
export interface ScriptResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: Uint8Array;
}

/**
 * THE SEAM FOR THE NETWORK POLICY (plan D3, phase P1b). Scripts have no network access until a
 * function of this type is passed to createWorldScripts(): it must apply the outbound policy
 * itself (address classes, redirects, byte cap, deadline) and return only what ScriptResponse
 * holds. `signal` aborts when the app that made the request is rebuilt or removed.
 */
export type ScriptNetwork = (url: string, request: ScriptRequest, signal: AbortSignal) => Promise<ScriptResponse>;

const blobs = new WeakMap<object, { bytes: Uint8Array; type: string }>();

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const copyOf = (bytes: Uint8Array) => bytes.slice().buffer;

// Blob.slice() index rules: negative values count from the end, everything is clamped to the size
function clampIndex(value: unknown, size: number, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Math.trunc(Number(value)) || 0;
  return n < 0 ? Math.max(size + n, 0) : Math.min(n, size);
}

/**
 * What a script gets instead of a Blob: the bytes stay in a module-private WeakMap, the object
 * itself is frozen and holds only values and functions made here. No host Blob, Response or
 * stream object exists for a script to reach.
 */
function createBlob(bytes: Uint8Array, type: string): object {
  const size = bytes.byteLength;
  const blob = Object.freeze({
    size,
    type,
    arrayBuffer: async () => copyOf(bytes),
    text: async () => text(bytes),
    // A script cannot choose the type of a slice; it keeps the type the response had
    slice: (start?: unknown, end?: unknown) => {
      const from = clampIndex(start, size, 0);
      const to = Math.max(clampIndex(end, size, size), from);
      return createBlob(bytes.slice(from, to), type);
    },
  });
  blobs.set(blob, { bytes, type });
  return blob;
}

/** The bytes behind a blob made by createBlob, or undefined for anything else */
export function scriptBlobBytes(value: unknown): Uint8Array | undefined {
  return value !== null && typeof value === 'object' ? blobs.get(value)?.bytes : undefined;
}

function toRequest(options: unknown): ScriptRequest {
  const request: ScriptRequest = { method: 'GET', headers: {} };
  if (!options || typeof options !== 'object') return request;
  const { method, headers, body } = options as Record<string, unknown>;
  if (typeof method === 'string') request.method = method.toUpperCase();
  if (headers && typeof headers === 'object') {
    for (const [name, value] of Object.entries(headers)) {
      if (typeof value === 'string') request.headers[name] = value;
    }
  }
  if (typeof body === 'string') request.body = body;
  else if (body instanceof ArrayBuffer) request.body = new Uint8Array(body);
  else if (ArrayBuffer.isView(body)) request.body = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  else {
    const bytes = scriptBlobBytes(body);
    if (bytes) request.body = bytes;
  }
  return request;
}

/**
 * The fetch argument of a script. Without a network function every call rejects, and says why on
 * the script's console once per app run.
 */
export function createScriptFetch(network: ScriptNetwork | null, signal: AbortSignal, log: ConsoleTarget = console) {
  let told = false;
  return async (url: unknown, options?: unknown): Promise<object> => {
    if (!network) {
      if (!told) {
        told = true;
        log.warn('[script] fetch() is not available: world scripts have no network access in this agent');
      }
      throw new TypeError('fetch is not available to world scripts in this agent');
    }
    if (typeof url !== 'string') throw new TypeError('fetch: the URL must be a string');
    const response = await network(url, toRequest(options), signal);
    const status = Number(response.status) || 0;
    const body = response.body instanceof Uint8Array ? response.body : new Uint8Array();
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(response.headers ?? {})) {
      if (typeof value === 'string') headers[name.toLowerCase()] = value;
    }
    const type = headers['content-type'] ?? '';
    return Object.freeze({
      ok: status >= 200 && status < 300,
      status,
      statusText: String(response.statusText ?? ''),
      headers: Object.freeze(headers),
      json: async () => JSON.parse(text(body)) as unknown,
      text: async () => text(body),
      blob: async () => createBlob(body, type),
      arrayBuffer: async () => copyOf(body),
    });
  };
}

// ---- timers ----

const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/**
 * The setTimeout argument of a script. `engineSetTimeout` is the app's own (entities/App.js): it
 * drops the callback once the app has been rebuilt or removed, and returns the runtime's timer
 * object, which stays here. The script gets a number.
 */
export function createScriptSetTimeout(engineSetTimeout: (fn: () => void, ms: number) => unknown, log: ConsoleTarget = console) {
  let ids = 0;
  return (fn: unknown, ms?: unknown): number => {
    if (typeof fn !== 'function') throw new TypeError('setTimeout: the callback must be a function');
    const delay = Math.min(Math.max(Number(ms) || 0, 0), MAX_TIMEOUT_MS);
    engineSetTimeout(() => {
      try {
        (fn as () => void)();
      } catch (err) {
        // A timer callback has no caller to throw to; the error is already a host-safe copy
        log.error(`[script] error in a setTimeout callback: ${err instanceof Error ? err.message : String(err)}`);
      }
    }, delay);
    return ++ids;
  };
}
