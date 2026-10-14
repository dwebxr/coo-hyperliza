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

export interface LiveKitInitOptions {
  wsUrl: string;
  token: string;
}

export interface PublishAudioOptions {
  signal?: AbortSignal;
}

const FFMPEG_TIMEOUT_MS = 30_000;

export class AgentLiveKit extends System {
  private room: Room | null = null;
  private audioSource: AudioSource | null = null;
  private localTrack: LocalAudioTrack | null = null;

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
    console.log('[LiveKit] Connecting to:', wsUrl);
    await this.disconnectRoom();
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
   * Leaves the current room. Does not call rtc-node's dispose(), which would
   * shut down the native runtime and make later reconnects impossible.
   */
  async disconnectRoom(): Promise<void> {
    const room = this.room;
    this.room = null;
    // The track and source belong to the old room's publication.
    this.audioSource = null;
    this.localTrack = null;
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

  async publishAudioStream(audioBuffer: Buffer, { signal }: PublishAudioOptions = {}): Promise<void> {
    console.log('[LiveKit] publishAudioStream called with buffer size:', audioBuffer.length);
    if (!this.room) {
      console.warn('[LiveKit] Not connected to a room - skipping audio playback');
      return;
    }
    const sampleRate = 48000;
    const numChannels = 1;
    const frameDurationMs = 100;
    const samplesPerFrame = (sampleRate * frameDurationMs) / 1000;

    console.log('[LiveKit] Converting to PCM...');
    const int16 = await this.convertToPcm(audioBuffer, sampleRate);
    if (!int16 || int16.length === 0) {
      console.warn('[LiveKit] No PCM data decoded');
      return;
    }
    console.log('[LiveKit] PCM data decoded, samples:', int16.length);

    const room = this.room;
    if (!room || signal?.aborted) return;

    if (!this.audioSource) {
      console.log('[LiveKit] Creating audio source and track...');
      const audioSource = new AudioSource(sampleRate, numChannels);
      const localTrack = LocalAudioTrack.createAudioTrack('agent-voice', audioSource);

      const options = new TrackPublishOptions();
      options.source = TrackSource.SOURCE_MICROPHONE;
      console.log('[LiveKit] Publishing track to room...');
      await room.localParticipant.publishTrack(localTrack, options);
      if (this.room !== room) return;
      this.audioSource = audioSource;
      this.localTrack = localTrack;
      console.log('[LiveKit] Track published successfully');
    }
    const audioSource = this.audioSource;

    const silence = new Int16Array(samplesPerFrame);
    await audioSource.captureFrame(new AudioFrame(silence, sampleRate, numChannels, silence.length));

    console.log('[LiveKit] Streaming audio frames...');
    const totalFrames = Math.ceil(int16.length / samplesPerFrame);
    const startTime = Date.now();

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
    }

    const actualDuration = Date.now() - startTime;
    console.log(`[LiveKit] Audio streaming complete (${totalFrames} frames, ${actualDuration}ms)`);
  }

  private async convertToPcm(buffer: Buffer, sampleRate = 48000): Promise<Int16Array> {
    const format = this.detectAudioFormat(buffer);
    console.log('[LiveKit] Detected audio format:', format);

    if (format === 'pcm') {
      console.log('[LiveKit] Already PCM, no conversion needed');
      return toInt16Array(buffer);
    }

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
      const ff = spawn('ffmpeg', ffmpegArgs);
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

  private detectAudioFormat(buffer: Buffer): 'mp3' | 'wav' | 'pcm' {
    const header = buffer.slice(0, 4).toString('ascii');
    console.log('[LiveKit] Buffer header bytes:', buffer.slice(0, 10).toString('hex'));

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

    console.log('[LiveKit] Format detection fallback to pcm');
    return 'pcm';
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
