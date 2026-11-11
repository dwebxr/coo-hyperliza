/**
 * The world's chat as the agent sees it, with provenance. Only message objects the world's server
 * sent on this connection (chatAdded) can become turns or tip notices. Everything else that lands
 * in world.chat — app scripts calling world.chat(msg, broadcast), the agent's own posts, the
 * engine's local notices such as "You have been disconnected." — is shown in the local chat
 * history but is not a turn, whatever its fromId says. Snapshot history counts as already seen,
 * so nothing from before the connection is replayed: its objects are never live, and its ids go to
 * onHistory listeners (the intake treats a live message with one of them as a duplicate).
 *
 * What the server sends is read by readChatMessage (lib/chat-intake.ts) before it is kept: a
 * chatAdded packet or a history element that is not a chat message is dropped, and what is kept is
 * a new object with a bounded id, body and name. The history is cut to its last MAX_MSGS elements.
 *
 * world.chat.add is replaced: it only appends locally and never sends anything to the world, so
 * no caller (app scripts included) can make the agent post. The agent posts through postAgentChat.
 *
 * Provenance is by object identity, and the marking happens in world.network.onChatAdded/onSnapshot.
 * It holds only against code that cannot reach those handlers or the received objects: app scripts
 * using their script API get frozen copies through the world's 'chat' event and cannot read
 * world.chat.msgs, but code with the raw world object could call network.onChatAdded itself.
 */

import { type ChatMessage, type ReceivedChatMessage, readChatMessage } from './chat-intake';
import { RateLimitedLog } from './rate-limited-log';

export type { ChatMessage };

type Listener = (msgs: unknown[]) => void;

// At most one line about malformed chat in this time; the line carries the count since the last one
const MALFORMED_LOG_INTERVAL_MS = 10_000;

/** The engine systems this module touches (hyperfy/src/core/systems/Chat.js, Events.js, ClientNetwork.js). */
export interface ChatWorld {
  chat: { msgs: unknown[]; listeners: Set<Listener>; add: (msg: unknown, broadcast?: unknown) => void };
  events: { emit: (name: string, data: unknown) => void };
  network: Record<string, unknown> & { send: (name: string, data: unknown) => void };
}

// The engine keeps this many messages (Chat.js CHAT_MAX_MESSAGES)
const MAX_MSGS = 50;

const isObject = (value: unknown): value is object => !!value && typeof value === 'object';

const chats = new WeakMap<object, WorldChat>();

export class WorldChat {
  readonly #world: ChatWorld;
  readonly #arrived = new WeakSet<object>();
  readonly #history = new WeakSet<object>();
  readonly #liveListeners = new Set<(msg: ReceivedChatMessage) => void>();
  readonly #historyListeners = new Set<(ids: readonly string[]) => void>();
  /** The ids of the last snapshot's history (at most MAX_MSGS) */
  #historyIds: readonly string[] = [];
  #malformed = 0;
  readonly #malformedLog = new RateLimitedLog(
    (count, what) => `[Chat] Ignored ${count} chat packet(s) or history element(s) that are not chat messages (the latest a ${what}; ${this.#malformed} so far on this connection)`,
    { intervalMs: MALFORMED_LOG_INTERVAL_MS, log: (line) => console.warn(line) }
  );

  private constructor(world: ChatWorld) {
    this.#world = world;
  }

  /** Installs provenance tracking and the non-broadcasting chat.add on a fresh world, before world.init(). */
  static install(world: ChatWorld): WorldChat {
    const chat = new WorldChat(world);
    const network = world.network;

    world.chat.add = (msg: unknown) => chat.#show(msg);

    const engineOnChatAdded = network.onChatAdded as ((msg: unknown) => unknown) | undefined;
    network.onChatAdded = (raw: unknown) => {
      const msg = readChatMessage(raw);
      if (!msg) return chat.#dropMalformed('chatAdded packet');
      chat.#arrived.add(msg);
      // The engine's handler calls world.chat.add(msg, false), i.e. #show
      const result = engineOnChatAdded ? engineOnChatAdded.call(network, msg) : chat.#show(msg);
      for (const listener of chat.#liveListeners) {
        try {
          listener(msg);
        } catch (error) {
          console.error(`[Chat] A chat listener failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return result;
    };

    const engineOnSnapshot = network.onSnapshot as ((data: unknown) => unknown) | undefined;
    network.onSnapshot = (data: unknown) => {
      if (!isObject(data)) return engineOnSnapshot?.call(network, data);
      // The engine installs data.chat as the chat history as it is: only chat messages, and only
      // as many as the history holds
      const sent = (data as { chat?: unknown }).chat;
      const history: ReceivedChatMessage[] = [];
      for (const raw of Array.isArray(sent) ? sent.slice(-MAX_MSGS) : []) {
        const msg = readChatMessage(raw);
        if (!msg) {
          chat.#dropMalformed('chat history element');
          continue;
        }
        chat.#arrived.add(msg);
        chat.#history.add(msg);
        history.push(msg);
      }
      chat.#historyIds = history.map((msg) => msg.id);
      for (const listener of chat.#historyListeners) {
        try {
          listener(chat.#historyIds);
        } catch (error) {
          console.error(`[Chat] A chat history listener failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return engineOnSnapshot?.call(network, { ...data, chat: history });
    };

    chats.set(world, chat);
    return chat;
  }

  /** Whether msg is a message the world's server sent on this connection after it was joined. */
  isLiveFromNetwork(msg: unknown): boolean {
    return isObject(msg) && this.#arrived.has(msg) && !this.#history.has(msg);
  }

  /**
   * Calls `listener` with every live message from the network (isLiveFromNetwork), once, in the
   * order the packets were handled, after it was added to the chat history. Returns the unsubscribe.
   */
  onLive(listener: (msg: ReceivedChatMessage) => void): () => void {
    this.#liveListeners.add(listener);
    return () => void this.#liveListeners.delete(listener);
  }

  /**
   * Calls `listener` with the ids of the snapshot's chat history: at once with the last snapshot's
   * (when one was received), then with every later one. Returns the unsubscribe.
   */
  onHistory(listener: (ids: readonly string[]) => void): () => void {
    this.#historyListeners.add(listener);
    if (this.#historyIds.length) listener(this.#historyIds);
    return () => void this.#historyListeners.delete(listener);
  }

  /** Counts something the world sent that is not a chat message, and says so (rate-limited). */
  #dropMalformed(what: string): void {
    this.#malformed++;
    this.#malformedLog.note(what);
  }

  /** The agent's own message: shown locally and sent to the world. */
  post(msg: ChatMessage): void {
    this.#show(msg);
    this.#world.network.send('chatAdded', msg);
  }

  /** Appends to the local chat history and notifies its listeners; sends nothing. */
  #show(msg: unknown): void {
    const chat = this.#world.chat;
    chat.msgs = [...chat.msgs, msg];
    if (chat.msgs.length > MAX_MSGS) chat.msgs.shift();
    for (const callback of chat.listeners) callback(chat.msgs);
    // The engine's own add also shows a chat bubble over the sender; that is skipped, as before
    this.#world.events.emit('chat', Object.freeze({ ...(msg as object) }));
  }
}

export const installWorldChat = (world: ChatWorld): WorldChat => WorldChat.install(world);

/** The chat installed on a world, or undefined. */
export function worldChat(world: object): WorldChat | undefined {
  return chats.get(world);
}

/** Posts the agent's own message to the world's chat. Throws when the world's chat is not installed. */
export function postAgentChat(world: object, msg: ChatMessage): void {
  const chat = chats.get(world);
  if (!chat) throw new Error('world chat is not ready');
  chat.post(msg);
}
