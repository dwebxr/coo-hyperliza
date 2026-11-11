/**
 * The boundary between world app scripts and the agent.
 *
 * The engine's script API (hyperfy/src/core/systems/Apps.js, entities/App.js, nodes/*.js getProxy)
 * was not written as a security boundary and cannot be edited here: its proxies hand out raw
 * nodes, entities and the world itself in several places (see lib/script-api.ts for the list).
 * So nothing the engine returns reaches a script as it is, and nothing a script passes reaches
 * the engine as it is. Every value crossing in either direction goes through this membrane:
 *
 * host -> script (toScript)
 *   - primitives pass
 *   - plain objects (prototype Object.prototype or null) and arrays become live facades: a Proxy
 *     whose traps convert every value read from or written to the host object
 *   - instances of the classes listed in `classes` (exact prototype match) become facades too,
 *     limited to properties whose name does not start with "_" and to assignments that replace
 *     an existing own non-function value or go through a setter
 *   - functions become frozen callables that convert `this`, the arguments, the result and any
 *     exception; a function is refused as `this`
 *   - promises are followed by a promise made here, dates and binary data are copied, errors are
 *     rebuilt with their name and message only (file paths replaced, no stack frames, no cause)
 *   - every other object (World, a System, an entity, a raw node, three.js objects, Blob, ...)
 *     becomes an opaque frozen token with no properties, which does not convert back
 *
 * script -> host (toHost)
 *   - primitives pass; facades unwrap to the host object they stand for
 *   - functions (a script's own, and the callables and classes of this membrane too) become host
 *     callables that convert the arguments (so a callback the engine invokes with a raw object
 *     sees a facade or a token), drop `this`, and rethrow an object the script throws as a fresh
 *     Error carrying strings only (a thrown primitive crosses as it is). A raw host function never
 *     goes back to host code.
 *   - promises are followed by a promise made here; binary data is copied byte for byte. Following
 *     a script's promise calls its `then` (the script's own, or the language's) with the two
 *     resolving functions of the promise made here, and nothing else of the host
 *   - everything else is copied: own enumerable string-keyed properties, each read once, into a
 *     new plain object or array. The engine never holds a script's own object, so a script
 *     cannot answer differently on a second read, and no getter of its runs later inside host code.
 *     Names the engine reads as a node reference (REF_KEYS) are refused.
 *
 * Species-free: host code here never calls a built-in whose behaviour a script's value can choose
 * through `constructor` / `Symbol.species` (Promise.prototype.then, ArrayBuffer.prototype.slice,
 * Array/TypedArray methods) on a script's value. Promise.prototype.then is only ever called on a
 * promise made here (follow), and bytes are copied into a buffer made here (freshBytes).
 *
 * What this does not do: it does not judge what a reachable host function does. A script can call
 * any function it can read from a facade, with any non-function `this` and arguments it is able to
 * pass. The list of what is reachable, and why each entry is acceptable, is in lib/script-api.ts.
 */

type AnyFunction = (...args: any[]) => unknown;
type Constructor = abstract new (...args: any[]) => object;

export interface ScriptClass {
  /** The name scripts construct it by, e.g. `new Vector3()` */
  name: string;
  ctor: Constructor;
  /** Other host classes whose instances are shown to scripts as this one (never constructed) */
  aliases?: Constructor[];
}

export type CallGuard = (hostArgs: unknown[]) => void;

export interface MembraneOptions {
  classes?: ScriptClass[];
  /**
   * Extra argument check for a host function read as `owner[prop]`; throw a TypeError to refuse
   * the call. Arguments are already converted to host values.
   */
  guardFor?: (owner: object, prop: string) => CallGuard | undefined;
  /**
   * Extra check for a value a script assigns as `owner[prop]`, called with `[hostValue]` before
   * the assignment; throw a TypeError to refuse it.
   */
  guardSet?: (owner: object, prop: string) => CallGuard | undefined;
  /** Told about a script async callback that rejected (the host ignores such results) */
  onAsyncError?: (error: Error) => void;
}

export interface ScriptMembrane {
  toScript(value: unknown): unknown;
  toHost(value: unknown): unknown;
  /**
   * A facade over an object whose properties cannot be enumerated (the engine's `app` Proxy):
   * every string property for which `allows` is true is read from and written to `host`.
   */
  exposeDynamic(host: object, allows: (prop: string) => boolean): object;
  /** The script-facing constructor for a class in `classes` */
  scriptClass(name: string): unknown;
  /** A fresh Error for the host from an object a script threw; a primitive as it is */
  toHostError(thrown: unknown): unknown;
  /**
   * Whether `value` is a host object this membrane has shown to a script as a facade. By
   * identity (the membrane's own WeakMaps), never by shape: a copy of a script's object, or
   * anything else a script made, is never handed out.
   */
  handedOut(value: unknown): boolean;
}

/**
 * Property names the engine reads to turn a value into a node or geometry (nodes/Node.js getRef,
 * nodes/Joint.js body0/body1). A script may not put them on anything that reaches the host, so
 * every host value that looks like a reference is one the engine made.
 */
export const REF_KEYS: readonly string[] = Object.freeze(['_isRef', '_ref']);
const REF_KEY_SET: ReadonlySet<string> = new Set(REF_KEYS);

const MAX_COPY_DEPTH = 64;
const MAX_COPY_NODES = 100_000;

const INTRINSIC_ERRORS: Record<string, ErrorConstructor> = {
  Error,
  TypeError,
  RangeError,
  ReferenceError,
  SyntaxError,
  EvalError,
  URIError,
};

const HostPromise = Promise;
const promiseThen = Promise.prototype.then;
const TypedArray = Object.getPrototypeOf(Uint8Array) as Constructor;
const typedArrayTag = Object.getOwnPropertyDescriptor(TypedArray.prototype, Symbol.toStringTag)!.get!;
const TYPED_ARRAYS: Record<string, new (buffer: ArrayBuffer) => ArrayBufferView> = {
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
  Float64Array,
  BigInt64Array,
  BigUint64Array,
};
const Float16 = (globalThis as Record<string, unknown>).Float16Array;
if (typeof Float16 === 'function') TYPED_ARRAYS.Float16Array = Float16 as new (buffer: ArrayBuffer) => ArrayBufferView;
const viewBytes = [TypedArray.prototype, DataView.prototype].map((proto) => ({
  buffer: Object.getOwnPropertyDescriptor(proto, 'buffer')!.get!,
  byteOffset: Object.getOwnPropertyDescriptor(proto, 'byteOffset')!.get!,
  byteLength: Object.getOwnPropertyDescriptor(proto, 'byteLength')!.get!,
}));
// Brand-checked: throws for anything but an ArrayBuffer (a SharedArrayBuffer and a Proxy included)
const arrayBufferByteLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!;
const dateGetTime = Date.prototype.getTime;
const hasOwn = (object: object, key: PropertyKey) => Object.prototype.hasOwnProperty.call(object, key);

/** Objects and functions; everything else is a primitive and crosses as it is */
const isObjectLike = (value: unknown): value is object =>
  value !== null && (typeof value === 'object' || typeof value === 'function');

const isIndex = (prop: string) => /^(0|[1-9]\d*)$/.test(prop) && Number(prop) < 2 ** 32 - 1;

/**
 * A promise made here that settles as `value` does, through onFulfilled / onRejected.
 *
 * Promise.prototype.then is only ever called on the promise made here. Called on `value` itself
 * it would build its result with `value.constructor[Symbol.species]`, which a script can set, and
 * hand onFulfilled's result to a resolve function of the script's choosing. Resolving a fresh
 * promise with `value` makes the language look up `value.then` and call it with the fresh
 * promise's own resolving functions: a script that intercepts that call gets those two functions
 * and nothing else, and never sees what onFulfilled returns.
 */
function follow<T>(value: unknown, onFulfilled: (result: unknown) => T, onRejected: (reason: unknown) => never): Promise<T> {
  const settled = new HostPromise<unknown>((resolve) => resolve(value));
  return promiseThen.call(settled, onFulfilled, onRejected) as Promise<T>;
}

/** `length` bytes of `buffer` from `offset`, in a buffer made here. No slice() on the script's buffer. */
function freshBytes(buffer: ArrayBuffer, offset: number, length: number): ArrayBuffer {
  const copy = new ArrayBuffer(length);
  // A typed array constructed over a buffer, and set() from a typed array, look nothing up on it
  new Uint8Array(copy).set(new Uint8Array(buffer, offset, length));
  return copy;
}

/** A byte-for-byte copy of an ArrayBuffer or view, made with brand-checked intrinsics, or null */
function copyBinary(value: object): ArrayBuffer | ArrayBufferView | null {
  let length: number | undefined;
  try {
    length = arrayBufferByteLength.call(value) as number;
  } catch {
    // not an ArrayBuffer
  }
  if (length !== undefined) {
    try {
      return freshBytes(value as ArrayBuffer, 0, length);
    } catch {
      return null; // detached
    }
  }
  if (!ArrayBuffer.isView(value)) return null;
  for (const getters of viewBytes) {
    try {
      const offset = getters.byteOffset.call(value) as number;
      const byteLength = getters.byteLength.call(value) as number;
      const bytes = freshBytes(getters.buffer.call(value) as ArrayBuffer, offset, byteLength);
      const tag = typedArrayTag.call(value) as string | undefined;
      const View = tag ? TYPED_ARRAYS[tag] : undefined;
      return View ? new View(bytes) : new DataView(bytes);
    } catch {
      // the other kind of view, or a detached or out-of-bounds view
    }
  }
  return null;
}

function readString(value: unknown, key: string): string | null {
  try {
    const v = (value as Record<string, unknown>)[key];
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}

// An absolute file path or file: URL with a "/" after its first segment, after the start of the
// text, whitespace, a quote, an opening bracket, "=" or ","; it ends at whitespace, a quote or a bracket
const PATH_PATTERN = /(^|[\s'"`([{=,])((?:file:\/\/)?\/(?:[^/\s'"`()<>[\]{}]+\/)+[^/\s'"`()<>[\]{}]*)/g;

/**
 * The text with every absolute file path PATH_PATTERN finds replaced by `<path>` (not a path of one
 * segment such as /tmp, not one that follows another character, and of a path with a space in it
 * only the part before the space)
 */
export function redactPaths(text: string): string {
  return text.replace(PATH_PATTERN, '$1<path>');
}

/** A new error of the language's own classes carrying only the name, message and stack strings */
function rebuildError(thrown: unknown): Error {
  const name = readString(thrown, 'name');
  let message = readString(thrown, 'message');
  if (message === null) {
    try {
      message = String(thrown);
    } catch {
      message = 'Error';
    }
  }
  const stack = readString(thrown, 'stack');
  const Ctor = (name !== null && hasOwn(INTRINSIC_ERRORS, name) && INTRINSIC_ERRORS[name]) || Error;
  const error = new Ctor(message);
  if (name !== null && name !== Ctor.name) Object.defineProperty(error, 'name', { value: name, writable: true, configurable: true });
  if (stack !== null) Object.defineProperty(error, 'stack', { value: stack, writable: true, configurable: true });
  return error;
}

/**
 * A new error for a script from what host code threw: the language's own class by name, the
 * name and message with file paths replaced, and a stack that names no frame. Nothing else of
 * the original crosses (no cause, no other property, no host stack).
 */
function errorForScript(thrown: unknown): Error {
  const name = readString(thrown, 'name');
  let message = readString(thrown, 'message');
  if (message === null) {
    try {
      message = String(thrown);
    } catch {
      message = 'Error';
    }
  }
  message = redactPaths(message);
  const Ctor = (name !== null && hasOwn(INTRINSIC_ERRORS, name) && INTRINSIC_ERRORS[name]) || Error;
  const error = new Ctor(message);
  if (name !== null && name !== Ctor.name) {
    Object.defineProperty(error, 'name', { value: redactPaths(name), writable: true, configurable: true });
  }
  // The constructor captured the host's stack; replace it with one that has no frames
  Object.defineProperty(error, 'stack', { value: `${error.name}: ${message}`, writable: true, configurable: true });
  return error;
}

/**
 * Host functions no script may call even if some object exposes them: they evaluate strings in
 * the host realm or reach the network and timers directly. Belt and braces only: the membrane's
 * job is that scripts never get to an object holding one.
 */
function forbiddenFunctions(): WeakSet<object> {
  const set = new WeakSet<object>();
  const g = globalThis as Record<string, unknown>;
  for (const name of ['Function', 'eval', 'fetch', 'setTimeout', 'setInterval', 'setImmediate', 'queueMicrotask', 'require']) {
    const value = g[name];
    if (typeof value === 'function') set.add(value);
  }
  return set;
}

export function createScriptMembrane(options: MembraneOptions = {}): ScriptMembrane {
  // host object or function -> what scripts hold for it (facade, callable, class, token)
  const scriptSide = new WeakMap<object, object>();
  // facade, callable or class -> the host value it stands for. Tokens are deliberately absent.
  const hostSide = new WeakMap<object, object>();
  // The facades among the values of scriptSide (handedOut)
  const facades = new WeakSet<object>();
  // script function -> the callable the host holds for it, and back
  const hostCallables = new WeakMap<object, AnyFunction>();
  const scriptFunctions = new WeakMap<object, AnyFunction>();
  // an error rebuilt for the host -> the script's original, so a script catches its own error again
  const scriptErrors = new WeakMap<object, unknown>();
  // host class prototype -> the prototype scripts see for its instances
  const scriptProtos = new Map<object, object>();
  const scriptClasses = new Map<string, object>();
  // Tokens are recognised by identity, never by shape
  const tokens = new WeakSet<object>();
  const forbidden = forbiddenFunctions();
  // Never shown, whatever their shape (in some runtimes these look like plain objects)
  const denied = new WeakSet<object>([globalThis]);
  if (typeof process === 'object' && process) {
    denied.add(process);
    if (typeof process.env === 'object' && process.env) denied.add(process.env);
  }

  /** An error of this membrane's for a script: a TypeError with this message and no frames */
  const refusal = (message: string): Error => errorForScript(new TypeError(message));

  for (const { name, ctor, aliases = [] } of options.classes ?? []) {
    const proto = {};
    const scriptClass = function (this: unknown, ...args: unknown[]) {
      if (!new.target) throw refusal(`Class constructor ${name} cannot be invoked without 'new'`);
      const hostArgs = onHost(() => args.map((arg) => toHost(arg)));
      return toScript(onHost(() => Reflect.construct(ctor as unknown as AnyFunction, hostArgs)));
    };
    Object.defineProperty(scriptClass, 'name', { value: name });
    Object.defineProperty(scriptClass, 'prototype', { value: proto, writable: false });
    Object.defineProperty(proto, 'constructor', { value: scriptClass, enumerable: false });
    // Constants such as Euler.DEFAULT_ORDER
    for (const key of Object.getOwnPropertyNames(ctor)) {
      if (key === 'name' || key === 'length' || key === 'prototype') continue;
      const value = Object.getOwnPropertyDescriptor(ctor, key)?.value;
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        Object.defineProperty(scriptClass, key, { value, enumerable: true });
      }
    }
    Object.freeze(proto);
    Object.freeze(scriptClass);
    scriptClasses.set(name, scriptClass);
    for (const host of [ctor, ...aliases]) {
      scriptProtos.set(host.prototype, proto);
      scriptSide.set(host, scriptClass);
    }
    hostSide.set(scriptClass, ctor);
  }

  function toScriptError(err: unknown): unknown {
    if (typeof err === 'string') return redactPaths(err);
    if (!isObjectLike(err)) return err;
    if (scriptErrors.has(err)) return scriptErrors.get(err);
    return errorForScript(err);
  }

  function toHostError(thrown: unknown): unknown {
    if (!isObjectLike(thrown)) return thrown;
    const error = rebuildError(thrown);
    scriptErrors.set(error, thrown);
    return error;
  }

  // ---- host -> script ----

  /**
   * Runs host code (or a conversion) on behalf of a script: whatever it throws is rebuilt before
   * the script sees it
   */
  function onHost<T>(fn: () => T): T {
    try {
      return fn();
    } catch (err) {
      throw toScriptError(err);
    }
  }

  function callable(fn: AnyFunction, guard?: CallGuard): object {
    const existing = scriptSide.get(fn);
    if (existing) return existing;
    // Method syntax: callable with a `this`, not constructible, no `prototype` property
    const wrapper = {
      call(this: unknown, ...args: unknown[]) {
        if (forbidden.has(fn)) throw refusal('This function is not available to world scripts');
        const hostThis = onHost(() => toHost(this));
        // Every function converts to a wrapper of this membrane's: a host method run on one would
        // write to it (an endowed helper, a class, a wrapper)
        if (typeof hostThis === 'function') throw refusal('A function cannot be the `this` of a world API function');
        const hostArgs = onHost(() => args.map((arg) => toHost(arg)));
        if (guard) onHost(() => guard(hostArgs));
        return toScript(onHost(() => Reflect.apply(fn, hostThis, hostArgs)));
      },
    }.call;
    Object.freeze(wrapper);
    scriptSide.set(fn, wrapper);
    hostSide.set(wrapper, fn);
    return wrapper;
  }

  function token(host: object): object {
    let value = scriptSide.get(host);
    if (!value) {
      value = Object.freeze({});
      tokens.add(value);
      scriptSide.set(host, value);
    }
    return value;
  }

  interface Shape {
    /** The prototype scripts see */
    proto: object;
    /** Whether scripts may read or write this property at all */
    visible(prop: string): boolean;
    /** Whether the host object has it (own, or inherited where the shape allows) */
    has(host: object, prop: string): boolean;
    keys(host: object): string[];
    canSet(host: object, prop: string): boolean;
    canDelete(host: object, prop: string): boolean;
  }

  const plainShape: Shape = {
    proto: Object.prototype,
    visible: (prop) => prop !== '__proto__',
    has: (host, prop) => hasOwn(host, prop),
    keys: (host) => Object.keys(host),
    // Never a name the engine reads as a node reference: no host object may be made to look like one
    canSet: (_host, prop) => !REF_KEY_SET.has(prop),
    canDelete: (host, prop) => {
      const desc = Object.getOwnPropertyDescriptor(host, prop);
      return !desc || ('value' in desc && typeof desc.value !== 'function');
    },
  };

  function findDescriptor(host: object, prop: string): PropertyDescriptor | undefined {
    for (let o: object | null = host; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
      const desc = Object.getOwnPropertyDescriptor(o, prop);
      if (desc) return desc;
    }
    return undefined;
  }

  function instanceShape(proto: object): Shape {
    return {
      proto,
      // "_" names are the classes' internals (_x, _onChangeCallback, ...): a script that could set a
      // node's change callback would switch off the engine's own bookkeeping for that node
      visible: (prop) => prop !== '__proto__' && !prop.startsWith('_'),
      has: (host, prop) => !!findDescriptor(host, prop),
      keys: (host) => Object.keys(host).filter((key) => !key.startsWith('_')),
      // Never a new property and never over a method: host code keeps calling these objects' methods
      canSet: (host, prop) => {
        const desc = findDescriptor(host, prop);
        if (!desc) return false;
        return 'value' in desc ? typeof desc.value !== 'function' && hasOwn(host, prop) : typeof desc.set === 'function';
      },
      canDelete: () => false,
    };
  }

  function facade(host: object, shape: Shape, dynamic = false): object {
    const read = (prop: string): unknown => {
      const value: unknown = onHost(() => Reflect.get(host, prop));
      return typeof value === 'function' && !scriptFunctions.has(value)
        ? callable(value as AnyFunction, options.guardFor?.(host, prop))
        : toScript(value);
    };
    const found = (prop: string) => shape.visible(prop) && (dynamic || onHost(() => shape.has(host, prop)));
    const keys = () => (dynamic ? [] : onHost(() => shape.keys(host)).filter((key) => shape.visible(key)));
    const value = new Proxy(
      {},
      {
        get(_target, prop, receiver) {
          if (typeof prop === 'string' && found(prop)) return read(prop);
          return Reflect.get(shape.proto, prop, receiver);
        },
        set(_target, prop, next) {
          if (typeof prop !== 'string' || !shape.visible(prop) || !onHost(() => shape.canSet(host, prop))) return false;
          const hostValue = onHost(() => toHost(next));
          const guard = options.guardSet?.(host, prop);
          if (guard) onHost(() => guard([hostValue]));
          return onHost(() => Reflect.set(host, prop, hostValue));
        },
        has(_target, prop) {
          return (typeof prop === 'string' && found(prop) && (!dynamic || read(prop) !== undefined)) || Reflect.has(shape.proto, prop);
        },
        ownKeys: keys,
        getOwnPropertyDescriptor(_target, prop) {
          if (typeof prop !== 'string' || !keys().includes(prop)) return undefined;
          return { value: read(prop), writable: true, enumerable: true, configurable: true };
        },
        deleteProperty(_target, prop) {
          if (typeof prop !== 'string' || dynamic || !shape.visible(prop)) return false;
          return onHost(() => shape.canDelete(host, prop) && Reflect.deleteProperty(host, prop));
        },
        defineProperty: () => false,
        getPrototypeOf: () => shape.proto,
        setPrototypeOf: () => false,
        preventExtensions: () => false,
        isExtensible: () => true,
      }
    );
    scriptSide.set(host, value);
    hostSide.set(value, host);
    facades.add(value);
    return value;
  }

  function arrayFacade(host: unknown[]): object {
    const item = (prop: string) => toScript(onHost(() => host[Number(prop)]));
    const value = new Proxy([] as unknown[], {
      get(_target, prop, receiver) {
        if (prop === 'length') return onHost(() => host.length);
        if (typeof prop === 'string' && isIndex(prop)) return item(prop);
        // Array methods run on the facade itself, so they read and write through these traps
        return Reflect.get(Array.prototype, prop, receiver);
      },
      set(_target, prop, next) {
        if (typeof prop !== 'string') return false;
        if (prop === 'length' ? typeof next !== 'number' : !isIndex(prop)) return false;
        const hostValue = onHost(() => toHost(next));
        return onHost(() => Reflect.set(host, prop, hostValue));
      },
      has(_target, prop) {
        if (prop === 'length') return true;
        if (typeof prop === 'string' && isIndex(prop)) return onHost(() => Number(prop) in host);
        return Reflect.has(Array.prototype, prop);
      },
      ownKeys() {
        return onHost(() => {
          const keys: string[] = [];
          for (let i = 0; i < host.length; i++) if (i in host) keys.push(String(i));
          keys.push('length');
          return keys;
        });
      },
      getOwnPropertyDescriptor(_target, prop) {
        if (prop === 'length') return { value: onHost(() => host.length), writable: true, enumerable: false, configurable: false };
        if (typeof prop !== 'string' || !isIndex(prop) || !onHost(() => Number(prop) in host)) return undefined;
        return { value: item(prop), writable: true, enumerable: true, configurable: true };
      },
      deleteProperty(_target, prop) {
        if (typeof prop !== 'string' || !isIndex(prop)) return false;
        return onHost(() => Reflect.deleteProperty(host, prop));
      },
      defineProperty: () => false,
      getPrototypeOf: () => Array.prototype,
      setPrototypeOf: () => false,
      preventExtensions: () => false,
      isExtensible: () => true,
    });
    scriptSide.set(host, value);
    hostSide.set(value, host);
    facades.add(value);
    return value;
  }

  function toScript(value: unknown): unknown {
    if (!isObjectLike(value)) return value;
    // A script's own function coming back (app.on handlers, node callbacks)
    const original = scriptFunctions.get(value);
    if (original) return original;
    const known = scriptSide.get(value);
    if (known) return known;
    if (denied.has(value)) return token(value);
    if (typeof value === 'function') return callable(value as AnyFunction);
    if (value instanceof Promise) {
      return follow(
        value,
        (result) => toScript(result),
        (err) => {
          throw toScriptError(err);
        }
      );
    }
    if (value instanceof Error) return toScriptError(value);
    if (Array.isArray(value)) return arrayFacade(value);
    const proto: object | null = Object.getPrototypeOf(value);
    if (proto === Object.prototype || proto === null) return facade(value, plainShape);
    const scriptProto = proto && scriptProtos.get(proto);
    if (scriptProto) return facade(value, instanceShape(scriptProto));
    const binary = copyBinary(value);
    if (binary) return binary;
    try {
      return new Date(dateGetTime.call(value));
    } catch {
      // not a Date
    }
    return token(value);
  }

  // ---- script -> host ----

  function hostCallable(fn: AnyFunction): AnyFunction {
    let wrapper = hostCallables.get(fn);
    if (!wrapper) {
      wrapper = (...args: unknown[]) => {
        const scriptArgs = args.map((arg) => toScript(arg));
        try {
          const result = Reflect.apply(fn, undefined, scriptArgs);
          if (result instanceof Promise) return settleQuietly(result);
          return toHost(result);
        } catch (err) {
          throw toHostError(err);
        }
      };
      hostCallables.set(fn, wrapper);
      scriptFunctions.set(wrapper, fn);
    }
    return wrapper;
  }

  /** A promise made here for a script's promise: its result converted, its rejection rebuilt */
  function adopt(promise: Promise<unknown>): Promise<unknown> {
    return follow(
      promise,
      // A promise whose `then` is not callable fulfils with itself: stop there instead of following it again.
      // A getter that throws while the result is copied rejects with an Error made here, never with
      // the script's own value, so a host that leaves this promise unhandled reports nothing of the script's.
      (result) => {
        if (result === promise) return undefined;
        try {
          return toHost(result);
        } catch (err) {
          throw toHostError(err);
        }
      },
      (err) => {
        throw toHostError(err);
      }
    );
  }

  /**
   * The promise an async script callback returned, for a host that almost never looks at it: its
   * rejection is reported once here instead of surfacing as a process-level unhandled rejection
   * whose reason is an object of the script's choosing.
   */
  function settleQuietly(promise: Promise<unknown>): Promise<unknown> {
    const hostPromise = adopt(promise);
    promiseThen.call(hostPromise, undefined, (err: unknown) => {
      options.onAsyncError?.(err instanceof Error ? err : new Error(String(err)));
    });
    return hostPromise;
  }

  function copyToHost(value: unknown, budget: { nodes: number }, depth: number, seen: Map<object, unknown>): unknown {
    if (!isObjectLike(value)) return value;
    const host = hostSide.get(value);
    if (host !== undefined) {
      // A facade gives its host object back. A callable or class never gives its raw host function
      // back: host code would get a function of the engine's (or a three.js class) to write to.
      return typeof host === 'function' ? hostCallable(value as AnyFunction) : host;
    }
    // Tokens stand for nothing on the way back
    if (tokens.has(value)) return undefined;
    if (typeof value === 'function') return hostCallable(value as AnyFunction);
    if (seen.has(value)) return seen.get(value);
    if (depth > MAX_COPY_DEPTH || ++budget.nodes > MAX_COPY_NODES) {
      throw new TypeError('Value is too large or too deeply nested to pass to the world');
    }
    if (value instanceof Promise) return adopt(value);
    if (value instanceof Error) return toHostError(value);
    const binary = copyBinary(value);
    if (binary) return binary;
    try {
      return new Date(dateGetTime.call(value));
    } catch {
      // not a Date
    }
    if (Array.isArray(value)) {
      const copy: unknown[] = [];
      seen.set(value, copy);
      const length = Math.min(Number(value.length) || 0, MAX_COPY_NODES);
      for (let i = 0; i < length; i++) copy[i] = copyToHost(value[i], budget, depth + 1, seen);
      return copy;
    }
    const copy: Record<string, unknown> = {};
    seen.set(value, copy);
    for (const key of Object.keys(value)) {
      if (REF_KEY_SET.has(key)) throw new TypeError(`A world script cannot pass a property named ${key}`);
      const item = copyToHost((value as Record<string, unknown>)[key], budget, depth + 1, seen);
      // defineProperty: a key named __proto__ must become a property, not the copy's prototype
      Object.defineProperty(copy, key, { value: item, writable: true, enumerable: true, configurable: true });
    }
    return copy;
  }

  function toHost(value: unknown): unknown {
    return copyToHost(value, { nodes: 0 }, 0, new Map());
  }

  return {
    toScript,
    toHost,
    exposeDynamic(host, allows) {
      const known = scriptSide.get(host);
      if (known) return known;
      return facade(
        host,
        {
          proto: Object.prototype,
          visible: (prop) => prop !== '__proto__' && allows(prop),
          has: () => true,
          keys: () => [],
          canSet: (_host, prop) => !REF_KEY_SET.has(prop),
          canDelete: () => false,
        },
        true
      );
    },
    scriptClass: (name) => scriptClasses.get(name),
    toHostError,
    handedOut(value) {
      if (!isObjectLike(value)) return false;
      const shown = scriptSide.get(value);
      return shown !== undefined && facades.has(shown);
    },
  };
}
