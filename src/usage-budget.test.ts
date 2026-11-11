import { describe, expect, it } from 'vitest';
import {
  AI_PURPOSE_MAX_TOKENS,
  type AiReservation,
  SKIP_BUCKET_MS,
  UsageBudget,
  UsageLimitError,
  type UsageLimits,
  currentOrigin,
  forPurpose,
  formatUsageReport,
  maxTokensFor,
  readUsageLimits,
  runWithOrigin,
  usageLimitProblems,
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

/** A Claude call that was admitted and returned with this usage, as src/anthropic-models.ts does it. */
function made(budget: UsageBudget, usage = call(), reserve = usage.inputTokens + usage.outputTokens): void {
  const reservation = budget.reserveAi(usage, reserve);
  if (typeof reservation === 'string') throw new Error(`not admitted: ${reservation}`);
  reservation.settle(usage);
}
const admitted = (reservation: AiReservation | string): AiReservation => {
  if (typeof reservation === 'string') throw new Error(`not admitted: ${reservation}`);
  return reservation;
};

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

  it('reads every limit: empty or unset is no limit (the default for the autonomous ones), 0 turns that use off', () => {
    const limits = readUsageLimits({
      AI_MAX_CALLS_PER_HOUR: '120',
      AI_MAX_TOKENS_PER_DAY: ' 2000000 ',
      VISION_MAX_PER_HOUR: '0',
      VOICE_TTS_MAX_CHARS_PER_DAY: '',
      VOICE_STT_MAX_SECONDS_PER_DAY: '   ',
      AUTONOMY_AI_MAX_PER_HOUR: '0',
      AUTONOMY_AI_MIN_INTERVAL_SEC: '300.9',
    });
    expect(limits).toEqual({
      aiCallsPerHour: 120,
      aiTokensPerDay: 2_000_000,
      visionPerHour: 0,
      ttsCharsPerDay: null,
      sttSecondsPerDay: null,
      autonomyAiPerHour: 0,
      autonomyAiMinIntervalMs: 300_000,
    });
  });

  it.each(['lots', '-1', '1e3', '0x10', '1,000', '100 calls', 'Infinity', 'NaN', '+5', '.5', '5.', '１２', '9'.repeat(30)])('refuses the value %j instead of taking it for "no limit"', (value) => {
    for (const key of ['AI_MAX_CALLS_PER_HOUR', 'AI_MAX_TOKENS_PER_DAY', 'VISION_MAX_PER_HOUR', 'VOICE_TTS_MAX_CHARS_PER_DAY', 'VOICE_STT_MAX_SECONDS_PER_DAY', 'AUTONOMY_AI_MAX_PER_HOUR', 'AUTONOMY_AI_MIN_INTERVAL_SEC']) {
      expect(() => readUsageLimits({ [key]: value }), key).toThrow(UsageLimitError);
      expect(usageLimitProblems({ [key]: value }), key).toHaveLength(1);
    }
    // A budget that reads its limits from the environment fails closed on first use
    const env = process.env.AI_MAX_CALLS_PER_HOUR;
    process.env.AI_MAX_CALLS_PER_HOUR = value;
    try {
      const budget = new UsageBudget();
      expect(() => budget.aiAvailable()).toThrow(UsageLimitError);
      expect(() => budget.reserveAi({ purpose: 'chat', origin: 'chat' }, 10)).toThrow(UsageLimitError);
    } finally {
      if (env === undefined) delete process.env.AI_MAX_CALLS_PER_HOUR;
      else process.env.AI_MAX_CALLS_PER_HOUR = env;
    }
  });
});

describe('usageLimitProblems', () => {
  it('finds nothing wrong with empty, zero and plain numbers', () => {
    expect(usageLimitProblems({})).toEqual([]);
    expect(usageLimitProblems({ AI_MAX_CALLS_PER_HOUR: '', AI_MAX_TOKENS_PER_DAY: '0', VISION_MAX_PER_HOUR: '12', AI_MAX_TOKENS_CHAT: '3000', USAGE_REPORT_INTERVAL_MIN: '0' })).toEqual([]);
  });

  it('names every variable it cannot read, also the per-purpose caps and the report interval, and says what to write instead', () => {
    const problems = usageLimitProblems({ AI_MAX_CALLS_PER_HOUR: 'abc', AI_MAX_TOKENS_SHOULD_RESPOND: '-5', USAGE_REPORT_INTERVAL_MIN: 'hourly', VISION_MAX_PER_HOUR: '3' });
    expect(problems).toEqual([
      '[Usage] AI_MAX_CALLS_PER_HOUR="abc" is not a number of 0 or more. Leave it empty for the default (for a limit: no limit), or set a number (0 turns that use off).',
      '[Usage] AI_MAX_TOKENS_SHOULD_RESPOND="-5" is not a number of 0 or more. Leave it empty for the default cap, or set a number of output tokens above 0.',
      '[Usage] USAGE_REPORT_INTERVAL_MIN="hourly" is not a number of 0 or more. Leave it empty for the default (for a limit: no limit), or set a number (0 turns that use off).',
    ]);
  });

  it('refuses 0 for a per-purpose cap, which sets the size of a reply and is not a switch, and says so', () => {
    for (const key of ['AI_MAX_TOKENS_CHAT', 'AI_MAX_TOKENS_SHOULD_RESPOND', 'AI_MAX_TOKENS_USE_ITEM']) {
      for (const value of ['0', ' 0 ', '0.4']) {
        expect(usageLimitProblems({ [key]: value }), `${key}=${value}`).toEqual([
          `[Usage] ${key}=0: AI_MAX_TOKENS_<PURPOSE> sets how many output tokens such a reply may have; it does not turn that use off. Leave it empty for the default cap, or set a number above 0 (AI_MAX_CALLS_PER_HOUR=0 turns Claude off).`,
        ]);
      }
    }
    // 0 still means off for a limit, and a cap of 1 is a cap
    expect(usageLimitProblems({ AI_MAX_CALLS_PER_HOUR: '0', AI_MAX_TOKENS_PER_DAY: '0', AI_MAX_TOKENS_CHAT: '1' })).toEqual([]);
  });

  it('shows only the start of a value, on one line (it could be a secret pasted into the wrong line)', () => {
    const [problem] = usageLimitProblems({ AI_MAX_TOKENS_PER_DAY: `sk-ant-${'x'.repeat(80)}\nINFO forged` });
    expect(problem).toContain('AI_MAX_TOKENS_PER_DAY="sk-ant-xxxxxxxxxxxxxxxxx…"');
    expect(problem).not.toContain('forged');
    expect(problem).not.toContain('\n');
  });
});

describe('purposes', () => {
  it('caps each purpose, with AI_MAX_TOKENS_<PURPOSE> overrides', () => {
    // Every purpose and the variable that overrides its cap, written out
    const overrides: Record<keyof typeof AI_PURPOSE_MAX_TOKENS, string> = {
      'should-respond': 'AI_MAX_TOKENS_SHOULD_RESPOND',
      chat: 'AI_MAX_TOKENS_CHAT',
      autonomous: 'AI_MAX_TOKENS_AUTONOMOUS',
      navigation: 'AI_MAX_TOKENS_NAVIGATION',
      'use-item': 'AI_MAX_TOKENS_USE_ITEM',
      vision: 'AI_MAX_TOKENS_VISION',
      reply: 'AI_MAX_TOKENS_REPLY',
      ambient: 'AI_MAX_TOKENS_AMBIENT',
      build: 'AI_MAX_TOKENS_BUILD',
    };
    expect(Object.keys(overrides).sort()).toEqual(Object.keys(AI_PURPOSE_MAX_TOKENS).sort());
    for (const [purpose, key] of Object.entries(overrides) as [keyof typeof AI_PURPOSE_MAX_TOKENS, string][]) {
      expect(AI_PURPOSE_MAX_TOKENS[purpose], purpose).toBeGreaterThan(0);
      expect(maxTokensFor(purpose, {}), purpose).toBe(AI_PURPOSE_MAX_TOKENS[purpose]);
      expect(maxTokensFor(purpose, { [key]: '700' }), purpose).toBe(700);
      // Another purpose's override is not this one's
      expect(maxTokensFor(purpose, { [`${key}_X`]: '700' }), purpose).toBe(AI_PURPOSE_MAX_TOKENS[purpose]);
    }
    expect(maxTokensFor('chat', {})).toBe(AI_PURPOSE_MAX_TOKENS.chat);
    expect(maxTokensFor('should-respond', { AI_MAX_TOKENS_SHOULD_RESPOND: '700' })).toBe(700);
    expect(maxTokensFor('chat', { AI_MAX_TOKENS_CHAT: 'x' })).toBe(AI_PURPOSE_MAX_TOKENS.chat);
    expect(maxTokensFor('chat', { AI_MAX_TOKENS_CHAT: '0' })).toBe(AI_PURPOSE_MAX_TOKENS.chat);
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
    made(budget);
    c.advance(10 * 60_000);
    made(budget);
    expect(budget.aiBlockedReason()).toBe('AI_MAX_CALLS_PER_HOUR=2');
    expect(budget.reserveAi(call(), 1)).toBe('AI_MAX_CALLS_PER_HOUR=2');
    c.advance(50 * 60_000 + 1);
    expect(budget.aiAvailable()).toBe(true);
  });

  it('counts every kind of token toward the daily token limit', () => {
    const c = clock();
    const budget = new UsageBudget({ ...noLimits, aiTokensPerDay: 1000 }, c.now);
    // 900 in four kinds, then 100 more: leaving any one kind out would stay under the limit
    made(budget, { ...call('chat', 400, 100), cacheReadTokens: 300, cacheWriteTokens: 100 } as ReturnType<typeof call>, 900);
    expect(budget.aiAvailable()).toBe(true);
    made(budget, call('chat', 50, 50));
    expect(budget.aiBlockedReason()).toBe('AI_MAX_TOKENS_PER_DAY=1000');
    expect(budget.snapshot(DAY).ai).toMatchObject({ inputTokens: 450, outputTokens: 150, cacheReadTokens: 300, cacheWriteTokens: 100 });
    c.advance(DAY);
    expect(budget.aiAvailable()).toBe(true);
  });

  it('admits a Claude call only when its whole reservation fits the daily token limit', () => {
    const budget = new UsageBudget({ ...noLimits, aiTokensPerDay: 1000 }, clock().now);
    made(budget, call('chat', 600, 100));
    // 300 are left: something is available, but not for a call that may use 301
    expect(budget.aiAvailable()).toBe(true);
    expect(budget.reserveAi(call(), 301)).toBe('AI_MAX_TOKENS_PER_DAY=1000');
    const fits = admitted(budget.reserveAi(call(), 300));
    // Reserved to the last token: nothing else is admitted while that call runs
    expect(budget.aiAvailable()).toBe(false);
    expect(budget.reserveAi(call(), 1)).toBe('AI_MAX_TOKENS_PER_DAY=1000');
    // It used less than it reserved: the rest is free again
    fits.settle(call('chat', 100, 50));
    expect(budget.snapshot(DAY).ai).toMatchObject({ calls: 2, inputTokens: 700, outputTokens: 150, reservedTokens: 0 });
    expect(admitted(budget.reserveAi(call(), 150))).toBeDefined();
  });

  it('never admits more calls than the hourly limit, however many ask before any has returned', () => {
    const budget = new UsageBudget({ ...noLimits, aiCallsPerHour: 3 }, clock().now);
    const results = Array.from({ length: 10 }, () => budget.reserveAi(call(), 100));
    expect(results.filter((r) => typeof r !== 'string')).toHaveLength(3);
    expect(results.slice(3).every((r) => r === 'AI_MAX_CALLS_PER_HOUR=3')).toBe(true);
    expect(budget.snapshot(HOUR).ai.calls).toBe(3);
  });

  it('never admits reservations beyond the daily token limit, however many ask before any has returned', () => {
    const budget = new UsageBudget({ ...noLimits, aiTokensPerDay: 1000 }, clock().now);
    const results = Array.from({ length: 10 }, () => budget.reserveAi(call(), 300));
    expect(results.filter((r) => typeof r !== 'string')).toHaveLength(3);
    expect(budget.snapshot(DAY).ai.reservedTokens).toBe(900);
  });

  it('keeps a failed call counted: as a call always, and with its whole reservation unless the API refused the request outright', () => {
    const c = clock();
    const budget = new UsageBudget({ ...noLimits, aiCallsPerHour: 3, aiTokensPerDay: 1000 }, c.now);
    admitted(budget.reserveAi(call(), 400)).fail('unknown');
    admitted(budget.reserveAi(call(), 400)).fail('rejected');
    expect(budget.snapshot(DAY).ai).toMatchObject({ calls: 2, inputTokens: 0, outputTokens: 0, reservedTokens: 400 });
    // 600 tokens and one call are left
    expect(budget.reserveAi(call(), 601)).toBe('AI_MAX_TOKENS_PER_DAY=1000');
    admitted(budget.reserveAi(call(), 600)).fail('rejected');
    expect(budget.aiBlockedReason()).toBe('AI_MAX_CALLS_PER_HOUR=3');
    expect(formatUsageReport(budget.snapshot(DAY))).toContain('Claude 3 calls (0 in / 0 out / 400 held for calls in progress or failed)');
    // The held tokens leave with the day, like any other use
    c.advance(DAY);
    expect(budget.snapshot(DAY).ai.reservedTokens).toBe(0);
  });

  it('ends a reservation once: a second settle or fail changes nothing', () => {
    const budget = new UsageBudget({ ...noLimits, aiTokensPerDay: 1000 }, clock().now);
    const reservation = admitted(budget.reserveAi(call(), 500));
    reservation.settle(call('chat', 10, 5));
    reservation.fail('unknown');
    reservation.settle(call('chat', 999, 999));
    expect(budget.snapshot(DAY).ai).toMatchObject({ calls: 1, inputTokens: 10, outputTokens: 5, reservedTokens: 0 });
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
    for (let i = 0; i < 5; i++) made(budget);
    expect(budget.autonomyAiAvailable()).toBe(false);

    const off = new UsageBudget({ ...noLimits, autonomyAiPerHour: 0 }, c.now);
    expect(off.autonomyAiAvailable()).toBe(false);
  });

  it('limits vision per hour and voice per day, each on its own, and never admits what does not fit whole', () => {
    const c = clock();
    const budget = new UsageBudget({ ...noLimits, visionPerHour: 1, ttsCharsPerDay: 100, sttSecondsPerDay: 60 }, c.now);
    expect(budget.reserveVision()).not.toBeNull();
    expect(budget.reserveVision()).toBeNull();
    expect(budget.reserveTts(99)).not.toBeNull();
    expect(budget.reserveStt(59.5)).toBe(true);
    expect([budget.visionAvailable(), budget.ttsAvailable(), budget.sttAvailable()]).toEqual([false, true, true]);
    // One character and half a second are left
    expect(budget.reserveTts(2)).toBeNull();
    expect(budget.reserveStt(0.6)).toBe(false);
    expect(budget.snapshot(DAY)).toMatchObject({ ttsChars: 99, sttSeconds: 59.5 });
    expect(budget.reserveTts(1)).not.toBeNull();
    expect(budget.reserveStt(0.5)).toBe(true);
    expect([budget.ttsAvailable(), budget.sttAvailable(), budget.aiAvailable()]).toEqual([false, false, true]);
    c.advance(HOUR);
    expect(budget.visionAvailable()).toBe(true);
    expect(budget.ttsAvailable()).toBe(false);
    c.advance(DAY);
    expect(budget.reserveTts(100)).not.toBeNull();
  });

  it('gives text-to-speech characters back when their reservation is released, once', () => {
    const budget = new UsageBudget({ ...noLimits, ttsCharsPerDay: 100 }, clock().now);
    const refused = budget.reserveTts(100)!;
    expect(budget.reserveTts(1)).toBeNull();
    refused.release();
    refused.release();
    expect(budget.snapshot(DAY).ttsChars).toBe(0);
    expect(budget.reserveTts(100)).not.toBeNull();
    expect(budget.reserveTts(1)).toBeNull();
  });

  it('admits no voice or vision at a limit of 0, and nothing that is not an amount', () => {
    const off = new UsageBudget({ ...noLimits, visionPerHour: 0, ttsCharsPerDay: 0, sttSecondsPerDay: 0, aiCallsPerHour: 0 }, clock().now);
    expect([off.reserveVision(), off.reserveTts(1), off.reserveTts(0), off.reserveStt(0.01), off.reserveStt(0)]).toEqual([null, null, null, false, false]);
    expect(off.reserveAi(call(), 0)).toBe('AI_MAX_CALLS_PER_HOUR=0');
    const open = new UsageBudget(noLimits, clock().now);
    expect([open.reserveTts(Number.NaN), open.reserveStt(-1), open.reserveTts(Number.POSITIVE_INFINITY)]).toEqual([null, false, null]);
    expect(open.snapshot(DAY)).toMatchObject({ ttsChars: 0, sttSeconds: 0 });
  });

  it('gives a look at the world back when it is released, once', () => {
    const budget = new UsageBudget({ ...noLimits, visionPerHour: 1 }, clock().now);
    const look = budget.reserveVision()!;
    expect(budget.reserveVision()).toBeNull();
    look.release();
    look.release();
    const again = budget.reserveVision();
    expect(again).not.toBeNull();
    // Releasing the first one again does not free the second
    look.release();
    expect(budget.reserveVision()).toBeNull();
    expect(budget.snapshot(HOUR).vision).toBe(1);
  });

  it('reports usage by purpose, origin and kind for a window', async () => {
    const c = clock();
    const budget = new UsageBudget(noLimits, c.now);
    made(budget, call('chat', 1000, 100));
    made(budget, { ...call('autonomous', 2000, 50), origin: 'autonomous' } as unknown as ReturnType<typeof call>);
    await runWithOrigin('autonomous', async () => budget.reserveTts(40));
    budget.reserveTts(10);
    budget.reserveStt(12.4);
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

  it('counts refused uses in at most a day of one-minute buckets, however many there are, and reports them per window', () => {
    const c = clock();
    const budget = new UsageBudget(noLimits, c.now);
    // Two days of a refused use every second, of each kind in turn
    const kinds = ['ai-call', 'offline-reply', 'vision', 'tts', 'stt'] as const;
    for (let second = 0; second < 2 * 24 * 3600; second++) {
      budget.recordSkip(kinds[second % kinds.length]);
      c.advance(1000);
      expect(budget.skipBuckets).toBeLessThanOrEqual(DAY / SKIP_BUCKET_MS + 1);
    }
    expect(budget.skipBuckets).toBeGreaterThanOrEqual(DAY / SKIP_BUCKET_MS);
    // The last hour: 3,600 refusals, 720 of each kind, give or take the minute the window starts in
    const hour = budget.snapshot(HOUR).skipped;
    for (const kind of kinds) {
      expect(hour[kind]).toBeGreaterThanOrEqual(720);
      expect(hour[kind]).toBeLessThanOrEqual(720 + 12);
    }
    expect(formatUsageReport(budget.snapshot(HOUR))).toMatch(/over limit: (ai-call|offline-reply|vision|tts|stt) \d+, /);
    // Nothing older than a day is counted
    const day = budget.snapshot(DAY).skipped;
    expect(Object.values(day).reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(24 * 3600 + 60);
    c.advance(DAY + SKIP_BUCKET_MS);
    expect(Object.values(budget.snapshot(DAY).skipped).every((n) => n === 0)).toBe(true);
  });
});
