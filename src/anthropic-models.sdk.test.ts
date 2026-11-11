import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ModelType } from '@elizaos/core';
import { closeServers, startServer, type TestServer } from './plugin-hyperfy/test-support/net';
import { anthropicModelsPlugin, tokenReserve } from './anthropic-models';
import { AiBudgetExceededError, UsageBudget, type UsageLimits, resetUsageBudget } from './usage-budget';

/*
 * The real Anthropic SDK against a Messages API on loopback (ANTHROPIC_BASE_URL): every request
 * the SDK sends is one the server sees, retries included. Nothing leaves the machine.
 */

const models = anthropicModelsPlugin.models as Record<string, (rt: any, params: any) => Promise<any>>;
const noLimits: UsageLimits = { aiCallsPerHour: null, aiTokensPerDay: null, visionPerHour: null, ttsCharsPerDay: null, sttSecondsPerDay: null, autonomyAiPerHour: null, autonomyAiMinIntervalMs: 0 };
const runtime = (): any => ({ getSetting: () => undefined, character: { system: 'You are Coo.' }, emitEvent: vi.fn().mockResolvedValue(undefined) });
const message = { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 12, output_tokens: 3 } };
const each = tokenReserve('You are Coo.', 'x', 2048);

type Answer = 'drop' | { status: number; body?: unknown; headers?: Record<string, string> };
let answers: Answer[] = [];
let api: TestServer;
let key = 0;

beforeAll(async () => {
  api = await startServer((_request, response) => {
    const answer = answers.shift() ?? { status: 200, body: message };
    // The request arrived; the connection is lost before any answer
    if (answer === 'drop') return void response.socket?.destroy();
    response.writeHead(answer.status, { 'content-type': 'application/json', ...answer.headers });
    response.end(JSON.stringify(answer.body ?? { type: 'error', error: { type: answer.status === 529 ? 'overloaded_error' : 'api_error', message: 'no' } }));
  });
});
afterAll(() => closeServers());
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetUsageBudget();
});

/** A chat call through the plugin's real client; a key of its own so that client is new */
function chat(limits: Partial<UsageLimits> = {}) {
  vi.stubEnv('ANTHROPIC_BASE_URL', `http://127.0.0.1:${api.port}`);
  vi.stubEnv('ANTHROPIC_API_KEY', `test-key-${++key}`);
  const budget = new UsageBudget({ ...noLimits, ...limits });
  resetUsageBudget(budget);
  api.hits.length = 0;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  return { budget, call: () => models[ModelType.TEXT_LARGE](runtime(), { prompt: 'x', purpose: 'chat' }) };
}

describe('Claude requests and what they are counted as', () => {
  it('sends a request whose connection was lost once, and keeps its reservation counted: the SDK retries nothing', async () => {
    const { budget, call } = chat();
    answers = ['drop', { status: 200, body: message }];
    await expect(call()).rejects.toThrow();
    expect(api.hits).toHaveLength(1);
    expect(budget.snapshot(60_000).ai).toMatchObject({ calls: 1, reservedTokens: each });
  });

  it.each([
    ['a server error', 500],
    ['a timeout answer', 408],
  ])('makes no second attempt after %s', async (_what, status) => {
    const { budget, call } = chat();
    answers = [{ status }, { status: 200, body: message }];
    await expect(call()).rejects.toThrow();
    expect(api.hits).toHaveLength(1);
    expect(budget.snapshot(60_000).ai.calls).toBe(1);
  });

  it('tries once more after an overloaded answer (529), under a reservation of its own, keeping the first counted', async () => {
    const { budget, call } = chat();
    answers = [{ status: 529, headers: { 'retry-after': '0' } }, { status: 200, body: message }];
    await expect(call()).resolves.toBe('ok');
    expect(api.hits).toHaveLength(2);
    // Two requests are two calls: the first held as possibly billed, the second settled at what it used
    expect(budget.snapshot(60_000).ai).toMatchObject({ calls: 2, inputTokens: 12, outputTokens: 3, reservedTokens: each });
  });

  it('tries once more after rate limiting (429), giving the refused attempt back', async () => {
    const { budget, call } = chat();
    answers = [{ status: 429, headers: { 'retry-after': '0' } }, { status: 200, body: message }];
    await expect(call()).resolves.toBe('ok');
    expect(api.hits).toHaveLength(2);
    expect(budget.snapshot(60_000).ai).toMatchObject({ calls: 2, inputTokens: 12, reservedTokens: 0 });
  });

  it('tries at most once more', async () => {
    const { budget, call } = chat();
    answers = [{ status: 529, headers: { 'retry-after': '0' } }, { status: 529, headers: { 'retry-after': '0' } }, { status: 200, body: message }];
    await expect(call()).rejects.toThrow();
    expect(api.hits).toHaveLength(2);
    expect(budget.snapshot(60_000).ai).toMatchObject({ calls: 2, reservedTokens: 2 * each });
    answers = [];
  });

  it('makes no second attempt the budget does not admit, and says the budget stopped it', async () => {
    const { budget, call } = chat({ aiCallsPerHour: 1 });
    answers = [{ status: 529, headers: { 'retry-after': '0' } }, { status: 200, body: message }];
    await expect(call()).rejects.toBeInstanceOf(AiBudgetExceededError);
    expect(api.hits).toHaveLength(1);
    expect(budget.snapshot(60_000)).toMatchObject({ ai: { calls: 1, reservedTokens: each }, skipped: { 'ai-call': 1 } });
    answers = [];
  });
});
