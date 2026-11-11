import { type TurnInit, neverAbortedSignal, runTurn } from '../lib/turn-context';
import { sessionAround } from './session-registry';
import { trackWorldIdentity } from '../lib/world-identity';
import { cooWorldSnapshot } from './world-packets';

/** A world object whose identity was recorded from `snapshot` through the real network handler wrappers. */
export function worldFromSnapshot<T extends Record<string, unknown>>(snapshot: unknown, extra: T = {} as T): T & { network: Record<string, any> } {
  const world = { network: {} as Record<string, any>, ...extra };
  trackWorldIdentity(world);
  world.network.onSnapshot(snapshot);
  return world;
}

/** A coo-world (admin code set, world rank visitor) where `player-1` has builder rank. */
export function worldWithBuilder<T extends Record<string, unknown>>(extra: T = {} as T) {
  return worldFromSnapshot(cooWorldSnapshot({ players: [{ id: 'player-1', name: 'Alice', rank: 1 }] }), extra);
}

/**
 * Runs `fn` as a turn on `turn.world`: a turn of the session a test built around that world
 * (test-support/session.ts), or a turn that belongs to no session.
 */
export function inTurn<T>(turn: Pick<TurnInit, 'origin' | 'world'> & Partial<TurnInit>, fn: () => Promise<T>): Promise<T> {
  const session = sessionAround(turn.world);
  if (session && turn.generation === undefined && turn.signal === undefined) return session.runTurn({ origin: turn.origin, requesterId: turn.requesterId, cancel: turn.cancel }, fn);
  return runTurn({ generation: 0, signal: neverAbortedSignal(), ...turn }, fn);
}

/** A chat turn from `requesterId` (default player-1, the builder in worldWithBuilder). */
export function inChatTurn<T>(world: object, fn: () => Promise<T>, requesterId = 'player-1'): Promise<T> {
  return inTurn({ origin: 'chat', world, requesterId }, fn);
}

export function inAutonomousTurn<T>(world: object, fn: () => Promise<T>): Promise<T> {
  return inTurn({ origin: 'autonomy', world }, fn);
}
