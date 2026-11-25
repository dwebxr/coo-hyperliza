import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TurnCancelled, neverAbortedSignal, runTurn } from './lib/turn-context';
import { MAX_SPEECH_AUDIO_BYTES, MAX_TRANSCRIPT_RESPONSE_BYTES, TtsLimitReached, countOtherPlayers, generateSpeech, resolveUrl, transcribeWithElevenLabs } from './utils';
import { UsageBudget, resetUsageBudget } from '../usage-budget';

const world = { assetsUrl: 'https://assets.example.com/' };

describe('resolveUrl', () => {
  afterEach(() => vi.restoreAllMocks());

  it('maps asset:// to the world assets URL', async () => {
    expect(await resolveUrl('asset://abc.glb', world)).toBe('https://assets.example.com/abc.glb');
  });

  // resolveUrl only says what a name refers to. Whether an http(s) URL may be fetched is decided
  // where it is fetched (lib/net-policy.ts; see asset-bytes.test.ts and net-policy.test.ts).
  it('leaves URLs that are already absolute as they are', async () => {
    for (const url of ['https://x.test/a.glb', 'http://x.test/a.glb', 'data:text/plain;base64,aGk=', 'blob:abc']) {
      expect(await resolveUrl(url, world)).toBe(url);
    }
  });

  it('reads a bundled file as a data URL of its type', async () => {
    const result = await resolveUrl('assets/day2.hdr', world);
    expect(result).toMatch(/^data:image\/vnd\.radiance;base64,/);
    expect(Buffer.from(result!.split(',')[1], 'base64').subarray(0, 10).toString()).toBe('#?RADIANCE');
  });

  it('refuses local paths that are not bundled files: outside the asset root, or elsewhere inside it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const url of ['../../package.json', '../../.env', 'assets/../../constants.ts', 'constants.ts', 'puppeteer/page.js', 'assets']) {
      expect(await resolveUrl(url, world), url).toBeNull();
    }
  });

  it('refuses absolute paths', async () => {
    expect(await resolveUrl('/etc/hosts', world)).toBeNull();
  });

  it('refuses all local paths when allowLocal is false', async () => {
    expect(await resolveUrl('assets/day2.hdr', world, { allowLocal: false })).toBeNull();
    expect(await resolveUrl('https://x.test/a.glb', world, { allowLocal: false })).toBe('https://x.test/a.glb');
  });

  it('returns null for non-strings', async () => {
    for (const value of [undefined, null, 42, { href: 'https://x.test/a.glb' }, ['asset://abc.glb']]) {
      expect(await resolveUrl(value as never, world), String(value)).toBeNull();
    }
  });
});

describe('countOtherPlayers', () => {
  const entity = (id: string, type: string) => [id, { data: { id, type } }] as const;

  it('counts players other than the agent', () => {
    const world = {
      entities: {
        player: { data: { id: 'me' } },
        items: new Map([entity('me', 'player'), entity('p1', 'player'), entity('p2', 'player'), entity('a1', 'app')]),
      },
    };
    expect(countOtherPlayers(world)).toBe(2);
  });

  it('returns 0 without a world', () => {
    expect(countOtherPlayers(null)).toBe(0);
  });
});

describe('transcribeWithElevenLabs', () => {
  const realFetch = globalThis.fetch;
  const realKey = process.env.ELEVENLABS_XI_API_KEY;
  afterEach(() => {
    globalThis.fetch = realFetch;
    // Assigning undefined would set the variable to the text "undefined"
    if (realKey === undefined) delete process.env.ELEVENLABS_XI_API_KEY;
    else process.env.ELEVENLABS_XI_API_KEY = realKey;
    vi.restoreAllMocks();
  });

  it('posts the audio to the correct speech-to-text URL and returns the text', async () => {
    process.env.ELEVENLABS_XI_API_KEY = 'test-key';
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ text: 'こんにちは' }), { status: 200 }));
    globalThis.fetch = fetchMock as any;

    await expect(transcribeWithElevenLabs(Buffer.from('RIFF'))).resolves.toBe('こんにちは');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.elevenlabs.io/v1/speech-to-text');
    expect(init.headers['xi-api-key']).toBe('test-key');
    expect((init.body as FormData).get('model_id')).toBe('scribe_v2');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('returns null without a key (making no request) or on an API error, so the caller can fall back', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"detail":"missing_permissions"}', { status: 401 }));
    globalThis.fetch = fetchMock as any;
    delete process.env.ELEVENLABS_XI_API_KEY;
    await expect(transcribeWithElevenLabs(Buffer.from('x'))).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    process.env.ELEVENLABS_XI_API_KEY = 'test-key';
    await expect(transcribeWithElevenLabs(Buffer.from('x'))).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('speech API answers are read within a byte cap and a deadline', () => {
  const realFetch = globalThis.fetch;
  const env = { ...process.env };
  beforeEach(() => {
    process.env.ELEVENLABS_XI_API_KEY = 'test-key';
    process.env.OPENAI_API_KEY = 'test-openai-key';
    // The OpenAI request these tests read is the /v1/audio/speech one of the legacy models
    process.env.OPENAI_TTS_MODEL = 'tts-1';
    delete process.env.OPENAI_TTS_VOICE;
    for (const method of ['log', 'error', 'warn'] as const) vi.spyOn(console, method).mockImplementation(() => {});
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    for (const key of ['ELEVENLABS_XI_API_KEY', 'OPENAI_API_KEY', 'OPENAI_TTS_MODEL', 'OPENAI_TTS_VOICE']) {
      if (env[key] === undefined) delete process.env[key];
      else process.env[key] = env[key];
    }
    resetUsageBudget();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /**
   * A response whose body is `total` bytes, `chunk` at a time, counting what was pulled and whether
   * it was cancelled. (It ends, and yields between chunks, so that code which reads all of it
   * fails its test instead of never returning.)
   */
  function oversized(total: number, chunk: number, init: ResponseInit = { status: 200 }) {
    const state = { pulled: 0, cancelled: false };
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          await new Promise((resolve) => setImmediate(resolve));
          if (state.pulled >= total) return controller.close();
          state.pulled += chunk;
          controller.enqueue(new Uint8Array(chunk));
        },
        cancel() {
          state.cancelled = true;
        },
      },
      { highWaterMark: 0 }
    );
    return { state, response: new Response(body, init) };
  }

  /** A response whose body sends `first` and then nothing more */
  function stalled(first = new Uint8Array(0)) {
    const state = { cancelled: false };
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        if (first.length) controller.enqueue(first);
      },
      cancel() {
        state.cancelled = true;
      },
    });
    return { state, response: new Response(body, { status: 200 }) };
  }

  /**
   * generateSpeech with only that provider's key set, so its one request goes to that provider
   * (checked: the request the stubbed fetch saw was for `url`).
   */
  const only = (key: 'ELEVENLABS_XI_API_KEY' | 'OPENAI_API_KEY', url: string) => async (text: string) => {
    for (const other of ['ELEVENLABS_XI_API_KEY', 'OPENAI_API_KEY']) if (other !== key) delete process.env[other];
    const audio = await generateSpeech(text);
    const asked = vi.mocked(globalThis.fetch).mock.calls.map(([input]) => String(input));
    expect(asked).toHaveLength(1);
    expect(asked[0].startsWith(url)).toBe(true);
    return audio;
  };
  const elevenLabsOnly = only('ELEVENLABS_XI_API_KEY', 'https://api.elevenlabs.io/v1/text-to-speech/');
  const speech = [
    ['ElevenLabs text-to-speech', elevenLabsOnly],
    ['OpenAI text-to-speech', only('OPENAI_API_KEY', 'https://api.openai.com/v1/audio/speech')],
  ] as const;

  it.each(speech)('%s: gives up on audio larger than 16 MB while it arrives, and downloads no more of it', async (_what, generate) => {
    const { state, response } = oversized(3 * MAX_SPEECH_AUDIO_BYTES, 1024 * 1024);
    globalThis.fetch = vi.fn().mockResolvedValue(response) as never;
    // Compared as a boolean: a failure must not print 48 MB of audio
    expect((await generate('hello')) === null).toBe(true);
    expect(state.cancelled).toBe(true);
    // Stopped at the first chunk past the cap
    expect(state.pulled).toBeLessThanOrEqual(MAX_SPEECH_AUDIO_BYTES + 2 * 1024 * 1024);
  });

  it.each(speech)('%s: reads nothing of an answer that declares more than 16 MB', async (_what, generate) => {
    const { state, response } = oversized(64 * 1024, 1024, { status: 200, headers: { 'content-length': String(MAX_SPEECH_AUDIO_BYTES + 1) } });
    globalThis.fetch = vi.fn().mockResolvedValue(response) as never;
    await expect(generate('hello')).resolves.toBeNull();
    expect(state.pulled).toBeLessThanOrEqual(1024);
    expect(state.cancelled).toBe(true);
  });

  it.each(speech)('%s: gives up on an answer whose body stalls, 30 s after the request started', async (_what, generate) => {
    vi.useFakeTimers();
    const { state, response } = stalled(new Uint8Array(100));
    globalThis.fetch = vi.fn().mockResolvedValue(response) as never;
    let result: unknown = 'pending';
    void generate('hello').then((value) => (result = value));
    await vi.advanceTimersByTimeAsync(29_999);
    expect(result).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toBeNull();
    expect(state.cancelled).toBe(true);
  });

  it.each(speech)('%s: returns audio within the cap whole', async (_what, generate) => {
    const audio = Buffer.alloc(3 * 1024 * 1024, 7);
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(audio, { status: 200 })) as never;
    const result = await generate('hello');
    expect(result?.equals(audio)).toBe(true);
  });

  it('speech-to-text: gives up on a transcript larger than 1 MB, one that stalls, and one that is not JSON', async () => {
    const big = oversized(3 * MAX_TRANSCRIPT_RESPONSE_BYTES, 64 * 1024);
    globalThis.fetch = vi.fn().mockResolvedValue(big.response) as never;
    await expect(transcribeWithElevenLabs(Buffer.from('RIFF'))).resolves.toBeNull();
    expect(big.state.cancelled).toBe(true);
    expect(big.state.pulled).toBeLessThanOrEqual(MAX_TRANSCRIPT_RESPONSE_BYTES + 128 * 1024);

    globalThis.fetch = vi.fn().mockResolvedValue(new Response('<html>busy</html>', { status: 200 })) as never;
    await expect(transcribeWithElevenLabs(Buffer.from('RIFF'))).resolves.toBeNull();

    vi.useFakeTimers();
    const stuck = stalled(Buffer.from('{"text":"hel'));
    globalThis.fetch = vi.fn().mockResolvedValue(stuck.response) as never;
    let result: unknown = 'pending';
    void transcribeWithElevenLabs(Buffer.from('RIFF')).then((value) => (result = value));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(result).toBeNull();
    expect(stuck.state.cancelled).toBe(true);
  });

  it('logs at most 2 KB of an error answer, on one line, and downloads no more of it', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const state = { pulled: 0, cancelled: false };
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (state.pulled >= 512 * 1024) return controller.close();
          state.pulled += 1024;
          controller.enqueue(new TextEncoder().encode(`${'e'.repeat(1000)}\nINFO forged line\n`.padEnd(1024, 'e')));
        },
        cancel() {
          state.cancelled = true;
        },
      },
      { highWaterMark: 0 }
    );
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(body, { status: 500 })) as never;
    await expect(elevenLabsOnly('hello')).resolves.toBeNull();
    const line = String(error.mock.calls[0][0]);
    expect(line.startsWith('[ElevenLabs TTS] API error 500: eee')).toBe(true);
    expect(line.length).toBeLessThanOrEqual(2048 + 40);
    expect(line).not.toContain('\n');
    expect(state.cancelled).toBe(true);
    expect(state.pulled).toBeLessThanOrEqual(4096);
  });
});

describe('generateSpeech: each provider request is reserved on its own', () => {
  const realFetch = globalThis.fetch;
  const env = { ...process.env };
  const noLimits = { aiCallsPerHour: null, aiTokensPerDay: null, visionPerHour: null, ttsCharsPerDay: null, sttSecondsPerDay: null, autonomyAiPerHour: null, autonomyAiMinIntervalMs: 0 };
  const TEXT = 'x'.repeat(100);
  const ELEVENLABS = 'https://api.elevenlabs.io/';
  const OPENAI = 'https://api.openai.com/';

  /** The speech APIs, answered here: no request leaves the machine */
  function providers(elevenLabs: () => Response | Promise<Response>) {
    const fetch = vi.fn(async (url: string) => (String(url).startsWith(ELEVENLABS) ? elevenLabs() : new Response(Buffer.from('openai-mp3'), { status: 200 })));
    globalThis.fetch = fetch as never;
    return { hosts: () => fetch.mock.calls.map(([url]) => (String(url).startsWith(ELEVENLABS) ? 'elevenlabs' : String(url).startsWith(OPENAI) ? 'openai' : String(url))) };
  }
  const budgetOf = (ttsCharsPerDay: number | null) => {
    const budget = new UsageBudget({ ...noLimits, ttsCharsPerDay });
    resetUsageBudget(budget);
    return budget;
  };
  /** Accepted (200), and then the body fails while it is read */
  const bodyFails = () =>
    new Response(new ReadableStream({ pull: (controller) => controller.error(new Error('connection reset')) }), { status: 200 });

  beforeEach(() => {
    process.env.ELEVENLABS_XI_API_KEY = 'test-key';
    process.env.OPENAI_API_KEY = 'test-openai-key';
    // The OpenAI request these tests read is the /v1/audio/speech one of the legacy models
    process.env.OPENAI_TTS_MODEL = 'tts-1';
    delete process.env.OPENAI_TTS_VOICE;
    for (const method of ['log', 'error', 'warn'] as const) vi.spyOn(console, method).mockImplementation(() => {});
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    for (const key of ['ELEVENLABS_XI_API_KEY', 'OPENAI_API_KEY', 'OPENAI_TTS_MODEL', 'OPENAI_TTS_VOICE']) {
      if (env[key] === undefined) delete process.env[key];
      else process.env[key] = env[key];
    }
    resetUsageBudget();
    vi.restoreAllMocks();
  });

  it.each([
    ['accepted, its body failing as it was read', bodyFails],
    ['a connection error', () => Promise.reject(new TypeError('fetch failed'))],
    ['a server error', () => new Response('busy', { status: 503 })],
  ])('keeps an ElevenLabs request that ended in %s counted, and makes no fallback the daily limit has no room for', async (_what, answer) => {
    const budget = budgetOf(100);
    const { hosts } = providers(answer);
    await expect(generateSpeech(TEXT)).resolves.toBeNull();
    expect(hosts()).toEqual(['elevenlabs']);
    expect(budget.snapshot(60_000)).toMatchObject({ ttsChars: 100, skipped: { tts: 1 } });
  });

  it('falls back to OpenAI under a reservation of its own when the limit has room for both requests', async () => {
    const budget = budgetOf(200);
    const { hosts } = providers(bodyFails);
    expect((await generateSpeech(TEXT))?.toString()).toBe('openai-mp3');
    expect(hosts()).toEqual(['elevenlabs', 'openai']);
    expect(budget.snapshot(60_000).ttsChars).toBe(200);
  });

  it('gives back the characters of a request ElevenLabs refused (a 4xx answer), so the fallback fits the same limit', async () => {
    const budget = budgetOf(100);
    const { hosts } = providers(() => new Response('{"detail":"quota_exceeded"}', { status: 401 }));
    expect((await generateSpeech(TEXT))?.toString()).toBe('openai-mp3');
    expect(hosts()).toEqual(['elevenlabs', 'openai']);
    expect(budget.snapshot(60_000)).toMatchObject({ ttsChars: 100, skipped: { tts: 0 } });
  });

  it('sends nothing and throws TtsLimitReached when the limit has no room even for the first request', async () => {
    const budget = budgetOf(99);
    const { hosts } = providers(() => new Response(Buffer.from('mp3'), { status: 200 }));
    await expect(generateSpeech(TEXT)).rejects.toBeInstanceOf(TtsLimitReached);
    expect(hosts()).toEqual([]);
    expect(budget.snapshot(60_000)).toMatchObject({ ttsChars: 0, skipped: { tts: 1 } });
  });

  it('makes no fallback request, and reserves nothing more, for a turn cancelled while the first request was pending', async () => {
    const budget = budgetOf(1000);
    let fail!: () => void;
    const { hosts } = providers(() => new Promise<Response>((resolve) => (fail = () => resolve(new Response('busy', { status: 503 })))));
    const slot = new AbortController();
    const speaking = runTurn({ origin: 'voice', world: {}, generation: 1, signal: neverAbortedSignal(), cancel: slot.signal }, () => generateSpeech(TEXT));
    await vi.waitFor(() => expect(hosts()).toEqual(['elevenlabs']));
    slot.abort();
    fail();
    await expect(speaking).rejects.toBeInstanceOf(TurnCancelled);
    expect(hosts()).toEqual(['elevenlabs']);
    // The request already sent stays counted
    expect(budget.snapshot(60_000).ttsChars).toBe(100);
  });

  it('counts nothing for a provider without a key: no request is made to it', async () => {
    delete process.env.ELEVENLABS_XI_API_KEY;
    const budget = budgetOf(100);
    const { hosts } = providers(() => new Response(Buffer.from('mp3'), { status: 200 }));
    expect((await generateSpeech(TEXT))?.toString()).toBe('openai-mp3');
    expect(hosts()).toEqual(['openai']);
    expect(budget.snapshot(60_000).ttsChars).toBe(100);
  });
});

describe('the OpenAI fallback reads with gpt-realtime-2.1-mini unless a legacy model is named', () => {
  const realFetch = globalThis.fetch;
  const realWebSocket = globalThis.WebSocket;
  const env = { ...process.env };
  const KEYS = ['ELEVENLABS_XI_API_KEY', 'OPENAI_API_KEY', 'OPENAI_TTS_MODEL', 'OPENAI_TTS_VOICE'];
  const noLimits = { aiCallsPerHour: null, aiTokensPerDay: null, visionPerHour: null, ttsCharsPerDay: null, sttSecondsPerDay: null, autonomyAiPerHour: null, autonomyAiMinIntervalMs: 0 };
  const TEXT = 'いらっしゃいませ！今日は何をお探しですか？';

  /** The Realtime API, answered here (the global WebSocket is replaced): what each session was sent */
  let sockets: { url: string; headers: Record<string, string>; sent: any[] }[];
  let realtimeAnswer: 'reads' | 'refuses' | 'other words';
  let onSessionUpdate: () => void;
  class FakeWebSocket {
    binaryType = 'blob';
    private readonly listeners = new Map<string, ((event: any) => void)[]>();
    private readonly record: { url: string; headers: Record<string, string>; sent: any[] };
    constructor(url: string, init: { headers: Record<string, string> }) {
      this.record = { url, headers: init.headers, sent: [] };
      sockets.push(this.record);
      queueMicrotask(() => (realtimeAnswer === 'refuses' ? (this.emit('error', {}), this.emit('close', { code: 1006 })) : this.serve({ type: 'session.created' })));
    }
    addEventListener(type: string, listener: (event: any) => void) {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }
    send(data: string) {
      const event = JSON.parse(data);
      this.record.sent.push(event);
      if (event.type === 'session.update') {
        onSessionUpdate();
        queueMicrotask(() => this.serve({ type: 'session.updated' }));
      }
      if (event.type === 'response.create') {
        const text = this.record.sent.find((e) => e.type === 'conversation.item.create').item.content[0].text;
        queueMicrotask(() => {
          this.serve({ type: 'response.output_audio.delta', delta: Buffer.alloc(4800).toString('base64') });
          this.serve({ type: 'response.output_audio_transcript.done', transcript: realtimeAnswer === 'other words' ? 'はい、何でしょう？' : text });
          this.serve({ type: 'response.done', response: { status: 'completed' } });
        });
      }
    }
    close() {}
    private emit(type: string, event: any) {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }
    private serve(event: object) {
      this.emit('message', { data: JSON.stringify(event) });
    }
  }

  /** The speech module and the budget as a new process has them (no warning given yet) */
  async function fresh(ttsCharsPerDay: number | null = null) {
    vi.resetModules();
    const budgetModule = await import('../usage-budget');
    const utils = await import('./utils');
    const turns = await import('./lib/turn-context');
    const budget = new budgetModule.UsageBudget({ ...noLimits, ttsCharsPerDay });
    budgetModule.resetUsageBudget(budget);
    return { ...utils, ...turns, budget };
  }
  let fetchCalls: string[];
  let elevenLabsAnswer: () => Response;
  const warnings = () => vi.mocked(console.warn).mock.calls.map((args) => String(args[0]));

  beforeEach(() => {
    sockets = [];
    fetchCalls = [];
    realtimeAnswer = 'reads';
    onSessionUpdate = () => {};
    elevenLabsAnswer = () => new Response('busy', { status: 503 });
    globalThis.WebSocket = FakeWebSocket as never;
    globalThis.fetch = vi.fn(async (url: string) => {
      fetchCalls.push(String(url));
      return String(url).startsWith('https://api.elevenlabs.io/') ? elevenLabsAnswer() : new Response(Buffer.from('openai-mp3'), { status: 200 });
    }) as never;
    process.env.ELEVENLABS_XI_API_KEY = 'test-key';
    process.env.OPENAI_API_KEY = 'test-openai-key';
    delete process.env.OPENAI_TTS_MODEL;
    delete process.env.OPENAI_TTS_VOICE;
    for (const method of ['log', 'error', 'warn'] as const) vi.spyOn(console, method).mockImplementation(() => {});
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    globalThis.WebSocket = realWebSocket;
    for (const key of KEYS) {
      if (env[key] === undefined) delete process.env[key];
      else process.env[key] = env[key];
    }
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('with OPENAI_TTS_MODEL empty: ElevenLabs failed, the Realtime session reads the text in marin, each request reserved on its own', async () => {
    const { generateSpeech, budget } = await fresh();
    process.env.OPENAI_TTS_MODEL = '';
    const audio = await generateSpeech(TEXT);
    expect(audio?.toString('ascii', 0, 4)).toBe('RIFF');
    expect(audio?.readUInt32LE(24)).toBe(24000);
    expect(fetchCalls.map((url) => new URL(url).host)).toEqual(['api.elevenlabs.io']);
    expect(sockets).toHaveLength(1);
    expect(sockets[0].url).toBe('wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1-mini');
    expect(sockets[0].headers).toEqual({ Authorization: 'Bearer test-openai-key' });
    expect(sockets[0].sent[0].session.audio.output.voice).toBe('marin');
    expect(sockets[0].sent[1].item.content[0].text).toBe(TEXT);
    expect(budget.snapshot(60_000).ttsChars).toBe(2 * TEXT.length);
  });

  it('named explicitly, the same; a voice of its own list is used, any other becomes marin with one warning', async () => {
    const { generateSpeech } = await fresh();
    process.env.OPENAI_TTS_MODEL = 'gpt-realtime-2.1-mini';
    process.env.OPENAI_TTS_VOICE = 'cedar';
    await generateSpeech(TEXT);
    process.env.OPENAI_TTS_VOICE = 'nova';
    await generateSpeech(TEXT);
    await generateSpeech(TEXT);
    expect(sockets.map((s) => s.sent[0].session.audio.output.voice)).toEqual(['cedar', 'marin', 'marin']);
    expect(warnings()).toEqual([
      '[OpenAI TTS] OPENAI_TTS_VOICE is not one of the voices of gpt-realtime-2.1-mini (alloy, ash, ballad, coral, echo, sage, shimmer, verse, marin, cedar): using marin',
    ]);
  });

  it('a refused connection gives the reservation back; a reading in other words keeps it and plays nothing', async () => {
    const refused = await fresh(1000);
    realtimeAnswer = 'refuses';
    await expect(refused.generateSpeech(TEXT)).resolves.toBeNull();
    expect(refused.budget.snapshot(60_000).ttsChars).toBe(TEXT.length);

    const otherWords = await fresh(1000);
    realtimeAnswer = 'other words';
    await expect(otherWords.generateSpeech(TEXT)).resolves.toBeNull();
    expect(otherWords.budget.snapshot(60_000).ttsChars).toBe(2 * TEXT.length);
  });

  it('another Realtime, Live or audio model is refused without a request, with one warning', async () => {
    const { generateSpeech, budget } = await fresh();
    for (const model of ['gpt-live-1.1', 'gpt-realtime-translate', 'gpt-audio-1.5', 'gpt-4o-realtime-preview', 'gpt-4o-mini-audio-preview']) {
      process.env.OPENAI_TTS_MODEL = model;
      await expect(generateSpeech(TEXT)).resolves.toBeNull();
      await expect(generateSpeech(TEXT)).resolves.toBeNull();
    }
    expect(sockets).toEqual([]);
    expect(fetchCalls.every((url) => url.startsWith('https://api.elevenlabs.io/'))).toBe(true);
    expect(warnings()).toHaveLength(5);
    expect(warnings()[0]).toBe('[OpenAI TTS] OPENAI_TTS_MODEL names a model this agent does not read text with: the OpenAI voice is off. Leave it empty for gpt-realtime-2.1-mini.');
    // The refused fallback's characters were given back: only the ten ElevenLabs requests count
    expect(budget.snapshot(60_000).ttsChars).toBe(10 * TEXT.length);
  });

  it('a setting that is not a model id is refused without a request, with one warning', async () => {
    const { generateSpeech } = await fresh();
    for (const model of ['gpt-realtime-2.1-mini\nX-Injected: 1', 'GPT-Realtime-2.1-Mini', 'tts 1']) {
      process.env.OPENAI_TTS_MODEL = model;
      await expect(generateSpeech(TEXT)).resolves.toBeNull();
    }
    expect(sockets).toEqual([]);
    expect(fetchCalls.every((url) => url.startsWith('https://api.elevenlabs.io/'))).toBe(true);
    expect(warnings()).toEqual(['[OpenAI TTS] OPENAI_TTS_MODEL is not a model id (lower-case letters, digits, ".", "_" and "-"): the OpenAI voice is off.']);
  });

  it('a legacy model keeps /v1/audio/speech and its own default voice, with one warning about its shutdown', async () => {
    const { generateSpeech } = await fresh();
    process.env.OPENAI_TTS_MODEL = 'tts-1';
    expect((await generateSpeech(TEXT))?.toString()).toBe('openai-mp3');
    expect((await generateSpeech(TEXT))?.toString()).toBe('openai-mp3');
    expect(sockets).toEqual([]);
    const speechRequest = vi.mocked(globalThis.fetch).mock.calls.find(([url]) => String(url) === 'https://api.openai.com/v1/audio/speech');
    expect(JSON.parse(String((speechRequest![1] as RequestInit).body))).toMatchObject({ model: 'tts-1', voice: 'nova', response_format: 'mp3' });
    expect(warnings()).toEqual(['[OpenAI TTS] OPENAI_TTS_MODEL=tts-1 shuts down on 2027-01-06: leave OPENAI_TTS_MODEL empty to use gpt-realtime-2.1-mini instead.']);
  });

  it('audio that reads a reply without its decorative emoji is marked as saying only part of it', async () => {
    const { generateSpeech, isPartialSpeech } = await fresh();
    const decorated = await generateSpeech('いらっしゃいませ😊');
    expect(sockets.at(-1)!.sent[1].item.content[0].text).toBe('いらっしゃいませ');
    expect(isPartialSpeech(decorated!)).toBe(true);
    const plain = await generateSpeech(TEXT);
    expect(isPartialSpeech(plain!)).toBe(false);
  });

  it('an ElevenLabs answer with no audio in it falls back to OpenAI, and stays counted', async () => {
    const { generateSpeech, budget } = await fresh();
    elevenLabsAnswer = () => new Response(new Uint8Array(0), { status: 200 });
    const audio = await generateSpeech(TEXT);
    expect(audio?.toString('ascii', 0, 4)).toBe('RIFF');
    expect(sockets).toHaveLength(1);
    expect(budget.snapshot(60_000).ttsChars).toBe(2 * TEXT.length);
    expect(vi.mocked(console.error).mock.calls.map((args) => String(args[0]))).toContain('[TTS] ElevenLabs answered with no audio');
  });

  it('a turn cancelled while the session is set up sends no text, and its fallback reservation is given back', async () => {
    const { generateSpeech, budget, runTurn, neverAbortedSignal } = await fresh();
    delete process.env.ELEVENLABS_XI_API_KEY;
    const slot = new AbortController();
    onSessionUpdate = () => slot.abort();
    const speaking = runTurn({ origin: 'voice', world: {}, generation: 1, signal: neverAbortedSignal(), cancel: slot.signal }, () => generateSpeech(TEXT));
    await expect(speaking).resolves.toBeNull();
    expect(sockets).toHaveLength(1);
    expect(sockets[0].sent.map((e) => e.type)).toEqual(['session.update']);
    expect(budget.snapshot(60_000).ttsChars).toBe(0);
  });

  it("gives the reader the turn: its signal, and whether it may still act (a completed turn's signal no longer follows its session)", async () => {
    const { generateSpeech, runTurn } = await fresh();
    const reader = await import('./lib/realtime-speech');
    const seen: { signal?: AbortSignal; live?: () => boolean }[] = [];
    vi.spyOn(reader, 'realtimeSpeech').mockImplementation(async (_text, options) => (seen.push(options), { audio: null, mayBeBilled: false }));
    delete process.env.ELEVENLABS_XI_API_KEY;
    const session = new AbortController();
    await runTurn({ origin: 'voice', world: {}, generation: 1, signal: session.signal }, () => generateSpeech(TEXT));
    expect(seen).toHaveLength(1);
    expect(seen[0].signal).toBeInstanceOf(AbortSignal);
    expect(seen[0].live!()).toBe(true);
    // The turn has completed; its session ends now. Its own signal no longer follows, live does
    session.abort();
    expect(seen[0].signal!.aborted).toBe(false);
    expect(seen[0].live!()).toBe(false);
    // Outside any turn there is neither
    await generateSpeech(TEXT);
    expect(seen[1].signal).toBeUndefined();
    expect(seen[1].live).toBeUndefined();
  });

  it('opens no connection when the agent loads with an OpenAI key, until something is to be spoken', async () => {
    vi.resetModules();
    await import('./utils');
    await import('./lib/realtime-speech');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sockets).toEqual([]);
  });
});
