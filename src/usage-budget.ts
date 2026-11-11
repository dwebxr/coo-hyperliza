import { logger } from '@elizaos/core';
import { currentUsageOrigin, runWithUsageOrigin } from './plugin-hyperfy/lib/turn-context';

/**
 * Usage meter and budgets for everything that costs money: Claude calls, vision, text-to-speech
 * and speech-to-text. Each is limited separately so running out of one (say, voice) leaves the
 * others working, and scripted behavior (patrol, waves, product links) needs none of them.
 *
 * Counts are in memory, over rolling windows (the last hour / the last 24 hours), and start
 * from zero when the agent restarts.
 *
 * A use is reserved before the request is made (reserveAi, reserveVision, reserveTts, reserveStt):
 * the check and the count are one synchronous step, so requests that start at the same time cannot
 * all pass a check that only one of them fits. A reservation is admitted only when it fits the
 * limit whole, so a limit is not exceeded by what was reserved; a use that turns out larger than
 * its reservation (see reserveAi) is the one way over. The *Available() checks reserve nothing:
 * they say whether anything is left, for deciding early not to start.
 */

type Env = Record<string, string | undefined>;

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

/** Where a call started; set around each chat turn, voice turn and autonomous tick. */
export type UsageOrigin = 'chat' | 'voice' | 'autonomous' | 'other';

/**
 * What a Claude call is for, and its default output cap. The caps leave room for the model's
 * (adaptive) thinking, which counts toward max_tokens. Override one with AI_MAX_TOKENS_<PURPOSE>,
 * e.g. AI_MAX_TOKENS_CHAT=3000 or AI_MAX_TOKENS_SHOULD_RESPOND=800.
 */
export const AI_PURPOSE_MAX_TOKENS = {
  'should-respond': 1024,
  chat: 2048,
  autonomous: 1536,
  navigation: 1024,
  'use-item': 1024,
  vision: 2048,
  reply: 1536,
  ambient: 1024,
  build: 2048,
} as const;
export type AiPurpose = keyof typeof AI_PURPOSE_MAX_TOKENS;

export function isAiPurpose(value: unknown): value is AiPurpose {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(AI_PURPOSE_MAX_TOKENS, value);
}

export function purposeEnvKey(purpose: AiPurpose): string {
  return `AI_MAX_TOKENS_${purpose.toUpperCase().replace(/-/g, '_')}`;
}

/**
 * The output cap for a tagged call; undefined for untagged calls (other plugins). An override
 * that is not a number above 0 is refused at startup (usageLimitProblems); here it gives the
 * default cap.
 */
export function maxTokensFor(purpose: unknown, env: Env = process.env): number | undefined {
  if (!isAiPurpose(purpose)) return undefined;
  let override: number | null = null;
  try {
    override = parseCount(env[purposeEnvKey(purpose)], purposeEnvKey(purpose));
  } catch {
    // The default cap below
  }
  return override && override > 0 ? override : AI_PURPOSE_MAX_TOKENS[purpose];
}

/**
 * Tags model params with what the call is for. The model handler reads it to pick the output
 * cap and to attribute the call in usage reports; elizaOS passes params through unchanged.
 */
export function forPurpose<T extends object>(purpose: AiPurpose, params: T): T {
  return { ...params, purpose };
}

/** Thrown by the model handler when the Claude budget is used up; callers fall back to scripts. */
export class AiBudgetExceededError extends Error {
  constructor(reason: string) {
    super(`[Usage] Claude budget reached (${reason}); call skipped`);
    this.name = 'AiBudgetExceededError';
  }
}

/**
 * Runs fn with every model call and speech inside it attributed to origin. Chat, voice and
 * autonomous turns get their origin from their TurnContext (plugin-hyperfy/lib/turn-context.ts),
 * which shares this scope.
 */
export function runWithOrigin<T>(origin: UsageOrigin, fn: () => Promise<T>): Promise<T> {
  return runWithUsageOrigin(origin, fn);
}

export function currentOrigin(): UsageOrigin {
  return currentUsageOrigin() ?? 'other';
}

/** null = no limit. */
export interface UsageLimits {
  aiCallsPerHour: number | null;
  aiTokensPerDay: number | null;
  visionPerHour: number | null;
  ttsCharsPerDay: number | null;
  sttSecondsPerDay: number | null;
  /** Autonomous ticks that may ask Claude what to do, per hour. */
  autonomyAiPerHour: number | null;
  /** Least time between such ticks, also counted from the end of the last conversation. */
  autonomyAiMinIntervalMs: number;
}

export const DEFAULT_AUTONOMY_AI_PER_HOUR = 20;
export const DEFAULT_AUTONOMY_AI_MIN_INTERVAL_SEC = 120;

/** A usage variable is set to something that is not a number of 0 or more. */
export class UsageLimitError extends Error {
  constructor(key: string, raw: string) {
    // The value could be anything pasted into the wrong line: only its start, on one line
    const shown = raw.trim().replace(/[^\x20-\x7e]/g, '?').slice(0, 24);
    super(`${key}="${shown}${raw.trim().length > 24 ? '…' : ''}" is not a number of 0 or more`);
    this.name = 'UsageLimitError';
  }
}

// Digits with an optional fraction: no sign, exponent, hex, separators or units
const PLAIN_NUMBER = /^\d+(\.\d+)?$/;

/**
 * An empty or unset value means "not set" (no limit, or the default); a number of 0 or more is
 * the value, rounded down (0 turns that use off). Anything else throws UsageLimitError: a limit
 * that cannot be read never means "no limit".
 */
function parseCount(raw: string | undefined, key: string): number | null {
  const value = raw?.trim();
  if (!value) return null;
  const n = PLAIN_NUMBER.test(value) ? Math.floor(Number(value)) : NaN;
  if (!Number.isSafeInteger(n)) throw new UsageLimitError(key, raw ?? '');
  return n;
}

const LIMIT_KEYS = [
  'AI_MAX_CALLS_PER_HOUR',
  'AI_MAX_TOKENS_PER_DAY',
  'VISION_MAX_PER_HOUR',
  'VOICE_TTS_MAX_CHARS_PER_DAY',
  'VOICE_STT_MAX_SECONDS_PER_DAY',
  'AUTONOMY_AI_MAX_PER_HOUR',
  'AUTONOMY_AI_MIN_INTERVAL_SEC',
] as const;

/**
 * What is wrong with the usage variables in `env`, one line each; empty when all can be read.
 * Covers the limits, the per-purpose output caps (AI_MAX_TOKENS_<PURPOSE>) and
 * USAGE_REPORT_INTERVAL_MIN. The agent refuses to start on any of these (src/index.ts).
 */
export function usageLimitProblems(env: Env = process.env): string[] {
  const capKeys = (Object.keys(AI_PURPOSE_MAX_TOKENS) as AiPurpose[]).map(purposeEnvKey);
  const problems: string[] = [];
  for (const key of [...LIMIT_KEYS, ...capKeys, 'USAGE_REPORT_INTERVAL_MIN']) {
    let value: number | null;
    try {
      value = parseCount(env[key], key);
    } catch (error) {
      problems.push(
        capKeys.includes(key)
          ? `[Usage] ${(error as Error).message}. Leave it empty for the default cap, or set a number of output tokens above 0.`
          : `[Usage] ${(error as Error).message}. Leave it empty for the default (for a limit: no limit), or set a number (0 turns that use off).`
      );
      continue;
    }
    // A cap is the size of a reply, not a switch: 0 would not turn that use off, so it is refused
    if (value === 0 && capKeys.includes(key)) {
      problems.push(`[Usage] ${key}=0: AI_MAX_TOKENS_<PURPOSE> sets how many output tokens such a reply may have; it does not turn that use off. Leave it empty for the default cap, or set a number above 0 (AI_MAX_CALLS_PER_HOUR=0 turns Claude off).`);
    }
  }
  return problems;
}

/** Throws UsageLimitError for a limit that is set but is not a number of 0 or more. */
export function readUsageLimits(env: Env = process.env): UsageLimits {
  const read = (key: string) => parseCount(env[key], key);
  return {
    aiCallsPerHour: read('AI_MAX_CALLS_PER_HOUR'),
    aiTokensPerDay: read('AI_MAX_TOKENS_PER_DAY'),
    visionPerHour: read('VISION_MAX_PER_HOUR'),
    ttsCharsPerDay: read('VOICE_TTS_MAX_CHARS_PER_DAY'),
    sttSecondsPerDay: read('VOICE_STT_MAX_SECONDS_PER_DAY'),
    autonomyAiPerHour: read('AUTONOMY_AI_MAX_PER_HOUR') ?? DEFAULT_AUTONOMY_AI_PER_HOUR,
    autonomyAiMinIntervalMs: (read('AUTONOMY_AI_MIN_INTERVAL_SEC') ?? DEFAULT_AUTONOMY_AI_MIN_INTERVAL_SEC) * 1000,
  };
}

export interface AiCall {
  purpose: string;
  origin: UsageOrigin;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** `reserved`: tokens counted toward the limit for a call that has not returned, or that failed after it may have been billed. */
type AiEvent = Required<AiCall> & { at: number; reserved: number };

/** A Claude call that was admitted. Exactly one of settle/fail ends it; until then its reservation counts. */
export interface AiReservation {
  /** The call returned: its real usage replaces the reservation. */
  settle(usage: Pick<AiCall, 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'>): void;
  /**
   * The call failed. It still counts as a call. `rejected` means the API refused the request
   * before generating anything, so no tokens are counted; otherwise (timeout, abort, connection
   * or server error) it may have been billed and the whole reservation stays counted.
   */
  fail(outcome: 'rejected' | 'unknown'): void;
}

/** A look at the world that was admitted; release() gives it back when no request was made for it. */
export interface VisionReservation {
  release(): void;
}

/** Characters of text-to-speech that were admitted; release() gives them back when the provider refused the request. */
export interface AmountReservation {
  release(): void;
}
type AmountEvent = { at: number; amount: number; origin: UsageOrigin };
export type SkipKind = 'ai-call' | 'offline-reply' | 'vision' | 'tts' | 'stt';

// Uses that were refused are counted per minute, not one entry each: at most a day of minutes is
// kept however many there are. A report's window starts at a minute boundary (it can count up to
// a minute more than the window).
export const SKIP_BUCKET_MS = 60_000;
type SkipBucket = { at: number; counts: Record<SkipKind, number> };
const noSkips = (): Record<SkipKind, number> => ({ 'ai-call': 0, 'offline-reply': 0, vision: 0, tts: 0, stt: 0 });

export interface TokenTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface UsageSnapshot {
  windowMs: number;
  /** `reservedTokens`: counted toward the token limit for calls in progress and calls that failed after they may have been billed. */
  ai: TokenTotals & { reservedTokens: number; byPurpose: Record<string, TokenTotals>; byOrigin: Record<string, number> };
  autonomy: { aiTicks: number; scriptedTicks: number };
  vision: number;
  ttsChars: number;
  ttsCharsByOrigin: Record<string, number>;
  sttSeconds: number;
  skipped: Record<SkipKind, number>;
}

function emptyTotals(): TokenTotals {
  return { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

function addTo(totals: TokenTotals, e: AiEvent): void {
  totals.calls++;
  totals.inputTokens += e.inputTokens;
  totals.outputTokens += e.outputTokens;
  totals.cacheReadTokens += e.cacheReadTokens;
  totals.cacheWriteTokens += e.cacheWriteTokens;
}

const totalTokens = (e: AiEvent) => e.inputTokens + e.outputTokens + e.cacheReadTokens + e.cacheWriteTokens + e.reserved;

export class UsageBudget {
  private ai: AiEvent[] = [];
  private autonomyAi: AmountEvent[] = [];
  private scripted: AmountEvent[] = [];
  private vision: AmountEvent[] = [];
  private tts: AmountEvent[] = [];
  private stt: AmountEvent[] = [];
  /** Oldest first; `at` is the start of the bucket's minute */
  private skips: SkipBucket[] = [];
  private lastAutonomyAiAt = Number.NEGATIVE_INFINITY;
  private _limits: UsageLimits | null;
  private readonly now: () => number;

  /** Without limits they are read from the environment on first use (after .env is loaded). */
  constructor(limits?: UsageLimits, now: () => number = Date.now) {
    this._limits = limits ?? null;
    this.now = now;
  }

  get limits(): UsageLimits {
    return (this._limits ??= readUsageLimits());
  }

  // --- Claude ---

  /**
   * Why a Claude call that needs `tokens` (0: any call at all) may not be made right now, or null
   * when it may. Calls in progress count as a call each and with their reserved tokens.
   */
  aiBlockedReason(tokens = 0): string | null {
    const t = this.now();
    const { aiCallsPerHour, aiTokensPerDay } = this.limits;
    if (aiCallsPerHour !== null && this.countSince(this.ai, t - HOUR_MS) >= aiCallsPerHour) {
      return `AI_MAX_CALLS_PER_HOUR=${aiCallsPerHour}`;
    }
    if (aiTokensPerDay !== null) {
      const used = this.ai.reduce((sum, e) => (e.at > t - DAY_MS ? sum + totalTokens(e) : sum), 0);
      if (used >= aiTokensPerDay || used + tokens > aiTokensPerDay) return `AI_MAX_TOKENS_PER_DAY=${aiTokensPerDay}`;
    }
    return null;
  }

  /** Whether any Claude call may be made right now. Reserves nothing: the call itself is admitted by reserveAi. */
  aiAvailable(): boolean {
    return this.aiBlockedReason() === null;
  }

  /**
   * Admits one Claude call, counted from now: one call toward the hourly limit and `tokens` (the
   * most the caller expects it to use: prompt and output cap) toward the daily one. Returns why
   * not (as aiBlockedReason) when it does not fit. Check and count are one step, so calls that
   * start together cannot exceed the call limit, nor the token limit by what they reserved. The
   * token limit can still be passed by a call that uses more than it reserved.
   */
  reserveAi(call: Pick<AiCall, 'purpose' | 'origin'>, tokens: number): AiReservation | string {
    const reserved = Math.max(0, Math.ceil(tokens));
    const blocked = this.aiBlockedReason(reserved);
    if (blocked) return blocked;
    const event: AiEvent = { ...call, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reserved, at: this.now() };
    this.ai.push(event);
    this.prune();
    let ended = false;
    const end = (apply: () => void) => {
      if (ended) return;
      ended = true;
      apply();
    };
    return {
      settle: (usage) =>
        end(() => {
          event.reserved = 0;
          event.inputTokens = usage.inputTokens;
          event.outputTokens = usage.outputTokens;
          event.cacheReadTokens = usage.cacheReadTokens ?? 0;
          event.cacheWriteTokens = usage.cacheWriteTokens ?? 0;
        }),
      fail: (outcome) =>
        end(() => {
          if (outcome === 'rejected') event.reserved = 0;
        }),
    };
  }

  // --- Autonomous behavior ---

  /**
   * Whether an autonomous tick may ask Claude what to do. lastActivityAt is when the last
   * conversation ended: while people are talking with the agent, it does not need to start
   * anything on its own.
   */
  autonomyAiAvailable(lastActivityAt: number = Number.NEGATIVE_INFINITY): boolean {
    const { autonomyAiPerHour, autonomyAiMinIntervalMs } = this.limits;
    const t = this.now();
    if (autonomyAiPerHour !== null && this.countSince(this.autonomyAi, t - HOUR_MS) >= autonomyAiPerHour) return false;
    if (t - Math.max(this.lastAutonomyAiAt, lastActivityAt) < autonomyAiMinIntervalMs) return false;
    return this.aiAvailable();
  }

  recordAutonomyAiTick(): void {
    this.lastAutonomyAiAt = this.now();
    this.autonomyAi.push({ at: this.lastAutonomyAiAt, amount: 1, origin: 'autonomous' });
    this.prune();
  }

  recordScriptedTick(): void {
    this.scripted.push({ at: this.now(), amount: 1, origin: 'autonomous' });
    this.prune();
  }

  // --- Vision ---

  visionAvailable(): boolean {
    const limit = this.limits.visionPerHour;
    return limit === null || this.countSince(this.vision, this.now() - HOUR_MS) < limit;
  }

  /**
   * Admits one look at the world (counted from now), or returns null when the hourly limit is
   * used up. release() takes it back; it is for a look that ended before any request was made.
   */
  reserveVision(): VisionReservation | null {
    if (!this.visionAvailable()) return null;
    const event: AmountEvent = { at: this.now(), amount: 1, origin: currentOrigin() };
    this.vision.push(event);
    this.prune();
    return {
      release: () => {
        const index = this.vision.indexOf(event);
        if (index !== -1) this.vision.splice(index, 1);
      },
    };
  }

  // --- Voice ---

  /** Whether any text-to-speech is left today. Reserves nothing. */
  ttsAvailable(): boolean {
    const limit = this.limits.ttsCharsPerDay;
    return limit === null || this.sumSince(this.tts, this.now() - DAY_MS) < limit;
  }

  /**
   * Admits `chars` characters of text-to-speech for one request to one provider and counts them, or
   * returns null when they do not fit in what is left of the daily limit. They stay counted unless
   * release() is called, which is for a request the provider refused without producing audio.
   */
  reserveTts(chars: number): AmountReservation | null {
    const event = this.reserveAmount(this.tts, this.limits.ttsCharsPerDay, chars);
    if (!event) return null;
    return {
      release: () => {
        const index = this.tts.indexOf(event);
        if (index !== -1) this.tts.splice(index, 1);
      },
    };
  }

  /** Whether any speech-to-text is left today. Reserves nothing. */
  sttAvailable(): boolean {
    const limit = this.limits.sttSecondsPerDay;
    return limit === null || this.sumSince(this.stt, this.now() - DAY_MS) < limit;
  }

  /**
   * Admits `seconds` of audio for speech-to-text and counts them, or returns false when they do not
   * fit in what is left of the daily limit. They stay counted whatever becomes of the request
   * (speech-to-text is billed by audio length).
   */
  reserveStt(seconds: number): boolean {
    return this.reserveAmount(this.stt, this.limits.sttSecondsPerDay, seconds) !== null;
  }

  /** The event counted, or null when `amount` does not fit. */
  private reserveAmount(events: AmountEvent[], limit: number | null, amount: number): AmountEvent | null {
    if (!Number.isFinite(amount) || amount < 0) return null;
    // 0 turns that use off, also for an amount of 0
    if (limit !== null && (limit === 0 || this.sumSince(events, this.now() - DAY_MS) + amount > limit)) return null;
    const event: AmountEvent = { at: this.now(), amount, origin: currentOrigin() };
    events.push(event);
    this.prune();
    return event;
  }

  recordSkip(kind: SkipKind): void {
    const at = Math.floor(this.now() / SKIP_BUCKET_MS) * SKIP_BUCKET_MS;
    let bucket = this.skips.at(-1);
    if (!bucket || bucket.at !== at) {
      bucket = { at, counts: noSkips() };
      this.skips.push(bucket);
      this.prune();
    }
    bucket.counts[kind]++;
  }

  /** How many buckets of refused uses are kept (at most a day of minutes, plus the current one). */
  get skipBuckets(): number {
    return this.skips.length;
  }

  // --- Reporting ---

  snapshot(windowMs: number): UsageSnapshot {
    const since = this.now() - windowMs;
    const ai = { ...emptyTotals(), reservedTokens: 0, byPurpose: {} as Record<string, TokenTotals>, byOrigin: {} as Record<string, number> };
    for (const e of this.ai) {
      if (e.at <= since) continue;
      ai.reservedTokens += e.reserved;
      addTo(ai, e);
      addTo((ai.byPurpose[e.purpose] ??= emptyTotals()), e);
      ai.byOrigin[e.origin] = (ai.byOrigin[e.origin] ?? 0) + 1;
    }
    const ttsCharsByOrigin: Record<string, number> = {};
    for (const e of this.tts) {
      if (e.at > since) ttsCharsByOrigin[e.origin] = (ttsCharsByOrigin[e.origin] ?? 0) + e.amount;
    }
    const skipped = noSkips();
    // Every minute that overlaps the window
    for (const bucket of this.skips) {
      if (bucket.at + SKIP_BUCKET_MS <= since) continue;
      for (const kind of Object.keys(skipped) as SkipKind[]) skipped[kind] += bucket.counts[kind];
    }
    return {
      windowMs,
      ai,
      autonomy: { aiTicks: this.countSince(this.autonomyAi, since), scriptedTicks: this.countSince(this.scripted, since) },
      vision: this.countSince(this.vision, since),
      ttsChars: this.sumSince(this.tts, since),
      ttsCharsByOrigin,
      sttSeconds: this.sumSince(this.stt, since),
      skipped,
    };
  }

  private countSince(events: { at: number }[], since: number): number {
    let n = 0;
    for (const e of events) if (e.at > since) n++;
    return n;
  }

  private sumSince(events: AmountEvent[], since: number): number {
    let n = 0;
    for (const e of events) if (e.at > since) n += e.amount;
    return n;
  }

  /** Nothing older than the longest window (a day) is needed. */
  private prune(): void {
    const cutoff = this.now() - DAY_MS;
    for (const list of [this.ai, this.autonomyAi, this.scripted, this.vision, this.tts, this.stt] as { at: number }[][]) {
      let drop = 0;
      while (drop < list.length && list[drop].at <= cutoff) drop++;
      if (drop) list.splice(0, drop);
    }
    // A minute is dropped once all of it is older than a day
    let drop = 0;
    while (drop < this.skips.length && this.skips[drop].at + SKIP_BUCKET_MS <= cutoff) drop++;
    if (drop) this.skips.splice(0, drop);
  }
}

const k = (n: number) => (n >= 10_000 ? `${(n / 1000).toFixed(0)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);
const tokens = (t: TokenTotals) =>
  `${k(t.inputTokens)} in / ${k(t.outputTokens)} out${t.cacheReadTokens ? ` / ${k(t.cacheReadTokens)} cache read` : ''}`;
const entries = (record: Record<string, number>, format: (n: number) => string = String) =>
  Object.entries(record)
    .sort((a, b) => b[1] - a[1])
    .map(([key, n]) => `${key} ${format(n)}`)
    .join(', ');

/** One line per window, e.g. for logs that are read to tune the limits. */
export function formatUsageReport(s: UsageSnapshot, limits?: UsageLimits): string {
  const window = s.windowMs >= DAY_MS ? '24h' : s.windowMs >= HOUR_MS ? `${Math.round(s.windowMs / HOUR_MS)}h` : `${Math.round(s.windowMs / 60_000)}m`;
  const purposes = Object.entries(s.ai.byPurpose)
    .sort((a, b) => b[1].inputTokens + b[1].outputTokens - (a[1].inputTokens + a[1].outputTokens))
    .map(([purpose, t]) => `${purpose} ${t.calls} (${tokens(t)})`)
    .join(', ');
  const limitNote = limits
    ? ` | limits: calls/h ${limits.aiCallsPerHour ?? '-'}, tokens/24h ${limits.aiTokensPerDay ?? '-'}, vision/h ${limits.visionPerHour ?? '-'}, TTS chars/24h ${limits.ttsCharsPerDay ?? '-'}, STT s/24h ${limits.sttSecondsPerDay ?? '-'}, autonomous AI/h ${limits.autonomyAiPerHour ?? '-'}`
    : '';
  const skipped = entries(Object.fromEntries(Object.entries(s.skipped).filter(([, n]) => n > 0)));
  return [
    `[Usage ${window}] Claude ${s.ai.calls} calls (${tokens(s.ai)}${s.ai.reservedTokens ? ` / ${k(s.ai.reservedTokens)} held for calls in progress or failed` : ''})`,
    s.ai.calls ? `by origin: ${entries(s.ai.byOrigin)}` : null,
    purposes ? `by purpose: ${purposes}` : null,
    `autonomous ticks: ${s.autonomy.aiTicks} AI / ${s.autonomy.scriptedTicks} scripted`,
    `vision ${s.vision}`,
    `TTS ${k(s.ttsChars)} chars${s.ttsChars ? ` (${entries(s.ttsCharsByOrigin, k)})` : ''}`,
    `STT ${Math.round(s.sttSeconds)} s`,
    skipped ? `over limit: ${skipped}` : null,
  ]
    .filter(Boolean)
    .join(' | ') + limitNote;
}

let shared: UsageBudget | null = null;

/** The process-wide meter. */
export function getUsageBudget(): UsageBudget {
  return (shared ??= new UsageBudget());
}

/** Replaces the process-wide meter (tests), or drops it so limits are read again. */
export function resetUsageBudget(budget: UsageBudget | null = null): void {
  shared = budget;
}

let reportTimer: NodeJS.Timeout | null = null;

/** Logs the last interval and the last 24 hours every USAGE_REPORT_INTERVAL_MIN minutes (default 60, 0 = off). */
export function startUsageReports(env: Env = process.env): void {
  if (reportTimer) return;
  // Throws for a value that is not a number, like the limits (the agent does not start then)
  const minutes = parseCount(env.USAGE_REPORT_INTERVAL_MIN, 'USAGE_REPORT_INTERVAL_MIN') ?? 60;
  if (minutes === 0) return;
  const intervalMs = minutes * 60_000;
  const budget = getUsageBudget();
  logger.info(`[Usage] Limits: ${JSON.stringify(budget.limits)}; reporting every ${minutes} min`);
  reportTimer = setInterval(() => {
    logger.info(formatUsageReport(budget.snapshot(intervalMs)));
    if (intervalMs < DAY_MS) logger.info(formatUsageReport(budget.snapshot(DAY_MS), budget.limits));
  }, intervalMs);
  reportTimer.unref?.();
}
