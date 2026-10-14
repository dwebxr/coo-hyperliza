import { ChannelType, Content, HandlerCallback, IAgentRuntime, Memory, ModelType, composePromptFromState, createUniqueUuid, logger, parseKeyValueXml } from "@elizaos/core";
import { HyperfyService } from "../service";
import { autoTemplate } from "../templates";
import { agentActivityLock } from "./guards";
import { getHyperfyActions, formatActions, countOtherPlayers } from "../utils";
import { isOpenPayLink } from "../../openpay-store";

const TIME_INTERVAL_MIN = 15000; // 15 seconds
const TIME_INTERVAL_MAX = 30000; // 30 seconds
const TIME_INTERVAL_IDLE_MIN = 60000; // 60 seconds when no players around
const TIME_INTERVAL_IDLE_MAX = 120000; // 120 seconds when no players around


export class BehaviorManager {
  private isRunning: boolean = false;
  private runtime: IAgentRuntime;
  private sleepTimer: NodeJS.Timeout | null = null;
  private wakeSleep: (() => void) | null = null;

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
      // Teardown calls this even when a connect failed before start()
      return;
    }

    this.isRunning = false;
    // Wake the loop so it exits now instead of after up to two minutes.
    if (this.sleepTimer) clearTimeout(this.sleepTimer);
    this.sleepTimer = null;
    this.wakeSleep?.();
    this.wakeSleep = null;
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
      await this.sleep(delay);
    }
  }

  private sleep(ms: number): Promise<void> {
    if (!this.isRunning) return Promise.resolve();
    return new Promise((resolve) => {
      this.wakeSleep = resolve;
      this.sleepTimer = setTimeout(() => {
        this.sleepTimer = null;
        this.wakeSleep = null;
        resolve();
      }, ms);
    });
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

    const otherPlayerCount = countOtherPlayers(world);
    const hasOtherPlayers = otherPlayerCount > 0;

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
    if (!parsedXml) {
      logger.warn("[BehaviorManager] Could not parse model response; skipping this tick.");
      return hasOtherPlayers;
    }
    logger.debug(`[BehaviorManager] Response: ${JSON.stringify(parsedXml)}`)

    const responseMemory: Memory = {
      id: createUniqueUuid(this.runtime, Date.now().toString()),
      content: {
        thought: parsedXml.thought as string,
        text: parsedXml.text as string,
        actions: parsedXml.actions as string[],
        providers: parsedXml.providers as string[],
        emote: parsedXml.emote as string,
      },
      entityId: createUniqueUuid(this.runtime, this.runtime.agentId),
      roomId: elizaRoomId,
      createdAt: Date.now(),
    };

    const name = world.entities.player.data.name;
    await this.runtime.ensureConnection({
      entityId: entityId,
      roomId: elizaRoomId,
      userName: name,
      name,
      source: 'hyperfy',
      channelId: _currentWorldId,
      type: ChannelType.WORLD,
      worldId: _currentWorldId,
    })

    const callback: HandlerCallback = async (responseContent: Content): Promise<Memory[]> => {
      console.info(`[Hyperfy Auto Callback] Received response: ${JSON.stringify(responseContent)}`)
      // Stopped (disconnect) while this tick was generating; don't act in a newer world
      if (!this.isRunning || service.getWorld() !== world) return [];
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

      if (responseContent.text && !isOpenPayLink(responseContent)) {
        service.getMessageManager().sendMessage(responseContent.text);
        await service.getVoiceManager()?.speak(responseContent.text);
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
