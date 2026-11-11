/**
 * A log line for something that can happen many times a second (dropped input): at most one line
 * per interval, carrying how many times it happened since the line before. The first occurrence
 * is said at once; later ones within the interval are counted and said with the next line, which
 * comes with the next occurrence (or flushDue()) once the interval has passed.
 */
export class RateLimitedLog {
  readonly #intervalMs: number;
  readonly #log: (line: string) => void;
  readonly #now: () => number;
  readonly #line: (count: number, detail: string | undefined) => string;
  #unreported = 0;
  #detail: string | undefined;
  #loggedAt = Number.NEGATIVE_INFINITY;

  constructor(
    line: (count: number, detail: string | undefined) => string,
    { intervalMs, log, now = () => Date.now() }: { intervalMs: number; log: (line: string) => void; now?: () => number }
  ) {
    this.#line = line;
    this.#intervalMs = intervalMs;
    this.#log = log;
    this.#now = now;
  }

  /** Counts one occurrence (`detail`: what the line says about the latest one) and logs when due. */
  note(detail?: string): void {
    this.#unreported++;
    this.#detail = detail;
    this.flushDue();
  }

  /** Logs what was counted since the last line, if anything was and the interval has passed. */
  flushDue(): void {
    if (!this.#unreported || this.#now() - this.#loggedAt < this.#intervalMs) return;
    const count = this.#unreported;
    this.#unreported = 0;
    this.#loggedAt = this.#now();
    this.#log(this.#line(count, this.#detail));
  }

  /** Occurrences counted and not said yet. */
  get unreported(): number {
    return this.#unreported;
  }
}
