import { logger } from '@elizaos/core';

/**
 * Scripted idle behavior: what the agent does on autonomous ticks that do not ask Claude.
 * Walking a patrol route or around its post, waving at newcomers and looking around keep it
 * visibly "on shift" at no API cost.
 */

type Env = Record<string, string | undefined>;

export interface Point {
  x: number;
  z: number;
}

export interface AutonomyConfig {
  /** Time between autonomous ticks while other players are in the world. */
  tickMinMs: number;
  tickMaxMs: number;
  /** Fixed patrol route; empty means wandering around where the agent spawned. */
  patrolPoints: Point[];
  wanderRadius: number;
}

export const DEFAULT_TICK_MIN_SEC = 15;
export const DEFAULT_TICK_MAX_SEC = 30;
export const WANDER_RADIUS_M = 6;
/** Players closer than this get waved at in place; farther ones (up to GREET_APPROACH_MAX_M) are approached first when the agent may move. Beyond that, or when it may not move, they are waved at in place too. */
export const GREET_IN_PLACE_M = 4;
export const GREET_APPROACH_MAX_M = 20;
/** After a conversation the agent stays where it is for this long instead of walking off. */
export const STAY_AFTER_CONVERSATION_MS = 90_000;

export const IDLE_EMOTES = { lookAround: 'looking around', wave: 'waving both hands' } as const;

/** "x,z; x,z; ..." (spaces optional). Entries that are not two numbers are skipped with a warning (an empty coordinate reads as 0). */
export function parsePatrolPoints(raw: string | undefined): Point[] {
  if (!raw?.trim()) return [];
  const points: Point[] = [];
  for (const entry of raw.split(';')) {
    if (!entry.trim()) continue;
    const parts = entry.split(',').map((p) => Number(p.trim()));
    if (parts.length === 2 && parts.every(Number.isFinite)) {
      points.push({ x: parts[0], z: parts[1] });
    } else {
      logger.warn(`[Autonomy] Ignoring PATROL_POINTS entry "${entry.trim()}" (expected "x,z")`);
    }
  }
  return points;
}

function readSeconds(env: Env, key: string, fallback: number): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    logger.warn(`[Autonomy] Ignoring invalid ${key}="${raw}"; using ${fallback}`);
    return fallback;
  }
  return n;
}

export function readAutonomyConfig(env: Env = process.env): AutonomyConfig {
  const min = readSeconds(env, 'AUTONOMY_TICK_MIN_SEC', DEFAULT_TICK_MIN_SEC);
  const max = Math.max(min, readSeconds(env, 'AUTONOMY_TICK_MAX_SEC', Math.max(min, DEFAULT_TICK_MAX_SEC)));
  return {
    tickMinMs: min * 1000,
    tickMaxMs: max * 1000,
    patrolPoints: parsePatrolPoints(env.PATROL_POINTS),
    wanderRadius: WANDER_RADIUS_M,
  };
}

export type IdleStep =
  | { kind: 'greet'; playerId: string; approach: boolean }
  | { kind: 'walk'; target: Point; nextPatrolIndex: number }
  | { kind: 'emote'; name: string }
  | { kind: 'rest' };

export interface IdleInput {
  /** A player who arrived since the last tick, with their distance from the agent. */
  newcomer: { id: string; distance: number } | null;
  /** False while navigating, right after a conversation, or while a turn has the avatar to itself. */
  canMove: boolean;
  patrolPoints: Point[];
  patrolIndex: number;
  /** Where the agent spawned; wandering stays around it. */
  home: Point | null;
  wanderRadius: number;
  random?: () => number;
}

export function chooseIdleStep(input: IdleInput): IdleStep {
  const random = input.random ?? Math.random;
  if (input.newcomer) {
    const approach = input.canMove && input.newcomer.distance > GREET_IN_PLACE_M && input.newcomer.distance <= GREET_APPROACH_MAX_M;
    return { kind: 'greet', playerId: input.newcomer.id, approach };
  }

  const roll = random();
  // Mid-conversation or already walking: stay calm rather than gesturing every tick
  if (!input.canMove) return roll < 0.2 ? { kind: 'emote', name: IDLE_EMOTES.lookAround } : { kind: 'rest' };
  if (roll < 0.5) {
    if (input.patrolPoints.length) {
      const index = input.patrolIndex % input.patrolPoints.length;
      return { kind: 'walk', target: input.patrolPoints[index], nextPatrolIndex: (index + 1) % input.patrolPoints.length };
    }
    if (input.home) {
      const angle = random() * Math.PI * 2;
      const radius = random() * input.wanderRadius;
      return {
        kind: 'walk',
        target: { x: input.home.x + Math.cos(angle) * radius, z: input.home.z + Math.sin(angle) * radius },
        nextPatrolIndex: input.patrolIndex,
      };
    }
  }
  if (roll < 0.7) return { kind: 'emote', name: IDLE_EMOTES.lookAround };
  if (roll < 0.8) return { kind: 'emote', name: IDLE_EMOTES.wave };
  return { kind: 'rest' };
}
