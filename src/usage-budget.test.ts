import { describe, expect, it } from 'vitest';
import {
  AI_PURPOSE_MAX_TOKENS,
  UsageBudget,
  type UsageLimits,
  currentOrigin,
  forPurpose,
  formatUsageReport,
  maxTokensFor,
  readUsageLimits,
  runWithOrigin,
} from './usage-budget';

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

const noLimits: UsageLimits = {
  aiCallsPerHour: null,
  aiTokensPerDay: null,
  visionPerHour: null,
  ttsCharsPerDay: null,
  sttSecondsPerDay: null,
  autonomyAiPerHour: null,
  autonomyAiMinIntervalMs: 0,
};

function clock(start = 1_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

const call = (purpose = 'chat', input = 100, output = 10) => ({ purpose, origin: 'chat' as const, inputTokens: input, outputTokens: output });

describe('readUsageLimits', () => {
  it('has no Claude, vision or voice limits by default, and a modest autonomous budget', () => {
    expect(readUsageLimits({})).toEqual({
      aiCallsPerHour: null,
      aiTokensPerDay: null,
      visionPerHour: null,
      ttsCharsPerDay: null,
      sttSecondsPerDay: null,
      autonomyAiPerHour: 20,
      autonomyAiMinIntervalMs: 120_000,
    });
  });

  it('reads every limit, where 0 turns that use off and invalid values are ignored', () => {
    const limits = readUsageLimits({
      AI_MAX_CALLS_PER_HOUR: '120',
      AI_MAX_TOKENS_PER_DAY: '2000000',
      VISION_MAX_PER_HOUR: '0',
      VOICE_TTS_MAX_CHARS_PER_DAY: '20000',
      VOICE_STT_MAX_SECONDS_PER_DAY: 'lots',
      AUTONOMY_AI_MAX_PER_HOUR: '0',
      AUTONOMY_AI_MIN_INTERVAL_SEC: '300',
    });
    expect(limits).toMatchObject({
      aiCallsPerHour: 120,
      aiTokensPerDay: 2_000_000,
      visionPerHour: 0,
      ttsCharsPerDay: 20_000,
      sttSecondsPerDay: null,
      autonomyAiPerHour: 0,
      autonomyAiMinIntervalMs: 300_000,
    });
  });
});

describe('purposes', () => {
  it('caps each purpose, with AI_MAX_TOKENS_<PURPOSE> overrides', () => {
    expect(maxTokensFor('chat', {})).toBe(AI_PURPOSE_MAX_TOKENS.chat);
    expect(maxTokensFor('should-respond', { AI_MAX_TOKENS_SHOULD_RESPOND: '700' })).toBe(700);
    expect(maxTokensFor('chat', { AI_MAX_TOKENS_CHAT: 'x' })).toBe(AI_PURPOSE_MAX_TOKENS.chat);
    expect(maxTokensFor('unknown', {})).toBeUndefined();
    expect(maxTokensFor(undefined, {})).toBeUndefined();
  });

  it('tags params without changing the rest', () => {
    expect(forPurpose('navigation', { prompt: 'p' })).toEqual({ prompt: 'p', purpose: 'navigation' });
  });

  it('attributes work to the origin it runs under, across awaits', async () => {
    expect(currentOrigin()).toBe('other');
    const seen = await runWithOrigin('autonomous', async () => {
      await new Promise((r) => setTimeout(r, 1));
      return currentOrigin();
    });
    expect(seen).toBe('autonomous');
    expect(currentOrigin()).toBe('other');
  });
});

describe('UsageBudget', () => {
  it('stops Claude after the hourly call limit, and allows it again as the hour rolls on', () => {
    const c = clock();
    const budget = new UsageBudget({ ...noLimits, aiCallsPerHour: 2 }, c.now);
    budget.recordAi(call());
    c.advance(10 * 60_000);
    budget.recordAi(call());
    expect(budget.aiBlockedReason()).toBe('AI_MAX_CALLS_PER_HOUR=2');
    c.advance(50 * 60_000 + 1);
    expect(budget.aiAvailable()).toBe(true);
  });

  it('counts every kind of token toward the daily token limit', () => {
    const c = clock();
    const budget = new UsageBudget({ ...noLimits, aiTokensPerDay: 1000 }, c.now);
    budget.recordAi({ ...call('chat', 500, 100), cacheReadTokens: 300 });
    expect(budget.aiAvailable()).toBe(true);
    budget.recordAi(call('chat', 50, 50));
    expect(budget.aiBlockedReason()).toBe('AI_MAX_TOKENS_PER_DAY=1000');
    c.advance(DAY);
    expect(budget.aiAvailable()).toBe(true);
  });

  it('spaces autonomous Claude ticks, counting from the last tick or the end of the last conversation', () => {
    const c = clock();
    const budget = new UsageBudget({ ...noLimits, autonomyAiMinIntervalMs: 120_000, autonomyAiPerHour: 10 }, c.now);
    expect(budget.autonomyAiAvailable()).toBe(true);
    budget.recordAutonomyAiTick();
    c.advance(119_000);
    expect(budget.autonomyAiAvailable()).toBe(false);
    c.advance(1_000);
    expect(budget.autonomyAiAvailable()).toBe(true);
    // Someone just talked with the agent
    expect(budget.autonomyAiAvailable(c.now() - 30_000)).toBe(false);
  });

  it('caps autonomous Claude ticks per hour, and never runs them without Claude budget', () => {
    const c = clock();
    const budget = new UsageBudget({ ...noLimits, autonomyAiPerHour: 1, aiCallsPerHour: 5 }, c.now);
    budget.recordAutonomyAiTick();
    c.advance(30 * 60_000);
    expect(budget.autonomyAiAvailable()).toBe(false);
    c.advance(30 * 60_000);
    expect(budget.autonomyAiAvailable()).toBe(true);
    for (let i = 0; i < 5; i++) budget.recordAi(call());
    expect(budget.autonomyAiAvailable()).toBe(false);

    const off = new UsageBudget({ ...noLimits, autonomyAiPerHour: 0 }, c.now);
    expect(off.autonomyAiAvailable()).toBe(false);
  });

  it('limits vision per hour and voice per day, each on its own', () => {
    const c = clock();
    const budget = new UsageBudget({ ...noLimits, visionPerHour: 1, ttsCharsPerDay: 100, sttSecondsPerDay: 60 }, c.now);
    budget.recordVision();
    budget.recordTts(99);
    budget.recordStt(59.5);
    expect([budget.visionAvailable(), budget.ttsAvailable(), budget.sttAvailable()]).toEqual([false, true, true]);
    budget.recordTts(5);
    budget.recordStt(1);
    expect([budget.ttsAvailable(), budget.sttAvailable(), budget.aiAvailable()]).toEqual([false, false, true]);
    c.advance(HOUR);
    expect(budget.visionAvailable()).toBe(true);
    expect(budget.ttsAvailable()).toBe(false);
    c.advance(DAY);
    expect(budget.ttsAvailable()).toBe(true);
  });

  it('reports usage by purpose, origin and kind for a window', async () => {
    const c = clock();
    const budget = new UsageBudget(noLimits, c.now);
    budget.recordAi(call('chat', 1000, 100));
    budget.recordAi({ ...call('autonomous', 2000, 50), origin: 'autonomous' });
    await runWithOrigin('autonomous', async () => budget.recordTts(40));
    budget.recordTts(10);
    budget.recordStt(12.4);
    budget.recordAutonomyAiTick();
    budget.recordScriptedTick();
    budget.recordScriptedTick();
    budget.recordSkip('vision');

    const s = budget.snapshot(HOUR);
    expect(s.ai).toMatchObject({ calls: 2, inputTokens: 3000, outputTokens: 150, byOrigin: { chat: 1, autonomous: 1 } });
    expect(s.ai.byPurpose.autonomous).toMatchObject({ calls: 1, inputTokens: 2000 });
    expect(s.autonomy).toEqual({ aiTicks: 1, scriptedTicks: 2 });
    expect(s.ttsChars).toBe(50);
    expect(s.ttsCharsByOrigin).toEqual({ autonomous: 40, other: 10 });
    expect(s.skipped.vision).toBe(1);

    const line = formatUsageReport(s, noLimits);
    expect(line).toContain('Claude 2 calls (3.0k in / 150 out)');
    expect(line).toContain('autonomous ticks: 1 AI / 2 scripted');
    expect(line).toContain('over limit: vision 1');

    c.advance(HOUR + 1);
    expect(budget.snapshot(HOUR).ai.calls).toBe(0);
    expect(budget.snapshot(DAY).ai.calls).toBe(2);
  });
});
