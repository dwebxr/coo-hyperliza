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

import { VoiceManager } from './voice-manager';
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

describe('VoiceManager transcription', () => {
  async function transcribeWith(hasTranscriptionModel: boolean) {
    const runtime: any = {
      getService: () => ({ getWorld: () => null }),
      getModel: vi.fn(() => (hasTranscriptionModel ? () => 'こんにちは' : undefined)),
      useModel: vi.fn().mockResolvedValue('こんにちは'),
    };
    const manager = new VoiceManager(runtime);
    (manager as any).userStates.set('p1', { buffers: [Buffer.alloc(8)], totalLength: 8, lastActive: 0, transcriptionText: '' });
    (manager as any).handleMessage = vi.fn();
    await (manager as any).processTranscription('p1');
    return { runtime, handled: (manager as any).handleMessage };
  }

  it('asks the registered TRANSCRIPTION model exactly once', async () => {
    const { runtime, handled } = await transcribeWith(true);
    expect(runtime.useModel).toHaveBeenCalledTimes(1);
    expect(runtime.useModel.mock.calls[0][0]).toBe('TRANSCRIPTION');
    expect(handled).toHaveBeenCalledWith('こんにちは', 'p1');
  });

  it('does nothing when no transcription model is registered', async () => {
    const { runtime, handled } = await transcribeWith(false);
    expect(runtime.useModel).not.toHaveBeenCalled();
    expect(handled).not.toHaveBeenCalled();
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

  it('reports that nothing was spoken for empty text', async () => {
    const { manager } = setup(async () => {});
    await expect(manager.speak('https://only.a/link')).resolves.toBe('none');
  });
});

describe('VoiceManager turns', () => {
  afterEach(() => vi.useRealTimers());

  it("handles a speaker's utterance as a voice turn for that player, after the pause", async () => {
    vi.useFakeTimers();
    const world = { livekit: {}, entities: {} };
    const runtime: any = { getService: () => ({ getWorld: () => world, getConnectionGeneration: () => 4 }) };
    const manager = new VoiceManager(runtime);
    let seen: any;
    vi.spyOn(manager as any, 'processTranscription').mockImplementation(async () => {
      seen = currentTurn();
    });
    (manager as any).userStates.set('p1', { buffers: [], totalLength: 0, lastActive: 0, transcriptionText: '' });
    manager.debouncedProcessTranscription('p1' as any);
    await vi.advanceTimersByTimeAsync(1500);
    expect(seen).toMatchObject({ origin: 'voice', requesterId: 'p1', world, generation: 4 });
    expect(seen.signal.aborted).toBe(false);
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
