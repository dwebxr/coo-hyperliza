import { ChannelType, Content, HandlerCallback, IAgentRuntime, Memory, ModelType, composePromptFromState, createUniqueUuid, logger, parseKeyValueXml } from "@elizaos/core";
import { HyperfyService } from "../service";
import { autoTemplate } from "../templates";
import { agentActivityLock } from "./guards";
import { getHyperfyActions, formatActions, generateElevenLabsTTS, generateOpenAITTS } from "../utils";

const TIME_INTERVAL_MIN = 15000; // 15 seconds
const TIME_INTERVAL_MAX = 30000; // 30 seconds
const TIME_INTERVAL_IDLE_MIN = 60000; // 60 seconds when no players around
const TIME_INTERVAL_IDLE_MAX = 120000; // 120 seconds when no players around


export class BehaviorManager {
  private isRunning: boolean = false;
  private runtime: IAgentRuntime;

  constructor(runtime: IAgentRuntime) {
    this.runtime = runtime;
  }

  /**
   * Starts the behavior loop if not already running and prerequisites are met.
   */
  public start(): void {
    if (this.isRunning) {
      logger.warn("[BehaviorManager] Already running");
      return;
    }

    this.isRunning = true;
    console.log(`[BehaviorManager] Starting behavior loop for player`);
    logger.info(`[BehaviorManager] Starting behavior loop for player`);

    this.runLoop().catch((err) => {
      console.error("[BehaviorManager] Fatal error in run loop:", err);
      logger.error("[BehaviorManager] Fatal error in run loop:", err);
    });
  }


  /**
   * Stops the behavior loop
   */
  public stop(): void {
    if (!this.isRunning) {
      logger.warn("[BehaviorManager] Not running");
      return;
    }

    this.isRunning = false;
    logger.info("[BehaviorManager] Stopped behavior loop");
  }

  /**
   * Main loop that waits for each behavior to finish
   */
  private async runLoop(): Promise<void> {
    while (this.isRunning) {
      let hasOtherPlayers = false;
      try {
        hasOtherPlayers = await this.executeBehavior();
      } catch (error) {
        logger.error("[BehaviorManager] Error in behavior:", error);
      }

      // Adjust delay based on whether other players are present
      // Longer delay when alone to save costs
      const [minDelay, maxDelay] = hasOtherPlayers
        ? [TIME_INTERVAL_MIN, TIME_INTERVAL_MAX]
        : [TIME_INTERVAL_IDLE_MIN, TIME_INTERVAL_IDLE_MAX];

      const delay = minDelay + Math.floor(Math.random() * (maxDelay - minDelay));
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  private getService() {
    return this.runtime.getService<HyperfyService>(HyperfyService.serviceType);
  }

  /**
   * Executes a behavior
   * @returns true if other players are present, false otherwise
   */
  private async executeBehavior(): Promise<boolean> {
    const service = this.getService();
    if (!service) {
      logger.error("[BehaviorManager] Cannot start — service not available");
      return false;
    }

    const world = service.getWorld();
    if (!world) {
      logger.warn("[BehaviorManager] World not found (disconnected or initializing). Skipping behavior.");
      return false;
    }

    const player = world.entities?.player;
    if (!player) {
      logger.warn("[BehaviorManager] Player entity not found (waiting for spawn). Skipping behavior.");
      return false;
    }

    // Check if there are other players in the world
    // Count players from entities instead of using getPlayers()
    let otherPlayerCount = 0;
    const entities = world?.entities?.items;
    if (entities) {
      for (const [id, entity] of entities.entries()) {
        const type = entity?.data?.type;
        if (type === 'player' && id !== player.data.id) {
          otherPlayerCount++;
          logger.debug(`[BehaviorManager] Found other player: ${entity?.data?.name || 'Unknown'} (${id})`);
        }
      }
    }
    const hasOtherPlayers = otherPlayerCount > 0;

    console.log(`[BehaviorManager] Player check: self=${player.data.id}, otherPlayers=${otherPlayerCount}, hasOthers=${hasOtherPlayers}`);
    logger.info(`[BehaviorManager] Player check: self=${player.data.id}, otherPlayers=${otherPlayerCount}, hasOthers=${hasOtherPlayers}`);

    // Skip autonomous behavior when alone to save costs
    if (!hasOtherPlayers) {
      logger.info("[BehaviorManager] No other players present. Skipping autonomous behavior to save costs.");
      return false;
    }

    // TODO: There may be slow post-processing in the bootstrap plugin's message handler.
    // Investigate long tail after message handling, especially in emitEvent or runtime methods.
    if (agentActivityLock.isActive()) {
      logger.info("[BehaviorManager] Skipping behavior — message activity in progress");
      return hasOtherPlayers;
    }

    const _currentWorldId = service.currentWorldId;

    const elizaRoomId = createUniqueUuid(this.runtime, _currentWorldId || 'hyperfy-unknown-world')
    const entityId = createUniqueUuid(this.runtime, this.runtime.agentId);

    const newMessage: Memory = {
      id: createUniqueUuid(this.runtime, Date.now().toString()),
      content: {
        text: '',
        type: 'text',
      },
      roomId: elizaRoomId,
      worldId: _currentWorldId,
      entityId,
    };

    const state = await this.runtime.composeState(newMessage);

    const actionsData = await getHyperfyActions(
      this.runtime,
      newMessage,
      state, [
      'HYPERFY_GOTO_ENTITY',
      'HYPERFY_WALK_RANDOMLY',
      'HYPERFY_USE_ITEM',
      'HYPERFY_UNUSE_ITEM',
      'HYPERFY_AMBIENT_SPEECH',
      'HYPERFY_TELEPORT_TO_USER',
      'REPLY',
      'IGNORE',
    ]
    );

    const actionsText = actionsData.length > 0 ? formatActions(actionsData) : '';

    const responsePrompt = composePromptFromState({ state, template: autoTemplate(actionsText) });

    // decide
    const response = await this.runtime.useModel(ModelType.TEXT_LARGE, {
      prompt: responsePrompt,
    });

    const parsedXml = parseKeyValueXml(response);

    console.log('****** response\n', parsedXml)

    const responseMemory = {
      content: {
        thought: parsedXml.thought,
        text: parsedXml.text,
        actions: parsedXml.actions,
        providers: parsedXml.providers,
        emote: parsedXml.emote,
      },
      entityId: createUniqueUuid(this.runtime, this.runtime.agentId),
      roomId: elizaRoomId,
    };

    const name = world.entities.player.data.name;
    await this.runtime.ensureConnection({
      entityId: entityId,
      roomId: elizaRoomId,
      userName: name,
      name,
      source: 'hyperfy',
      channelId: _currentWorldId,
      serverId: 'hyperfy',
      type: ChannelType.WORLD,
      worldId: _currentWorldId,
      userId: world.entities.player.data.id
    })

    const callback: HandlerCallback = async (responseContent: Content): Promise<Memory[]> => {
      console.info(`[Hyperfy Auto Callback] Received response: ${JSON.stringify(responseContent)}`)
      const emote = responseContent.emote as string;
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

      if (emote) {
        const emoteManager = service.getEmoteManager();
        emoteManager.playEmote(emote);
      }

      if (responseContent.text) {
        const messageManager = service.getMessageManager();
        messageManager.sendMessage(responseContent.text);

        // Generate TTS audio and play via LiveKit (prefer ElevenLabs, fallback to OpenAI)
        try {
          console.log('[BehaviorManager] Starting TTS generation for:', responseContent.text.substring(0, 50) + '...');

          let audioBuffer = await generateElevenLabsTTS(responseContent.text);
          if (!audioBuffer) {
            console.log('[BehaviorManager] ElevenLabs failed, trying OpenAI TTS...');
            audioBuffer = await generateOpenAITTS(responseContent.text);
          }

          if (audioBuffer) {
            const voiceManager = service.getVoiceManager();
            if (voiceManager) {
              console.log('[BehaviorManager] Playing audio via LiveKit...');
              await voiceManager.playAudio(audioBuffer);
              logger.info('[BehaviorManager] TTS audio played successfully');
            }
          }
        } catch (ttsError) {
          logger.warn('[BehaviorManager] TTS generation failed, text-only response sent:', ttsError);
        }
      }

      return [];
    };

    await this.runtime.processActions(
      newMessage,
      [responseMemory],
      state,
      callback
    );

    await this.runtime.evaluate(newMessage, state, true, callback, [
      responseMemory,
    ]);

    return hasOtherPlayers;
  }
}
