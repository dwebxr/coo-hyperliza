import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ModelType } from '@elizaos/core';
import { closeServers, startServer, type TestServer } from './plugin-hyperfy/test-support/net';
import { anthropicModelsPlugin } from './anthropic-models';
import { UsageBudget, type UsageLimits, resetUsageBudget } from './usage-budget';
import { TurnCancelled, neverAbortedSignal, runTurn } from './plugin-hyperfy/lib/turn-context';

/*
 * The real Anthropic SDK against a Messages API on loopback (ANTHROPIC_BASE_URL), called from
 * inside turns: a turn that may no longer act makes no request. Nothing leaves the machine.
 */

const models = anthropicModelsPlugin.models as Record<string, (rt: unknown, params: unknown) => Promise<unknown>>;
const noLimits: UsageLimits = { aiCallsPerHour: null, aiTokensPerDay: null, visionPerHour: null, ttsCharsPerDay: null, sttSecondsPerDay: null, autonomyAiPerHour: null, autonomyAiMinIntervalMs: 0 };
const runtime = () => ({ getSetting: () => undefined, character: { system: 'You are Coo.' }, emitEvent: vi.fn().mockResolvedValue(undefined) });
const message = { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 12, output_tokens: 3 } };

let statuses: number[] = [];
let api: TestServer;
let key = 0;

beforeAll(async () => {
  api = await startServer((_request, response) => {
    const status = statuses.shift() ?? 200;
    response.writeHead(status, { 'content-type': 'application/json', ...(status === 200 ? {} : { 'retry-after-ms': '50' }) });
    response.end(JSON.stringify(status === 200 ? message : { type: 'error', error: { type: 'overloaded_error', message: 'no' } }));
  });
});
afterAll(() => closeServers());
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetUsageBudget();
});

function setup() {
  vi.stubEnv('ANTHROPIC_BASE_URL', `http://127.0.0.1:${api.port}`);
  vi.stubEnv('ANTHROPIC_API_KEY', `turn-test-key-${++key}`);
  const budget = new UsageBudget(noLimits);
  resetUsageBudget(budget);
  api.hits.length = 0;
  statuses = [];
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const slot = new AbortController();
  const connection = new AbortController();
  const inTurn = <T>(fn: () => Promise<T>) => runTurn({ origin: 'chat', requesterId: 'p1', world: {}, generation: 1, signal: connection.signal, cancel: slot.signal }, fn);
  const call = () => models[ModelType.TEXT_LARGE](runtime(), { prompt: 'x', purpose: 'chat' });
  return { budget, slot, connection, inTurn, call };
}

describe('Claude requests of a turn', () => {
  it('are made for a live turn, and outside any turn', async () => {
    const { budget, inTurn, call } = setup();
    expect(await inTurn(call)).toBe('ok');
    expect(await call()).toBe('ok');
    expect(api.hits).toHaveLength(2);
    expect(budget.snapshot(60_000).ai.calls).toBe(2);
  });

  it.each([
    ['its slot ran out', (ctx: ReturnType<typeof setup>) => ctx.slot.abort()],
    ['its connection ended', (ctx: ReturnType<typeof setup>) => ctx.connection.abort()],
  ])('are not made, and not counted, once %s', async (_what, end) => {
    const ctx = setup();
    const outcome = await ctx.inTurn(async () => {
      end(ctx);
      return ctx.call().then(
        () => 'answered',
        (error: unknown) => error
      );
    });
    expect(outcome).toBeInstanceOf(TurnCancelled);
    expect(api.hits).toEqual([]);
    expect(ctx.budget.snapshot(60_000).ai).toMatchObject({ calls: 0, reservedTokens: 0 });
    // Not a budget skip either: nothing was refused for lack of budget
    expect(ctx.budget.snapshot(60_000).skipped['ai-call'] ?? 0).toBe(0);
  });

  it('does not try again after an overloaded answer once the turn was cancelled during the wait', async () => {
    const ctx = setup();
    statuses = [529];
    const outcome = await ctx.inTurn(async () => {
      const pending = ctx.call().then(
        () => 'answered',
        (error: unknown) => error
      );
      await vi.waitFor(() => expect(api.hits).toHaveLength(1));
      ctx.slot.abort();
      return pending;
    });
    expect(outcome).toBeInstanceOf(TurnCancelled);
    expect(api.hits).toHaveLength(1);
  });

  it('are made for a turn that belongs to no session at all (a signal that never fires)', async () => {
    const { call } = setup();
    expect(await runTurn({ origin: 'autonomy', world: {}, generation: 0, signal: neverAbortedSignal() }, call)).toBe('ok');
  });
});
