/**
 * Chat as it comes off the network, made safe to keep and bounded before it costs anything.
 *
 * readChatMessage is the only way a message from the world gets into the local chat history: a
 * new object with exactly the five fields below, or null (lib/world-chat.ts calls it for every
 * chatAdded packet and every element of the snapshot's history).
 *
 * ChatIntake turns the live messages into turns, one at a time, in the order they arrived on the
 * socket. The sender's clock (createdAt) decides nothing. Everything it keeps is bounded:
 * - the ids it has seen (CHAT_SEEN_IDS, least recently seen forgotten first);
 * - the senders it rate-limits (CHAT_TRACKED_SENDERS, least recently seen forgotten first);
 * - the messages waiting for their turn (CHAT_QUEUE_MAX, oldest dropped first).
 * What it does not bound: how long one turn takes within its slot, and what a sender who rotates
 * ids does on a world that lets clients choose their own (upstream Hyperfy; coo-world sets the
 * sender id itself). Such a sender is still held by the queue bound.
 */

import { SHOWN_NAME_MAX, oneLine, shownName } from './text';

export interface ChatMessage {
  id: string;
  body: string;
  /** The sender's player id; null for a notice from the world itself. */
  fromId?: string | null;
  from?: string | null;
  createdAt?: string;
}

/** A message as readChatMessage returns it: every field present. */
export interface ReceivedChatMessage extends ChatMessage {
  fromId: string | null;
  from: string | null;
  createdAt: string;
}

// coo-world cuts ids and sender ids to 64 and bodies to 500 (src/core/extras/chatPolicy.js)
export const CHAT_ID_MAX_LENGTH = 64;
export const CHAT_BODY_MAX_CODE_POINTS = 500;
export const CHAT_NAME_MAX_CODE_POINTS = SHOWN_NAME_MAX;

// Ids are keys and go into logs: no whitespace, control or format characters
const ID_UNSAFE = /[\s\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const isId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= CHAT_ID_MAX_LENGTH && !ID_UNSAFE.test(value);

/**
 * The chat message in `raw`, or null when it is not one: not an object, no usable id, a body that
 * is not text or has nothing visible in it, or a sender id / name of the wrong type. The body is
 * one line of at most CHAT_BODY_MAX_CODE_POINTS code points (control characters and line breaks
 * become spaces); the name is at most CHAT_NAME_MAX_CODE_POINTS code points with nothing invisible.
 */
export function readChatMessage(raw: unknown, now: () => number = Date.now): ReceivedChatMessage | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { id, body, fromId, from, createdAt } = raw as Record<string, unknown>;
  if (!isId(id)) return null;
  if (typeof body !== 'string') return null;
  let sender: string | null = null;
  if (fromId !== undefined && fromId !== null) {
    if (!isId(fromId)) return null;
    sender = fromId;
  }
  if (from !== undefined && from !== null && typeof from !== 'string') return null;
  const text = oneLine(body, CHAT_BODY_MAX_CODE_POINTS);
  if (!text) return null;
  return {
    id,
    body: text,
    fromId: sender,
    from: shownName(from, CHAT_NAME_MAX_CODE_POINTS) || null,
    createdAt: typeof createdAt === 'string' && createdAt.length <= CHAT_ID_MAX_LENGTH ? createdAt : new Date(now()).toISOString(),
  };
}

// Far more than the 50 messages a world keeps as history: a replayed id is only handled again
// after 1024 other messages
export const CHAT_SEEN_IDS = 1024;
// Turns run one at a time and take seconds each (a model call, then speech): 20 waiting messages
// are minutes of backlog, more than CHAT_TURN_MAX_AGE_MS lets through anyway
export const CHAT_QUEUE_MAX = 20;
// An answer that starts later than this after its message is noise in a live chat
export const CHAT_TURN_MAX_AGE_MS = 120_000;
// A handler stuck longer than this (e.g. an action that keeps navigating) stops holding up the
// next message; it keeps running, and what it produces later is dropped (ChatTurn.cancelled)
export const CHAT_TURN_SLOT_MS = 180_000;
// Per sender: 8 messages at once, then one every 4 s (15 a minute). People send bursts of three
// to five short lines and cannot keep up 15 a minute with an agent that takes seconds to answer;
// one sender can fill at most 8 of the 20 queue places at once.
export const CHAT_SENDER_BURST = 8;
export const CHAT_SENDER_REFILL_MS = 4_000;
// Notices without a sender share one bucket: 10 at once, then one a second. coo-world announces at
// most 3 tips at once and then one every 3 s, plus a private notice per throttled tip.
export const CHAT_NOTICE_BURST = 10;
export const CHAT_NOTICE_REFILL_MS = 1_000;
// More than a world's player limit. A sender forgotten here starts again with a full bucket,
// which is also what an untouched bucket has after 32 s.
export const CHAT_TRACKED_SENDERS = 256;
// At most one line per kind of drop in this time; the line carries the count
export const CHAT_DROP_LOG_INTERVAL_MS = 10_000;

/** Set when a turn outlives its slot, so its late output is dropped. */
export interface ChatTurn {
  cancelled: boolean;
}

export type ChatAdmission = 'queued' | 'duplicate' | 'rate-limited' | 'stopped';
type DropKind = 'rate-limited' | 'queue-full' | 'stale';

export interface ChatIntakeOptions {
  /** Handles one message as a turn. Its failure is logged and never stops later messages. */
  handle: (msg: ReceivedChatMessage, turn: ChatTurn) => Promise<void>;
  /** False once the connection this intake serves is gone: what is still queued is dropped. */
  isLive?: () => boolean;
  now?: () => number;
  log?: (line: string) => void;
}

export interface ChatIntakeStats {
  queued: number;
  handled: number;
  duplicate: number;
  rateLimited: number;
  queueFull: number;
  stale: number;
}

interface Bucket {
  tokens: number;
  at: number;
}

const DROP_TEXT: Record<DropKind, string> = {
  'rate-limited': 'from senders over their rate limit',
  'queue-full': `because more than ${CHAT_QUEUE_MAX} were waiting (oldest first)`,
  stale: `after waiting longer than ${CHAT_TURN_MAX_AGE_MS / 1000} s for a turn`,
};

export class ChatIntake {
  readonly #handle: ChatIntakeOptions['handle'];
  readonly #isLive: () => boolean;
  readonly #now: () => number;
  readonly #log: (line: string) => void;
  /** Insertion order is recency: the first key is the least recently seen. */
  readonly #seen = new Set<string>();
  readonly #buckets = new Map<string, Bucket>();
  #notices: Bucket;
  readonly #queue: { msg: ReceivedChatMessage; at: number }[] = [];
  #draining: Promise<void> | null = null;
  #stopped = false;
  readonly #stats: ChatIntakeStats = { queued: 0, handled: 0, duplicate: 0, rateLimited: 0, queueFull: 0, stale: 0 };
  readonly #unreported: Record<DropKind, number> = { 'rate-limited': 0, 'queue-full': 0, stale: 0 };
  readonly #reportedAt: Record<DropKind, number> = { 'rate-limited': -Infinity, 'queue-full': -Infinity, stale: -Infinity };

  constructor({ handle, isLive = () => true, now = Date.now, log = (line) => console.warn(line) }: ChatIntakeOptions) {
    this.#handle = handle;
    this.#isLive = isLive;
    this.#now = now;
    this.#log = log;
    this.#notices = { tokens: CHAT_NOTICE_BURST, at: now() };
  }

  /** One live message from the network (as readChatMessage returned it), in arrival order. */
  accept(msg: ReceivedChatMessage): ChatAdmission {
    if (this.#stopped) return 'stopped';
    if (this.#seen.delete(msg.id)) {
      this.#seen.add(msg.id);
      this.#stats.duplicate++;
      return 'duplicate';
    }
    this.#seen.add(msg.id);
    if (this.#seen.size > CHAT_SEEN_IDS) this.#seen.delete(this.#seen.values().next().value as string);

    if (!this.#take(msg.fromId)) {
      this.#stats.rateLimited++;
      this.#dropped('rate-limited');
      return 'rate-limited';
    }

    this.#queue.push({ msg, at: this.#now() });
    this.#stats.queued++;
    if (this.#queue.length > CHAT_QUEUE_MAX) {
      this.#queue.shift();
      this.#stats.queueFull++;
      this.#dropped('queue-full');
    }
    this.#start();
    return 'queued';
  }

  #start(): void {
    this.#draining ??= this.#drain().finally(() => {
      this.#draining = null;
      // A message accepted after the loop saw an empty queue
      if (this.#queue.length) this.#start();
    });
  }

  /** Resolves once nothing is being handled and nothing waits. */
  async idle(): Promise<void> {
    while (this.#draining) await this.#draining;
  }

  /** Drops what is waiting and accepts nothing more. A turn in progress is not interrupted. */
  stop(): void {
    this.#stopped = true;
    this.#queue.length = 0;
  }

  get waiting(): number {
    return this.#queue.length;
  }

  stats(): ChatIntakeStats {
    return { ...this.#stats };
  }

  /** Takes one token from the sender's bucket (the notice bucket when there is no sender). */
  #take(fromId: string | null): boolean {
    const t = this.#now();
    let bucket: Bucket;
    let burst = CHAT_SENDER_BURST;
    let refillMs = CHAT_SENDER_REFILL_MS;
    if (fromId === null) {
      bucket = this.#notices;
      burst = CHAT_NOTICE_BURST;
      refillMs = CHAT_NOTICE_REFILL_MS;
    } else {
      bucket = this.#buckets.get(fromId) ?? { tokens: CHAT_SENDER_BURST, at: t };
      // Re-inserted: the first key stays the least recently seen sender
      this.#buckets.delete(fromId);
      this.#buckets.set(fromId, bucket);
      if (this.#buckets.size > CHAT_TRACKED_SENDERS) this.#buckets.delete(this.#buckets.keys().next().value as string);
    }
    bucket.tokens = Math.min(burst, bucket.tokens + Math.max(0, t - bucket.at) / refillMs);
    bucket.at = t;
    if (bucket.tokens < 1) return false;
    bucket.tokens--;
    return true;
  }

  async #drain(): Promise<void> {
    // Not in the caller's stack: accept() returns before any handler runs
    await Promise.resolve();
    while (this.#queue.length) {
      if (this.#stopped || !this.#isLive()) {
        this.#queue.length = 0;
        break;
      }
      const { msg, at } = this.#queue.shift()!;
      if (this.#now() - at > CHAT_TURN_MAX_AGE_MS) {
        this.#stats.stale++;
        this.#dropped('stale');
        continue;
      }
      const turn: ChatTurn = { cancelled: false };
      // Whatever the timed-out turn produces later is dropped instead of overlapping the next one
      if (!(await this.#withinSlot(msg, turn))) turn.cancelled = true;
      this.#stats.handled++;
    }
    this.#report();
  }

  /** Waits for the handler, at most CHAT_TURN_SLOT_MS. False when the slot ran out. */
  async #withinSlot(msg: ReceivedChatMessage, turn: ChatTurn): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => {
        this.#log(`[Chat] Gave up waiting for the turn of message ${msg.id} after ${CHAT_TURN_SLOT_MS / 1000} s; moving on`);
        resolve(false);
      }, CHAT_TURN_SLOT_MS);
    });
    const handled = Promise.resolve()
      .then(() => this.#handle(msg, turn))
      .then(
        () => true,
        (error: unknown) => {
          this.#log(`[Chat] Handling message ${msg.id} failed: ${error instanceof Error ? error.message : String(error)}`);
          return true;
        }
      );
    try {
      return await Promise.race([handled, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Counts a drop, and says so at most once per CHAT_DROP_LOG_INTERVAL_MS per kind. */
  #dropped(kind: DropKind): void {
    this.#unreported[kind]++;
    if (this.#now() - this.#reportedAt[kind] >= CHAT_DROP_LOG_INTERVAL_MS) this.#report(kind);
  }

  /** Logs the drops not yet reported: of one kind, or of every kind (when the queue runs empty). */
  #report(only?: DropKind): void {
    for (const kind of only ? [only] : (Object.keys(this.#unreported) as DropKind[])) {
      const count = this.#unreported[kind];
      if (!count) continue;
      this.#unreported[kind] = 0;
      this.#reportedAt[kind] = this.#now();
      this.#log(`[Chat] Dropped ${count} message${count === 1 ? '' : 's'} ${DROP_TEXT[kind]}`);
    }
  }
}
