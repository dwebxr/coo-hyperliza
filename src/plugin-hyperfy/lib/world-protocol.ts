import { Packr } from 'msgpackr';
import { WORLD_URL_PROTOCOLS, sessionTokenProblem } from './world-url';
import { describeUrl } from './log-url';
import { readChatMessage } from './chat-intake';
import { RateLimitedLog } from './rate-limited-log';
import { PacketOverLimit, PacketRefused, decodeServerFrame } from './packet-decode';

/**
 * The network protocol of coo-world (github.com/dwebxr/coo-world, src/core/packets.js as of
 * dbae3cf: protocol version 2 with the wallet and tip packets appended), spoken by the agent's
 * older engine through adaptToWorldProtocol.
 *
 * The world kicks clients whose socket URL lacks `v=<PROTOCOL_VERSION>` ('outdated'), silently
 * drops client packets that are not plain msgpack, and numbers packets by their position in
 * PACKET_NAMES. When the world changes any of these, update this file to match.
 */

export const PROTOCOL_VERSION = 2;

// The world's inboundPolicy.js silently drops packets above these byte limits
const INBOUND_BYTE_LIMITS: Record<string, number> = {
  requestEvmNonce: 128,
  requestEvmVerify: 8704,
  setEvmTipReceive: 32,
  entityEvent: 64 * 1024,
  blueprintAdded: 64 * 1024,
  blueprintModified: 64 * 1024,
  ai: 64 * 1024,
};
const INBOUND_DEFAULT_BYTE_LIMIT = 32 * 1024;

// prettier-ignore
export const PACKET_NAMES = [
  'snapshot',
  'command',
  'chatAdded',
  'chatCleared',
  'blueprintAdded',
  'blueprintModified',
  'entityAdded',
  'entityModified',
  'entityEvent',
  'entityRemoved',
  'playerTeleport',
  'playerPush',
  'playerSessionAvatar',
  'liveKitLevel',
  'mute',
  'settingsModified',
  'spawnModified',
  'modifyRank',
  'kick',
  'ai',
  'ping',
  'pong',
  'requestBuilderByToken',
  'revokeBuilderByToken',
  'requestBuilderNonce',
  'builderNonce',
  'walletStatus',
  'tokenBalanceRequest',
  'tokenBalance',
  'requestBuilderRecheck',
  'requestEvmNonce',
  'evmNonce',
  'requestEvmVerify',
  'evmWalletStatus',
  'revokeEvmWallet',
  'setEvmTipReceive',
  'requestEvmTipIntent',
  'evmTipIntent',
  'evmTip',
  'evmTipStatus',
] as const;

// What the world sends is read by lib/packet-decode.ts (msgpackr's format, under limits).
// What the world accepts from clients: plain msgpack, no extension types
const clientPackr = new Packr({ useRecords: false, structuredClone: false, moreTypes: false, bundleStrings: false });

const idByName = new Map<string, number>(PACKET_NAMES.map((name, id) => [name, id]));
const methodOf = (name: string) => `on${name.charAt(0).toUpperCase()}${name.slice(1)}`; // 'kick' -> 'onKick'

// The world's inboundPolicy.js also scans every packet (strictDecode.js) and drops one with more
// values than these, nested deeper than INBOUND_MAX_DEPTH, or holding anything but plain msgpack
const INBOUND_NODE_LIMITS: Record<string, number> = {
  entityEvent: 8192,
  blueprintAdded: 8192,
  blueprintModified: 8192,
  ai: 1024,
};
const INBOUND_DEFAULT_NODE_LIMIT = 4096;
const INBOUND_MAX_DEPTH = 32;

/**
 * Why the world would drop packet `name` with `data` unread, or null: over its byte limit, over
 * its node or depth limit, or holding a value its scan refuses (coo-world src/core/extras/
 * inboundPolicy.js and strictDecode.js). network.send does not send a packet over the byte limit
 * (adaptToWorldProtocol); a caller that must know whether its change reaches the world
 * (managers/build-manager.ts) asks first.
 *
 * `data` is walked as clientPackr writes it before it is packed, and the walk stops at the first
 * limit it passes: clientPackr writes a value held twice in full each time, so a small value can
 * pack into far more than the world takes.
 */
export function outgoingPacketProblem(name: string, data: unknown): string | null {
  if (!idByName.has(name)) throw new Error(`outgoingPacketProblem: ${name} is not in the world's protocol`);
  const byteLimit = INBOUND_BYTE_LIMITS[name] ?? INBOUND_DEFAULT_BYTE_LIMIT;
  const nodeLimit = INBOUND_NODE_LIMITS[name] ?? INBOUND_DEFAULT_NODE_LIMIT;
  const tooMany = `the ${name} packet holds more than the ${nodeLimit} values the world accepts`;
  const tooDeep = `the ${name} packet nests deeper than the ${INBOUND_MAX_DEPTH} levels the world accepts`;
  let walked: ReturnType<typeof walkAsPacked>;
  try {
    walked = walkAsPacked(data, nodeLimit, byteLimit);
  } catch (error: any) {
    // (what makes clientPackr throw too: a getter or toJSON that throws, an object posing as a Map)
    return `the ${name} packet holds a value that cannot be written as msgpack (${error?.name || 'Error'})`;
  }
  if (walked === 'values') return tooMany;
  if (walked === 'depth') return tooDeep;
  if (typeof walked === 'number') return `the ${name} packet would be at least ${walked} bytes, more than the ${byteLimit} the world accepts`;
  let packet: Uint8Array;
  try {
    packet = writeClientPacket(name, data);
  } catch (error: any) {
    return `the ${name} packet holds a value that cannot be written as msgpack (${error?.name || 'Error'})`;
  }
  if (packet.byteLength > byteLimit) return `the ${name} packet would be ${packet.byteLength} bytes, more than the ${byteLimit} the world accepts`;
  const scanned = inboundScanProblem(packet, nodeLimit);
  if (scanned === 'node budget exceeded') return tooMany;
  if (scanned === 'too deep') return tooDeep;
  return scanned ? `the ${name} packet holds a value the world does not accept (${scanned})` : null;
}

/**
 * Walks `data` as the packet [id, data] that clientPackr writes (useRecords, structuredClone and
 * moreTypes off: an object or a Map is a map, a Set, an Error and a RegExp an array, a typed
 * array or an ArrayBuffer a bin (a DataView an empty one), a function undefined, an object with
 * toJSON what that returns), counting values and depth as the world's scan does (strictDecode.js:
 * the packet array and its two elements are three values; each further element one, each map
 * entry two, each bin four; a value more than INBOUND_MAX_DEPTH levels down is refused) and bytes
 * from below (one for each value, a string's UTF-16 length, a bin's length). Stops at the first
 * limit passed: 'values', 'depth', or the bytes counted when they passed the byte limit; null
 * within all three.
 */
function walkAsPacked(data: unknown, nodeLimit: number, byteLimit: number): 'values' | 'depth' | number | null {
  let nodes = 3;
  let bytes = 2;
  const over = (): 'values' | number | null => (nodes > nodeLimit ? 'values' : bytes > byteLimit ? bytes : null);
  const list = (items: ArrayLike<unknown> | Iterable<unknown>, count: number, depth: number) => {
    nodes += count;
    bytes += 1;
    const stop = over();
    if (stop !== null) return stop;
    if (Array.isArray(items) || !(Symbol.iterator in Object(items))) {
      const indexed = items as ArrayLike<unknown>;
      for (let i = 0; i < count; i++) {
        const inner = walk(indexed[i], depth + 1);
        if (inner !== null) return inner;
      }
      return null;
    }
    for (const item of items as Iterable<unknown>) {
      const inner = walk(item, depth + 1);
      if (inner !== null) return inner;
    }
    return null;
  };
  const entry = (key: unknown, value: unknown, depth: number) => {
    nodes += 2;
    return over() ?? walk(key, depth + 1) ?? walk(value, depth + 1);
  };
  const walk = (value: unknown, depth: number): 'values' | 'depth' | number | null => {
    if (depth > INBOUND_MAX_DEPTH) return 'depth';
    if (typeof value === 'string') bytes += 1 + value.length;
    else if ((typeof value !== 'object' && typeof value !== 'function') || value === null) bytes += 1;
    else {
      // In clientPackr's order (msgpackr pack.js)
      const object = value as any;
      const constructor = object.constructor;
      if (constructor === Object) return members(object, depth);
      if (constructor === Array) return list(object, object.length, depth);
      if (constructor === Map) {
        bytes += 1;
        for (const [key, inner] of object as Map<unknown, unknown>) {
          const stop = entry(key, inner, depth);
          if (stop !== null) return stop;
        }
        return over();
      }
      if (object instanceof Date) bytes += 1;
      else if (object instanceof Set) return list(object, object.size, depth);
      else if (object instanceof Error) return list([object.name, object.message, object.cause], 3, depth);
      else if (object instanceof RegExp) return list([object.source, object.flags], 2, depth);
      else if (object instanceof DataView) {
        // (written as an empty bin)
        nodes += 3;
        bytes += 1;
      } else if (object instanceof ArrayBuffer || ArrayBuffer.isView(object)) {
        nodes += 3;
        bytes += 1 + object.byteLength;
      } else if (Array.isArray(object)) return list(object, object.length, depth);
      else {
        if (object.toJSON) {
          const json = object.toJSON();
          if (json !== object) return walk(json, depth);
        }
        // A function is written as undefined
        if (typeof object === 'function') bytes += 1;
        else return members(object, depth);
      }
    }
    return over();
  };
  // A plain object as clientPackr writes one: the keys for..in finds that are its own
  const members = (object: any, depth: number) => {
    bytes += 1;
    for (const key in object) {
      if (typeof object.hasOwnProperty === 'function' && !object.hasOwnProperty(key)) continue;
      const stop = entry(key, object[key], depth);
      if (stop !== null) return stop;
    }
    return over();
  };
  return walk(data, 2);
}

/**
 * Why coo-world's inbound scan (strictDecode.js with build off) refuses `packet`, in its words, or
 * null: the same counting and depth, and only nil, booleans, integers, floats, strings, bin, arrays,
 * maps whose keys are strings, and undefined (fixext 1 of type 0).
 */
function inboundScanProblem(packet: Uint8Array, maxNodes: number): string | null {
  const length = packet.length;
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  let position = 0;
  let nodes = 1;
  class Refused extends Error {}
  const fail = (reason: string): never => {
    throw new Refused(reason);
  };
  const need = (count: number) => {
    if (position + count > length) fail('truncated');
  };
  const charge = (count: number) => {
    nodes += count;
    if (nodes > maxNodes) fail('node budget exceeded');
  };
  const skip = (count: number) => {
    need(count);
    position += count;
  };
  const read = (depth: number, key = false): void => {
    if (depth > INBOUND_MAX_DEPTH) fail('too deep');
    need(1);
    const b = packet[position];
    const string = (b >= 0xa0 && b <= 0xbf) || b === 0xd9 || b === 0xda || b === 0xdb;
    if (key && !string) fail('map key is not a string');
    if (b === 0xc1 || (b >= 0xc7 && b <= 0xc9) || (b >= 0xd5 && b <= 0xd8)) fail(`byte 0x${b.toString(16)} refused`);
    position++;
    if (b <= 0x7f || b >= 0xe0 || b === 0xc0 || b === 0xc2 || b === 0xc3) return;
    if (b >= 0xa0 && b <= 0xbf) return skip(b & 0x1f);
    if (b >= 0x90 && b <= 0x9f) return items(b & 0x0f, depth);
    if (b >= 0x80 && b <= 0x8f) return entries(b & 0x0f, depth);
    switch (b) {
      case 0xc4:
        need(1);
        return bin(packet[position++]);
      case 0xc5:
        need(2);
        return bin(view.getUint16((position += 2) - 2));
      case 0xc6:
        need(4);
        return bin(view.getUint32((position += 4) - 4));
      case 0xca:
      case 0xce:
      case 0xd2:
        return skip(4);
      case 0xcb:
      case 0xcf:
      case 0xd3:
        return skip(8);
      case 0xcc:
      case 0xd0:
        return skip(1);
      case 0xcd:
      case 0xd1:
        return skip(2);
      case 0xd4:
        need(1);
        if (packet[position] !== 0x00) fail(`ext type 0x${packet[position].toString(16)} refused`);
        return skip(2);
      case 0xd9:
        need(1);
        return skip(packet[position++]);
      case 0xda:
        need(2);
        return skip(view.getUint16((position += 2) - 2));
      case 0xdb:
        need(4);
        return skip(view.getUint32((position += 4) - 4));
      case 0xdc:
        need(2);
        return items(view.getUint16((position += 2) - 2), depth);
      case 0xdd:
        need(4);
        return items(view.getUint32((position += 4) - 4), depth);
      case 0xde:
        need(2);
        return entries(view.getUint16((position += 2) - 2), depth);
      case 0xdf:
        need(4);
        return entries(view.getUint32((position += 4) - 4), depth);
    }
  };
  const bin = (count: number) => {
    charge(3);
    skip(count);
  };
  const items = (count: number, depth: number) => {
    charge(count);
    if (count > length - position) fail('declared length exceeds remaining bytes');
    for (let i = 0; i < count; i++) read(depth + 1);
  };
  const entries = (count: number, depth: number) => {
    charge(count * 2);
    if (count * 2 > length - position) fail('declared length exceeds remaining bytes');
    for (let i = 0; i < count; i++) {
      read(depth + 1, true);
      read(depth + 1);
    }
  };
  try {
    read(1);
    if (position !== length) fail('trailing bytes');
    return null;
  } catch (error) {
    if (error instanceof Refused) return error.message;
    throw error;
  }
}

export function writeClientPacket(name: string, data: unknown): Uint8Array {
  const id = idByName.get(name);
  if (id === undefined) throw new Error(`writeClientPacket failed: ${name} (not in the world's protocol)`);
  return clientPackr.pack([id, data]);
}

/**
 * The largest frame from the world that is decoded. A snapshot of a large world (every entity,
 * blueprint and the chat history) is a few megabytes at most. What this bounds: the decode work
 * and the input of the decoder for one frame. What it does not bound: receipt (the WebSocket
 * implementation has buffered the whole frame before this code sees it). What a frame may decode
 * into is bounded separately: at most PACKET_LIMITS.maxNodes values and PACKET_LIMITS.maxBytes
 * bytes of strings and binary data, nested at most PACKET_LIMITS.maxDepth deep
 * (lib/packet-decode.ts); a frame over any of these is dropped like one that is too large.
 */
export const MAX_SERVER_FRAME_BYTES = 8 * 1024 * 1024;
// Unknown packet ids are each reported once; after this many different ones, no more
export const MAX_REPORTED_PACKET_IDS = 32;

/**
 * What may wait for the engine's next flush (ClientNetwork.flush, every tick: 30 a second once the
 * world runs). A tick's worth is a handful of packets; this is room for seconds of a busy world
 * before the first tick and a snapshot of the largest size four times over. Counted per packet:
 * its frame's size, or what it decoded into when that is more (QUEUED_NODE_BYTES for each value:
 * a frame of small containers takes several times its size in memory), or for a chat message
 * QUEUED_CHAT_BYTES (it is cut down before it waits). So what waits is at most
 * MAX_QUEUED_BYTES / QUEUED_NODE_BYTES decoded values, whatever the frames looked like.
 */
export const MAX_QUEUED_PACKETS = 4096;
export const MAX_QUEUED_BYTES = 4 * MAX_SERVER_FRAME_BYTES;
// What one decoded value is counted as while it waits: about what a small array or object costs
export const QUEUED_NODE_BYTES = 32;
// A chat message as readChatMessage leaves it: 500 code points of body and four short fields
const QUEUED_CHAT_BYTES = 4096;
// Close code the agent gives a connection it ends because the world sent more than it can take
export const QUEUE_OVERFLOW_CLOSE_CODE = 4000;
// At most one line about undecodable or dropped frames in this time; it carries the count
const FRAME_LOG_INTERVAL_MS = 10_000;

const reportedIds = new Set<string>();
let undecodable = undecodableLog();

function undecodableLog(): RateLimitedLog {
  // Only the size and the decoder's fixed word for the rule (PacketRefused.kind): its messages, or
  // another decoder's, could quote the payload, which may hold credentials
  return new RateLimitedLog((count, latest) => `[Hyperfy] Could not read ${count} packet(s) from the world (the latest ${latest})`, {
    intervalMs: FRAME_LOG_INTERVAL_MS,
    log: (line) => console.error(line),
  });
}

/** Forgets which unknown packet ids were reported, and when an unreadable packet was (tests). */
export function resetReportedPacketIds(): void {
  reportedIds.clear();
  undecodable = undecodableLog();
}

/**
 * [handler method, data, the number of values the packet decoded into], or [] when the packet
 * cannot be read (logged at most once per FRAME_LOG_INTERVAL_MS with the count, and for the latest
 * one its size and the decoder's word for why: PacketRefused.kind; once per unknown
 * id, for the first MAX_REPORTED_PACKET_IDS different ones). A packet that would decode into more
 * than the limits allow (lib/packet-decode.ts) is not read either: `overLimit`, when given, is
 * told why.
 */
export function readServerPacket(packet: ArrayBuffer | Uint8Array, overLimit?: (why: string) => void): [string, unknown, number] | [] {
  let id: unknown;
  let data: unknown;
  let nodes: number;
  try {
    const decoded = decodeServerFrame(packet instanceof Uint8Array ? packet : new Uint8Array(packet));
    [id, data] = decoded.value as [unknown, unknown];
    nodes = decoded.nodes;
  } catch (error) {
    if (error instanceof PacketOverLimit && overLimit) overLimit(error.message);
    else undecodable.note(`${packet.byteLength} bytes, refused: ${error instanceof PacketRefused ? error.kind : error instanceof PacketOverLimit ? 'over the limits' : 'unreadable'}`);
    return [];
  }
  const name = typeof id === 'number' ? PACKET_NAMES[id] : undefined;
  if (!name) {
    const label = typeof id === 'number' ? `id ${id}` : `a non-numeric id (${typeof id})`;
    if (!reportedIds.has(label) && reportedIds.size < MAX_REPORTED_PACKET_IDS) {
      reportedIds.add(label);
      const last = reportedIds.size === MAX_REPORTED_PACKET_IDS ? ' Further unknown packet ids are not reported.' : '';
      console.warn(`[Hyperfy] The world sent packet ${label}, which is not in this agent's protocol table; the world's protocol may have changed (see lib/world-protocol.ts).${last}`);
    }
    return [];
  }
  return [methodOf(name), data, nodes];
}

/** The parts of a CloseEvent worth logging; the event itself holds the socket URL with the auth token. */
export function describeClose(event: any): unknown {
  if (!event || typeof event !== 'object') return event;
  return { code: event.code, reason: event.reason, wasClean: event.wasClean };
}

export interface WorldProtocol {
  /**
   * The session token this connection may use with the world (read when called: the snapshot can
   * issue a new one), or null when there is none or it was withheld from the socket URL.
   */
  sessionToken(): string | null;
}

/**
 * Makes the engine's ClientNetwork speak the world's protocol. Call before world.init(): it replaces
 * init/send/flush and the onPacket/onClose listeners on the instance, so init registers them and
 * the engine's destroy() removes the same functions.
 *
 * Whether the connection may carry a session token is decided from the URL alone
 * (sessionTokenProblem, lib/world-url.ts), whether or not a token is saved. Where it may not, the
 * connection is made without one: the world treats the agent as a new guest, the token it issues
 * for that guest is neither stored (the engine would store it, replacing a saved one) nor used for
 * uploads, so the agent is a new guest on every connection there.
 *
 * What waits for the engine's flush is bounded (MAX_QUEUED_PACKETS, MAX_QUEUED_BYTES). When more
 * would wait, the connection is closed instead of dropping packets: a dropped packet would leave
 * the agent's copy of the world silently different from the server's (an entity missing or stale,
 * a blueprint not updated, a rank change in lib/world-identity.ts not applied) with nothing to
 * repair it short of a new snapshot. Closing reports the disconnect like any other, and the
 * reconnect logic joins again with a fresh snapshot. A queued kick is kept, so the service still
 * sees why the world wanted the agent gone.
 */
export function adaptToWorldProtocol(network: any, getAuthToken: () => string | null | undefined): WorldProtocol {
  const engineOnClose = network.onClose;
  const engineFlush = network.flush;
  const reportedOversized = new Set<string>();
  let tokenWithheld = false;
  let queuedBytes = 0;
  let overflowed = false;
  let closeReported = false;
  const dropped = new RateLimitedLog((count, why) => `[Hyperfy] Dropped ${count} frame(s) from the world: ${why}`, {
    intervalMs: FRAME_LOG_INTERVAL_MS,
    log: (line) => console.warn(line),
  });
  const dropFrame = (why: string) => dropped.note(why);

  const reportClose = (event: unknown) => {
    if (closeReported) return;
    closeReported = true;
    engineOnClose(describeClose(event));
  };

  const overflow = () => {
    overflowed = true;
    const kicks = network.queue.filter((entry: unknown) => Array.isArray(entry) && entry[0] === 'onKick');
    network.queue.length = 0;
    network.queue.push(...kicks);
    queuedBytes = 0;
    console.error(
      `[Hyperfy] Closing the connection: the world sent more than ${MAX_QUEUED_PACKETS} packets or ${MAX_QUEUED_BYTES} bytes ` +
        'faster than the agent handles them. Reconnecting starts again from a fresh snapshot of the world.'
    );
    const reason = 'the world sent more than the agent can take';
    try {
      network.ws?.close(QUEUE_OVERFLOW_CLOSE_CODE, reason);
    } catch {
      // Closed already
    }
    // Reported now: the socket's own close event may come late, or not at all from a peer that
    // does not answer the close
    reportClose({ code: QUEUE_OVERFLOW_CLOSE_CODE, reason, wasClean: false });
  };

  network.init = ({ wsUrl, name, avatar }: { wsUrl: string; name?: string; avatar?: string }) => {
    let url: URL;
    try {
      url = new URL(wsUrl);
    } catch {
      throw new Error(`Invalid Hyperfy WebSocket URL: ${describeUrl(wsUrl)}`);
    }
    if (!WORLD_URL_PROTOCOLS.includes(url.protocol)) {
      throw new Error(`Unsupported Hyperfy WebSocket protocol: ${url.protocol}`);
    }
    url.hash = '';
    const problem = sessionTokenProblem(url);
    tokenWithheld = problem !== null;
    const authToken = problem ? null : getAuthToken();
    if (problem) {
      console.error(
        `[Hyperfy] No session token on this connection: ${problem}, and the token would travel readable in the URL. ` +
          'Connecting as a new guest (no saved identity, rank or avatar upload); the guest token the world issues is not kept or used. ' +
          'Use a wss:// WS_URL to connect as the saved user.'
      );
    }
    if (authToken) url.searchParams.set('authToken', authToken);
    else url.searchParams.delete('authToken');
    if (name) url.searchParams.set('name', name);
    if (avatar) url.searchParams.set('avatar', avatar);
    url.searchParams.set('v', String(PROTOCOL_VERSION));
    try {
      network.ws = new WebSocket(url.toString());
    } catch (error: any) {
      // Constructor messages can contain the full URL, including the session token
      throw new Error(`Could not open Hyperfy WebSocket at ${url.origin}${url.pathname} (${error?.name || 'Error'})`);
    }
    network.ws.binaryType = 'arraybuffer';
    network.ws.addEventListener('message', network.onPacket);
    network.ws.addEventListener('close', network.onClose);
  };

  // Whether the packet was sent: one over the world's limit is not (outgoingPacketProblem)
  network.send = (name: string, data: unknown): boolean => {
    const packet = writeClientPacket(name, data);
    const limit = INBOUND_BYTE_LIMITS[name] ?? INBOUND_DEFAULT_BYTE_LIMIT;
    if (packet.byteLength > limit) {
      if (!reportedOversized.has(name)) {
        reportedOversized.add(name);
        console.warn(`[Hyperfy] Not sending ${name}: ${packet.byteLength} bytes exceeds the ${limit}-byte limit`);
      }
      return false;
    }
    network.ws.send(packet);
    return true;
  };

  network.onPacket = (event: { data: unknown }) => {
    if (overflowed) return;
    const frame = event?.data;
    // The world's packets are binary frames (the socket's binaryType is arraybuffer)
    if (!(frame instanceof ArrayBuffer) && !(frame instanceof Uint8Array)) return dropFrame('not a binary frame');
    // Before unpack: see MAX_SERVER_FRAME_BYTES for what this does and does not bound
    if (frame.byteLength > MAX_SERVER_FRAME_BYTES) return dropFrame(`${frame.byteLength} bytes exceeds the ${MAX_SERVER_FRAME_BYTES}-byte limit`);
    // Over the decode limits: dropped like a frame that is too large
    const [method, data, nodes = 0] = readServerPacket(frame, (why) => dropFrame(`a frame of ${frame.byteLength} bytes is not decoded: ${why}`));
    if (!method) return;
    let queued = data;
    let size = Math.max(frame.byteLength, nodes * QUEUED_NODE_BYTES);
    if (method === 'onChatAdded') {
      // Cut down before it waits: a chat body is 500 code points however large the frame was
      // (world-chat.ts reads it again when the engine hands it over)
      const msg = readChatMessage(data);
      if (!msg) return dropFrame('a chat packet that is not a chat message');
      queued = msg;
      size = Math.min(size, QUEUED_CHAT_BYTES);
    }
    if (network.queue.length + 1 > MAX_QUEUED_PACKETS || queuedBytes + size > MAX_QUEUED_BYTES) return overflow();
    queuedBytes += size;
    network.enqueue(method, queued);
  };

  // The engine's flush hands every queued packet to its handler and empties the queue
  network.flush = () => {
    try {
      engineFlush.call(network);
    } finally {
      if (!network.queue.length) queuedBytes = 0;
    }
  };

  network.onClose = (event: unknown) => reportClose(event);

  // The engine's onSnapshot stores the token the world issued (storage.set('authToken', ...)). On a
  // connection made without a token that is a new guest's: it must not be stored, so the engine is
  // handed what is saved (a saved token, or nothing) to store again.
  const engineOnSnapshot = network.onSnapshot;
  network.onSnapshot = (data: unknown) =>
    engineOnSnapshot.call(network, tokenWithheld && data && typeof data === 'object' ? { ...data, authToken: getAuthToken() } : data);

  return { sessionToken: () => (tokenWithheld ? null : (getAuthToken() ?? null)) };
}
