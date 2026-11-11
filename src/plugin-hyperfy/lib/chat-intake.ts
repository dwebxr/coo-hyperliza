/**
 * Chat as it comes off the network, made safe to keep and bounded before it costs anything.
 *
 * readChatMessage is the only way a message from the world gets into the local chat history: a
 * new object with exactly the five fields below, or null (lib/world-chat.ts calls it for every
 * chatAdded packet and every element of the snapshot's history).
 *
 * ChatIntake is the conversation queue of one connection. It turns what players say to the agent
 * into turns, one at a time, in the order it arrived: the live chat messages as they came off the
 * socket, and what was heard in voice once it is transcribed (managers/voice-manager.ts hands each
 * transcript in as a message of its speaker). Chat and voice share the one queue because they
 * share one room: the message handler lets only the latest turn of a room answer, and the agent
 * has one voice and one chat to answer in. The sender's clock (createdAt) decides nothing.
 * Everything it keeps is bounded:
 * - the ids it has seen (CHAT_SEEN_IDS, least recently seen forgotten first), the snapshot's
 *   history included (markSeen);
 * - the senders it rate-limits (CHAT_TRACKED_SENDERS, least recently seen forgotten first);
 * - the messages waiting for their turn: CHAT_SENDER_WAITING_MAX per sender (their oldest dropped
 *   first) and CHAT_QUEUE_MAX in all (dropped from whoever has the most waiting).
 * What it does not bound: how long one turn takes within its slot, and what a sender who rotates
 * ids does on a world that lets clients choose their own (upstream Hyperfy; coo-world sets the
 * sender id itself). Each new id of such a sender gets one message once the sender table is full,
 * and a full queue turns its newest message away before anyone's earlier one.
 */

import { RateLimitedLog } from './rate-limited-log';
import { SHOWN_NAME_MAX, oneLine, shownName } from './text';
import { TurnCancelled } from './turn-context';

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
// A handler that takes longer than this (e.g. an action that keeps navigating) stops holding up
// the next message: its turn is cancelled (ChatTurn.signal fires), and what it would still do to
// the world is refused from then on (lib/turn-context.ts assertLive)
export const CHAT_TURN_SLOT_MS = 180_000;
// Per sender: 8 messages at once, then one every 4 s (15 a minute). People send bursts of three
// to five short lines and cannot keep up 15 a minute with an agent that takes seconds to answer;
// one sender can fill at most 8 of the 20 queue places at once.
export const CHAT_SENDER_BURST = 8;
export const CHAT_SENDER_REFILL_MS = 4_000;
// Waiting messages of one sender: its burst, which can arrive within one engine tick. One more
// drops that sender's own oldest, so one sender holds at most 8 of the 20 places; a full queue
// drops from whoever has the most waiting, never from someone with fewer. Sender-less notices,
// together, as many as their burst (CHAT_NOTICE_BURST).
export const CHAT_SENDER_WAITING_MAX = CHAT_SENDER_BURST;
// Notices without a sender share one bucket: 10 at once, then one a second. coo-world announces at
// most 3 tips at once and then one every 3 s, plus a private notice per throttled tip.
export const CHAT_NOTICE_BURST = 10;
export const CHAT_NOTICE_REFILL_MS = 1_000;
// More than a world's player limit. A sender that is not in the table starts with a full bucket
// while the table has room, and with CHAT_NEWCOMER_TOKENS once it is full: forgetting a sender
// by cycling 256 other ids gives it one message back, not a new burst.
export const CHAT_TRACKED_SENDERS = 256;
export const CHAT_NEWCOMER_TOKENS = 1;
// At most one line per kind of drop in this time; the line carries the count since the last one
export const CHAT_DROP_LOG_INTERVAL_MS = 10_000;

/** One turn of the queue. */
export interface ChatTurn {
  /** Fires when the turn outlives its slot, or the intake stops while it runs: the turn may no longer act. */
  readonly signal: AbortSignal;
  readonly cancelled: boolean;
}

export type ChatHandler = (msg: ReceivedChatMessage, turn: ChatTurn) => Promise<void>;

/** 'queue-full': the queue was full of other senders' single messages, so this one was turned away. */
export type ChatAdmission = 'queued' | 'duplicate' | 'rate-limited' | 'queue-full' | 'stopped';
type DropKind = 'rate-limited' | 'sender-waiting' | 'queue-full' | 'stale';

export interface ChatIntakeOptions {
  /** Handles one message as a turn. Its failure is logged and never stops later messages. */
  handle: ChatHandler;
  /**
   * Told, synchronously, of each message the moment it is queued (past de-duplication and its
   * sender's rate limit; not one turned away): what must not wait for its turn (an addressed
   * "stop": session/connection-session.ts). Its failure is logged and changes nothing here.
   */
  admitted?: (msg: ReceivedChatMessage) => void;
  /** Fires when the connection this intake serves ends: the intake stops (see stop). */
  signal?: AbortSignal;
  now?: () => number;
  log?: (line: string) => void;
}

export interface ChatIntakeStats {
  queued: number;
  handled: number;
  duplicate: number;
  rateLimited: number;
  /** Dropped because their sender had CHAT_SENDER_WAITING_MAX messages waiting already */
  senderWaiting: number;
  queueFull: number;
  stale: number;
}

interface Bucket {
  tokens: number;
  at: number;
}

interface Waiting {
  msg: ReceivedChatMessage;
  at: number;
  /** The sender's id; '' for sender-less notices (ids are never empty) */
  key: string;
  /** Handles this message instead of the intake's own handler (a voice transcript) */
  handle?: ChatHandler;
}

const DROP_TEXT: Record<DropKind, string> = {
  'rate-limited': 'from senders over their rate limit',
  'sender-waiting': `from senders who had ${CHAT_SENDER_WAITING_MAX} waiting already (notices: ${CHAT_NOTICE_BURST}; their oldest first)`,
  'queue-full': `because more than ${CHAT_QUEUE_MAX} were waiting (from whoever had the most waiting)`,
  stale: `after waiting longer than ${CHAT_TURN_MAX_AGE_MS / 1000} s for a turn`,
};

export class ChatIntake {
  readonly #handle: ChatHandler;
  readonly #admitted?: (msg: ReceivedChatMessage) => void;
  /** The turn in progress */
  #current: AbortController | null = null;
  readonly #now: () => number;
  readonly #log: (line: string) => void;
  /** Insertion order is recency: the first key is the least recently seen. */
  readonly #seen = new Set<string>();
  readonly #buckets = new Map<string, Bucket>();
  #notices: Bucket;
  readonly #queue: Waiting[] = [];
  /** How many messages each sender has in #queue */
  readonly #waiting = new Map<string, number>();
  #draining: Promise<void> | null = null;
  #stopped = false;
  readonly #stats: ChatIntakeStats = { queued: 0, handled: 0, duplicate: 0, rateLimited: 0, senderWaiting: 0, queueFull: 0, stale: 0 };
  readonly #reports: Record<DropKind, RateLimitedLog>;

  constructor({ handle, admitted, signal, now = Date.now, log = (line) => console.warn(line) }: ChatIntakeOptions) {
    this.#handle = handle;
    this.#admitted = admitted;
    if (signal?.aborted) this.#stopped = true;
    else signal?.addEventListener('abort', () => this.stop(), { once: true });
    this.#now = now;
    this.#log = log;
    this.#notices = { tokens: CHAT_NOTICE_BURST, at: now() };
    const report = (kind: DropKind) =>
      new RateLimitedLog((count) => `[Chat] Dropped ${count} message${count === 1 ? '' : 's'} ${DROP_TEXT[kind]}`, { intervalMs: CHAT_DROP_LOG_INTERVAL_MS, log, now });
    this.#reports = { 'rate-limited': report('rate-limited'), 'sender-waiting': report('sender-waiting'), 'queue-full': report('queue-full'), stale: report('stale') };
  }

  /**
   * One live message from the network (as readChatMessage returned it), in arrival order. With
   * `handle`, that handles its turn instead of the intake's own handler: a voice transcript, which
   * waits, is dropped and gets its slot by the same rules as a chat message of its speaker.
   */
  accept(msg: ReceivedChatMessage, handle?: ChatHandler): ChatAdmission {
    if (this.#stopped) return 'stopped';
    if (this.#seen.has(msg.id)) {
      this.#remember(msg.id);
      this.#stats.duplicate++;
      return 'duplicate';
    }
    this.#remember(msg.id);

    if (!this.#take(msg.fromId)) {
      this.#stats.rateLimited++;
      this.#reports['rate-limited'].note();
      return 'rate-limited';
    }

    const key = msg.fromId ?? '';
    this.#queue.push({ msg, at: this.#now(), key, handle });
    this.#waiting.set(key, (this.#waiting.get(key) ?? 0) + 1);
    this.#stats.queued++;
    let dropped: Waiting | undefined;
    if (this.#waiting.get(key)! > (msg.fromId === null ? CHAT_NOTICE_BURST : CHAT_SENDER_WAITING_MAX)) {
      dropped = this.#dropOldestOf(key);
      this.#stats.senderWaiting++;
      this.#reports['sender-waiting'].note();
    } else if (this.#queue.length > CHAT_QUEUE_MAX) {
      dropped = this.#dropOldestOf(this.#mostWaiting());
      this.#stats.queueFull++;
      this.#reports['queue-full'].note();
    }
    if (dropped?.msg === msg) return 'queue-full';
    try {
      this.#admitted?.(msg);
    } catch (error) {
      this.#log(`[Chat] Acting on message ${msg.id} on arrival failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.#start();
    return 'queued';
  }

  /**
   * Ids the world already showed on this connection (the snapshot's chat history): a live message
   * with one of them is a duplicate. Nothing is queued and no sender's allowance is used.
   */
  markSeen(ids: Iterable<string>): void {
    for (const id of ids) this.#remember(id);
  }

  /** Adds `id` as the most recently seen, forgetting the least recently seen beyond CHAT_SEEN_IDS. */
  #remember(id: string): void {
    this.#seen.delete(id);
    this.#seen.add(id);
    if (this.#seen.size > CHAT_SEEN_IDS) this.#seen.delete(this.#seen.values().next().value as string);
  }

  /**
   * The sender with the most messages waiting; between equals, the one whose latest message came
   * last. When everyone has one waiting, that is the message just accepted: a full queue turns the
   * newest away rather than one that came before it.
   */
  #mostWaiting(): string {
    let most = '';
    let count = 0;
    for (let i = this.#queue.length - 1; i >= 0; i--) {
      const { key } = this.#queue[i];
      const n = this.#waiting.get(key)!;
      if (n > count) {
        count = n;
        most = key;
      }
    }
    return most;
  }

  #dropOldestOf(key: string): Waiting | undefined {
    const index = this.#queue.findIndex((entry) => entry.key === key);
    return index === -1 ? undefined : this.#unqueue(index);
  }

  /** Removes the message at `index` from the queue and returns it. */
  #unqueue(index: number): Waiting {
    const [entry] = this.#queue.splice(index, 1);
    const left = this.#waiting.get(entry.key)! - 1;
    if (left > 0) this.#waiting.set(entry.key, left);
    else this.#waiting.delete(entry.key);
    return entry;
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

  /** Drops what is waiting, accepts nothing more, and cancels the turn in progress (its slot ends now). */
  stop(): void {
    this.#stopped = true;
    this.#queue.length = 0;
    this.#waiting.clear();
    this.#current?.abort(new TurnCancelled('the conversation it belongs to ended'));
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
      bucket = this.#buckets.get(fromId) ?? { tokens: this.#buckets.size >= CHAT_TRACKED_SENDERS ? CHAT_NEWCOMER_TOKENS : CHAT_SENDER_BURST, at: t };
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
      if (this.#stopped) break;
      const { msg, at, handle } = this.#unqueue(0);
      if (this.#now() - at > CHAT_TURN_MAX_AGE_MS) {
        this.#stats.stale++;
        this.#reports.stale.note();
        continue;
      }
      await this.#withinSlot(msg, handle ?? this.#handle);
      this.#stats.handled++;
    }
    // Drops counted since the last line are said now if the interval has passed (never sooner)
    for (const report of Object.values(this.#reports)) report.flushDue();
  }

  /**
   * Runs the handler as one turn and waits for it, at most CHAT_TURN_SLOT_MS. When the slot runs
   * out, or the intake stops, the turn is cancelled and the wait ends; the handler itself cannot be
   * interrupted, so what it does next has to check its turn (lib/turn-context.ts assertLive).
   */
  async #withinSlot(msg: ReceivedChatMessage, handle: ChatHandler): Promise<void> {
    const controller = new AbortController();
    const turn: ChatTurn = {
      signal: controller.signal,
      get cancelled() {
        return controller.signal.aborted;
      },
    };
    this.#current = controller;
    const timer = setTimeout(() => {
      this.#log(`[Chat] Gave up waiting for the turn of message ${msg.id} after ${CHAT_TURN_SLOT_MS / 1000} s; moving on`);
      controller.abort(new TurnCancelled(`its turn took longer than ${CHAT_TURN_SLOT_MS / 1000} s`));
    }, CHAT_TURN_SLOT_MS);
    const cancelled = new Promise<void>((resolve) => controller.signal.addEventListener('abort', () => resolve(), { once: true }));
    const handled = Promise.resolve()
      .then(() => handle(msg, turn))
      .catch((error: unknown) => {
        // A turn that ends because it was cancelled says so in its own log line, not as a failure
        if (error instanceof TurnCancelled) return;
        this.#log(`[Chat] Handling message ${msg.id} failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    try {
      await Promise.race([handled, cancelled]);
    } finally {
      clearTimeout(timer);
      if (this.#current === controller) this.#current = null;
    }
  }

}
