import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const rooms: any[] = [];
vi.mock('@livekit/rtc-node', () => {
  class Room {
    connected = false;
    resolveConnect!: () => void;
    disconnect = vi.fn(async () => {
      // like the SDK: a no-op while the join is still pending
      this.connected = false;
    });
    on = vi.fn();
    localParticipant = { publishTrack: vi.fn(async () => {}) };
    connectedTo: unknown[] = [];
    constructor() {
      rooms.push(this);
    }
    connect(...args: unknown[]) {
      this.connectedTo = args;
      return new Promise<void>((resolve) => {
        this.resolveConnect = () => {
          this.connected = true;
          resolve();
        };
      });
    }
  }
  return {
    Room,
    AudioFrame: class {},
    AudioSource: class {
      captureFrame = vi.fn(async () => {});
    },
    LocalAudioTrack: { createAudioTrack: vi.fn() },
    TrackPublishOptions: class {},
    TrackSource: { SOURCE_MICROPHONE: 1 },
    RoomEvent: {},
    TrackKind: { KIND_AUDIO: 1 },
    AudioStream: class {},
  };
});

import { AgentLiveKit } from './liveKit';
import { NetPolicy, installWorldNet } from '../lib/net-policy';
import { PUBLIC_ADDRESS } from '../test-support/net';

const opts = { wsUrl: 'wss://lk.test', token: 't' };
/** A world whose own host is lk.test (WS_URL wss://lk.test/ws) */
const worldOnLk = () => {
  const world = {};
  installWorldNet(world, new NetPolicy({ worldOrigin: 'https://lk.test' }));
  return world;
};

describe('AgentLiveKit room lifecycle', () => {
  it('leaves a room whose join completes after teardown', async () => {
    rooms.length = 0;
    const livekit = new AgentLiveKit(worldOnLk());
    const joining = livekit.deserialize(opts);
    await vi.waitFor(() => expect(rooms).toHaveLength(1));

    await livekit.disconnectRoom();
    rooms[0].resolveConnect();
    await joining;

    expect(rooms[0].disconnect).toHaveBeenCalledTimes(2);
    expect(rooms[0].connected).toBe(false);
    expect(rooms[0].on).not.toHaveBeenCalled();
  });

  it('a second deserialize replaces the first room without double-wiring events', async () => {
    rooms.length = 0;
    const livekit = new AgentLiveKit(worldOnLk());
    const first = livekit.deserialize(opts);
    await vi.waitFor(() => expect(rooms).toHaveLength(1));
    const second = livekit.deserialize(opts);
    await vi.waitFor(() => expect(rooms).toHaveLength(2));

    rooms[0].resolveConnect();
    rooms[1].resolveConnect();
    await Promise.all([first, second]);

    expect(rooms[0].connected).toBe(false);
    expect(rooms[0].on).not.toHaveBeenCalled();
    expect(rooms[1].connected).toBe(true);
    expect(rooms[1].on).toHaveBeenCalled();
  });

  it('a join superseded (or torn down) during the voice server check creates no room', async () => {
    rooms.length = 0;
    const livekit = new AgentLiveKit(worldOnLk());
    const first = livekit.deserialize(opts);
    const second = livekit.deserialize(opts);
    await vi.waitFor(() => expect(rooms).toHaveLength(1));
    rooms[0].resolveConnect();
    await Promise.all([first, second]);
    const third = livekit.deserialize(opts);
    livekit.destroy();
    await third;
    expect(rooms).toHaveLength(1);
  });
});

describe('AgentLiveKit and the voice server the world names', () => {
  const quiet = () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    return vi.spyOn(console, 'warn').mockImplementation(() => {});
  };

  it.each([
    ['a private address', 'wss://10.0.0.7', '10.0.0.7 is a private address'],
    ['loopback while the world is elsewhere', 'ws://127.0.0.1:7880', "ws:// is only allowed on the world's own host"],
    ['the metadata address', 'wss://169.254.169.254', 'cloud metadata'],
    ['a host that resolves to a private address', 'wss://lk.internal', 'lk.internal resolves to 10.0.0.9, which is a private address'],
    ['another port elsewhere', 'wss://lk.example:7880', 'port 7880 is not allowed'],
    ['credentials', 'wss://user:pw@lk.test', 'user name or password'],
    ['another scheme', 'https://lk.example', 'https:// is not a voice server URL'],
  ])('hands the native client nothing for %s, and says why in one line without the token', async (_name, wsUrl, why) => {
    rooms.length = 0;
    const warn = quiet();
    const world = {};
    installWorldNet(world, new NetPolicy({ worldOrigin: 'https://world.example', resolve: async (host) => [{ address: host === 'lk.internal' ? '10.0.0.9' : PUBLIC_ADDRESS, family: 4 }] }));
    await new AgentLiveKit(world).deserialize({ wsUrl, token: 'secret-livekit-token' });
    expect(rooms).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0].join(' ')).toContain('Voice chat off');
    expect(warn.mock.calls[0].join(' ')).toContain(why);
    expect(warn.mock.calls[0].join(' ')).not.toContain('secret-livekit-token');
    vi.restoreAllMocks();
  });

  it("connects to the world's own host (any scheme and port) and to wss: on a public host", async () => {
    quiet();
    for (const [origin, wsUrl] of [['http://127.0.0.1:3000', 'ws://localhost:7880'], ['https://world.example', 'wss://lk.example']]) {
      rooms.length = 0;
      const world = {};
      installWorldNet(world, new NetPolicy({ worldOrigin: origin, resolve: async () => [{ address: PUBLIC_ADDRESS, family: 4 }] }));
      const joining = new AgentLiveKit(world).deserialize({ wsUrl, token: 't' });
      await vi.waitFor(() => expect(rooms).toHaveLength(1));
      rooms[0].resolveConnect();
      await joining;
      expect(rooms[0].connectedTo.slice(0, 2)).toEqual([wsUrl, 't']);
    }
    vi.restoreAllMocks();
  });
});

describe('AgentLiveKit playback outcome', () => {
  const pcm = () => Buffer.alloc(4800 * 2);
  async function joined() {
    rooms.length = 0;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const livekit = new AgentLiveKit(worldOnLk());
    const joining = livekit.deserialize(opts);
    await vi.waitFor(() => expect(rooms).toHaveLength(1));
    rooms[0].resolveConnect();
    await joining;
    return livekit;
  }
  afterEach(() => vi.restoreAllMocks());

  it('reports nothing played when no room is connected', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(new AgentLiveKit({}).publishAudioStream(pcm())).resolves.toEqual({ played: 'none', reason: 'not connected to a voice room' });
  });

  it('reports played once audio went out to the room', async () => {
    const livekit = await joined();
    await expect(livekit.publishAudioStream(pcm())).resolves.toEqual({ played: 'all' });
  });

  it('reports nothing played when stopped before the first frame, or when the room went away while the track was published', async () => {
    const livekit = await joined();
    const stopped = new AbortController();
    stopped.abort();
    await expect(livekit.publishAudioStream(pcm(), { signal: stopped.signal })).resolves.toEqual({ played: 'none', reason: 'stopped' });
    rooms[0].localParticipant.publishTrack.mockImplementation(async () => {
      await livekit.disconnectRoom();
    });
    await expect(livekit.publishAudioStream(pcm())).resolves.toEqual({ played: 'none', reason: 'the voice room went away' });
  });

  it('reports nothing played when it was stopped before the first frame went out (during the lead-in silence)', async () => {
    const livekit = await joined();
    await livekit.publishAudioStream(pcm());
    const stop = new AbortController();
    (livekit as any).audioSource.captureFrame.mockImplementationOnce(async () => stop.abort());
    await expect(livekit.publishAudioStream(pcm(), { signal: stop.signal })).resolves.toEqual({ played: 'none', reason: 'stopped' });
  });

  it('reports nothing played for audio that decodes to nothing', async () => {
    const livekit = await joined();
    await expect(livekit.publishAudioStream(Buffer.alloc(1))).resolves.toEqual({ played: 'none', reason: 'no audio was decoded' });
  });

  it('reports partly played, never nothing, when the stream fails after a frame went out, and counts frames as they go', async () => {
    const livekit = await joined();
    await livekit.publishAudioStream(pcm());
    const capture = (livekit as any).audioSource.captureFrame;
    // The lead-in silence, the first frame, then a failure
    capture.mockImplementationOnce(async () => {}).mockImplementationOnce(async () => {}).mockImplementationOnce(async () => {
      throw new Error('capture failed');
    });
    const progress = { frames: 0 };
    await expect(livekit.publishAudioStream(Buffer.alloc(4800 * 2 * 3), { progress })).resolves.toEqual({ played: 'partial', error: 'capture failed' });
    expect(progress.frames).toBe(1);
    // A capture that never returns: the count holds what went out before it
    capture.mockImplementationOnce(async () => {}).mockImplementationOnce(async () => {}).mockImplementationOnce(() => new Promise(() => {}));
    const hung = { frames: 0 };
    void livekit.publishAudioStream(Buffer.alloc(4800 * 2 * 3), { progress: hung });
    // 2 for the first playback, 3 for the failed one, 3 for this one (silence, a frame, the hung one)
    await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(2 + 3 + 3));
    expect(hung.frames).toBe(1);
  });

  it('reports nothing played, without rejecting, when the stream fails before any frame went out', async () => {
    const livekit = await joined();
    await livekit.publishAudioStream(pcm());
    (livekit as any).audioSource.captureFrame.mockImplementationOnce(async () => {
      throw new Error('capture failed');
    });
    await expect(livekit.publishAudioStream(pcm())).resolves.toEqual({ played: 'none', error: 'capture failed' });
  });
});

describe('AgentLiveKit and ffmpeg', () => {
  it("runs ffmpeg without the agent's environment", async () => {
    // A stand-in `ffmpeg` at the front of PATH: it writes down the environment it was given and
    // answers with four bytes of "PCM"
    const dir = mkdtempSync(path.join(tmpdir(), 'coo-ffmpeg-'));
    const seen = path.join(dir, 'environment');
    writeFileSync(path.join(dir, 'ffmpeg'), `#!/bin/sh\nenv > '${seen}'\ncat > /dev/null\nprintf 'abcd'\n`);
    chmodSync(path.join(dir, 'ffmpeg'), 0o755);
    const agentOnly = { ANTHROPIC_API_KEY: 'value-of-the-anthropic-key', ELIZA_SERVER_AUTH_TOKEN: 'value-of-the-api-token', POSTGRES_URL: 'value-of-the-database-url', HTTPS_PROXY: 'value-of-the-proxy' };
    for (const [name, value] of Object.entries(agentOnly)) vi.stubEnv(name, value);
    vi.stubEnv('PATH', `${dir}${path.delimiter}${process.env.PATH}`);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const mp3 = Buffer.from([0xff, 0xfb, 0x90, 0x00, 1, 2, 3, 4]);
      const pcm: Int16Array = await (new AgentLiveKit({}) as any).convertToPcm(mp3);

      expect(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString()).toBe('abcd');
      const environment = readFileSync(seen, 'utf8');
      expect(environment).toContain(`PATH=${dir}`);
      for (const [name, value] of Object.entries(agentOnly)) {
        expect(environment).not.toContain(name);
        expect(environment).not.toContain(value);
      }
    } finally {
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
