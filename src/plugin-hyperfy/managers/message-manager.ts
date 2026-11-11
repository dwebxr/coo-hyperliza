import { ChannelType, Entity, Content, HandlerCallback, IAgentRuntime, Memory, UUID, formatTimestamp, createUniqueUuid, getEntityDetails, logger } from "@elizaos/core";
import type { ConnectionSession } from "../session/connection-session";
import { type ReplyContext, deliverReply } from "../session/deliver-reply";
import { agentActivityLock } from "./guards";
import { hyperfyEventType } from "../events";
import { countOtherPlayers } from "../utils";
import { isDirectlyAddressed, parseAliases } from "../lib/addressing";
import { splitChatText } from "../lib/chat-chunks";
import { currentTurn, noteDelivered } from "../lib/turn-context";
import { postAgentChat, worldChat } from "../lib/world-chat";
import type { ChatMessage, ChatTurn } from "../lib/chat-intake";
import { isJapanese } from "../lib/simple-commands";
import { type TipNotice, TipThanksLimiter, announcedName, namesakeOf, parseTipNotice, privateLookalikeOf, tipThanks, tipThought } from "../lib/tip-notice";
import { oneLine, shownName, shownNames } from "../lib/text";
import moment from 'moment'
import { uuid } from '../hyperfy/src/core/utils';

export type { ChatTurn };

// One message of the history in a prompt: what a stored memory holds was bounded when it was
// received, but rows stored by earlier versions were not
export const HISTORY_TEXT_MAX_CODE_POINTS = 1000;
// The action names of one stored reply in a prompt: a reply names a few; each is one short line
export const PROMPT_ACTIONS_MAX = 8;
export const PROMPT_ACTION_NAME_MAX = 48;
// How often the log says that tip announcements were not thanked for (they are counted)
const TIP_SKIP_LOG_INTERVAL_MS = 60_000;
// What the agent does while thanking for a tip, where the world has the clip
const TIP_THANKS_EMOTE = 'waving both hands';

// Players whose language is remembered for tip thanks
const MAX_REMEMBERED_SENDERS = 500;

/** The chat of one connection: its messages as turns, and the agent's own posts. */
export class MessageManager {
  private runtime: IAgentRuntime;
  private session: ConnectionSession;
  /** Whether each player (by display name) last wrote in Japanese. */
  private senderJapanese = new Map<string, boolean>();
  /** Per connection, like the manager: how often tip announcements are thanked for */
  private tipThanksLimiter = new TipThanksLimiter();
  private tipThanksSkipped = 0;
  private tipThanksSkipLoggedAt = Number.NEGATIVE_INFINITY;

  constructor(runtime: IAgentRuntime, session: ConnectionSession) {
    this.runtime = runtime;
    this.session = session;
    if (!this.runtime.character.templates) {
      this.runtime.character.templates = {};
    }
  }

  /**
   * Handles one chat message as a turn. `msg` is what lib/chat-intake.ts readChatMessage made of a
   * packet (one-line body of at most 500 code points, bounded name and ids). `slot`: the queue's
   * turn; when its signal fires the turn may no longer act.
   */
  async handleMessage(msg: ChatMessage, slot?: ChatTurn): Promise<void> {
    const session = this.session;
    const world = session.world;
    // maybe a thinking emote here?
    await session.runTurn({
      origin: 'chat',
      // Set by the world's server on coo-world; chosen by the sending client on upstream Hyperfy
      requesterId: typeof msg.fromId === 'string' && msg.fromId ? msg.fromId : undefined,
      cancel: slot?.signal,
    }, () => agentActivityLock.run(async () => {
      const agentPlayerId = world.entities.player.data.id // Get agent's ID
      // A player without a visible name is not shown as anything that sounds like the world itself
      const senderName = msg.from || (msg.fromId ? 'Anonymous' : 'World')
      const messageBody = msg.body || ''
      const _currentWorldId = session.worldId;
      console.info(`[Chat Received] From: ${senderName}, ID: ${msg.id}, Body: "${messageBody}"`)

      // World notices have no sender. coo-world sets fromId itself, so players cannot send one;
      // a server that relays chat as clients wrote it can, so a tip announcement counts only once
      // this connection's tip wallet has been signed in and shown as receiving tips, and only when
      // the message object is one the world's server sent on this connection. Nothing is checked
      // on chain: such a world can still announce a tip that did not happen.
      if (!msg.fromId) {
        const agentName = world.entities.player.data?.name || this.runtime.character.name
        const tip = parseTipNotice(messageBody, agentName)
        if (!tip) return
        if (!worldChat(world)?.isLiveFromNetwork(msg)) {
          logger.warn(`[Tips] Ignoring a tip announcement that did not come from the world's server`)
        } else if (tip.addressed === 'privately' && privateLookalikeOf(world.entities.items?.entries?.() ?? [], agentPlayerId)) {
          // Someone here could have produced this text as a public announcement to another player
          logger.info(`[Tips] Ignoring a private-looking tip notice: a player here has a name that makes public announcements read like one`)
        } else if (namesakeOf(agentName, world.entities.items?.entries?.() ?? [], agentPlayerId)) {
          // The world names the recipient only by text: this one may be the namesake's
          logger.info(`[Tips] Ignoring a tip announcement to "${announcedName(agentName)}": another player here has that name`)
        } else if (!session.tipWallet?.receivedOnThisConnection) {
          logger.info(`[Tips] Ignoring a tip announcement: the agent has not been receiving tips on this connection`)
        } else if (!this.tipThanksLimiter.allow(tip.fromName)) {
          this.noteTipNotThanked()
        } else {
          await this.thankForTip(tip)
        }
        return
      }

      // Respond only to messages not from the agent itself
      if (msg.fromId && msg.fromId !== agentPlayerId) {
        console.info(`[Hyperfy Chat] Processing message from ${senderName}`)
        this.rememberLanguage(senderName, messageBody)

        // First, ensure we register the entity (world, room, sender) in Eliza properly
        const hyperfyWorldId = createUniqueUuid(this.runtime, 'hyperfy-world') as UUID
        const elizaRoomId = createUniqueUuid(this.runtime, _currentWorldId || 'hyperfy-unknown-world')
        const entityId = createUniqueUuid(this.runtime, msg.fromId.toString()) as UUID

        console.debug(`[Hyperfy Chat] Creating entity connection for: ${entityId}`)
        // Ensure connection for the sender entity
        await this.runtime.ensureConnection({
          entityId: entityId,
          roomId: elizaRoomId,
          // Core stores it as metadata.hyperfy.id: the player id the history shows next to the name
          userId: msg.fromId as UUID,
          userName: senderName,
          name: senderName,
          source: 'hyperfy',
          channelId: _currentWorldId,
          type: ChannelType.WORLD,
          worldId: hyperfyWorldId,
        })

        // Create the message memory
        const messageId = createUniqueUuid(this.runtime, msg.id.toString()) as UUID
        console.debug(`[Hyperfy Chat] Creating memory: ${messageId}`)
        const agentNames = [this.runtime.character.name, ...parseAliases(process.env.HYPERFY_AGENT_ALIASES)]
        const memory: Memory = {
          id: messageId,
          entityId: entityId,
          agentId: this.runtime.agentId,
          roomId: elizaRoomId,
          worldId: hyperfyWorldId,
          content: {
            text: messageBody,
            source: 'hyperfy',
            channelType: ChannelType.WORLD,
            metadata: {
              hyperfyMessageId: msg.id,
              hyperfyFromId: msg.fromId,
              hyperfyFromName: senderName,
              // Let the handler skip the "should I respond?" LLM call when the answer is obvious
              directlyAddressed: isDirectlyAddressed(messageBody, agentNames),
              soloPlayer: countOtherPlayers(world) === 1,
              // A stop command that already stopped the agent when it arrived: this turn only acknowledges it
              ...(session.stoppedOnArrival(msg.id) ? { hyperfyStopTaken: true } : {}),
            },
          },
          createdAt: Date.now(),
        }

        // Every reply of this turn goes out through the one delivery path (session/deliver-reply.ts)
        const reply = this.replyContext(elizaRoomId);
        const callback: HandlerCallback = async (responseContent: Content): Promise<Memory[]> => {
          await deliverReply(reply, responseContent);
          return [];
        };

        // Ensure the entity actually exists in DB before event emission
        try {
          const entity = await this.runtime.getEntityById(entityId)
          if (!entity) {
            console.warn(
              `[Hyperfy Chat] Entity ${entityId} not found in database after creation, creating directly`
            )
            await this.runtime.createEntity({
              id: entityId,
              names: [senderName],
              agentId: this.runtime.agentId,
              metadata: {
                hyperfy: {
                  id: msg.fromId,
                  userName: senderName,
                  name: senderName,
                },
              },
            })
          }
        } catch (error) {
          console.error(`[Hyperfy Chat] Error checking/creating entity: ${error}`)
        }
        // Nothing is asked of the model for a turn that was cancelled while it was being set up
        if (!reply.turn.live) return

        // emitEvent awaits the handler, so the activity lock above covers the whole turn
        console.info(`[Hyperfy Chat] Emitting MESSAGE_RECEIVED event for message: ${messageId}`)
        await this.runtime.emitEvent(hyperfyEventType.MESSAGE_RECEIVED as string, {
            runtime: this.runtime,
            message: memory,
            callback: callback,
            source: 'hyperfy',
          } as any,
        )

        console.info(`[Hyperfy Chat] Successfully emitted event for message: ${messageId}`)
      }
    }));
  }

  /** What deliverReply needs for a reply of the caller's turn into `roomId`. */
  private replyContext(roomId: UUID, memory?: Partial<Content>): ReplyContext {
    const turn = currentTurn();
    if (!turn) throw new Error('a reply is delivered inside a turn');
    return { turn, runtime: this.runtime, session: this.session, roomId, memory };
  }

  private rememberLanguage(name: string, text: string) {
    this.senderJapanese.delete(name)
    this.senderJapanese.set(name, isJapanese(text))
    if (this.senderJapanese.size > MAX_REMEMBERED_SENDERS) {
      this.senderJapanese.delete(this.senderJapanese.keys().next().value as string)
    }
  }

  /** Thanks a player for a tip without a model call: turns to them, says thanks, remembers it. */
  private async thankForTip(tip: TipNotice) {
    const session = this.session
    const world = session.world
    if (!currentTurn()?.live) return
    logger.info(`[Tips] The world announced a tip: ${tip.fromName} tipped ${tip.amount} ${tip.token} (not checked on chain)`)
    // JPYC tippers are most likely Japanese speakers
    const text = tipThanks(tip, this.senderJapanese.get(tip.fromName) ?? true)

    const selfId = world.entities.player?.data?.id
    for (const [id, entity] of world.entities.items?.entries?.() ?? []) {
      // The announcement names the tipper as coo-world's shown() writes names
      if (id !== selfId && entity?.data?.type === 'player' && shownName(entity.data.name) === tip.fromName) {
        world.controls?.faceEntity?.(id, undefined, { signal: currentTurn()?.signal })?.catch?.(() => {})
        break
      }
    }
    await deliverReply(this.replyContext(createUniqueUuid(this.runtime, session.worldId || 'hyperfy-unknown-world')), {
      text,
      thought: tipThought(tip),
      source: 'hyperfy',
      ...(session.emotes.hasEmote(TIP_THANKS_EMOTE) ? { emote: TIP_THANKS_EMOTE } : {}),
    })
  }

  /** Counts an announcement that was not thanked for (rate limit) and says so at most once a minute. */
  private noteTipNotThanked() {
    this.tipThanksSkipped++
    if (Date.now() - this.tipThanksSkipLoggedAt < TIP_SKIP_LOG_INTERVAL_MS) return
    this.tipThanksSkipLoggedAt = Date.now()
    logger.info(`[Tips] Not thanking for ${this.tipThanksSkipped} tip announcement(s): thanks are limited per name and overall`)
    this.tipThanksSkipped = 0
  }

  /**
   * Posts to this connection's world chat: the one way the agent's text gets there. Nothing is
   * posted once the connection has ended, or for a turn that may no longer act (the caller's, when
   * it runs in one). Never throws (callers fire and forget); returns false if nothing was posted or
   * on failure. If posting fails partway through, earlier chunks have already been posted and are
   * not rolled back.
   */
  async sendMessage(text: string): Promise<boolean> {
    try {
      const chunks = splitChatText(text);
      if (!chunks.length) return false;

      const session = this.session;
      const world = session.world;
      const turn = currentTurn();
      if (session.ended || (turn && !turn.live)) {
        logger.info('[Hyperfy Chat] Not posting: the connection ended or the turn was cancelled');
        return false;
      }
      if (!world?.chat || !world?.entities?.player) {
        console.error('HyperfyService: Cannot send message. Not ready.')
        return false
      }

      const agentPlayerId = world.entities.player.data.id
      const agentPlayerName = world.entities.player.data?.name || 'Hyperliza'

      console.info(`HyperfyService sending message: "${text}" as ${agentPlayerName} (${agentPlayerId})`)

      // Not world.chat.add, which never broadcasts (lib/world-chat.ts)
      for (const body of chunks) {
        postAgentChat(world, {
          id: uuid(),
          body,
          fromId: agentPlayerId,
          from: agentPlayerName,
          createdAt: moment().toISOString()
        })
        // Per chunk: a later chunk that fails does not undo what was posted
        noteDelivered()
      }
      return true
    } catch (error: any) {
      console.error('Error sending Hyperfy message:', error.message, error.stack)
      return false
    }
  }

  formatMessages({
    messages,
    entities,
  }: {
    messages: Memory[];
    entities: Entity[];
  }) {
    
    const messageStrings = messages
      .filter((message: Memory) => message.entityId)
      .reverse()
      .map((message: Memory) => {
        const content = message.content as Content;
        const messageText = oneLine(typeof content.text === 'string' ? content.text : '', HISTORY_TEXT_MAX_CODE_POINTS);
        const messageActions = content.actions;
  
        const entity = entities.find((e: Entity) => e.id === message.entityId) as any;
        const formattedName = (() => {
          try {
            const parsedData = JSON.parse(entity?.data || '{}');
            const hyperfyData = parsedData.hyperfy || {};
            return (
              hyperfyData.userName ||
              hyperfyData.name ||
              (entity?.names || []).find((n: string) => n.toLowerCase() !== 'anonymous') ||
              'Unknown User'
            );
          } catch (e) {
            return (
              (entity?.names || []).find((n: string) => n.toLowerCase() !== 'anonymous') ||
              'Unknown User'
            );
          }
        })();

        const formattedId = (() => {
          try {
            return JSON.parse(entity?.data || '{}')?.hyperfy?.id ?? "";
          } catch {
            return "";
          }
        })();
  
        const createdAt = message.createdAt ?? 0;
        const messageTime = new Date(createdAt);
        const hours = messageTime.getHours().toString().padStart(2, "0");
        const minutes = messageTime.getMinutes().toString().padStart(2, "0");
        const timeString = `${hours}:${minutes}`;
  
        const timestamp = formatTimestamp(createdAt);
  
        const actionNames = shownNames(messageActions, PROMPT_ACTIONS_MAX, PROMPT_ACTION_NAME_MAX);
        const actionString = actionNames.length > 0 ? ` (${actionNames.join(", ")})` : "";
  
        const textPart = messageText ? `: ${messageText}` : "";
  
        const formattedLine = `- ${timeString} (${timestamp}) ${shownName(formattedName) || 'Unknown User'} [${shownName(String(formattedId), 64)}]${actionString}${textPart}`;
  
        return formattedLine;
      })
      .filter(Boolean)
      .join("\n");
  
    return messageStrings;
  }
  

  async getRecentMessages(roomId: UUID, count = 20) {
    const [entitiesData, recentMessagesData] = await Promise.all([
      getEntityDetails({ runtime: this.runtime, roomId }),
      this.runtime.getMemories({
        tableName: 'messages',
        roomId,
        count,
        unique: false,
      }),
    ]);
    const formattedHistory = this.formatMessages({
      messages: recentMessagesData,
      entities: entitiesData,
    });

    const lastResponseText = recentMessagesData
      .filter(msg =>
        msg.entityId === this.runtime.agentId &&
        typeof msg.content?.text === 'string' &&
        msg.content.text.trim() !== ''
      )
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0]?.content.text || null;

    const lastActions = recentMessagesData
      .filter(msg =>
        msg.entityId === this.runtime.agentId &&
        Array.isArray(msg.content?.actions) &&
        msg.content.actions.length > 0
      )
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0]?.content.actions || [];

    return {
      formattedHistory,
      lastResponseText,
      lastActions,
    };
  }
}
