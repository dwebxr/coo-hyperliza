/**
 * Page work for one world (its loader and its sky): which assets got the render page killed, and
 * how page work runs once one did.
 *
 * A kill (lib/render-watchdog.ts RenderPageKilled) blames an asset only when its page call was the
 * only one in flight when the kill came; the others in flight are not blamed. From the first kill
 * on, this world's page work runs one call at a time, so that the next kill has one call to
 * blame. A blamed asset fails at once from then on, with the reason, and is logged once.
 *
 * What this does not do: the refused set is bounded (REFUSED_KEPT, the oldest dropped first) and
 * keyed by the asset's type and URL, so the same bytes under other URLs are not recognised. What
 * bounds repeated kills, whatever the URLs, is the process-wide circuit breaker (renderBreaker).
 */
import { RenderPageKilled } from './render-watchdog';

export const REFUSED_KEPT = 256;

export class PageWork {
  #serial = false;
  #tail: Promise<unknown> = Promise.resolve();
  #refused = new Map<string, string>();
  #log: (line: string) => void;

  constructor({ log = (line: string) => console.error(line) }: { log?: (line: string) => void } = {}) {
    this.#log = log;
  }

  /** Whether page work runs one call at a time (after a kill) */
  get serial(): boolean {
    return this.#serial;
  }

  /** Why `key` is not handed to the page again, or undefined */
  refusal(key: string): string | undefined {
    return this.#refused.get(key);
  }

  /** Runs `work` (one page call for the asset `key`, described as `what` in the log) under the rules above. */
  run<T>(key: string, what: string, work: () => Promise<T>): Promise<T> {
    const refused = this.#refused.get(key);
    if (refused) return Promise.reject(new Error(`[PageWork] Not handing ${what} to the render page again: ${refused}`));
    const attempt = async () => {
      try {
        return await work();
      } catch (error) {
        if (error instanceof RenderPageKilled) this.#blame(key, what, error);
        throw error;
      }
    };
    if (!this.#serial) return attempt();
    const turn = this.#tail.then(attempt, attempt);
    this.#tail = turn.catch(() => {});
    return turn;
  }

  #blame(key: string, what: string, error: RenderPageKilled) {
    this.#serial = true;
    if (error.callsInFlight !== 1 || error.initInFlight || this.#refused.has(key)) return;
    this.#refused.set(key, error.message);
    while (this.#refused.size > REFUSED_KEPT) this.#refused.delete(this.#refused.keys().next().value as string);
    this.#log(`[PageWork] ${what} got the render page killed while it was the only page call: it is not handed to the page again for this world (${error.message})`);
  }
}
