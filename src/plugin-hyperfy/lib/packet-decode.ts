/**
 * Decodes one frame from the world under limits on what it may become in memory.
 *
 * The world's server packs its packets with msgpackr (`new Packr({ structuredClone: true })`, both
 * coo-world's src/core/packets.js and the bundled engine's): MessagePack with msgpackr's record
 * extension (an object is written as a record: its keys once, then only values), its reference
 * extensions for a value held twice, and, as structuredClone turns on moreTypes, extensions for the
 * other values an app may keep in its state. msgpackr's own decoder has no limit: a frame of N
 * bytes can hold N empty arrays or objects, each of which costs tens of bytes once decoded, and its
 * reference extension lets one small subtree appear any number of times in the value.
 *
 * This decoder reads the same format and counts while it reads:
 *  - nodes: every value it produces (each number, string, null, array, map, object, Set, each
 *    element and each property value; a map's keys too; a typed array's elements; a big integer's
 *    64-bit words). A subtree that is referred to again (the pointer extension) is counted again in
 *    full for every reference, so the count is the size of the value as code that walks it sees it.
 *    Containers are charged at their header, before anything is allocated for them, and may not
 *    announce more elements than the frame has bytes left; a typed array's bytes are checked
 *    against what is left of the frame before they are copied.
 *  - depth: how deep arrays, maps, records, Sets and reference wrappers nest; a reference to a
 *    subtree counts that subtree's height at the depth it is put at.
 * Over either limit it throws PacketOverLimit before building any more of the value.
 *
 * What it reads, as msgpackr returns it (SERVER_TYPES): nil, booleans, integers (64-bit ones as
 * BigInt), floats, strings (a leading BOM kept), bin, arrays, maps (as Map: with records on,
 * msgpackr writes only Map objects as maps), record definitions (one-byte ids; their keys a list of
 * names, or a reference to one) and records, `undefined`, dates (also an invalid one), Set, Error,
 * RegExp, typed arrays, ArrayBuffer and DataView, big integers beyond 64 bits, and the reference
 * extensions without cycles. Refused with PacketRefused, as nothing the two servers send holds
 * them: two-byte record ids, bundled strings, the reserved byte 0xc1, other extension types, a
 * typed array of a kind msgpackr has no code for (its own decoder fails on it as well), a cycle,
 * a reference to a value that is not complete, and trailing bytes.
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

// msgpackr keeps a leading BOM in a string; so does this
const utf8 = new TextDecoder('utf-8', { ignoreBOM: true });
const EXT_UNDEFINED = 0x00;
const EXT_BIGINT = 0x42;
const EXT_ERROR = 0x65;
const EXT_ID = 0x69;
const EXT_POINTER = 0x70;
const EXT_RECORD = 0x72;
const EXT_SET = 0x73;
const EXT_TYPED = 0x74;
const EXT_REGEXP = 0x78;
const EXT_TIMESTAMP = 0xff;
/** msgpackr's typed-array codes (unpack.js typedArrays); 16 is an ArrayBuffer, 17 a DataView */
const TYPED_ARRAYS = [Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array];
const ARRAY_BUFFER = 16;
const DATA_VIEW = 17;
/** The errors msgpackr rebuilds by name; any other name makes an Error with that name */
const ERRORS: Record<string, (message: unknown, options: { cause: unknown }) => Error> = {
  Error: (message, options) => Error(message as string, options),
  EvalError: (message, options) => EvalError(message as string, options),
  RangeError: (message, options) => RangeError(message as string, options),
  ReferenceError: (message, options) => ReferenceError(message as string, options),
  SyntaxError: (message, options) => SyntaxError(message as string, options),
  TypeError: (message, options) => TypeError(message as string, options),
  URIError: (message, options) => URIError(message as string, options),
  // As msgpackr calls it: the message where the list of errors goes
  AggregateError: (message, options) => (AggregateError as unknown as (errors: Iterable<unknown>, message: unknown) => Error)(message as Iterable<unknown>, options),
};

/** What one reference id names: the value, what it counted, and how many levels it nests */
interface Reference {
  value: unknown;
  nodes: number;
  height: number;
  /** A record definition's list of names (only another definition may refer to it) */
  names?: true;
}

export function decodeServerFrame(frame: Uint8Array, limits: DecodeLimits = PACKET_LIMITS): Decoded {
  const length = frame.byteLength;
  const view = new DataView(frame.buffer, frame.byteOffset, length);
  let position = 0;
  let nodes = 0;
  /** The deepest level reached so far (see deeper) */
  let reach = 0;
  /** Record structures by id (0 to 63): the property names, in order */
  const structures: (string[] | undefined)[] = [];
  /** Values named by the id extension that are complete */
  const references = new Map<number, Reference>();
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
  /** The level inside a container at `depth`; also notes it as reached */
  const deeper = (depth: number): number => {
    if (depth >= limits.maxDepth) throw new PacketOverLimit(`it nests more than ${limits.maxDepth} levels deep`);
    if (depth + 1 > reach) reach = depth + 1;
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
  const id32 = (): number => {
    need(4);
    const id = view.getUint32(position);
    position += 4;
    return id;
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
  /** The element count of the array header at the current byte, or -1 when it is no array */
  const arrayHeader = (): number => {
    need(1);
    const token = frame[position];
    if (token >= 0x90 && token < 0xa0) return position++, token - 0x90;
    if (token === 0xdc) return need(3), position++, view.getUint16((position += 2) - 2);
    if (token === 0xdd) return need(5), position++, view.getUint32((position += 4) - 4);
    return -1;
  };
  /** The array a Set, an Error or a RegExp is written as (msgpackr writes a fresh array: never a reference) */
  const listOf = (what: string, depth: number, exactly?: number): unknown[] => {
    const count = arrayHeader();
    if (count < 0 || (exactly !== undefined && count !== exactly)) refuse(`${what} that is not written as msgpackr writes one`);
    return array(count, depth);
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
  /**
   * A record definition's property names: a list of strings and nothing else, read here without
   * recursing. msgpackr may wrap it in an id (its first definition) and refer to it from a later
   * definition of the same shape (when it runs out of record ids and reuses one).
   */
  const names = (): string[] => {
    need(1);
    const wrapped = frame[position] === 0xd6 && position + 1 < length;
    if (wrapped && frame[position + 1] === EXT_POINTER) {
      position += 2;
      const known = references.get(id32());
      if (!known?.names) refuse('a record definition whose keys refer to something that is not a list of names');
      return known.value as string[];
    }
    let id: number | null = null;
    if (wrapped && frame[position + 1] === EXT_ID) {
      position += 2;
      id = id32();
    }
    const count = arrayHeader();
    if (count < 0) refuse('a record definition whose keys are not a list');
    need(count);
    const out = new Array<string>(count);
    for (let i = 0; i < count; i++) {
      need(1);
      const token = frame[position++];
      if (token >= 0xa0 && token < 0xc0) out[i] = text(token - 0xa0);
      else if (token === 0xd9) out[i] = (need(1), text(frame[position++]));
      else if (token === 0xda) out[i] = (need(2), text(view.getUint16((position += 2) - 2)));
      else if (token === 0xdb) out[i] = (need(4), text(view.getUint32((position += 4) - 4)));
      else refuse('a record definition whose keys are not strings');
    }
    if (id !== null) references.set(id, { value: out, nodes: 0, height: 0, names: true });
    return out;
  };
  const define = (id: number, depth: number): Record<string, unknown> => {
    // The property names (not part of the value), then the first record of that structure
    const keys = names();
    structures[id & 0x3f] = keys;
    return record(keys, depth);
  };
  const timestamp = (bytes: number): Date => {
    const at = position;
    position += bytes;
    if (bytes === 1) return new Date(Number.NaN);
    if (bytes === 4) return new Date(view.getUint32(at) * 1000);
    if (bytes === 8) {
      const high = view.getUint32(at);
      const low = view.getUint32(at + 4);
      return new Date((high >>> 2) / 1e6 + ((high & 0x3) * 0x100000000 + low) * 1000);
    }
    // msgpackr's arithmetic (unpack.js extension 0xff): the sign bit, then the low 48 bits of the seconds
    const d = (i: number) => frame[at + i];
    const seconds = (d(4) & 0x80 ? -0x1000000000000 : 0) + d(6) * 0x10000000000 + d(7) * 0x100000000 + d(8) * 0x1000000 + (d(9) << 16) + (d(10) << 8) + d(11);
    // (its nanoseconds as a signed 32-bit sum, as msgpackr computes them)
    return new Date(((d(0) << 24) + (d(1) << 16) + (d(2) << 8) + d(3)) / 1e6 + seconds * 1000);
  };
  /** A typed array, ArrayBuffer or DataView of `bytes` data bytes (its kind code first) */
  const typed = (bytes: number): unknown => {
    if (bytes < 1) refuse('a typed array without its kind');
    const code = frame[position++];
    const Kind = TYPED_ARRAYS[code];
    if (!Kind && code !== ARRAY_BUFFER && code !== DATA_VIEW) refuse(`a typed array of kind ${code}, which msgpackr has no code for`);
    const byteLength = bytes - 1;
    const size = Kind ? Kind.BYTES_PER_ELEMENT : 1;
    if (byteLength % size !== 0) refuse('a typed array whose bytes are not whole elements');
    // Its elements are values like any other (the array itself was charged by whatever holds it)
    charge(byteLength / size);
    // A copy, as msgpackr makes: aligned for its kind, and not a view that keeps the frame alive
    const buffer = Uint8Array.prototype.slice.call(frame, position, position + byteLength).buffer;
    position += byteLength;
    return Kind ? new Kind(buffer) : code === ARRAY_BUFFER ? buffer : new DataView(buffer);
  };
  /** A big integer beyond 64 bits (msgpackr unpack.js extension 0x42, the same arithmetic) */
  const bigint = (bytes: number): bigint => {
    if (bytes < 1) refuse('a big integer without its bytes');
    // One value per 64-bit word beyond the first (the integer itself was charged by whatever holds it)
    charge(Math.ceil(bytes / 8) - 1);
    const start = position;
    position += bytes;
    const headLength = bytes % 8 || 8;
    let head = BigInt(frame[start] & 0x80 ? frame[start] - 0x100 : frame[start]);
    for (let i = 1; i < headLength; i++) head = (head << 8n) + BigInt(frame[start + i]);
    if (bytes === headLength) return head;
    const words = (from: number, to: number): bigint => {
      if (to - from <= 40) {
        let out = view.getBigUint64(start + from);
        for (let i = from + 8; i < to; i += 8) out = (out << 64n) | view.getBigUint64(start + i);
        return out;
      }
      const middle = from + (((to - from) >> 4) << 3);
      return (words(from, middle) << BigInt((to - middle) * 8)) | words(middle, to);
    };
    return (head << BigInt((bytes - headLength) * 8)) | words(headLength, bytes);
  };
  const error = (parts: unknown[]): Error => {
    const [name, message, cause] = parts;
    // Only the table's own names (msgpackr's lookup would also find Object.prototype's members)
    if (typeof name === 'string' && Object.prototype.hasOwnProperty.call(ERRORS, name)) return ERRORS[name](message, { cause });
    const made = Error(message as string, { cause });
    made.name = name as string;
    return made;
  };
  /** A one-byte marker extension (Set, Error, RegExp) is followed by a filler byte, then its array */
  const marker = (bytes: number, what: string) => {
    if (bytes !== 1 || frame[position] !== 0) refuse(`${what} that is not written as msgpackr writes one`);
    position++;
  };
  /** An extension of `bytes` data bytes, whose type byte is next */
  const extension = (bytes: number, depth: number): unknown => {
    need(1 + bytes);
    const type = frame[position++];
    switch (type) {
      case EXT_TIMESTAMP:
        if (bytes === 1 || bytes === 4 || bytes === 8 || bytes === 12) return timestamp(bytes);
        break;
      case EXT_UNDEFINED:
        if (bytes !== 1) break;
        position++;
        return undefined;
      case EXT_RECORD:
        if (bytes !== 1) return refuse('a two-byte record definition');
        return define(frame[position++], depth);
      case EXT_SET:
        marker(bytes, 'a Set');
        return new Set(listOf('a Set', depth));
      case EXT_ERROR:
        marker(bytes, 'an Error');
        return error(listOf('an Error', depth, 3));
      case EXT_REGEXP: {
        marker(bytes, 'a RegExp');
        const [source, flags] = listOf('a RegExp', depth, 2);
        if (typeof source !== 'string' || typeof flags !== 'string') return refuse('a RegExp that is not written as msgpackr writes one');
        try {
          return new RegExp(source, flags);
        } catch {
          return refuse('a RegExp whose pattern does not compile');
        }
      }
      case EXT_TYPED:
        return typed(bytes);
      case EXT_BIGINT:
        return bigint(bytes);
      case EXT_ID: {
        if (bytes !== 4) break;
        const id = id32();
        if (open.has(id)) refuse('a reference id that is defined inside itself');
        open.add(id);
        const before = nodes;
        const inside = deeper(depth);
        const outerReach = reach;
        reach = inside;
        const named = value(inside);
        // How many levels it nests below where it stands (0 for a plain value)
        const height = reach - inside;
        reach = Math.max(outerReach, reach);
        open.delete(id);
        // What it counted: itself (charged by whatever holds it) and everything in it
        references.set(id, { value: named, nodes: 1 + nodes - before, height });
        return named;
      }
      case EXT_POINTER: {
        if (bytes !== 4) break;
        const id = id32();
        const known = references.get(id);
        if (!known || known.names) return refuse(open.has(id) ? 'a reference to a value that contains it (a cycle)' : 'a reference to nothing');
        // Its levels, from where it is put now
        if (depth + known.height > limits.maxDepth) throw new PacketOverLimit(`it nests more than ${limits.maxDepth} levels deep`);
        if (depth + known.height > reach) reach = depth + known.height;
        // Counted again in full: whoever walks the value meets it once more (one node of it was
        // charged already, for the pointer)
        charge(known.nodes - 1);
        return known.value;
      }
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
      case 0xc8:
        need(2);
        return extension(view.getUint16((position += 2) - 2), depth);
      case 0xc9:
        need(4);
        return extension(view.getUint32((position += 4) - 4), depth);
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
      case 0xd5:
        return extension(2, depth);
      case 0xd6:
        return extension(4, depth);
      case 0xd7:
        return extension(8, depth);
      case 0xd8:
        return extension(16, depth);
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
        // 0xc1: never used by either server (msgpackr's own placeholder)
        return refuse(`byte 0x${token.toString(16)}`);
    }
  }

  charge(1);
  const decoded = value(0);
  if (position !== length) refuse('bytes after the packet');
  return { value: decoded, nodes };
}
