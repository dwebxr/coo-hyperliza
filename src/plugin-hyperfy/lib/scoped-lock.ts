/**
 * Mutual exclusion for one kind of side effect, not for whole turns: a section runs when the
 * sections that asked before it have ended, in the order they asked. A waiter gives up as soon as
 * its signal fires (its turn was cancelled, or its connection ended) and never runs then; a
 * section that has started is not interrupted, so it has to check its own signal after every await.
 *
 * Not re-entrant: a section must not ask for the lock it runs under.
 */
export class ScopedLock {
  #tail: Promise<void> = Promise.resolve();
  #pending = 0;

  /** Whether a section is running or waiting. */
  get busy(): boolean {
    return this.#pending > 0;
  }

  /** Runs `section` alone. Rejects with the signal's reason when it fires before the section started. */
  async run<T>(signal: AbortSignal | undefined, section: () => Promise<T>): Promise<T> {
    if (signal?.aborted) throw abortReason(signal);
    const before = this.#tail;
    let release!: () => void;
    const mine = new Promise<void>((resolve) => (release = resolve));
    // Whoever asks next waits for everything before this section, and for this section
    this.#tail = before.then(() => mine);
    this.#pending++;
    try {
      await untilAborted(before, signal);
      return await section();
    } finally {
      this.#pending--;
      release();
    }
  }
}

function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error('aborted');
}

/** `promise`, or the signal's reason as soon as it fires. */
function untilAborted(promise: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (!signal) return promise;
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    });
  });
}
