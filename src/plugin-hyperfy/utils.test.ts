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
    for (const method of ['log', 'error'] as const) vi.spyOn(console, method).mockImplementation(() => {});
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    for (const key of ['ELEVENLABS_XI_API_KEY', 'OPENAI_API_KEY']) {
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
    for (const method of ['log', 'error'] as const) vi.spyOn(console, method).mockImplementation(() => {});
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    for (const key of ['ELEVENLABS_XI_API_KEY', 'OPENAI_API_KEY']) {
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
