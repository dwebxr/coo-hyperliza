import type { TurnOrigin } from '../lib/turn-context';

/** What a test's turn helpers need of a session built around a world (test-support/session.ts). */
export interface TurnRunner {
  runTurn<T>(turn: { origin: TurnOrigin; requesterId?: string; cancel?: AbortSignal }, fn: () => Promise<T>): Promise<T>;
}

const latest = new WeakMap<object, TurnRunner>();

/** Records the session a test built around `world`. */
export function registerSession(world: object, session: TurnRunner): void {
  latest.set(world, session);
}

/** The session a test last built around `world`, if any. */
export function sessionAround(world: object): TurnRunner | undefined {
  return latest.get(world);
}
