import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../service', () => ({ HyperfyService: { serviceType: 'hyperfy' } }));
vi.mock('../events', () => ({ hyperfyEventType: { VOICE_MESSAGE_RECEIVED: 'HYPERFY_VOICE_MESSAGE_RECEIVED' } }));

import { VoiceManager } from './voice-manager';

function setup(publishAudioStream: (...args: any[]) => Promise<void>) {
  const player = { setSpeaking: vi.fn() };
  const livekit = { publishAudioStream: vi.fn(publishAudioStream), on: vi.fn(), off: vi.fn() };
  const world = { livekit, entities: { player } };
  const runtime: any = { getService: () => ({ getWorld: () => world }) };
  return { manager: new VoiceManager(runtime), livekit, player };
}

const audio = (label: string) => Buffer.from(label);

describe('VoiceManager playback queue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('plays overlapping utterances in order instead of dropping them', async () => {
    const played: string[] = [];
    const { manager, livekit } = setup(async (buf: Buffer) => {
      await new Promise((r) => setTimeout(r, 1000));
      played.push(buf.toString());
    });

    const first = manager.playAudio(audio('first'));
    const second = manager.playAudio(audio('second'));
    await vi.advanceTimersByTimeAsync(2000);
    await Promise.all([first, second]);

    expect(played).toEqual(['first', 'second']);
    expect(livekit.publishAudioStream).toHaveBeenCalledTimes(2);
  });

  it('keeps playing after a failed utterance', async () => {
    const { manager, livekit } = setup(async (buf: Buffer) => {
      if (buf.toString() === 'bad') throw new Error('room gone');
    });

    await manager.playAudio(audio('bad'));
    await manager.playAudio(audio('good'));
    expect(livekit.publishAudioStream).toHaveBeenCalledTimes(2);
  });

  it('times out a hung playback, aborts it, and moves on', async () => {
    let signal: AbortSignal | undefined;
    const { manager, livekit, player } = setup((buf: Buffer, _lipSync, opts) => {
      if (buf.toString() === 'hang') {
        signal = opts?.signal;
        return new Promise(() => {});
      }
      return Promise.resolve();
    });

    const hung = manager.playAudio(audio('hang'));
    const next = manager.playAudio(audio('next'));
    await vi.advanceTimersByTimeAsync(120_000);
    await Promise.all([hung, next]);

    expect(signal?.aborted).toBe(true);
    expect(livekit.publishAudioStream).toHaveBeenCalledTimes(2);
    expect(player.setSpeaking).toHaveBeenLastCalledWith(false);
  });

  it('drops audio when too many utterances are queued', async () => {
    const { manager, livekit } = setup(() => new Promise((r) => setTimeout(r, 1000)));

    const pending = [1, 2, 3, 4].map((n) => manager.playAudio(audio(String(n))));
    await vi.advanceTimersByTimeAsync(5000);
    await Promise.all(pending);

    expect(livekit.publishAudioStream).toHaveBeenCalledTimes(3);
  });

  it('stop() discards queued playback', async () => {
    const { manager, livekit } = setup(() => new Promise((r) => setTimeout(r, 1000)));

    const first = manager.playAudio(audio('first'));
    const queued = manager.playAudio(audio('queued'));
    await vi.advanceTimersByTimeAsync(10);
    manager.stop();
    await vi.advanceTimersByTimeAsync(5000);
    await Promise.all([first, queued]);

    expect(livekit.publishAudioStream).toHaveBeenCalledTimes(1);
    // managers are per connection: a stopped one stays inert
    await manager.playAudio(audio('after'));
    expect(livekit.publishAudioStream).toHaveBeenCalledTimes(1);
  });

  it('stop() aborts the utterance that is currently playing', async () => {
    let signal: AbortSignal | undefined;
    const { manager } = setup((_buf, _lipSync, opts) => {
      signal = opts?.signal;
      return new Promise((r) => setTimeout(r, 10_000));
    });

    const playing = manager.playAudio(audio('long'));
    await vi.advanceTimersByTimeAsync(10);
    manager.stop();
    expect(signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    await playing;
  });
});

describe('VoiceManager.speak', () => {
  it('discards speech synthesized after stop()', async () => {
    const utils = await import('../utils');
    let finishTts!: (buf: Buffer) => void;
    const tts = vi.spyOn(utils, 'generateSpeech').mockImplementation(
      () => new Promise((resolve) => (finishTts = resolve))
    );
    const { manager, livekit } = setup(() => Promise.resolve());

    const speaking = manager.speak('hello');
    manager.stop();
    finishTts(audio('late'));
    await speaking;

    expect(livekit.publishAudioStream).not.toHaveBeenCalled();
    tts.mockRestore();
  });
});
