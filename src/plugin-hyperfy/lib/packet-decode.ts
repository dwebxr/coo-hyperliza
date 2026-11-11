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
 *  - bytes: the bytes of every string, bin and typed array, and of a record's property names for
 *    every record. Like nodes, a subtree is counted again for every reference to it: one long
 *    string the frame holds once and refers to thousands of times is small in memory and gigabytes
 *    to code that walks, copies or prints the value.
 *  - depth: how deep arrays, maps, records, Sets, Errors, RegExps and reference wrappers nest; a
 *    reference to a subtree counts that subtree's height at the depth it is put at.
 * Over any of these limits it throws PacketOverLimit before building any more of the value.
 *
 * What it reads, as msgpackr writes it: nil, booleans, integers (64-bit ones as BigInt), floats,
 * strings (a leading BOM kept; msgpackr's JS decoder drops one from a string over 64 bytes), bin,
 * arrays, maps (as Map: with records on, msgpackr writes only
 * Map objects as maps), record definitions (one-byte ids; their keys a list of names, or a
 * reference to one) and records, `undefined`, dates (also an invalid one), Set, Error (its name
 * and message strings; the message may be nil), RegExp, typed arrays, ArrayBuffer and DataView, big
 * integers beyond 64 bits, and the reference extensions without cycles. Each extension only in the
 * framing msgpackr's packer gives it: fixext 1 for undefined, record definitions, Set, Error,
 * RegExp and an invalid date; fixext 4 for the id and pointer references; ext 8, 16 or 32 (the
 * shortest that fits) for typed arrays; for dates and big integers fixext where the data is 1, 2,
 * 4, 8 or 16 bytes and the shortest ext header otherwise.
 *
 * Refused with PacketRefused, whose `kind` names the rule in words that never quote the frame:
 * two-byte record ids, bundled strings, the reserved byte 0xc1, other extension types or framings,
 * a reference id defined twice, a typed array of a kind msgpackr has no code for (its own decoder
 * fails on it as well), an Error whose name or message is not a string (msgpackr would convert
 * whatever it is to a string, which can be far larger than the frame, or fail), a cycle, a
 * reference to a value that is not complete, and trailing bytes.
 *
 * The reference it is held to: for frames the servers' packers produce, the decoded value equals
 * what msgpackr 1.12.1 (this package's, and the bundled engine's) returns with its native
 * acceleration, as the agent ran it under Bun before this decoder existed; the one exception is an
 * Error named after a member of Object.prototype (such as `valueOf`), where msgpackr calls that
 * member and returns what it returns, and this decoder an Error of that name. coo-world's server
 * runs msgpackr 1.11.2, whose unpacker differs in two ways, both as they were before this decoder
 * existed (the agent then ran msgpackr 1.12.1's own unpack): Error subclasses and names (1.11.2
 * rebuilds only Error, TypeError and ReferenceError and names every other one Error; 1.12.1 and
 * this decoder rebuild all of the standard ones and keep any other name), and lone surrogates in
 * strings (1.11.2's JavaScript reader keeps one; natively both versions, like this decoder, read
 * each of its three bytes as U+FFFD).
 */

export interface DecodeLimits {
  maxNodes: number;
  maxDepth: number;
  maxBytes: number;
}

/**
 * What one frame may decode into.
 *
 * 500,000 values: a snapshot of 14,000 entities (with 300 blueprints and 50 chat messages; the
 * shape lib/packet-decode.test.ts measures) decodes into 399,215, about 28 an entity, so the limit
 * holds a world of about 17,500 entities of that kind, and everything else the protocol sends
 * stays far under it; the 8 MB frame limit alone would allow 8 million.
 *
 * 32 MiB of strings and binary data: four times the largest frame (world-protocol.ts
 * MAX_SERVER_FRAME_BYTES), as what a frame holds once is at most its own size; the rest is room for
 * what the protocol repeats (property names, once for every record; shared values). The
 * 14,000-entity snapshot comes to 2.0 MiB of it, and at the value limit (17,500 entities) 2.5 MiB:
 * the value limit is reached long before this one by anything but repetition.
 *
 * 64 levels: the protocol's own packets nest a handful deep (an entity's state and a blueprint's
 * props are the deepest, and those are the builders' data).
 */
export const PACKET_LIMITS: Readonly<DecodeLimits> = Object.freeze({ maxNodes: 500_000, maxDepth: 64, maxBytes: 32 * 1024 * 1024 });

/** The frame would decode into more than the limits allow. Nothing of it is used. */
export class PacketOverLimit extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PacketOverLimit';
  }
}

/** Which rule refused a frame: fixed words, safe to log (they never quote the frame) */
export type RefusalKind =
  | 'cut short'
  | 'trailing bytes'
  | 'reserved byte'
  | 'extension'
  | 'record definition'
  | 'reference'
  | 'cycle'
  | 'Error'
  | 'RegExp'
  | 'Set'
  | 'typed array'
  | 'big integer';

/** The frame is not something the world's protocol sends (or is cut short). Nothing of it is used. */
export class PacketRefused extends Error {
  readonly kind: RefusalKind;

  constructor(kind: RefusalKind, message: string) {
    super(message);
    this.name = 'PacketRefused';
    this.kind = kind;
  }
}

export interface Decoded {
  value: unknown;
  /** The values counted while decoding (see above) */
  nodes: number;
  /** The bytes counted while decoding (see above) */
  bytes: number;
}

// A leading BOM stays in the string. msgpackr keeps it too, except in its JS string decoder (no
// msgpackr-extract) for a string over 64 bytes
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
const ERRORS: Record<string, (message: string | null, options: { cause: unknown }) => Error> = {
  Error: (message, options) => Error(message as string, options),
  EvalError: (message, options) => EvalError(message as string, options),
  RangeError: (message, options) => RangeError(message as string, options),
  ReferenceError: (message, options) => ReferenceError(message as string, options),
  SyntaxError: (message, options) => SyntaxError(message as string, options),
  TypeError: (message, options) => TypeError(message as string, options),
  URIError: (message, options) => URIError(message as string, options),
  // As msgpackr calls it: the message where the list of errors goes (one element for each of its code points)
  AggregateError: (message, options) => (AggregateError as unknown as (errors: Iterable<unknown>, message: unknown) => Error)(message as Iterable<unknown>, options),
};

/** The values written as a marker extension and an array */
type Marked = 'Set' | 'Error' | 'RegExp';
const MARKED: Record<Marked, string> = { Set: 'a Set', Error: 'an Error', RegExp: 'a RegExp' };

/** The code points of `text`, and the bytes it is in UTF-8 */
function measureText(text: string): { points: number; bytes: number } {
  let points = 0;
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    points++;
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if ((unit & 0xfc00) === 0xd800 && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return { points, bytes };
}

/** A record structure: its property names in order, and their bytes */
interface Structure {
  keys: string[];
  bytes: number;
}

/** What one reference id names: the value, what it counted, and how many levels it nests */
interface Reference {
  value: unknown;
  nodes: number;
  bytes: number;
  height: number;
  /** A record definition's list of names (only another definition may refer to it) */
  names?: Structure;
}

export function decodeServerFrame(frame: Uint8Array, limits: DecodeLimits = PACKET_LIMITS): Decoded {
  const length = frame.byteLength;
  const view = new DataView(frame.buffer, frame.byteOffset, length);
  let position = 0;
  let nodes = 0;
  let weight = 0;
  /** The deepest level reached so far (see deeper) */
  let reach = 0;
  /** Record structures by id (0 to 63) */
  const structures: (Structure | undefined)[] = [];
  /** Values named by the id extension that are complete */
  const references = new Map<number, Reference>();
  /** Ids whose value is still being read: a pointer to one would close a cycle */
  const open = new Set<number>();

  const refuse = (kind: RefusalKind, why: string): never => {
    throw new PacketRefused(kind, `${why} (at byte ${position} of ${length})`);
  };
  const need = (bytes: number) => {
    if (position + bytes > length) refuse('cut short', 'the frame ends in the middle of a value');
  };
  const charge = (count: number) => {
    nodes += count;
    if (nodes > limits.maxNodes) throw new PacketOverLimit(`it holds more than ${limits.maxNodes} values`);
  };
  const weigh = (bytes: number) => {
    weight += bytes;
    if (weight > limits.maxBytes) throw new PacketOverLimit(`it holds more than ${limits.maxBytes} bytes of strings and binary data`);
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

  /** `bytes` of UTF-8, uncounted (a record's names are counted with each record) */
  const text = (bytes: number): string => {
    need(bytes);
    const start = position;
    position += bytes;
    return utf8.decode(frame.subarray(start, position));
  };
  const string = (bytes: number): string => {
    need(bytes);
    weigh(bytes);
    return text(bytes);
  };
  const binary = (bytes: number): Uint8Array => {
    need(bytes);
    weigh(bytes);
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
  const listOf = (kind: Marked, depth: number, exactly?: number): unknown[] => {
    const count = arrayHeader();
    if (count < 0 || (exactly !== undefined && count !== exactly)) refuse(kind, `${MARKED[kind]} that is not written as msgpackr writes one`);
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
  const record = (structure: Structure, depth: number): Record<string, unknown> => {
    container(structure.keys.length);
    // Its names, as code that walks the object meets them
    weigh(structure.bytes);
    const inside = deeper(depth);
    const out: Record<string, unknown> = {};
    // msgpackr's rename: no value can be written onto the prototype slot
    for (const key of structure.keys) out[key === '__proto__' ? '__proto_' : key] = value(inside);
    return out;
  };
  /** A reference id that is defined now: once only, and not inside its own definition */
  const defining = (id: number) => {
    if (open.has(id)) refuse('reference', 'a reference id that is defined inside itself');
    if (references.has(id)) refuse('reference', 'a reference id that is defined twice');
  };
  /**
   * A record definition's property names: a list of strings and nothing else, read here without
   * recursing. msgpackr may wrap it in an id (its first definition) and refer to it from a later
   * definition of the same shape (when it runs out of record ids and reuses one).
   */
  const names = (): Structure => {
    need(1);
    const wrapped = frame[position] === 0xd6 && position + 1 < length;
    if (wrapped && frame[position + 1] === EXT_POINTER) {
      position += 2;
      const known = references.get(id32());
      if (!known?.names) return refuse('record definition', 'a record definition whose keys refer to something that is not a list of names');
      return known.names;
    }
    let id: number | null = null;
    if (wrapped && frame[position + 1] === EXT_ID) {
      position += 2;
      id = id32();
      defining(id);
    }
    const count = arrayHeader();
    if (count < 0) refuse('record definition', 'a record definition whose keys are not a list');
    need(count);
    const keys = new Array<string>(count);
    const start = position;
    for (let i = 0; i < count; i++) {
      need(1);
      const token = frame[position++];
      if (token >= 0xa0 && token < 0xc0) keys[i] = text(token - 0xa0);
      else if (token === 0xd9) keys[i] = (need(1), text(frame[position++]));
      else if (token === 0xda) keys[i] = (need(2), text(view.getUint16((position += 2) - 2)));
      else if (token === 0xdb) keys[i] = (need(4), text(view.getUint32((position += 4) - 4)));
      else refuse('record definition', 'a record definition whose keys are not strings');
    }
    // (their string headers included: a little more than the names themselves)
    const structure: Structure = { keys, bytes: position - start };
    if (id !== null) references.set(id, { value: keys, nodes: 0, bytes: 0, height: 0, names: structure });
    return structure;
  };
  const define = (id: number, depth: number): Record<string, unknown> => {
    // The property names (not part of the value), then the first record of that structure
    const structure = names();
    structures[id & 0x3f] = structure;
    return record(structure, depth);
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
    if (bytes < 1) refuse('typed array', 'a typed array without its kind');
    const code = frame[position++];
    const Kind = TYPED_ARRAYS[code];
    if (!Kind && code !== ARRAY_BUFFER && code !== DATA_VIEW) refuse('typed array', `a typed array of kind ${code}, which msgpackr has no code for`);
    const byteLength = bytes - 1;
    const size = Kind ? Kind.BYTES_PER_ELEMENT : 1;
    if (byteLength % size !== 0) refuse('typed array', 'a typed array whose bytes are not whole elements');
    // Its elements are values like any other (the array itself was charged by whatever holds it)
    charge(byteLength / size);
    weigh(byteLength);
    // A copy, as msgpackr makes: aligned for its kind, and not a view that keeps the frame alive
    const buffer = Uint8Array.prototype.slice.call(frame, position, position + byteLength).buffer;
    position += byteLength;
    return Kind ? new Kind(buffer) : code === ARRAY_BUFFER ? buffer : new DataView(buffer);
  };
  /** A big integer beyond 64 bits (msgpackr unpack.js extension 0x42, the same arithmetic) */
  const bigint = (bytes: number): bigint => {
    if (bytes < 1) refuse('big integer', 'a big integer without its bytes');
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
    // Strings only: the constructor converts anything else to a string, which can be far larger
    // than the frame (an array of references to one long string) or throw
    if (typeof name !== 'string' || (typeof message !== 'string' && message !== null)) return refuse('Error', 'an Error whose name or message is not a string');
    // Only the table's own names (msgpackr's lookup would also find Object.prototype's members)
    const known = Object.prototype.hasOwnProperty.call(ERRORS, name);
    if (known && name === 'AggregateError' && message !== null) {
      // The list it makes of the message: one string for each code point
      const { points, bytes } = measureText(message);
      charge(points);
      weigh(bytes);
    }
    try {
      if (known) return ERRORS[name](message, { cause });
      const made = Error(message as string, { cause });
      made.name = name;
      return made;
    } catch {
      return refuse('Error', 'an Error that cannot be made from what the frame holds');
    }
  };
  /** A one-byte marker extension (Set, Error, RegExp) is fixext 1 with a filler byte of 0, then its array */
  const marker = (kind: Marked, fixed: boolean, bytes: number) => {
    if (!fixed || bytes !== 1 || frame[position] !== 0) refuse(kind, `${MARKED[kind]} that is not written as msgpackr writes one`);
    position++;
  };
  /**
   * An extension of `bytes` data bytes, after the `header` byte that framed it (fixext 0xd4 to
   * 0xd8, or ext 0xc7 to 0xc9 with its length); its type byte is next.
   */
  const extension = (header: number, bytes: number, depth: number): unknown => {
    need(1 + bytes);
    const type = frame[position++];
    const fixed = header >= 0xd4;
    // msgpackr's packer writes ext 8, 16 or 32, whichever is the shortest for the length
    if (!fixed && header !== (bytes < 0x100 ? 0xc7 : bytes < 0x10000 ? 0xc8 : 0xc9)) return refuse('extension', `an extension with a longer header than msgpackr writes`);
    // How msgpackr frames data it writes as it is (writeExtensionData): fixext for 1, 2, 4, 8 and 16 bytes
    const asData = fixed === (bytes === 1 || bytes === 2 || bytes === 4 || bytes === 8 || bytes === 16);
    switch (type) {
      case EXT_TIMESTAMP:
        // (an invalid date is fixext 1 holding 0xff)
        if (asData && (bytes === 1 ? frame[position] === 0xff : bytes === 4 || bytes === 8 || bytes === 12)) return timestamp(bytes);
        break;
      case EXT_UNDEFINED:
        if (!fixed || bytes !== 1 || frame[position] !== 0) break;
        position++;
        return undefined;
      case EXT_RECORD:
        if (fixed && bytes === 2) return refuse('record definition', 'a two-byte record definition');
        if (!fixed || bytes !== 1) break;
        return define(frame[position++], depth);
      case EXT_SET:
        marker('Set', fixed, bytes);
        return new Set(listOf('Set', depth));
      case EXT_ERROR:
        marker('Error', fixed, bytes);
        return error(listOf('Error', depth, 3));
      case EXT_REGEXP: {
        marker('RegExp', fixed, bytes);
        const [source, flags] = listOf('RegExp', depth, 2);
        if (typeof source !== 'string' || typeof flags !== 'string') return refuse('RegExp', 'a RegExp that is not written as msgpackr writes one');
        try {
          return new RegExp(source, flags);
        } catch {
          return refuse('RegExp', 'a RegExp whose pattern does not compile');
        }
      }
      case EXT_TYPED:
        if (fixed) break;
        return typed(bytes);
      case EXT_BIGINT:
        if (!asData) break;
        return bigint(bytes);
      case EXT_ID: {
        if (!fixed || bytes !== 4) break;
        const id = id32();
        defining(id);
        open.add(id);
        const before = { nodes, weight };
        const inside = deeper(depth);
        const outerReach = reach;
        reach = inside;
        const named = value(inside);
        // How many levels it nests below where it stands (0 for a plain value)
        const height = reach - inside;
        reach = Math.max(outerReach, reach);
        open.delete(id);
        // What it counted: itself (charged by whatever holds it) and everything in it
        references.set(id, { value: named, nodes: 1 + nodes - before.nodes, bytes: weight - before.weight, height });
        return named;
      }
      case EXT_POINTER: {
        if (!fixed || bytes !== 4) break;
        const id = id32();
        const known = references.get(id);
        if (open.has(id)) return refuse('cycle', 'a reference to a value that contains it (a cycle)');
        if (!known || known.names) return refuse('reference', 'a reference to nothing');
        // Its levels, from where it is put now
        if (depth + known.height > limits.maxDepth) throw new PacketOverLimit(`it nests more than ${limits.maxDepth} levels deep`);
        if (depth + known.height > reach) reach = depth + known.height;
        // Counted again in full: whoever walks the value meets it once more (one node of it was
        // charged already, for the pointer)
        charge(known.nodes - 1);
        weigh(known.bytes);
        return known.value;
      }
    }
    return refuse('extension', `extension type 0x${type.toString(16)} with ${bytes} byte(s) after 0x${header.toString(16)}`);
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
    if (token < 0xc0) return string(token - 0xa0);
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
        return extension(token, frame[position++], depth);
      case 0xc8:
        need(2);
        return extension(token, view.getUint16((position += 2) - 2), depth);
      case 0xc9:
        need(4);
        return extension(token, view.getUint32((position += 4) - 4), depth);
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
        return extension(token, 1, depth);
      case 0xd5:
        return extension(token, 2, depth);
      case 0xd6:
        return extension(token, 4, depth);
      case 0xd7:
        return extension(token, 8, depth);
      case 0xd8:
        return extension(token, 16, depth);
      case 0xd9:
        need(1);
        return string(frame[position++]);
      case 0xda:
        need(2);
        return string(view.getUint16((position += 2) - 2));
      case 0xdb:
        need(4);
        return string(view.getUint32((position += 4) - 4));
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
        return refuse('reserved byte', `byte 0x${token.toString(16)}`);
    }
  }

  charge(1);
  const decoded = value(0);
  if (position !== length) refuse('trailing bytes', 'bytes after the packet');
  return { value: decoded, nodes, bytes: weight };
}
