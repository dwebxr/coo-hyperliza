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
