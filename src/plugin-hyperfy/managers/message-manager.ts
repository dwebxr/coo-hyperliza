import { ChannelType, Entity, Content, HandlerCallback, IAgentRuntime, Memory, UUID, formatTimestamp, createUniqueUuid, getEntityDetails, logger } from "@elizaos/core";
import { HyperfyService } from "../service";
import { agentActivityLock } from "./guards";
import { hyperfyEventType } from "../events";
import { countOtherPlayers } from "../utils";
import { isDirectlyAddressed, parseAliases } from "../lib/addressing";
import { splitChatText } from "../lib/chat-chunks";
import { isOpenPayLink } from "../../openpay-store";
import { type TurnContext, neverAbortedSignal, noteDelivered, runTurn } from "../lib/turn-context";
import { postAgentChat, worldChat } from "../lib/world-chat";
import type { ChatMessage, ChatTurn } from "../lib/chat-intake";
import { isJapanese } from "../lib/simple-commands";
import { type TipNotice, TipThanksLimiter, parseTipNotice, tipThanks, tipThought } from "../lib/tip-notice";
import { oneLine, shownName } from "../lib/text";
import moment from 'moment'
import { uuid } from '../hyperfy/src/core/utils';

export type { ChatTurn };

// One message of the history in a prompt: what a stored memory holds was bounded when it was
// received, but rows stored by earlier versions were not
const HISTORY_TEXT_MAX_CODE_POINTS = 1000;
// How often the log says that tip announcements were not thanked for (they are counted)
const TIP_SKIP_LOG_INTERVAL_MS = 60_000;

// Players whose language is remembered for tip thanks
const MAX_REMEMBERED_SENDERS = 500;

export class MessageManager {
  private runtime: IAgentRuntime;
  // Managers are per connection; replies from turns that started before a teardown are dropped
  private stopped = false;
  /** Whether each player (by display name) last wrote in Japanese. */
  private senderJapanese = new Map<string, boolean>();
  /** Per connection, like the manager: how often tip announcements are thanked for */
  private tipThanksLimiter = new TipThanksLimiter();
  private tipThanksSkipped = 0;
  private tipThanksSkipLoggedAt = Number.NEGATIVE_INFINITY;

  constructor(runtime: IAgentRuntime) {
    this.runtime = runtime;
    if (!this.runtime.character.templates) {
      this.runtime.character.templates = {};
    }
  }

  stop() {
    this.stopped = true;
  }

  /**
   * Handles one chat message as a turn. `msg` is what lib/chat-intake.ts readChatMessage made of a
   * packet (one-line body of at most 500 code points, bounded name and ids).
   */
  async handleMessage(msg: ChatMessage, turn?: ChatTurn): Promise<void> {
    const service = this.getService();
    const world = service.getWorld();
    const context: TurnContext = {
      origin: 'chat',
      // Set by the world's server on coo-world; chosen by the sending client on upstream Hyperfy
      requesterId: typeof msg.fromId === 'string' && msg.fromId ? msg.fromId : undefined,
      world,
      generation: service.getConnectionGeneration(),
      signal: neverAbortedSignal(),
    };
    // maybe a thinking emote here?
    await runTurn(context, () => agentActivityLock.run(async () => {
      const agentPlayerId = world.entities.player.data.id // Get agent's ID
      // A player without a visible name is not shown as anything that sounds like the world itself
      const senderName = msg.from || (msg.fromId ? 'Anonymous' : 'World')
      const messageBody = msg.body || ''
      const _currentWorldId = service.currentWorldId;
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
        } else if (!service.getTipWallet?.()?.receivedOnThisConnection) {
          logger.info(`[Tips] Ignoring a tip announcement: the agent has not been receiving tips on this connection`)
        } else if (!this.tipThanksLimiter.allow(tip.fromName)) {
          this.noteTipNotThanked()
        } else {
          await this.thankForTip(tip, service, world)
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
            },
          },
          createdAt: Date.now(),
        }

        // Create a callback function to handle responses
        const callback: HandlerCallback = async (responseContent: Content): Promise<Memory[]> => {
          console.info(`[Hyperfy Chat Callback] Received response: ${JSON.stringify(responseContent)}`)
          if (this.stopped || turn?.cancelled || service.getWorld() !== world) {
            logger.info(`[Hyperfy Chat] Dropping a late reply to ${msg.id}: its turn timed out or the connection changed`);
            return [];
          }
          const emote = responseContent.emote as string;
          // Send response back to Hyperfy
          const emoteManager = service.getEmoteManager();
          if (emote) {
            emoteManager.playEmote(emote);
          }
          if (responseContent.text && isOpenPayLink(responseContent)) {
            // Shop links are posted, never read aloud
            this.sendMessage(responseContent.text);
          } else if (responseContent.text) {
            this.sendMessage(responseContent.text);
            await service.getVoiceManager()?.speak(responseContent.text);
          }
          const callbackMemory: Memory = {
            id: createUniqueUuid(this.runtime, Date.now().toString()),
            entityId: this.runtime.agentId,
            agentId: this.runtime.agentId,
            content: {
              ...responseContent,
              channelType: ChannelType.WORLD,
              emote
            },
            roomId: elizaRoomId,
            createdAt: Date.now(),
          };

          await this.runtime.createMemory(callbackMemory, 'messages');

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

  private rememberLanguage(name: string, text: string) {
    this.senderJapanese.delete(name)
    this.senderJapanese.set(name, isJapanese(text))
    if (this.senderJapanese.size > MAX_REMEMBERED_SENDERS) {
      this.senderJapanese.delete(this.senderJapanese.keys().next().value)
    }
  }

  /** Thanks a player for a tip without a model call: turns to them, says thanks, remembers it. */
  private async thankForTip(tip: TipNotice, service: HyperfyService, world: any) {
    if (this.stopped || service.getWorld() !== world) return
    logger.info(`[Tips] The world announced a tip: ${tip.fromName} tipped ${tip.amount} ${tip.token} (not checked on chain)`)
    // JPYC tippers are most likely Japanese speakers
    const text = tipThanks(tip, this.senderJapanese.get(tip.fromName) ?? true)

    const selfId = world.entities.player?.data?.id
    for (const [id, entity] of world.entities.items?.entries?.() ?? []) {
      // The announcement names the tipper as coo-world's shown() writes names
      if (id !== selfId && entity?.data?.type === 'player' && shownName(entity.data.name) === tip.fromName) {
        world.controls?.faceEntity?.(id)?.catch?.(() => {})
        break
      }
    }
    const emotes = service.getEmoteManager()
    if (emotes?.hasEmote?.('waving both hands')) emotes.playEmote('waving both hands')

    this.sendMessage(text)
    await service.getVoiceManager()?.speak(text)
    await this.runtime.createMemory({
      id: createUniqueUuid(this.runtime, `tip-thanks-${Date.now()}`),
      entityId: this.runtime.agentId,
      agentId: this.runtime.agentId,
      roomId: createUniqueUuid(this.runtime, service.currentWorldId || 'hyperfy-unknown-world'),
      content: {
        text,
        thought: tipThought(tip),
        source: 'hyperfy',
        channelType: ChannelType.WORLD,
      },
      createdAt: Date.now(),
    }, 'messages')
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
   * Posts to world chat. Never throws (callers fire and forget); returns false if empty or on failure.
   * If posting fails partway through, earlier chunks have already been posted and are not rolled back.
   */
  async sendMessage(text: string): Promise<boolean> {
    try {
      const chunks = splitChatText(text);
      if (!chunks.length) return false;

      const service = this.runtime.getService<HyperfyService>(HyperfyService.serviceType);
      const world = service?.getWorld();
      if (!service?.isConnected() || !world?.chat || !world?.entities?.player) {
        console.error('HyperfyService: Cannot send message. Not ready.')
        return false
      }

      const agentPlayerId = world.entities.player.data.id
      const agentPlayerName = service.getEntityName(agentPlayerId) || world.entities.player.data?.name || 'Hyperliza'

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
              (entity?.names || []).find(n => n.toLowerCase() !== 'anonymous') ||
              'Unknown User'
            );
          } catch (e) {
            return (
              (entity?.names || []).find(n => n.toLowerCase() !== 'anonymous') ||
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
  
        const messageTime = new Date(message.createdAt);
        const hours = messageTime.getHours().toString().padStart(2, "0");
        const minutes = messageTime.getMinutes().toString().padStart(2, "0");
        const timeString = `${hours}:${minutes}`;
  
        const timestamp = formatTimestamp(message.createdAt); // assuming this is already defined
  
        const actionString =
          messageActions && messageActions.length > 0
            ? ` (${messageActions.join(", ")})`
            : "";
  
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
      .sort((a, b) => b.createdAt - a.createdAt)[0]?.content.text || null;

    const lastActions = recentMessagesData
      .filter(msg =>
        msg.entityId === this.runtime.agentId &&
        Array.isArray(msg.content?.actions) &&
        msg.content.actions.length > 0
      )
      .sort((a, b) => b.createdAt - a.createdAt)[0]?.content.actions || [];

    return {
      formattedHistory,
      lastResponseText,
      lastActions,
    };
  }

  private getService() {
    return this.runtime.getService<HyperfyService>(HyperfyService.serviceType);
  }
}
