/**
 * Decodes one frame from the world under limits on what it may become in memory.
 *
 * The world's server packs its packets with msgpackr (`new Packr({ structuredClone: true })`):
 * MessagePack with msgpackr's record extension (an object is written as a record: its keys once,
 * then only values) and its extensions for `undefined`, dates and repeated references. msgpackr's
 * own decoder has no limit: a frame of N bytes can hold N empty arrays or objects, each of which
 * costs tens of bytes once decoded, and its reference extension lets one small subtree appear any
 * number of times in the value.
 *
 * This decoder reads the same format and counts while it reads:
 *  - nodes: every value it produces (each number, string, null, array, map, object, each element
 *    and each property value; a map's keys too). A subtree that is referred to again (the pointer
 *    extension) is counted again in full for every reference, so the count is the size of the
 *    value as code that walks it sees it. Containers are charged at their header, before anything
 *    is allocated for them, and may not announce more elements than the frame has bytes left.
 *  - depth: how deep arrays, maps, records and reference wrappers nest.
 * Over either limit it throws PacketOverLimit before building any more of the value.
 *
 * What it reads: nil, booleans, integers (64-bit ones as BigInt, as msgpackr does), floats,
 * strings, bin, arrays, maps (as Map: with records on, msgpackr writes only Map objects as maps),
 * record definitions and records with one-byte ids, `undefined` (fixext 1, type 0), timestamps
 * (type 0xff), and the reference extensions 'i' and 'p' without cycles. Anything else (other
 * extension types, two-byte record ids, bundled strings, the reserved byte 0xc1, a reference to a
 * value that is still being read, trailing bytes) is refused with PacketRefused: no packet of the
 * world's protocol holds any of it.
 */

export interface DecodeLimits {
  maxNodes: number;
  maxDepth: number;
}

/**
 * What one frame may decode into. 500,000 values: a snapshot of a world with ten thousand
 * entities stays well under it (an entity is about 30 values), and so does everything else the
 * protocol sends; the 8 MB frame limit alone would allow 8 million. 64 levels: the protocol's own
 * packets nest a handful deep (an entity's state and a blueprint's props are the deepest, and
 * those are the builders' data).
 */
export const PACKET_LIMITS: Readonly<DecodeLimits> = Object.freeze({ maxNodes: 500_000, maxDepth: 64 });

/** The frame would decode into more than the limits allow. Nothing of it is used. */
export class PacketOverLimit extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PacketOverLimit';
  }
}

/** The frame is not something the world's protocol sends (or is cut short). Nothing of it is used. */
export class PacketRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PacketRefused';
  }
}

export interface Decoded {
  value: unknown;
  /** The values counted while decoding (see above) */
  nodes: number;
}

const utf8 = new TextDecoder('utf-8');
const EXT_UNDEFINED = 0x00;
const EXT_RECORD = 0x72;
const EXT_ID = 0x69;
const EXT_POINTER = 0x70;
const EXT_TIMESTAMP = 0xff;

export function decodeServerFrame(frame: Uint8Array, limits: DecodeLimits = PACKET_LIMITS): Decoded {
  const length = frame.byteLength;
  const view = new DataView(frame.buffer, frame.byteOffset, length);
  let position = 0;
  let nodes = 0;
  /** Record structures by id (0 to 63): the property names, in order */
  const structures: (string[] | undefined)[] = [];
  /** Values named by the id extension that are complete, with what each counted */
  const references = new Map<number, { value: unknown; nodes: number }>();
  /** Ids whose value is still being read: a pointer to one would close a cycle */
  const open = new Set<number>();

  const refuse: (why: string) => never = (why) => {
    throw new PacketRefused(`${why} (at byte ${position} of ${length})`);
  };
  const need = (bytes: number) => {
    if (position + bytes > length) refuse('the frame ends in the middle of a value');
  };
  const charge = (count: number) => {
    nodes += count;
    if (nodes > limits.maxNodes) throw new PacketOverLimit(`it holds more than ${limits.maxNodes} values`);
  };
  const deeper = (depth: number): number => {
    if (depth >= limits.maxDepth) throw new PacketOverLimit(`it nests more than ${limits.maxDepth} levels deep`);
    return depth + 1;
  };
  /**
   * A container of `count` slots (its elements; for a map, keys and values): each is at least one
   * byte of the frame, and each is one node, charged here, before the container is allocated.
   * (The container itself was charged by whatever holds it.)
   */
  const container = (count: number, slotsEach = 1) => {
    need(count * slotsEach);
    charge(count * slotsEach);
  };

  const text = (bytes: number): string => {
    need(bytes);
    const start = position;
    position += bytes;
    return utf8.decode(frame.subarray(start, position));
  };
  const binary = (bytes: number): Uint8Array => {
    need(bytes);
    const start = position;
    position += bytes;
    // A copy (msgpackr gives a view): a view would keep the whole frame alive
    return Uint8Array.prototype.slice.call(frame, start, position);
  };
  const array = (count: number, depth: number): unknown[] => {
    container(count);
    const inside = deeper(depth);
    const out = new Array<unknown>(count);
    for (let i = 0; i < count; i++) out[i] = value(inside);
    return out;
  };
  const map = (count: number, depth: number): Map<unknown, unknown> => {
    container(count, 2);
    const inside = deeper(depth);
    const out = new Map<unknown, unknown>();
    for (let i = 0; i < count; i++) {
      const key = value(inside);
      out.set(key, value(inside));
    }
    return out;
  };
  const record = (keys: string[], depth: number): Record<string, unknown> => {
    container(keys.length);
    const inside = deeper(depth);
    const out: Record<string, unknown> = {};
    // msgpackr's rename: no value can be written onto the prototype slot
    for (const key of keys) out[key === '__proto__' ? '__proto_' : key] = value(inside);
    return out;
  };
  const define = (id: number, depth: number): Record<string, unknown> => {
    // The property names, as an array of strings, then the first record of that structure
    const before = nodes;
    const keys = value(depth);
    if (!Array.isArray(keys) || !keys.every((key) => typeof key === 'string')) refuse('a record definition whose keys are not strings');
    // The names are not part of the value (they were counted, against the limit, while they were read)
    nodes = before;
    structures[id & 0x3f] = keys as string[];
    return record(keys as string[], depth);
  };
  const timestamp = (bytes: number): Date => {
    need(bytes);
    const at = position;
    position += bytes;
    if (bytes === 4) return new Date(view.getUint32(at) * 1000);
    if (bytes === 8) {
      const high = view.getUint32(at);
      const low = view.getUint32(at + 4);
      return new Date((high >>> 2) / 1e6 + ((high & 0x3) * 0x100000000 + low) * 1000);
    }
    const nanoseconds = view.getUint32(at);
    const seconds = Number(view.getBigInt64(at + 4));
    return new Date(nanoseconds / 1e6 + seconds * 1000);
  };
  /** An extension of `bytes` data bytes, whose type byte is next */
  const extension = (bytes: number, depth: number): unknown => {
    need(1 + bytes);
    const type = frame[position++];
    if (type === EXT_TIMESTAMP && (bytes === 4 || bytes === 8 || bytes === 12)) return timestamp(bytes);
    if (bytes === 1 && type === EXT_UNDEFINED) {
      position++;
      return undefined;
    }
    if (bytes === 1 && type === EXT_RECORD) return define(frame[position++], depth);
    if (bytes === 4 && type === EXT_ID) {
      const id = view.getUint32(position);
      position += 4;
      if (open.has(id)) refuse('a reference id that is defined inside itself');
      open.add(id);
      const before = nodes;
      const named = value(deeper(depth));
      open.delete(id);
      // What it counted: itself (charged by whatever holds it) and everything in it
      references.set(id, { value: named, nodes: 1 + nodes - before });
      return named;
    }
    if (bytes === 4 && type === EXT_POINTER) {
      const id = view.getUint32(position);
      position += 4;
      const known = references.get(id);
      if (!known) return refuse(open.has(id) ? 'a reference to a value that contains it (a cycle)' : 'a reference to nothing');
      // Counted again in full: whoever walks the value meets it once more (one node of it was
      // charged already, for the pointer)
      charge(known.nodes - 1);
      return known.value;
    }
    return refuse(`extension type 0x${type.toString(16)} with ${bytes} byte(s)`);
  };

  /** The next value. It is one node, which whoever asked for it has charged. */
  function value(depth: number): unknown {
    need(1);
    const token = frame[position++];
    if (token < 0x40) return token;
    if (token < 0x80) {
      const structure = structures[token & 0x3f];
      // Not a record of a structure defined so far: the positive integer the byte is in MessagePack
      return structure ? record(structure, depth) : token;
    }
    if (token < 0x90) return map(token - 0x80, depth);
    if (token < 0xa0) return array(token - 0x90, depth);
    if (token < 0xc0) return text(token - 0xa0);
    if (token >= 0xe0) return token - 0x100;
    switch (token) {
      case 0xc0:
        return null;
      case 0xc2:
        return false;
      case 0xc3:
        return true;
      case 0xc4:
        need(1);
        return binary(frame[position++]);
      case 0xc5:
        need(2);
        return binary(view.getUint16((position += 2) - 2));
      case 0xc6:
        need(4);
        return binary(view.getUint32((position += 4) - 4));
      case 0xc7:
        need(1);
        return extension(frame[position++], depth);
      case 0xca:
        need(4);
        return view.getFloat32((position += 4) - 4);
      case 0xcb:
        need(8);
        return view.getFloat64((position += 8) - 8);
      case 0xcc:
        need(1);
        return frame[position++];
      case 0xcd:
        need(2);
        return view.getUint16((position += 2) - 2);
      case 0xce:
        need(4);
        return view.getUint32((position += 4) - 4);
      case 0xcf:
        need(8);
        return view.getBigUint64((position += 8) - 8);
      case 0xd0:
        need(1);
        return view.getInt8(position++);
      case 0xd1:
        need(2);
        return view.getInt16((position += 2) - 2);
      case 0xd2:
        need(4);
        return view.getInt32((position += 4) - 4);
      case 0xd3:
        need(8);
        return view.getBigInt64((position += 8) - 8);
      case 0xd4:
        return extension(1, depth);
      case 0xd6:
        return extension(4, depth);
      case 0xd7:
        return extension(8, depth);
      case 0xd9:
        need(1);
        return text(frame[position++]);
      case 0xda:
        need(2);
        return text(view.getUint16((position += 2) - 2));
      case 0xdb:
        need(4);
        return text(view.getUint32((position += 4) - 4));
      case 0xdc:
        need(2);
        return array(view.getUint16((position += 2) - 2), depth);
      case 0xdd:
        need(4);
        return array(view.getUint32((position += 4) - 4), depth);
      case 0xde:
        need(2);
        return map(view.getUint16((position += 2) - 2), depth);
      case 0xdf:
        need(4);
        return map(view.getUint32((position += 4) - 4), depth);
      default:
        // 0xc1 (never used; msgpackr's bundled strings), ext 16/32 and fixext 2/16
        return refuse(`byte 0x${token.toString(16)}`);
    }
  }

  charge(1);
  const decoded = value(0);
  if (position !== length) refuse('bytes after the packet');
  return { value: decoded, nodes };
}
