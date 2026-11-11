import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

import { MAX_CONCURRENT_TRANSCRIPTIONS, MAX_HELD_VOICE_BYTES, MAX_SPEAKERS, MAX_SPOKEN_CODE_POINTS, MAX_UTTERANCE_BYTES, MIN_UTTERANCE_BYTES, UTTERANCE_PAUSE_MS, spokenPart } from './voice-manager';
import { installWorldChat } from '../lib/world-chat';
import { sessionFor, sessionRuntime, withParts } from '../test-support/session';
import { Events } from '../hyperfy/src/core/systems/Events.js';
import { UsageBudget, resetUsageBudget } from '../../usage-budget';
import { currentTurn, turnDelivered } from '../lib/turn-context';
import { AgentLiveKit } from '../systems/liveKit';
import { deliverReply } from '../session/deliver-reply';
import { reportsPrivilegedAction } from '../lib/authorization';

const PLAYED = { played: 'all' } as const;

function setup(publishAudioStream: (...args: any[]) => Promise<unknown>) {
  const player = { setSpeaking: vi.fn() };
  const livekit = { publishAudioStream: vi.fn(publishAudioStream), on: vi.fn(), off: vi.fn() };
  const world = { livekit, entities: { player } };
  const session = sessionFor(world);
  return { manager: session.voice, session, livekit, player };
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

describe('VoiceManager.speak and the turn it speaks for', () => {
  afterEach(() => vi.restoreAllMocks());

  it('does not play an utterance whose turn was cancelled while it waited behind another one, and lets the one playing finish', async () => {
    const utils = await import('../utils');
    vi.spyOn(utils, 'generateSpeech').mockImplementation(async (text: string) => Buffer.from(text));
    let finishFirst!: () => void;
    const { manager, session, livekit } = setup((buf: Buffer) => (buf.toString() === 'First reply' ? new Promise<unknown>((resolve) => (finishFirst = () => resolve(PLAYED))) : Promise.resolve(PLAYED)));
    const slot = new AbortController();
    const first = session.runTurn({ origin: 'chat', requesterId: 'p1' }, () => manager.speak('First reply'));
    await vi.waitFor(() => expect(livekit.publishAudioStream).toHaveBeenCalledTimes(1));
    // The second turn's reply is synthesized and waits for the first to finish playing
    const second = session.runTurn({ origin: 'chat', requesterId: 'p2', cancel: slot.signal }, () => manager.speak('Second reply'));
    await new Promise((resolve) => setTimeout(resolve, 5));
    slot.abort();
    finishFirst();
    expect(await first).toBe('all');
    expect(await second).toBe('none');
    expect(livekit.publishAudioStream.mock.calls.map(([buf]) => buf.toString())).toEqual(['First reply']);
    // The queue is not stuck: the next live utterance plays
    expect(await session.runTurn({ origin: 'chat', requesterId: 'p3' }, () => manager.speak('Third reply'))).toBe('all');
  });

  it('does not play an utterance whose turn was cancelled while it was being synthesized', async () => {
    const utils = await import('../utils');
    const slot = new AbortController();
    vi.spyOn(utils, 'generateSpeech').mockImplementation(async (text: string) => {
      slot.abort();
      return Buffer.from(text);
    });
    const { manager, session, livekit } = setup(async () => PLAYED);
    expect(await session.runTurn({ origin: 'voice', requesterId: 'p1', cancel: slot.signal }, () => manager.speak('Too late'))).toBe('none');
    expect(livekit.publishAudioStream).not.toHaveBeenCalled();
  });
});

describe('a voice reply through the real delivery and voice', () => {
  afterEach(() => vi.restoreAllMocks());

  /** deliverReply for a voice turn over the real VoiceManager; posts and memories are recorded */
  function delivering(publishAudioStream: (...args: any[]) => Promise<unknown> = async () => PLAYED) {
    const { manager, session, livekit } = setup(publishAudioStream);
    const posted: string[] = [];
    const stored: string[] = [];
    const deliver = (content: any, cancel?: AbortSignal) =>
      session.runTurn({ origin: 'voice', requesterId: 'p1', cancel }, () =>
        deliverReply(
          {
            turn: currentTurn()!,
            session: { ended: false, emotes: { playEmote: () => {} }, messages: { sendMessage: async (text: string) => (posted.push(text), true) }, voice: manager },
            runtime: { agentId: '00000000-0000-0000-0000-0000000000aa' as any, createMemory: async (memory: any) => (stored.push(memory.content.text), 'id' as any) },
            roomId: '00000000-0000-0000-0000-0000000000bb' as any,
          },
          content
        )
      );
    const played = () => livekit.publishAudioStream.mock.calls.map(([buf]) => buf.toString());
    return { manager, deliver, posted, stored, played, livekit };
  }

  it('plays, posts and stores the neutral line, and none of the report, when the requester loses the right while the report is synthesized', async () => {
    const utils = await import('../utils');
    let finishSynthesis: (() => void) | undefined;
    vi.spyOn(utils, 'generateSpeech').mockImplementation((text: string) =>
      text.includes('moved') ? new Promise((resolve) => (finishSynthesis = () => resolve(Buffer.from(text)))) : Promise.resolve(Buffer.from(text))
    );
    const { deliver, posted, stored, played } = delivering();
    let allowed = true;
    const report = reportsPrivilegedAction({ text: 'I moved the box up!' } as any, {
      refusal: () => (allowed ? null : 'the requester is no longer a builder'),
      instead: { text: 'I cannot go any further with that request.' },
    });
    const delivery = deliver(report);
    await vi.waitFor(() => expect(finishSynthesis).toBeDefined());
    allowed = false;
    finishSynthesis!();
    expect(await delivery).toMatchObject({ spoken: 'all', posted: false, stored: true });
    expect(played()).toEqual(['I cannot go any further with that request.']);
    expect(posted).toEqual([]);
    expect(stored).toEqual(['I cannot go any further with that request.']);
  });

  it('posts the neutral line, not the report, when synthesis failed and the right went meanwhile', async () => {
    const utils = await import('../utils');
    let allowed = true;
    vi.spyOn(utils, 'generateSpeech').mockImplementation(async () => {
      allowed = false;
      return null;
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { deliver, posted, stored, played } = delivering();
    const report = reportsPrivilegedAction({ text: 'I moved the box up!' } as any, { refusal: () => (allowed ? null : 'demoted'), instead: { text: 'I cannot go any further with that request.' } });
    await deliver(report);
    expect(played()).toEqual([]);
    expect([posted, stored]).toEqual([['I cannot go any further with that request.'], ['I cannot go any further with that request.']]);
  });

  it('asks for no speech of a report whose requester lost the right while it was posted (a chat turn posts, then speaks)', async () => {
    const utils = await import('../utils');
    const synthesize = vi.spyOn(utils, 'generateSpeech').mockImplementation(async (text: string) => Buffer.from(text));
    const { manager, session, livekit } = setup(async () => PLAYED);
    let allowed = true;
    const posted: string[] = [];
    const report = reportsPrivilegedAction({ text: 'I moved the box up!' } as any, { refusal: () => (allowed ? null : 'demoted'), instead: { text: 'I cannot go any further with that request.' } });
    await session.runTurn({ origin: 'chat', requesterId: 'p1' }, () =>
      deliverReply(
        {
          turn: currentTurn()!,
          session: { ended: false, emotes: { playEmote: () => {} }, messages: { sendMessage: async (text: string) => (posted.push(text), (allowed = false), true) }, voice: manager },
          runtime: { agentId: '00000000-0000-0000-0000-0000000000aa' as any, createMemory: async () => 'id' as any },
          roomId: '00000000-0000-0000-0000-0000000000bb' as any,
        },
        report
      )
    );
    expect(posted).toEqual(['I moved the box up!']);
    expect(synthesize).not.toHaveBeenCalled();
    expect(livekit.publishAudioStream).not.toHaveBeenCalled();
  });

  it('says a reply with a link without the link, posts all of it once as text, and remembers it once', async () => {
    const utils = await import('../utils');
    const synthesized: string[] = [];
    vi.spyOn(utils, 'generateSpeech').mockImplementation(async (text: string) => (synthesized.push(text), Buffer.from(text)));
    const { deliver, posted, stored } = delivering();
    const delivery = await deliver({ text: 'Documentation is here https://example.test/guide' });
    expect(synthesized).toEqual(['Documentation is here']);
    expect(delivery).toMatchObject({ spoken: 'partial', posted: true, stored: true });
    expect(posted).toEqual(['Documentation is here https://example.test/guide']);
    expect(stored).toEqual(['Documentation is here https://example.test/guide']);
  });

  it('cuts an utterance that is playing when its turn is cancelled, hears voices again, and posts nothing more for that turn', async () => {
    const utils = await import('../utils');
    vi.spyOn(utils, 'generateSpeech').mockImplementation(async (text: string) => Buffer.from(text));
    let publishSignal: AbortSignal | undefined;
    const { manager, deliver, posted, stored } = delivering((_buf: Buffer, opts: any) => {
      publishSignal = opts?.signal;
      opts.progress.frames = 10;
      return new Promise((resolve) => opts.signal.addEventListener('abort', () => resolve({ played: 'partial', reason: 'stopped' })));
    });
    const slot = new AbortController();
    const delivery = deliver({ text: 'A very long answer that takes a minute to say' }, slot.signal);
    await vi.waitFor(() => expect(publishSignal).toBeDefined());
    expect((manager as any).isSpeaking).toBe(true);
    slot.abort();
    expect(publishSignal!.aborted).toBe(true);
    expect(await delivery).toMatchObject({ spoken: 'partial', posted: false });
    expect((manager as any).isSpeaking).toBe(false);
    expect(posted).toEqual([]);
    // What went out is remembered
    expect(stored).toEqual(['A very long answer that takes a minute to say']);
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
  absent = [],
}: { transcribe?: (wav: Buffer) => Promise<unknown>; hasModel?: boolean; limits?: typeof noLimits | Record<string, number | null>; absent?: string[] } = {}) {
  const budget = new UsageBudget({ ...noLimits, ...limits } as any);
  resetUsageBudget(budget);
  const livekit = { on: vi.fn(), off: vi.fn(), publishAudioStream: vi.fn(async () => PLAYED) };
  // Everyone who speaks is a player in the world until they leave (or never was: `absent`)
  const gone = new Set<string>(absent);
  const events = new Events({});
  const world = { livekit, events, entities: { player: { setSpeaking: vi.fn() }, getPlayer: (id: string) => (gone.has(id) ? undefined : { data: { id, name: id } }) } };
  /** What the engine does when a player's entity is removed: the entity is gone, and 'leave' is emitted */
  const leave = (playerId: string) => {
    gone.add(playerId);
    events.emit('leave', { playerId });
  };
  /** The same account joining again: an entity with the same id */
  const rejoin = (playerId: string) => void gone.delete(playerId);
  const sendMessage = vi.fn();
  const useModel = vi.fn((_type: string, wav: Buffer) => transcribe(wav));
  const runtime: any = sessionRuntime({
    getModel: vi.fn(() => (hasModel ? () => '' : undefined)),
    useModel,
  });
  const session = withParts(sessionFor(world, { runtime }), { messages: { sendMessage } });
  const manager = session.voice;
  const heard: { text: string; speaker: string; turn: any }[] = [];
  (manager as any).handleMessage = vi.fn(async (text: string, speaker: string) => void heard.push({ text, speaker, turn: currentTurn() }));
  manager.start();
  const emit = livekit.on.mock.calls.find(([event]) => event === 'audio')![1] as (data: unknown) => unknown;
  const say = (participant: string, buffer: Buffer) => emit({ participant, buffer });
  const state = () => ({ speakers: (manager as any).speakers.size, transcribing: (manager as any).transcribing.size, held: (manager as any).heldVoiceBytes });
  /** PCM seconds in each transcription request so far */
  const requests = () => useModel.mock.calls.map(([, wav]) => (wav.length - 44) / 96_000);
  return { manager, session, budget, runtime, useModel, emit, say, state, requests, heard, sendMessage, world, leave, rejoin, events };
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
    const { say, session, useModel, heard, requests } = listening();
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
    expect(heard[0]).toMatchObject({ text: 'hello there', speaker: 'p1', turn: { origin: 'voice', requesterId: 'p1', generation: session.generation, live: true } });
  });

  it('asks speech-to-text nothing for a sound too short to be a word, and counts nothing for it; 100 ms of speech is transcribed', async () => {
    const { say, budget, useModel, heard, requests, state } = listening({ limits: { sttSecondsPerDay: 100 } });
    // 100 ms of 48 kHz 16-bit mono
    expect(MIN_UTTERANCE_BYTES).toBe(9600);
    // One 10 ms frame (a click); then nine of them, with quiet frames in between that do not count
    say('p1', loud(10));
    await vi.advanceTimersByTimeAsync(UTTERANCE_PAUSE_MS);
    for (let i = 0; i < 9; i++) {
      say('p2', loud(10));
      say('p2', quiet(10));
    }
    await vi.advanceTimersByTimeAsync(UTTERANCE_PAUSE_MS);
    expect(useModel).not.toHaveBeenCalled();
    expect(heard).toEqual([]);
    expect(budget.snapshot(24 * 3600_000).sttSeconds).toBe(0);
    // Nothing of them is held either
    expect(state()).toEqual({ speakers: 0, transcribing: 0, held: 0 });

    for (let i = 0; i < 10; i++) say('p3', loud(10));
    await vi.advanceTimersByTimeAsync(UTTERANCE_PAUSE_MS);
    expect(requests()).toEqual([0.1]);
    expect(heard.map(({ speaker }) => speaker)).toEqual(['p3']);
    expect(budget.snapshot(24 * 3600_000).sttSeconds).toBeCloseTo(0.1);
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

  it("keeps nothing of a speaker once their utterance has been handled", async () => {
    const { say, state } = listening();
    say('p1', loud(500));
    say('p2', loud(500));
    expect(state()).toEqual({ speakers: 2, transcribing: 0, held: 2 * 500 * 96 });
    await vi.advanceTimersByTimeAsync(UTTERANCE_PAUSE_MS);
    expect(state()).toEqual({ speakers: 0, transcribing: 0, held: 0 });
  });

  it('drops what a speaker said when they leave the world before their pause: nothing of it is transcribed', async () => {
    const { say, state, useModel, heard, leave } = listening();
    say('p1', loud(500));
    say('p2', loud(500));
    await vi.advanceTimersByTimeAsync(UTTERANCE_PAUSE_MS - 500);
    leave('p1');
    expect(state()).toEqual({ speakers: 1, transcribing: 0, held: 500 * 96 });
    await vi.advanceTimersByTimeAsync(UTTERANCE_PAUSE_MS);
    expect(useModel).toHaveBeenCalledTimes(1);
    expect(heard.map(({ speaker }) => speaker)).toEqual(['p2']);
  });

  it('starts no turn for a transcript whose speaker left the world while it was being transcribed', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    let finish!: (text: string) => void;
    const { say, heard, leave } = listening({ transcribe: () => new Promise((resolve) => (finish = resolve)) });
    say('p1', loud(300));
    await vi.advanceTimersByTimeAsync(UTTERANCE_PAUSE_MS);
    leave('p1');
    finish('hello there');
    await vi.advanceTimersByTimeAsync(0);
    expect(heard).toEqual([]);
  });

  it('starts no turn for a transcript whose speaker left the world while it waited its turn; one who stayed gets theirs', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const { manager, session, runtime, say, leave } = listening();
    // The real turn handling, up to the event the message handler would take over
    delete (manager as any).handleMessage;
    runtime.ensureConnection = vi.fn().mockResolvedValue(undefined);
    runtime.emitEvent = vi.fn().mockResolvedValue(undefined);
    // A chat turn in progress: what was said meanwhile waits behind it
    let finishChat!: () => void;
    (session.messages as any).handleMessage = () => new Promise<void>((resolve) => (finishChat = resolve));
    session.conversation.accept({ id: 'c1', body: 'hello', fromId: 'p9', from: 'P9', createdAt: '' });
    say('p1', loud(300));
    say('p2', loud(300));
    await vi.advanceTimersByTimeAsync(UTTERANCE_PAUSE_MS);
    expect(session.conversation.waiting).toBe(2);
    leave('p1');
    finishChat();
    await vi.advanceTimersByTimeAsync(0);
    await session.conversation.idle();
    const answered = runtime.emitEvent.mock.calls.map(([, payload]: [string, any]) => payload.message.content.metadata.hyperfyFromId);
    expect(answered).toEqual(['p2']);
  });

  it('starts no turn for a transcript whose speaker left and came back under the same id while it was being transcribed', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    let finish!: (text: string) => void;
    const { session, say, heard, leave, rejoin } = listening({ transcribe: () => new Promise((resolve) => (finish = resolve)) });
    say('p1', loud(300));
    await vi.advanceTimersByTimeAsync(UTTERANCE_PAUSE_MS);
    leave('p1');
    rejoin('p1');
    finish('said before leaving');
    await vi.advanceTimersByTimeAsync(0);
    // Not even queued: it takes no place in the queue and nothing acts on it when it is admitted
    expect(session.conversation.stats().queued).toBe(0);
    expect(heard).toEqual([]);
    // What they say after coming back is theirs again
    finish = undefined as any;
    say('p1', loud(300));
    await vi.advanceTimersByTimeAsync(UTTERANCE_PAUSE_MS);
    finish('said after coming back');
    await vi.advanceTimersByTimeAsync(0);
    expect(heard.map(({ text }) => text)).toEqual(['said after coming back']);
  });

  it('starts no turn for a queued transcript whose speaker left and came back under the same id before its turn', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const { manager, session, runtime, say, leave, rejoin } = listening();
    delete (manager as any).handleMessage;
    runtime.ensureConnection = vi.fn().mockResolvedValue(undefined);
    runtime.emitEvent = vi.fn().mockResolvedValue(undefined);
    let finishChat!: () => void;
    (session.messages as any).handleMessage = () => new Promise<void>((resolve) => (finishChat = resolve));
    session.conversation.accept({ id: 'c1', body: 'hello', fromId: 'p9', from: 'P9', createdAt: '' });
    say('p1', loud(300));
    await vi.advanceTimersByTimeAsync(UTTERANCE_PAUSE_MS);
    expect(session.conversation.waiting).toBe(1);
    leave('p1');
    rejoin('p1');
    finishChat();
    await vi.advanceTimersByTimeAsync(0);
    await session.conversation.idle();
    expect(runtime.emitEvent).not.toHaveBeenCalled();
  });

  it('stops the agent the moment a transcript that is a stop command addressed to it is admitted, before its turn', async () => {
    const { session, say, world } = listening({ transcribe: async () => 'Coo, stop!' });
    const stopAllActions = vi.fn();
    (world as any).controls = { stopAllActions };
    // A chat turn in progress: the transcript waits behind it, but its stop does not
    let finishChat!: () => void;
    (session.messages as any).handleMessage = () => new Promise<void>((resolve) => (finishChat = resolve));
    session.conversation.accept({ id: 'c1', body: 'hello', fromId: 'p9', from: 'P9', createdAt: '' });
    say('p1', loud(300));
    await vi.advanceTimersByTimeAsync(UTTERANCE_PAUSE_MS);
    expect(session.conversation.waiting).toBe(1);
    expect(stopAllActions).toHaveBeenCalledWith('asked to stop');
    finishChat();
  });

  it('does not transcribe a voice that is not a player in the world', async () => {
    const { say, heard, useModel, requests, state } = listening({ absent: ['stranger'] });
    say('stranger', loud(300));
    say('p1', loud(200));
    await vi.advanceTimersByTimeAsync(UTTERANCE_PAUSE_MS);
    expect(requests()).toEqual([0.2]);
    expect(useModel).toHaveBeenCalledTimes(1);
    expect(heard.map(({ speaker }) => speaker)).toEqual(['p1']);
    expect(state()).toEqual({ speakers: 0, transcribing: 0, held: 0 });
  });

  it('stops listening for departures on stop()', () => {
    const { manager, events } = listening();
    expect((events as any).listeners.leave.size).toBe(1);
    manager.stop();
    expect((events as any).listeners.leave.size).toBe(0);
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
    // Three requests at a time: everyone is heard within three pauses
    await vi.advanceTimersByTimeAsync(3 * UTTERANCE_PAUSE_MS);
    expect(heard.map(({ speaker }) => speaker).sort()).toEqual(['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7']);
  });

  it('counts people being transcribed toward the 8: while eight are held, waiting or in slow requests, a ninth is not heard', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Speech-to-text never answers
    const { say, state, useModel } = listening({ transcribe: () => new Promise(() => {}) });
    for (let i = 0; i < MAX_SPEAKERS; i++) say(`p${i}`, loud(100));
    await vi.advanceTimersByTimeAsync(UTTERANCE_PAUSE_MS * 4);
    expect(state()).toMatchObject({ speakers: MAX_SPEAKERS - MAX_CONCURRENT_TRANSCRIPTIONS, transcribing: MAX_CONCURRENT_TRANSCRIPTIONS });
    say('p8', loud(100));
    expect(state().speakers + state().transcribing).toBe(MAX_SPEAKERS);
    await vi.advanceTimersByTimeAsync(UTTERANCE_PAUSE_MS * 4);
    // Someone already held can go on speaking: their next utterance waits for their request
    say('p0', loud(100));
    expect(state().speakers).toBe(MAX_SPEAKERS - MAX_CONCURRENT_TRANSCRIPTIONS + 1);
    expect(useModel).toHaveBeenCalledTimes(MAX_CONCURRENT_TRANSCRIPTIONS);
  });

  it('sends at most 3 speech-to-text requests at once, over all speakers; the others wait and are transcribed as requests end', async () => {
    const finish: ((text: string) => void)[] = [];
    let inFlight = 0;
    let most = 0;
    const { say, heard, useModel } = listening({
      transcribe: () =>
        new Promise((resolve) => {
          most = Math.max(most, ++inFlight);
          finish.push((text) => {
            inFlight--;
            resolve(text);
          });
        }),
    });
    for (let i = 0; i < 6; i++) say(`p${i}`, loud(100));
    await vi.advanceTimersByTimeAsync(UTTERANCE_PAUSE_MS * 3);
    expect(useModel).toHaveBeenCalledTimes(MAX_CONCURRENT_TRANSCRIPTIONS);
    while (finish.length) {
      finish.shift()!('said something');
      await vi.advanceTimersByTimeAsync(UTTERANCE_PAUSE_MS);
    }
    expect(heard).toHaveLength(6);
    expect(most).toBe(MAX_CONCURRENT_TRANSCRIPTIONS);
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
      // The failing turn is the conversation queue's to report (lib/chat-intake.ts)
      expect(warn.mock.calls.flat().map(String).join('\n')).toContain('turn failed');
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
    const manager = sessionFor({}).voice;
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
    const sendMessage = vi.fn().mockResolvedValue(true);
    const world = { entities: { getPlayer: () => ({ data: { name: 'Alice' } }), items: new Map() } };
    const link = '🛒 HoverBoard — 505 JPYC\nhttps://open-pay.jp/ja/@a?product=x';
    const runtime: any = sessionRuntime({
      ensureConnection: vi.fn(),
      createMemory: vi.fn(),
      // The message handler's part: it answers through the callback while the turn runs
      emitEvent: vi.fn(async (_e: string, payload: any) => void (await payload.callback({ text: link, metadata: { openpayLink: true } }))),
    });
    const session = withParts(sessionFor(world, { runtime }), { emotes: { playEmote: vi.fn() }, messages: { sendMessage } });
    const speak = vi.spyOn(session.voice, 'speak');
    await session.runTurn({ origin: 'voice', requesterId: 'p1' }, () => (session.voice as any).handleMessage('HoverBoardのリンクちょうだい', 'p1'));
    expect(sendMessage.mock.calls).toEqual([[link]]);
    expect(speak).not.toHaveBeenCalled();
  });
});

describe('VoiceManager voice limits', () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    // Only ElevenLabs: the speech request is answered by the stub fetch below, never sent
    vi.stubEnv('ELEVENLABS_XI_API_KEY', 'test-key');
    vi.stubEnv('OPENAI_API_KEY', '');
    for (const method of ['log', 'error'] as const) vi.spyOn(console, method).mockImplementation(() => {});
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    resetUsageBudget();
  });

  it('skips text-to-speech once the daily character limit is reached, sending nothing', async () => {
    const fetch = vi.fn();
    globalThis.fetch = fetch as never;
    const budget = new UsageBudget({ ...noLimits, ttsCharsPerDay: 0 });
    resetUsageBudget(budget);
    const { manager, livekit } = setup(async () => {});
    await expect(manager.speak('Hello there')).resolves.toBe('none');
    expect(fetch).not.toHaveBeenCalled();
    expect(livekit.publishAudioStream).not.toHaveBeenCalled();
    expect(budget.snapshot(60_000).skipped.tts).toBe(1);
  });

  it('counts the characters before the request: of two replies spoken at once only the one that fits the daily limit is synthesized', async () => {
    let answer!: (response: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>((resolve) => (answer = resolve)));
    globalThis.fetch = fetch as never;
    const budget = new UsageBudget({ ...noLimits, ttsCharsPerDay: 20 });
    resetUsageBudget(budget);
    const { manager } = setup(async () => PLAYED);
    const both = [manager.speak('Hello there!'), manager.speak('Hello again!')];
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(budget.snapshot(60_000)).toMatchObject({ ttsChars: 12, skipped: { tts: 1 } });
    answer(new Response(Buffer.from('audio'), { status: 200 }));
    expect(await Promise.all(both)).toEqual(['all', 'none']);
  });

  it('keeps the characters of a synthesis that failed after it was sent counted', async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    globalThis.fetch = fetch as never;
    const budget = new UsageBudget({ ...noLimits, ttsCharsPerDay: 20 });
    resetUsageBudget(budget);
    const { manager } = setup(async () => PLAYED);
    await expect(manager.speak('Hello there!')).resolves.toBe('none');
    expect(budget.snapshot(60_000).ttsChars).toBe(12);
    await expect(manager.speak('Hello again!')).resolves.toBe('none');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('speaks at most 600 code points of a reply, up to a sentence end, and reports the reply as partly spoken', async () => {
    const fetch = vi.fn(async () => new Response(Buffer.from('audio'), { status: 200 }));
    globalThis.fetch = fetch as never;
    const budget = new UsageBudget(noLimits);
    resetUsageBudget(budget);
    const { manager } = setup(async () => PLAYED);
    const sentence = 'This is one sentence of the reply. ';
    const reply = sentence.repeat(40);
    await expect(manager.speak(reply)).resolves.toBe('partial');
    const spoken: string = JSON.parse((fetch.mock.calls[0] as unknown as [string, { body: string }])[1].body).text;
    expect(spoken).toBe(sentence.repeat(17).trimEnd());
    expect(spoken.length).toBeLessThanOrEqual(MAX_SPOKEN_CODE_POINTS);
    // Only what was sent is counted
    expect(budget.snapshot(60_000).ttsChars).toBe(spoken.length);
    // A reply within the cap is spoken whole
    await expect(manager.speak(sentence.repeat(17))).resolves.toBe('all');
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
    const { manager, session } = setup(publish);
    const result = await session.runTurn({ origin: 'voice', requesterId: 'p1' }, async () => [await manager.speak('Hello there'), turnDelivered(currentTurn())]);
    expect(result).toEqual([played, played !== 'none']);
  });

  it('reports a playback that hung until its timeout after some frames went out as partly played', async () => {
    vi.useFakeTimers();
    try {
      const utils = await import('../utils');
      vi.spyOn(utils, 'generateSpeech').mockResolvedValue(Buffer.from('audio'));
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { manager, session } = setup((_buf: Buffer, { progress }: { progress: { frames: number } }) => {
        progress.frames = 2;
        return new Promise(() => {});
      });
      const result = session.runTurn({ origin: 'voice', requesterId: 'p1' }, async () => [await manager.speak('Hello there'), turnDelivered(currentTurn())]);
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
  const session = sessionFor({ entities: {} });
  const result = await session.runTurn({ origin: 'voice', requesterId: 'p1' }, async () => [await session.voice.speak('Hello there'), turnDelivered(currentTurn())]);
  expect(result).toEqual(['none', false]);
  vi.restoreAllMocks();
});

describe('VoiceManager voice replies (a voice turn answered through the one delivery path)', () => {
  afterEach(() => vi.restoreAllMocks());

  /**
   * A voice turn of player p1 with the real session, the real message manager posting into the
   * real world chat, and a real AgentLiveKit (no room unless `livekit` is given). The message
   * handler's part is `answer`: it replies through the callback while the turn runs.
   */
  async function voiceTurn({ livekit = new AgentLiveKit({}) as any, reply = { text: 'Hi Alice' } as Record<string, unknown> } = {}) {
    const sent: [string, any][] = [];
    const playEmote = vi.fn();
    const world: any = {
      livekit,
      chat: { msgs: [], listeners: new Set(), add: vi.fn() },
      events: { emit: vi.fn() },
      network: { send: (name: string, data: unknown) => sent.push([name, data]) },
      entities: { getPlayer: () => ({ data: { name: 'Alice' } }), items: new Map(), player: { data: { id: 'coo', name: 'Coo' }, setSpeaking: vi.fn() } },
    };
    installWorldChat(world);
    const outcome: { delivered?: boolean } = {};
    const runtime: any = sessionRuntime({
      ensureConnection: vi.fn(),
      createMemory: vi.fn(async () => {}),
      emitEvent: vi.fn(async (_e: string, payload: any) => {
        await payload.callback(reply);
        outcome.delivered = turnDelivered(currentTurn());
      }),
    });
    const session = withParts(sessionFor(world, { runtime }), { emotes: { playEmote, stop: vi.fn() } });
    const run = () => session.runTurn({ origin: 'voice', requesterId: 'p1' }, () => (session.voice as any).handleMessage('hello there', 'p1'));
    const posted = () => sent.filter(([name]) => name === 'chatAdded').map(([, msg]) => msg.body);
    return { session, world, runtime, playEmote, run, posted, outcome };
  }

  it('posts the reply as text, once, when LiveKit played nothing (no room)', async () => {
    const utils = await import('../utils');
    vi.spyOn(utils, 'generateSpeech').mockResolvedValue(Buffer.from('audio'));
    for (const method of ['log', 'warn', 'info'] as const) vi.spyOn(console, method).mockImplementation(() => {});
    const { run, posted, runtime, playEmote } = await voiceTurn();
    await run();
    expect(posted()).toEqual(['Hi Alice']);
    expect(playEmote).toHaveBeenCalledWith('TALK');
    // Remembered as a voice reply to what was said
    expect(runtime.createMemory).toHaveBeenCalledTimes(1);
    expect(runtime.createMemory.mock.calls[0][0].content).toMatchObject({ text: 'Hi Alice', isVoiceMessage: true, name: 'Coo', inReplyTo: expect.any(String) });
  });

  it('posts the whole reply as text, once, when only part of it was spoken before the playback failed', async () => {
    const utils = await import('../utils');
    vi.spyOn(utils, 'generateSpeech').mockResolvedValue(Buffer.from('audio'));
    for (const method of ['warn', 'info'] as const) vi.spyOn(console, method).mockImplementation(() => {});
    const publishAudioStream = vi.fn(async (_buf: Buffer, { progress }: { progress: { frames: number } }) => {
      progress.frames = 1;
      throw new Error('capture failed');
    });
    const { run, posted, outcome } = await voiceTurn({ livekit: { publishAudioStream } });
    await run();
    expect(posted()).toEqual(['Hi Alice']);
    expect(outcome.delivered).toBe(true);
  });

  it('posts the whole reply as text, once, when the playback timed out after some of it went out', async () => {
    vi.useFakeTimers();
    try {
      const utils = await import('../utils');
      vi.spyOn(utils, 'generateSpeech').mockResolvedValue(Buffer.from('audio'));
      for (const method of ['warn', 'info'] as const) vi.spyOn(console, method).mockImplementation(() => {});
      const publishAudioStream = vi.fn((_buf: Buffer, { progress }: { progress: { frames: number } }) => {
        progress.frames = 2;
        return new Promise(() => {});
      });
      const { run, posted } = await voiceTurn({ livekit: { publishAudioStream } });
      const turn = run();
      await vi.advanceTimersByTimeAsync(120_000);
      await turn;
      expect(posted()).toEqual(['Hi Alice']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('posts a reply longer than what is said aloud as text, once, although the spoken part played to its end', async () => {
    const utils = await import('../utils');
    const tts = vi.spyOn(utils, 'generateSpeech').mockResolvedValue(Buffer.from('audio'));
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const long = `${'A sentence of the reply. '.repeat(40)}The end.`;
    expect(Array.from(long).length).toBeGreaterThan(MAX_SPOKEN_CODE_POINTS);
    const { run, posted } = await voiceTurn({ livekit: { publishAudioStream: vi.fn(async () => PLAYED) }, reply: { text: long } });
    await run();
    expect(Array.from(tts.mock.calls[0][0]).length).toBeLessThanOrEqual(MAX_SPOKEN_CODE_POINTS);
    // The whole reply, in the chunks the world's chat takes (cut at spaces)
    expect(posted().length).toBeGreaterThan(1);
    expect(posted().join(' ').replace(/\s+/g, ' ')).toBe(long);
  });

  it('does not post the reply as text when all of it was played', async () => {
    const utils = await import('../utils');
    vi.spyOn(utils, 'generateSpeech').mockResolvedValue(Buffer.from('audio'));
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const { run, posted, outcome, runtime } = await voiceTurn({ livekit: { publishAudioStream: vi.fn(async () => PLAYED) } });
    await run();
    expect(posted()).toEqual([]);
    expect(outcome.delivered).toBe(true);
    expect(runtime.createMemory).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['ended', (ctx: any) => void ctx.session.end()],
    ['was replaced by a connection around the same world object', (ctx: any) => {
      void ctx.session.end();
      sessionFor(ctx.world, { runtime: ctx.runtime });
    }],
  ])('posts and plays nothing when its connection %s while the reply was being synthesized', async (_what, change) => {
    const utils = await import('../utils');
    for (const method of ['log', 'warn', 'info'] as const) vi.spyOn(console, method).mockImplementation(() => {});
    const publishAudioStream = vi.fn(async () => PLAYED);
    const ctx = await voiceTurn({ livekit: { publishAudioStream, disconnectRoom: vi.fn(async () => {}) } });
    vi.spyOn(utils, 'generateSpeech').mockImplementation(async () => {
      change(ctx);
      return Buffer.from('audio');
    });
    await ctx.run();
    expect(publishAudioStream).not.toHaveBeenCalled();
    expect(ctx.posted()).toEqual([]);
    // Nothing reached anyone: nothing is remembered as said
    expect(ctx.runtime.createMemory).not.toHaveBeenCalled();
  });

  it('remembers a reply that was played although its connection ended while it played, and posts nothing after that', async () => {
    const utils = await import('../utils');
    vi.spyOn(utils, 'generateSpeech').mockResolvedValue(Buffer.from('audio'));
    for (const method of ['log', 'warn', 'info'] as const) vi.spyOn(console, method).mockImplementation(() => {});
    let ctx!: Awaited<ReturnType<typeof voiceTurn>>;
    const publishAudioStream = vi.fn(async () => {
      void ctx.session.end();
      return { played: 'partial', reason: 'stopped' } as const;
    });
    ctx = await voiceTurn({ livekit: { publishAudioStream, disconnectRoom: vi.fn(async () => {}) } });
    await ctx.run();
    expect(ctx.posted()).toEqual([]);
    expect(ctx.runtime.createMemory).toHaveBeenCalledTimes(1);
  });
});
