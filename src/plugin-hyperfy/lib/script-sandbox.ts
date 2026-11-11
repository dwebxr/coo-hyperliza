/**
 * World app scripts: the HYPERFY_WORLD_SCRIPTS policy, the locked-down realm and the compartments
 * scripts are evaluated in. App scripts are code the world's server sends; whoever can build in
 * the world (or runs it) writes them.
 *
 *   off        nothing is evaluated (the default)
 *   sandboxed  the process is locked down with SES once, a self-test checks that the known escapes
 *              are closed, and each script runs in its own Compartment behind the membrane of
 *              lib/script-membrane.ts
 *
 * There is no mode that runs scripts without the sandbox.
 */

import 'ses';
import { type ErrorEventGuard, type ErrorEventTarget, describeRejection, guardErrorEvents } from './error-events';

export { describeRejection };

export type WorldScriptsMode = 'off' | 'sandboxed';

/**
 * What `sandboxed` does not protect against. README.md quotes this text word for word
 * (script-sandbox.test.ts checks that it does).
 */
export const WORLD_SCRIPTS_RESIDUAL_RISK = [
  "A sandboxed world script still runs inside the agent's process, on its only thread.",
  'There is no CPU or memory isolation: `while (true) {}` hangs the agent for good, and a script can allocate until the process dies.',
  "A script can use everything the engine's script API offers it: create and move nodes, read every player's position, name and id, teleport, push, freeze and re-skin the agent's own avatar, send app events to the world's server, post to the agent's local chat view, make the agent download models, avatars, emotes, sky images and HDR environments from the world's own origin or from any public https URL it names (of a model or avatar it loads it learns only whether that worked and the names and positions of its parts), and with `fetch()` send whatever it can read to any public https host and read the answer.",
  "A script can break the engine code it calls into by passing it nonsense, which can stop that app, the world's update loop, or the whole process.",
  "A script's own error stack traces name the agent's files and where they are on disk.",
  'The sandbox is defence for worlds whose builders you mostly trust. It is not a guarantee against a hostile world: use `off` there.',
].join(' ');

/** Reads HYPERFY_WORLD_SCRIPTS. Anything but `off`, `sandboxed` or nothing is a mistake and means off. */
export function resolveWorldScriptsMode(raw: string | undefined): { mode: WorldScriptsMode; problem?: string } {
  const value = raw?.trim().toLowerCase() ?? '';
  if (value === '' || value === 'off') return { mode: 'off' };
  if (value === 'sandboxed') return { mode: 'sandboxed' };
  return {
    mode: 'off',
    problem: `HYPERFY_WORLD_SCRIPTS="${raw}" is not a known value (use "off" or "sandboxed"). World scripts stay off.`,
  };
}

/**
 * When HYPERFY_WORLD_SCRIPTS is `sandboxed`, installs the guard of the process's error events
 * (lib/error-events.ts) now rather than at activation: Bun does not tell a once listener that was
 * registered before the guard apart, so the earlier it is installed the fewer there can be.
 * Activation installs it if it is not there yet. Returns whether it did.
 */
export function guardErrorEventsForWorldScripts(
  env: Record<string, string | undefined>,
  install: () => unknown = () => guardErrorEvents()
): boolean {
  if (resolveWorldScriptsMode(env.HYPERFY_WORLD_SCRIPTS).mode !== 'sandboxed') return false;
  install();
  return true;
}

/**
 * Default taming, minus what this stack needs: untamed error stacks and console (logging), no
 * domain check (Bun and several dependencies load node:domain), platform error and rejection
 * handling left alone, and the platform's own locale methods (the tamed ones change what
 * toLocaleString and localeCompare return). `overrideTaming: 'severe'` lets every dependency
 * that assigns over an inherited property of a frozen intrinsic keep working.
 */
export const LOCKDOWN_OPTIONS = {
  errorTaming: 'unsafe',
  consoleTaming: 'unsafe',
  overrideTaming: 'severe',
  domainTaming: 'unsafe',
  stackFiltering: 'verbose',
  errorTrapping: 'none',
  unhandledRejectionTrapping: 'none',
  localeTaming: 'unsafe',
} as const;

// ---- compartments ----

export interface ScriptCompartment {
  evaluate(code: string): unknown;
}

/**
 * One Compartment per script asset. Scripts share the frozen language intrinsics with the host;
 * each gets its own global object, and the names put there cannot be reassigned, redefined or
 * deleted by the script.
 */
export function createScriptCompartment(globals: Record<string, unknown>): ScriptCompartment {
  if (sandboxState !== 'active') throw new Error('World scripts can only be evaluated after the sandbox has been activated');
  return buildCompartment(globals);
}

/** The same compartment, for the self-test only: while it runs, and never after */
export function createSelfTestCompartment(globals: Record<string, unknown>): ScriptCompartment {
  if (sandboxState !== 'testing') throw new Error('Self-test compartments exist only while the sandbox self-test runs');
  return buildCompartment(globals);
}

function buildCompartment(globals: Record<string, unknown>): ScriptCompartment {
  const compartment = new Compartment({ globals, __options__: true });
  for (const name of Object.keys(globals)) {
    const desc = Object.getOwnPropertyDescriptor(compartment.globalThis, name);
    if (desc) Object.defineProperty(compartment.globalThis, name, { ...desc, writable: false, configurable: false });
  }
  return compartment;
}

/** The engine's wrapper (hyperfy/src/core/systems/Scripts.js): `config` is the deprecated name of `props` */
export function wrapScriptCode(code: string): string {
  return `
  (function() {
    const shared = {}
    return (world, app, fetch, props, setTimeout) => {
      const config = props // deprecated
      ${code}
    }
  })()
  `;
}

// ---- self-test ----

export interface ProbeResult {
  name: string;
  blocked: boolean;
  detail: string;
}

/**
 * Escape attempts, each a script expression that evaluates to a string starting with "ESCAPED"
 * when it got through. A probe that throws counts as blocked.
 */
const SCRIPT_PROBES: [name: string, code: string][] = [
  [
    'Function constructor reached from a script function',
    `(() => { const r = (function(){}).constructor('return typeof process + typeof Bun + typeof require')(); return r === 'undefinedundefinedundefined' ? 'no host globals' : 'ESCAPED ' + r })()`,
  ],
  [
    'AsyncFunction constructor',
    `(() => { (async function(){}).constructor('return 1'); return 'ESCAPED constructed' })()`,
  ],
  [
    'GeneratorFunction constructor',
    `(() => { (function*(){}).constructor('return 1'); return 'ESCAPED constructed' })()`,
  ],
  [
    'AsyncGeneratorFunction constructor',
    `(() => { (async function*(){}).constructor('return 1'); return 'ESCAPED constructed' })()`,
  ],
  [
    'host globals visible in the compartment',
    `(() => { const seen = ['process', 'Bun', 'require', 'fetch', 'WebSocket', 'window', 'self', 'global', 'Buffer', 'setInterval', 'queueMicrotask', 'WebAssembly', 'structuredClone'].filter(n => typeof globalThis[n] !== 'undefined'); return seen.length ? 'ESCAPED ' + seen.join(',') : 'none' })()`,
  ],
  [
    'Function() sees the host global object',
    `(() => { const g = Function('return this')(); return g === undefined || typeof g.process === 'undefined' ? 'no' : 'ESCAPED' })()`,
  ],
  // Markers only: in a realm that is not locked down these writes succeed, and are removed again below
  ...['Object', 'Array', 'Function', 'Promise'].map((name): [string, string] => [
    `${name}.prototype can be written to`,
    `(() => { ${name}.prototype.__worldScriptProbe = 1; return 'ESCAPED' })()`,
  ]),
  [
    'Error.prepareStackTrace hands out call sites',
    `(() => { let sites; const before = Error.prepareStackTrace; try { Error.prepareStackTrace = (e, s) => { sites = s; return '' }; void new Error('x').stack } catch {} try { Error.prepareStackTrace = before } catch {} return sites === undefined ? 'not called' : 'ESCAPED' })()`,
  ],
  [
    'an endowed global can be replaced',
    `(() => { const before = globalThis.__probeHost; globalThis.__probeHost = 1; return globalThis.__probeHost === before ? 'ignored' : 'ESCAPED' })()`,
  ],
  [
    'Function constructor reached from anything reachable from the globals',
    `(() => {
      const seen = new Set(); const queue = Object.getOwnPropertyNames(globalThis).filter(n => n !== '__probeHost').map(n => { try { return globalThis[n] } catch { return undefined } });
      const hits = [];
      while (queue.length && seen.size < 20000) {
        const v = queue.pop();
        if (v === null || (typeof v !== 'object' && typeof v !== 'function') || seen.has(v)) continue;
        seen.add(v);
        if (typeof v === 'function') {
          try { const r = v.constructor('return typeof process + typeof Bun + typeof require')(); if (r !== 'undefinedundefinedundefined') hits.push(r) } catch {}
        }
        try { queue.push(Object.getPrototypeOf(v)) } catch {}
        let keys = []; try { keys = Reflect.ownKeys(v) } catch {}
        for (const k of keys) { try { queue.push(v[k]) } catch {} }
      }
      return hits.length ? 'ESCAPED ' + hits[0] : 'walked ' + seen.size
    })()`,
  ],
  [
    'a host object handed over by a host function',
    `(() => {
      const leaked = [];
      for (const value of [__probeHost.process(), __probeHost.nested().inner, __probeHost.global(), __probeHost.instance()]) {
        if (value === null || typeof value !== 'object') continue;
        if (Reflect.ownKeys(value).length || typeof value.env !== 'undefined' || typeof value.secret !== 'undefined' || typeof value.process !== 'undefined') leaked.push(1);
        try { Object.getPrototypeOf(value).__worldScriptProbe = 1 } catch {}
      }
      return leaked.length ? 'ESCAPED' : 'opaque'
    })()`,
  ],
  [
    'a callback is called with a host object',
    `(() => { let got; __probeHost.callWithHostObject(v => { got = v }); return got !== null && typeof got === 'object' && (Reflect.ownKeys(got).length || typeof got.secret !== 'undefined') ? 'ESCAPED' : 'opaque' })()`,
  ],
  [
    'a thrown script object reaches the host',
    `(() => { try { __probeHost.callAndReport(() => { throw { secret: 1, [Symbol.for('nodejs.util.inspect.custom')]() { return 'x' } } }) } catch {} return 'thrown' })()`,
  ],
  // The host side of the next four is checked after the probes (hostChecks below)
  [
    'an ArrayBuffer a script passes reaches the host as its own object (species)',
    `(() => {
      const carrier = new ArrayBuffer(4); carrier.scriptMarker = 1
      const viaSpecies = new ArrayBuffer(4); viaSpecies.scriptMarker = 1
      Object.defineProperty(viaSpecies, 'constructor', { value: { [Symbol.species]: function () { return carrier } } })
      for (const value of [viaSpecies, new Uint8Array(viaSpecies), new DataView(viaSpecies)]) { try { __probeHost.take(value) } catch {} }
      return 'passed'
    })()`,
  ],
  [
    'a copy of a script object poses as an engine reference',
    `(() => { try { __probeHost.take({ _isRef: true, _ref: __probeHost.plain }) } catch { return 'refused' } return 'ESCAPED the host took it' })()`,
  ],
  [
    'a host function runs with an endowed function as its this',
    `(() => { try { __probeHost.setX.call(__probeHost.fn, 1) } catch { return 'refused' } return 'ESCAPED the host function ran' })()`,
  ],
  [
    'a host function a script passes back reaches the host as itself',
    `(() => { try { __probeHost.take(__probeHost.fn) } catch {} return 'passed' })()`,
  ],
  [
    'a host function that calls back on its `this` hands the callback a host value',
    `(() => {
      let got = 'not called'
      try { __probeHost.callOnThis.call({ callback(value) { got = value } }) } catch (e) { return 'threw ' + e.message }
      return got === __probeHost.plain ? 'the facade' : 'ESCAPED ' + typeof got
    })()`,
  ],
  [
    'a host error reaches a script with its stack, cause or file paths',
    `(() => {
      try { __probeHost.fail() } catch (e) {
        const text = String(e && e.stack) + ' ' + String(e && e.message)
        if (/\\n\\s*at |\\/home\\/agent/.test(text) || (e && (e.cause !== undefined || e.secret !== undefined))) return 'ESCAPED ' + text.slice(0, 120)
        return 'clean'
      }
      return 'not thrown'
    })()`,
  ],
];

/**
 * Probes whose outcome is only known once promise jobs have run: the code returns an object that
 * the host reads after a turn of the event loop. A promise's species constructor chooses the
 * resolve function that Promise.prototype.then hands its result to; if the membrane ever calls
 * then() on a script's promise, the script's resolve function is handed a host value.
 */
const ASYNC_PROBES: [name: string, code: string][] = [
  [
    "a promise's species constructor is handed a host value (promise passed to the host)",
    `(() => {
      const seen = { values: [] }
      const p = Promise.resolve(__probeHost.plain)
      Object.defineProperty(p, 'constructor', { value: { [Symbol.species]: function (executor) { executor((v) => { seen.values.push(v) }, () => {}); return Promise.resolve() } } })
      seen.promise = p
      try { __probeHost.take(p) } catch {}
      return seen
    })()`,
  ],
  [
    "a promise's species constructor is handed a host value (promise returned by a callback)",
    `(() => {
      const seen = { values: [] }
      try {
        __probeHost.callAndKeep(() => {
          const p = Promise.resolve(__probeHost.plain)
          Object.defineProperty(p, 'constructor', { value: { [Symbol.species]: function (executor) { executor((v) => { seen.values.push(v) }, () => {}); return Promise.resolve() } } })
          seen.promise = p
          return p
        })
      } catch {}
      return seen
    })()`,
  ],
];

// A host promise handed to a script: the script must get a promise of its own that resolves to the facade
const HOST_PROMISE_PROBE = `(() => {
  const seen = { values: [] }
  try { seen.promise = __probeHost.later(); seen.promise.then((v) => { seen.values.push(v) }) } catch (e) { seen.error = e.message }
  return seen
})()`;

// An unhandled rejection with a reason that has a custom-inspect hook and a stack getter
const REJECTION_PROBE = `(() => {
  const seen = { hook: 0, getter: 0 }
  seen.reason = {
    [Symbol.for('nodejs.util.inspect.custom')]() { seen.hook++; return 'hooked' },
    get stack() { seen.getter++; return 'Error: from a script' },
  }
  seen.promise = Promise.reject(seen.reason)
  return seen
})()`;

// Rejected when the source is parsed, before anything runs
const REJECTED_SOURCES: [name: string, code: string][] = [
  ['dynamic import', `import('node:fs')`],
  ['direct eval', `eval('1')`],
];

export interface SelfTestTools {
  /** Evaluates in a fresh compartment built exactly like a script's, plus the given global */
  evaluate(code: string, extraGlobals: Record<string, unknown>): unknown;
  /** Converts a host value the way a script would receive it */
  toScript(value: unknown): unknown;
  /**
   * The process and its error-event guard (lib/error-events.ts). With these, a probe rejects a
   * promise for real and checks what a process listener receives; without them it is not run.
   */
  errorEvents?: { target: ErrorEventTarget; guard: ErrorEventGuard };
}

const isObjectLike = (value: unknown): value is object =>
  value !== null && (typeof value === 'object' || typeof value === 'function');

/** Two turns of the event loop: every promise job a probe started has run */
const settle = () => new Promise<void>((resolve) => setTimeout(() => setTimeout(resolve, 0), 0));

/**
 * Rejects a promise in a compartment, with a reason that has an inspect hook and a stack getter,
 * and listens for it on the process like any other listener would. Only this probe's listener gets
 * that rejection (ErrorEventGuard.deliverOnlyTo). Returns the check, to be called after a turn of
 * the event loop: the listener must have been called, with an Error made by the host and not the
 * script's reason or promise, the hook must not have run, and nothing the guard does not cover
 * may be there to get an error event (ErrorEventGuard.coversAllListeners).
 */
function startRejectionProbe(
  evaluate: SelfTestTools['evaluate'],
  globals: Record<string, unknown>,
  { target, guard }: NonNullable<SelfTestTools['errorEvents']>
): () => ProbeResult {
  const name = 'an unhandled rejection reaches a process listener with the script\'s own values';
  const delivered: unknown[][] = [];
  const listener = (...args: unknown[]) => void delivered.push(args);
  let seen: unknown;
  target.on('unhandledRejection', listener);
  try {
    seen = evaluate(REJECTION_PROBE, globals);
    const reason = isObjectLike(seen) ? (seen as Record<string, unknown>).reason : undefined;
    if (isObjectLike(reason)) guard.deliverOnlyTo(reason, listener);
  } catch (err) {
    seen = { error: err instanceof Error ? err.message : String(err) };
  }
  return () => {
    target.removeListener('unhandledRejection', listener);
    guard.deliverOnlyTo(null);
    const record = (isObjectLike(seen) ? seen : {}) as Record<string, unknown>;
    const [reason, promise] = delivered[0] ?? [];
    const problems = [
      delivered.length !== 1 && `the listener was called ${delivered.length} times`,
      delivered.length && (reason === record.reason || !(reason instanceof Error)) && 'the listener got the script\'s reason',
      delivered.length && promise === record.promise && 'the listener got the script\'s promise',
      record.hook !== 0 && 'the inspect hook ran',
      !guard.coversAllListeners() && 'an error-event listener is not guarded',
      typeof record.error === 'string' && `the probe threw ${record.error}`,
    ].filter((problem): problem is string => typeof problem === 'string');
    return { name, blocked: problems.length === 0, detail: problems.length ? problems.join('; ') : 'an Error made by the host' };
  };
}

/**
 * Runs the escape probes. Must be called after lockdown; `tools` come from the real script runtime
 * (lib/script-api.ts) so the probes see the same globals and the same membrane as a world script.
 * A probe that throws counts as blocked, so the first probe is a control that must evaluate.
 */
export async function runEscapeProbes(tools: SelfTestTools): Promise<ProbeResult[]> {
  class Opaque {
    secret = 'host';
  }
  let reported: unknown;
  // A plain host object (scripts see a facade of it) and a host function (scripts see a wrapper)
  const plain = { marker: 'a host object' };
  const fn = function probeTarget() {};
  const hostPromise = Promise.resolve(plain);
  const received: unknown[] = [];
  const probeHost = {
    process: () => process,
    nested: () => ({ inner: process }),
    global: () => globalThis,
    instance: () => new Opaque(),
    callWithHostObject: (callback: (value: unknown) => void) => callback(new Opaque()),
    callAndReport: (callback: () => void) => {
      try {
        callback();
      } catch (err) {
        reported = err;
      }
    },
    plain,
    fn,
    take: (value: unknown) => void received.push(value),
    callAndKeep: (callback: () => unknown) => void received.push(callback()),
    setX(this: Record<string, unknown>, x: unknown) {
      this.x = x;
    },
    callOnThis(this: { callback?: (value: unknown) => unknown }) {
      return this.callback?.(plain);
    },
    later: () => hostPromise,
    fail: () => {
      throw Object.assign(new Error("ENOENT: no such file or directory, open '/home/agent/project/.env'"), { cause: new Opaque(), secret: 1 });
    },
  };
  const globals = { __probeHost: tools.toScript(probeHost) };
  const results: ProbeResult[] = [];

  try {
    const control = String(tools.evaluate(`(() => typeof __probeHost.take === 'function' ? 'evaluated' : 'no probe host')()`, globals));
    results.push({ name: 'the self-test can evaluate a script', blocked: control === 'evaluated', detail: control });
  } catch (err) {
    results.push({ name: 'the self-test can evaluate a script', blocked: false, detail: `threw ${err instanceof Error ? err.message : String(err)}` });
  }

  for (const [name, code] of SCRIPT_PROBES) {
    try {
      const outcome = String(tools.evaluate(code, globals));
      results.push({ name, blocked: !outcome.startsWith('ESCAPED'), detail: outcome });
    } catch (err) {
      results.push({ name, blocked: true, detail: `threw ${err instanceof Error ? err.message : String(err)}` });
    }
  }
  for (const [name, code] of REJECTED_SOURCES) {
    try {
      tools.evaluate(code, globals);
      results.push({ name, blocked: false, detail: 'the source was evaluated' });
    } catch (err) {
      results.push({ name, blocked: true, detail: `rejected: ${err instanceof Error ? err.message : String(err)}` });
    }
  }
  const pending: [string, unknown][] = [];
  for (const [name, code] of ASYNC_PROBES) {
    try {
      pending.push([name, tools.evaluate(code, globals)]);
    } catch (err) {
      results.push({ name, blocked: false, detail: `threw ${err instanceof Error ? err.message : String(err)}` });
    }
  }
  let hostPromiseSeen: unknown;
  try {
    hostPromiseSeen = tools.evaluate(HOST_PROMISE_PROBE, globals);
  } catch (err) {
    hostPromiseSeen = { error: err instanceof Error ? err.message : String(err) };
  }
  const rejection = tools.errorEvents ? startRejectionProbe(tools.evaluate, globals, tools.errorEvents) : null;
  await settle();
  const plainFacade = tools.toScript(plain);
  const field = (value: unknown, key: string): unknown => (isObjectLike(value) ? (value as Record<string, unknown>)[key] : undefined);
  for (const [name, seen] of pending) {
    const values = field(seen, 'values');
    // The species constructor runs (when the host follows the promise) and is handed only what a
    // resolving function returns: undefined. The host holds a promise of its own, never the script's.
    const ran = Array.isArray(values) && values.length > 0;
    const leaked = Array.isArray(values) ? values.filter((value) => value !== undefined) : [];
    const kept = received.includes(field(seen, 'promise'));
    results.push({
      name,
      blocked: ran && leaked.length === 0 && !kept,
      detail: !ran
        ? 'the species constructor never ran'
        : leaked.length
          ? `handed ${leaked.map((value) => (value === plain ? 'the raw host object' : value === plainFacade ? 'the facade' : typeof value)).join(', ')}`
          : kept
            ? "the host kept the script's own promise"
            : 'handed nothing',
    });
  }
  {
    const values = field(hostPromiseSeen, 'values');
    const ok = Array.isArray(values) && values.length === 1 && values[0] === plainFacade && field(hostPromiseSeen, 'promise') !== hostPromise;
    results.push({
      name: 'a host promise reaches a script as itself, or resolves to a host value',
      blocked: ok,
      detail: ok ? 'a promise of its own, resolving to the facade' : `got ${Array.isArray(values) ? values.map((value) => (value === plain ? 'the raw host object' : typeof value)).join(', ') || 'nothing' : String(field(hostPromiseSeen, 'error'))}`,
    });
  }
  if (rejection) results.push(rejection());

  const hostChecks: [name: string, escaped: boolean][] = [
    [
      'the host never holds a buffer carrying a script\'s properties',
      received.some(
        (value) =>
          isObjectLike(value) &&
          (Object.prototype.hasOwnProperty.call(value, 'scriptMarker') ||
            (ArrayBuffer.isView(value) && Object.prototype.hasOwnProperty.call(value.buffer, 'scriptMarker')))
      ),
    ],
    [
      'the host never holds a copy that unwraps to a host object as a reference',
      received.some((value) => isObjectLike(value) && Object.prototype.hasOwnProperty.call(value, '_ref')),
    ],
    ['no host function was written to through `this`', Object.prototype.hasOwnProperty.call(fn, 'x')],
    ['a host function never comes back to the host as itself', received.includes(fn)],
  ];
  for (const [name, escaped] of hostChecks) results.push({ name, blocked: !escaped, detail: escaped ? 'it did' : 'never' });

  const writable: object[] = [Object.prototype, Array.prototype, Function.prototype, Promise.prototype, Opaque.prototype];
  for (const value of [process, globalThis]) {
    const proto: object | null = Object.getPrototypeOf(value);
    if (proto) writable.push(proto);
  }
  const polluted = writable.some((proto) => Object.prototype.hasOwnProperty.call(proto, '__worldScriptProbe'));
  // Where a probe did get through, its marker must not outlive the test
  for (const proto of writable) {
    try {
      delete (proto as Record<string, unknown>).__worldScriptProbe;
    } catch {
      // frozen: nothing was written
    }
  }
  results.push({
    name: 'host prototypes unchanged after the probes',
    blocked: !polluted,
    detail: polluted ? 'a probe wrote to a host prototype' : 'unchanged',
  });
  // What the host caught must be an Error this side made, never the script's own object
  const safe = reported instanceof Error && Reflect.ownKeys(reported).every((key) => typeof key === 'string');
  results.push({
    name: 'what a script throws reaches the host as a plain Error',
    blocked: safe,
    detail: safe ? 'plain Error' : 'the host received the script\'s object',
  });
  const frozen = [Object.prototype, Function.prototype, Array.prototype, Promise.prototype, Error.prototype, Math, Reflect, JSON];
  results.push({
    name: 'language intrinsics are frozen',
    blocked: frozen.every((value) => Object.isFrozen(value)),
    detail: 'Object, Function, Array, Promise, Error prototypes, Math, Reflect, JSON',
  });
  return results;
}

/** The probes that got through. Empty means the sandbox may be used. */
export function failedProbes(results: ProbeResult[]): ProbeResult[] {
  return results.filter((result) => !result.blocked);
}

// ---- activation ----

/**
 * inactive  nothing may be evaluated
 * testing   locked down; only the self-test's compartments (createSelfTestCompartment) may exist
 * active    the self-test passed; world scripts may be evaluated (createScriptCompartment)
 */
let sandboxState: 'inactive' | 'testing' | 'active' = 'inactive';

export function isScriptSandboxActive(): boolean {
  return sandboxState === 'active';
}

export interface ActivationDeps {
  lockdown?: (options: typeof LOCKDOWN_OPTIONS) => void;
  /**
   * Guards the process's error events (lib/error-events.ts); called after lockdown, before the
   * self-test (src/index.ts may have installed the guard already; installing it again returns
   * that guard). Returns null when there is none.
   */
  guardErrorEvents?: () => ErrorEventGuard | null;
  /** Runs the self-test; called after lockdown and the guard */
  selfTest: (context: { errorEvents: ErrorEventGuard | null }) => ProbeResult[] | Promise<ProbeResult[]>;
  log?: Pick<Console, 'info' | 'error'>;
}

let activation: Promise<boolean> | null = null;

/**
 * Locks the realm down and proves it. Resolves to false, having said why, when lockdown threw or
 * any probe got through: the caller must then stop the process, because a realm that is half
 * tamed (or tamed but leaking) must not go on to run scripts, and it cannot be un-locked either.
 * Idempotent once it has succeeded; a call while an activation runs gets that activation's result.
 */
export function activateScriptSandbox(deps: ActivationDeps): Promise<boolean> {
  if (sandboxState === 'active') return Promise.resolve(true);
  if (activation) return activation;
  // Set before activate() runs: its synchronous part (lockdown, the self-test's start) may already
  // see a second caller
  let resolveActivation!: (ok: boolean) => void;
  const current = new Promise<boolean>((resolve) => {
    resolveActivation = resolve;
  });
  activation = current;
  void activate(deps).then(resolveActivation, () => resolveActivation(false)).finally(() => {
    if (activation === current) activation = null;
  });
  return current;
}

async function activate({
  lockdown: lock = lockdown,
  guardErrorEvents: guard = () => guardErrorEvents(),
  selfTest,
  log = console,
}: ActivationDeps): Promise<boolean> {
  try {
    lock(LOCKDOWN_OPTIONS);
  } catch (err) {
    log.error(`[Hyperfy] World scripts: SES lockdown failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
  sandboxState = 'testing';
  let results: ProbeResult[];
  try {
    const errorEvents = guard();
    results = await selfTest({ errorEvents });
  } catch (err) {
    sandboxState = 'inactive';
    log.error(`[Hyperfy] World scripts: the sandbox self-test could not run: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
  const failed = failedProbes(results);
  if (failed.length || results.length === 0) {
    sandboxState = 'inactive';
    if (!results.length) log.error('[Hyperfy] World scripts: the sandbox self-test ran no checks');
    for (const probe of failed) log.error(`[Hyperfy] World scripts: sandbox self-test FAILED: ${probe.name} (${probe.detail})`);
    return false;
  }
  sandboxState = 'active';
  log.info(`[Hyperfy] World scripts: sandbox self-test passed (${results.length} checks).`);
  return true;
}

// ---- unhandled rejections ----

let rejectionsLogged = false;

/**
 * Keeps the process alive when a promise is rejected and nobody handles it, and logs it as text.
 *
 * A script needs one line to cause that (`Promise.reject()`, or an async function that throws),
 * no membrane can prevent it, and without a listener Bun and Node end the process.
 *
 * This is process-wide: the agent's own unhandled rejections are logged and survived as well.
 * Other listeners still run. Like this one, they get an Error made from the reason's strings
 * instead of the reason itself (lib/error-events.ts, which says what it does not cover).
 */
export function surviveUnhandledRejections(log: Pick<Console, 'error'> = console): void {
  if (rejectionsLogged) return;
  rejectionsLogged = true;
  process.on('unhandledRejection', (reason) => {
    log.error(`[Hyperfy] Unhandled promise rejection (the agent keeps running): ${describeRejection(reason).slice(0, 4000)}`);
  });
}
