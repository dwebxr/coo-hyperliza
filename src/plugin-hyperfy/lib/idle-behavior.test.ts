import { describe, expect, it } from 'vitest';
import { IDLE_EMOTES, chooseIdleStep, parsePatrolPoints, readAutonomyConfig } from './idle-behavior';

const base = {
  newcomer: null,
  canMove: true,
  patrolPoints: [],
  patrolIndex: 0,
  home: { x: 10, z: -5 },
  wanderRadius: 6,
};
const fixed = (...values: number[]) => {
  let i = 0;
  return () => values[i++ % values.length];
};

describe('readAutonomyConfig', () => {
  it('defaults to a tick every 15-30 s and wandering', () => {
    expect(readAutonomyConfig({})).toEqual({ tickMinMs: 15_000, tickMaxMs: 30_000, patrolPoints: [], wanderRadius: 6 });
  });

  it('reads the cadence and a patrol route, keeping max >= min', () => {
    const config = readAutonomyConfig({ AUTONOMY_TICK_MIN_SEC: '40', AUTONOMY_TICK_MAX_SEC: '20', PATROL_POINTS: '0,0; 5,-3' });
    expect(config).toMatchObject({ tickMinMs: 40_000, tickMaxMs: 40_000, patrolPoints: [{ x: 0, z: 0 }, { x: 5, z: -3 }] });
  });

  it('skips malformed patrol points', () => {
    expect(parsePatrolPoints('1,2;oops;3, 4 ;5')).toEqual([{ x: 1, z: 2 }, { x: 3, z: 4 }]);
    expect(parsePatrolPoints('')).toEqual([]);
  });
});

describe('chooseIdleStep', () => {
  it('greets a newcomer: walks over when they are a little away, waves in place when close or far', () => {
    expect(chooseIdleStep({ ...base, newcomer: { id: 'p1', distance: 10 } })).toEqual({ kind: 'greet', playerId: 'p1', approach: true });
    expect(chooseIdleStep({ ...base, newcomer: { id: 'p1', distance: 2 } })).toMatchObject({ approach: false });
    expect(chooseIdleStep({ ...base, newcomer: { id: 'p1', distance: 50 } })).toMatchObject({ approach: false });
    expect(chooseIdleStep({ ...base, canMove: false, newcomer: { id: 'p1', distance: 10 } })).toMatchObject({ approach: false });
  });

  it('walks the patrol route in order', () => {
    const route = [{ x: 0, z: 0 }, { x: 5, z: 5 }];
    expect(chooseIdleStep({ ...base, patrolPoints: route, patrolIndex: 1, random: fixed(0.1) })).toEqual({
      kind: 'walk',
      target: { x: 5, z: 5 },
      nextPatrolIndex: 0,
    });
  });

  it('wanders within the radius of its post', () => {
    const step = chooseIdleStep({ ...base, random: fixed(0.1, 0.25, 1) });
    expect(step.kind).toBe('walk');
    if (step.kind !== 'walk') return;
    expect(Math.hypot(step.target.x - 10, step.target.z + 5)).toBeCloseTo(6);
  });

  it('otherwise looks around, waves, or rests', () => {
    expect(chooseIdleStep({ ...base, random: fixed(0.6) })).toEqual({ kind: 'emote', name: IDLE_EMOTES.lookAround });
    expect(chooseIdleStep({ ...base, random: fixed(0.75) })).toEqual({ kind: 'emote', name: IDLE_EMOTES.wave });
    expect(chooseIdleStep({ ...base, random: fixed(0.9) })).toEqual({ kind: 'rest' });
  });

  it('does not walk off or gesture much right after a conversation', () => {
    expect(chooseIdleStep({ ...base, canMove: false, random: fixed(0.1) })).toEqual({ kind: 'emote', name: IDLE_EMOTES.lookAround });
    expect(chooseIdleStep({ ...base, canMove: false, random: fixed(0.4) })).toEqual({ kind: 'rest' });
  });
});
