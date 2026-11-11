import { Packr } from 'msgpackr';
import { WORLD_URL_PROTOCOLS, sessionTokenProblem } from './world-url';
import { describeUrl } from './log-url';

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

// What the world sends
const serverPackr = new Packr({ structuredClone: true });
// What the world accepts from clients: plain msgpack, no extension types
const clientPackr = new Packr({ useRecords: false, structuredClone: false, moreTypes: false, bundleStrings: false });

const idByName = new Map<string, number>(PACKET_NAMES.map((name, id) => [name, id]));
const methodOf = (name: string) => `on${name.charAt(0).toUpperCase()}${name.slice(1)}`; // 'kick' -> 'onKick'

export function writeClientPacket(name: string, data: unknown): Uint8Array {
  const id = idByName.get(name);
  if (id === undefined) throw new Error(`writeClientPacket failed: ${name} (not in the world's protocol)`);
  return clientPackr.pack([id, data]);
}

/**
 * The largest frame from the world that is decoded. A snapshot of a large world (every entity,
 * blueprint and the chat history) is a few megabytes at most. What this bounds: the decode work
 * and the input of the decoder for one frame. What it does not bound: receipt (the WebSocket
 * implementation has buffered the whole frame before this code sees it), nor the memory of the
 * decoded value, which can be many times the frame's size (one small object per byte).
 */
export const MAX_SERVER_FRAME_BYTES = 8 * 1024 * 1024;
// Unknown packet ids are each reported once; after this many different ones, no more
export const MAX_REPORTED_PACKET_IDS = 32;

const reportedIds = new Set<string>();

/** Forgets which unknown packet ids were reported (tests). */
export function resetReportedPacketIds(): void {
  reportedIds.clear();
}

/**
 * [handler method, data], or [] when the packet cannot be read (logged; once per unknown id, for
 * the first MAX_REPORTED_PACKET_IDS different ones).
 */
export function readServerPacket(packet: ArrayBuffer | Uint8Array): [string, unknown] | [] {
  let id: unknown;
  let data: unknown;
  try {
    [id, data] = serverPackr.unpack(packet instanceof Uint8Array ? packet : new Uint8Array(packet));
  } catch {
    // Decoder messages can quote the payload, which may hold credentials
    console.error(`[Hyperfy] Could not read a ${packet.byteLength}-byte packet from the world`);
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
  return [methodOf(name), data];
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

// At most one line about dropped frames in this time; the line carries the count
const FRAME_DROP_LOG_INTERVAL_MS = 10_000;

/**
 * Makes the engine's ClientNetwork speak the world's protocol. Call before world.init(): it replaces
 * init/send and the onPacket/onClose listeners on the instance, so init registers them and the
 * engine's destroy() removes the same functions.
 *
 * The session token goes into the socket URL's query only where sessionTokenProblem allows it
 * (lib/world-url.ts). Otherwise the connection is made without it: the world then treats the agent
 * as a new guest, and the token the world issues for that guest session is not stored (the engine
 * would replace the saved one with it).
 */
export function adaptToWorldProtocol(network: any, getAuthToken: () => string | null | undefined): WorldProtocol {
  const engineOnClose = network.onClose;
  const reportedOversized = new Set<string>();
  let tokenWithheld = false;
  let droppedFrames = 0;
  let droppedFramesLoggedAt = Number.NEGATIVE_INFINITY;
  const dropFrame = (why: string) => {
    droppedFrames++;
    if (Date.now() - droppedFramesLoggedAt < FRAME_DROP_LOG_INTERVAL_MS) return;
    droppedFramesLoggedAt = Date.now();
    console.warn(`[Hyperfy] Dropped ${droppedFrames} frame(s) from the world: ${why}`);
    droppedFrames = 0;
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
    const authToken = getAuthToken();
    const problem = authToken ? sessionTokenProblem(url) : null;
    tokenWithheld = problem !== null;
    if (problem) {
      console.error(
        `[Hyperfy] Not sending the saved session token: ${problem}, and the token would travel readable in the URL. ` +
          'Connecting without it, as a new guest (no saved identity, rank or avatar upload). Use a wss:// WS_URL to connect as the saved user.'
      );
    }
    if (authToken && !problem) url.searchParams.set('authToken', authToken);
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

  network.send = (name: string, data: unknown) => {
    const packet = writeClientPacket(name, data);
    const limit = INBOUND_BYTE_LIMITS[name] ?? INBOUND_DEFAULT_BYTE_LIMIT;
    if (packet.byteLength > limit) {
      if (!reportedOversized.has(name)) {
        reportedOversized.add(name);
        console.warn(`[Hyperfy] Not sending ${name}: ${packet.byteLength} bytes exceeds the ${limit}-byte limit`);
      }
      return;
    }
    network.ws.send(packet);
  };

  network.onPacket = (event: { data: unknown }) => {
    const frame = event?.data;
    // The world's packets are binary frames (the socket's binaryType is arraybuffer)
    if (!(frame instanceof ArrayBuffer) && !(frame instanceof Uint8Array)) return dropFrame('not a binary frame');
    // Before unpack: see MAX_SERVER_FRAME_BYTES for what this does and does not bound
    if (frame.byteLength > MAX_SERVER_FRAME_BYTES) return dropFrame(`${frame.byteLength} bytes exceeds the ${MAX_SERVER_FRAME_BYTES}-byte limit`);
    const [method, data] = readServerPacket(frame);
    if (method) network.enqueue(method, data);
  };

  network.onClose = (event: unknown) => engineOnClose(describeClose(event));

  // The engine's onSnapshot stores the token the world issued (storage.set('authToken', ...)). On a
  // connection made without the saved token that is a new guest's: it must not replace the saved
  // one, so the engine is handed the saved one to store again.
  const engineOnSnapshot = network.onSnapshot;
  network.onSnapshot = (data: unknown) =>
    engineOnSnapshot.call(network, tokenWithheld && data && typeof data === 'object' ? { ...data, authToken: getAuthToken() } : data);

  return { sessionToken: () => (tokenWithheld ? null : (getAuthToken() ?? null)) };
}
