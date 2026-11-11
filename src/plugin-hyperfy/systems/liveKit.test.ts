import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const rooms: any[] = [];
// The native voice tracks made (LocalAudioTrack.createAudioTrack), and what was done to each, in order
const tracks: any[] = [];
const released: string[] = [];
vi.mock('@livekit/rtc-node', () => {
  class Room {
    connected = false;
    resolveConnect!: () => void;
    rejectConnect!: (error: Error) => void;
    disconnect = vi.fn(async () => {
      // like the SDK: a no-op while the join is still pending
      this.connected = false;
      released.push('room left');
    });
    on = vi.fn();
    localParticipant = {
      publishTrack: vi.fn(async () => {}),
      unpublishTrack: vi.fn(async (sid: string) => void released.push(`unpublished ${sid}`)),
    };
    connectedTo: unknown[] = [];
    constructor() {
      rooms.push(this);
    }
    connect(...args: unknown[]) {
      this.connectedTo = args;
      return new Promise<void>((resolve, reject) => {
        this.resolveConnect = () => {
          this.connected = true;
          resolve();
        };
        this.rejectConnect = reject;
      });
    }
  }
  return {
    Room,
    // Keeps what it was made of, for the tests that look at what went out
    AudioFrame: class {
      constructor(readonly data: Int16Array, readonly sampleRate: number, readonly channels: number, readonly samplesPerChannel: number) {}
    },
    AudioSource: class {
      captureFrame = vi.fn(async () => {});
      close = vi.fn(async () => void released.push('source closed'));
    },
    LocalAudioTrack: {
      createAudioTrack: vi.fn((_name: string, source: any) => {
        const sid = `TR_${tracks.length + 1}`;
        // As the SDK's track: closing it closes its source
        const track = { sid, source, close: vi.fn(async () => (released.push(`closed ${sid}`), source.close())) };
        tracks.push(track);
        return track;
      }),
    },
    TrackPublishOptions: class {},
    TrackSource: { SOURCE_MICROPHONE: 1 },
    RoomEvent: { ParticipantConnected: 'participantConnected', Disconnected: 'disconnected', TrackPublished: 'trackPublished', TrackSubscribed: 'trackSubscribed' },
    TrackKind: { KIND_AUDIO: 1, KIND_VIDEO: 2 },
    // The frames of a remote track: whatever the test's track yields
    AudioStream: class {
      constructor(readonly track: { frames(): AsyncIterator<unknown> }) {}
      [Symbol.asyncIterator]() {
        return this.track.frames();
      }
    },
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

  it('a second deserialize replaces the first room: the first is left with no event wired, the second has each room event wired once', async () => {
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
    expect(rooms[0].disconnect).toHaveBeenCalled();
    expect(rooms[0].on).not.toHaveBeenCalled();
    expect(rooms[1].connected).toBe(true);
    expect(rooms[1].disconnect).not.toHaveBeenCalled();
    expect(rooms[1].on.mock.calls.map(([event]: [string]) => event).sort()).toEqual(['disconnected', 'participantConnected', 'trackPublished', 'trackSubscribed']);
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

describe('AgentLiveKit joins that come to nothing', () => {
  afterEach(() => vi.restoreAllMocks());

  // The engine's ClientNetwork calls deserialize without awaiting it
  it('never rejects: without options nothing is joined, and a join that fails leaves no room and no event wired', async () => {
    rooms.length = 0;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const livekit = new AgentLiveKit(worldOnLk());
    await expect(livekit.deserialize(undefined as never)).resolves.toBeUndefined();
    expect(rooms).toHaveLength(0);

    const joining = livekit.deserialize(opts);
    await vi.waitFor(() => expect(rooms).toHaveLength(1));
    rooms[0].rejectConnect(new Error('could not establish signal connection'));
    await expect(joining).resolves.toBeUndefined();
    expect(error.mock.calls.map((call) => call.join(' '))).toEqual(['[LiveKit] Failed to connect to room: could not establish signal connection']);
    expect(rooms[0].on).not.toHaveBeenCalled();
    // The room that could not be joined is not kept: there is nothing to play into
    await expect(livekit.publishAudioStream(Buffer.from([0xff, 0xfb, 0x90, 0x00, 0, 0]))).resolves.toEqual({ played: 'none', reason: 'not connected to a voice room' });
  });

  it('never rejects when something before the connection throws (the voice server check, the native room): it says so once', async () => {
    rooms.length = 0;
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const world = {};
    installWorldNet(world, { voiceUrlProblem: async () => { throw new Error('lookup failed'); } } as never);
    await expect(new AgentLiveKit(world).deserialize(opts)).resolves.toBeUndefined();
    expect(error.mock.calls.map((call) => call.join(' '))).toEqual(['[LiveKit] Voice chat off: joining the voice room failed: lookup failed']);
    expect(rooms).toHaveLength(0);
  });
});

describe('AgentLiveKit and the voice server the world names', () => {
  const quiet = () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    return vi.spyOn(console, 'warn').mockImplementation(() => {});
  };
  afterEach(() => vi.restoreAllMocks());

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
    const joining = new AgentLiveKit(world).deserialize({ wsUrl, token: 'secret-livekit-token' });
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    // No room is made after the refusal (a join would wait on it: checked before the join is awaited)
    expect(rooms).toHaveLength(0);
    await joining;
    expect(rooms).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0].join(' ')).toContain('Voice chat off');
    expect(warn.mock.calls[0].join(' ')).toContain(why);
    expect(warn.mock.calls[0].join(' ')).not.toContain('secret-livekit-token');
  });

  it("connects to the world's own host (by ws: on another port) and to wss: on a public host", async () => {
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
  });
});

/*
 * Playback takes encoded audio (MP3 or WAV by its first bytes) and has ffmpeg decode it. Here a
 * stand-in `ffmpeg` at the front of PATH gives back what follows the four header bytes, as PCM.
 */
describe('AgentLiveKit playback outcome', () => {
  const FRAME_BYTES = 4800 * 2;
  /** Encoded audio that decodes to `frames` frames of 100 ms */
  const mp3 = (frames = 1) => Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(FRAME_BYTES * frames)]);
  let dir = '';
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'coo-ffmpeg-'));
    // ...and writes down the input format it was told (`-f <format>`)
    writeFileSync(path.join(dir, 'ffmpeg'), `#!/bin/sh\necho "$2" >> '${path.join(dir, 'formats')}'\ntail -c +5\n`);
    chmodSync(path.join(dir, 'ffmpeg'), 0o755);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  async function joined() {
    rooms.length = 0;
    tracks.length = 0;
    released.length = 0;
    vi.stubEnv('PATH', `${dir}${path.delimiter}${process.env.PATH}`);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const livekit = new AgentLiveKit(worldOnLk());
    const joining = livekit.deserialize(opts);
    await vi.waitFor(() => expect(rooms).toHaveLength(1));
    rooms[0].resolveConnect();
    await joining;
    return livekit;
  }
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('reports nothing played when no room is connected', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(new AgentLiveKit({}).publishAudioStream(mp3())).resolves.toEqual({ played: 'none', reason: 'not connected to a voice room' });
  });

  it('reports played once audio went out to the room: one track published, the lead-in silence and the decoded frame captured', async () => {
    const livekit = await joined();
    const audio = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(FRAME_BYTES, 3)]);
    await expect(livekit.publishAudioStream(audio)).resolves.toEqual({ played: 'all' });
    expect(tracks).toHaveLength(1);
    expect(rooms[0].localParticipant.publishTrack).toHaveBeenCalledTimes(1);
    expect(rooms[0].localParticipant.publishTrack.mock.calls[0][0]).toBe(tracks[0]);
    const frames = tracks[0].source.captureFrame.mock.calls.map(([frame]: [{ data: Int16Array; sampleRate: number; channels: number }]) => frame);
    expect(frames.map((frame: { sampleRate: number; channels: number }) => [frame.sampleRate, frame.channels])).toEqual([[48000, 1], [48000, 1]]);
    // 100 ms of silence, then the 100 ms the stand-in ffmpeg decoded (every byte 3)
    expect(Array.from(new Set(frames[0].data))).toEqual([0]);
    expect(frames[1].data).toHaveLength(4800);
    expect(Array.from(new Set(frames[1].data))).toEqual([0x0303]);
  });

  it.each([
    ['raw 16-bit PCM', Buffer.alloc(FRAME_BYTES, 1)],
    ['bytes of no audio format', Buffer.from('<html><body>503 Service Unavailable</body></html>')],
    ['an Ogg file', Buffer.concat([Buffer.from('OggS'), Buffer.alloc(FRAME_BYTES)])],
    ['nothing', Buffer.alloc(0)],
  ])('does not play %s as if it were PCM: nothing goes out, and no track is published for it', async (_what, audio) => {
    const livekit = await joined();
    await expect(livekit.publishAudioStream(audio)).resolves.toEqual({ played: 'none', reason: 'the audio is in no format the agent plays (MP3 or WAV)' });
    expect(rooms[0].localParticipant.publishTrack).not.toHaveBeenCalled();
    expect(tracks).toEqual([]);
    // ...and a track there already takes no frame of it
    await livekit.publishAudioStream(mp3());
    const capture = (livekit as any).audioSource.captureFrame;
    const before = capture.mock.calls.length;
    await expect(livekit.publishAudioStream(audio)).resolves.toMatchObject({ played: 'none' });
    expect(capture.mock.calls.length).toBe(before);
  });

  it('takes MP3 (frame sync or ID3 tag) and WAV by their first bytes, and tells ffmpeg which it is', async () => {
    const livekit = await joined();
    writeFileSync(path.join(dir, 'formats'), '');
    for (const header of [[0xff, 0xfb, 0x90, 0x00], [0x49, 0x44, 0x33, 0x04], [0x52, 0x49, 0x46, 0x46]]) {
      await expect(livekit.publishAudioStream(Buffer.concat([Buffer.from(header), Buffer.alloc(FRAME_BYTES)]))).resolves.toEqual({ played: 'all' });
    }
    expect(readFileSync(path.join(dir, 'formats'), 'utf8').trim().split('\n')).toEqual(['mp3', 'mp3', 'wav']);
  });

  it('reports nothing played when stopped before the first frame, or when the room went away while the track was published', async () => {
    const livekit = await joined();
    const stopped = new AbortController();
    stopped.abort();
    await expect(livekit.publishAudioStream(mp3(), { signal: stopped.signal })).resolves.toEqual({ played: 'none', reason: 'stopped' });
    rooms[0].localParticipant.publishTrack.mockImplementation(async () => {
      await livekit.disconnectRoom();
    });
    await expect(livekit.publishAudioStream(mp3())).resolves.toEqual({ played: 'none', reason: 'the voice room went away' });
    // The track made for the room that went away is closed, with its source: nobody else holds it
    expect(tracks).toHaveLength(1);
    expect(tracks[0].close).toHaveBeenCalledTimes(1);
    expect(tracks[0].source.close).toHaveBeenCalledTimes(1);
  });

  it('reports nothing played when it was stopped before the first frame went out (during the lead-in silence)', async () => {
    const livekit = await joined();
    await livekit.publishAudioStream(mp3());
    const stop = new AbortController();
    (livekit as any).audioSource.captureFrame.mockImplementationOnce(async () => stop.abort());
    await expect(livekit.publishAudioStream(mp3(), { signal: stop.signal })).resolves.toEqual({ played: 'none', reason: 'stopped' });
  });

  it('plays nothing when asked so right before the first frame: after decoding and publishing the track', async () => {
    const livekit = await joined();
    let admitted = true;
    let decoded!: () => void;
    const decode = (livekit as any).convertToPcm.bind(livekit);
    vi.spyOn(livekit as any, 'convertToPcm').mockImplementationOnce(async (...args: unknown[]) => {
      await new Promise<void>((resolve) => (decoded = resolve));
      return decode(...args);
    });
    const playing = livekit.publishAudioStream(mp3(2), { admit: () => admitted });
    await vi.waitFor(() => expect(decoded).toBeDefined());
    admitted = false;
    decoded();
    await expect(playing).resolves.toEqual({ played: 'none', reason: 'no longer admitted' });
    // The lead-in silence went out, no frame of the audio did
    expect((livekit as any).audioSource.captureFrame).toHaveBeenCalledTimes(1);
  });

  describe('a privileged report through the real delivery and voice', () => {
    /** A voice turn delivering `content` over the real VoiceManager and this AgentLiveKit; posts and memories recorded */
    async function deliverOver(livekit: AgentLiveKit, content: any) {
      const { sessionFor } = await import('../test-support/session');
      const { deliverReply } = await import('../session/deliver-reply');
      const { currentTurn } = await import('../lib/turn-context');
      const world = { livekit, entities: { player: { setSpeaking: vi.fn() } } };
      const session = sessionFor(world);
      const posted: string[] = [];
      const stored: string[] = [];
      const delivery = await session.runTurn({ origin: 'voice', requesterId: 'p1' }, () =>
        deliverReply(
          {
            turn: currentTurn()!,
            session: { ended: false, emotes: { playEmote: () => {} }, messages: { sendMessage: async (text: string) => (posted.push(text), true) }, voice: session.voice },
            runtime: { agentId: '00000000-0000-0000-0000-0000000000aa' as any, createMemory: async (memory: any) => (stored.push(memory.content.text), 'id' as any) },
            roomId: '00000000-0000-0000-0000-0000000000bb' as any,
          },
          content
        )
      );
      return { delivery, posted, stored };
    }
    const REPORT = 'I moved the box up!';
    const NEUTRAL = 'I cannot go any further with that request.';

    it.each([
      ['while its audio is decoded', 'decode'],
      ['while its track is published', 'publish'],
    ])('says the neutral line instead when the requester loses the right %s', async (_when, step) => {
      const livekit = await joined();
      const { reportsPrivilegedAction } = await import('../lib/authorization');
      const utils = await import('../utils');
      // The report is three frames long, the neutral line one
      vi.spyOn(utils, 'generateSpeech').mockImplementation(async (text: string) => mp3(text === REPORT ? 3 : 1));
      let allowed = true;
      let ready!: () => void;
      const held = new Promise<void>((resolve) => (ready = resolve));
      if (step === 'decode') {
        const decode = (livekit as any).convertToPcm.bind(livekit);
        vi.spyOn(livekit as any, 'convertToPcm').mockImplementationOnce(async (...args: unknown[]) => {
          allowed = false;
          await held;
          return decode(...args);
        });
      } else {
        rooms[0].localParticipant.publishTrack.mockImplementationOnce(async () => {
          allowed = false;
          await held;
        });
      }
      const report = reportsPrivilegedAction({ text: REPORT } as any, { refusal: () => (allowed ? null : 'the requester is no longer a builder'), instead: { text: NEUTRAL } });
      const delivering = deliverOver(livekit, report);
      await new Promise((resolve) => setTimeout(resolve, 20));
      ready();
      const { delivery, posted, stored } = await delivering;
      expect(delivery).toMatchObject({ spoken: 'all', posted: false, stored: true });
      // Two lead-in silences and the neutral line's one frame: none of the report's three
      expect((livekit as any).audioSource.captureFrame).toHaveBeenCalledTimes(3);
      expect(posted).toEqual([]);
      expect(stored).toEqual([NEUTRAL]);
    });
  });

  it('reports nothing played, without rejecting, when ffmpeg fails or is not there: no track is published', async () => {
    const livekit = await joined();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const failing = mkdtempSync(path.join(tmpdir(), 'coo-ffmpeg-failing-'));
    const empty = mkdtempSync(path.join(tmpdir(), 'coo-ffmpeg-none-'));
    try {
      writeFileSync(path.join(failing, 'ffmpeg'), '#!/bin/sh\ncat > /dev/null\nexit 3\n');
      chmodSync(path.join(failing, 'ffmpeg'), 0o755);
      // /bin for the stand-in's `cat`
      vi.stubEnv('PATH', `${failing}${path.delimiter}/bin`);
      await expect(livekit.publishAudioStream(mp3())).resolves.toEqual({ played: 'none', error: 'ffmpeg failed (code 3)' });
      vi.stubEnv('PATH', empty);
      await expect(livekit.publishAudioStream(mp3())).resolves.toEqual({ played: 'none', error: expect.stringContaining('ENOENT') });
      expect(tracks).toEqual([]);
      expect(rooms[0].localParticipant.publishTrack).not.toHaveBeenCalled();
    } finally {
      rmSync(failing, { recursive: true, force: true });
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('reports nothing played for audio that decodes to nothing', async () => {
    const livekit = await joined();
    await expect(livekit.publishAudioStream(mp3(0))).resolves.toEqual({ played: 'none', reason: 'no audio was decoded' });
  });

  it('reports partly played, never nothing, when the stream fails after a frame went out, and counts frames as they go', async () => {
    const livekit = await joined();
    await livekit.publishAudioStream(mp3());
    const capture = (livekit as any).audioSource.captureFrame;
    // The lead-in silence, the first frame, then a failure
    capture.mockImplementationOnce(async () => {}).mockImplementationOnce(async () => {}).mockImplementationOnce(async () => {
      throw new Error('capture failed');
    });
    const progress = { frames: 0 };
    await expect(livekit.publishAudioStream(mp3(3), { progress })).resolves.toEqual({ played: 'partial', error: 'capture failed' });
    expect(progress.frames).toBe(1);
    // A capture that never returns: the count holds what went out before it
    capture.mockImplementationOnce(async () => {}).mockImplementationOnce(async () => {}).mockImplementationOnce(() => new Promise(() => {}));
    const hung = { frames: 0 };
    void livekit.publishAudioStream(mp3(3), { progress: hung });
    // 2 for the first playback, 3 for the failed one, 3 for this one (silence, a frame, the hung one)
    await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(2 + 3 + 3));
    expect(hung.frames).toBe(1);
  });

  it('reports nothing played, without rejecting, when the stream fails before any frame went out', async () => {
    const livekit = await joined();
    await livekit.publishAudioStream(mp3());
    (livekit as any).audioSource.captureFrame.mockImplementationOnce(async () => {
      throw new Error('capture failed');
    });
    await expect(livekit.publishAudioStream(mp3())).resolves.toEqual({ played: 'none', error: 'capture failed' });
  });

  describe("the agent's own voice track when its room is left", () => {
    it.each([
      ['a disconnect', (livekit: AgentLiveKit) => livekit.disconnectRoom()],
      ['the world being destroyed', async (livekit: AgentLiveKit) => {
        livekit.destroy();
        await vi.waitFor(() => expect(released).toContain('room left'));
      }],
    ])('is unpublished from that room and closed with its source, before the room is left (%s)', async (_what, leave) => {
      const livekit = await joined();
      await livekit.publishAudioStream(mp3());
      expect(tracks).toHaveLength(1);
      released.length = 0;
      await leave(livekit);
      expect(released).toEqual(['unpublished TR_1', 'closed TR_1', 'source closed', 'room left']);
      expect(rooms[0].localParticipant.unpublishTrack).toHaveBeenCalledWith('TR_1');
    });

    it('is released when a new join replaces the room, and the new room gets a track of its own', async () => {
      const livekit = await joined();
      await livekit.publishAudioStream(mp3());
      released.length = 0;
      const rejoining = livekit.deserialize(opts);
      await vi.waitFor(() => expect(rooms).toHaveLength(2));
      rooms[1].resolveConnect();
      await rejoining;
      expect(released).toEqual(['unpublished TR_1', 'closed TR_1', 'source closed', 'room left']);
      await expect(livekit.publishAudioStream(mp3())).resolves.toEqual({ played: 'all' });
      expect(tracks).toHaveLength(2);
      expect(tracks[1].close).not.toHaveBeenCalled();
    });

    it('leaving goes on when the native unpublish or close fails or never returns', async () => {
      const livekit = await joined();
      await livekit.publishAudioStream(mp3());
      released.length = 0;
      rooms[0].localParticipant.unpublishTrack.mockImplementation(() => new Promise(() => {}));
      tracks[0].close.mockRejectedValue(new Error('handle already disposed'));
      vi.useFakeTimers();
      try {
        const leaving = livekit.disconnectRoom();
        await vi.advanceTimersByTimeAsync(5_000);
        await leaving;
      } finally {
        vi.useRealTimers();
      }
      expect(tracks[0].close).toHaveBeenCalledTimes(1);
      expect(released).toEqual(['room left']);
      // Nothing of the old room is used again
      await expect(livekit.publishAudioStream(mp3())).resolves.toEqual({ played: 'none', reason: 'not connected to a voice room' });
    });
  });
});

/*
 * What the room's other participants say: the frames of a subscribed audio track, handed on as
 * 'audio' events (the voice manager listens for them).
 */
describe('AgentLiveKit and the audio of other participants', () => {
  afterEach(() => vi.restoreAllMocks());

  /** A joined AgentLiveKit, what it emitted as 'audio', and the handler it wired for subscribed tracks */
  async function listening() {
    rooms.length = 0;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const livekit = new AgentLiveKit(worldOnLk());
    const joining = livekit.deserialize(opts);
    await vi.waitFor(() => expect(rooms).toHaveLength(1));
    rooms[0].resolveConnect();
    await joining;
    const heard: { participant: string; buffer: Buffer }[] = [];
    (livekit as any).on('audio', (data: { participant: string; buffer: Buffer }) => heard.push(data));
    const subscribed: (track: unknown, publication: unknown, participant: { identity: string }) => Promise<void> = rooms[0].on.mock.calls.find(([event]: [string]) => event === 'trackSubscribed')[1];
    return { livekit, heard, subscribed };
  }

  it("emits each frame of a subscribed audio track with its participant's identity, and nothing for a video track", async () => {
    const { heard, subscribed } = await listening();
    const first = new Int16Array([1, -2, 3]);
    const second = new Int16Array([4, 5]);
    await subscribed({ kind: 1, sid: 'TR_alice', async *frames() { yield { data: first }; yield { data: second }; } }, {}, { identity: 'alice' });
    expect(heard).toEqual([
      { participant: 'alice', buffer: Buffer.from(first.buffer) },
      { participant: 'alice', buffer: Buffer.from(second.buffer) },
    ]);
    const video = vi.fn();
    await subscribed({ kind: 2, sid: 'TR_video', frames: video }, {}, { identity: 'bob' });
    expect(video).not.toHaveBeenCalled();
    expect(heard).toHaveLength(2);
  });

  it('goes on with the frames when a listener throws on one, saying so once for the track; a stream that fails ends there, said once, without rejecting', async () => {
    const { livekit, heard, subscribed } = await listening();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    (livekit as any).on('audio', () => {
      throw new Error('handler broke');
    });
    const frame = { data: new Int16Array([1, 2]) };
    await expect(subscribed({ kind: 1, sid: 'TR_alice', async *frames() { yield frame; yield frame; yield frame; } }, {}, { identity: 'alice' })).resolves.toBeUndefined();
    // The listener before the throwing one heard every frame
    expect(heard).toHaveLength(3);
    expect(error.mock.calls.map((call) => call.join(' '))).toEqual(['[LiveKit] Handling the audio of alice failed (further failures on this track are not logged): handler broke']);
    error.mockClear();
    await expect(subscribed({ kind: 1, sid: 'TR_bob', async *frames() { yield frame; throw new Error('stream broke'); } }, {}, { identity: 'bob' })).resolves.toBeUndefined();
    expect(error.mock.calls.map((call) => call.join(' '))).toEqual([
      '[LiveKit] Handling the audio of bob failed (further failures on this track are not logged): handler broke',
      '[LiveKit] The audio track of bob ended with an error: stream broke',
    ]);
  });

  it('emits no frame of a room that was left, also when its track goes on yielding', async () => {
    const { livekit, heard, subscribed } = await listening();
    let more!: () => void;
    const held = new Promise<void>((resolve) => (more = resolve));
    const frame = { data: new Int16Array([7, 8]) };
    const done = subscribed({ kind: 1, sid: 'TR_alice', async *frames() { yield frame; await held; yield frame; yield frame; } }, {}, { identity: 'alice' });
    await vi.waitFor(() => expect(heard).toHaveLength(1));
    await livekit.disconnectRoom();
    more();
    await done;
    expect(heard).toHaveLength(1);
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
