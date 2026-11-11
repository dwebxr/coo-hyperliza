import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Packr } from 'msgpackr';
import { describe, expect, it } from 'vitest';
import { type DecodeLimits, PACKET_LIMITS, PacketOverLimit, PacketRefused, type RefusalKind, decodeServerFrame } from './packet-decode';
import { cooWorldChat, cooWorldPlayer, cooWorldSnapshot } from '../test-support/world-packets';

/*
 * The bounded decoder against msgpackr itself: frames are packed the way the world's server packs
 * them (coo-world src/core/packets.js: new Packr({ structuredClone: true })), and what the
 * decoder makes of a frame is compared with what msgpackr's own unpack makes of it.
 */

/** The msgpackr these tests compare against: this package's, which the bundled engine's server also packs with */
const REFERENCE_MSGPACKR = '1.12.1';

/** A packer as the world's server has it. A new one each time: msgpackr keeps state between packs. */
const pack = (value: unknown): Uint8Array => new Uint8Array(new Packr({ structuredClone: true }).pack(value));
const unpack = (frame: Uint8Array): unknown => new Packr({ structuredClone: true }).unpack(frame);
const decode = (frame: Uint8Array, limits: Partial<DecodeLimits> = {}) => decodeServerFrame(frame, { ...PACKET_LIMITS, ...limits }).value;
const bytes = (...values: number[]) => new Uint8Array(values);
const MiB = 1024 * 1024;

/**
 * A value as text that tells apart everything the decoders can return: types, -0, NaN, prototypes,
 * a typed array's kind and bytes, an Error's class, name, message and cause, and which values are
 * one object seen twice. Source text, so a child process (below) runs the same function.
 */
const CANON_SOURCE = `(value) => {
  const seen = new Map();
  const go = (v) => {
    if (v === null) return null;
    switch (typeof v) {
      case 'undefined': return ['undefined'];
      case 'boolean': return v;
      case 'number': return Object.is(v, -0) ? ['-0'] : Number.isFinite(v) ? v : ['number', String(v)];
      case 'bigint': return ['bigint', String(v)];
      case 'string': return v;
      case 'object': break;
      default: return ['other', typeof v];
    }
    if (seen.has(v)) return ['again', seen.get(v)];
    seen.set(v, seen.size);
    const tag = Object.prototype.toString.call(v).slice(8, -1);
    if (Array.isArray(v)) return ['array', Array.from(v, go)];
    if (v instanceof Map) return ['map', Array.from(v, ([k, x]) => [go(k), go(x)])];
    if (v instanceof Set) return ['set', Array.from(v, go)];
    if (v instanceof Date) return ['date', String(v.getTime())];
    if (v instanceof RegExp) return ['regexp', v.source, v.flags];
    if (v instanceof Error) return ['error', v.constructor.name, go(v.name), go(v.message), Object.hasOwn(v, 'cause'), go(v.cause), 'errors' in v ? go(v.errors) : null];
    if (v instanceof ArrayBuffer) return [tag, Array.from(new Uint8Array(v))];
    if (ArrayBuffer.isView(v)) return [tag, Array.from(new Uint8Array(v.buffer, v.byteOffset, v.byteLength))];
    return ['object', Object.getPrototypeOf(v) === Object.prototype, Object.keys(v).map((k) => [k, go(v[k])])];
  };
  return JSON.stringify(go(value));
}`;
const canon = new Function(`return ${CANON_SOURCE}`)() as (value: unknown) => string;

const REPO = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * What msgpackr's own unpack makes of each frame, in a child process with native acceleration on
 * or off: the sha256 of its canon for a frame it reads, null for one it refuses.
 */
function msgpackrInChild(frames: Uint8Array[], native: boolean): { native: boolean; version: string; results: (string | null)[] } {
  const program = `
    const { Unpackr, isNativeAccelerationEnabled } = require('msgpackr');
    const { createHash } = require('node:crypto');
    const canon = ${CANON_SOURCE};
    const hash = (text) => createHash('sha256').update(text).digest('hex');
    const version = JSON.parse(require('node:fs').readFileSync(require('node:path').join(require('node:path').dirname(require.resolve('msgpackr')), '..', 'package.json'), 'utf8')).version;
    const chunks = [];
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => {
      const results = JSON.parse(Buffer.concat(chunks).toString()).map((base64) => {
        let value;
        try {
          value = new Unpackr({ structuredClone: true }).unpack(Buffer.from(base64, 'base64'));
        } catch {
          return null;
        }
        return hash(canon(value));
      });
      process.stdout.write(JSON.stringify({ native: isNativeAccelerationEnabled, version, results }));
    });`;
  const env = { ...process.env };
  if (native) delete env.MSGPACKR_NATIVE_ACCELERATION_DISABLED;
  else env.MSGPACKR_NATIVE_ACCELERATION_DISABLED = 'true';
  const child = spawnSync(process.execPath, ['-e', program], { cwd: REPO, env, input: JSON.stringify(frames.map((frame) => Buffer.from(frame).toString('base64'))), maxBuffer: 256 * MiB });
  if (child.status !== 0) throw new Error(`the msgpackr child failed: ${child.stderr}`);
  return JSON.parse(child.stdout.toString());
}
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

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
    // Each kind once by name (the generated packets pick theirs at random), read as its own class
    const each: object[] = [...TYPED.map((Kind) => new Kind(3)), new Uint8Array([1, 2, 3]).buffer, new DataView(new Uint8Array([1, 2, 3]).buffer), new Set([1, 'two', [3]]), new TypeError('typed'), new RegExp('a+b', 'gi')];
    for (const value of each) {
      const frame = pack([0, { state: { value } }]);
      const read = (decode(frame) as [number, { state: { value: object } }])[1].state.value;
      expect(decode(frame), value.constructor.name).toEqual(unpack(frame));
      expect(Object.getPrototypeOf(read), value.constructor.name).toBe(Object.getPrototypeOf(value));
    }
    expect(each).toHaveLength(16);
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

  it(`compares against msgpackr ${REFERENCE_MSGPACKR}, the version installed here`, () => {
    const entry = createRequire(import.meta.url).resolve('msgpackr');
    const { version } = JSON.parse(readFileSync(join(dirname(entry), '..', 'package.json'), 'utf8'));
    expect(version).toBe(REFERENCE_MSGPACKR);
  });

  it('an ordinary large snapshot (14,000 entities, 300 blueprints, 50 chat messages) is read, as msgpackr reads it, well under the limits', () => {
    const frame = pack([0, largeSnapshot(14_000)]);
    const decoded = decodeServerFrame(frame);
    expect(canon(decoded.value)).toBe(canon(unpack(frame)));
    // The measurement PACKET_LIMITS gives: about 28 values an entity, 2 MiB of strings
    expect(decoded.nodes).toBe(399_215);
    expect(decoded.bytes).toBeGreaterThan(1.9 * MiB);
    expect(decoded.bytes).toBeLessThan(2.1 * MiB);
    expect(decoded.bytes * 16).toBeLessThan(PACKET_LIMITS.maxBytes);
    // The value limit holds about 17,500 such entities
    expect(decodeServerFrame(pack([0, largeSnapshot(17_500)])).nodes).toBeLessThan(PACKET_LIMITS.maxNodes);
    expect(() => decode(pack([0, largeSnapshot(18_000)]))).toThrow(`it holds more than ${PACKET_LIMITS.maxNodes} values`);
  });
});

/** The shape of a large world's snapshot (the decoder consultant's perf.mjs) */
function largeSnapshot(count: number) {
  const next = random(1);
  const entities = [];
  for (let i = 0; i < count; i++) {
    entities.push({ id: 'e' + i.toString(36).padStart(8, '0'), type: 'app', blueprint: 'bp' + (i % 300), position: [next() * 100, next() * 5, next() * 100], quaternion: [0, next(), 0, 1], scale: [1, 1, 1], mover: null, uploader: null, pinned: next() < 0.1, state: { open: next() < 0.5, label: 'door ' + i, score: Math.floor(next() * 1e6), tags: ['a', 'bb', 'こんにちは'] } });
  }
  const blueprints = Array.from({ length: 300 }, (_, i) => ({ id: 'bp' + i, version: 3, name: 'Blueprint ' + i, image: null, author: 'x', url: null, desc: 'd'.repeat(200), model: 'asset://' + 'f'.repeat(64) + '.glb', script: 'asset://' + 'a'.repeat(64) + '.js', props: { color: '#ffffff', speed: 1.5, list: [1, 2, 3] }, preload: false, public: false, locked: false, frozen: false, unique: false, disabled: false }));
  const chat = Array.from({ length: 50 }, (_, i) => ({ id: 'm' + i, from: 'Bob', fromId: 'p1', body: 'hello '.repeat(20), createdAt: new Date(1_700_000_000_000 + i).toISOString() }));
  return { id: 'coo', serverTime: 1, apiUrl: 'https://x', maxUploadSize: 10, settings: { title: 't' }, spawn: {}, collections: [], blueprints, entities, chat, authToken: 'x' };
}

const hex = (frame: Uint8Array) => Buffer.from(frame).toString('hex');

/** One string, which a frame holds once and refers to again (the review's Error message) */
const SHARED_LEAF = ['x'.repeat(100)];

/** Frames built by hand in the reviews of this decoder: each is refused here, and msgpackr's verdict on it varies */
const CRAFTED: Uint8Array[] = [
  // a record definition in ext 8 (msgpackr: unknown extension 0x72)
  bytes(0xc7, 0x01, 0x72, 0x40, 0x91, 0xa1, 0x61, 0x01),
  // an id defined twice, the second time around a pointer to itself (msgpackr: a cycle)
  bytes(0x92, 0xd6, 0x69, 0, 0, 0, 1, 0x90, 0xd6, 0x69, 0, 0, 0, 1, 0x91, 0xd6, 0x70, 0, 0, 0, 1),
  // the id and pointer extensions in ext 8 (msgpackr reads them)
  bytes(0x92, 0xc7, 0x04, 0x69, 0, 0, 0, 1, 0x90, 0xd6, 0x70, 0, 0, 0, 1),
  bytes(0x92, 0xd6, 0x69, 0, 0, 0, 1, 0x90, 0xc7, 0x04, 0x70, 0, 0, 0, 1),
  // a Set of a string, a Set marker with another filler byte, a Set in ext 8
  bytes(0xd4, 0x73, 0x00, 0xa3, 0x61, 0x62, 0x63),
  bytes(0xd4, 0x73, 0x07, 0x90),
  bytes(0xc7, 0x01, 0x73, 0x00, 0x90),
  // record keys that are not strings
  bytes(0xd4, 0x72, 0x40, 0x92, 0x01, 0xc0, 0x05, 0x06),
  bytes(0xd4, 0x72, 0x40, 0xc4, 0x02, 0x61, 0x62, 0x05, 0x06),
  // a timestamp and undefined of other sizes or contents
  bytes(0xd5, 0xff, 1, 2),
  bytes(0xd5, 0x00, 1, 2),
  bytes(0xd4, 0xff, 0x00),
  bytes(0xd4, 0x00, 0x01),
  bytes(0xc7, 0x04, 0xff, 0, 0, 0, 1),
  // a typed array in fixext, and with a longer header than it needs
  bytes(0xd5, 0x74, 0x01, 0x07),
  bytes(0xc8, 0x00, 0x02, 0x74, 0x01, 0x07),
  // a big integer in ext 8 where msgpackr writes fixext 16
  bytes(0xc7, 0x10, 0x42, ...new Array(16).fill(1)),
  // Errors whose message is not a string (an array of references to one string; an object no
  // conversion to a string works for) or whose name is not one
  pack([7, { e: Object.assign(new Error('placeholder'), { message: [SHARED_LEAF, SHARED_LEAF, SHARED_LEAF] }) }]),
  pack(Object.assign(new Error('x'), { message: { toString: 0, valueOf: 0 } })),
  pack(Object.assign(new Error('x'), { name: 7 })),
  // an AggregateError without a message (msgpackr: not iterable)
  bytes(0xd4, 0x65, 0x00, 0x93, 0xae, ...Buffer.from('AggregateError'), 0xc0, 0xc0),
  // trailing bytes
  bytes(0x91, 0xa1, 0x61, 0xc0),
];

describe('decodeServerFrame never reads a frame msgpackr refuses, with its native acceleration on and off', () => {
  /*
   * What each mode proves. msgpackr reads strings natively (msgpackr-extract, where a prebuilt
   * binary loads: under Bun and Node on this machine, so as the agent runs it) or in JavaScript
   * (MSGPACKR_NATIVE_ACCELERATION_DISABLED=true, or no binary). Each mode runs in a child process.
   *  - Native: for frames the packer writes, this decoder's value is msgpackr's, exactly; for frames
   *    damaged at random and the crafted ones, every frame read here is read by msgpackr too, to
   *    exactly the same value (strings whose bytes are not UTF-8 included: both replace those bytes
   *    with U+FFFD the same way).
   *  - JavaScript: the same for frames the packer writes, and for every frame whose strings are
   *    UTF-8. msgpackr's JavaScript reader trusts a string's lead bytes: one that announces more
   *    bytes than the string has left reads past its end, and the rest of the frame becomes
   *    something else to it (in the decoder consultant's desync.mjs, a frame read here as three
   *    values is a structure of 2^31 to it). Frames whose strings are not UTF-8 (they decode here
   *    with U+FFFD) are therefore counted and not compared in this mode; the servers' packers never
   *    write one that is cut short, as they write every UTF-16 code unit whole.
   */
  const next = random(7);
  const generated = Array.from({ length: 1500 }, () => pack([Math.floor(next() * 40), worldLike(next)]));
  const damaged = Array.from({ length: 3000 }, () => {
    const frame = Uint8Array.from(pack([Math.floor(next() * 40), worldLike(next)]));
    for (let flips = 1 + Math.floor(next() * 3); flips > 0; flips--) frame[Math.floor(next() * frame.length)] = Math.floor(next() * 256);
    return frame;
  });
  const frames = [...generated, ...damaged, ...CRAFTED];
  /** Anything but a refusal thrown while decoding them: there must be none */
  const unexpected: string[] = [];
  /** The canon of what this decoder reads, or null where it refuses */
  const ours = frames.map((frame): string | null => {
    try {
      return canon(decode(frame));
    } catch (error) {
      if (!(error instanceof PacketRefused || error instanceof PacketOverLimit)) unexpected.push(`${String(error).slice(0, 80)} for ${hex(frame).slice(0, 120)}`);
      return null;
    }
  });

  it('refuses every crafted frame, and reads every frame the packer wrote', () => {
    expect(unexpected).toEqual([]);
    expect(ours.slice(-CRAFTED.length)).toEqual(CRAFTED.map(() => null));
    expect(ours.slice(0, generated.length).every((read) => read !== null)).toBe(true);
  });

  it.each([
    ['on', true],
    ['off', false],
  ])('native acceleration %s', (_mode, native) => {
    const theirs = msgpackrInChild(frames, native);
    expect(theirs.native).toBe(native);
    expect(theirs.version).toBe(REFERENCE_MSGPACKR);
    const onlyHere: string[] = [];
    const different: string[] = [];
    let compared = 0;
    let notUtf8 = 0;
    frames.forEach((frame, i) => {
      const mine = ours[i];
      if (!mine) return;
      if (!native && mine.includes('\uFFFD')) {
        notUtf8++;
        return;
      }
      const other = theirs.results[i];
      if (!other) onlyHere.push(hex(frame));
      else if (sha256(mine) === other) compared++;
      else different.push(hex(frame));
    });
    expect(onlyHere).toEqual([]);
    expect(different).toEqual([]);
    // What the packer wrote, exactly
    for (let i = 0; i < generated.length; i++) expect(sha256(ours[i]!), `packet ${i}`).toBe(theirs.results[i]);
    expect(compared).toBeGreaterThan(generated.length + 300);
    // Damaged frames refused here, and (JavaScript only) not compared
    expect(ours.slice(generated.length).filter((read) => read === null).length).toBeGreaterThan(1000);
    if (native) expect(notUtf8).toBe(0);
    else expect(notUtf8).toBeGreaterThan(0);
  });

  it('a lone surrogate (an app sliced an emoji by UTF-16 units) is read as U+FFFD for each of its three bytes, as msgpackr 1.12.1 reads it natively', () => {
    const frame = pack([2, { body: 'x\uD800y' }]);
    expect(decode(frame)).toEqual([2, { body: 'x\uFFFD\uFFFD\uFFFDy' }]);
    const [native] = msgpackrInChild([frame], true).results;
    expect(native).toBe(sha256(canon([2, { body: 'x\uFFFD\uFFFD\uFFFDy' }])));
    // msgpackr 1.12.1's JavaScript reader makes one U+FFFD of it (1.11.2's keeps the surrogate)
    const [javascript] = msgpackrInChild([frame], false).results;
    expect(javascript).toBe(sha256(canon([2, { body: 'x\uFFFDy' }])));
  });
});

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

  it('is charged at the header: a container that announces more elements than the frame has bytes left, or than the limit, is refused without reading any of them', () => {
    // array 32 of 0x7fffffff elements, with enough bytes after it for the first few
    const frame = new Uint8Array(8_000_000).fill(0xc0);
    frame.set([0xdd, 0x7f, 0xff, 0xff, 0xff]);
    expect(() => decode(frame)).toThrow(PacketRefused);
    const smaller = new Uint8Array(8_000_000).fill(0xc0);
    smaller.set([0xdd, 0x00, 0x7a, 0x11, 0xfb]);
    expect(() => decode(smaller)).toThrow(PacketOverLimit);
    // The same two headers before elements that cannot be read (the reserved byte): refused for
    // what the header announces, so not one element was looked at
    const unreadable = (...header: number[]) => {
      const bad = new Uint8Array(8_000_000).fill(0xc1);
      bad.set(header);
      return bad;
    };
    expect(() => decode(unreadable(0xdd, 0x7f, 0xff, 0xff, 0xff))).toThrow('the frame ends in the middle of a value');
    expect(() => decode(unreadable(0xdd, 0x00, 0x7a, 0x11, 0xfb))).toThrow('it holds more than 500000 values');
    expect(() => decode(unreadable(0xdf, 0x00, 0x3d, 0x08, 0xfd))).toThrow('it holds more than 500000 values');
    // (an element that is looked at is refused as what it is)
    expect(() => decode(unreadable(0x91))).toThrow('byte 0xc1');
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

  it("refuses an Error whose name or message is not a string before making it: the review's mechanism, a frame of 143 bytes whose message would become 302 characters", () => {
    const shared = pack([7, { e: Object.assign(new Error('placeholder'), { message: [SHARED_LEAF, SHARED_LEAF, SHARED_LEAF] }) }]);
    expect(shared.byteLength).toBe(143);
    expect(((unpack(shared) as [number, { e: Error }])[1].e.message).length).toBe(302);
    const refusal = (frame: Uint8Array) => {
      try {
        decode(frame);
      } catch (error) {
        return error;
      }
      return null;
    };
    for (const frame of [shared, pack(Object.assign(new Error('x'), { message: { toString: 0, valueOf: 0 } })), pack(Object.assign(new Error('x'), { name: 7 })), pack(Object.assign(new Error('x'), { message: 5 }))]) {
      const error = refusal(frame);
      expect(error).toBeInstanceOf(PacketRefused);
      expect(error).toMatchObject({ kind: 'Error', message: expect.stringContaining('an Error whose name or message is not a string') });
    }
    // A nil message is one (msgpackr makes it the text "null")
    const nil = bytes(0xd4, 0x65, 0x00, 0x93, 0xa1, 0x45, 0xc0, 0xc0);
    expect(canon(decode(nil))).toBe(canon(unpack(nil)));
    expect((decode(nil) as Error).message).toBe('null');
    // A constructor that fails is a refusal too: an AggregateError's list of errors made from no message
    expect(refusal(bytes(0xd4, 0x65, 0x00, 0x93, 0xae, ...Buffer.from('AggregateError'), 0xc0, 0xc0))).toMatchObject({ kind: 'Error', message: expect.stringContaining('an Error that cannot be made') });
  });

  it("refuses the review's 40 GiB construction (200 Errors, each message 400 references to one 512 KiB string) while it reads the first message, before any Error is made", () => {
    const leaf = ['x'.repeat(512 * 1024)];
    const errors = Array.from({ length: 200 }, () => Object.assign(new Error('placeholder'), { message: Array.from({ length: 400 }, () => leaf) }));
    const frame = pack([0, { entities: [{ id: 'app', state: { errors } }] }]);
    expect(frame.byteLength).toBeLessThan(MiB + 64 * 1024);
    let refusal: unknown;
    try {
      decode(frame);
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(PacketOverLimit);
    expect(String((refusal as Error).message)).toBe(`it holds more than ${PACKET_LIMITS.maxBytes} bytes of strings and binary data`);
    // The first Error alone is over the limit: 64 of its 400 references come to 32 MiB
    expect(() => decode(pack([0, { errors: errors.slice(0, 1) }]))).toThrow(`it holds more than ${PACKET_LIMITS.maxBytes} bytes`);
    // Under a byte limit that lets the messages through, an Error is refused for its message (one
    // Error only: made, it would hold a 200 MiB message)
    expect(() => decode(pack([0, { errors: errors.slice(0, 1) }]), { maxBytes: Number.MAX_SAFE_INTEGER, maxNodes: Number.MAX_SAFE_INTEGER })).toThrow('an Error whose name or message is not a string');
  });

  it('makes an AggregateError as msgpackr does (its message is the list of errors), counting the elements of that list first', () => {
    for (const message of ['abc', 'こんにちは🛹', '']) {
      const frame = pack(new AggregateError([], message));
      const read = decodeServerFrame(frame);
      expect(canon(read.value)).toBe(canon(unpack(frame)));
      expect((read.value as AggregateError).errors).toEqual([...message]);
      // The Error, its three parts, and one element for each code point
      expect(read.nodes).toBe(1 + 3 + [...message].length);
    }
    const long = pack(new AggregateError([], 'x'.repeat(600_000)));
    expect(() => decode(long)).toThrow(`it holds more than ${PACKET_LIMITS.maxNodes} values`);
  });

  it('counts the bytes of strings, bins and typed arrays again for every reference to them: one string referred to many times is refused, a few times read', () => {
    const big = ['x'.repeat(MiB)];
    const aliased = (times: number) => pack([7, Array.from({ length: times }, () => big)]);
    expect(aliased(40).byteLength).toBeLessThan(MiB + 1024);
    expect(() => decode(aliased(40))).toThrow(PacketOverLimit);
    expect(() => decode(aliased(40))).toThrow(`it holds more than ${PACKET_LIMITS.maxBytes} bytes of strings and binary data`);
    const few = decodeServerFrame(aliased(20));
    expect(few.bytes).toBe(20 * MiB);
    expect(few.nodes).toBe(3 + 20 * 2);
    // The same for a bin and a typed array
    for (const shared of [Buffer.alloc(MiB), new Float32Array(MiB / 4)]) {
      expect(() => decode(pack([7, Array.from({ length: 40 }, () => shared)]), { maxNodes: Number.MAX_SAFE_INTEGER })).toThrow(`it holds more than ${PACKET_LIMITS.maxBytes} bytes`);
    }
    // A record's property names count for every record
    const longName = 'k'.repeat(MiB);
    const records = pack([7, Array.from({ length: 40 }, (_, i) => ({ [longName]: i }))]);
    expect(records.byteLength).toBeLessThan(MiB + 1024);
    expect(() => decode(records)).toThrow(`it holds more than ${PACKET_LIMITS.maxBytes} bytes`);
    expect(decode(records, { maxBytes: 41 * MiB })).toEqual(unpack(records));
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
  it.each<[string, string, RefusalKind, () => Uint8Array]>([
    ['a value that refers to itself (a cycle)', 'a reference to a value that contains it (a cycle)', 'cycle', () => {
      const loop: unknown[] = [];
      loop.push(loop);
      return pack([0, loop]);
    }],
    ['a reference to nothing', 'a reference to nothing', 'reference', () => bytes(0x92, 0x00, 0xd6, 0x70, 0, 0, 0, 9)],
    ['a reference id that is defined inside itself', 'a reference id that is defined inside itself', 'reference', () => bytes(0xd6, 0x69, 0, 0, 0, 1, 0xd6, 0x69, 0, 0, 0, 1, 0xc0)],
    ['a reference id that is defined twice (msgpackr reads the second as a cycle)', 'a reference id that is defined twice', 'reference', () => bytes(0x92, 0xd6, 0x69, 0, 0, 0, 1, 0x90, 0xd6, 0x69, 0, 0, 0, 1, 0x91, 0xd6, 0x70, 0, 0, 0, 1)],
    ["a reference id that was a record definition's names, defined again", 'a reference id that is defined twice', 'reference', () => bytes(0x92, 0xd4, 0x72, 0x40, 0xd6, 0x69, 0, 0, 0, 1, 0x91, 0xa1, 0x61, 0x01, 0xd6, 0x69, 0, 0, 0, 1, 0x90)],
    ['a typed array of a kind msgpackr has no code for (its own decoder fails on it too)', 'a typed array of kind', 'typed array', () => pack([0, new Float16Array([1])])],
    ['a typed array whose bytes are not whole elements', 'a typed array whose bytes are not whole elements', 'typed array', () => bytes(0xc7, 0x04, 0x74, 0x07, 0x00, 0x00, 0x00)],
    ['a typed array without its kind', 'a typed array without its kind', 'typed array', () => bytes(0xc7, 0x00, 0x74)],
    ['a typed array longer than the frame', 'the frame ends in the middle of a value', 'cut short', () => bytes(0xc9, 0x7f, 0xff, 0xff, 0xff, 0x74, 0x01, 0x00)],
    ['a typed array in fixext (msgpackr writes ext 8, 16 or 32)', 'extension type 0x74 with 2 byte(s) after 0xd5', 'extension', () => bytes(0xd5, 0x74, 0x01, 0x07)],
    ['an extension with a longer header than its length needs', 'an extension with a longer header than msgpackr writes', 'extension', () => bytes(0xc8, 0x00, 0x02, 0x74, 0x01, 0x07)],
    ['a big integer without its bytes', 'a big integer without its bytes', 'big integer', () => bytes(0xc7, 0x00, 0x42)],
    ['a big integer of 16 bytes in ext 8 (msgpackr writes fixext 16)', 'extension type 0x42 with 16 byte(s) after 0xc7', 'extension', () => bytes(0xc7, 0x10, 0x42, ...new Array(16).fill(1))],
    ['a Set that is not followed by an array', 'a Set that is not written as msgpackr writes one', 'Set', () => bytes(0xd4, 0x73, 0x00, 0x01)],
    ['a Set marker with another filler byte', 'a Set that is not written as msgpackr writes one', 'Set', () => bytes(0xd4, 0x73, 0x05, 0x90)],
    ['a Set marker in ext 8', 'a Set that is not written as msgpackr writes one', 'Set', () => bytes(0xc7, 0x01, 0x73, 0x00, 0x90)],
    ['an Error that is not three values', 'an Error that is not written as msgpackr writes one', 'Error', () => bytes(0xd4, 0x65, 0x00, 0x92, 0xa1, 0x45, 0xa1, 0x6d)],
    ['a RegExp whose pattern does not compile', 'a RegExp whose pattern does not compile', 'RegExp', () => bytes(0xd4, 0x78, 0x00, 0x92, 0xa1, 0x28, 0xa0)],
    ['a RegExp whose source is not a string', 'a RegExp that is not written as msgpackr writes one', 'RegExp', () => bytes(0xd4, 0x78, 0x00, 0x92, 0x01, 0xa0)],
    ['bundled strings (an option neither server sets)', 'extension type 0x62 with 4 byte(s)', 'extension', () => bytes(0xd6, 0x62, 0x00, 0x00, 0x00, 0x05, 0xc0)],
    ['a value that refers to a record definition\'s names', 'a reference to nothing', 'reference', () => bytes(0x92, 0xd4, 0x72, 0x40, 0xd6, 0x69, 0, 0, 0, 1, 0x91, 0xa1, 0x61, 0x01, 0xd6, 0x70, 0, 0, 0, 1)],
    ["a record definition whose names refer to a value", 'a record definition whose keys refer to something that is not a list of names', 'record definition', () => bytes(0x92, 0xd6, 0x69, 0, 0, 0, 1, 0x91, 0xa1, 0x61, 0xd4, 0x72, 0x40, 0xd6, 0x70, 0, 0, 0, 1, 0x01)],
    ['a record definition in ext 8 (msgpackr: an unknown extension)', 'extension type 0x72 with 1 byte(s) after 0xc7', 'extension', () => bytes(0xc7, 0x01, 0x72, 0x40, 0x91, 0xa1, 0x61, 0x01)],
    ['an id reference in ext 8 (msgpackr writes fixext 4)', 'extension type 0x69 with 4 byte(s) after 0xc7', 'extension', () => bytes(0x92, 0xc7, 0x04, 0x69, 0, 0, 0, 1, 0x90, 0xd6, 0x70, 0, 0, 0, 1)],
    ['a pointer reference in ext 8', 'extension type 0x70 with 4 byte(s) after 0xc7', 'extension', () => bytes(0x92, 0xd6, 0x69, 0, 0, 0, 1, 0x90, 0xc7, 0x04, 0x70, 0, 0, 0, 1)],
    ['the reserved byte 0xc1', 'byte 0xc1', 'reserved byte', () => bytes(0xc1)],
    ['a two-byte record definition', 'a two-byte record definition', 'record definition', () => bytes(0xd5, 0x72, 0x60, 0x00, 0x90)],
    ['an unknown extension', 'extension type 0x41 with 1 byte(s)', 'extension', () => bytes(0xd4, 0x41, 0x00)],
    ['a timestamp of a size that is not one', 'extension type 0xff with 2 byte(s)', 'extension', () => bytes(0xd5, 0xff, 0x00, 0x00)],
    ['a timestamp of 4 bytes in ext 8 (msgpackr writes fixext 4)', 'extension type 0xff with 4 byte(s) after 0xc7', 'extension', () => bytes(0xc7, 0x04, 0xff, 0, 0, 0, 1)],
    ['an invalid date that does not hold 0xff', 'extension type 0xff with 1 byte(s)', 'extension', () => bytes(0xd4, 0xff, 0x00)],
    ['undefined that does not hold 0', 'extension type 0x0 with 1 byte(s)', 'extension', () => bytes(0xd4, 0x00, 0x01)],
    ['a record definition whose keys are not strings', 'a record definition whose keys are not strings', 'record definition', () => bytes(0xd4, 0x72, 0x40, 0x91, 0x01, 0x01)],
    ['a record definition that announces more keys than the frame holds', 'the frame ends in the middle of a value', 'cut short', () => bytes(0xd4, 0x72, 0x40, 0xdd, 0x7f, 0xff, 0xff, 0xff, 0xa1, 0x61)],
    ['a frame cut short', 'the frame ends in the middle of a value', 'cut short', () => pack([7, { id: 'e1', p: [1, 2, 3] }]).subarray(0, 12)],
    ['a string longer than the frame', 'the frame ends in the middle of a value', 'cut short', () => bytes(0xdb, 0x7f, 0xff, 0xff, 0xff, 0x61)],
    ['bytes after the packet', 'bytes after the packet', 'trailing bytes', () => Uint8Array.from([...pack([7, 'e1']), 0xc0])],
    ['an empty frame', 'the frame ends in the middle of a value', 'cut short', () => bytes()],
  ])('%s', (_what, why, kind, frame) => {
    expect(() => decode(frame())).toThrow(PacketRefused);
    expect(() => decode(frame())).toThrow(why);
    expect(() => decode(frame())).toThrow(expect.objectContaining({ kind }));
  });

  it('reads each extension in the framing the packer writes it in', () => {
    // fixext 1 (undefined, an invalid date, Set, Error, RegExp), fixext 4 and 8 (dates), ext 8 of 12 (a date
    // before 1970), fixext 16 and ext 8 (big integers), ext 8/16/32 (typed arrays), fixext 4 (references)
    const shared = { at: 1 };
    const values = [undefined, new Date(Number.NaN), new Set([1]), new Error('e'), /a/g, new Date(1_700_000_000_000), new Date(1_700_000_000_123), new Date(-1), 2n ** 64n, 2n ** 130n, new Uint8Array(3), new Uint8Array(300), new Uint8Array(70_000), [shared, shared]];
    const frame = pack(values);
    for (const header of ['d40000', 'd4ffff', 'd47300', 'd46500', 'd47800', 'd6ff', 'd7ff', 'c70cff', 'd842', 'c71842', 'c70474', 'c8012d74', 'c900011171', 'd669', 'd670']) {
      expect(hex(frame), header).toContain(header);
    }
    expect(canon(decode(frame))).toBe(canon(unpack(frame)));
  });

  it('reads a frame that sits at an offset in a larger buffer', () => {
    const frame = pack([7, { id: 'e1', p: [1, 2, 3], at: new Date(1_700_000_000_000), text: 'こんにちは' }]);
    const padded = new Uint8Array(frame.byteLength + 7);
    padded.set(frame, 3);
    expect(decode(padded.subarray(3, 3 + frame.byteLength))).toEqual(unpack(frame));
  });
});
