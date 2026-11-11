import { type TurnContext, neverAbortedSignal, runTurn } from '../lib/turn-context';
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

export function inTurn<T>(turn: Pick<TurnContext, 'origin' | 'world'> & Partial<TurnContext>, fn: () => Promise<T>): Promise<T> {
  return runTurn({ generation: 0, signal: neverAbortedSignal(), ...turn }, fn);
}

/** A chat turn from `requesterId` (default player-1, the builder in worldWithBuilder). */
export function inChatTurn<T>(world: object, fn: () => Promise<T>, requesterId = 'player-1'): Promise<T> {
  return inTurn({ origin: 'chat', world, requesterId }, fn);
}

export function inAutonomousTurn<T>(world: object, fn: () => Promise<T>): Promise<T> {
  return inTurn({ origin: 'autonomy', world }, fn);
}
