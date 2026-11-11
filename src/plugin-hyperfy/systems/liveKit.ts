import {
  AudioFrame,
  AudioSource,
  LocalAudioTrack,
  Room,
  TrackPublishOptions,
  TrackSource,
  RoomEvent,
  TrackKind,
  AudioStream
} from '@livekit/rtc-node';
import { System } from '../hyperfy/src/core/systems/System';
import { spawn } from 'node:child_process';
import { childEnv } from '../lib/child-env';
import { describeUrl } from '../lib/log-url';
import { worldNet } from '../lib/net-policy';
import type { Played } from '../lib/playback';

export interface LiveKitInitOptions {
  wsUrl: string;
  token: string;
}

export interface PublishAudioOptions {
  signal?: AbortSignal;
  /**
   * Asked right before the first frame of the audio, once it is decoded and its track published
   * (a reply that reports a privileged action: session/deliver-reply.ts). No: nothing is played.
   */
  admit?: () => boolean;
  /** Counts the frames of the audio the room took as they go out, so it holds also when the stream fails or hangs */
  progress?: { frames: number };
}

export type { Played };

/** What publishAudioStream did, and why not all of it played (`reason`, or the `error` it ended with). */
export interface PlaybackOutcome {
  played: Played;
  reason?: string;
  error?: string;
}

const FFMPEG_TIMEOUT_MS = 30_000;
// How long leaving a room waits for each native step (unpublish, close): a join waits for it
const RELEASE_STEP_TIMEOUT_MS = 5_000;

/** Waits for `step` to settle, at most RELEASE_STEP_TIMEOUT_MS; a failure is logged, never thrown. */
async function released(what: string, step: () => Promise<unknown> | undefined): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(step),
      new Promise((resolve) => {
        timer = setTimeout(() => {
          console.warn(`[LiveKit] Gave up ${what} after ${RELEASE_STEP_TIMEOUT_MS} ms`);
          resolve(undefined);
        }, RELEASE_STEP_TIMEOUT_MS);
      }),
    ]);
  } catch (error: any) {
    console.warn(`[LiveKit] Error while ${what}:`, error?.message || error);
  } finally {
    clearTimeout(timer);
  }
}

export class AgentLiveKit extends System {
  private room: Room | null = null;
  private audioSource: AudioSource | null = null;
  private localTrack: LocalAudioTrack | null = null;
  /** Bumped by every join and every teardown: a join that is no longer the latest stops */
  private joinId = 0;

  constructor(world: any) {
    super(world);
  }

  // Called by ClientNetwork without awaiting, so this must never reject.
  async deserialize(opts: LiveKitInitOptions): Promise<void> {
    if (!opts) {
      console.log('[LiveKit] No LiveKit options provided by server - voice chat not available');
      return;
    }
    const { wsUrl, token } = opts;
    // Taken before the first await: a teardown (disconnectRoom) or a later join from here on wins
    const join = ++this.joinId;
    await this.leaveRoom();
    // The world names the voice server: judged like the world's downloads before the native client
    // gets it (lib/net-policy.ts voiceUrlProblem)
    const problem = await worldNet(this.world).voiceUrlProblem(wsUrl);
    if (join !== this.joinId) return;
    if (problem) {
      console.warn(`[LiveKit] Voice chat off: the voice server ${describeUrl(wsUrl)} the world named is refused (${problem})`);
      return;
    }
    console.log('[LiveKit] Connecting to:', describeUrl(wsUrl));
    const room = new Room();
    this.room = room;
    try {
      await room.connect(wsUrl, token, {
        autoSubscribe: true,
        dynacast: true,
      });
    } catch (error: any) {
      console.error('[LiveKit] Failed to connect to room:', error?.message || error);
      if (this.room === room) this.room = null;
      return;
    }
    // Torn down or replaced while joining: disconnect() on a joining room is a no-op,
    // so the join has to be undone here or the connection lingers untracked.
    if (this.room !== room) {
      console.log('[LiveKit] Room superseded while connecting; leaving it');
      await room.disconnect().catch(() => { });
      return;
    }
    console.log('[LiveKit] Connected to room');
    this.setupRoomEvents(room);
  }

  /**
   * Leaves the current room, and stops a join in progress. Does not call rtc-node's dispose(),
   * which would shut down the native runtime and make later reconnects impossible.
   */
  async disconnectRoom(): Promise<void> {
    this.joinId++;
    await this.leaveRoom();
  }

  private async leaveRoom(): Promise<void> {
    const room = this.room;
    const track = this.localTrack;
    const source = this.audioSource;
    this.room = null;
    // The track and source belong to the old room's publication.
    this.audioSource = null;
    this.localTrack = null;
    // The agent's own voice track: unpublished from the room it is in, then closed with its
    // source. These are native objects; dropping the references does not free them.
    if (track) {
      const sid = track.sid;
      if (room && sid) await released('unpublishing the voice track', () => room.localParticipant?.unpublishTrack(sid));
      // Closes its audio source with it
      await released('closing the voice track', () => track.close());
    } else if (source) {
      await released('closing the audio source', () => source.close());
    }
    if (room) {
      try {
        await room.disconnect();
      } catch (error: any) {
        console.warn('[LiveKit] Error while disconnecting room:', error?.message || error);
      }
    }
  }

  // World.destroy() calls this on every system.
  destroy() {
    this.disconnectRoom().catch(() => { });
  }

  // nodes/Video.js calls these on mount and unmount. The agent shows no screen shares: no screen
  // is registered, and the video node falls back to its own source.
  registerScreenNode(_node: unknown): undefined {
    return undefined;
  }

  unregisterScreenNode(_node: unknown): void {}

  private setupRoomEvents(room: Room): void {
    room.on(RoomEvent.ParticipantConnected, (p) => {
      console.log(`[LiveKit] Participant connected: ${p.identity}`);
    });

    room.on(RoomEvent.Disconnected, () => {
      console.log('[LiveKit] Disconnected from room');
    });

    room.on(RoomEvent.TrackPublished, (publication, participant) => {
      console.log(`[LiveKit] TrackPublished by ${participant.identity}`);
    });

    room.on(RoomEvent.TrackSubscribed, async (track, _publication, participant) => {
      console.log(`[LiveKit] TrackSubscribed: ${track.kind} from ${participant.identity}`);
      if (track.kind === TrackKind.KIND_AUDIO) {
        const stream = new AudioStream(track);
        for await (const frame of stream) {
          if (!track.sid || this.room !== room) return;
          const int16 = frame.data;
          (this as any).emit('audio', {
            participant: participant.identity,
            buffer: Buffer.from(int16.buffer, int16.byteOffset, int16.byteLength),
          });
        }
      }
    });
  }

  // Framework stubs
  // init() {}
  preTick() { }
  preFixedUpdate() { }
  fixedUpdate() { }
  postFixedUpdate() { }
  preUpdate() { }
  update() { }
  postUpdate() { }
  lateUpdate() { }
  postLateUpdate() { }
  commit() { }
  postTick() { }
  start() { }

  /** Plays audio into the room. Never rejects: a failure ends the outcome with how much had played. */
  async publishAudioStream(audioBuffer: Buffer, { signal, progress = { frames: 0 }, admit }: PublishAudioOptions = {}): Promise<PlaybackOutcome> {
    const before = progress.frames;
    try {
      return await this.streamAudio(audioBuffer, signal, progress, admit);
    } catch (error: any) {
      const message = String(error?.message ?? error);
      console.warn('[LiveKit] Audio playback failed:', message);
      return { played: progress.frames > before ? 'partial' : 'none', error: message };
    }
  }

  private async streamAudio(audioBuffer: Buffer, signal: AbortSignal | undefined, progress: { frames: number }, admit?: () => boolean): Promise<PlaybackOutcome> {
    console.log('[LiveKit] publishAudioStream called with buffer size:', audioBuffer.length);
    if (!this.room) {
      console.warn('[LiveKit] Not connected to a room - skipping audio playback');
      return { played: 'none', reason: 'not connected to a voice room' };
    }
    const sampleRate = 48000;
    const numChannels = 1;
    const frameDurationMs = 100;
    const samplesPerFrame = (sampleRate * frameDurationMs) / 1000;

    console.log('[LiveKit] Converting to PCM...');
    const int16 = await this.convertToPcm(audioBuffer, sampleRate);
    if (int16 === null) {
      console.warn('[LiveKit] Not playing audio in a format that is neither MP3 nor WAV');
      return { played: 'none', reason: 'the audio is in no format the agent plays (MP3 or WAV)' };
    }
    if (int16.length === 0) {
      console.warn('[LiveKit] No PCM data decoded');
      return { played: 'none', reason: 'no audio was decoded' };
    }
    console.log('[LiveKit] PCM data decoded, samples:', int16.length);

    const room = this.room;
    if (!room) return { played: 'none', reason: 'the voice room went away' };
    if (signal?.aborted) return { played: 'none', reason: 'stopped' };

    if (!this.audioSource) {
      console.log('[LiveKit] Creating audio source and track...');
      const audioSource = new AudioSource(sampleRate, numChannels);
      const localTrack = LocalAudioTrack.createAudioTrack('agent-voice', audioSource);

      const options = new TrackPublishOptions();
      options.source = TrackSource.SOURCE_MICROPHONE;
      console.log('[LiveKit] Publishing track to room...');
      if (!room.localParticipant) return { played: 'none', reason: 'the voice room has no local participant' };
      await room.localParticipant.publishTrack(localTrack, options);
      if (this.room !== room) {
        // Nobody keeps it: closed here (the room it was published to is being left)
        await localTrack.close().catch(() => { });
        return { played: 'none', reason: 'the voice room went away' };
      }
      this.audioSource = audioSource;
      this.localTrack = localTrack;
      console.log('[LiveKit] Track published successfully');
    }
    const audioSource = this.audioSource;

    const silence = new Int16Array(samplesPerFrame);
    await audioSource.captureFrame(new AudioFrame(silence, sampleRate, numChannels, silence.length));
    // After everything that was awaited to get ready, right before the first frame of the audio
    if (admit && !admit()) return { played: 'none', reason: 'no longer admitted' };

    console.log('[LiveKit] Streaming audio frames...');
    const totalFrames = Math.ceil(int16.length / samplesPerFrame);
    const startTime = Date.now();
    let sent = 0;

    for (let i = 0; i < int16.length; i += samplesPerFrame) {
      if (signal?.aborted || this.room !== room) {
        console.warn('[LiveKit] Audio streaming stopped early');
        break;
      }
      const frameIndex = Math.floor(i / samplesPerFrame);
      const expectedTime = startTime + (frameIndex * frameDurationMs);
      const currentTime = Date.now();

      // Wait if we're ahead of schedule
      if (currentTime < expectedTime) {
        await new Promise(resolve => setTimeout(resolve, expectedTime - currentTime));
      }

      const slice = int16.slice(i, i + samplesPerFrame);
      const frame = new AudioFrame(slice, sampleRate, numChannels, slice.length);
      await audioSource.captureFrame(frame);
      sent++;
      progress.frames++;
    }

    const stoppedWhy = signal?.aborted ? 'stopped' : 'the voice room went away';
    if (sent === 0) return { played: 'none', reason: stoppedWhy };
    const actualDuration = Date.now() - startTime;
    console.log(`[LiveKit] Audio streaming complete (${sent} of ${totalFrames} frames, ${actualDuration}ms)`);
    return sent === totalFrames ? { played: 'all' } : { played: 'partial', reason: stoppedWhy };
  }

  /**
   * The audio as 16-bit mono PCM at `sampleRate`, decoded by ffmpeg, or null when it is neither
   * MP3 nor WAV by its first bytes: bytes in an unknown format are not played as if they were raw
   * PCM (that is noise at full volume, or speech at the wrong speed).
   */
  private async convertToPcm(buffer: Buffer, sampleRate = 48000): Promise<Int16Array | null> {
    const format = this.detectAudioFormat(buffer);
    console.log('[LiveKit] Detected audio format:', format ?? 'none recognised');
    if (format === null) return null;

    const ffmpegArgs: string[] = [
      '-f',
      format,
      '-i',
      'pipe:0',
      '-f',
      's16le',
      '-ar',
      sampleRate.toString(),
      '-ac',
      '1',
      'pipe:1',
    ];

    console.log('[LiveKit] Running ffmpeg to convert', format, 'to PCM...');
    return new Promise((resolve, reject) => {
      // Not the agent's environment, which holds API keys and tokens (lib/child-env.ts)
      const ff = spawn('ffmpeg', ffmpegArgs, { env: childEnv() });
      const chunks: Buffer[] = [];
      let stderrOutput = '';
      let settled = false;
      const finish = (error: Error | null, samples?: Int16Array) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(samples!);
      };
      const timer = setTimeout(() => {
        ff.kill('SIGKILL');
        finish(new Error(`ffmpeg timed out after ${FFMPEG_TIMEOUT_MS}ms`));
      }, FFMPEG_TIMEOUT_MS);

      ff.stdout.on('data', (chunk) => {
        chunks.push(chunk);
      });

      ff.stderr.on('data', (data) => {
        stderrOutput += data.toString();
      });

      ff.on('error', (err) => {
        console.error('[LiveKit] ffmpeg spawn error:', err.message);
        finish(err);
      });

      // Without this, ffmpeg exiting early (bad input) surfaces as an uncaught EPIPE.
      ff.stdin.on('error', (err) => {
        console.error('[LiveKit] ffmpeg stdin error:', err.message);
      });

      ff.on('close', (code) => {
        if (code !== 0) {
          console.error('[LiveKit] ffmpeg failed with code', code);
          console.error('[LiveKit] ffmpeg stderr:', stderrOutput);
          return finish(new Error(`ffmpeg failed (code ${code})`));
        }
        const raw = Buffer.concat(chunks);
        console.log('[LiveKit] ffmpeg conversion successful, output size:', raw.length);
        finish(null, toInt16Array(raw));
      });

      ff.stdin.write(buffer);
      ff.stdin.end();
    });
  }

  private detectAudioFormat(buffer: Buffer): 'mp3' | 'wav' | null {
    const header = buffer.slice(0, 4).toString('ascii');

    // Check for WAV (RIFF header)
    if (header === 'RIFF') return 'wav';

    // Check for MP3 frame sync (0xff followed by 0xe0-0xff)
    if (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) return 'mp3';

    // Check for ID3 tag (ID3v2 header at start of mp3)
    if (header.startsWith('ID3')) return 'mp3';

    // Check for MP3 frame sync elsewhere in first 10 bytes (some mp3s have metadata at start)
    for (let i = 0; i < Math.min(10, buffer.length - 1); i++) {
      if (buffer[i] === 0xff && (buffer[i + 1] & 0xe0) === 0xe0) {
        console.log('[LiveKit] Found MP3 frame sync at offset', i);
        return 'mp3';
      }
    }

    return null;
  }
}

// Int16Array needs an even byteOffset; Buffers from pools or concat may not have one.
function toInt16Array(buffer: Buffer): Int16Array {
  const length = Math.floor(buffer.byteLength / 2);
  if (buffer.byteOffset % 2 === 0) {
    return new Int16Array(buffer.buffer, buffer.byteOffset, length);
  }
  const copy = new Uint8Array(length * 2);
  copy.set(buffer.subarray(0, length * 2));
  return new Int16Array(copy.buffer);
}
