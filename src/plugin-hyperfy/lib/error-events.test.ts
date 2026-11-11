import { EventEmitter } from 'node:events';
import { inspect } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { type ErrorEventTarget, describeRejection, errorEventValue, guardErrorEvents } from './error-events';

// Emitters of their own stand for the process: this worker's process is never guarded. The real
// process (Node and Bun, under lockdown) is tested in script-sandbox.child.test.ts.
type Target = ErrorEventTarget & EventEmitter;

/** Delivers through emit(), as Node delivers the process's error events */
const nodeLike = () => new EventEmitter() as unknown as Target;

/**
 * Has its methods on a prototype of its own, as Bun's process does. A plain emitter's emit() calls
 * the stored listeners, which is what Bun does for these events (the guard leaves emit() alone).
 */
function bunLike(): Target {
  const prototype = Object.create(EventEmitter.prototype) as Record<string, unknown>;
  for (const name of ['on', 'addListener', 'prependListener', 'once', 'prependOnceListener', 'removeListener', 'off', 'listeners', 'rawListeners', 'listenerCount']) {
    prototype[name] = (EventEmitter.prototype as unknown as Record<string, unknown>)[name];
  }
  const target = Object.create(prototype) as Target;
  EventEmitter.call(target);
  return target;
}

const quiet = () => ({ log: { error: vi.fn() }, exit: vi.fn() });

/** A reason a script could hand the process: a custom-inspect hook that records being called */
function hookedReason() {
  const calls: unknown[][] = [];
  const reason = {
    message: 'from a script',
    [Symbol.for('nodejs.util.inspect.custom')](...args: unknown[]) {
      calls.push(args);
      return 'hooked';
    },
  };
  return { reason, calls };
}

/** A listener that records what it got and prints it, as elizaOS's Sentry integration does */
function recorder() {
  const got: [string, unknown, unknown][] = [];
  const listener = (name: string) => (reason: unknown, promise: unknown) => {
    got.push([name, reason, promise]);
    inspect(reason);
    inspect(promise);
  };
  return { got, listener };
}

function expectHostValues(got: [string, unknown, unknown][], scriptReason: unknown, scriptPromise: unknown) {
  for (const [name, received, promise] of got) {
    expect(received, name).toBeInstanceOf(Error);
    expect(received, name).not.toBe(scriptReason);
    expect((received as Error).message, name).toBe('from a script');
    expect(Object.getOwnPropertySymbols(received as object), name).toEqual([]);
    expect(promise, name).toBeInstanceOf(Promise);
    expect(promise, name).not.toBe(scriptPromise);
  }
}

describe('guardErrorEvents, where the runtime delivers through emit() (Node)', () => {
  it('hands every listener an Error and a promise of its own, however it was registered, and leaves registration alone', () => {
    const target = nodeLike();
    const { got, listener } = recorder();
    const onceBefore = listener('once, before');
    target.on('unhandledRejection', listener('on, before'));
    target.once('unhandledRejection', onceBefore);
    const capturedOn = target.on.bind(target);
    guardErrorEvents(target, { delivery: 'emit', ...quiet() });
    target.prependListener('unhandledRejection', listener('prependListener'));
    target.once('unhandledRejection', listener('once'));
    capturedOn('unhandledRejection', listener('captured on'));
    EventEmitter.prototype.on.call(target, 'unhandledRejection', listener('EventEmitter.prototype.on'));
    const { reason, calls } = hookedReason();
    const scriptPromise = Promise.resolve();

    expect(target.listeners('unhandledRejection')).toContain(onceBefore);
    target.emit('unhandledRejection', reason, scriptPromise);
    target.emit('unhandledRejection', reason, scriptPromise);

    expect(got.map(([name]) => name)).toEqual([
      'prependListener',
      'on, before',
      'once, before',
      'once',
      'captured on',
      'EventEmitter.prototype.on',
      'prependListener',
      'on, before',
      'captured on',
      'EventEmitter.prototype.on',
    ]);
    expectHostValues(got, reason, scriptPromise);
    expect(calls).toEqual([]);
  });

  it("guards multipleResolves, uncaughtException, uncaughtExceptionMonitor, rejectionHandled and the capture callback, and leaves other events' values alone", () => {
    const captured: unknown[] = [];
    const target = Object.assign(nodeLike(), {
      setUncaughtExceptionCaptureCallback: (callback: ((error: unknown) => void) | null) => void captured.push(callback),
      hasUncaughtExceptionCaptureCallback: () => captured.length > 0 && captured[captured.length - 1] !== null,
    });
    const guard = guardErrorEvents(target, { delivery: 'emit', ...quiet() });
    const got: unknown[][] = [];
    for (const event of ['uncaughtException', 'uncaughtExceptionMonitor', 'rejectionHandled', 'multipleResolves', 'exit']) {
      target.on(event, (...args: unknown[]) => void got.push([event, ...args]));
    }
    const { reason, calls } = hookedReason();
    const scriptPromise = Promise.resolve();

    target.emit('uncaughtException', reason, 'uncaughtException');
    target.emit('uncaughtExceptionMonitor', reason, { not: 'a string' });
    target.emit('rejectionHandled', scriptPromise);
    target.emit('multipleResolves', 'reject', scriptPromise, reason);
    target.emit('multipleResolves', 'resolve', scriptPromise, 42);
    target.emit('exit', reason);
    const seen: unknown[] = [];
    target.setUncaughtExceptionCaptureCallback((error) => void seen.push(error));
    (captured[0] as (error: unknown) => void)(reason);

    expect(got[0]).toEqual(['uncaughtException', expect.any(Error), 'uncaughtException']);
    expect(got[1]).toEqual(['uncaughtExceptionMonitor', expect.any(Error), 'uncaughtException']);
    expect(got[2][1]).toBeInstanceOf(Promise);
    expect(got[2][1]).not.toBe(scriptPromise);
    expect(got[3]).toEqual(['multipleResolves', 'reject', expect.any(Promise), expect.any(Error)]);
    expect(got[3][2]).not.toBe(scriptPromise);
    expect(got[4]).toEqual(['multipleResolves', 'resolve', expect.any(Promise), 42]);
    expect(got[5]).toEqual(['exit', reason]);
    expect(seen[0]).toBeInstanceOf(Error);
    expect(seen[0]).not.toBe(reason);
    expect(calls).toEqual([]);
    expect(guard.coversAllListeners()).toBe(true);
  });

  it('fails closed when a capture callback the guard did not set is there: logs once and exits before handing the event on', () => {
    let capture: unknown = null;
    const target = Object.assign(nodeLike(), {
      setUncaughtExceptionCaptureCallback: (callback: unknown) => void (capture = callback),
      hasUncaughtExceptionCaptureCallback: () => capture !== null,
    });
    const setThroughAReferenceFromBefore = target.setUncaughtExceptionCaptureCallback;
    const { log, exit } = quiet();
    const guard = guardErrorEvents(target, { delivery: 'emit', log, exit });
    const listener = vi.fn();
    target.on('uncaughtExceptionMonitor', listener);
    const { reason } = hookedReason();

    target.setUncaughtExceptionCaptureCallback(() => {});
    target.emit('uncaughtExceptionMonitor', reason, 'uncaughtException');
    expect(guard.coversAllListeners()).toBe(true);
    expect(exit).not.toHaveBeenCalled();

    target.setUncaughtExceptionCaptureCallback(null);
    setThroughAReferenceFromBefore(() => {});
    target.emit('uncaughtExceptionMonitor', reason, 'uncaughtException');
    target.emit('uncaughtExceptionMonitor', reason, 'uncaughtException');

    expect(guard.coversAllListeners()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error.mock.calls[0][0]).toContain('the uncaught-exception capture callback is registered past the error-event guard');
  });

  it('delivers one reason to one listener only while the self-test asks for it', () => {
    const target = nodeLike();
    const guard = guardErrorEvents(target, { delivery: 'emit', ...quiet() });
    const probe = vi.fn();
    const other = vi.fn();
    target.on('unhandledRejection', other);
    target.on('unhandledRejection', probe);
    const reason = { message: 'probe' };

    guard.deliverOnlyTo(reason, probe);
    target.emit('unhandledRejection', reason, Promise.resolve());
    target.emit('unhandledRejection', { message: 'another' }, Promise.resolve());
    guard.deliverOnlyTo(null);
    target.emit('unhandledRejection', reason, Promise.resolve());

    expect(probe).toHaveBeenCalledTimes(3);
    expect(probe.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(other).toHaveBeenCalledTimes(2);
  });
});

describe('guardErrorEvents, where the runtime calls the stored listeners itself (Bun)', () => {
  it('hands every listener an Error and a promise of its own: those there before, and those registered later, also through the prototype', () => {
    const target = bunLike();
    const { got, listener } = recorder();
    target.on('unhandledRejection', listener('on, before'));
    target.once('unhandledRejection', listener('once, before'));
    guardErrorEvents(target, { delivery: 'listeners', ...quiet() });
    target.on('unhandledRejection', listener('on'));
    target.addListener('unhandledRejection', listener('addListener'));
    target.prependListener('unhandledRejection', listener('prependListener'));
    target.once('unhandledRejection', listener('once'));
    target.prependOnceListener('unhandledRejection', listener('prependOnceListener'));
    (Object.getPrototypeOf(target) as Target).on.call(target, 'unhandledRejection', listener('prototype on'));
    const { reason, calls } = hookedReason();
    const scriptPromise = Promise.resolve();

    target.emit('unhandledRejection', reason, scriptPromise);
    target.emit('unhandledRejection', reason, scriptPromise);

    expect(got.map(([name]) => name)).toEqual([
      'prependOnceListener',
      'prependListener',
      'on, before',
      'once, before',
      'on',
      'addListener',
      'once',
      'prototype on',
      'prependListener',
      'on, before',
      'on',
      'addListener',
      'prototype on',
    ]);
    expectHostValues(got, reason, scriptPromise);
    expect(calls).toEqual([]);
  });

  it("keeps EventEmitter's semantics for the functions registered: once, removal, listing, raw listing, counting, order", () => {
    const target = bunLike();
    const event = 'uncaughtExceptionMonitor';
    const before = vi.fn();
    const onceBefore = vi.fn();
    target.on(event, before);
    target.once(event, onceBefore);
    guardErrorEvents(target, { delivery: 'listeners', ...quiet() });
    const after = vi.fn();
    const onceAfter = vi.fn();
    const prepended = vi.fn();
    const removedBeforeFiring = vi.fn();
    target.on(event, after);
    target.once(event, onceAfter);
    target.prependListener(event, prepended);
    target.once(event, removedBeforeFiring);

    expect(target.listeners(event)).toEqual([prepended, before, onceBefore, after, onceAfter, removedBeforeFiring]);
    const raw = target.rawListeners(event) as (Function & { listener?: Function })[];
    expect(raw.map((entry) => entry.listener ?? entry)).toEqual([prepended, before, onceBefore, after, onceAfter, removedBeforeFiring]);
    // Node's shape: an ordinary listener as itself, a once listener as a function whose `listener` it is
    expect([raw[0], raw[1], raw[3]]).toEqual([prepended, before, after]);
    expect([raw[2], raw[4], raw[5]].map((entry) => entry !== entry.listener && typeof entry.listener === 'function')).toEqual([true, true, true]);
    expect(target.listenerCount(event)).toBe(6);
    expect(target.listenerCount(event, onceAfter)).toBe(1);
    expect(target.listenerCount(event, after)).toBe(1);

    target.removeListener(event, removedBeforeFiring);
    target.emit(event, new Error('first'), 'uncaughtException');
    target.emit(event, new Error('second'), 'uncaughtException');

    expect(removedBeforeFiring).not.toHaveBeenCalled();
    expect(onceBefore).toHaveBeenCalledTimes(1);
    expect(onceAfter).toHaveBeenCalledTimes(1);
    expect([before, after, prepended].map((fn) => fn.mock.calls.length)).toEqual([2, 2, 2]);
    expect(target.listeners(event)).toEqual([prepended, before, after]);
    expect(target.listenerCount(event)).toBe(3);
    expect(target.listenerCount(event, onceAfter)).toBe(0);
    expect(target.listenerCount(event, before)).toBe(1);

    // A raw once listener called by hand runs once and goes, as in Node
    const manual = vi.fn();
    target.once(event, manual);
    const wrapper = target.rawListeners(event)[3] as Function;
    wrapper(new Error('by hand'));
    wrapper(new Error('again'));
    expect(manual).toHaveBeenCalledTimes(1);
    expect(manual.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(target.listeners(event)).toEqual([prepended, before, after]);

    target.off!(event, before);
    target.removeListener(event, after);
    target.removeListener(event, prepended);
    expect(target.listenerCount(event)).toBe(0);
  });

  it('fails closed on a listener registered through a method reference taken before the guard: logs once, exits before that listener is called', () => {
    const target = bunLike();
    const capturedOn = target.on;
    const order: string[] = [];
    const log = { error: vi.fn() };
    const exit = vi.fn(() => void order.push('exit'));
    const guard = guardErrorEvents(target, { delivery: 'listeners', log, exit });
    const guarded = vi.fn(() => void order.push('guarded'));
    const past = vi.fn(() => void order.push('past'));
    target.on('unhandledRejection', guarded);
    expect(guard.coversAllListeners()).toBe(true);

    Reflect.apply(capturedOn, target, ['unhandledRejection', past]);
    const { reason } = hookedReason();
    target.emit('unhandledRejection', reason, Promise.resolve());
    target.emit('unhandledRejection', reason, Promise.resolve());

    expect(guard.coversAllListeners()).toBe(false);
    // Here exit() returns, so the emitter goes on to `past`; the real exit never returns
    expect(order).toEqual(['exit', 'past', 'exit', 'past']);
    expect(exit).toHaveBeenCalledWith(1);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error.mock.calls[0][0]).toContain('a process unhandledRejection listener is registered past the error-event guard');
  });

  it.each(['rejectionHandled', 'uncaughtExceptionMonitor', 'multipleResolves'])(
    'fails closed on %s too when the only listener there was registered past the guard, and lists no listener of its own',
    (event) => {
      const target = bunLike();
      const capturedOn = target.on;
      const order: string[] = [];
      const log = { error: vi.fn() };
      const exit = vi.fn(() => void order.push('exit'));
      const guard = guardErrorEvents(target, { delivery: 'listeners', log, exit });
      expect(target.listenerCount(event)).toBe(0);
      expect(target.listeners(event)).toEqual([]);
      expect(target.rawListeners(event)).toEqual([]);

      const past = vi.fn(() => void order.push('past'));
      Reflect.apply(capturedOn, target, [event, past]);
      target.emit(event, hookedReason().reason, Promise.resolve(), hookedReason().reason);

      expect(guard.coversAllListeners()).toBe(false);
      // Here exit() returns, so the emitter goes on to `past`; the real exit never returns
      expect(order).toEqual(['exit', 'past']);
      expect(log.error.mock.calls[0][0]).toContain(`a process ${event} listener is registered past the error-event guard`);
    }
  );

  it('delivers one reason to one listener only while the self-test asks for it, and leaves other events alone', () => {
    const target = bunLike();
    const guard = guardErrorEvents(target, { delivery: 'listeners', ...quiet() });
    const probe = vi.fn();
    const other = vi.fn();
    const exitListener = vi.fn();
    target.on('unhandledRejection', other);
    target.on('unhandledRejection', probe);
    target.on('exit', exitListener);
    const reason = { message: 'probe' };

    guard.deliverOnlyTo(reason, probe);
    target.emit('unhandledRejection', reason, Promise.resolve());
    guard.deliverOnlyTo(null);
    target.emit('unhandledRejection', reason, Promise.resolve());
    target.emit('exit', reason);

    expect(probe).toHaveBeenCalledTimes(2);
    expect(other).toHaveBeenCalledTimes(1);
    expect(exitListener).toHaveBeenCalledWith(reason);
    expect(target.listeners('exit')).toEqual([exitListener]);
    expect(guardErrorEvents(target)).toBe(guard);
  });
});

describe('errorEventValue', () => {
  it('survives reasons that throw, trap or are not objects, reading only their strings', () => {
    const traps = vi.fn();
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();
    const reasons: unknown[] = [
      new Proxy({}, { get: () => { traps(); throw new Error('trap'); }, getPrototypeOf: () => { traps(); return null; } }),
      { get message() { throw new Error('getter'); }, get stack() { return { not: 'a string' }; } },
      function scriptFunction() {},
      revocable.proxy,
      'a string',
      42,
      undefined,
      Symbol('s'),
    ];

    const made = reasons.map(errorEventValue);

    for (const value of made) expect(value).toBeInstanceOf(Error);
    expect(made.map((error) => error.message)).toEqual([
      'a value that is not an error',
      'a value that is not an error',
      'a function',
      'a value that is not an error',
      'a string',
      '42',
      'undefined',
      'Symbol(s)',
    ]);
  });

  it('keeps name, stack and code strings of an error, and nothing else of it', () => {
    const original = Object.assign(new TypeError('boom'), { code: 'ECONNRESET', secret: { token: 'x' }, cause: new Error('inner') });

    const made = errorEventValue(original);

    expect(made).not.toBe(original);
    expect(made.name).toBe('TypeError');
    expect(made.message).toBe('boom');
    expect(made.stack).toBe(original.stack);
    expect((made as Error & { code?: unknown }).code).toBe('ECONNRESET');
    expect((made as Error & { secret?: unknown }).secret).toBeUndefined();
    expect(made.cause).toBeUndefined();
    expect(describeRejection(made)).toBe(original.stack);
  });
});
