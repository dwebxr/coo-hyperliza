import { AsyncLocalStorage } from 'node:async_hooks';
import type { UsageOrigin } from '../../usage-budget';

/**
 * What one unit of the agent's work is acting for: a chat message, a voice utterance or an
 * autonomous tick. The chat, voice and autonomy entry points start one; everything that runs
 * inside it (including the action handlers elizaOS core calls, which get no such argument of
 * their own) reads it with currentTurn().
 *
 * There is no ambient default: code that runs outside any turn sees undefined, and checks
 * that need a turn must fail closed then.
 */

export type TurnOrigin = 'chat' | 'voice' | 'autonomy';

export interface TurnContext {
  readonly origin: TurnOrigin;
  /** The Hyperfy player id of who the turn answers (chat sender, voice speaker); absent for autonomy. */
  readonly requesterId?: string;
  /** The engine world the turn started on. */
  readonly world: object;
  /** The service's connection generation when the turn started. */
  readonly generation: number;
  /** Not wired to any cancellation yet: it never aborts. */
  readonly signal: AbortSignal;
}

interface Scope {
  readonly turn?: TurnContext;
  readonly usageOrigin: UsageOrigin;
}

const store = new AsyncLocalStorage<Scope>();

const USAGE_ORIGIN: Record<TurnOrigin, UsageOrigin> = { chat: 'chat', voice: 'voice', autonomy: 'autonomous' };

/** A signal that never aborts (cancellation is not wired up yet). */
export function neverAbortedSignal(): AbortSignal {
  return new AbortController().signal;
}

/** Runs fn as the given turn. Its usage is attributed to the turn's origin. */
export function runTurn<T>(turn: TurnContext, fn: () => Promise<T>): Promise<T> {
  const frozen: TurnContext = Object.freeze({ ...turn });
  return store.run({ turn: frozen, usageOrigin: USAGE_ORIGIN[frozen.origin] }, fn);
}

/** The turn the caller runs in, or undefined outside every turn. */
export function currentTurn(): TurnContext | undefined {
  return store.getStore()?.turn;
}

const delivered = new WeakSet<TurnContext>();

/** Records that the caller's turn has posted or said something to the world (no-op outside a turn). */
export function noteDelivered(): void {
  const turn = currentTurn();
  if (turn) delivered.add(turn);
}

/** Whether something was posted or said during this turn (see noteDelivered). */
export function turnDelivered(turn: TurnContext | undefined): boolean {
  return !!turn && delivered.has(turn);
}

/** Runs fn with its usage attributed to origin, inside the caller's turn if any (see usage-budget.ts runWithOrigin). */
export function runWithUsageOrigin<T>(origin: UsageOrigin, fn: () => Promise<T>): Promise<T> {
  return store.run({ turn: currentTurn(), usageOrigin: origin }, fn);
}

/** The usage origin of the caller's scope; undefined outside every scope. */
export function currentUsageOrigin(): UsageOrigin | undefined {
  return store.getStore()?.usageOrigin;
}
