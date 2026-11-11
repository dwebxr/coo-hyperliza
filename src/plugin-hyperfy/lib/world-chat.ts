/**
 * The world's chat as the agent sees it, with provenance. Only message objects the world's server
 * sent on this connection (chatAdded) can become turns or tip notices. Everything else that lands
 * in world.chat — app scripts calling world.chat(msg, broadcast), the agent's own posts, the
 * engine's local notices such as "You have been disconnected." — is shown in the local chat
 * history but is not a turn, whatever its fromId says. Snapshot history counts as already seen,
 * so nothing from before the connection is replayed.
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

export type { ChatMessage };

type Listener = (msgs: unknown[]) => void;

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
  #malformed = 0;

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

  /** Says that the world sent something that is not a chat message: the first time, then every 100th. */
  #dropMalformed(what: string): void {
    if (this.#malformed++ % 100 === 0) {
      console.warn(`[Chat] Ignoring a ${what} that is not a chat message (${this.#malformed} so far on this connection)`);
    }
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
