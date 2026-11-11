import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventType, ModelType } from '@elizaos/core';

const create = vi.fn();
const constructed: any[] = [];
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create };
    constructor(options: any) {
      constructed.push(options);
    }
  },
}));

import { AnthropicRefusalError, anthropicModelsPlugin, parseJsonResponse, toImageSource, tokenReserve } from './anthropic-models';
import { AiBudgetExceededError, UsageBudget, type UsageLimits, resetUsageBudget, runWithOrigin } from './usage-budget';

function runtime(settings: Record<string, string> = {}): any {
  return {
    getSetting: (key: string) => settings[key],
    character: { system: 'You are Coo.' },
    emitEvent: vi.fn().mockResolvedValue(undefined),
  };
}
const usage = { input_tokens: 12, output_tokens: 3 };
const reply = (content: any[], stop_reason = 'end_turn') => ({ content, stop_reason, usage });
const models = anthropicModelsPlugin.models as Record<string, (rt: any, params: any) => Promise<any>>;

describe('anthropicModelsPlugin', () => {
  beforeEach(() => {
    create.mockReset();
    create.mockResolvedValue(reply([{ type: 'text', text: 'ok' }]));
    // The environment wins over the runtime's settings: what the shell has set must not decide these tests
    for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_SMALL_MODEL', 'ANTHROPIC_LARGE_MODEL', 'ANTHROPIC_EFFORT']) vi.stubEnv(key, '');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('sends no sampling parameters, which current models reject, from any of its model types', async () => {
    const sampling = { temperature: 0.7, topP: 0.9, topK: 40, frequencyPenalty: 0.7, presencePenalty: 0.7 };
    create.mockResolvedValue(reply([{ type: 'text', text: '{"a":1}' }]));
    for (const type of [ModelType.TEXT_SMALL, ModelType.TEXT_LARGE, ModelType.OBJECT_SMALL, ModelType.OBJECT_LARGE]) await models[type](runtime(), { prompt: 'hello', ...sampling });
    await models[ModelType.IMAGE_DESCRIPTION](runtime(), { imageUrl: 'https://x.test/a.png', prompt: 'p', ...sampling });
    expect(create).toHaveBeenCalledTimes(5);
    for (const [body] of create.mock.calls) {
      expect(Object.keys(body).sort()).toEqual(expect.arrayContaining(['max_tokens', 'messages', 'model', 'output_config']));
      for (const key of ['temperature', 'top_p', 'top_k', 'frequency_penalty', 'presence_penalty', 'topP', 'topK', 'frequencyPenalty', 'presencePenalty']) {
        expect(body).not.toHaveProperty(key);
      }
    }
  });

  it('uses Haiku 5.5 at low effort by default, and the configured models otherwise', async () => {
    await models[ModelType.TEXT_SMALL](runtime(), { prompt: 'a' });
    await models[ModelType.TEXT_LARGE](runtime(), { prompt: 'a' });
    for (const [body] of create.mock.calls.slice(0, 2)) expect(body).toMatchObject({ model: 'claude-haiku-5-5', output_config: { effort: 'low' }, system: 'You are Coo.' });

    const configured = { ANTHROPIC_SMALL_MODEL: 'claude-haiku-9', ANTHROPIC_LARGE_MODEL: 'claude-sonnet-5-5', ANTHROPIC_EFFORT: 'medium' };
    await models[ModelType.TEXT_LARGE](runtime(configured), { prompt: 'b' });
    expect(create.mock.calls[2][0]).toMatchObject({ model: 'claude-sonnet-5-5', output_config: { effort: 'medium' } });
    await models[ModelType.TEXT_SMALL](runtime(configured), { prompt: 'b' });
    expect(create.mock.calls[3][0]).toMatchObject({ model: 'claude-haiku-9', output_config: { effort: 'medium' } });
  });

  it('lets the SDK retry nothing', async () => {
    await models[ModelType.TEXT_SMALL](runtime(), { prompt: 'a' });
    expect(create.mock.calls[0][1].maxRetries).toBe(0);
  });

  describe('one overall deadline, on a fake clock', () => {
    /**
     * AbortSignal.timeout runs on the fake clock here: the signal it gives aborts when the fake
     * clock has gone `ms` further. The request, as the SDK's fetch does, rejects once its signal aborts.
     */
    function onFakeClock() {
      vi.useFakeTimers();
      const deadlines: number[] = [];
      vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
        deadlines.push(ms);
        const controller = new AbortController();
        setTimeout(() => controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')), ms);
        return controller.signal;
      });
      const stalls = (_body: unknown, { signal }: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      const call = () => {
        const state: { outcome: unknown } = { outcome: 'pending' };
        void models[ModelType.TEXT_LARGE](runtime(), { prompt: 'x', purpose: 'chat' }).then(
          (value) => (state.outcome = value),
          (error) => (state.outcome = error)
        );
        return state;
      };
      return { deadlines, stalls, call };
    }
    const overloaded = () => Object.assign(new Error('overloaded'), { status: 529 });
    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it('gives up on a request that never answers 60 s after the call started', async () => {
      const { deadlines, stalls, call } = onFakeClock();
      create.mockImplementation(stalls);
      const state = call();
      await vi.advanceTimersByTimeAsync(59_999);
      expect(state.outcome).toBe('pending');
      await vi.advanceTimersByTimeAsync(1);
      expect(state.outcome).toMatchObject({ name: 'TimeoutError' });
      expect(deadlines).toEqual([60_000]);
    });

    it('counts the time of the first attempt and the wait before the retry against the same deadline', async () => {
      const { deadlines, stalls, call } = onFakeClock();
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      // Overloaded after 30 s; the retry then never answers
      create.mockImplementationOnce(() => new Promise((_resolve, reject) => setTimeout(() => reject(overloaded()), 30_000))).mockImplementation(stalls);
      const state = call();
      await vi.advanceTimersByTimeAsync(31_000);
      expect(create).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(28_999);
      expect(state.outcome).toBe('pending');
      await vi.advanceTimersByTimeAsync(1);
      expect(state.outcome).toMatchObject({ name: 'TimeoutError' });
      // One deadline for both attempts
      expect(deadlines).toEqual([60_000]);
      expect(create.mock.calls[0][1].signal).toBe(create.mock.calls[1][1].signal);
    });

    it('makes no retry that could not be answered before the deadline', async () => {
      const { call } = onFakeClock();
      const error = overloaded();
      create.mockImplementation(() => new Promise((_resolve, reject) => setTimeout(() => reject(error), 59_500)));
      const state = call();
      await vi.advanceTimersByTimeAsync(59_500);
      expect(state.outcome).toBe(error);
      expect(create).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['1 s when the answer names no wait', {}, 1000],
      ['the retry-after the answer names', { 'retry-after': '2' }, 2000],
      ['its retry-after-ms, which wins over retry-after', { 'retry-after-ms': '250', 'retry-after': '4' }, 250],
      ['at most 5 s, whatever the answer names', { 'retry-after': '30' }, 5000],
    ])('waits %s before the one more attempt', async (_what, headers: Record<string, string>, wait) => {
      const { call } = onFakeClock();
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const error = Object.assign(overloaded(), { headers: { get: (name: string) => headers[name] ?? null } });
      create.mockRejectedValueOnce(error);
      const state = call();
      await vi.advanceTimersByTimeAsync(wait - 1);
      expect(create).toHaveBeenCalledTimes(1);
      expect(state.outcome).toBe('pending');
      await vi.advanceTimersByTimeAsync(1);
      expect(create).toHaveBeenCalledTimes(2);
      expect(state.outcome).toBe('ok');
    });
  });

  it('returns only text blocks (thinking blocks are skipped)', async () => {
    create.mockResolvedValue(reply([{ type: 'thinking', thinking: '' }, { type: 'text', text: 'Hello' }, { type: 'text', text: '!' }]));
    await expect(models[ModelType.TEXT_SMALL](runtime(), { prompt: 'x' })).resolves.toBe('Hello!');
  });

  it('forwards maxTokens and non-empty stop sequences', async () => {
    await models[ModelType.TEXT_SMALL](runtime(), { prompt: 'x', maxTokens: 256, stopSequences: ['', '  ', '</response>'] });
    expect(create.mock.calls[0][0]).toMatchObject({ max_tokens: 256, stop_sequences: ['</response>'] });

    await models[ModelType.TEXT_SMALL](runtime(), { prompt: 'x', stopSequences: [] });
    expect(create.mock.calls[1][0]).not.toHaveProperty('stop_sequences');
  });

  it('answers streaming requests with the full text', async () => {
    await expect(models[ModelType.TEXT_SMALL](runtime(), { prompt: 'x', stream: true })).resolves.toBe('ok');
  });

  it('falls back to low effort for an invalid ANTHROPIC_EFFORT instead of failing every request', async () => {
    await models[ModelType.TEXT_SMALL](runtime({ ANTHROPIC_EFFORT: 'lowest' }), { prompt: 'x' });
    await models[ModelType.TEXT_SMALL](runtime({ ANTHROPIC_EFFORT: 'High' }), { prompt: 'x' });
    expect(create.mock.calls.map((c) => c[0].output_config.effort)).toEqual(['low', 'high']);
  });

  it('emits MODEL_USED with the token counts of the answer', async () => {
    const rt = runtime();
    await models[ModelType.TEXT_LARGE](rt, { prompt: 'hello' });
    expect(rt.emitEvent).toHaveBeenCalledWith(EventType.MODEL_USED, {
      provider: 'anthropic',
      type: ModelType.TEXT_LARGE,
      prompt: 'hello',
      tokens: { prompt: 12, completion: 3, total: 15 },
    });
  });

  it('throws AnthropicRefusalError for a refusal, from text and from object calls, after one request each whose usage is counted and reported', async () => {
    create.mockResolvedValue({ ...reply([{ type: 'text', text: 'partial' }], 'refusal'), stop_details: { category: 'cyber' } });
    const budget = new UsageBudget({ aiCallsPerHour: null, aiTokensPerDay: null, visionPerHour: null, ttsCharsPerDay: null, sttSecondsPerDay: null, autonomyAiPerHour: null, autonomyAiMinIntervalMs: 0 });
    resetUsageBudget(budget);
    try {
      const rt = runtime();
      for (const type of [ModelType.TEXT_LARGE, ModelType.OBJECT_LARGE]) {
        const error = await models[type](rt, { prompt: 'x' }).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(AnthropicRefusalError);
        expect((error as Error).message).toBe('[Anthropic] claude-haiku-5-5 declined the request (cyber)');
      }
      // One request per call: the handler itself does not ask again
      expect(create).toHaveBeenCalledTimes(2);
      expect(rt.emitEvent.mock.calls.map(([type, payload]: [string, { tokens: unknown }]) => [type, payload.tokens])).toEqual([
        [EventType.MODEL_USED, { prompt: 12, completion: 3, total: 15 }],
        [EventType.MODEL_USED, { prompt: 12, completion: 3, total: 15 }],
      ]);
      expect(budget.snapshot(60_000).ai).toMatchObject({ calls: 2, inputTokens: 24, outputTokens: 6, reservedTokens: 0 });
    } finally {
      resetUsageBudget();
    }
  });

  it('reuses a client per API key and picks up a changed key', async () => {
    constructed.length = 0;
    await models[ModelType.TEXT_SMALL](runtime({ ANTHROPIC_API_KEY: 'key-a' }), { prompt: 'x' });
    await models[ModelType.TEXT_SMALL](runtime({ ANTHROPIC_API_KEY: 'key-a' }), { prompt: 'x' });
    await models[ModelType.TEXT_SMALL](runtime({ ANTHROPIC_API_KEY: 'key-b' }), { prompt: 'x' });
    expect(constructed.map((o) => o.apiKey)).toEqual(['key-a', 'key-b']);
  });

  it('prefers .env over the copy of the settings elizaOS keeps in its database', async () => {
    constructed.length = 0;
    // Restored by the afterEach above
    vi.stubEnv('ANTHROPIC_API_KEY', 'key-from-env');
    vi.stubEnv('ANTHROPIC_LARGE_MODEL', 'claude-sonnet-5-5');
    await models[ModelType.TEXT_LARGE](runtime({ ANTHROPIC_API_KEY: 'stale-key-in-db', ANTHROPIC_LARGE_MODEL: 'old-model' }), { prompt: 'x' });
    expect(constructed.map((o) => o.apiKey)).toEqual(['key-from-env']);
    expect(create.mock.calls[0][0].model).toBe('claude-sonnet-5-5');
  });

  // That the real SDK then runs next to a global window and document: anthropic-models.sdk.test.ts
  it('creates the SDK client with dangerouslyAllowBrowser', async () => {
    constructed.length = 0;
    await models[ModelType.TEXT_SMALL](runtime({ ANTHROPIC_API_KEY: 'key-c' }), { prompt: 'x' });
    expect(constructed[0].dangerouslyAllowBrowser).toBe(true);
  });

  it('OBJECT_* forwards the maxTokens core injects from model settings', async () => {
    create.mockResolvedValue(reply([{ type: 'text', text: '{"a":1}' }]));
    await models[ModelType.OBJECT_SMALL](runtime(), { prompt: 'x', maxTokens: 256 });
    await models[ModelType.OBJECT_LARGE](runtime(), { prompt: 'x', maxTokens: 512 });
    expect(create.mock.calls.map((c) => c[0].max_tokens)).toEqual([256, 512]);
  });

  it('OBJECT_* asks for JSON and parses fenced output', async () => {
    create.mockResolvedValue(reply([{ type: 'text', text: '```json\n{"entity": "abc"}\n```' }]));
    await expect(models[ModelType.OBJECT_LARGE](runtime(), { prompt: 'Where?' })).resolves.toEqual({ entity: 'abc' });
    const body = create.mock.calls[0][0];
    expect(body.system).toContain('valid JSON only');
    expect(body.messages[0].content).toContain('respond with valid JSON only');
  });

  it('IMAGE_DESCRIPTION sends the snapshot to Claude and returns a description', async () => {
    create.mockResolvedValue(reply([{ type: 'text', text: 'A fountain in a plaza.' }]));
    const result = await models[ModelType.IMAGE_DESCRIPTION](runtime(), { imageUrl: '/9j/4AAQSkZJRg==', prompt: 'What do you see?' });
    expect(result).toEqual({ title: 'Image description', description: 'A fountain in a plaza.' });
    const content = create.mock.calls[0][0].messages[0].content;
    expect(content[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: '/9j/4AAQSkZJRg==' } });
    expect(content[1]).toEqual({ type: 'text', text: 'What do you see?' });
  });

  it('caps output per purpose, over any value core injected from model settings', async () => {
    await models[ModelType.TEXT_LARGE](runtime(), { prompt: 'x', purpose: 'chat', maxTokens: 9000 });
    create.mockResolvedValue(reply([{ type: 'text', text: '{"navigationType":"entity"}' }]));
    await models[ModelType.OBJECT_LARGE](runtime(), { prompt: 'x', purpose: 'navigation' });
    create.mockResolvedValue(reply([{ type: 'text', text: '<response/>' }]));
    await models[ModelType.IMAGE_DESCRIPTION](runtime(), { imageUrl: 'https://x.test/a.png', prompt: 'p', purpose: 'vision' });
    expect(create.mock.calls.map((c) => c[0].max_tokens)).toEqual([2048, 1024, 2048]);
    // The purpose tag is not sent to the API
    for (const [body] of create.mock.calls) expect(JSON.stringify(body)).not.toContain('purpose');
  });

  it('meters each call by purpose and origin', async () => {
    const budget = new UsageBudget({
      aiCallsPerHour: null,
      aiTokensPerDay: null,
      visionPerHour: null,
      ttsCharsPerDay: null,
      sttSecondsPerDay: null,
      autonomyAiPerHour: null,
      autonomyAiMinIntervalMs: 0,
    });
    resetUsageBudget(budget);
    try {
      await runWithOrigin('autonomous', () => models[ModelType.TEXT_LARGE](runtime(), { prompt: 'x', purpose: 'autonomous' }));
      await models[ModelType.TEXT_SMALL](runtime(), { prompt: 'x' });
      const s = budget.snapshot(60_000);
      expect(s.ai.byPurpose.autonomous).toMatchObject({ calls: 1, inputTokens: 12, outputTokens: 3 });
      expect(s.ai.byPurpose[ModelType.TEXT_SMALL]).toMatchObject({ calls: 1 });
      expect(s.ai.byOrigin).toEqual({ autonomous: 1, other: 1 });
    } finally {
      resetUsageBudget();
    }
  });

  it('refuses calls without contacting the API once the Claude budget is used up', async () => {
    const budget = new UsageBudget({
      aiCallsPerHour: 1,
      aiTokensPerDay: null,
      visionPerHour: null,
      ttsCharsPerDay: null,
      sttSecondsPerDay: null,
      autonomyAiPerHour: null,
      autonomyAiMinIntervalMs: 0,
    });
    resetUsageBudget(budget);
    try {
      await models[ModelType.TEXT_LARGE](runtime(), { prompt: 'x', purpose: 'chat' });
      await expect(models[ModelType.TEXT_LARGE](runtime(), { prompt: 'x', purpose: 'chat' })).rejects.toBeInstanceOf(AiBudgetExceededError);
      expect(create).toHaveBeenCalledTimes(1);
      expect(budget.snapshot(60_000).skipped['ai-call']).toBe(1);
    } finally {
      resetUsageBudget();
    }
  });

  describe('with limits (the budget is reserved before the request)', () => {
    const limits = (over: Partial<UsageLimits>) =>
      new UsageBudget({ aiCallsPerHour: null, aiTokensPerDay: null, visionPerHour: null, ttsCharsPerDay: null, sttSecondsPerDay: null, autonomyAiPerHour: null, autonomyAiMinIntervalMs: 0, ...over });
    const text = (rt = runtime()) => models[ModelType.TEXT_LARGE](rt, { prompt: 'x', purpose: 'chat' });

    it('makes exactly AI_MAX_CALLS_PER_HOUR requests when many calls start at the same time', async () => {
      const budget = limits({ aiCallsPerHour: 3 });
      resetUsageBudget(budget);
      try {
        // No request has returned while the others ask
        let answer!: () => void;
        const answered = new Promise<void>((resolve) => (answer = resolve));
        create.mockImplementation(async () => {
          await answered;
          return reply([{ type: 'text', text: 'ok' }]);
        });
        const calls = Array.from({ length: 12 }, () => text().then(() => 'made', (error) => error));
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(create).toHaveBeenCalledTimes(3);
        answer();
        const results = await Promise.all(calls);
        expect(results.filter((r) => r === 'made')).toHaveLength(3);
        expect(results.filter((r) => r instanceof AiBudgetExceededError)).toHaveLength(9);
        expect(create).toHaveBeenCalledTimes(3);
        expect(budget.snapshot(60_000)).toMatchObject({ ai: { calls: 3 }, skipped: { 'ai-call': 9 } });
      } finally {
        resetUsageBudget();
      }
    });

    it('never has more tokens in flight than AI_MAX_TOKENS_PER_DAY has room for, and frees what a call did not use', async () => {
      // Each call reserves its prompt bytes ("You are Coo." + "x" + framing) plus the chat output cap
      const each = tokenReserve('You are Coo.', 'x', 2048);
      const budget = limits({ aiTokensPerDay: each * 2 + 10 });
      resetUsageBudget(budget);
      try {
        let answer!: () => void;
        const answered = new Promise<void>((resolve) => (answer = resolve));
        create.mockImplementation(async () => {
          await answered;
          return reply([{ type: 'text', text: 'ok' }]);
        });
        const calls = Array.from({ length: 8 }, () => text().then(() => 'made', (error) => error));
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(create).toHaveBeenCalledTimes(2);
        expect(budget.snapshot(60_000).ai.reservedTokens).toBe(each * 2);
        answer();
        expect((await Promise.all(calls)).filter((r) => r === 'made')).toHaveLength(2);
        // Each used 15 tokens of what it reserved: the rest is available again
        expect(budget.snapshot(60_000).ai).toMatchObject({ calls: 2, inputTokens: 24, outputTokens: 6, reservedTokens: 0 });
        await expect(text()).resolves.toBe('ok');
      } finally {
        resetUsageBudget();
      }
    });

    it('reserves at least what the request can cost: the bytes of system and prompt, the output cap, and a fixed amount per image', () => {
      expect(tokenReserve(undefined, '', 100)).toBe(164);
      expect(tokenReserve('sys', 'prompt', 100)).toBe(164 + 3 + 6);
      // Bytes, not characters: Japanese text is three bytes a character and about a token each
      expect(tokenReserve(undefined, 'こんにちは', 0)).toBe(64 + 15);
      expect(tokenReserve(undefined, [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'A'.repeat(100_000) } }, { type: 'text', text: 'look' }], 0)).toBe(64 + 5000 + 4);
    });

    it.each([
      ['a timeout', Object.assign(new Error('Request timed out.'), { name: 'APIConnectionTimeoutError' }), 1],
      ['an abort', Object.assign(new Error('Request was aborted.'), { name: 'APIUserAbortError' }), 1],
      ['a server error', Object.assign(new Error('internal error'), { status: 500 }), 1],
      ['a conflict', Object.assign(new Error('conflict'), { status: 409 }), 1],
      ['a request timeout answer (408)', Object.assign(new Error('request timeout'), { status: 408 }), 1],
      ['a request the API refused (400)', Object.assign(new Error('bad request'), { status: 400 }), 0],
      ['an invalid key (401)', Object.assign(new Error('invalid x-api-key'), { status: 401 }), 0],
      ['a request the API forbade (403)', Object.assign(new Error('forbidden'), { status: 403 }), 0],
    ])('counts a call that failed with %s as a call, and its reservation as used unless the API refused it; it is not tried again', async (_what, error, held) => {
      const each = tokenReserve('You are Coo.', 'x', 2048);
      const budget = limits({ aiCallsPerHour: 2, aiTokensPerDay: each * 2 });
      resetUsageBudget(budget);
      try {
        create.mockRejectedValue(error);
        await expect(text()).rejects.toBe(error);
        expect(budget.snapshot(60_000).ai).toMatchObject({ calls: 1, inputTokens: 0, outputTokens: 0, reservedTokens: held * each });
        await expect(text()).rejects.toBe(error);
        // Two failed calls are two calls
        await expect(text()).rejects.toBeInstanceOf(AiBudgetExceededError);
        expect(create).toHaveBeenCalledTimes(2);
      } finally {
        resetUsageBudget();
      }
    });

    it('makes no request with the budget set to 0', async () => {
      for (const off of [{ aiCallsPerHour: 0 }, { aiTokensPerDay: 0 }]) {
        resetUsageBudget(limits(off));
        try {
          await expect(text()).rejects.toBeInstanceOf(AiBudgetExceededError);
        } finally {
          resetUsageBudget();
        }
      }
      expect(create).not.toHaveBeenCalled();
    });
  });

  it('IMAGE_DESCRIPTION also accepts a bare image string', async () => {
    create.mockResolvedValue(reply([{ type: 'text', text: 'A tree.' }]));
    const result = await models[ModelType.IMAGE_DESCRIPTION](runtime(), 'https://x.test/a.png');
    expect(result.description).toBe('A tree.');
    expect(create.mock.calls[0][0].messages[0].content[0].source).toEqual({ type: 'url', url: 'https://x.test/a.png' });
  });
});

describe('toImageSource', () => {
  it('handles URLs, data URLs and bare base64', () => {
    expect(toImageSource('https://x.test/a.png')).toEqual({ type: 'url', url: 'https://x.test/a.png' });
    expect(toImageSource('data:image/png;base64,iVBORw0KGgo=')).toEqual({ type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' });
    expect(toImageSource('iVBORw0KGgo=')).toMatchObject({ media_type: 'image/png' });
    expect(toImageSource('/9j/4AAQ')).toMatchObject({ media_type: 'image/jpeg' });
  });
});

describe('parseJsonResponse', () => {
  it('parses plain, fenced, and prose-wrapped JSON', () => {
    expect(parseJsonResponse('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonResponse('```\n[1,2]\n```')).toEqual([1, 2]);
    expect(parseJsonResponse('Sure! {"a": {"b": "}"}} Hope that helps')).toEqual({ a: { b: '}' } });
    expect(parseJsonResponse('[result] {"entityId": "abc"}')).toEqual({ entityId: 'abc' });
  });

  it('repairs comments and trailing commas copied from prompt examples', () => {
    // actions/use.ts shows `"entityId": "<string>" // or null if none`
    expect(parseJsonResponse('{\n  "entityId": null // or null if none\n}')).toEqual({ entityId: null });
    expect(parseJsonResponse('{"a": 1, "b": [1, 2,],}')).toEqual({ a: 1, b: [1, 2] });
  });

  it('repairs the complete value instead of returning a valid nested fragment', () => {
    // goto.ts needs navigationType + parameter, not just the inner object
    expect(parseJsonResponse('{"navigationType":"entity","parameter":{"entityId":"abc"},}')).toEqual({
      navigationType: 'entity',
      parameter: { entityId: 'abc' },
    });
    expect(parseJsonResponse('[result] {"entityId":"abc",}')).toEqual({ entityId: 'abc' });
  });

  it('throws when there is no JSON object or array, even if a primitive parses or repair could make one', () => {
    expect(() => parseJsonResponse('no json here')).toThrow('did not return valid JSON');
    expect(() => parseJsonResponse('```\nhello\n```')).toThrow('did not return valid JSON');
    expect(() => parseJsonResponse('```json\nnull\n```')).toThrow('did not return valid JSON');
    expect(() => parseJsonResponse('```json\n"some text"\n```')).toThrow('did not return valid JSON');
    expect(() => parseJsonResponse('[result]')).toThrow('did not return valid JSON');
  });
});
