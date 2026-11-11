import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Packr } from 'msgpackr';

// The engine's ClientNetwork imports its storage module, which reads and writes the agent's saved
// session: a stub in memory instead, never the real storage file
const { saved } = vi.hoisted(() => ({ saved: new Map<string, unknown>() }));
vi.mock('../hyperfy/src/core/storage.js', () => ({
  storage: {
    get: (key: string) => saved.get(key) ?? null,
    // As the engine's NodeStorage does: null or undefined removes the key
    set: (key: string, value: unknown) => void (value === null || value === undefined ? saved.delete(key) : saved.set(key, value)),
    remove: (key: string) => void saved.delete(key),
  },
}));

import { ClientNetwork } from '../hyperfy/src/core/systems/ClientNetwork.js';
import {
  MAX_QUEUED_BYTES,
  MAX_QUEUED_PACKETS,
  MAX_REPORTED_PACKET_IDS,
  MAX_SERVER_FRAME_BYTES,
  PACKET_NAMES,
  PROTOCOL_VERSION,
  QUEUED_NODE_BYTES,
  QUEUE_OVERFLOW_CLOSE_CODE,
  adaptToWorldProtocol,
  outgoingPacketProblem,
  describeClose,
  readServerPacket,
  resetReportedPacketIds,
  writeClientPacket,
} from './world-protocol';
import { sessionTokenProblem } from './world-url';
import { PACKET_LIMITS } from './packet-decode';
import { cooWorldSnapshot } from '../test-support/world-packets';

const TOKEN = 'test-session-token';
// How the world encodes what it sends
const serverPackr = new Packr({ structuredClone: true });

/**
 * Walks a msgpack value and throws on anything outside the plain subset the world accepts from
 * clients (extension types, the never-used 0xc1). Returns the number of bytes consumed.
 */
function assertPlainMsgpack(buf: Uint8Array, pos = 0): number {
  const b = buf[pos];
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const items = (count: number, at: number) => {
    for (let i = 0; i < count; i++) at = assertPlainMsgpack(buf, at);
    return at;
  };
  if (b <= 0x7f || b >= 0xe0 || b === 0xc0 || b === 0xc2 || b === 0xc3) return pos + 1;
  if (b >= 0x80 && b <= 0x8f) return items((b & 0x0f) * 2, pos + 1);
  if (b >= 0x90 && b <= 0x9f) return items(b & 0x0f, pos + 1);
  if (b >= 0xa0 && b <= 0xbf) return pos + 1 + (b & 0x1f);
  switch (b) {
    case 0xc4: return pos + 2 + buf[pos + 1];
    case 0xc5: return pos + 3 + view.getUint16(pos + 1);
    case 0xc6: return pos + 5 + view.getUint32(pos + 1);
    case 0xca: return pos + 5;
    case 0xcb: return pos + 9;
    case 0xcc: case 0xd0: return pos + 2;
    case 0xcd: case 0xd1: return pos + 3;
    case 0xce: case 0xd2: return pos + 5;
    case 0xcf: case 0xd3: return pos + 9;
    case 0xd9: return pos + 2 + buf[pos + 1];
    case 0xda: return pos + 3 + view.getUint16(pos + 1);
    case 0xdb: return pos + 5 + view.getUint32(pos + 1);
    case 0xdc: return items(view.getUint16(pos + 1), pos + 3);
    case 0xdd: return items(view.getUint32(pos + 1), pos + 5);
    case 0xde: return items(view.getUint16(pos + 1) * 2, pos + 3);
    case 0xdf: return items(view.getUint32(pos + 1) * 2, pos + 5);
    default: throw new Error(`not plain msgpack: byte 0x${b.toString(16)} at ${pos}`);
  }
}

// What the agent sends most: its player state, plus repeated shapes that msgpackr would turn into records
const PLAYER_UPDATE = { id: 'p1', p: [1, 2, 3], q: [0, 0, 0, 1], e: 'asset://mp-walk.glb?s=2' };
const REPEATED = [{ a: 1, b: 'x' }, { a: 2, b: 'y' }, { a: 3, b: 'z' }];

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.OPEN;
  binaryType = '';
  listeners = new Map<string, Set<(e: any) => void>>();
  sent: Uint8Array[] = [];
  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }
  addEventListener(type: string, fn: (e: any) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: (e: any) => void) {
    this.listeners.get(type)?.delete(fn);
  }
  dispatch(type: string, event: any) {
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }
  send(data: Uint8Array) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
}

describe('world protocol table', () => {
  it("numbers packets as the world does: coo-world's table, every position, and the engine's own names in the same order", () => {
    expect(PROTOCOL_VERSION).toBe(2);
    // coo-world src/core/packets.js as of 2d6cba2, in order: a packet's id is its position
    // prettier-ignore
    expect(PACKET_NAMES).toEqual([
      'snapshot', 'command', 'chatAdded', 'chatCleared', 'blueprintAdded', 'blueprintModified', 'entityAdded', 'entityModified',
      'entityEvent', 'entityRemoved', 'playerTeleport', 'playerPush', 'playerSessionAvatar', 'liveKitLevel', 'mute', 'settingsModified',
      'spawnModified', 'modifyRank', 'kick', 'ai', 'ping', 'pong', 'requestBuilderByToken', 'revokeBuilderByToken',
      'requestBuilderNonce', 'builderNonce', 'walletStatus', 'tokenBalanceRequest', 'tokenBalance', 'requestBuilderRecheck', 'requestEvmNonce', 'evmNonce',
      'requestEvmVerify', 'evmWalletStatus', 'revokeEvmWallet', 'setEvmTipReceive', 'requestEvmTipIntent', 'evmTipIntent', 'evmTip', 'evmTipStatus',
    ]);
    // The bundled engine's table (its packets.js): each of its names is in the world's, in the same order
    // prettier-ignore
    const engine = ['snapshot', 'command', 'chatAdded', 'chatCleared', 'blueprintAdded', 'blueprintModified', 'entityAdded', 'entityModified', 'entityEvent', 'entityRemoved', 'playerTeleport', 'playerPush', 'playerSessionAvatar', 'settingsModified', 'spawnModified', 'kick', 'ping', 'pong'];
    const positions = engine.map((name) => PACKET_NAMES.indexOf(name as (typeof PACKET_NAMES)[number]));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });
});

describe('writeClientPacket', () => {
  it('writes plain msgpack that the world admits', () => {
    for (const data of [PLAYER_UPDATE, REPEATED, 'hello', null]) {
      const packet = writeClientPacket('entityModified', data);
      expect(packet[0]).toBe(0x92); // [id, data]
      expect(packet[1]).toBe(7);
      expect(assertPlainMsgpack(packet)).toBe(packet.length);
    }
  });

  it('is checked by a scan that does catch extension types', () => {
    const records = serverPackr.pack([7, REPEATED]);
    expect(() => assertPlainMsgpack(records)).toThrow(/not plain msgpack/);
  });

  it('refuses a packet the world does not know', () => {
    expect(() => writeClientPacket('nope', {})).toThrow(/not in the world's protocol/);
  });
});

describe('readServerPacket', () => {
  beforeEach(() => resetReportedPacketIds());
  afterEach(() => vi.restoreAllMocks());

  it('reports at most 32 different unknown packet ids, however many the world invents', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (let id = 1000; id < 6000; id++) expect(readServerPacket(serverPackr.pack([id, {}]))).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(MAX_REPORTED_PACKET_IDS);
    expect(String(warn.mock.calls.at(-1)![0])).toContain('Further unknown packet ids are not reported.');
    expect(String(warn.mock.calls[0][0])).not.toContain('Further unknown');
    // One of the reported ids again: still not repeated
    readServerPacket(serverPackr.pack([1000, {}]));
    expect(warn).toHaveBeenCalledTimes(MAX_REPORTED_PACKET_IDS);
  });

  it("reads the world's packets, including the ones the engine's table lacks", () => {
    // With each: how many values it decoded into (lib/packet-decode.ts)
    expect(readServerPacket(serverPackr.pack([18, 'outdated']))).toEqual(['onKick', 'outdated', 3]);
    const settings = serverPackr.pack([15, { key: 'customAvatars', value: true }]);
    const arrayBuffer = settings.buffer.slice(settings.byteOffset, settings.byteOffset + settings.byteLength) as ArrayBuffer;
    expect(readServerPacket(arrayBuffer)).toEqual([
      'onSettingsModified',
      { key: 'customAvatars', value: true },
      5,
    ]);
  });

  it('does not read a packet that would decode into more values than the limit, and tells whoever asked why', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    // 600,000 empty arrays in 600 KB, as the data of a known packet
    const frame = new Uint8Array(7 + 600_000).fill(0x90);
    frame.set([0x92, 0x07, 0xdd, 0x00, 0x09, 0x27, 0xc0]);
    const why: string[] = [];
    expect(readServerPacket(frame, (reason) => why.push(reason))).toEqual([]);
    expect(why).toEqual([`it holds more than ${PACKET_LIMITS.maxNodes} values`]);
    expect(error).not.toHaveBeenCalled();
    // Nobody to tell: counted with the packets that could not be read
    expect(readServerPacket(frame)).toEqual([]);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('skips an unknown packet and says so once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(readServerPacket(serverPackr.pack([99, {}]))).toEqual([]);
    expect(readServerPacket(serverPackr.pack([99, {}]))).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('skips an unreadable packet without throwing, and says only its size', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    // A complete frame followed by junk, the first unreadable one (so it is the one the line is about)
    const frame = serverPackr.pack([2, { body: TOKEN }]);
    const withTrailer = new Uint8Array([...frame, 0xc1, 0xc1]);
    expect(Buffer.from(withTrailer).toString('latin1')).toContain(TOKEN);
    expect(readServerPacket(withTrailer)).toEqual([]);
    expect(error.mock.calls).toEqual([[`[Hyperfy] Could not read 1 packet(s) from the world (the latest ${withTrailer.byteLength} bytes, refused: trailing bytes)`]]);
    expect(readServerPacket(new Uint8Array([0xc1]))).toEqual([]);
    expect(JSON.stringify(error.mock.calls)).not.toContain(TOKEN);
  });

  it('says that packets could not be read at most once per 10 s, with the count since the last line', () => {
    vi.useFakeTimers();
    try {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      for (let i = 0; i < 500; i++) readServerPacket(new Uint8Array([0xc1]));
      expect(error.mock.calls.map(([line]) => line)).toEqual(['[Hyperfy] Could not read 1 packet(s) from the world (the latest 1 bytes, refused: reserved byte)']);
      vi.advanceTimersByTime(10_000);
      readServerPacket(new Uint8Array([0xc1, 0xc1]));
      expect(error.mock.calls.map(([line]) => line).at(-1)).toBe('[Hyperfy] Could not read 500 packet(s) from the world (the latest 2 bytes, refused: reserved byte)');
      expect(error).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not echo a non-numeric id', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(readServerPacket(serverPackr.pack([TOKEN, {}]))).toEqual([]);
    // It is reported, by its type alone
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('The world sent packet a non-numeric id (string), which is not in this agent\'s protocol table');
    expect(JSON.stringify(warn.mock.calls)).not.toContain(TOKEN);
  });
});

describe('adaptToWorldProtocol on the engine ClientNetwork', () => {
  let world: any;
  let network: any;

  beforeEach(() => {
    resetReportedPacketIds();
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
    world = { chat: { add: vi.fn() }, emit: vi.fn() };
    network = new ClientNetwork(world);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const socket = () => FakeWebSocket.instances[0];

  it('says why each frame it cannot read before the snapshot was read could not be read, and nothing after the snapshot', () => {
    const protocol = adaptToWorldProtocol(network, () => null);
    const heard: string[] = [];
    protocol.onUnreadableBeforeSnapshot((why) => heard.push(why));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const loop: unknown[] = [];
    loop.push(loop);
    const cyclic = serverPackr.pack([0, loop]);
    network.onPacket({ data: cyclic });
    network.onPacket({ data: 'text' });
    expect(heard).toEqual([`a frame of ${cyclic.byteLength} bytes is refused: cycle`, 'not a binary frame']);
    // A snapshot read: from then on an unreadable frame is dropped as before and nothing more is said here
    network.onPacket({ data: serverPackr.pack([0, cooWorldSnapshot()]) });
    network.onPacket({ data: cyclic });
    network.onPacket({ data: new Uint8Array([0xc1]) });
    expect(heard).toHaveLength(2);
  });

  it('connects with the session token and the protocol version', () => {
    adaptToWorldProtocol(network, () => TOKEN);
    network.init({ wsUrl: 'wss://world.test/ws', name: 'Coo Bot' });
    const url = new URL(socket().url);
    expect(url.searchParams.get('authToken')).toBe(TOKEN);
    expect(url.searchParams.get('v')).toBe(String(PROTOCOL_VERSION));
    expect(url.searchParams.get('name')).toBe('Coo Bot');
    expect(socket().binaryType).toBe('arraybuffer');
  });

  it('leaves the token out when there is none yet', () => {
    adaptToWorldProtocol(network, () => null);
    network.init({ wsUrl: 'wss://world.test/ws?authToken=old&authToken=older' });
    expect(new URL(socket().url).searchParams.has('authToken')).toBe(false);
  });

  it.each([
    ['not a url', 'not a url'],
    // Text with a scheme that does not parse keeps only its length (lib/log-url.ts)
    ['ws://', '<invalid URL, 5 characters>'],
  ])('rejects a malformed URL before reading the token: %s', (wsUrl, shown) => {
    const getAuthToken = vi.fn(() => TOKEN);
    adaptToWorldProtocol(network, getAuthToken);
    expect(() => network.init({ wsUrl })).toThrow(`Invalid Hyperfy WebSocket URL: ${shown}`);
    expect(getAuthToken).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it.each(['localhost:3000/ws', 'ftp://world.test/ws'])('rejects an unsupported protocol: %s', (wsUrl) => {
    const getAuthToken = vi.fn(() => TOKEN);
    adaptToWorldProtocol(network, getAuthToken);
    expect(() => network.init({ wsUrl })).toThrow(`Unsupported Hyperfy WebSocket protocol: ${new URL(wsUrl).protocol}`);
    expect(getAuthToken).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it.each([
    'wss://world.test/ws',
    'https://world.test/ws',
    'ws://127.0.0.1:3000/ws',
    'ws://127.8.9.10/ws',
    'ws://0x7f.1/ws',
    'ws://localhost:3000/ws',
    'http://localhost:3000/ws',
    'ws://[::1]:3000/ws',
    'ws://10.0.0.5/ws',
    'ws://172.16.0.1/ws',
    'ws://172.31.255.255/ws',
    'ws://192.168.1.20:3000/ws',
    'ws://[fd12:3456::1]/ws',
  ])('sends the session token to %s: encrypted, or a loopback or private address', (wsUrl) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const protocol = adaptToWorldProtocol(network, () => TOKEN);
    network.init({ wsUrl });
    expect(new URL(socket().url).searchParams.getAll('authToken')).toEqual([TOKEN]);
    expect(protocol.sessionToken()).toBe(TOKEN);
    expect(error).not.toHaveBeenCalled();
  });

  it.each([
    'ws://world.test/ws',
    'http://world.test/ws',
    'ws://8.8.8.8/ws',
    'ws://172.32.0.1/ws',
    'ws://172.15.0.1/ws',
    'ws://192.169.1.1/ws',
    'ws://11.0.0.1/ws',
    'ws://169.254.169.254/ws',
    'ws://0.0.0.0/ws',
    'ws://[2001:db8::1]/ws',
    'ws://[fe80::1]/ws',
    'ws://localhost.evil.test/ws',
    'ws://127.0.0.1.nip.io/ws',
    'ws://127.0.0.1@evil.test/ws',
    'ws://my-lan-box:3000/ws',
  ])('connects to %s without the session token, says why once, and never prints the token', (wsUrl) => {
    const logs = (['log', 'warn', 'error', 'info', 'debug'] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => {}));
    const protocol = adaptToWorldProtocol(network, () => TOKEN);
    network.init({ wsUrl: `${wsUrl}?authToken=old&other=keep`, name: 'Coo Bot' });
    const url = new URL(socket().url);
    expect(url.searchParams.has('authToken')).toBe(false);
    expect(socket().url).not.toContain(TOKEN);
    expect(url.searchParams.get('other')).toBe('keep');
    expect(url.searchParams.get('v')).toBe(String(PROTOCOL_VERSION));
    // Nothing else of this connection gets the token either (the upload reads it from here)
    expect(protocol.sessionToken()).toBeNull();
    const lines = logs.flatMap((log) => log.mock.calls.flat()).map(String);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('[Hyperfy] No session token on this connection');
    expect(lines[0]).toContain('is not encrypted and is not a loopback or private address');
    expect(lines.join('\n')).not.toContain(TOKEN);
  });

  describe("the engine's own snapshot handler, with nothing saved yet", () => {
    beforeEach(() => saved.clear());
    afterEach(() => saved.clear());

    /**
     * The engine's ClientNetwork joined at `wsUrl` through the adapter, the storage being the stub
     * above; the world systems its onSnapshot hands the snapshot to take it and do nothing.
     */
    function join(wsUrl: string) {
      const takes = { deserialize() {} };
      const engineWorld: any = { loader: { preload() {}, execPreload() {} }, environment: {}, collections: takes, settings: takes, chat: takes, blueprints: takes, entities: takes };
      const engineNetwork: any = new ClientNetwork(engineWorld);
      // As the service reads it: storage.get('authToken'), here the stub's map
      const protocol = adaptToWorldProtocol(engineNetwork, () => (saved.get('authToken') as string | undefined) ?? null);
      engineNetwork.init({ wsUrl });
      // What the engine's flush() calls for the world's snapshot: its own ClientNetwork.onSnapshot
      engineNetwork.onSnapshot({ ...cooWorldSnapshot(), authToken: 'guest-token-1' });
      return { protocol, url: new URL(FakeWebSocket.instances.at(-1)!.url) };
    }

    it('keeps no guest token from a cleartext public world and gives uploads none: the agent is a new guest on every connection there', () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const first = join('ws://world.test/ws');
      expect(saved.has('authToken')).toBe(false);
      expect(first.protocol.sessionToken()).toBeNull();
      expect(first.url.searchParams.has('authToken')).toBe(false);
      const again = join('ws://world.test/ws');
      expect(again.url.searchParams.has('authToken')).toBe(false);
      expect(saved.has('authToken')).toBe(false);
      // One line per connection, naming why
      expect(error.mock.calls.map(([line]) => String(line))).toEqual([expect.stringContaining('[Hyperfy] No session token on this connection'), expect.stringContaining('[Hyperfy] No session token on this connection')]);
    });

    it('stores the token an encrypted world issues and uses it from then on (control)', () => {
      const first = join('wss://world.test/ws');
      expect(saved.get('authToken')).toBe('guest-token-1');
      expect(first.protocol.sessionToken()).toBe('guest-token-1');
      expect(join('wss://world.test/ws').url.searchParams.get('authToken')).toBe('guest-token-1');
    });
  });

  it("does not let the engine replace the saved token with the guest token of a connection made without it", () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // The engine's onSnapshot stores data.authToken (ClientNetwork.js: storage.set('authToken', data.authToken))
    const stored: unknown[] = [];
    const engine = (wsUrl: string) => {
      const fake: any = { onClose: () => {}, onSnapshot: (data: { authToken: unknown }) => void stored.push(data.authToken) };
      adaptToWorldProtocol(fake, () => TOKEN);
      fake.init({ wsUrl });
      return fake;
    };
    const snapshot = { id: 'guest-1', authToken: 'token-of-a-new-guest', chat: [] };
    engine('ws://world.test/ws').onSnapshot(snapshot);
    expect(stored).toEqual([TOKEN]);
    // The snapshot itself is not changed
    expect(snapshot.authToken).toBe('token-of-a-new-guest');
    // A connection that sent the token keeps what the world answers (it may renew it)
    engine('wss://world.test/ws').onSnapshot({ ...snapshot, authToken: 'renewed-token' });
    expect(stored).toEqual([TOKEN, 'renewed-token']);
  });

  it.each(['ws:', 'wss:', 'http:', 'https:'])('accepts %s and replaces existing parameters and the fragment', (protocol) => {
    adaptToWorldProtocol(network, () => TOKEN);
    network.init({
      wsUrl: `${protocol}//localhost/ws?v=1&v=0&authToken=old&authToken=older&name=old&name=older&avatar=old&avatar=older&other=keep#hash`,
      name: 'Coo Bot',
      avatar: 'asset://coo.vrm',
    });
    const url = new URL(socket().url);
    expect(url.searchParams.getAll('v')).toEqual(['2']);
    expect(url.searchParams.getAll('authToken')).toEqual([TOKEN]);
    expect(url.searchParams.getAll('name')).toEqual(['Coo Bot']);
    expect(url.searchParams.getAll('avatar')).toEqual(['asset://coo.vrm']);
    expect(url.searchParams.get('other')).toBe('keep');
    expect(url.hash).toBe('');
  });

  it('does not expose a constructor error containing the authenticated URL', () => {
    vi.stubGlobal('WebSocket', class {
      constructor(url: string) {
        throw new SyntaxError(`Wrong url scheme: ${url}`);
      }
    });
    adaptToWorldProtocol(network, () => TOKEN);
    let failure: any;
    try {
      network.init({ wsUrl: 'wss://world.test/ws?other=private' });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toBe('Could not open Hyperfy WebSocket at wss://world.test/ws (SyntaxError)');
    expect(failure.stack).not.toContain(TOKEN);
    expect(failure).not.toHaveProperty('cause');
  });

  it('sends plain packets and queues what the world sends', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    adaptToWorldProtocol(network, () => TOKEN);
    network.init({ wsUrl: 'wss://world.test/ws' });

    network.send('chatAdded', { id: 'm1', body: 'hi' });
    const [packet] = socket().sent;
    expect(packet[1]).toBe(2);
    expect(assertPlainMsgpack(packet)).toBe(packet.length);

    socket().dispatch('message', { data: serverPackr.pack([18, 'outdated']) });
    socket().dispatch('message', { data: serverPackr.pack([100, {}]) });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(network.queue).toEqual([['onKick', 'outdated']]);
  });

  describe('what waits for the engine to flush', () => {
    const entityModified = (i: number, pad = 0) => serverPackr.pack([7, { id: `e${i}`, p: [i, 0, 0], ...(pad ? { pad: 'x'.repeat(pad) } : {}) }]);

    function connected() {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(console, 'log').mockImplementation(() => {});
      adaptToWorldProtocol(network, () => TOKEN);
      network.init({ wsUrl: 'wss://world.test/ws' });
      const ws = socket();
      ws.close = vi.fn(() => void (ws.readyState = 3));
      return { ws, error, send: (frame: Uint8Array) => ws.dispatch('message', { data: frame }) };
    }

    it(`closes the connection, once, when more than ${MAX_QUEUED_PACKETS} packets wait, keeping a queued kick for the service`, () => {
      const { ws, error, send } = connected();
      send(serverPackr.pack([18, 'player_limit']));
      for (let i = 0; i < MAX_QUEUED_PACKETS - 1; i++) send(entityModified(i));
      expect(network.queue).toHaveLength(MAX_QUEUED_PACKETS);
      expect(world.emit).not.toHaveBeenCalled();
      send(entityModified(-1));
      // What waited is gone but the kick; nothing more is taken from this socket
      expect(network.queue).toEqual([['onKick', 'player_limit']]);
      expect(ws.close).toHaveBeenCalledWith(QUEUE_OVERFLOW_CLOSE_CODE, expect.any(String));
      expect(world.emit.mock.calls.filter(([name]: [string]) => name === 'disconnect')).toEqual([['disconnect', { code: QUEUE_OVERFLOW_CLOSE_CODE, reason: expect.any(String), wasClean: false }]]);
      for (let i = 0; i < 10; i++) send(entityModified(i));
      expect(network.queue).toHaveLength(1);
      // The socket's own close event, when it comes, reports nothing more
      ws.dispatch('close', { code: 1006, reason: '', wasClean: false });
      expect(world.emit.mock.calls.filter(([name]: [string]) => name === 'disconnect')).toHaveLength(1);
      expect(error.mock.calls.flat().map(String).filter((line) => line.includes('Closing the connection'))).toHaveLength(1);
    });

    it('drops a frame that would decode into more values than the limit like a frame that is too large: nothing of it is queued, and the connection stays', () => {
      const { ws, send } = connected();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const tooMany = new Uint8Array(7 + 600_000).fill(0x90);
      tooMany.set([0x92, 0x07, 0xdd, 0x00, 0x09, 0x27, 0xc0]);
      const tooDeep = new Uint8Array(100).fill(0x91);
      tooDeep.set([0x92, 0x07]);
      tooDeep[99] = 0xc0;
      send(tooMany);
      send(tooDeep);
      send(entityModified(1));
      expect(network.queue).toEqual([['onEntityModified', { id: 'e1', p: [1, 0, 0] }]]);
      expect(ws.close).not.toHaveBeenCalled();
      expect(warn.mock.calls.map(([line]) => String(line))).toEqual([`[Hyperfy] Dropped 1 frame(s) from the world: a frame of 600007 bytes is not decoded: it holds more than ${PACKET_LIMITS.maxNodes} values`]);
    });

    it('counts what waits by what it decoded into, not only by its frame: frames of small containers fill the queue long before their bytes would', () => {
      const { ws, send } = connected();
      // 400,000 empty arrays in 400 KB: under the per-frame limit, 12.8 MB as it waits
      const dense = new Uint8Array(7 + 400_000).fill(0x90);
      dense.set([0x92, 0x07, 0xdd, 0x00, 0x06, 0x1a, 0x80]);
      const fit = Math.floor(MAX_QUEUED_BYTES / (400_003 * QUEUED_NODE_BYTES));
      expect(fit).toBe(2);
      for (let i = 0; i < fit; i++) send(dense);
      expect(network.queue).toHaveLength(fit);
      expect(ws.close).not.toHaveBeenCalled();
      // By their bytes alone, eighty of them would fit
      expect(Math.floor(MAX_QUEUED_BYTES / dense.byteLength)).toBeGreaterThan(80);
      send(dense);
      expect(ws.close).toHaveBeenCalledTimes(1);
      expect(network.queue).toEqual([]);
    });

    it(`closes the connection when the frames waiting add up to more than ${MAX_QUEUED_BYTES / 1024 / 1024} MiB`, () => {
      const { ws, send } = connected();
      const big = entityModified(0, 7 * 1024 * 1024);
      const fit = Math.floor(MAX_QUEUED_BYTES / big.byteLength);
      for (let i = 0; i < fit; i++) send(big);
      expect(network.queue).toHaveLength(fit);
      expect(ws.close).not.toHaveBeenCalled();
      send(big);
      expect(ws.close).toHaveBeenCalledTimes(1);
      expect(network.queue).toEqual([]);
    });

    it('counts what waited as gone once the engine has flushed it: a busy world that is kept up with is never closed', () => {
      const { ws, send } = connected();
      network.onEntityModified = vi.fn();
      const big = entityModified(0, 7 * 1024 * 1024);
      const small = entityModified(1);
      // Per tick within both limits; over five ticks far more than either
      for (let tick = 0; tick < 5; tick++) {
        for (let i = 0; i < 4; i++) send(big);
        for (let i = 0; i < 1000; i++) send(small);
        network.flush();
      }
      expect(network.onEntityModified).toHaveBeenCalledTimes(5 * 1004);
      expect(ws.close).not.toHaveBeenCalled();
    });

    it('cuts a chat message down before it waits: twenty 2 MB chat frames hold 500 code points each and do not close the connection', () => {
      const { ws, send } = connected();
      const frames = 20;
      for (let i = 0; i < frames; i++) send(serverPackr.pack([2, { id: `m${i}`, fromId: 'p1', from: 'Alice', body: '🛹'.repeat(512 * 1024), createdAt: '' }]));
      expect(frames * 2 * 1024 * 1024).toBeGreaterThan(MAX_QUEUED_BYTES);
      expect(ws.close).not.toHaveBeenCalled();
      expect(network.queue).toHaveLength(frames);
      for (const [method, msg] of network.queue) {
        expect(method).toBe('onChatAdded');
        expect(Array.from(msg.body)).toHaveLength(500);
        expect(Object.keys(msg).sort()).toEqual(['body', 'createdAt', 'from', 'fromId', 'id']);
      }
      // One that is not a chat message does not wait at all
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      send(serverPackr.pack([2, { id: 7, body: 'x'.repeat(1024 * 1024) }]));
      expect(network.queue).toHaveLength(frames);
    });
  });

  it('drops a frame above 8 MB before decoding it, and frames that are not binary, with one line for the burst', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    adaptToWorldProtocol(network, () => TOKEN);
    network.init({ wsUrl: 'wss://world.test/ws' });
    // A well-formed chat packet that would be queued if it were decoded
    const big = serverPackr.pack([2, { id: 'm1', body: 'x'.repeat(MAX_SERVER_FRAME_BYTES) }]);
    expect(big.byteLength).toBeGreaterThan(MAX_SERVER_FRAME_BYTES);
    for (let i = 0; i < 5; i++) socket().dispatch('message', { data: big });
    socket().dispatch('message', { data: big.buffer.slice(big.byteOffset, big.byteOffset + big.byteLength) });
    socket().dispatch('message', { data: 'a text frame' });
    socket().dispatch('message', { data: null });
    socket().dispatch('message', {});
    expect(network.queue).toEqual([]);
    expect(warn.mock.calls.flat().map(String)).toEqual([`[Hyperfy] Dropped 1 frame(s) from the world: ${big.byteLength} bytes exceeds the ${MAX_SERVER_FRAME_BYTES}-byte limit`]);

    // A large frame within the limit is read
    const fits = serverPackr.pack([2, { id: 'm2', body: 'x'.repeat(1024 * 1024) }]);
    socket().dispatch('message', { data: fits });
    expect(network.queue.map(([method]: [string]) => method)).toEqual(['onChatAdded']);
  });

  it('drops oversized chat packets and warns once without their contents', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    adaptToWorldProtocol(network, () => TOKEN);
    network.init({ wsUrl: 'wss://world.test/ws' });
    const data = { body: TOKEN + 'あ'.repeat(12 * 1024) };
    const size = writeClientPacket('chatAdded', data).byteLength;
    expect(size).toBeGreaterThan(32 * 1024);

    network.send('chatAdded', data);
    network.send('chatAdded', data);

    expect(socket().sent).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(`[Hyperfy] Not sending chatAdded: ${size} bytes exceeds the ${32 * 1024}-byte limit`);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(TOKEN);
  });

  it.each(['entityEvent', 'blueprintAdded', 'blueprintModified', 'ai'])('allows %s between 32 and 64 KiB, then warns once above 64 KiB', (name) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    adaptToWorldProtocol(network, () => TOKEN);
    network.init({ wsUrl: 'wss://world.test/ws' });
    const data = 'x'.repeat(40 * 1024);

    network.send(name, data);

    expect(socket().sent).toHaveLength(1);
    expect(socket().sent[0].byteLength).toBeGreaterThan(32 * 1024);
    expect(socket().sent[0].byteLength).toBeLessThan(64 * 1024);
    expect(warn).not.toHaveBeenCalled();

    const oversized = 'x'.repeat(64 * 1024);
    network.send(name, oversized);
    network.send(name, oversized);
    expect(socket().sent).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(`[Hyperfy] Not sending ${name}: ${writeClientPacket(name, oversized).byteLength} bytes exceeds the ${64 * 1024}-byte limit`);
  });

  it('reports a disconnect without the socket URL, and destroy() removes the same listeners', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    adaptToWorldProtocol(network, () => TOKEN);
    network.init({ wsUrl: 'wss://world.test/ws' });
    const ws = socket();

    ws.dispatch('close', { code: 1008, reason: 'outdated', wasClean: false, target: ws, currentTarget: ws });
    expect(world.emit).toHaveBeenCalledWith('disconnect', { code: 1008, reason: 'outdated', wasClean: false });
    expect(JSON.stringify(log.mock.calls)).not.toContain(TOKEN);

    network.destroy();
    expect(ws.listeners.get('message')?.size).toBe(0);
    expect(ws.listeners.get('close')?.size).toBe(0);
  });
});

describe('describeClose', () => {
  it('keeps only what is safe to log', () => {
    expect(describeClose({ code: 1000, reason: '', wasClean: true, target: { url: `wss://x?authToken=${TOKEN}` } })).toEqual({
      code: 1000,
      reason: '',
      wasClean: true,
    });
    expect(describeClose(1006)).toBe(1006);
  });
});

describe('sessionTokenProblem', () => {
  it('reads the host as the URL parser writes it, whatever the spelling', () => {
    expect(sessionTokenProblem(new URL('ws://2130706433/ws'))).toBeNull();
    expect(sessionTokenProblem(new URL('ws://LOCALHOST/ws'))).toBeNull();
    expect(sessionTokenProblem(new URL('ws://[::ffff:127.0.0.1]/ws'))).toBeNull();
    expect(sessionTokenProblem(new URL('ws://localhost./ws'))).toBe('ws://localhost. is not encrypted and is not a loopback or private address');
    expect(sessionTokenProblem(new URL('ws://user:pw@world.test:8080/ws'))).toBe('ws://world.test:8080 is not encrypted and is not a loopback or private address');
  });
});

describe('outgoingPacketProblem', () => {
  afterEach(() => vi.restoreAllMocks());

  it('says why the world would drop a packet over its limit, and the adapter does not send it', () => {
    expect(outgoingPacketProblem('blueprintAdded', { id: 'b', props: { a: 'x'.repeat(100) } })).toBeNull();
    expect(outgoingPacketProblem('blueprintAdded', { id: 'b', props: { a: 'x'.repeat(70 * 1024) } })).toMatch(/^the blueprintAdded packet would be at least \d+ bytes, more than the 65536 the world accepts$/);
    expect(outgoingPacketProblem('entityAdded', { id: 'e', state: { a: 'x'.repeat(33 * 1024) } })).toMatch(/more than the 32768/);
    const frames: unknown[] = [];
    const network: any = { queue: [], onClose: () => {}, flush: () => {}, ws: { send: (frame: unknown) => void frames.push(frame) } };
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    adaptToWorldProtocol(network, () => null);
    expect(network.send('entityAdded', { id: 'e', state: { a: 'x'.repeat(33 * 1024) } })).toBe(false);
    expect(network.send('entityAdded', { id: 'e' })).toBe(true);
    expect(frames).toHaveLength(1);
  });

  // What coo-world's inbound scan (src/core/extras/strictDecode.js, inboundPolicy.js) gives at each limit
  const nested = (levels: number): unknown => (levels === 0 ? null : { a: nested(levels - 1) });

  it("refuses nesting the world's scan refuses (deeper than 32 levels): the review's 33 nested objects, and one level past the limit", () => {
    expect(outgoingPacketProblem('blueprintAdded', { id: 'b', props: nested(33) })).toBe('the blueprintAdded packet nests deeper than the 32 levels the world accepts');
    // [id, {id, props: ...}]: the props' 29 objects and their innermost value come to level 32
    expect(outgoingPacketProblem('blueprintAdded', { id: 'b', props: nested(29) })).toBeNull();
    expect(outgoingPacketProblem('blueprintAdded', { id: 'b', props: nested(30) })).toBe('the blueprintAdded packet nests deeper than the 32 levels the world accepts');
    // A value that holds itself: refused at the depth limit, never packed (the packer would recurse until the stack overflows)
    const loop: Record<string, unknown> = { id: 'loop' };
    loop.self = loop;
    expect(outgoingPacketProblem('blueprintAdded', { id: 'b', props: loop })).toBe('the blueprintAdded packet nests deeper than the 32 levels the world accepts');
  });

  it('refuses more values than the world takes for that packet (8,192 for a blueprint, 4,096 for an entity), counted as its scan counts them', () => {
    // The packet array and its two elements, the two entries of the object (two each), then the list
    expect(outgoingPacketProblem('blueprintAdded', { id: 'b', props: new Array(8185).fill(0) })).toBeNull();
    expect(outgoingPacketProblem('blueprintAdded', { id: 'b', props: new Array(8186).fill(0) })).toBe('the blueprintAdded packet holds more than the 8192 values the world accepts');
    expect(outgoingPacketProblem('entityAdded', { id: 'e', state: new Array(4089).fill(0) })).toBeNull();
    expect(outgoingPacketProblem('entityAdded', { id: 'e', state: new Array(4090).fill(0) })).toBe('the entityAdded packet holds more than the 4096 values the world accepts');
    // A bin is four
    expect(outgoingPacketProblem('entityAdded', { id: 'e', state: Array.from({ length: 1022 }, () => new Uint8Array(1)) })).toBeNull();
    expect(outgoingPacketProblem('entityAdded', { id: 'e', state: Array.from({ length: 1023 }, () => new Uint8Array(1)) })).toMatch(/more than the 4096 values/);
  });

  it('refuses what the world scan does not take: a date (an extension), a map key that is not a string; and what cannot be written at all', () => {
    expect(outgoingPacketProblem('blueprintAdded', { id: 'b', props: { at: new Date(0) } })).toBe('the blueprintAdded packet holds a value the world does not accept (byte 0xd6 refused)');
    expect(outgoingPacketProblem('blueprintAdded', { id: 'b', props: new Map([[1, 'x']]) })).toBe('the blueprintAdded packet holds a value the world does not accept (map key is not a string)');
    expect(outgoingPacketProblem('entityAdded', { id: 'e', state: { n: 2n ** 70n } })).toBe('the entityAdded packet holds a value that cannot be written as msgpack (RangeError)');
    // undefined is fixext 1 of type 0, which the world takes
    expect(outgoingPacketProblem('entityAdded', { id: 'e', state: { n: undefined } })).toBeNull();
  });

  it('stops at the limit before packing a value the packer would write out in full at every reference to it', () => {
    /** `items` as an array whose element reads are counted (a packer would read every element at every reference) */
    const counted = <T>(items: T[]) => {
      const reads = { count: 0 };
      const array = new Proxy(items, {
        get(target, key, receiver) {
          if (typeof key === 'string' && /^\d+$/.test(key)) reads.count++;
          return Reflect.get(target, key, receiver);
        },
      });
      return { array, reads };
    };
    // 2^20 values to the packer, in a few objects: the innermost list, held 2^20 times, is read a few thousand times
    const leaf = counted([0]);
    let chain: unknown = leaf.array;
    for (let i = 0; i < 20; i++) chain = [chain, chain];
    expect(outgoingPacketProblem('blueprintAdded', { id: 'b', props: chain })).toBe('the blueprintAdded packet holds more than the 8192 values the world accepts');
    expect(leaf.reads.count).toBeLessThan(8192);
    // One 60 KB string 5,000 times (300 MB to the packer): two of them are read
    const strings = counted(new Array(5000).fill('z'.repeat(60_000)));
    expect(outgoingPacketProblem('blueprintAdded', { id: 'b', props: strings.array })).toMatch(/^the blueprintAdded packet would be at least \d+ bytes, more than the 65536 the world accepts$/);
    expect(strings.reads.count).toBe(2);
  });
});
