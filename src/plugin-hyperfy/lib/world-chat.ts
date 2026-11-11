/**
 * The world's chat as the agent sees it, with provenance. Only message objects the world's server
 * sent on this connection (chatAdded) can become turns or tip notices. Everything else that lands
 * in world.chat — app scripts calling world.chat(msg, broadcast), the agent's own posts, the
 * engine's local notices such as "You have been disconnected." — is shown in the local chat
 * history but is not a turn, whatever its fromId says. Snapshot history counts as already seen,
 * so nothing from before the connection is replayed.
 *
 * world.chat.add is replaced: it only appends locally and never sends anything to the world, so
 * no caller (app scripts included) can make the agent post. The agent posts through postAgentChat.
 *
 * Provenance is by object identity, and the marking happens in world.network.onChatAdded/onSnapshot.
 * It holds only against code that cannot reach those handlers or the received objects: app scripts
 * using their script API get frozen copies through the world's 'chat' event and cannot read
 * world.chat.msgs, but code with the raw world object could call network.onChatAdded itself.
 */

export interface ChatMessage {
  id: string;
  body: string;
  fromId?: string | null;
  from?: string | null;
  createdAt: string;
}

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

  private constructor(world: ChatWorld) {
    this.#world = world;
  }

  /** Installs provenance tracking and the non-broadcasting chat.add on a fresh world, before world.init(). */
  static install(world: ChatWorld): WorldChat {
    const chat = new WorldChat(world);
    const network = world.network;

    world.chat.add = (msg: unknown) => chat.#show(msg);

    const engineOnChatAdded = network.onChatAdded as ((msg: unknown) => unknown) | undefined;
    network.onChatAdded = (msg: unknown) => {
      if (isObject(msg)) chat.#arrived.add(msg);
      // The engine's handler calls world.chat.add(msg, false), i.e. #show
      return engineOnChatAdded ? engineOnChatAdded.call(network, msg) : chat.#show(msg);
    };

    const engineOnSnapshot = network.onSnapshot as ((data: unknown) => unknown) | undefined;
    network.onSnapshot = (data: unknown) => {
      const history = isObject(data) ? (data as { chat?: unknown }).chat : undefined;
      if (Array.isArray(history)) {
        for (const msg of history) {
          if (!isObject(msg)) continue;
          chat.#arrived.add(msg);
          chat.#history.add(msg);
        }
      }
      return engineOnSnapshot?.call(network, data);
    };

    chats.set(world, chat);
    return chat;
  }

  /** Whether msg is a message the world's server sent on this connection after it was joined. */
  isLiveFromNetwork(msg: unknown): boolean {
    return isObject(msg) && this.#arrived.has(msg) && !this.#history.has(msg);
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
