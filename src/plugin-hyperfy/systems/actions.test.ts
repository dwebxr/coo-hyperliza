import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Action } from '../hyperfy/src/core/nodes/Action.js';
import { AgentActions, MAX_HOLD_SECONDS, NEARBY_DEFAULT_METERS, NEARBY_MAX_NODES } from './actions';
import { AgentControls } from './controls';

/*
 * The agent's interactions with action nodes, with the engine's real Action node where its
 * duration matters: its unit is the engine's (seconds).
 */

function world() {
  const player = { data: { id: 'coo' }, base: { position: new THREE.Vector3(100, 0, 100), quaternion: new THREE.Quaternion() } };
  // The engine's camera rig, which nothing moves in the agent: it stays at the origin
  const w: any = { rig: { position: new THREE.Vector3() }, camera: { position: { z: 10 } }, entities: { player, items: new Map<string, any>() } };
  w.controls = new AgentControls(w);
  w.actions = new AgentActions(w);
  return w as { controls: AgentControls; actions: AgentActions; entities: { player: typeof player; items: Map<string, any> }; rig: { position: THREE.Vector3 } };
}

/** An entity `meters` east of the agent with one action node; `duration` as a script would set it on the node */
function item(w: ReturnType<typeof world>, id: string, { meters = 1, ...extra }: { meters?: number } & Record<string, unknown> = {}) {
  const entity = { data: { id }, root: { position: new THREE.Vector3(100 + meters, 0, 100) } };
  w.entities.items.set(id, entity);
  const node: any = { ctx: { entity }, _onTrigger: vi.fn(), _onCancel: vi.fn(), ...extra };
  w.actions.register(node);
  return node;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("an action node's duration is in seconds, as the engine counts it", () => {
  /** The engine's own node, as a script's app.create('action', data) makes it */
  function engineNode(w: ReturnType<typeof world>, id: string, data: Record<string, unknown>) {
    const entity = { data: { id }, root: { position: new THREE.Vector3(101, 0, 100) } };
    w.entities.items.set(id, entity);
    const onTrigger = vi.fn();
    const node: any = new Action({ ...data, onTrigger });
    node.ctx = { entity, world: w };
    w.actions.register(node);
    return { node, onTrigger };
  }

  it.each([
    ['the default (0.5)', {}, 500],
    ['duration: 2', { duration: 2 }, 2000],
    ['duration: 0.1', { duration: 0.1 }, 100],
  ])('holds E for %s seconds before the trigger fires', (_what, data, ms) => {
    const w = world();
    const { onTrigger } = engineNode(w, 'seat', data);
    expect(w.actions.performAction('seat')).toBe('started');
    expect(w.controls.keyE.down).toBe(true);
    vi.advanceTimersByTime(ms - 1);
    expect(onTrigger).not.toHaveBeenCalled();
    expect(w.controls.keyE.down).toBe(true);
    vi.advanceTimersByTime(1);
    expect(onTrigger).toHaveBeenCalledWith({ playerId: 'coo' });
    expect(w.controls.keyE.down).toBe(false);
  });

  it.each([
    ['not a finite number', Number.POSITIVE_INFINITY],
    ['not a number at all (NaN)', Number.NaN],
    [`longer than ${MAX_HOLD_SECONDS} seconds`, MAX_HOLD_SECONDS + 1],
    ['a string', '1'],
  ])('does not use a node whose duration is %s: nothing is pressed and no timer is set', (_what, duration) => {
    const w = world();
    const node = item(w, 'seat', { _duration: duration });
    expect(w.actions.performAction('seat')).toBe('entity-has-no-action-node');
    expect(w.controls.keyE.down).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(24 * 3600_000);
    expect(node._onTrigger).not.toHaveBeenCalled();
  });

  it('triggers at once for a duration of zero or less, as the engine does', () => {
    const w = world();
    const node = item(w, 'seat', { _duration: -5 });
    expect(w.actions.performAction('seat')).toBe('started');
    vi.advanceTimersByTime(0);
    expect(node._onTrigger).toHaveBeenCalledTimes(1);
  });
});

describe('one interaction at a time, reserved from the moment the hold starts', () => {
  it('a second use while E is held is busy: one hold, one trigger', () => {
    const w = world();
    const seat = item(w, 'seat', { _duration: 1 });
    const lamp = item(w, 'lamp', { _duration: 1, meters: 2 });
    expect(w.actions.performAction('seat')).toBe('started');
    expect(w.actions.performAction('seat')).toBe('busy');
    expect(w.actions.performAction('lamp')).toBe('busy');
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(5_000);
    expect(seat._onTrigger).toHaveBeenCalledTimes(1);
    expect(lamp._onTrigger).not.toHaveBeenCalled();
    // ...and still busy while it is in use
    expect(w.actions.performAction('lamp')).toBe('busy');
  });

  it('letting go while E is still held calls the use off: nothing is triggered, the cancel handler is told, and the agent is free again', () => {
    const w = world();
    const seat = item(w, 'seat', { _duration: 2 });
    w.actions.performAction('seat');
    vi.advanceTimersByTime(1_000);
    expect(w.actions.releaseAction()).toBe(true);
    expect(w.controls.keyE.down).toBe(false);
    expect(seat._onCancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10_000);
    expect(seat._onTrigger).not.toHaveBeenCalled();
    expect(w.actions.releaseAction()).toBe(false);
    expect(w.actions.performAction('seat')).toBe('started');
  });

  it('a cancel handler that throws while the hold is called off is contained', () => {
    const w = world();
    item(w, 'seat', { _duration: 2, _onCancel: () => { throw new Error('script error'); } });
    w.actions.performAction('seat');
    expect(() => w.actions.releaseAction()).not.toThrow();
    expect(w.controls.keyE.down).toBe(false);
    expect(w.actions.performAction('seat')).toBe('started');
  });

  it('a node that goes away while E is held is not triggered, and one that goes away while in use is no longer held', () => {
    const w = world();
    const seat = item(w, 'seat', { _duration: 1 });
    w.actions.performAction('seat');
    w.actions.unregister(seat);
    expect(w.controls.keyE.down).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(5_000);
    expect(seat._onTrigger).not.toHaveBeenCalled();

    const lamp = item(w, 'lamp', { _duration: 0 });
    expect(w.actions.performAction('lamp')).toBe('started');
    vi.advanceTimersByTime(0);
    expect(lamp._onTrigger).toHaveBeenCalledTimes(1);
    w.actions.unregister(lamp);
    expect(w.actions.releaseAction()).toBe(false);
  });

  it('a second release while X is still down presses nothing again', () => {
    const w = world();
    const seat = item(w, 'seat', { _duration: 0 });
    w.actions.performAction('seat');
    vi.advanceTimersByTime(0);
    expect(w.actions.releaseAction()).toBe(true);
    expect(w.actions.releaseAction()).toBe(true);
    expect(seat._onCancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    // Not usable again until X is up
    expect(w.actions.performAction('seat')).toBe('busy');
    vi.advanceTimersByTime(500);
    expect(w.controls.keyX.down).toBe(false);
    expect(w.actions.performAction('seat')).toBe('started');
  });
});

describe('timers and callbacks', () => {
  it('destroy() leaves no timer of the world behind: a pending trigger never fires and the keys are up', () => {
    const held = world();
    const seat = item(held, 'seat', { _duration: 5 });
    held.actions.performAction('seat');
    held.actions.destroy();
    expect(vi.getTimerCount()).toBe(0);
    expect(held.controls.keyE.down).toBe(false);
    vi.advanceTimersByTime(60_000);
    expect(seat._onTrigger).not.toHaveBeenCalled();

    const releasing = world();
    item(releasing, 'seat', { _duration: 0 });
    releasing.actions.performAction('seat');
    vi.advanceTimersByTime(0);
    releasing.actions.releaseAction();
    expect(releasing.controls.keyX.down).toBe(true);
    releasing.actions.destroy();
    expect(vi.getTimerCount()).toBe(0);
    expect(releasing.controls.keyX.down).toBe(false);
    expect(releasing.actions.getNearby()).toEqual([]);
  });

  it("contains the X key's own press and release handlers: the release completes whatever they throw", () => {
    const w = world();
    item(w, 'seat', { _duration: 0 });
    w.actions.performAction('seat');
    vi.advanceTimersByTime(0);
    w.controls.keyX.onPress = () => { throw new Error('press handler'); };
    w.controls.keyX.onRelease = () => { throw new Error('release handler'); };
    expect(w.actions.releaseAction()).toBe(true);
    expect(() => vi.advanceTimersByTime(500)).not.toThrow();
    expect(w.controls.keyX.down).toBe(false);
    expect(w.actions.releaseAction()).toBe(false);
    expect(w.actions.performAction('seat')).toBe('started');
  });
});

describe('getNearby', () => {
  it('measures from where the agent stands, not from the camera rig nothing moves', () => {
    const w = world();
    const byAgent = item(w, 'by-agent', { meters: 3 });
    // 100 m and more from the agent, a few metres from the origin (where the rig is)
    const origin = { data: { id: 'by-origin' }, root: { position: new THREE.Vector3(2, 0, 2) } };
    const byOrigin: any = { ctx: { entity: origin } };
    w.actions.register(byOrigin);
    expect(w.actions.getNearby()).toEqual([byAgent]);
    expect(w.actions.getNearby(1_000)).toEqual([byAgent, byOrigin]);
  });

  it(`looks ${NEARBY_DEFAULT_METERS} m around when not told (or told something that is not a distance), nearest first`, () => {
    const w = world();
    const far = item(w, 'far', { meters: NEARBY_DEFAULT_METERS + 1 });
    const edge = item(w, 'edge', { meters: NEARBY_DEFAULT_METERS });
    const near = item(w, 'near', { meters: 2 });
    for (const distance of [undefined, Number.NaN, Number.POSITIVE_INFINITY, 'far' as unknown as number]) expect(w.actions.getNearby(distance)).toEqual([near, edge]);
    expect(w.actions.getNearby(5)).toEqual([near]);
    expect(w.actions.getNearby(1_000)).toEqual([near, edge, far]);
  });

  it(`returns at most ${NEARBY_MAX_NODES} nodes, the nearest`, () => {
    const w = world();
    const nodes = Array.from({ length: 500 }, (_, i) => item(w, `n${i}`, { meters: 40 - i * 0.05 }));
    const nearby = w.actions.getNearby();
    expect(nearby).toHaveLength(NEARBY_MAX_NODES);
    expect(nearby[0]).toBe(nodes[499]);
    expect(nearby).toEqual(nodes.slice(-NEARBY_MAX_NODES).reverse());
  });

  it('skips finished nodes and nodes that have no entity, no position, or a position that is not a number, without throwing', () => {
    const w = world();
    const good = item(w, 'good');
    item(w, 'done', { finished: true });
    for (const odd of [{}, { ctx: null }, { ctx: {} }, { ctx: { entity: {} } }, { ctx: { entity: { root: {} } } }, { ctx: { entity: { root: { position: new THREE.Vector3(Number.NaN, 0, 0) } } } }]) w.actions.register(odd as never);
    expect(w.actions.getNearby()).toEqual([good]);
    expect(w.actions.performAction('good')).toBe('started');
  });

  it('uses the nearest node when no entity is named', () => {
    const w = world();
    item(w, 'farther', { meters: 9, _duration: 0 });
    const nearest = item(w, 'nearest', { meters: 1, _duration: 0 });
    expect(w.actions.performAction()).toBe('started');
    vi.advanceTimersByTime(0);
    expect(nearest._onTrigger).toHaveBeenCalledTimes(1);
  });
});
