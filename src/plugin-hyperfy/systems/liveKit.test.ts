import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

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
    localParticipant = { publishTrack: vi.fn() };
    constructor() {
      rooms.push(this);
    }
    connect() {
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
    AudioSource: class {},
    LocalAudioTrack: { createAudioTrack: vi.fn() },
    TrackPublishOptions: class {},
    TrackSource: { SOURCE_MICROPHONE: 1 },
    RoomEvent: {},
    TrackKind: { KIND_AUDIO: 1 },
    AudioStream: class {},
  };
});

import { AgentLiveKit } from './liveKit';

const opts = { wsUrl: 'wss://lk.test', token: 't' };

describe('AgentLiveKit room lifecycle', () => {
  it('leaves a room whose join completes after teardown', async () => {
    rooms.length = 0;
    const livekit = new AgentLiveKit({});
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
    const livekit = new AgentLiveKit({});
    const first = livekit.deserialize(opts);
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

  it('skips playback when no room is connected', async () => {
    const livekit = new AgentLiveKit({});
    await expect(livekit.publishAudioStream(Buffer.alloc(4))).resolves.toBeUndefined();
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
