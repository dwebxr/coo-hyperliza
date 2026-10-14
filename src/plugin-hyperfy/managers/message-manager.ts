import { ChannelType, Entity, Content, HandlerCallback, IAgentRuntime, Memory, UUID, formatTimestamp, createUniqueUuid, getEntityDetails, logger } from "@elizaos/core";
import { HyperfyService } from "../service";
import { agentActivityLock } from "./guards";
import { hyperfyEventType } from "../events";
import { countOtherPlayers } from "../utils";
import { isDirectlyAddressed, parseAliases } from "../lib/addressing";
import { isOpenPayLink } from "../../openpay-store";
import moment from 'moment'
import { uuid } from '../hyperfy/src/core/utils';

/** Set by the chat queue when a turn outlives its slot, so its late output is dropped. */
export interface ChatTurn {
  cancelled: boolean;
}

export class MessageManager {
  private runtime: IAgentRuntime;
  // Managers are per connection; replies from turns that started before a teardown are dropped
  private stopped = false;
  
  constructor(runtime: IAgentRuntime) {
    this.runtime = runtime;
    if (!this.runtime.character.templates) {
      this.runtime.character.templates = {};
    }
  }

  stop() {
    this.stopped = true;
  }

  async handleMessage(msg, turn?: ChatTurn): Promise<void> {
    // maybe a thinking emote here?
    await agentActivityLock.run(async () => {
      const service = this.getService();
      const world = service.getWorld();
      const agentPlayerId = world.entities.player.data.id // Get agent's ID
      const senderName = msg.from || 'System'
      const messageBody = msg.body || ''
      const _currentWorldId = service.currentWorldId;
      console.info(`[Chat Received] From: ${senderName}, ID: ${msg.id}, Body: "${messageBody}"`)

      // Respond only to messages not from the agent itself
      if (msg.fromId && msg.fromId !== agentPlayerId) {
        console.info(`[Hyperfy Chat] Processing message from ${senderName}`)

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
    });
  }

  /**
   * Posts to world chat. Never throws (callers fire and forget); returns false on failure.
   */
  async sendMessage(text: string): Promise<boolean> {
    const service = this.runtime.getService<HyperfyService>(HyperfyService.serviceType);
    const world = service?.getWorld();
    if (!service?.isConnected() || !world?.chat || !world?.entities?.player) {
      console.error('HyperfyService: Cannot send message. Not ready.')
      return false
    }

    try {
      const agentPlayerId = world.entities.player.data.id
      const agentPlayerName = service.getEntityName(agentPlayerId) || world.entities.player.data?.name || 'Hyperliza'

      console.info(`HyperfyService sending message: "${text}" as ${agentPlayerName} (${agentPlayerId})`)

      if (typeof world.chat.add !== 'function') {
        throw new Error('world.chat.add is not a function')
      }

      world.chat.add(
        {
          id: uuid(),
          body: text,
          fromId: agentPlayerId,
          from: agentPlayerName,
          createdAt: moment().toISOString()
        },
        true
      )
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
        const messageText = content.text || "";
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
  
        const formattedLine = `- ${timeString} (${timestamp}) ${formattedName} [${formattedId}]${actionString}${textPart}`;
  
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
