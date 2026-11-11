import { Packr } from 'msgpackr';
import { describe, expect, it } from 'vitest';
import { PACKET_LIMITS, PacketOverLimit, PacketRefused, decodeServerFrame } from './packet-decode';
import { cooWorldChat, cooWorldPlayer, cooWorldSnapshot } from '../test-support/world-packets';

/*
 * The bounded decoder against msgpackr itself: frames are packed the way the world's server packs
 * them (coo-world src/core/packets.js: new Packr({ structuredClone: true })), and what the
 * decoder makes of a frame is compared with what msgpackr's own unpack makes of it.
 */

/** A packer as the world's server has it. A new one each time: msgpackr keeps state between packs. */
const pack = (value: unknown): Uint8Array => new Uint8Array(new Packr({ structuredClone: true }).pack(value));
const unpack = (frame: Uint8Array): unknown => new Packr({ structuredClone: true }).unpack(frame);
const decode = (frame: Uint8Array, limits = PACKET_LIMITS) => decodeServerFrame(frame, limits).value;
const bytes = (...values: number[]) => new Uint8Array(values);

/** A fixed pseudo-random sequence */
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const TYPED = [Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array] as const;

/** A value an app may keep in its state that the server writes with an extension of its own (structuredClone turns on moreTypes) */
function serverTyped(next: () => number): unknown {
  const kind = Math.floor(next() * 12);
  const count = Math.floor(next() * 300);
  if (kind < 11) {
    const Kind = TYPED[kind];
    const out = new Kind(count);
    for (let i = 0; i < count; i++) (out as any)[i] = Kind === BigInt64Array || Kind === BigUint64Array ? BigInt(Math.floor(next() * 1e9)) : Math.floor(next() * 200) - (Kind === Int8Array ? 100 : 0);
    return out;
  }
  return next() < 0.5 ? new Uint8Array(count).fill(7).buffer : new DataView(new Uint8Array(count).fill(9).buffer);
}

/** Data like the world's: nested objects of many shapes, arrays, strings in several scripts, numbers of every size, and the other types an app's state can hold */
function worldLike(next: () => number, depth = 0): unknown {
  const pick = next();
  if (depth > 5 || pick < 0.3) {
    const leaves = [
      null, true, false, 0, 63, 64, 127, 128, 255, 256, 65535, 65536, -1, -32, -33, -129, 4294967295, 4294967296, 1_700_000_000_000, 0.5, -1234.5678, 1e300,
      '', 'coo', 'VLvCb3w5G2', 'こんにちは、世界', '🛹 skate', 'x'.repeat(40), 'y'.repeat(300), 'asset://3f2a9c.glb', undefined, new Date(1_700_000_000_000), new Date(1_700_000_000_123),
      '\uFEFFwith a BOM', new Date(Number.NaN), new Date(-1), new Date(8.64e15), 5n, -(2n ** 63n), 2n ** 64n - 1n, 2n ** 70n, -(2n ** 70n) - 12345n, 7n ** 300n, -(3n ** 500n), Buffer.from([1, 2, 3]),
    ];
    if (next() < 0.25) return serverTyped(next);
    return leaves[Math.floor(next() * leaves.length)];
  }
  if (pick < 0.45) return Array.from({ length: Math.floor(next() * 6) }, () => worldLike(next, depth + 1));
  if (pick < 0.5) return new Set(Array.from({ length: Math.floor(next() * 5) }, () => worldLike(next, depth + 1)));
  if (pick < 0.55) return new Map(Array.from({ length: Math.floor(next() * 4) }, (_, i) => [next() < 0.5 ? `m${i}` : i, worldLike(next, depth + 1)]));
  if (pick < 0.57) return [new TypeError(`bad ${Math.floor(next() * 9)}`), new Error('plain', { cause: worldLike(next, depth + 1) }), Object.assign(new Error('named'), { name: 'AppError' })][Math.floor(next() * 3)];
  if (pick < 0.59) return [/a+b*/g, /^こんにちは$/u, new RegExp('[x-z]{2,}', 'im')][Math.floor(next() * 3)];
  const object: Record<string, unknown> = {};
  const keys = Math.floor(next() * 7);
  for (let i = 0; i < keys; i++) object[`k${Math.floor(next() * 40)}`] = worldLike(next, depth + 1);
  return object;
}

describe('decodeServerFrame reads what the world sends exactly as msgpackr does', () => {
  it('a coo-world snapshot, chat message and entity packets', () => {
    const snapshot = cooWorldSnapshot({ selfId: 'coo', worldRank: 1, players: [{ id: 'p1', name: 'Bob', rank: 2 }, { id: 'p2', name: 'アリス' }], chat: [cooWorldChat('m1', 'p1', 'Bob', 'hello')] });
    for (const packet of [
      [0, snapshot],
      [2, cooWorldChat('m2', 'p1', 'Bob', 'Coo, こんにちは 🛹')],
      [6, cooWorldPlayer({ id: 'p3', name: 'Carol', rank: 1 })],
      [7, { id: 'e1', p: [1.5, 0, -2.25], q: [0, 0.7071, 0, 0.7071], t: true }],
      [7, { id: 'coo', evmTips: true }],
      [9, 'e1'],
      [18, 'outdated'],
      [33, { verified: true, wallet: '0x000000000000000000000000000000000000dEaD', attempt: 3, reason: 'ok' }],
      [15, { key: 'title', value: undefined }],
    ]) {
      const frame = pack(packet);
      expect(decode(frame)).toEqual(unpack(frame));
      expect(decode(frame)).toEqual(packet);
    }
  });

  it('two thousand packets of generated world-like data, of many object shapes', () => {
    const next = random(20261111);
    for (let i = 0; i < 2000; i++) {
      const packet = [Math.floor(next() * 40), worldLike(next)];
      const frame = pack(packet);
      expect(decode(frame), `packet ${i}`).toEqual(unpack(frame));
    }
  });

  it('more object shapes in one packet than there are record ids (msgpackr then reuses ids), and empty objects', () => {
    const shapes = Array.from({ length: 300 }, (_, i) => ({ [`only${i}`]: i, shared: { [`inner${i % 70}`]: [i, {}] }, empty: {} }));
    const frame = pack([0, shapes]);
    expect(decode(frame)).toEqual(unpack(frame));
    expect(decode(frame)).toEqual([0, shapes]);
  });

  it('a value the server holds once and sends twice (msgpackr writes a reference): one object, seen at both places', () => {
    const shared = { position: [1, 2, 3], state: { open: true } };
    const frame = pack([7, { first: shared, second: shared, list: [shared, shared] }]);
    const mine = decode(frame) as [number, { first: unknown; second: unknown; list: unknown[] }];
    const theirs = unpack(frame) as typeof mine;
    expect(mine).toEqual(theirs);
    expect(mine[1].second).toBe(mine[1].first);
    expect(mine[1].list[1]).toBe(mine[1].first);
    expect(theirs[1].second).toBe(theirs[1].first);
  });

  it('a Map (the only thing msgpackr writes as a MessagePack map when records are on), bin, 64-bit integers and dates', () => {
    const packet = [19, { map: new Map<unknown, unknown>([['a', 1], [2, { b: [3] }]]), bin: Buffer.from([1, 2, 3]), big: 2n ** 60n, negative: -(2n ** 60n), at: new Date(1_800_000_000_500) }];
    const frame = pack(packet);
    const mine = decode(frame) as [number, any];
    const theirs = unpack(frame) as [number, any];
    expect(mine).toEqual(theirs);
    expect(mine[1].map).toBeInstanceOf(Map);
    expect([...mine[1].bin]).toEqual([1, 2, 3]);
    expect(mine[1].big).toBe(2n ** 60n);
    expect(mine[1].at.getTime()).toBe(1_800_000_000_500);
  });

  it("a snapshot whose app state holds a Uint8Array, a Float32Array, a Set, a Map, a Date and a bigint, as msgpackr reads it", () => {
    const snapshot = cooWorldSnapshot({ selfId: 'coo', players: [{ id: 'p1', name: 'Bob' }] }) as any;
    const state = { bits: new Uint8Array([1, 2, 3]), weights: new Float32Array([0.5, -1.25]), seen: new Set(['p1', 'p2']), scores: new Map<unknown, unknown>([['p1', 3], [7, { best: true }]]), since: new Date(1_800_000_000_000), total: 2n ** 80n + 1n };
    snapshot.entities.push({ id: 'app1', type: 'app', blueprint: 'bp1', position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1], mover: null, uploader: null, pinned: false, state });
    const frame = pack([0, snapshot]);
    const mine = decode(frame) as [number, any];
    expect(mine).toEqual(unpack(frame));
    expect(mine[1].entities.at(-1).state).toEqual(state);
    expect(mine[1].entities.at(-1).state.bits).toBeInstanceOf(Uint8Array);
    expect(mine[1].entities.at(-1).state.weights).toBeInstanceOf(Float32Array);
  });

  it('every kind of typed array, ArrayBuffer and DataView, Set, Error and RegExp, inside snapshot-shaped packets, as msgpackr reads them', () => {
    const next = random(424242);
    for (let i = 0; i < 300; i++) {
      const state: Record<string, unknown> = {};
      for (let k = 0; k < 4; k++) state[`v${k}`] = k % 2 ? serverTyped(next) : worldLike(next);
      const frame = pack([0, { id: 'coo', entities: [{ id: `app${i}`, type: 'app', state }], blueprints: [{ id: 'bp', props: { list: new Set([state.v1, 'x']), at: new Date(1_700_000_000_000 + i) } }] }]);
      expect(decode(frame), `packet ${i}`).toEqual(unpack(frame));
    }
    // A value held twice is one object at both places, whatever its kind
    const shared = new Float64Array([1, 2]);
    const twice = pack([7, { a: shared, b: shared, s: new Set([shared]) }]);
    const read = decode(twice) as [number, any];
    expect(read).toEqual(unpack(twice));
    expect(read[1].b).toBe(read[1].a);
    expect([...read[1].s][0]).toBe(read[1].a);
  });

  it('keeps a leading BOM in strings and keys, as msgpackr does', () => {
    const frame = pack([7, { '\uFEFFmode': '\uFEFFhello', mode: 'plain' }]);
    expect(decode(frame)).toEqual(unpack(frame));
    expect(Object.keys((decode(frame) as [number, object])[1])).toEqual(['\uFEFFmode', 'mode']);
  });

  it('a property named __proto__ becomes an ordinary one, as in msgpackr: nothing is put on a prototype', () => {
    const frame = pack([7, JSON.parse('{"__proto__": {"polluted": true}, "id": "e1"}')]);
    const mine = decode(frame) as [number, Record<string, unknown>];
    expect(mine).toEqual(unpack(frame));
    expect(Object.getPrototypeOf(mine[1])).toBe(Object.prototype);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    expect(Object.keys(mine[1])).toEqual(['__proto_', 'id']);
  });

  it('never gives a value msgpackr would not: frames damaged at random are refused, or read the same', () => {
    const next = random(7);
    let same = 0;
    let refused = 0;
    const onlyHere: string[] = [];
    for (let i = 0; i < 3000; i++) {
      const frame = pack([Math.floor(next() * 40), worldLike(next)]);
      const damaged = Uint8Array.from(frame);
      for (let flips = 1 + Math.floor(next() * 3); flips > 0; flips--) damaged[Math.floor(next() * damaged.length)] = Math.floor(next() * 256);
      let mine: unknown;
      try {
        mine = decode(damaged);
      } catch (error) {
        expect(error instanceof PacketRefused || error instanceof PacketOverLimit, String(error)).toBe(true);
        refused++;
        continue;
      }
      // Read: then msgpackr reads it too, and reads the same (strings compared as text msgpackr may decode leniently)
      let theirs: unknown;
      try {
        theirs = unpack(damaged);
      } catch (error) {
        // Read here and refused by msgpackr: that must not happen (this decoder is the stricter one)
        onlyHere.push(`${String(error).slice(0, 80)} for ${Buffer.from(damaged).toString('hex').slice(0, 120)}`);
        continue;
      }
      if (JSON.stringify(mine, replacer) === JSON.stringify(theirs, replacer)) same++;
      else expect(lenient(mine), `frame ${i}`).toEqual(lenient(theirs));
    }
    expect(onlyHere).toEqual([]);
    expect(same).toBeGreaterThan(300);
    expect(refused).toBeGreaterThan(300);
  });
});

// For comparing damaged frames: BigInt and Map have no JSON form, and a damaged string may hold bytes that are not UTF-8
const replacer = (_key: string, value: unknown) => (typeof value === 'bigint' ? `${value}n` : value instanceof Map ? [...value] : value);
const lenient = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (key, inner) => (typeof inner === 'string' ? inner.replace(/[^\x20-\x7e]/g, '?') : replacer(key, inner))) ?? 'null');

describe('decodeServerFrame limits', () => {
  it('counts every value a frame decodes into', () => {
    expect(decodeServerFrame(pack(7)).nodes).toBe(1);
    expect(decodeServerFrame(pack([1, 'two', null])).nodes).toBe(4);
    // The packet array, its id, the object, its three values, the array's three numbers
    expect(decodeServerFrame(pack([7, { id: 'e1', p: [1, 2, 3], t: true }])).nodes).toBe(9);
    // A map: its keys count too
    expect(decodeServerFrame(pack(new Map([['a', 1], ['b', 2]]))).nodes).toBe(5);
  });

  it('refuses a frame of empty arrays that would decode into more values than the limit, without building them', () => {
    // 600,000 one-byte empty arrays in one array: 600 KB that would become 600,000 objects
    const frame = new Uint8Array(5 + 600_000).fill(0x90);
    frame.set([0xdd, 0x00, 0x09, 0x27, 0xc0]);
    expect(() => decode(frame)).toThrow(PacketOverLimit);
    expect(() => decode(frame)).toThrow('it holds more than 500000 values');
    // Under the limit the same shape is read
    const small = new Uint8Array(5 + 1000).fill(0x90);
    small.set([0xdd, 0x00, 0x00, 0x03, 0xe8]);
    expect((decode(small) as unknown[]).length).toBe(1000);
    expect(decodeServerFrame(small).nodes).toBe(1001);
  });

  it('is charged at the header: a container that announces more elements than the limit is refused before anything is allocated for it', () => {
    // array 32 of 0x7fffffff elements, with enough bytes after it for the first few
    const frame = new Uint8Array(8_000_000).fill(0xc0);
    frame.set([0xdd, 0x7f, 0xff, 0xff, 0xff]);
    const started = Date.now();
    expect(() => decode(frame)).toThrow(PacketRefused);
    const smaller = new Uint8Array(8_000_000).fill(0xc0);
    smaller.set([0xdd, 0x00, 0x7a, 0x11, 0xfb]);
    expect(() => decode(smaller)).toThrow(PacketOverLimit);
    // Neither read 8 MB element by element
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('refuses nesting deeper than the limit, and reads nesting up to it', () => {
    const nested = (levels: number) => bytes(...Array.from({ length: levels }, () => 0x91), 0xc0);
    expect(() => decode(nested(64))).not.toThrow();
    expect(() => decode(nested(65))).toThrow('it nests more than 64 levels deep');
    // A frame of nothing but array headers does not overflow the stack either
    expect(() => decode(new Uint8Array(1_000_000).fill(0x91))).toThrow(PacketOverLimit);
  });

  it('counts reference ids wrapped around one another as nesting: a frame of nothing but such wrappers is refused, not recursed into', () => {
    // i(1) i(2) i(3) ... around one nil
    const wrapped = (levels: number) => {
      const frame = new Uint8Array(levels * 6 + 1);
      for (let n = 0; n < levels; n++) {
        frame.set([0xd6, 0x69], n * 6);
        new DataView(frame.buffer).setUint32(n * 6 + 2, n + 1);
      }
      frame[levels * 6] = 0xc0;
      return frame;
    };
    expect(decode(wrapped(64))).toBeNull();
    expect(() => decode(wrapped(65))).toThrow('it nests more than 64 levels deep');
    expect(() => decode(wrapped(1_000_000))).toThrow(PacketOverLimit);
  });

  it('counts a subtree again for every reference to it: a small frame cannot stand for a huge value', () => {
    // msgpackr's own references: one object of 1,000 values, referred to 1,000 times
    const big = Array.from({ length: 999 }, (_, i) => i);
    const frame = pack([0, Array.from({ length: 1000 }, () => big)]);
    expect(frame.byteLength).toBeLessThan(20_000);
    expect(() => decode(frame)).toThrow(PacketOverLimit);
    // msgpackr itself reads it: a million elements to whoever walks it
    expect(((unpack(frame) as [number, unknown[][]])[1]).reduce((sum, list) => sum + list.length, 0)).toBe(999_000);
    // A few references are fine, and counted
    const few = pack([0, [big, big, big]]);
    expect(decodeServerFrame(few).nodes).toBe(3 + 3 * 1000);
  });

  it('refuses a doubling chain of references (each level holds the one below twice)', () => {
    // i(1) [x]; then level n = i(n) [p(n-1), p(n-1)]
    const out: number[] = [0xdc, 0x00, 0x1f];
    const id = (n: number) => [0x00, 0x00, 0x00, n];
    out.push(0xd6, 0x69, ...id(1), 0x91, 0xc0);
    for (let n = 2; n <= 31; n++) out.push(0xd6, 0x69, ...id(n), 0x92, 0xd6, 0x70, ...id(n - 1), 0xd6, 0x70, ...id(n - 1));
    expect(out.length).toBeLessThan(600);
    expect(() => decode(Uint8Array.from(out))).toThrow(PacketOverLimit);
  });

  it('reads a record definition\'s names without recursing: definitions nested where the names belong are refused at once', () => {
    // d4 72 40 d4 72 41 d4 72 42 90: three definitions, each where the previous one's names should be
    expect(() => decode(bytes(0xd4, 0x72, 0x40, 0xd4, 0x72, 0x41, 0xd4, 0x72, 0x42, 0x90), { maxNodes: 100, maxDepth: 1 })).toThrow('a record definition whose keys are not a list');
    // A million of them: refused at the first, not recursed into
    const chain = new Uint8Array(3_000_000);
    for (let i = 0; i < 1_000_000; i++) chain.set([0xd4, 0x72, 0x40 + (i % 64)], i * 3);
    expect(() => decode(chain)).toThrow(PacketRefused);
    // Names that are references to an earlier list are read, as msgpackr writes them when it reuses record ids
    const shapes = Array.from({ length: 70 }, (_, i) => ({ [`k${i}`]: i }));
    const reused = pack([0, [...shapes, { k0: 'again' }]]);
    expect(Buffer.from(reused).toString('hex')).toContain('d670');
    expect(decode(reused)).toEqual(unpack(reused));
  });

  it("counts a shared subtree's levels wherever it is put: a reference cannot carry nesting past the limit", () => {
    const shared = [null];
    // The reviewer's input: five arrays deep, though each part alone is shallower
    const frame = pack([shared, [[[shared]]]]);
    expect(frame.byteLength).toBeLessThan(20);
    expect(() => decode(frame, { maxNodes: 100, maxDepth: 4 })).toThrow('it nests more than 4 levels deep');
    expect(() => decode(frame, { maxNodes: 100, maxDepth: 5 })).not.toThrow();
    // Scaled: a 40-level subtree put 40 levels down, in a small frame
    let deep: unknown = null;
    for (let i = 0; i < 40; i++) deep = [deep];
    let holder: unknown = deep;
    for (let i = 0; i < 40; i++) holder = [holder];
    const big = pack([deep, holder]);
    expect(big.byteLength).toBeLessThan(200);
    expect(() => decode(big)).toThrow('it nests more than 64 levels deep');
  });

  it("counts a typed array's elements and a big integer's 64-bit words as values", () => {
    expect(decodeServerFrame(pack(new Uint8Array(10))).nodes).toBe(11);
    expect(decodeServerFrame(pack(new Float64Array(10))).nodes).toBe(11);
    expect(decodeServerFrame(pack(new ArrayBuffer(6))).nodes).toBe(7);
    // 2^130: three 64-bit words (msgpackr writes 24 bytes)
    expect(decodeServerFrame(pack(2n ** 130n)).nodes).toBe(3);
    expect(() => decode(pack(new Uint8Array(600_000)))).toThrow('it holds more than 500000 values');
  });

  it('rebuilds an Error by its name only from the errors msgpackr knows: any other name is an Error with that name', () => {
    for (const name of ['constructor', 'toString', '__proto__', 'AppError']) {
      const error = decode(bytes(0xd4, 0x65, 0x00, 0x93, 0xa0 + name.length, ...Buffer.from(name), 0xa1, 0x6d, 0xc0)) as Error;
      expect(error).toBeInstanceOf(Error);
      expect([error.name, error.message]).toEqual([name, 'm']);
    }
    expect(decode(pack(new RangeError('r')))).toBeInstanceOf(RangeError);
  });

  it('takes other limits when given them', () => {
    const frame = pack([7, { id: 'e1', p: [1, 2, 3] }]);
    expect(() => decode(frame, { maxNodes: 7, maxDepth: 64 })).toThrow(PacketOverLimit);
    expect(() => decode(frame, { maxNodes: 8, maxDepth: 64 })).not.toThrow();
    expect(() => decode(frame, { maxNodes: 8, maxDepth: 2 })).toThrow(PacketOverLimit);
    expect(() => decode(frame, { maxNodes: 8, maxDepth: 3 })).not.toThrow();
  });
});

describe('decodeServerFrame refuses what is not the protocol', () => {
  it.each([
    ['a value that refers to itself (a cycle)', () => {
      const loop: unknown[] = [];
      loop.push(loop);
      return pack([0, loop]);
    }],
    ['a reference to nothing', () => bytes(0x92, 0x00, 0xd6, 0x70, 0, 0, 0, 9)],
    ['a typed array of a kind msgpackr has no code for (its own decoder fails on it too)', () => pack([0, new Float16Array([1])])],
    ['a typed array whose bytes are not whole elements', () => bytes(0xc7, 0x04, 0x74, 0x07, 0x00, 0x00, 0x00)],
    ['a Set that is not followed by an array', () => bytes(0xd4, 0x73, 0x00, 0x01)],
    ['a Set marker with another filler byte', () => bytes(0xd4, 0x73, 0x05, 0x90)],
    ['a RegExp whose pattern does not compile', () => bytes(0xd4, 0x78, 0x00, 0x92, 0xa1, 0x28, 0xa0)],
    ['bundled strings (an option neither server sets)', () => bytes(0xd6, 0x62, 0x00, 0x00, 0x00, 0x05, 0xc0)],
    ['a value that refers to a record definition\'s names', () => bytes(0x92, 0xd4, 0x72, 0x40, 0xd6, 0x69, 0, 0, 0, 1, 0x91, 0xa1, 0x61, 0x01, 0xd6, 0x70, 0, 0, 0, 1)],
    ["a record definition whose names refer to a value", () => bytes(0x92, 0xd6, 0x69, 0, 0, 0, 1, 0x91, 0xa1, 0x61, 0xd4, 0x72, 0x40, 0xd6, 0x70, 0, 0, 0, 1, 0x01)],
    ['the reserved byte 0xc1', () => bytes(0xc1)],
    ['a two-byte record definition', () => bytes(0xd5, 0x72, 0x60, 0x00, 0x90)],
    ['an unknown extension', () => bytes(0xd4, 0x41, 0x00)],
    ['a record definition whose keys are not strings', () => bytes(0xd4, 0x72, 0x40, 0x91, 0x01, 0x01)],
    ['a frame cut short', () => pack([7, { id: 'e1', p: [1, 2, 3] }]).subarray(0, 12)],
    ['a string longer than the frame', () => bytes(0xdb, 0x7f, 0xff, 0xff, 0xff, 0x61)],
    ['bytes after the packet', () => Uint8Array.from([...pack([7, 'e1']), 0xc0])],
    ['an empty frame', () => bytes()],
  ])('%s', (_what, frame) => {
    expect(() => decode(frame())).toThrow(PacketRefused);
  });

  it('reads a frame that sits at an offset in a larger buffer', () => {
    const frame = pack([7, { id: 'e1', p: [1, 2, 3], at: new Date(1_700_000_000_000), text: 'こんにちは' }]);
    const padded = new Uint8Array(frame.byteLength + 7);
    padded.set(frame, 3);
    expect(decode(padded.subarray(3, 3 + frame.byteLength))).toEqual(unpack(frame));
  });
});
