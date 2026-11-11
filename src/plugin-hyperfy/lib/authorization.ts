import { type Action, type Content, type Handler, logger } from '@elizaos/core';
import { actionFailed } from './action-result';
import { type TurnContext, currentTurn } from './turn-context';
import { Ranks, worldIdentity } from './world-identity';

/**
 * Who may make the agent do what. Principle: the agent never does for someone what the world
 * would not let them do themselves.
 */

type Env = Record<string, string | undefined>;

export const OPERATOR_IDS_ENV = 'HYPERFY_OPERATOR_IDS';
export const SCENE_EDITS_ENV = 'HYPERFY_SCENE_EDITS';
export const EDIT_ENTITY_ACTION = 'HYPERFY_EDIT_ENTITY';

export type SceneEditsMode = 'off' | 'builders';

/**
 * HYPERFY_SCENE_EDITS: `off` (the default) or `builders`. Who asks for an edit is the sender id of
 * a chat message, which only a server that sets it itself (coo-world) makes trustworthy; stock
 * Hyperfy passes on whatever id the sending client wrote. An unknown value counts as off.
 */
export function readSceneEditsMode(env: Env = process.env): { mode: SceneEditsMode; problem?: string } {
  const raw = env[SCENE_EDITS_ENV]?.trim().toLowerCase();
  if (!raw || raw === 'off') return { mode: 'off' };
  if (raw === 'builders') return { mode: 'builders' };
  return {
    mode: 'off',
    problem: `Configuration error: unknown ${SCENE_EDITS_ENV}="${env[SCENE_EDITS_ENV]}" (expected off or builders); scene edits stay off`,
  };
}

/** One line for the log saying who may ask for scene edits. */
export function describeSceneEditsMode(env: Env = process.env): string {
  return readSceneEditsMode(env).mode === 'builders'
    ? `[Hyperfy] Scene edits by request: on for builders (${SCENE_EDITS_ENV}=builders: builder rank or ${OPERATOR_IDS_ENV}). Safe only on a world whose server sets each chat message's sender itself (coo-world does; stock Hyperfy does not).`
    : `[Hyperfy] Scene edits by request: off (${SCENE_EDITS_ENV}=builders turns them on for builders; see README).`;
}

/** What an autonomous turn may run; everything else it names is refused (see guardActions). */
export const AUTONOMY_ACTIONS: readonly string[] = Object.freeze([
  'HYPERFY_GOTO_ENTITY',
  'HYPERFY_WALK_RANDOMLY',
  'HYPERFY_USE_ITEM',
  'HYPERFY_UNUSE_ITEM',
  'HYPERFY_AMBIENT_SPEECH',
  'HYPERFY_TELEPORT_TO_USER',
  'REPLY',
  'IGNORE',
]);

/** Actions that act with a requester's authority; they never run outside a chat or voice turn. */
export const PRIVILEGED_ACTIONS: readonly string[] = Object.freeze([EDIT_ENTITY_ACTION]);

/** HYPERFY_OPERATOR_IDS: player ids or userIds treated as builders in every world. */
export function operatorIds(env: Env = process.env): Set<string> {
  return new Set((env[OPERATOR_IDS_ENV] ?? '').split(',').map((id) => id.trim()).filter(Boolean));
}

/**
 * Whether the player may build in this world: they are a player present in it (as the world's
 * server reported), and their effective rank there is builder or higher, or their player id or
 * userId is in HYPERFY_OPERATOR_IDS. A world whose identity is not tracked grants nobody.
 */
export function isBuilder(world: object, playerId: string, env: Env = process.env): boolean {
  const identity = worldIdentity(world);
  const rank = identity?.effectiveRank(playerId);
  if (!identity || rank === undefined) return false;
  const operators = operatorIds(env);
  if (operators.has(playerId)) return true;
  const userId = identity.userIdOf(playerId);
  if (userId !== undefined && operators.has(userId)) return true;
  return rank >= Ranks.BUILDER;
}

/** Why the agent must not edit the world for this turn, or null when it may. */
export function sceneEditRefusal(turn: TurnContext | undefined, env: Env = process.env): string | null {
  if (!turn) return 'scene edits run only for a player who asked in chat or voice';
  if (turn.origin === 'autonomy') return 'autonomous turns never edit the world';
  if (readSceneEditsMode(env).mode === 'off') return `scene edits are off (${SCENE_EDITS_ENV})`;
  if (!turn.requesterId) return 'nobody asked for this edit';
  if (!isBuilder(turn.world, turn.requesterId, env)) return 'the requester is not a builder in this world';
  return null;
}

/** Thrown when an authorized scene edit may not go on (see sceneEditStillAllowed). */
export class SceneEditStopped extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'SceneEditStopped';
  }
}

/**
 * Why a scene edit authorized for `turn` must stop now, or null while it may go on: the turn is
 * live (its connection has not ended and it was not cancelled, lib/turn-context.ts) and the
 * requester is still allowed there (a rank change, or the player leaving, ends it). Checked before
 * each effect and after each await.
 */
export function sceneEditStillAllowed(turn: TurnContext, env: Env = process.env): string | null {
  if (!turn.live) return 'the turn was cancelled or its connection ended';
  return sceneEditRefusal(turn, env);
}

/**
 * A reply that reports what a privileged action did is checked again when it is delivered:
 * elizaOS core (1.7.2) holds what an action hands its callback until the action has returned, and
 * the requester's right can end in between. The action registers the reply (the content object
 * itself, which core passes on as it is) with the check and what to say instead.
 */
export interface PrivilegedReport {
  /** Why the report must not be delivered now, or null while it may. */
  refusal(): string | null;
  /** What the requester is told instead: nothing about what was done. */
  readonly instead: Content;
}

const privilegedReports = new WeakMap<object, PrivilegedReport>();

/** Marks `content` as a report of a privileged action (see PrivilegedReport). Returns `content`. */
export function reportsPrivilegedAction<T extends Content>(content: T, report: PrivilegedReport): T {
  privilegedReports.set(content, report);
  return content;
}

/** The check `content` was registered with, or undefined for an ordinary reply. */
export function privilegedReport(content: object): PrivilegedReport | undefined {
  return privilegedReports.get(content);
}

/**
 * Why `actionName` must not run in this turn, or null when it may. Autonomous turns run only
 * AUTONOMY_ACTIONS; privileged actions never run outside a turn. Chat and voice turns may run any
 * action (privileged ones check their requester themselves, e.g. sceneEditRefusal).
 */
export function actionRefusal(actionName: string, turn: TurnContext | undefined): string | null {
  if (!turn) return PRIVILEGED_ACTIONS.includes(actionName) ? `${actionName} runs only inside a chat or voice turn` : null;
  if (turn.origin === 'autonomy' && !AUTONOMY_ACTIONS.includes(actionName)) {
    return `${actionName} is not allowed on an autonomous turn`;
  }
  return null;
}

/**
 * Wraps each action's handler with actionRefusal. elizaOS core (1.7.2) never calls validate()
 * before running an action and resolves the names a model emits by exact, then substring, then
 * simile match, so a list in the prompt is no restriction. The wrapper runs after that
 * resolution and checks the action's real name; a refused action's handler is not called.
 *
 * No action of a turn that may no longer act is started either: the wrapper throws TurnCancelled
 * (assertLive), which ends core's processActions and so the rest of the turn's plan.
 */
export function guardActions(actions: Action[]): Action[] {
  return actions.map((action) => {
    const handler: Handler = async (runtime, message, state, options, callback, responses) => {
      currentTurn()?.assertLive();
      const refusal = actionRefusal(action.name, currentTurn());
      if (refusal) {
        // Silent on purpose: an autonomous turn has nobody to tell, and a privileged action outside
        // any turn has no requester either
        logger.warn(`[Hyperfy] Not running ${action.name}: ${refusal}`);
        return actionFailed(action.name, refusal);
      }
      return action.handler(runtime, message, state, options, callback, responses);
    };
    return { ...action, handler };
  });
}
