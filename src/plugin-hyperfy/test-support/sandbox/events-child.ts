/**
 * Entry of a child process (bundled and spawned by lib/script-sandbox.child.test.ts, under Bun and
 * Node): the guard of the process's error events (lib/error-events.ts) on the real process, with
 * the real activation (lockdown and self-test). argv: scenario file, report file.
 *
 * Listeners are registered before activation and after, in every way the process offers; a
 * compartment built as a world script's rejects promises with values whose inspect hooks report
 * being run, resolves a promise twice, handles a rejection late, and hands the host a value that a
 * timer then throws. The report says, per listener, how often it was called and how often with a
 * value the script made, and which hooks ran. Listener semantics (once, removal, listing, order)
 * are checked on uncaughtExceptionMonitor, which changes nothing about how the process behaves.
 *
 * The report is written when the process exits, so it is there also when the guard ends it.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { inspect } from 'node:util';
import { activateWorldScripts } from '../../lib/script-api';
import { createScriptCompartment, guardErrorEventsForWorldScripts, surviveUnhandledRejections } from '../../lib/script-sandbox';

export interface EventsScenario {
  /** Install the guard before anything registers, as src/index.ts does when world scripts are sandboxed */
  early: boolean;
  /** After activation, register a listener through process.on taken before the guard */
  capturedOn?: boolean;
  /** After activation, prepend a listener through process.prependListener taken before the guard */
  capturedPrepend?: boolean;
}

type Listener = (...args: unknown[]) => void;
const scenario: EventsScenario = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const calls: Record<string, number> = {};
const raw: Record<string, number> = {};
const hooks: string[] = [];
const logs: string[] = [];
const report: Record<string, unknown> = { runtime: (globalThis as { Bun?: unknown }).Bun ? 'bun' : 'node', calls, raw, hooks, logs };
process.on('exit', () => writeFileSync(process.argv[3], JSON.stringify(report)));

/** process.emit as it is now (the guard may have replaced it) */
const emit = (event: string, ...args: unknown[]): boolean => (process.emit as (event: string, ...args: unknown[]) => boolean).call(process, event, ...args);

const isScriptMade = (value: unknown): boolean => {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false;
  try {
    return Object.getOwnPropertySymbols(value).length > 0 || (value as { __scriptMade?: unknown }).__scriptMade === true;
  } catch {
    return true;
  }
};
/** A listener that counts its calls and prints what it gets, as elizaOS's Sentry integration does */
const listener = (tag: string): Listener => (...args) => {
  calls[tag] = (calls[tag] ?? 0) + 1;
  if (args.some(isScriptMade)) raw[tag] = (raw[tag] ?? 0) + 1;
  for (const arg of args) {
    try {
      inspect(arg);
    } catch {
      // what a printing listener does with a value it cannot print does not matter here
    }
  }
};

const same = (list: unknown[], expected: unknown[]) => list.length === expected.length && list.every((entry, i) => entry === expected[i]);

/** EventEmitter semantics for the functions registered, on an event that changes nothing */
function semantics(): Record<string, boolean> {
  const event = 'uncaughtExceptionMonitor';
  const base = process.listeners(event);
  const fired: string[] = [];
  const named = (name: string) => () => void fired.push(name);
  const [ordinary, prepended, once, removed] = ['ordinary', 'prepended', 'once', 'removed'].map(named);
  process.on(event, ordinary);
  process.prependListener(event, prepended);
  process.once(event, once);
  process.once(event, removed);
  const rawListed = process.rawListeners(event) as (Function & { listener?: unknown })[];
  const result: Record<string, boolean> = {
    listed: same(process.listeners(event), [prepended, ...base, ordinary, once, removed]),
    rawListedInNodeShape:
      same(rawListed.slice(0, base.length + 2), [prepended, ...base, ordinary]) &&
      rawListed.slice(-2).every((entry, i) => entry !== [once, removed][i] && entry.listener === [once, removed][i]),
    counted: process.listenerCount(event) === base.length + 4 && process.listenerCount(event, once) === 1,
  };
  process.removeListener(event, removed);
  result.removedBeforeFiring = same(process.listeners(event), [prepended, ...base, ordinary, once]);
  emit(event, new Error('first'), 'uncaughtException');
  emit(event, new Error('second'), 'uncaughtException');
  result.onceFiredOnce = fired.join() === 'prepended,ordinary,once,prepended,ordinary';
  result.onceGone = same(process.listeners(event), [prepended, ...base, ordinary]) && process.listenerCount(event, once) === 0;
  process.removeListener(event, ordinary);
  process.off(event, prepended);
  result.allRemoved = same(process.listeners(event), base);
  return result;
}

const capturedOn = process.on.bind(process);
const capturedPrepend = process.prependListener.bind(process);
if (scenario.early) report.early = guardErrorEventsForWorldScripts({ HYPERFY_WORLD_SCRIPTS: 'sandboxed' });

// ---- before activation ----
process.on('unhandledRejection', listener('before: on'));
process.once('unhandledRejection', listener('before: once'));
process.on('uncaughtExceptionMonitor', listener('before: uncaughtExceptionMonitor'));
if (scenario.early) report.semanticsBefore = semantics();

const activated = await activateWorldScripts({ info: (m: string) => void logs.push(`info: ${m}`), error: (m: string) => void logs.push(`error: ${m}`) });
report.activated = activated;
if (!activated) process.exit(0);
surviveUnhandledRejections({ error: () => {} });
report.semanticsAfter = semantics();

// ---- after activation ----
process.on('unhandledRejection', listener('after: on'));
process.prependListener('unhandledRejection', listener('after: prependListener'));
process.once('unhandledRejection', listener('after: once'));
const removable = listener('after: once, removed before it fired');
process.once('unhandledRejection', removable);
process.removeListener('unhandledRejection', removable);
(Object.getPrototypeOf(process) as EventEmitter).on.call(process, 'unhandledRejection', listener("after: the prototype's on"));
EventEmitter.prototype.on.call(process, 'unhandledRejection', listener('after: EventEmitter.prototype.on'));
for (const event of ['rejectionHandled', 'uncaughtException', 'uncaughtExceptionMonitor', 'multipleResolves']) process.on(event, listener(`after: ${event}`));
if (scenario.capturedOn) capturedOn('unhandledRejection', listener('after: process.on taken before the guard'));
if (scenario.capturedPrepend) capturedPrepend('unhandledRejection', listener('after: process.prependListener taken before the guard'));

// ---- a compartment, as a world script's ----
const compartment = createScriptCompartment({
  __hook: (tag: unknown) => void hooks.push(String(tag)),
  __later: (fn: () => void) => void setTimeout(fn, 20),
});
const MADE = `
  const INSPECT = Symbol.for('nodejs.util.inspect.custom')
  const made = (tag) => ({ __scriptMade: true, message: 'from a script: ' + tag, [INSPECT](depth, options, inspect) { __hook(tag + ':' + typeof inspect); return 'hooked' } })
`;
const thrown = compartment.evaluate(`${MADE}
  Promise.reject(made('reject'))
  Promise.reject({ __scriptMade: true, get stack() { return 'Error: from a getter' }, [INSPECT]() { __hook('getter'); return 'hooked' } })
  new Promise((resolve, reject) => { resolve(1); reject(made('multiple')) })
  const late = Promise.reject(made('late'))
  late.__scriptMade = true
  __later(() => late.catch(() => {}))
  made('thrown')
`);
await new Promise((resolve) => setTimeout(resolve, 80));
// A value a script made, thrown by the host (from a timer)
setTimeout(() => {
  throw thrown;
}, 0);
await new Promise((resolve) => setTimeout(resolve, 50));
// One more, after the once listeners have had theirs
compartment.evaluate(`${MADE} Promise.reject(made('second'))`);
await new Promise((resolve) => setTimeout(resolve, 50));
// A host module that emits by hand what it was given
emit('unhandledRejection', thrown, Promise.resolve());
await new Promise((resolve) => setTimeout(resolve, 50));
report.done = true;
process.exit(0);
