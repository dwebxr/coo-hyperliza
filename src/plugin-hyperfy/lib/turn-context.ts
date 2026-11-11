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
 *
 * A turn may act only while it is live: its connection (session) has not ended and the turn was
 * not cancelled (its slot ran out, lib/chat-intake.ts). Code that acts for a turn calls
 * assertLive() after every await and right before each effect on the world.
 */

export type TurnOrigin = 'chat' | 'voice' | 'autonomy';

/** Thrown by assertLive(): the turn may no longer act. Nothing the turn planned is done after it. */
export class TurnCancelled extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'TurnCancelled';
  }
}

/** What an entry point gives runTurn. */
export interface TurnInit {
  readonly origin: TurnOrigin;
  /** The Hyperfy player id of who the turn answers (chat sender, voice speaker); absent for autonomy. */
  readonly requesterId?: string;
  /** The engine world the turn started on. */
  readonly world: object;
  /** The generation of the session (connection) the turn started on. */
  readonly generation: number;
  /** The session's signal: fires when the connection the turn started on ends. */
  readonly signal: AbortSignal;
  /** Fires when this turn alone is cancelled (its slot ran out); absent when nothing cancels it. */
  readonly cancel?: AbortSignal;
}

export interface TurnContext {
  readonly origin: TurnOrigin;
  readonly requesterId?: string;
  readonly world: object;
  readonly generation: number;
  /**
   * Fires when the turn is cancelled: its session ended or its slot ran out while it ran, or
   * cancelTurn. What the turn started and awaits (a walk, a wait for a lock) stops with it. A
   * completed turn's signal does not follow its session or slot, so a walk such a turn left
   * running goes on.
   */
  readonly signal: AbortSignal;
  /** False once the turn may no longer act; also after it completed, once its session has ended. */
  readonly live: boolean;
  /** Throws TurnCancelled unless the turn is live. */
  assertLive(): void;
}

interface Scope {
  readonly turn?: TurnContext;
  readonly usageOrigin: UsageOrigin;
}

const store = new AsyncLocalStorage<Scope>();

const USAGE_ORIGIN: Record<TurnOrigin, UsageOrigin> = { chat: 'chat', voice: 'voice', autonomy: 'autonomous' };

const controllers = new WeakMap<TurnContext, AbortController>();

/** A signal that never fires: for work that belongs to no session (tests, tools). */
export function neverAbortedSignal(): AbortSignal {
  return new AbortController().signal;
}

const reasonOf = (signal: AbortSignal, fallback: string): string => {
  const reason: unknown = signal.reason;
  if (reason instanceof TurnCancelled) return reason.message;
  return typeof reason === 'string' && reason ? reason : fallback;
};

/** Runs fn as the given turn. Its usage is attributed to the turn's origin. */
export function runTurn<T>(init: TurnInit, fn: () => Promise<T>): Promise<T> {
  const own = new AbortController();
  const sources: [AbortSignal, string][] = [[init.signal, 'the connection it started on ended']];
  if (init.cancel) sources.push([init.cancel, 'the turn was cancelled']);
  const why = (): string | null => {
    for (const [signal, fallback] of sources) if (signal.aborted) return reasonOf(signal, fallback);
    return own.signal.aborted ? reasonOf(own.signal, 'the turn was cancelled') : null;
  };
  const turn: TurnContext = Object.freeze({
    origin: init.origin,
    requesterId: init.requesterId,
    world: init.world,
    generation: init.generation,
    signal: own.signal,
    get live() {
      return why() === null;
    },
    assertLive() {
      const reason = why();
      if (reason !== null) throw new TurnCancelled(reason);
    },
  });
  controllers.set(turn, own);
  const listeners: [AbortSignal, () => void][] = [];
  for (const [signal, fallback] of sources) {
    const abort = () => own.abort(new TurnCancelled(reasonOf(signal, fallback)));
    if (signal.aborted) abort();
    else {
      signal.addEventListener('abort', abort, { once: true });
      listeners.push([signal, abort]);
    }
  }
  // Only while it runs: a completed turn's signal does not follow its session or slot (see TurnContext.signal)
  const unlink = () => {
    for (const [signal, abort] of listeners) signal.removeEventListener('abort', abort);
  };
  return store.run({ turn, usageOrigin: USAGE_ORIGIN[turn.origin] }, fn).finally(unlink);
}

/** Cancels `turn`: from now on it may no longer act (assertLive throws) and its signal has fired. */
export function cancelTurn(turn: TurnContext, reason: string): void {
  controllers.get(turn)?.abort(new TurnCancelled(reason));
}

/** The turn the caller runs in, or undefined outside every turn. */
export function currentTurn(): TurnContext | undefined {
  return store.getStore()?.turn;
}

/** Throws TurnCancelled when the caller runs in a turn that may no longer act; nothing outside a turn. */
export function assertTurnLive(): void {
  currentTurn()?.assertLive();
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
