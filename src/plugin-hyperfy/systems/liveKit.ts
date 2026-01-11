import {
  AudioFrame,
  AudioSource,
  LocalAudioTrack,
  Room,
  TrackPublishOptions,
  TrackSource,
  dispose,
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

export class AgentLiveKit extends System {
  private room: Room | null = null;
  private audioSource: AudioSource | null = null;
  private localTrack: LocalAudioTrack | null = null;

  constructor(world: any) {
    super(world);
  }

  async deserialize(opts: LiveKitInitOptions): Promise<void> {
    console.log('[LiveKit] deserialize called with opts:', opts);
    if (!opts) {
      console.log('[LiveKit] No LiveKit options provided by server - voice chat not available');
      return;
    }
    const { wsUrl, token } = opts;
    console.log('[LiveKit] Connecting to:', wsUrl);
    this.room = new Room();
    await this.room.connect(wsUrl, token, {
      autoSubscribe: true,
      dynacast: true,
    });
    console.log('[LiveKit] Connected to room');
    this.setupRoomEvents();
  }

  async stop(): Promise<void> {
    if (this.room) {
      await this.room.disconnect();
    }
    await dispose();
  }

  private setupRoomEvents(): void {
    if (!this.room) return;

    this.room.on(RoomEvent.ParticipantConnected, (p) => {
      console.log(`[LiveKit] Participant connected: ${p.identity}`);
    });

    this.room.on(RoomEvent.Disconnected, () => {
      console.log('[LiveKit] Disconnected from room');
    });

    this.room.on(RoomEvent.TrackPublished, (publication, participant) => {
      console.log(`[LiveKit] TrackPublished by ${participant.identity}`);
    });

    this.room.on(RoomEvent.TrackSubscribed, async (track, _publication, participant) => {
      console.log(`[LiveKit] TrackSubscribed: ${track.kind} from ${participant.identity}`);
      if (track.kind === TrackKind.KIND_AUDIO) {
        const stream = new AudioStream(track);
        for await (const frame of stream) {
          if (!track.sid) return;
          const int16 = frame.data;
          (this as any).emit('audio', {
            participant: participant.identity,
            buffer: Buffer.from(int16.buffer),
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

  async publishAudioStream(audioBuffer: Buffer): Promise<void> {
    console.log('[LiveKit] publishAudioStream called with buffer size:', audioBuffer.length);
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

    if (!this.audioSource) {
      console.log('[LiveKit] Creating audio source and track...');
      this.audioSource = new AudioSource(sampleRate, numChannels);
      this.localTrack = LocalAudioTrack.createAudioTrack('agent-voice', this.audioSource);

      const options = new TrackPublishOptions();
      options.source = TrackSource.SOURCE_MICROPHONE;
      console.log('[LiveKit] Publishing track to room...');
      await this.room?.localParticipant.publishTrack(this.localTrack, options);
      console.log('[LiveKit] Track published successfully');
    }

    const silence = new Int16Array(samplesPerFrame);
    await this.audioSource.captureFrame(new AudioFrame(silence, sampleRate, numChannels, silence.length));

    console.log('[LiveKit] Streaming audio frames...');
    const totalFrames = Math.ceil(int16.length / samplesPerFrame);
    const startTime = Date.now();

    for (let i = 0; i < int16.length; i += samplesPerFrame) {
      const frameIndex = Math.floor(i / samplesPerFrame);
      const expectedTime = startTime + (frameIndex * frameDurationMs);
      const currentTime = Date.now();

      // Wait if we're ahead of schedule
      if (currentTime < expectedTime) {
        await new Promise(resolve => setTimeout(resolve, expectedTime - currentTime));
      }

      const slice = int16.slice(i, i + samplesPerFrame);
      const frame = new AudioFrame(slice, sampleRate, numChannels, slice.length);
      await this.audioSource.captureFrame(frame);
    }

    const actualDuration = Date.now() - startTime;
    console.log(`[LiveKit] Audio streaming complete (${totalFrames} frames, ${actualDuration}ms)`);
  }

  private async convertToPcm(buffer: Buffer, sampleRate = 48000): Promise<Int16Array> {
    const format = this.detectAudioFormat(buffer);
    console.log('[LiveKit] Detected audio format:', format);

    if (format === 'pcm') {
      console.log('[LiveKit] Already PCM, no conversion needed');
      return new Int16Array(buffer.buffer, buffer.byteOffset, buffer.length / 2);
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
      let raw = Buffer.alloc(0);
      let stderrOutput = '';

      ff.stdout.on('data', (chunk) => {
        raw = Buffer.concat([raw, chunk]);
      });

      ff.stderr.on('data', (data) => {
        stderrOutput += data.toString();
      });

      ff.on('error', (err) => {
        console.error('[LiveKit] ffmpeg spawn error:', err.message);
        reject(err);
      });

      ff.on('close', (code) => {
        if (code !== 0) {
          console.error('[LiveKit] ffmpeg failed with code', code);
          console.error('[LiveKit] ffmpeg stderr:', stderrOutput);
          return reject(new Error(`ffmpeg failed (code ${code})`));
        }
        console.log('[LiveKit] ffmpeg conversion successful, output size:', raw.length);
        const samples = new Int16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
        resolve(samples);
      });

      ff.stdin.write(buffer);
      ff.stdin.end();
    });
  }

  private detectAudioFormat(buffer: Buffer): 'mp3' | 'wav' | 'pcm' {
    const header = buffer.slice(0, 4).toString('ascii');
    if (header === 'RIFF') return 'wav';
    if (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) return 'mp3';
    return 'pcm';
  }
}