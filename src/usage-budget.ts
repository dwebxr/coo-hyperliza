import { AsyncLocalStorage } from 'node:async_hooks';
import { logger } from '@elizaos/core';

/**
 * Usage meter and budgets for everything that costs money: Claude calls, vision, text-to-speech
 * and speech-to-text. Each is limited separately so running out of one (say, voice) leaves the
 * others working, and scripted behavior (patrol, waves, product links) needs none of them.
 *
 * Counts are in memory, over rolling windows (the last hour / the last 24 hours), and start
 * from zero when the agent restarts.
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

/** The output cap for a tagged call; undefined for untagged calls (other plugins). */
export function maxTokensFor(purpose: unknown, env: Env = process.env): number | undefined {
  if (!isAiPurpose(purpose)) return undefined;
  const override = parseCount(env[purposeEnvKey(purpose)], purposeEnvKey(purpose));
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

const originStore = new AsyncLocalStorage<UsageOrigin>();

/** Runs fn with every model call and speech inside it attributed to origin. */
export function runWithOrigin<T>(origin: UsageOrigin, fn: () => Promise<T>): Promise<T> {
  return originStore.run(origin, fn);
}

export function currentOrigin(): UsageOrigin {
  return originStore.getStore() ?? 'other';
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

const warnedInvalid = new Set<string>();

/** An empty value means "use the default"; a number is the limit (0 turns that use off). */
function parseCount(raw: string | undefined, key: string): number | null {
  const value = raw?.trim();
  if (!value) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    // Read on every call for the per-purpose caps; say it once
    if (!warnedInvalid.has(`${key}=${raw}`)) {
      warnedInvalid.add(`${key}=${raw}`);
      logger.warn(`[Usage] Ignoring invalid ${key}="${raw}" (expected a number of 0 or more)`);
    }
    return null;
  }
  return Math.floor(n);
}

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

type AiEvent = Required<AiCall> & { at: number };
type AmountEvent = { at: number; amount: number; origin: UsageOrigin };
export type SkipKind = 'ai-call' | 'offline-reply' | 'vision' | 'tts' | 'stt';

export interface TokenTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface UsageSnapshot {
  windowMs: number;
  ai: TokenTotals & { byPurpose: Record<string, TokenTotals>; byOrigin: Record<string, number> };
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

const totalTokens = (e: AiEvent) => e.inputTokens + e.outputTokens + e.cacheReadTokens + e.cacheWriteTokens;

export class UsageBudget {
  private ai: AiEvent[] = [];
  private autonomyAi: AmountEvent[] = [];
  private scripted: AmountEvent[] = [];
  private vision: AmountEvent[] = [];
  private tts: AmountEvent[] = [];
  private stt: AmountEvent[] = [];
  private skips: { at: number; kind: SkipKind }[] = [];
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

  /** Why Claude may not be called right now, or null when it may. */
  aiBlockedReason(): string | null {
    const t = this.now();
    const { aiCallsPerHour, aiTokensPerDay } = this.limits;
    if (aiCallsPerHour !== null && this.countSince(this.ai, t - HOUR_MS) >= aiCallsPerHour) {
      return `AI_MAX_CALLS_PER_HOUR=${aiCallsPerHour}`;
    }
    if (aiTokensPerDay !== null) {
      const used = this.ai.reduce((sum, e) => (e.at > t - DAY_MS ? sum + totalTokens(e) : sum), 0);
      if (used >= aiTokensPerDay) return `AI_MAX_TOKENS_PER_DAY=${aiTokensPerDay}`;
    }
    return null;
  }

  aiAvailable(): boolean {
    return this.aiBlockedReason() === null;
  }

  recordAi(call: AiCall): void {
    this.ai.push({ cacheReadTokens: 0, cacheWriteTokens: 0, ...call, at: this.now() });
    this.prune();
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

  recordVision(): void {
    this.vision.push({ at: this.now(), amount: 1, origin: currentOrigin() });
    this.prune();
  }

  // --- Voice (may go over by at most one utterance) ---

  ttsAvailable(): boolean {
    const limit = this.limits.ttsCharsPerDay;
    return limit === null || this.sumSince(this.tts, this.now() - DAY_MS) < limit;
  }

  recordTts(chars: number): void {
    this.tts.push({ at: this.now(), amount: chars, origin: currentOrigin() });
    this.prune();
  }

  sttAvailable(): boolean {
    const limit = this.limits.sttSecondsPerDay;
    return limit === null || this.sumSince(this.stt, this.now() - DAY_MS) < limit;
  }

  recordStt(seconds: number): void {
    this.stt.push({ at: this.now(), amount: seconds, origin: currentOrigin() });
    this.prune();
  }

  recordSkip(kind: SkipKind): void {
    this.skips.push({ at: this.now(), kind });
    this.prune();
  }

  // --- Reporting ---

  snapshot(windowMs: number): UsageSnapshot {
    const since = this.now() - windowMs;
    const ai = { ...emptyTotals(), byPurpose: {} as Record<string, TokenTotals>, byOrigin: {} as Record<string, number> };
    for (const e of this.ai) {
      if (e.at <= since) continue;
      addTo(ai, e);
      addTo((ai.byPurpose[e.purpose] ??= emptyTotals()), e);
      ai.byOrigin[e.origin] = (ai.byOrigin[e.origin] ?? 0) + 1;
    }
    const ttsCharsByOrigin: Record<string, number> = {};
    for (const e of this.tts) {
      if (e.at > since) ttsCharsByOrigin[e.origin] = (ttsCharsByOrigin[e.origin] ?? 0) + e.amount;
    }
    const skipped: Record<SkipKind, number> = { 'ai-call': 0, 'offline-reply': 0, vision: 0, tts: 0, stt: 0 };
    for (const s of this.skips) if (s.at > since) skipped[s.kind]++;
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
    for (const list of [this.ai, this.autonomyAi, this.scripted, this.vision, this.tts, this.stt, this.skips] as { at: number }[][]) {
      let drop = 0;
      while (drop < list.length && list[drop].at <= cutoff) drop++;
      if (drop) list.splice(0, drop);
    }
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
    `[Usage ${window}] Claude ${s.ai.calls} calls (${tokens(s.ai)})`,
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
