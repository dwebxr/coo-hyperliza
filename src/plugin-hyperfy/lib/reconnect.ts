export interface ReconnectDelayOptions {
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitter?: number;
  random?: () => number;
}

export const RECONNECT_BASE_DELAY_MS = 5_000;
export const RECONNECT_MAX_DELAY_MS = 5 * 60_000;

/**
 * Exponential backoff with +/- jitter, capped at maxDelayMs.
 */
export function computeReconnectDelay(attempt: number, options: ReconnectDelayOptions = {}): number {
  const {
    baseDelayMs = RECONNECT_BASE_DELAY_MS,
    maxDelayMs = RECONNECT_MAX_DELAY_MS,
    jitter = 0.2,
    random = Math.random,
  } = options;
  const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempt));
  const factor = 1 + (random() * 2 - 1) * jitter;
  return Math.max(0, Math.min(maxDelayMs, Math.round(exponential * factor)));
}

export interface ReconnectControllerOptions extends ReconnectDelayOptions {
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  onError?: (error: unknown) => void;
}

/**
 * Owns the single pending reconnect timer.
 * - schedule() is a no-op while a timer is pending, a reconnect is running, or after stop().
 * - attempts only reset on markEstablished(), i.e. on evidence of a real session,
 *   so a server that accepts init but drops the socket still backs off.
 * - a failed reconnect schedules the next one itself.
 */
export class ReconnectController {
  private attempts = 0;
  private timer: unknown = null;
  private running = false;
  private stopped = false;
  private slowNext = false;

  constructor(
    private readonly reconnect: () => Promise<void>,
    private readonly options: ReconnectControllerOptions = {}
  ) {}

  get attemptCount(): number {
    return this.attempts;
  }

  get isPending(): boolean {
    return this.timer !== null || this.running;
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  /** A session is up: reset the backoff and drop any retry that is now obsolete. */
  markEstablished(): void {
    this.attempts = 0;
    this.cancelPending();
  }

  /** Makes the next scheduled retry (from any caller) wait the maximum delay. */
  deferNextRetry(): void {
    this.slowNext = true;
  }

  /**
   * @returns the delay in ms, or null when nothing was scheduled.
   */
  schedule({ useMaxDelay = false }: { useMaxDelay?: boolean } = {}): number | null {
    if (this.stopped || this.isPending) return null;

    const delay = useMaxDelay || this.slowNext
      ? this.options.maxDelayMs ?? RECONNECT_MAX_DELAY_MS
      : computeReconnectDelay(this.attempts, this.options);
    this.slowNext = false;
    this.attempts++;

    const setTimer = this.options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.timer = setTimer(() => {
      this.timer = null;
      if (this.stopped) return;
      this.running = true;
      this.reconnect().then(
        () => {
          this.running = false;
        },
        (error) => {
          this.running = false;
          this.options.onError?.(error);
          this.schedule();
        }
      );
    }, delay);
    return delay;
  }

  /** Cancels a pending (not yet running) retry; later schedule() calls still work. */
  cancelPending(): void {
    if (this.timer !== null) {
      const clearTimer = this.options.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
      clearTimer(this.timer);
      this.timer = null;
    }
  }

  /** Cancels any pending timer and refuses further scheduling until resume(). */
  stop(): void {
    this.stopped = true;
    this.cancelPending();
  }

  resume(): void {
    this.stopped = false;
  }
}
