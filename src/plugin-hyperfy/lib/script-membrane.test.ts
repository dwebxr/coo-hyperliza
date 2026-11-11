import { describe, expect, it } from 'vitest';
import { createScriptMembrane } from './script-membrane';

// The test plays the script: whatever toScript() returns is all a script would hold. (The realm is
// not locked down here; the escapes that depend on lockdown are tested in script-sandbox.child.test.ts.)

class World {
  network = { send() {} };
}
class Vec {
  x = 0;
  _secret = 'internal';
  _onChange(fn: () => void) {
    this._callback = fn;
  }
  _callback: (() => void) | undefined;
  set(x: number) {
    this.x = x;
    return this;
  }
  get double() {
    return this.x * 2;
  }
  static UNIT = 'm';
}
class OtherVec {
  x = 7;
}

const membrane = () => createScriptMembrane({ classes: [{ name: 'Vec', ctor: Vec, aliases: [OtherVec] }] });
const script = <T>(value: T) => membrane().toScript(value) as any;

describe('host values shown to a script', () => {
  it('turns an instance of any class that is not listed into a frozen, empty token', () => {
    const world = new World();
    const seen = script({ world, map: new Map([[1, world]]), blob: new Blob(['x']) });

    for (const value of [seen.world, seen.map, seen.blob]) {
      expect(Reflect.ownKeys(value)).toEqual([]);
      expect(Object.isFrozen(value)).toBe(true);
      expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
      expect(value.network).toBeUndefined();
    }
  });

  it('does not show globalThis, process or process.env', () => {
    const seen = script({ g: globalThis, p: process, env: process.env });
    expect(Reflect.ownKeys(seen.g)).toEqual([]);
    expect(Reflect.ownKeys(seen.p)).toEqual([]);
    expect(Reflect.ownKeys(seen.env)).toEqual([]);
    expect(process.env.PATH).toEqual(expect.any(String));
    expect(seen.env.PATH).toBeUndefined();
    for (const value of [seen.g, seen.p, seen.env]) expect(Object.isFrozen(value)).toBe(true);
  });

  it('does not show process.env where it has the shape of a plain object, which any other object of that shape is shown as', () => {
    const real = process.env;
    // In this test runner process.env is no plain object; in other runtimes it is one
    const plain = { PATH: '/usr/bin', SECRET_KEY: 'a secret' };
    process.env = plain;
    try {
      const m = membrane();
      const seen = m.toScript({ env: process.env, other: { ...plain } }) as any;
      expect(seen.other.SECRET_KEY).toBe('a secret');
      expect(seen.env.SECRET_KEY).toBeUndefined();
      expect(Reflect.ownKeys(seen.env)).toEqual([]);
      expect(Object.isFrozen(seen.env)).toBe(true);
    } finally {
      process.env = real;
    }
    expect(process.env).toBe(real);
  });

  it('does not turn a token back into the object it stands for', () => {
    const m = membrane();
    const world = new World();
    let received: unknown = 'not called';
    const api = m.toScript({ world, take: (value: unknown) => void (received = value) }) as any;

    api.take(api.world);

    expect(received).toBeUndefined();
  });

  it('shows a plain object live, through own properties only', () => {
    const host: Record<string, unknown> = { a: 1, nested: { b: 2 } };
    const seen = script(host);

    expect(seen.a).toBe(1);
    expect(seen.nested.b).toBe(2);
    host.a = 5;
    expect(seen.a).toBe(5);
    seen.c = { d: [1, 2] };
    expect(host.c).toEqual({ d: [1, 2] });
    expect(Object.keys(seen)).toEqual(['a', 'nested', 'c']);
    expect(JSON.stringify(seen)).toBe('{"a":5,"nested":{"b":2},"c":{"d":[1,2]}}');
    expect(seen.nested).toBe(seen.nested);
    // Inherited names come from the script's own Object.prototype, not from the host object
    expect(seen.constructor).toBe(Object);
    expect(seen.hasOwnProperty('a')).toBe(true);
  });

  it('refuses to change the prototype of a host object or to define properties on it', () => {
    const host = { a: 1 };
    const seen = script(host);

    expect(Reflect.set(seen, '__proto__', { evil: true })).toBe(false);
    expect(Reflect.setPrototypeOf(seen, { evil: true })).toBe(false);
    expect(Reflect.defineProperty(seen, 'x', { get: () => 1 })).toBe(false);
    expect(Object.getPrototypeOf(host)).toBe(Object.prototype);
    expect(Object.keys(host)).toEqual(['a']);
  });

  it('shows an array live, with the script\'s own array methods', () => {
    const host = [1, { n: 2 }, new World()];
    const seen = script(host);

    expect(Array.isArray(seen)).toBe(true);
    expect(seen.length).toBe(3);
    expect(seen[1].n).toBe(2);
    expect(Reflect.ownKeys(seen[2])).toEqual([]);
    seen.push('x');
    expect(host[3]).toBe('x');
    expect(seen.map((item: unknown) => typeof item)).toEqual(['number', 'object', 'object', 'string']);
    expect([...seen].length).toBe(4);
  });

  it('wraps host functions: arguments are copied, the result is converted, the function object is frozen', () => {
    const m = membrane();
    const received: unknown[] = [];
    const api = m.toScript({
      call(arg: unknown) {
        received.push(arg);
        return { world: new World(), echo: arg };
      },
    }) as any;
    const mine = { a: 1, get b() { return 2; }, [Symbol.for('nodejs.util.inspect.custom')]() { return 'x'; } };

    const result = api.call(mine);

    expect(received[0]).toEqual({ a: 1, b: 2 });
    expect(received[0]).not.toBe(mine);
    expect(Object.getOwnPropertySymbols(received[0] as object)).toEqual([]);
    expect(Object.getOwnPropertyDescriptor(received[0] as object, 'b')).toMatchObject({ value: 2 });
    expect(Reflect.ownKeys(result.world)).toEqual([]);
    expect(Object.isFrozen(api.call)).toBe(true);
    expect(() => new api.call()).toThrow(TypeError);
  });

  it('rebuilds what the host throws as a plain error with the same class and message', () => {
    const api = script({
      fail() {
        throw Object.assign(new RangeError('too far'), { world: new World(), cause: new World() });
      },
    });

    let caught: any;
    try {
      api.fail();
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(RangeError);
    expect(caught.message).toBe('too far');
    expect(caught.world).toBeUndefined();
    expect(caught.cause).toBeUndefined();
  });

  it('converts what a host promise resolves to or rejects with', async () => {
    const api = script({
      load: async () => ({ node: new World(), ok: true }),
      fail: async () => {
        throw Object.assign(new Error('nope'), { world: new World() });
      },
    });

    const loaded = await api.load();
    expect(loaded.ok).toBe(true);
    expect(Reflect.ownKeys(loaded.node)).toEqual([]);
    const error: any = await api.fail().catch((err: unknown) => err);
    expect(error.message).toBe('nope');
    expect(error.world).toBeUndefined();
  });

  it('refuses to call the host\'s evaluators, fetch and timers even when an object exposes them', () => {
    const api = script({ Function, eval, fetch: globalThis.fetch, setTimeout, setInterval, queueMicrotask });

    for (const name of ['Function', 'eval', 'fetch', 'setTimeout', 'setInterval', 'queueMicrotask']) {
      expect(() => api[name]('return process')).toThrow('not available to world scripts');
    }
  });
});

describe('instances of listed classes', () => {
  it('are constructed through the script-facing class and are instances of it', () => {
    const m = membrane();
    const ScriptVec = m.scriptClass('Vec') as any;

    const v = new ScriptVec();

    expect(v instanceof ScriptVec).toBe(true);
    expect(v.set(3)).toBe(v);
    expect(v.x).toBe(3);
    expect(v.double).toBe(6);
    expect(v.constructor).toBe(ScriptVec);
    expect(ScriptVec.UNIT).toBe('m');
    expect(() => ScriptVec()).toThrow(TypeError);
    expect(m.toHost(v)).toBeInstanceOf(Vec);
  });

  it('hide "_" names, so a script cannot read internals or take over a change callback', () => {
    const host = new Vec();
    const seen = script(host);

    expect(seen._secret).toBeUndefined();
    expect(seen._onChange).toBeUndefined();
    expect('_onChange' in seen).toBe(false);
    expect(Object.keys(seen)).toEqual(['x']);
    expect(Reflect.set(seen, '_callback', () => {})).toBe(false);
    expect(host._callback).toBeUndefined();
  });

  it('accept new values for existing fields only: no new properties, no method replaced', () => {
    const host = new Vec();
    const seen = script(host);

    expect(Reflect.set(seen, 'x', 9)).toBe(true);
    expect(host.x).toBe(9);
    expect(Reflect.set(seen, 'set', () => 'hijacked')).toBe(false);
    expect(Reflect.set(seen, 'extra', 1)).toBe(false);
    expect(Reflect.deleteProperty(seen, 'x')).toBe(false);
    expect(Object.keys(host)).toEqual(['x', '_secret', '_callback']);
    expect(host.set).toBe(Vec.prototype.set);
  });

  it('share a frozen script-side prototype: the host class prototype is out of reach', () => {
    const m = membrane();
    const proto = Object.getPrototypeOf(m.toScript(new Vec()));

    expect(proto).not.toBe(Vec.prototype);
    expect(Object.isFrozen(proto)).toBe(true);
    expect(() => {
      'use strict';
      proto.set = () => {};
    }).toThrow(TypeError);
    expect(Object.getPrototypeOf(m.toScript(new OtherVec()))).toBe(proto);
  });

  it('are opaque when they are instances of a subclass', () => {
    class Sub extends Vec {
      world = new World();
    }
    expect(Reflect.ownKeys(script(new Sub()))).toEqual([]);
  });
});

describe('script values given to the host', () => {
  it('copies objects once, so a getter cannot answer differently later and runs before the host call', () => {
    const m = membrane();
    let reads = 0;
    let received: any;
    const api = m.toScript({ take: (value: unknown) => void (received = value) }) as any;

    api.take({ get n() { return ++reads; }, list: [1, { deep: true }] });

    expect(reads).toBe(1);
    expect(received.n).toBe(1);
    expect(received.n).toBe(1);
    expect(received.list).toEqual([1, { deep: true }]);
    expect(Object.getPrototypeOf(received)).toBe(Object.prototype);
  });

  it('keeps a key named __proto__ as data instead of setting the copy\'s prototype', () => {
    const m = membrane();
    const copy = m.toHost(JSON.parse('{"__proto__": {"polluted": true}, "a": 1}')) as any;

    expect(Object.getPrototypeOf(copy)).toBe(Object.prototype);
    expect(copy.polluted).toBeUndefined();
    expect(Object.keys(copy)).toEqual(['__proto__', 'a']);
  });

  it('wraps callbacks: host arguments are converted, `this` is dropped, the same wrapper is reused', () => {
    const m = membrane();
    const world = new World();
    const seen: unknown[] = [];
    function callback(this: unknown, ...args: any[]) {
      seen.push(this, ...args);
      return { fromScript: true };
    }

    const hostFn = m.toHost(callback) as (...args: unknown[]) => unknown;
    const result = hostFn.call(world, world, { ctx: { world } });

    expect(seen[0]).toBeUndefined();
    expect(Reflect.ownKeys(seen[1] as object)).toEqual([]);
    expect(Reflect.ownKeys((seen[2] as any).ctx.world)).toEqual([]);
    expect(result).toEqual({ fromScript: true });
    expect(m.toHost(callback)).toBe(hostFn);
    // Coming back, it is the script's own function again (app.off needs that)
    expect(m.toScript(hostFn)).toBe(callback);
  });

  it('rethrows what a callback throws as a fresh Error with strings only, and hands the script its own object back', () => {
    const m = membrane();
    const thrown = { message: 'boom', secret: 1, [Symbol.for('nodejs.util.inspect.custom')]: () => 'x' };
    const hostFn = m.toHost(() => {
      throw thrown;
    }) as () => void;

    let hostSaw: any;
    try {
      hostFn();
    } catch (err) {
      hostSaw = err;
    }
    expect(hostSaw).toBeInstanceOf(Error);
    expect(hostSaw.message).toBe('boom');
    expect(hostSaw.secret).toBeUndefined();
    expect(Object.getOwnPropertySymbols(hostSaw)).toEqual([]);

    // The host lets it propagate back out through a host function the script called
    const api = m.toScript({ run: (fn: () => void) => fn() }) as any;
    let scriptSaw: unknown;
    try {
      api.run(() => {
        throw thrown;
      });
    } catch (err) {
      scriptSaw = err;
    }
    expect(scriptSaw).toBe(thrown);
  });

  it('reports an async callback\'s rejection instead of leaving it unhandled', async () => {
    const errors: Error[] = [];
    const m = createScriptMembrane({ onAsyncError: (error) => errors.push(error) });
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', listener);
    try {
      const hostFn = m.toHost(async () => {
        throw { message: 'async boom', secret: 1 };
      }) as () => unknown;

      hostFn();
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(errors.map((error) => error.message)).toEqual(['async boom']);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', listener);
    }
  });

  it('refuses values too deep to copy instead of overflowing the stack', () => {
    const m = membrane();
    let deep: any = {};
    for (let i = 0; i < 100; i++) deep = { deep };
    expect(() => m.toHost(deep)).toThrow('too large or too deeply nested');
  });

  it('refuses a value of more objects than it copies (100,000), and copies one just within that', () => {
    const m = membrane();
    const wide = (count: number) => Array.from({ length: count }, () => ({}));
    // The array itself is one of them
    expect(m.toHost(wide(99_999))).toHaveLength(99_999);
    expect(() => m.toHost(wide(100_000))).toThrow('too large or too deeply nested');
  });

  it('refuses an array longer than what is left of that budget, also one of primitives, instead of cutting it short', () => {
    const m = membrane();
    expect(m.toHost(new Array(99_999).fill(7))).toHaveLength(99_999);
    expect(() => m.toHost(new Array(100_000).fill(7))).toThrow('too large or too deeply nested');
    expect(() => m.toHost(new Array(2_000_000).fill(7))).toThrow('too large or too deeply nested');
    // Each array against what is left of the budget when it is reached (primitives themselves are
    // not counted: two arrays of 60,000 numbers fit, an array after two objects that leaves too little does not)
    expect(() => m.toHost({ a: new Array(60_000).fill(1), b: new Array(60_000).fill(1) })).not.toThrow();
    expect(() => m.toHost([{}, new Array(99_998).fill(1)])).toThrow('too large or too deeply nested');
  });

  it('copies cyclic values without looping', () => {
    const m = membrane();
    const a: any = { name: 'a' };
    a.self = a;
    const copy = m.toHost(a) as any;
    expect(copy.self).toBe(copy);
    expect(copy).not.toBe(a);
  });

  it('copies bytes instead of sharing the buffer', () => {
    const m = membrane();
    const bytes = new Uint8Array([1, 2, 3]);
    const copy = m.toHost(bytes) as Uint8Array;

    expect(copy).toBeInstanceOf(Uint8Array);
    expect([...copy]).toEqual([1, 2, 3]);
    copy[0] = 9;
    expect(bytes[0]).toBe(1);
    expect((m.toScript(bytes) as Uint8Array).buffer).not.toBe(bytes.buffer);
  });
});

describe('call guards and dynamic facades', () => {
  it('runs the guard for a property\'s function with host arguments, before the call', () => {
    const calls: unknown[] = [];
    const node = { add: (child: unknown) => void calls.push(child) };
    const m = createScriptMembrane({
      guardFor: (owner, prop) =>
        owner === node && prop === 'add'
          ? (args) => {
              if (args[0] !== node) throw new TypeError('expects a node');
            }
          : undefined,
    });
    const seen = m.toScript(node) as any;

    expect(() => seen.add({ activate() {} })).toThrow('expects a node');
    expect(calls).toEqual([]);
    seen.add(seen);
    expect(calls).toEqual([node]);
  });

  it('exposes only the allowed names of a dynamic object', () => {
    const m = membrane();
    const host = new Proxy(
      {},
      {
        get: (_target, prop) => (prop === 'constructor' ? new World() : prop === 'position' ? { x: 1 } : undefined),
      }
    );

    const seen = m.exposeDynamic(host, (prop) => !(prop in Object.prototype)) as any;

    expect(seen.position.x).toBe(1);
    expect(seen.constructor).toBe(Object);
    expect(seen.unknown).toBeUndefined();
    expect(m.toHost(seen)).toBe(host);
  });
});

// ---- No built-in on a script's value may choose what runs (the P1a2 review's S-01 ... S-07) ----

/** Lets every promise job that has been queued run */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A promise of the script's that resolves to `value`, with a species constructor that records what it is handed */
function speciesPromise(value: unknown, handed: unknown[]) {
  const p = Promise.resolve(value);
  Object.defineProperty(p, 'constructor', {
    value: {
      [Symbol.species]: function (executor: (resolve: (v: unknown) => void, reject: () => void) => void) {
        executor((v) => void handed.push(v), () => {});
        // A real promise, so that whatever the host calls then() on next does not throw
        return Promise.resolve();
      },
    },
  });
  return p;
}

describe('promises a script passes to the host (S-01)', () => {
  it('are followed without calling then() on them: a species constructor is handed nothing of the host', async () => {
    const m = membrane();
    const secret = { network: 'raw host object' };
    let received: unknown;
    const api = m.toScript({ secret, take: (value: unknown) => void (received = value) }) as any;
    const handed: unknown[] = [];

    api.take(speciesPromise(api.secret, handed));
    await settle();

    // The host got a promise of its own that resolves to the host object
    expect(received).toBeInstanceOf(Promise);
    expect(await received).toBe(secret);
    // ...and the species constructor, which did run, had its resolve function handed nothing:
    // then() called on the script's promise hands it the raw host object
    expect(handed.includes(secret)).toBe(false);
    expect(handed).toEqual([undefined]);
  });

  it('are followed without calling then() on them when a callback returns one', async () => {
    const m = membrane();
    const secret = { network: 'raw host object' };
    const api = m.toScript({ secret }) as any;
    const handed: unknown[] = [];
    const hostFn = m.toHost(() => speciesPromise(api.secret, handed)) as () => Promise<unknown>;

    const result = hostFn();
    await settle();

    expect(await result).toBe(secret);
    expect(handed.includes(secret)).toBe(false);
    // The species constructor did run
    expect(handed).toEqual([undefined]);
  });

  it('reject with an Error the host made, never the script\'s own value, when copying their result throws', async () => {
    const m = membrane();
    let received: unknown;
    const api = m.toScript({ take: (value: unknown) => void (received = value) }) as any;
    const thrown = { message: 'from a getter', [Symbol.for('nodejs.util.inspect.custom')]: () => 'hooked' };

    api.take(Promise.resolve({ get x() { throw thrown; } }));
    const reason = await (received as Promise<unknown>).catch((err: unknown) => err);

    expect(reason).toBeInstanceOf(Error);
    expect(reason).not.toBe(thrown);
    expect((reason as Error).message).toBe('from a getter');
    expect(Object.getOwnPropertySymbols(reason as object)).toEqual([]);
  });

  it('settle when their then is not callable, instead of being followed forever', async () => {
    const m = membrane();
    let received: unknown;
    const api = m.toScript({ take: (value: unknown) => void (received = value) }) as any;
    const p = Promise.resolve(1);
    Object.defineProperty(p, 'then', { value: 'not a function' });

    api.take(p);

    expect(await received).toBeUndefined();
  });

  it('reach the host as a promise of its own even when they are only shaped like one', async () => {
    const m = membrane();
    let received: unknown;
    const api = m.toScript({ take: (value: unknown) => void (received = value) }) as any;

    api.take(Object.create(Promise.prototype));

    expect(received).toBeInstanceOf(Promise);
    await expect(received).rejects.toBeInstanceOf(TypeError);
  });
});

describe('binary data a script passes to the host (S-02)', () => {
  it('is copied into a buffer of the host: a species constructor is never asked for one', () => {
    const m = membrane();
    const received: unknown[] = [];
    const api = m.toScript({ take: (value: unknown) => void received.push(value) }) as any;
    const kept = new ArrayBuffer(4);
    (kept as any).activate = () => {};
    let asked = 0;
    const evil = new ArrayBuffer(4);
    new Uint8Array(evil)[0] = 7;
    Object.defineProperty(evil, 'constructor', {
      value: {
        [Symbol.species]: function () {
          asked++;
          return kept;
        },
      },
    });

    api.take(evil);
    api.take(new Uint8Array(evil, 1, 2));
    api.take(new DataView(evil));

    expect(asked).toBe(0);
    const [buffer, view, dataView] = received as [ArrayBuffer, Uint8Array, DataView];
    expect(buffer).not.toBe(kept);
    expect(buffer).not.toBe(evil);
    expect(Object.keys(buffer)).toEqual([]);
    expect([...new Uint8Array(buffer)]).toEqual([7, 0, 0, 0]);
    expect(view).toBeInstanceOf(Uint8Array);
    expect(view.buffer).not.toBe(evil);
    expect(view.byteLength).toBe(2);
    expect(dataView).toBeInstanceOf(DataView);
    expect(dataView.buffer).not.toBe(evil);
    // A later change to the script's buffer is not seen by the host
    new Uint8Array(evil)[0] = 9;
    expect(new Uint8Array(buffer)[0]).toBe(7);
  });
});

describe('functions crossing back to the host (S-06)', () => {
  function setX(this: Record<string, unknown>, x: unknown) {
    this.x = x;
  }

  it('never come back as the raw host function: a callable or a class reaches the host as a wrapper', () => {
    const m = createScriptMembrane({ classes: [{ name: 'Vec', ctor: Vec }] });
    function helper() {
      return 'host helper';
    }
    let received: unknown;
    const api = m.toScript({ helper, take: (value: unknown) => void (received = value) }) as any;

    api.take(api.helper);
    expect(typeof received).toBe('function');
    expect(received).not.toBe(helper);
    // It still works, and it is the script's callable again when it comes back
    expect((received as () => unknown)()).toBe('host helper');
    expect(m.toScript(received)).toBe(api.helper);

    api.take(m.scriptClass('Vec'));
    expect(received).not.toBe(Vec);
  });

  it('refuse a function (a callable, a class, a script function) as the `this` of a host function', () => {
    const m = createScriptMembrane({ classes: [{ name: 'Vec', ctor: Vec }] });
    function helper() {}
    const api = m.toScript({ helper, setX }) as any;
    const ScriptVec = m.scriptClass('Vec') as any;

    for (const receiver of [api.helper, ScriptVec, () => {}]) {
      expect(() => api.setX.call(receiver, 1)).toThrow('A function cannot be the `this`');
    }
    expect(Object.prototype.hasOwnProperty.call(helper, 'x')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(Vec, 'x')).toBe(false);
    // An object `this` still works: the methods of listed classes need it
    const v = new ScriptVec();
    expect(v.set(3).x).toBe(3);
  });
});

describe('references the engine reads (S-07)', () => {
  it('cannot be forged: a copy refuses _isRef and _ref, and no host object can be given them', () => {
    const m = membrane();
    const host: Record<string, unknown> = { a: 1 };
    const api = m.toScript({ host, take: () => {} }) as any;

    expect(() => api.take({ _isRef: true, _ref: api.host })).toThrow('cannot pass a property named _isRef');
    expect(() => api.take({ nested: { _ref: api.host } })).toThrow('cannot pass a property named _ref');
    expect(Reflect.set(api.host, '_isRef', true)).toBe(false);
    expect(Reflect.set(api.host, '_ref', api.host)).toBe(false);
    expect(Object.keys(host)).toEqual(['a']);

    const dynamic = m.exposeDynamic(
      new Proxy(
        {},
        {
          set: (_t, prop) => {
            host[String(prop)] = 'written';
            return true;
          },
        }
      ),
      () => true
    ) as any;
    expect(Reflect.set(dynamic, '_isRef', true)).toBe(false);
    expect(host._isRef).toBeUndefined();
  });

  it('runs the set guard with the host value before the assignment', () => {
    const seen: unknown[] = [];
    const node = { geometry: null as unknown };
    const m = createScriptMembrane({
      guardSet: (owner, prop) =>
        owner === node && prop === 'geometry'
          ? ([value]) => {
              seen.push(value);
              if (value !== null) throw new TypeError('geometry must be the geometry of a node');
            }
          : undefined,
    });
    const api = m.toScript({ node }) as any;

    expect(() => {
      api.node.geometry = { fake: true };
    }).toThrow('geometry must be the geometry of a node');
    expect(node.geometry).toBeNull();
    api.node.geometry = null;
    expect(seen).toEqual([{ fake: true }, null]);
  });

  it('handedOut() knows a host object by identity, never by its shape', () => {
    const m = membrane();
    const shown = { traverse() {}, get _ref() { return null; } };
    const lookalike = { traverse() {}, get _ref() { return null; } };
    m.toScript({ shown });
    const api = m.toScript({ shown }) as any;
    void api.shown;

    expect(m.handedOut(shown)).toBe(true);
    expect(m.handedOut(lookalike)).toBe(false);
    expect(m.handedOut(m.toHost({ copy: 1 }))).toBe(false);
    // A token is not a facade: what it stands for was never shown
    const world = new World();
    m.toScript(world);
    expect(m.handedOut(world)).toBe(false);
  });
});

describe('errors shown to a script (S-05)', () => {
  const frames = /\n\s*at /;

  it('carry the name and message only: no stack frames, no cause, no properties, file paths replaced', () => {
    const api = script({
      fail() {
        throw Object.assign(new RangeError("ENOENT: no such file or directory, open '/Users/someone/project/.env'"), {
          cause: new World(),
          world: new World(),
        });
      },
      failWithUrl() {
        throw new Error('could not load file:///Users/someone/project/dist/index.js:7:13 (see http://127.0.0.1:3000/api/agents)');
      },
    });

    let caught: any;
    try {
      api.fail();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RangeError);
    expect(caught.message).toBe("ENOENT: no such file or directory, open '<path>'");
    expect(caught.stack).toBe(`RangeError: ${caught.message}`);
    expect(caught.stack).not.toMatch(frames);
    expect(caught.cause).toBeUndefined();
    expect(caught.world).toBeUndefined();

    try {
      api.failWithUrl();
    } catch (err) {
      caught = err;
    }
    // A URL that is not a file: URL is left as it is
    expect(caught.message).toBe('could not load <path> (see http://127.0.0.1:3000/api/agents)');
  });

  it('that the membrane makes itself carry no frames either', async () => {
    const m = createScriptMembrane({ classes: [{ name: 'Vec', ctor: Vec }] });
    const api = m.toScript({ Function, take: () => {}, setX() {}, later: async () => Promise.reject(new Error('at /opt/agent/x.js')) }) as any;
    let deep: any = {};
    for (let i = 0; i < 100; i++) deep = { deep };
    const errors: any[] = [];
    for (const attempt of [
      () => api.Function('return 1'),
      () => api.take(deep),
      () => api.setX.call(api.take),
      () => (m.scriptClass('Vec') as any)(),
      () => api.take({ _isRef: true }),
    ]) {
      try {
        attempt();
      } catch (err) {
        errors.push(err);
      }
    }
    errors.push(await api.later().catch((err: unknown) => err));

    expect(errors).toHaveLength(6);
    for (const error of errors) {
      expect(error).toBeInstanceOf(Error);
      expect(String(error.stack)).not.toMatch(frames);
      expect(String(error.stack) + error.message).not.toContain('/opt/agent');
    }
  });

  it('thrown by a script and handed back to it are its own again', () => {
    const m = membrane();
    const thrown = { message: 'mine' };
    const api = m.toScript({ run: (fn: () => void) => fn() }) as any;
    let caught: unknown;
    try {
      api.run(() => {
        throw thrown;
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBe(thrown);
  });
});
