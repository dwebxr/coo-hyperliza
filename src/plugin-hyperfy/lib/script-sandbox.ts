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

export type WorldScriptsMode = 'off' | 'sandboxed';

/**
 * What `sandboxed` does not protect against. README.md quotes this text word for word
 * (script-sandbox.test.ts checks that it does).
 */
export const WORLD_SCRIPTS_RESIDUAL_RISK = [
  "A sandboxed world script still runs inside the agent's process, on its only thread.",
  'There is no CPU or memory isolation: `while (true) {}` hangs the agent for good, and a script can allocate until the process dies.',
  "A script can use everything the engine's script API offers it: create and move nodes, read every player's position, name and id, teleport, push, freeze and re-skin the agent's own avatar, send app events to the world's server, post to the agent's local chat view, make the agent download models and avatars from the world's own origin or from any public https URL it names (of a download it learns only whether it worked and, for a model, the names and positions of its parts), and with `fetch()` send whatever it can read to any public https host and read the answer.",
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
    `(() => { try { __probeHost.take({ _isRef: true, _ref: __probeHost.plain }) } catch { return 'refused' } return 'passed' })()`,
  ],
  [
    'a host function runs with an endowed function as its this',
    `(() => { try { __probeHost.setX.call(__probeHost.fn, 1) } catch { return 'refused' } return 'passed' })()`,
  ],
  [
    'a host function a script passes back reaches the host as itself',
    `(() => { try { __probeHost.take(__probeHost.fn) } catch {} return 'passed' })()`,
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
          return p
        })
      } catch {}
      return seen
    })()`,
  ],
];

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
}

const isObjectLike = (value: unknown): value is object =>
  value !== null && (typeof value === 'object' || typeof value === 'function');

/** Two turns of the event loop: every promise job a probe started has run */
const settle = () => new Promise<void>((resolve) => setTimeout(() => setTimeout(resolve, 0), 0));

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
      results.push({ name, blocked: true, detail: `threw ${err instanceof Error ? err.message : String(err)}` });
    }
  }
  await settle();
  const plainFacade = tools.toScript(plain);
  for (const [name, seen] of pending) {
    const values = (seen as { values?: unknown }).values;
    // Fixed: the species constructor is only ever handed the result of a resolving function (undefined)
    const leaked = Array.isArray(values) ? values.filter((value) => value !== undefined && value !== plainFacade) : ['no values'];
    results.push({
      name,
      blocked: leaked.length === 0,
      detail: leaked.length ? `handed ${leaked.map((value) => (value === plain ? 'the raw host object' : typeof value)).join(', ')}` : 'handed nothing',
    });
  }

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
  /** Builds the self-test tools; called after lockdown */
  selfTest: () => ProbeResult[] | Promise<ProbeResult[]>;
  log?: Pick<Console, 'info' | 'error'>;
}

/**
 * Locks the realm down and proves it. Resolves to false, having said why, when lockdown threw or
 * any probe got through: the caller must then stop the process, because a realm that is half
 * tamed (or tamed but leaking) must not go on to run scripts, and it cannot be un-locked either.
 * Idempotent once it has succeeded; a second call while the self-test runs is refused.
 */
export async function activateScriptSandbox({ lockdown: lock = lockdown, selfTest, log = console }: ActivationDeps): Promise<boolean> {
  if (sandboxState === 'active') return true;
  if (sandboxState === 'testing') {
    log.error('[Hyperfy] World scripts: the sandbox is already being activated');
    return false;
  }
  try {
    lock(LOCKDOWN_OPTIONS);
  } catch (err) {
    log.error(`[Hyperfy] World scripts: SES lockdown failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
  sandboxState = 'testing';
  let results: ProbeResult[];
  try {
    results = await selfTest();
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

function readText(value: object, key: string): string | null {
  try {
    const text = (value as Record<string, unknown>)[key];
    return typeof text === 'string' ? text : null;
  } catch {
    return null;
  }
}

/** A rejection reason as text, built from its name, message and stack strings and nothing else */
export function describeRejection(reason: unknown): string {
  if (reason === null || (typeof reason !== 'object' && typeof reason !== 'function')) return String(reason);
  const stack = readText(reason, 'stack');
  if (stack) return stack;
  const message = readText(reason, 'message');
  return message === null ? 'a value that is not an error' : `${readText(reason, 'name') ?? 'Error'}: ${message}`;
}

let rejectionsLogged = false;

/**
 * Keeps the process alive when a promise is rejected and nobody handles it, and logs it as text.
 *
 * A script needs one line to cause that (`Promise.reject()`, or an async function that throws),
 * no membrane can prevent it, and without a listener Bun and Node end the process. The reason is
 * an object of the script's choosing: it is never handed to console.*, whose formatter would call
 * its custom-inspect method with the runtime's own inspect function and options.
 *
 * This is process-wide: the agent's own unhandled rejections are logged and survived as well.
 * Other listeners still run. One that prints the reason with console.* (none is registered by
 * `elizaos start` as of 1.7.2) would run a script's inspect hook after all.
 */
export function surviveUnhandledRejections(log: Pick<Console, 'error'> = console): void {
  if (rejectionsLogged) return;
  rejectionsLogged = true;
  process.on('unhandledRejection', (reason) => {
    log.error(`[Hyperfy] Unhandled promise rejection (the agent keeps running): ${describeRejection(reason).slice(0, 4000)}`);
  });
}
