
/**
 * Counts the chat and voice turns in progress and remembers when the last one ended (it excludes
 * nothing). The behavior manager skips its tick while one runs.
 */

export class AgentActivityLock {
    private count = 0;
    private lastExitAt = Number.NEGATIVE_INFINITY;

    constructor(private readonly now: () => number = Date.now) {}

    isActive(): boolean {
      return this.count > 0;
    }

    /** When message activity last ended: now while it is in progress, -Infinity if there was none. */
    lastActivityAt(): number {
      return this.isActive() ? this.now() : this.lastExitAt;
    }

    enter() {
      this.count++;
    }

    exit() {
      this.count = Math.max(0, this.count - 1);
      this.lastExitAt = this.now();
    }

    async run<T>(fn: () => Promise<T>): Promise<T> {
      this.enter();
      try {
        return await fn();
      } finally {
        this.exit();
      }
    }
  }



export const agentActivityLock = new AgentActivityLock();
