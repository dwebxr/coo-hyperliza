import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Packr } from 'msgpackr';

// The engine's ClientNetwork imports its storage module, which reads the agent's saved session
vi.mock('../hyperfy/src/core/storage.js', () => ({ storage: { get: () => null, set: () => {}, remove: () => {} } }));

import { ClientNetwork } from '../hyperfy/src/core/systems/ClientNetwork.js';
import { PACKET_NAMES, PROTOCOL_VERSION, adaptToWorldProtocol, describeClose, readServerPacket, writeClientPacket } from './world-protocol';

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
  it("numbers packets as the world does", () => {
    expect(PROTOCOL_VERSION).toBe(2);
    expect(PACKET_NAMES).toHaveLength(26);
    expect(PACKET_NAMES.indexOf('entityModified')).toBe(7);
    expect(PACKET_NAMES.indexOf('settingsModified')).toBe(15);
    expect(PACKET_NAMES.indexOf('kick')).toBe(18);
    expect(PACKET_NAMES.indexOf('ping')).toBe(20);
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
  afterEach(() => vi.restoreAllMocks());

  it("reads the world's packets, including the ones the engine's table lacks", () => {
    expect(readServerPacket(serverPackr.pack([18, 'outdated']))).toEqual(['onKick', 'outdated']);
    const settings = serverPackr.pack([15, { key: 'customAvatars', value: true }]);
    const arrayBuffer = settings.buffer.slice(settings.byteOffset, settings.byteOffset + settings.byteLength) as ArrayBuffer;
    expect(readServerPacket(arrayBuffer)).toEqual([
      'onSettingsModified',
      { key: 'customAvatars', value: true },
    ]);
  });

  it('skips an unknown packet and says so once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(readServerPacket(serverPackr.pack([99, {}]))).toEqual([]);
    expect(readServerPacket(serverPackr.pack([99, {}]))).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('skips an unreadable packet without throwing or quoting it', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(readServerPacket(new Uint8Array([0xc1]))).toEqual([]);
    // a complete frame followed by junk: the decoder's own message would quote the frame
    const frame = serverPackr.pack([2, { body: TOKEN }]);
    const withTrailer = new Uint8Array([...frame, 0xc1, 0xc1]);
    readServerPacket(withTrailer);
    expect(JSON.stringify(error.mock.calls)).not.toContain(TOKEN);
  });

  it('does not echo a non-numeric id', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(readServerPacket(serverPackr.pack([TOKEN, {}]))).toEqual([]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(TOKEN);
  });
});

describe('adaptToWorldProtocol on the engine ClientNetwork', () => {
  let world: any;
  let network: any;

  beforeEach(() => {
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

  it.each(['not a url', 'ws://'])('rejects a malformed URL before reading the token: %s', (wsUrl) => {
    const getAuthToken = vi.fn(() => TOKEN);
    adaptToWorldProtocol(network, getAuthToken);
    expect(() => network.init({ wsUrl })).toThrow(`Invalid Hyperfy WebSocket URL: ${wsUrl}`);
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

  it.each(['ws:', 'wss:', 'http:', 'https:'])('accepts %s and replaces existing parameters and the fragment', (protocol) => {
    adaptToWorldProtocol(network, () => TOKEN);
    network.init({
      wsUrl: `${protocol}//world.test/ws?v=1&v=0&authToken=old&authToken=older&name=old&name=older&avatar=old&avatar=older&other=keep#hash`,
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
