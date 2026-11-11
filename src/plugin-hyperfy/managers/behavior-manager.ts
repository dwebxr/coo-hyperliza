import { ChannelType, Content, HandlerCallback, IAgentRuntime, Memory, ModelType, composePromptFromState, createUniqueUuid, logger, parseKeyValueXml } from "@elizaos/core";
import type { ConnectionSession } from "../session/connection-session";
import { deliverReply } from "../session/deliver-reply";
import { autoTemplate } from "../templates";
import { agentActivityLock } from "./guards";
import { getHyperfyActions, formatActions, countOtherPlayers } from "../utils";
import { AiBudgetExceededError, forPurpose, getUsageBudget } from "../../usage-budget";
import { AUTONOMY_ACTIONS } from "../lib/authorization";
import { TurnCancelled, currentTurn } from "../lib/turn-context";
import { errorText } from "../lib/error-text";
import {
  type AutonomyConfig,
  type Point,
  GREET_APPROACH_MAX_M,
  IDLE_EMOTES,
  STAY_AFTER_CONVERSATION_MS,
  chooseIdleStep,
  readAutonomyConfig,
} from "../lib/idle-behavior";
import { readActionNames, readString, readStringList } from "../lib/model-output";

const TIME_INTERVAL_IDLE_MIN = 60000; // 60 seconds when no players around
const TIME_INTERVAL_IDLE_MAX = 120000; // 120 seconds when no players around

/**
 * Autonomous behavior while other players are around. Most ticks are scripted (patrol or wander,
 * wave at newcomers, look around) and cost nothing; Claude decides a tick only within the
 * autonomous budget (AUTONOMY_AI_MIN_INTERVAL_SEC / AUTONOMY_AI_MAX_PER_HOUR, and never right after
 * a conversation), and the scripts carry on when the Claude budget is used up.
 */
export class BehaviorManager {
  private isRunning: boolean = false;
  private runtime: IAgentRuntime;
  private session: ConnectionSession;
  private sleepTimer: NodeJS.Timeout | null = null;
  private wakeSleep: (() => void) | null = null;
  private readonly config: AutonomyConfig;
  private home: Point | null = null;
  private patrolIndex = 0;
  /** Players already greeted on this connection; someone who leaves and comes back is greeted again. */
  private seenPlayers = new Set<string>();

  constructor(runtime: IAgentRuntime, session: ConnectionSession, config: AutonomyConfig = readAutonomyConfig()) {
    this.runtime = runtime;
    this.session = session;
    this.config = config;
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
      logger.error(`[BehaviorManager] Fatal error in run loop: ${errorText(err)}`);
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
        logger.error(`[BehaviorManager] Error in behavior: ${errorText(error)}`);
      }

      // Adjust delay based on whether other players are present
      // Longer delay when alone to save costs
      const [minDelay, maxDelay] = hasOtherPlayers
        ? [this.config.tickMinMs, this.config.tickMaxMs]
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

  /**
   * Executes a behavior
   * @returns true if other players are present, false otherwise
   */
  private async executeBehavior(): Promise<boolean> {
    const session = this.session;
    if (session.ended) return false;
    const world = session.world;

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

    const budget = getUsageBudget();
    if (budget.autonomyAiAvailable(agentActivityLock.lastActivityAt())) {
      // Counted up front, so a failing tick cannot be retried on every loop
      budget.recordAutonomyAiTick();
      try {
        await session.runTurn({ origin: 'autonomy' }, () => this.runAiBehavior(world));
        return hasOtherPlayers;
      } catch (error) {
        // The connection ended while the tick ran: what it had planned is not done
        if (error instanceof TurnCancelled) {
          logger.info(`[BehaviorManager] Autonomous tick stopped: ${error.message}`);
          return hasOtherPlayers;
        }
        if (!(error instanceof AiBudgetExceededError)) throw error;
        logger.info(`[BehaviorManager] ${error.message}; using scripted behavior`);
      }
    }

    if (session.ended) return hasOtherPlayers;
    budget.recordScriptedTick();
    this.runScriptedBehavior(world);
    return hasOtherPlayers;
  }

  /**
   * One scripted step; movement and emotes are started, not awaited. Not a turn: what it starts
   * belongs to the connection and stops with it.
   */
  private runScriptedBehavior(world: any): void {
    const session = this.session;
    const self = world.entities.player;
    const position = self?.base?.position;
    if (!this.home && position) this.home = { x: position.x, z: position.z };

    const controls = world.controls;
    const navigating = !!(controls?.getIsNavigating?.() || controls?.getIsWalkingRandomly?.());
    const recentlyTalked = Date.now() - agentActivityLock.lastActivityAt() < STAY_AFTER_CONVERSATION_MS;
    const step = chooseIdleStep({
      newcomer: this.findNewcomer(world),
      // Not while a turn has the avatar to itself (walking somewhere, editing, looking)
      canMove: !!controls && !navigating && !recentlyTalked && !session.body.busy,
      patrolPoints: this.config.patrolPoints,
      patrolIndex: this.patrolIndex,
      home: this.home,
      wanderRadius: this.config.wanderRadius,
    });
    logger.debug(`[BehaviorManager] Scripted step: ${JSON.stringify(step)}`);

    const emotes = session.emotes;
    const ignore = (what: string) => (error: unknown) => logger.debug(`[BehaviorManager] ${what} failed: ${error}`);
    // Worlds that refuse emote uploads have no wave / look-around clips: turn instead, which
    // everyone sees
    const wave = (playerId: string) => {
      if (emotes?.hasEmote(IDLE_EMOTES.wave)) emotes.playEmote(IDLE_EMOTES.wave);
      else controls?.faceEntity?.(playerId).catch(ignore('Turning to a player'));
    };
    switch (step.kind) {
      case 'greet': {
        if (!step.approach) {
          wave(step.playerId);
          break;
        }
        // Emotes stop while walking, so wave once there
        controls
          .followEntity(step.playerId)
          .then((outcome: string) => {
            // Only next to them: a walk that was stopped or replaced waves at nobody
            if (outcome === 'arrived' && this.isRunning && !session.ended) wave(step.playerId);
          })
          .catch(ignore('Greeting walk'));
        break;
      }
      case 'walk':
        this.patrolIndex = step.nextPatrolIndex;
        controls.goto(step.target.x, step.target.z).catch(ignore('Idle walk'));
        break;
      case 'emote': {
        if (emotes?.hasEmote(step.name)) {
          emotes.playEmote(step.name);
          break;
        }
        // Walking already shows movement (and sets the facing every step)
        if (navigating) break;
        const nearest = this.nearestPlayerId(world);
        // Waving, or just after talking with someone: face them rather than look away
        if (nearest && (step.name === IDLE_EMOTES.wave || recentlyTalked)) wave(nearest);
        else controls?.rotateTo?.(Math.random() < 0.5 ? 'left' : 'right', 900).catch(ignore('Looking around'));
        break;
      }
      case 'rest':
        break;
    }
  }

  private nearestPlayerId(world: any): string | null {
    const self = world.entities.player;
    const mine = self?.base?.position;
    let best: string | null = null;
    let bestDistance = Infinity;
    for (const [id, entity] of world.entities.items.entries()) {
      if (entity?.data?.type !== 'player' || id === self?.data?.id || !entity.base?.position || !mine) continue;
      const distance = entity.base.position.distanceTo(mine);
      if (distance < bestDistance) {
        best = id;
        bestDistance = distance;
      }
    }
    return best;
  }

  /** The first player not seen before on this connection, with their distance from the agent. */
  private findNewcomer(world: any): { id: string; distance: number } | null {
    const self = world.entities.player;
    const present = new Set<string>();
    let newcomer: { id: string; distance: number } | null = null;
    for (const [id, entity] of world.entities.items.entries()) {
      if (entity?.data?.type !== 'player' || id === self?.data?.id) continue;
      present.add(id);
      if (newcomer || this.seenPlayers.has(id)) continue;
      const theirs = entity.base?.position;
      const mine = self?.base?.position;
      const distance = theirs && mine ? theirs.distanceTo(mine) : GREET_APPROACH_MAX_M + 1;
      newcomer = { id, distance };
    }
    for (const id of this.seenPlayers) if (!present.has(id)) this.seenPlayers.delete(id);
    if (newcomer) this.seenPlayers.add(newcomer.id);
    return newcomer;
  }

  /** Lets Claude choose the next action. Throws AiBudgetExceededError when the budget ran out. */
  private async runAiBehavior(world: any): Promise<void> {
    const session = this.session;
    const turn = currentTurn();
    if (!turn) throw new Error('an autonomous tick runs inside a turn');
    const _currentWorldId = session.worldId;

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

    // What the prompt offers; lib/authorization.ts refuses anything else the model names
    const actionsData = await getHyperfyActions(this.runtime, newMessage, state, [...AUTONOMY_ACTIONS]);

    const actionsText = actionsData.length > 0 ? formatActions(actionsData) : '';

    const responsePrompt = composePromptFromState({ state: { ...state, values: { ...state.values, autonomousActions: actionsText } }, template: autoTemplate });

    // decide
    const response = await this.runtime.useModel(ModelType.TEXT_LARGE, forPurpose('autonomous', {
      prompt: responsePrompt,
    }));

    const parsedXml = parseKeyValueXml(response);
    if (!parsedXml) {
      logger.warn("[BehaviorManager] Could not parse model response; skipping this tick.");
      return;
    }
    logger.debug(`[BehaviorManager] Response: ${JSON.stringify(parsedXml)}`)

    const responseMemory: Memory = {
      id: createUniqueUuid(this.runtime, Date.now().toString()),
      content: {
        thought: readString(parsedXml, 'thought'),
        text: readString(parsedXml, 'text'),
        actions: readActionNames(parsedXml),
        providers: readStringList(parsedXml, 'providers'),
        emote: readString(parsedXml, 'emote'),
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

    // The model's answer came back for a connection that has ended meanwhile: nothing is done with it
    turn.assertLive();

    // Every reply of this tick goes out through the one delivery path (session/deliver-reply.ts)
    const reply = { turn, runtime: this.runtime, session, roomId: elizaRoomId };
    const callback: HandlerCallback = async (responseContent: Content): Promise<Memory[]> => {
      await deliverReply(reply, responseContent);
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
  }
}
