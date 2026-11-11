/**
 * The process's error events (`unhandledRejection`, `rejectionHandled`, `uncaughtException`,
 * `uncaughtExceptionMonitor`, `multipleResolves`) never hand a listener a value a world script
 * made.
 *
 * Every promise in the process uses the same intrinsics, so a promise a script rejects and never
 * handles is reported to the process like any other, with the script's own reason and promise.
 * A listener that prints the reason (elizaOS's Sentry integration calls console.error with it)
 * would run the script's custom-inspect hook with the runtime's own `inspect` and its options.
 * Once the guard is installed, a listener gets an Error made here from the original's name,
 * message, stack and code strings, and a promise made here, instead of the originals:
 *
 * - Node delivers these events through `process.emit`, and the guard replaces it: every listener
 *   is covered, however and whenever it was registered. Registration is left to Node.
 * - Bun calls the stored listeners itself. The guard wraps every listener of these events that is
 *   there when it is installed, and every one registered later through the process's methods
 *   (also when they are called from the process's prototype). Once listeners stay one-shot, and
 *   listeners(), rawListeners() (in Node's shape: a once listener as a function whose `listener`
 *   is the one registered), listenerCount() and removeListener()/off() work with the functions
 *   registered. Bun's rawListeners() does not tell a once listener apart, so one registered before
 *   the guard is installed becomes an ordinary listener; the agent installs the guard as soon as
 *   its code loads when world scripts are sandboxed (src/index.ts), before elizaOS's server and
 *   the plugins register theirs.
 * - A callback set through process.setUncaughtExceptionCaptureCallback() gets the same Error.
 *
 * Fails closed: at each of these events, if anything the guard does not cover is there to get the
 * arguments (on Bun a listener registered through a method reference taken before the guard was
 * installed; on both, an uncaught-exception capture callback the guard did not set), the guard
 * logs one line and ends the process before it hands the event on. A script cannot cause that
 * without such a listener or callback being there, and only the host can register one.
 *
 * The check runs in the guard's own wrappers. On Bun the guard therefore keeps a listener of its
 * own on rejectionHandled, uncaughtExceptionMonitor and multipleResolves (left out of listeners(),
 * rawListeners() and listenerCount()), so these are checked even when nobody else listens. An
 * uncaught exception reaches uncaughtExceptionMonitor before uncaughtException, so that one is
 * checked there; the agent has its own listener on unhandledRejection.
 *
 * Not covered:
 * - on Bun, such a listener that is called before any listener the guard wrapped has run since it
 *   was registered (it was prepended, for instance): it gets that event's arguments once, then the
 *   process ends;
 * - on Bun, such a listener on an event whose listeners were all removed with removeAllListeners(),
 *   the guard's own included: nothing runs the check for that event any more;
 * - on Node, a function that replaces process.emit after the guard: it gets the arguments before
 *   the guard does;
 * - a capture callback that replaces one set through the guard, by a reference to the setter taken
 *   before the guard was installed (node:domain takes one when it loads);
 * - code that calls listeners itself with values of its own.
 */

type Listener = (...args: any[]) => unknown;
type Method = (this: unknown, ...args: any[]) => unknown;

export const ERROR_EVENTS = ['unhandledRejection', 'rejectionHandled', 'uncaughtException', 'uncaughtExceptionMonitor', 'multipleResolves'] as const;
type ErrorEvent = (typeof ERROR_EVENTS)[number];

/** Where the runtime calls the stored listeners itself, the guard keeps a listener of its own on these */
const SENTINEL_EVENTS = ['rejectionHandled', 'uncaughtExceptionMonitor', 'multipleResolves'] as const;

const isErrorEvent = (event: unknown): event is ErrorEvent => typeof event === 'string' && (ERROR_EVENTS as readonly string[]).includes(event);

/** The part of EventEmitter (the process) this module uses */
export interface ErrorEventTarget {
  on(event: string, listener: Listener): unknown;
  addListener(event: string, listener: Listener): unknown;
  prependListener(event: string, listener: Listener): unknown;
  once(event: string, listener: Listener): unknown;
  prependOnceListener(event: string, listener: Listener): unknown;
  removeListener(event: string, listener: Listener): unknown;
  off?(event: string, listener: Listener): unknown;
  emit(event: string, ...args: unknown[]): boolean;
  listeners(event: string): Function[];
  rawListeners(event: string): Function[];
  listenerCount(event: string, listener?: Function): number;
  removeAllListeners(event?: string): unknown;
  setUncaughtExceptionCaptureCallback?: (callback: ((error: unknown) => void) | null) => void;
  hasUncaughtExceptionCaptureCallback?: () => boolean;
}

function readText(value: unknown, key: string): string | null {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return null;
  try {
    const text = (value as Record<string, unknown>)[key];
    return typeof text === 'string' ? text : null;
  } catch {
    return null;
  }
}

function readCode(value: unknown): string | number | undefined {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return undefined;
  try {
    const code = (value as Record<string, unknown>).code;
    return typeof code === 'string' || typeof code === 'number' ? code : undefined;
  } catch {
    return undefined;
  }
}

const isPrimitive = (value: unknown): boolean => value === null || (typeof value !== 'object' && typeof value !== 'function');

/** A reason or error as text, built from its name, message and stack strings and nothing else */
export function describeRejection(reason: unknown): string {
  if (isPrimitive(reason)) return String(reason);
  const stack = readText(reason, 'stack');
  if (stack) return stack;
  const message = readText(reason, 'message');
  return message === null ? 'a value that is not an error' : `${readText(reason, 'name') ?? 'Error'}: ${message}`;
}

/**
 * An Error made here that stands for `value`: its name, message, stack and code when they are
 * strings (or a number for code), nothing else. Reading them may run a script's getters; they are
 * handed nothing of the host, and what they return is used only if it is a string.
 */
export function errorEventValue(value: unknown): Error {
  const name = readText(value, 'name');
  const message =
    readText(value, 'message') ?? (isPrimitive(value) ? String(value) : typeof value === 'function' ? 'a function' : 'a value that is not an error');
  const stack = readText(value, 'stack');
  const code = readCode(value);
  const error = new Error(message);
  if (name !== null && name !== 'Error') Object.defineProperty(error, 'name', { value: name, writable: true, configurable: true });
  Object.defineProperty(error, 'stack', { value: stack ?? `${name ?? 'Error'}: ${message}`, writable: true, configurable: true });
  if (code !== undefined) Object.defineProperty(error, 'code', { value: code, writable: true, configurable: true, enumerable: true });
  return error;
}

/** A promise made here that is rejected with `error` and already handled, so it reports nothing itself */
function handledRejection(error: Error): Promise<never> {
  const promise = Promise.reject(error);
  promise.catch(() => {});
  return promise;
}

function sanitizeArgs(event: ErrorEvent, args: unknown[]): unknown[] {
  switch (event) {
    case 'unhandledRejection': {
      const error = errorEventValue(args[0]);
      return [error, handledRejection(error)];
    }
    case 'rejectionHandled':
      return [handledRejection(new Error('a promise rejection was handled late'))];
    case 'multipleResolves':
      // (type, promise, value): a value that is not an object stays as it is
      return [args[0] === 'reject' ? 'reject' : 'resolve', Promise.resolve(), isPrimitive(args[2]) ? args[2] : errorEventValue(args[2])];
    default:
      return [errorEventValue(args[0]), typeof args[1] === 'string' ? args[1] : 'uncaughtException'];
  }
}

export interface ErrorEventGuard {
  /** How the runtime delivers the events, and so what the guard replaces (see the header) */
  readonly delivery: 'emit' | 'listeners';
  /** Whether nothing the guard does not cover would get an error event's arguments */
  coversAllListeners(): boolean;
  /**
   * While `reason` is set, an unhandled rejection whose original reason is exactly `reason` goes
   * to `listener` only (the self-test uses this so its probe reaches no other listener).
   */
  deliverOnlyTo(reason: object | null, listener?: Listener): void;
}

export interface ErrorEventGuardOptions {
  /** Default: 'listeners' under Bun, 'emit' otherwise (see the header) */
  delivery?: 'emit' | 'listeners';
  log?: Pick<Console, 'error'>;
  /** Ends the process when the guard fails closed (default process.exit) */
  exit?: (code: number) => void;
}

const guards = new WeakMap<object, ErrorEventGuard>();

const REGISTERING = ['on', 'addListener', 'prependListener', 'once', 'prependOnceListener'] as const;
const LISTING = ['removeListener', 'off', 'listeners', 'rawListeners', 'listenerCount'] as const;

function define(target: object, name: string, value: unknown): void {
  Object.defineProperty(target, name, { value, writable: true, configurable: true });
}

/** The object on `start`'s prototype chain that has `name` as an own property */
function ownerOf(start: object | null, name: string): object | null {
  for (let current = start; current; current = Object.getPrototypeOf(current) as object | null) {
    if (Object.prototype.hasOwnProperty.call(current, name)) return current;
  }
  return null;
}

/** Installs the guard on `target` (the process). Idempotent per target: a second call returns the first guard. */
export function guardErrorEvents(target: ErrorEventTarget = process as unknown as ErrorEventTarget, options: ErrorEventGuardOptions = {}): ErrorEventGuard {
  const existing = guards.get(target);
  if (existing) return existing;
  const delivery = options.delivery ?? ('Bun' in globalThis ? 'listeners' : 'emit');
  const log = options.log ?? console;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  let only: { reason: object; listener: Listener } | null = null;
  const isProbe = (event: ErrorEvent, args: unknown[]): boolean => only !== null && event === 'unhandledRejection' && args[0] === only.reason;

  // ---- the capture callback ----
  let captureIsGuards = false;
  if (typeof target.setUncaughtExceptionCaptureCallback === 'function') {
    const setCapture = target.setUncaughtExceptionCaptureCallback;
    define(target, 'setUncaughtExceptionCaptureCallback', function (this: unknown, callback: ((error: unknown) => void) | null) {
      const wrapped = typeof callback === 'function' ? (error: unknown) => callback(errorEventValue(error)) : callback;
      const result = Reflect.apply(setCapture, this, [wrapped]);
      captureIsGuards = typeof callback === 'function';
      return result;
    });
  }
  const hasCapture = target.hasUncaughtExceptionCaptureCallback;
  const captureUncovered = (): boolean => typeof hasCapture === 'function' && Reflect.apply(hasCapture, target, []) === true && !captureIsGuards;

  let listenersUncovered: () => ErrorEvent | null = () => null;
  const uncovered = (): string | null => {
    const event = listenersUncovered();
    if (event) return `a process ${event} listener`;
    return captureUncovered() ? 'the uncaught-exception capture callback' : null;
  };
  let failed = false;
  /** Logs once and ends the process when something uncovered is there; true if it did (and exit returned) */
  const failClosed = (): boolean => {
    const what = uncovered();
    if (!what) return false;
    if (!failed) {
      failed = true;
      log.error(`[Hyperfy] World scripts: ${what} is registered past the error-event guard (lib/error-events.ts) and would get a world script's values. Exiting.`);
    }
    exit(1);
    return true;
  };

  if (delivery === 'emit') {
    const nativeEmit = target.emit as Method;
    define(target, 'emit', function (this: unknown, event: unknown, ...args: unknown[]) {
      if (!isErrorEvent(event)) return Reflect.apply(nativeEmit, this, [event, ...args]);
      const safe = sanitizeArgs(event, args);
      if (isProbe(event, args)) {
        Reflect.apply(only!.listener, this, safe);
        return true;
      }
      if (failClosed()) return true;
      return Reflect.apply(nativeEmit, this, [event, ...safe]);
    });
  } else {
    // The runtime's own methods, before any is replaced
    const native = Object.fromEntries([...REGISTERING, ...LISTING].map((name) => [name, target[name] as Method | undefined])) as Record<
      (typeof REGISTERING)[number] | (typeof LISTING)[number],
      Method | undefined
    >;
    const removeAll = target.removeAllListeners as Method;
    const stored = (event: ErrorEvent) => Reflect.apply(native.rawListeners!, target, [event]) as Function[];
    // Each wrapper this guard registered: the function registered, and whether it is a once listener
    const registrations = new WeakMap<Function, { listener: Listener; once: boolean; fired: boolean }>();

    const wrap = (event: ErrorEvent, listener: Listener, once: boolean): Listener => {
      const registration = { listener, once, fired: false };
      const wrapper = function (this: unknown, ...args: unknown[]) {
        const probe = isProbe(event, args);
        if (probe && listener !== only!.listener) return undefined;
        if (!probe && failClosed()) return undefined;
        if (registration.once) {
          if (registration.fired) return undefined;
          registration.fired = true;
          Reflect.apply(native.removeListener!, target, [event, wrapper]);
        }
        return Reflect.apply(listener, this, sanitizeArgs(event, args));
      };
      if (once) define(wrapper, 'listener', listener);
      registrations.set(wrapper, registration);
      return wrapper;
    };
    const registered = (entry: Function, listener: unknown) => entry === listener || registrations.get(entry)?.listener === listener;

    const replacements: Record<string, Method> = {};
    for (const name of REGISTERING) {
      const once = name === 'once' || name === 'prependOnceListener';
      const add = name === 'prependListener' || name === 'prependOnceListener' ? native.prependListener! : native.on!;
      replacements[name] = function (this: unknown, event: unknown, listener: unknown) {
        if (this !== target || !isErrorEvent(event) || typeof listener !== 'function') return Reflect.apply(native[name]!, this, [event, listener]);
        Reflect.apply(add, target, [event, wrap(event, listener as Listener, once)]);
        return this;
      };
    }
    const remove = function (this: unknown, event: unknown, listener: unknown) {
      if (this !== target || !isErrorEvent(event) || typeof listener !== 'function') return Reflect.apply(native.removeListener!, this, [event, listener]);
      // The most recently registered entry for it, as EventEmitter does
      const entries = stored(event);
      for (let i = entries.length - 1; i >= 0; i--) {
        if (registered(entries[i], listener)) {
          Reflect.apply(native.removeListener!, target, [event, entries[i]]);
          break;
        }
      }
      return this;
    };
    replacements.removeListener = remove;
    replacements.off = remove;
    // The guard's own listeners (see below) are not the host's: listing and counting leave them out
    const sentinels = new WeakSet<Function>();
    const hosts = (event: ErrorEvent) => stored(event).filter((entry) => !sentinels.has(entry));
    replacements.listeners = function (this: unknown, event: unknown) {
      if (this !== target || !isErrorEvent(event)) return Reflect.apply(native.listeners!, this, [event]);
      return hosts(event).map((entry) => registrations.get(entry)?.listener ?? entry);
    };
    replacements.rawListeners = function (this: unknown, event: unknown) {
      if (this !== target || !isErrorEvent(event)) return Reflect.apply(native.rawListeners!, this, [event]);
      return hosts(event).map((entry) => {
        const registration = registrations.get(entry);
        return !registration || registration.once ? entry : registration.listener;
      });
    };
    replacements.listenerCount = function (this: unknown, event: unknown, listener?: unknown) {
      if (this !== target || !isErrorEvent(event)) {
        return Reflect.apply(native.listenerCount!, this, listener === undefined ? [event] : [event, listener]);
      }
      const entries = hosts(event);
      return listener === undefined ? entries.length : entries.filter((entry) => registered(entry, listener)).length;
    };

    for (const [name, replacement] of Object.entries(replacements)) {
      const original = native[name as keyof typeof native];
      if (typeof original !== 'function') continue;
      // A call through the prototype's method with the process as `this` is replaced too
      const owner = ownerOf(Object.getPrototypeOf(target) as object | null, name);
      if (owner && (owner as Record<string, unknown>)[name] === original) define(owner, name, replacement);
      define(target, name, replacement);
    }

    // The listeners already there: the same ones, in the same order, wrapped (a once listener only
    // where rawListeners() says so)
    for (const event of ERROR_EVENTS) {
      const entries = stored(event) as (Function & { listener?: unknown })[];
      if (!entries.length) continue;
      Reflect.apply(removeAll, target, [event]);
      for (const entry of entries) {
        const once = typeof entry.listener === 'function';
        Reflect.apply(native.on!, target, [event, wrap(event, (once ? entry.listener : entry) as Listener, once)]);
      }
    }
    // The check runs inside the guard's wrappers, so an event nobody listens to through the guard
    // would never be checked. These three get a listener of the guard's own, first in line; a
    // listener on them changes nothing the runtime does by default (one on unhandledRejection or
    // uncaughtException would).
    for (const event of SENTINEL_EVENTS) {
      const sentinel = wrap(event, () => {}, false);
      sentinels.add(sentinel);
      Reflect.apply(native.prependListener!, target, [event, sentinel]);
    }
    listenersUncovered = () => ERROR_EVENTS.find((event) => stored(event).some((entry) => !registrations.has(entry))) ?? null;
  }

  const guard: ErrorEventGuard = {
    delivery,
    coversAllListeners: () => uncovered() === null,
    deliverOnlyTo: (reason, listener) => {
      only = reason && listener ? { reason, listener } : null;
    },
  };
  guards.set(target, guard);
  return guard;
}
