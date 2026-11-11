import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../service', () => ({ HyperfyService: { serviceType: 'hyperfy' } }));
vi.mock('../events', () => ({ hyperfyEventType: { VOICE_MESSAGE_RECEIVED: 'HYPERFY_VOICE_MESSAGE_RECEIVED' } }));
// The native client is never loaded here: a room that connects and takes frames
vi.mock('@livekit/rtc-node', () => ({
  Room: class {},
  AudioFrame: class {},
  AudioSource: class {},
  LocalAudioTrack: { createAudioTrack: vi.fn() },
  TrackPublishOptions: class {},
  TrackSource: { SOURCE_MICROPHONE: 1 },
  RoomEvent: {},
  TrackKind: { KIND_AUDIO: 1 },
  AudioStream: class {},
}));

import { MAX_HELD_VOICE_BYTES, MAX_SPEAKERS, MAX_SPOKEN_CODE_POINTS, MAX_UTTERANCE_BYTES, UTTERANCE_PAUSE_MS, VoiceManager, spokenPart } from './voice-manager';
import { UsageBudget, resetUsageBudget } from '../../usage-budget';
import { currentTurn, neverAbortedSignal, runTurn, turnDelivered } from '../lib/turn-context';
import { AgentLiveKit } from '../systems/liveKit';

const PLAYED = { played: 'all' } as const;

function setup(publishAudioStream: (...args: any[]) => Promise<unknown>) {
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
    const { manager, livekit, player } = setup((buf: Buffer, opts) => {
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
    const { manager } = setup((_buf, opts) => {
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

// 48 kHz 16-bit mono: 96 bytes per millisecond
const loud = (ms: number, amplitude = 5000) => {
  const frame = Buffer.alloc(ms * 96);
  for (let i = 0; i < frame.length; i += 2) frame.writeInt16LE(i % 4 === 0 ? amplitude : -amplitude, i);
  return frame;
};
const quiet = (ms: number) => loud(ms, 10);
const noLimits = { aiCallsPerHour: null, aiTokensPerDay: null, visionPerHour: null, ttsCharsPerDay: null, sttSecondsPerDay: null, autonomyAiPerHour: null, autonomyAiMinIntervalMs: 0 };

/**
 * A started VoiceManager fed through the listener it registered with LiveKit, the way
 * AgentLiveKit emits frames. Speech-to-text is `transcribe` (default: answers at once).
 */
function listening({
  transcribe = async (_wav: Buffer) => 'hello there',
  hasModel = true,
  limits = noLimits,
}: { transcribe?: (wav: Buffer) => Promise<unknown>; hasModel?: boolean; limits?: typeof noLimits | Record<string, number | null> } = {}) {
  const budget = new UsageBudget({ ...noLimits, ...limits } as any);
  resetUsageBudget(budget);
  const livekit = { on: vi.fn(), off: vi.fn(), publishAudioStream: vi.fn(async () => PLAYED) };
  const world = { livekit, entities: { player: { setSpeaking: vi.fn() } } };
  const sendMessage = vi.fn();
  const useModel = vi.fn((_type: string, wav: Buffer) => transcribe(wav));
  const runtime: any = {
    getService: () => ({ getWorld: () => world, getConnectionGeneration: () => 4, getMessageManager: () => ({ sendMessage }) }),
    getModel: vi.fn(() => (hasModel ? () => '' : undefined)),
    useModel,
  };
  const manager = new VoiceManager(runtime);
  const heard: { text: string; speaker: string; turn: any }[] = [];
  (manager as any).handleMessage = vi.fn(async (text: string, speaker: string) => void heard.push({ text, speaker, turn: currentTurn() }));
  manager.start();
  const emit = livekit.on.mock.calls.find(([event]) => event === 'audio')![1] as (data: unknown) => unknown;
  const say = (participant: string, buffer: Buffer) => emit({ participant, buffer });
  const state = () => ({ speakers: (manager as any).speakers.size, transcribing: (manager as any).transcribing.size, held: (manager as any).heldVoiceBytes });
  /** PCM seconds in each transcription request so far */
  const requests = () => useModel.mock.calls.map(([, wav]) => (wav.length - 44) / 96_000);
  return { manager, budget, runtime, useModel, emit, say, state, requests, heard, sendMessage, world };
}

describe('VoiceManager voice input', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    resetUsageBudget();
  });

  it("transcribes a speaker's utterance once, after 1.5 s of silence, as a voice turn for that player", async () => {
    const { say, useModel, heard, requests } = listening();
    say('p1', loud(100));
    say('p1', quiet(100));
    say('p1', loud(200));
    await vi.advanceTimersByTimeAsync(UTTERANCE_PAUSE_MS - 1);
    expect(useModel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(useModel).toHaveBeenCalledTimes(1);
    expect(useModel.mock.calls[0][0]).toBe('TRANSCRIPTION');
    // The quiet frame is not part of it
    expect(requests()).toEqual([0.3]);
    expect(useModel.mock.calls[0][1].subarray(0, 4).toString()).toBe('RIFF');
    expect(heard).toHaveLength(1);
    expect(heard[0]).toMatchObject({ text: 'hello there', speaker: 'p1', turn: { origin: 'voice', requesterId: 'p1', generation: 4 } });
  });

  it('transcribes two people who speak at the same time, each on their own', async () => {
    const { say, heard, requests } = listening({ transcribe: async (wav) => `${(wav.length - 44) / 96} ms` });
    for (let i = 0; i < 5; i++) {
      say('alice', loud(100));
      say('bob', loud(100));
    }
    for (let i = 0; i < 3; i++) say('bob', loud(100));
    await vi.advanceTimersByTimeAsync(UTTERANCE_PAUSE_MS);
    expect(requests().sort()).toEqual([0.5, 0.8]);
    expect(heard.map(({ text, speaker, turn }) => [speaker, text, turn.requesterId]).sort()).toEqual([
      ['alice', '500 ms', 'alice'],
      ['bob', '800 ms', 'bob'],
    ]);
  });

  it('keeps what a second person says while the first is still being transcribed', async () => {
    let finishAlice!: (text: string) => void;
    const { say, heard, useModel } = listening({
      transcribe: (wav) => (wav.length - 44 === 300 * 96 ? new Promise((resolve) => (finishAlice = resolve)) : Promise.resolve('bob speaking')),
    });
    say('alice', loud(300));
    await vi.advanceTimersByTimeAsync(UTTERANCE_PAUSE_MS);
    expect(useModel).toHaveBeenCalledTimes(1);
    // Alice's request is in flight; Bob starts and finishes his sentence meanwhile
    say('bob', loud(400));
    await vi.advanceTimersByTimeAsync(1000);
    say('bob', loud(100));
    await vi.advanceTimersByTimeAsync(UTTERANCE_PAUSE_MS);
    expect(heard.map(({ speaker, text }) => [speaker, text])).toEqual([['bob', 'bob speaking']]);
    finishAlice('alice speaking');
    await vi.advanceTimersByTimeAsync(0);
    expect(heard.map(({ speaker }) => speaker)).toEqual(['bob', 'alice']);
  });

  it("sends one request per speaker at a time: the next utterance waits for the previous one's transcription", async () => {
    const finish: ((text: string) => void)[] = [];
    const { say, useModel, heard, requests } = listening({ transcribe: () => new Promise((resolve) => finish.push(resolve)) });
    say('p1', loud(100));
    await vi.advanceTimersByTimeAsync(UTTERANCE_PAUSE_MS);
    say('p1', loud(200));
    await vi.advanceTimersByTimeAsync(UTTERANCE_PAUSE_MS * 3);
    expect(useModel).toHaveBeenCalledTimes(1);
    finish[0]('first');
    await vi.advanceTimersByTimeAsync(UTTERANCE_PAUSE_MS);
    expect(requests()).toEqual([0.1, 0.2]);
    finish[1]('second');
    await vi.advanceTimersByTimeAsync(0);
    expect(heard.map(({ text }) => text)).toEqual(['first', 'second']);
  });

  it('forgets a speaker once their utterance has been handled: nothing is kept for someone who left', async () => {
    const { say, state } = listening();
    say('p1', loud(500));
    say('p2', loud(500));
    expect(state()).toEqual({ speakers: 2, transcribing: 0, held: 2 * 500 * 96 });
    await vi.advanceTimersByTimeAsync(UTTERANCE_PAUSE_MS);
    expect(state()).toEqual({ speakers: 0, transcribing: 0, held: 0 });
  });

  it('transcribes a speaker who never pauses every 30 s: at most 30 s of them wait, plus the 30 s being transcribed', async () => {
    const { say, state, requests } = listening();
    for (let second = 0; second < 65; second++) {
      say('p1', loud(1000));
      // Right after a forced flush the flushed 30 s are still with speech-to-text
      expect(state().held).toBeLessThanOrEqual(MAX_UTTERANCE_BYTES + 96_000);
      await vi.advanceTimersByTimeAsync(1000);
      // ...and once it has answered, only what waits is held
      expect(state().held).toBeLessThanOrEqual(MAX_UTTERANCE_BYTES);
    }
    expect(requests()).toEqual([30, 30]);
    await vi.advanceTimersByTimeAsync(UTTERANCE_PAUSE_MS);
    expect(requests()).toEqual([30, 30, 5]);
  });

  it('holds at most four full utterances over all speakers; at the cap the longest is transcribed at once and frames are dropped', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Speech-to-text never answers: everything flushed stays held
    const { say, state, requests } = listening({ transcribe: () => new Promise(() => {}) });
    const speakers = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'];
    // 5 s between each one's frames is longer than a pause, so the frames come 1 s apart per speaker
    let firstDropAt: number | undefined;
    let firstRequestAt: number | undefined;
    for (let second = 0; second < 29; second++) {
      for (const [i, speaker] of speakers.entries()) say(speaker, loud(1000 - i));
      expect(state().held).toBeLessThanOrEqual(MAX_HELD_VOICE_BYTES);
      if (firstDropAt === undefined && warn.mock.calls.length > 0) firstDropAt = second;
      if (firstRequestAt === undefined && requests().length > 0) firstRequestAt = second;
      await vi.advanceTimersByTimeAsync(1000);
    }
    // The longest utterance went to speech-to-text the moment the cap was hit, not a pause later
    expect(firstDropAt).toBe(20);
    expect(firstRequestAt).toBe(firstDropAt);
    // 6 x 29 s would be 16.7 MB; the cap is 11.52 MB
    expect(state().held).toBeLessThanOrEqual(MAX_HELD_VOICE_BYTES);
    expect(state().held).toBeGreaterThan(MAX_HELD_VOICE_BYTES - 6 * 96_000);
    // No one paused, yet speakers were transcribed: forced by the cap, longest first
    expect(requests().length).toBeGreaterThan(0);
    expect(requests()[0]).toBeGreaterThan(19);
    const lines = warn.mock.calls.flat().map(String).filter((line) => line.includes('Dropped'));
    expect(lines[0]).toBe('[VoiceManager] Dropped 1 audio frame(s): the voice buffers are full');
    // 29 s of drops are reported in at most a line per 10 s
    expect(lines.length).toBeLessThanOrEqual(3);
  });

  it('listens to at most 8 people at once', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { say, state, heard } = listening();
    for (let i = 0; i < 12; i++) say(`p${i}`, loud(100));
    expect(state().speakers).toBe(MAX_SPEAKERS);
    await vi.advanceTimersByTimeAsync(UTTERANCE_PAUSE_MS);
    expect(heard.map(({ speaker }) => speaker).sort()).toEqual(['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7']);
  });

  it('keeps nothing when no speech-to-text model is registered', async () => {
    const { say, state, useModel } = listening({ hasModel: false });
    for (let i = 0; i < 50; i++) say('p1', loud(100));
    expect(state()).toEqual({ speakers: 0, transcribing: 0, held: 0 });
    await vi.advanceTimersByTimeAsync(UTTERANCE_PAUSE_MS * 2);
    expect(useModel).not.toHaveBeenCalled();
  });

  it('keeps nothing once the speech-to-text budget is used up, and says so in chat once', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const { say, state, useModel, budget, sendMessage } = listening({ limits: { sttSecondsPerDay: 0 } });
    for (let second = 0; second < 10; second++) {
      for (let i = 0; i < 10; i++) say('p1', loud(100));
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(state()).toEqual({ speakers: 0, transcribing: 0, held: 0 });
    expect(useModel).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    // Counted when the budget is looked up (every 2 s while someone speaks), not per frame
    expect(budget.snapshot(60_000).skipped.stt).toBe(5);
  });

  it('does not transcribe an utterance that is longer than what is left of the budget, and counts every transcribed second before the request', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const { say, useModel, budget, requests } = listening({ limits: { sttSecondsPerDay: 3 }, transcribe: () => new Promise(() => {}) });
    say('p1', loud(1000));
    say('p1', loud(1000));
    await vi.advanceTimersByTimeAsync(UTTERANCE_PAUSE_MS);
    // In flight, never answered: already counted
    expect(budget.snapshot(60_000).sttSeconds).toBe(2);
    say('p2', loud(1000));
    say('p2', loud(1000));
    await vi.advanceTimersByTimeAsync(UTTERANCE_PAUSE_MS);
    expect(useModel).toHaveBeenCalledTimes(1);
    expect(budget.snapshot(60_000).sttSeconds).toBe(2);
    say('p3', loud(1000));
    await vi.advanceTimersByTimeAsync(UTTERANCE_PAUSE_MS);
    expect(requests()).toEqual([2, 1]);
    expect(budget.snapshot(60_000).sttSeconds).toBe(3);
  });

  it('drops what people say while the agent itself is talking', async () => {
    const { manager, say, state, useModel } = listening();
    say('p1', loud(300));
    (manager as any).isSpeaking = true;
    say('p1', loud(300));
    say('p2', loud(300));
    expect(state()).toEqual({ speakers: 0, transcribing: 0, held: 0 });
    await vi.advanceTimersByTimeAsync(UTTERANCE_PAUSE_MS);
    expect(useModel).not.toHaveBeenCalled();
  });

  it.each([
    ['nothing', undefined],
    ['null', null],
    ['no buffer', { participant: 'p1' }],
    ['a buffer that is not one', { participant: 'p1', buffer: 'loud' }],
    ['a typed array that is not a Buffer', { participant: 'p1', buffer: new Uint8Array(960) }],
    ['a frame longer than a second', { participant: 'p1', buffer: loud(1001) }],
    ['a single byte', { participant: 'p1', buffer: Buffer.alloc(1, 0x7f) }],
    ['no participant', { buffer: loud(100) }],
    ['a participant that is not text', { participant: { toString: () => 'p1' }, buffer: loud(100) }],
    ['a participant id of 65 characters', { participant: 'p'.repeat(65), buffer: loud(100) }],
  ])('ignores a frame with %s without throwing or keeping anything', (_what, data) => {
    const { emit, state } = listening();
    expect(emit(data)).toBeUndefined();
    expect(state()).toEqual({ speakers: 0, transcribing: 0, held: 0 });
  });

  it('never leaves a rejected promise behind: a failing model lookup, a failing transcription and a failing turn are all contained', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const failing = listening({ transcribe: () => Promise.reject(new Error('speech-to-text is down')) });
      // The listener returns nothing to await
      expect(failing.say('p1', loud(300))).toBeUndefined();
      await vi.advanceTimersByTimeAsync(UTTERANCE_PAUSE_MS);
      expect(failing.state()).toEqual({ speakers: 0, transcribing: 0, held: 0 });

      const turnFails = listening();
      (turnFails.manager as any).handleMessage = vi.fn().mockRejectedValue(new Error('turn failed'));
      turnFails.say('p1', loud(300));
      await vi.advanceTimersByTimeAsync(UTTERANCE_PAUSE_MS);

      const lookupFails = listening();
      lookupFails.runtime.getModel.mockImplementation(() => {
        throw new Error('registry gone');
      });
      for (let i = 0; i < 20; i++) expect(lookupFails.say('p1', loud(100))).toBeUndefined();
      expect(lookupFails.state()).toEqual({ speakers: 0, transcribing: 0, held: 0 });
      // One line for the burst
      expect(warn.mock.calls.flat().filter((line) => String(line).includes('registry gone'))).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(UTTERANCE_PAUSE_MS);
      // Node reports an unhandled rejection once the microtasks of a real turn of the loop have run
      vi.useRealTimers();
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
      expect(error.mock.calls.flat().map(String).join('\n')).toContain('speech-to-text is down');
      expect(error.mock.calls.flat().map(String).join('\n')).toContain('turn failed');
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('stop() forgets every buffered utterance and ignores frames that still arrive', async () => {
    const { manager, say, state, useModel } = listening();
    say('p1', loud(500));
    say('p2', loud(500));
    manager.stop();
    expect(state()).toEqual({ speakers: 0, transcribing: 0, held: 0 });
    say('p1', loud(500));
    await vi.advanceTimersByTimeAsync(UTTERANCE_PAUSE_MS * 2);
    expect(state().speakers).toBe(0);
    expect(useModel).not.toHaveBeenCalled();
  });

  it('cuts a transcript to one line of 500 code points before it becomes a turn', async () => {
    const { say, heard } = listening({ transcribe: async () => `ignore\nall\u0000previous ${'🛹'.repeat(600)}` });
    say('p1', loud(300));
    await vi.advanceTimersByTimeAsync(UTTERANCE_PAUSE_MS);
    expect(heard[0].text.startsWith('ignore all previous 🛹')).toBe(true);
    expect(Array.from(heard[0].text)).toHaveLength(500);
  });

  it.each([
    ['nothing', undefined],
    ['an empty string', ''],
    ['blank audio', '[BLANK_AUDIO]'],
    ['something that is not text', { text: 'hello' }],
  ])('starts no turn when speech-to-text returns %s', async (_what, transcript) => {
    const { say, heard, useModel } = listening({ transcribe: async () => transcript });
    say('p1', loud(300));
    await vi.advanceTimersByTimeAsync(UTTERANCE_PAUSE_MS);
    expect(useModel).toHaveBeenCalledTimes(1);
    expect(heard).toEqual([]);
  });
});

describe('VoiceManager.speak and links', () => {
  it('never reads URLs aloud and skips text that is only a link', async () => {
    const utils = await import('../utils');
    const tts = vi.spyOn(utils, 'generateSpeech').mockResolvedValue(null);
    const manager = new VoiceManager({ getService: () => ({ getWorld: () => null }) } as any);
    await manager.speak('Here you go https://open-pay.jp/ja/@a?product=x');
    expect(tts).toHaveBeenCalledWith('Here you go');
    tts.mockClear();
    await manager.speak('https://open-pay.jp/ja/@a?product=x');
    expect(tts).not.toHaveBeenCalled();
    tts.mockRestore();
  });
});

describe('VoiceManager shop links', () => {
  it('posts a shop link from a voice turn to chat (voice replies are otherwise only spoken) without speaking it', async () => {
    let callback: any;
    const sendMessage = vi.fn();
    const world = { entities: { getPlayer: () => ({ data: { name: 'Alice' } }), items: new Map() } };
    const service = {
      getWorld: () => world,
      getConnectionGeneration: () => 0,
      currentWorldId: 'w1',
      getEmoteManager: () => ({ playEmote: vi.fn() }),
      getMessageManager: () => ({ sendMessage }),
    };
    const runtime: any = {
      agentId: 'agent',
      character: { name: 'Coo' },
      getService: () => service,
      ensureConnection: vi.fn(),
      createMemory: vi.fn(),
      emitEvent: vi.fn(async (_e: string, payload: any) => { callback = payload.callback; }),
    };
    const manager = new VoiceManager(runtime);
    const speak = vi.spyOn(manager, 'speak');
    await (manager as any).handleMessage('HoverBoardのリンクちょうだい', 'p1');
    const link = '🛒 HoverBoard — 505 JPYC\nhttps://open-pay.jp/ja/@a?product=x';
    await callback({ text: link, metadata: { openpayLink: true } });
    expect(sendMessage).toHaveBeenCalledWith(link);
    expect(speak).not.toHaveBeenCalled();
  });
});

describe('VoiceManager voice limits', () => {
  afterEach(() => resetUsageBudget());

  it('skips text-to-speech once the daily character limit is reached', async () => {
    const budget = new UsageBudget({
      aiCallsPerHour: null,
      aiTokensPerDay: null,
      visionPerHour: null,
      ttsCharsPerDay: 0,
      sttSecondsPerDay: null,
      autonomyAiPerHour: null,
      autonomyAiMinIntervalMs: 0,
    });
    resetUsageBudget(budget);
    const { manager, livekit } = setup(async () => {});
    await expect(manager.speak('Hello there')).resolves.toBe('none');
    expect(livekit.publishAudioStream).not.toHaveBeenCalled();
    expect(budget.snapshot(60_000).skipped.tts).toBe(1);
  });

  it('counts the characters before the request: of two replies spoken at once only the one that fits the daily limit is synthesized', async () => {
    const utils = await import('../utils');
    let finish!: (audio: Buffer) => void;
    const tts = vi.spyOn(utils, 'generateSpeech').mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    const budget = new UsageBudget({ ...noLimits, ttsCharsPerDay: 20 });
    resetUsageBudget(budget);
    const { manager } = setup(async () => PLAYED);
    const both = [manager.speak('Hello there!'), manager.speak('Hello again!')];
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(tts).toHaveBeenCalledTimes(1);
    expect(budget.snapshot(60_000)).toMatchObject({ ttsChars: 12, skipped: { tts: 1 } });
    finish(Buffer.from('audio'));
    expect(await Promise.all(both)).toEqual(['all', 'none']);
    tts.mockRestore();
  });

  it('keeps the characters of a failed synthesis counted', async () => {
    const utils = await import('../utils');
    const tts = vi.spyOn(utils, 'generateSpeech').mockRejectedValue(new Error('TTS down'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const budget = new UsageBudget({ ...noLimits, ttsCharsPerDay: 20 });
    resetUsageBudget(budget);
    const { manager } = setup(async () => PLAYED);
    await expect(manager.speak('Hello there!')).resolves.toBe('none');
    expect(budget.snapshot(60_000).ttsChars).toBe(12);
    await expect(manager.speak('Hello again!')).resolves.toBe('none');
    expect(tts).toHaveBeenCalledTimes(1);
    tts.mockRestore();
    vi.restoreAllMocks();
  });

  it('speaks at most 600 code points of a reply, up to a sentence end, and reports the reply as partly spoken', async () => {
    const utils = await import('../utils');
    const tts = vi.spyOn(utils, 'generateSpeech').mockResolvedValue(Buffer.from('audio'));
    const budget = new UsageBudget(noLimits);
    resetUsageBudget(budget);
    const { manager } = setup(async () => PLAYED);
    const sentence = 'This is one sentence of the reply. ';
    const reply = sentence.repeat(40);
    await expect(manager.speak(reply)).resolves.toBe('partial');
    const [spoken] = tts.mock.calls[0];
    expect(spoken).toBe(sentence.repeat(17).trimEnd());
    expect(spoken.length).toBeLessThanOrEqual(MAX_SPOKEN_CODE_POINTS);
    // Only what was sent is counted
    expect(budget.snapshot(60_000).ttsChars).toBe(spoken.length);
    // A reply within the cap is spoken whole
    await expect(manager.speak(sentence.repeat(17))).resolves.toBe('all');
    tts.mockRestore();
  });

  it('cuts speech at the cap itself when there is no sentence end, never through a surrogate pair', () => {
    expect(spokenPart('short')).toEqual({ text: 'short', cut: false });
    const cut = spokenPart('🛹'.repeat(700));
    expect(cut).toEqual({ text: '🛹'.repeat(MAX_SPOKEN_CODE_POINTS), cut: true });
    const japanese = spokenPart(`${'あ'.repeat(400)}。${'い'.repeat(400)}`);
    expect(japanese).toEqual({ text: `${'あ'.repeat(400)}。`, cut: true });
  });

  it('reports that nothing was spoken for empty text', async () => {
    const { manager } = setup(async () => {});
    await expect(manager.speak('https://only.a/link')).resolves.toBe('none');
  });
});

describe('VoiceManager delivery', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ['played', async () => PLAYED, 'all'],
    ['played in part (stopped early)', async () => ({ played: 'partial', reason: 'stopped' }), 'partial'],
    ['not connected to a room', async () => ({ played: 'none', reason: 'not connected to a voice room' }), 'none'],
    ['the room went away', async () => ({ played: 'none', reason: 'the voice room went away' }), 'none'],
    ['the room refused the stream before any frame', async () => {
      throw new Error('room gone');
    }, 'none'],
    ['the stream failed after some frames went out', async (_buf: Buffer, { progress }: { progress: { frames: number } }) => {
      progress.frames = 3;
      throw new Error('room gone');
    }, 'partial'],
  ])('counts an utterance as delivered for the turn only when some of it was played (%s)', async (_what, publish, played) => {
    const utils = await import('../utils');
    vi.spyOn(utils, 'generateSpeech').mockResolvedValue(Buffer.from('audio'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { manager } = setup(publish);
    const turn = { origin: 'voice' as const, requesterId: 'p1', world: {}, generation: 0, signal: neverAbortedSignal() };
    const result = await runTurn(turn, async () => [await manager.speak('Hello there'), turnDelivered(currentTurn())]);
    expect(result).toEqual([played, played !== 'none']);
  });

  it('reports a playback that hung until its timeout after some frames went out as partly played', async () => {
    vi.useFakeTimers();
    try {
      const utils = await import('../utils');
      vi.spyOn(utils, 'generateSpeech').mockResolvedValue(Buffer.from('audio'));
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { manager } = setup((_buf: Buffer, { progress }: { progress: { frames: number } }) => {
        progress.frames = 2;
        return new Promise(() => {});
      });
      const turn = { origin: 'voice' as const, requesterId: 'p1', world: {}, generation: 0, signal: neverAbortedSignal() };
      const result = runTurn(turn, async () => [await manager.speak('Hello there'), turnDelivered(currentTurn())]);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(await result).toEqual(['partial', true]);
    } finally {
      vi.useRealTimers();
    }
  });
});

it('does not count an utterance that could not be played because the world has no voice room', async () => {
  const utils = await import('../utils');
  vi.spyOn(utils, 'generateSpeech').mockResolvedValue(Buffer.from('audio'));
  const manager = new VoiceManager({ getService: () => ({ getWorld: () => ({ entities: {} }) }) } as any);
  const turn = { origin: 'voice' as const, requesterId: 'p1', world: {}, generation: 0, signal: neverAbortedSignal() };
  const result = await runTurn(turn, async () => [await manager.speak('Hello there'), turnDelivered(currentTurn())]);
  expect(result).toEqual(['none', false]);
  vi.restoreAllMocks();
});

describe('VoiceManager voice replies (the callback a voice turn answers through)', () => {
  afterEach(() => vi.restoreAllMocks());

  /** handleMessage with a real AgentLiveKit (no room unless `room`), on connection `generation` of `service` */
  async function voiceTurn({ livekit = new AgentLiveKit({}) as any } = {}) {
    let callback: any;
    const sendMessage = vi.fn();
    const playEmote = vi.fn();
    const world = { livekit, entities: { getPlayer: () => ({ data: { name: 'Alice' } }), items: new Map(), player: { setSpeaking: vi.fn() } } };
    const connection = { world: world as object, generation: 3 };
    const service = {
      getWorld: () => connection.world,
      getConnectionGeneration: () => connection.generation,
      currentWorldId: 'w1',
      getEmoteManager: () => ({ playEmote }),
      getMessageManager: () => ({ sendMessage }),
    };
    const runtime: any = {
      agentId: 'agent',
      character: { name: 'Coo' },
      getService: () => service,
      ensureConnection: vi.fn(),
      createMemory: vi.fn(async () => {}),
      emitEvent: vi.fn(async (_e: string, payload: any) => {
        callback = payload.callback;
      }),
    };
    const manager = new VoiceManager(runtime);
    const turn = { origin: 'voice' as const, requesterId: 'p1', world, generation: 3, signal: neverAbortedSignal() };
    await runTurn(turn, () => (manager as any).handleMessage('hello there', 'p1'));
    const reply = (text: string) => runTurn(turn, async () => [await callback({ text }), turnDelivered(currentTurn())]);
    return { manager, runtime, connection, sendMessage, playEmote, reply };
  }

  it("posts the reply as text when LiveKit played nothing (no room), and does not count it as spoken", async () => {
    const utils = await import('../utils');
    vi.spyOn(utils, 'generateSpeech').mockResolvedValue(Buffer.from('audio'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const { sendMessage, reply } = await voiceTurn();
    const [, delivered] = await reply('Hi Alice');
    expect(sendMessage).toHaveBeenCalledWith('Hi Alice');
    // Delivered as text (message-manager counts that one), not as speech
    expect(delivered).toBe(false);
  });

  it('posts the whole reply as text when only part of it was spoken before the playback failed, and counts it delivered', async () => {
    const utils = await import('../utils');
    vi.spyOn(utils, 'generateSpeech').mockResolvedValue(Buffer.from('audio'));
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const publishAudioStream = vi.fn(async (_buf: Buffer, { progress }: { progress: { frames: number } }) => {
      progress.frames = 1;
      throw new Error('capture failed');
    });
    const { sendMessage, reply } = await voiceTurn({ livekit: { publishAudioStream } });
    const [, delivered] = await reply('Hi Alice');
    expect(sendMessage).toHaveBeenCalledWith('Hi Alice');
    expect(delivered).toBe(true);
  });

  it('does not post the reply as text when it was played', async () => {
    const utils = await import('../utils');
    vi.spyOn(utils, 'generateSpeech').mockResolvedValue(Buffer.from('audio'));
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const { sendMessage, reply } = await voiceTurn({ livekit: { publishAudioStream: vi.fn(async () => PLAYED) } });
    const [, delivered] = await reply('Hi Alice');
    expect(sendMessage).not.toHaveBeenCalled();
    expect(delivered).toBe(true);
  });

  it.each([
    ['while the reply was stored', 'memory'],
    ['while it was being synthesized', 'speech'],
  ])('posts nothing to a replacement connection that came %s', async (_when, at) => {
    const utils = await import('../utils');
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const ctx = await voiceTurn();
    const reconnect = () => Object.assign(ctx.connection, { world: { entities: {} }, generation: 4 });
    vi.spyOn(utils, 'generateSpeech').mockImplementation(async () => {
      if (at === 'speech') reconnect();
      return null;
    });
    if (at === 'memory') ctx.runtime.createMemory.mockImplementation(async () => reconnect());
    await ctx.reply('Hi Alice');
    expect(ctx.sendMessage).not.toHaveBeenCalled();
    if (at === 'memory') expect(ctx.playEmote).not.toHaveBeenCalled();
  });

  it('posts nothing when the same world object comes back on a new connection generation', async () => {
    const utils = await import('../utils');
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const ctx = await voiceTurn();
    vi.spyOn(utils, 'generateSpeech').mockImplementation(async () => {
      ctx.connection.generation = 4;
      return null;
    });
    await ctx.reply('Hi Alice');
    expect(ctx.sendMessage).not.toHaveBeenCalled();
  });
});
