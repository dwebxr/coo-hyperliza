import { Packr } from 'msgpackr';

/**
 * The network protocol of coo-world (github.com/dwebxr/coo-world, src/core/packets.js as of
 * 7abb25e "protocol version 2"), spoken by the agent's older engine through adaptToWorldProtocol.
 *
 * The world kicks clients whose socket URL lacks `v=<PROTOCOL_VERSION>` ('outdated'), silently
 * drops client packets that are not plain msgpack, and numbers packets by their position in
 * PACKET_NAMES. When the world changes any of these, update this file to match.
 */

export const PROTOCOL_VERSION = 2;

// The world's inboundPolicy.js silently drops packets above these byte limits
const INBOUND_BYTE_LIMITS: Record<string, number> = {
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

const reportedIds = new Set<string>();

/** [handler method, data], or [] when the packet cannot be read (logged; once per unknown id). */
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
    if (!reportedIds.has(label)) {
      reportedIds.add(label);
      console.warn(`[Hyperfy] The world sent packet ${label}, which is not in this agent's protocol table; the world's protocol may have changed (see lib/world-protocol.ts).`);
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

/**
 * Makes the engine's ClientNetwork speak the world's protocol. Call before world.init(): it replaces
 * init/send and the onPacket/onClose listeners on the instance, so init registers them and the
 * engine's destroy() removes the same functions.
 */
export function adaptToWorldProtocol(network: any, getAuthToken: () => string | null | undefined): void {
  const engineOnClose = network.onClose;
  const reportedOversized = new Set<string>();

  network.init = ({ wsUrl, name, avatar }: { wsUrl: string; name?: string; avatar?: string }) => {
    let url: URL;
    try {
      url = new URL(wsUrl);
    } catch {
      throw new Error(`Invalid Hyperfy WebSocket URL: ${wsUrl}`);
    }
    if (!['ws:', 'wss:', 'http:', 'https:'].includes(url.protocol)) {
      throw new Error(`Unsupported Hyperfy WebSocket protocol: ${url.protocol}`);
    }
    url.hash = '';
    const authToken = getAuthToken();
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

  network.onPacket = (event: { data: ArrayBuffer | Uint8Array }) => {
    const [method, data] = readServerPacket(event.data);
    if (method) network.enqueue(method, data);
  };

  network.onClose = (event: unknown) => engineOnClose(describeClose(event));
}
