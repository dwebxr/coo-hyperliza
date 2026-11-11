import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentControls } from './controls';
import { AgentActions } from './actions';
import { ControlPriorities } from '../hyperfy/src/core/extras/ControlPriorities.js';

function world() {
  const w: any = { rig: { position: { x: 0, y: 0, z: 0 } }, camera: { position: { z: 10 } }, entities: { player: { data: { id: 'coo' } } } };
  w.controls = new AgentControls(w);
  w.actions = new AgentActions(w);
  return w;
}

/** Every object and function reachable from `root` through own properties and prototypes */
function reachable(root: object): Set<unknown> {
  const seen = new Set<unknown>();
  const queue: unknown[] = [root];
  while (queue.length) {
    const value = queue.pop();
    if (value === null || (typeof value !== 'object' && typeof value !== 'function') || seen.has(value)) continue;
    seen.add(value);
    queue.push(Object.getPrototypeOf(value));
    for (const key of Reflect.ownKeys(value)) {
      const desc = Object.getOwnPropertyDescriptor(value, key)!;
      queue.push(desc.value, desc.get, desc.set);
    }
  }
  return seen;
}

describe('AgentControls.bind', () => {
  it('gives the local player the controls themselves (PlayerLocal reads the keys from them)', () => {
    const w = world();
    expect(w.controls.bind({ priority: ControlPriorities.PLAYER })).toBe(w.controls);
  });

  it('gives an app script a control that leads neither to the controls system nor to the world', () => {
    const w = world();

    // What systems/Apps.js app.control() passes: the script's options, APP priority, the entity
    const control = w.controls.bind({ priority: ControlPriorities.APP, object: { world: w } });
    const graph = reachable(control);

    expect(control).not.toBe(w.controls);
    expect(graph.has(w.controls)).toBe(false);
    expect(graph.has(w)).toBe(false);
    expect(graph.has(w.actions)).toBe(false);
    expect(control.world).toBeUndefined();
    expect(control.setKey).toBeUndefined();
    expect(control.goto).toBeUndefined();
    expect(Object.isFrozen(control)).toBe(true);
    // What scripts use: buttons, a camera to write, a pointer to lock
    expect(control.keyX).toMatchObject({ down: false, pressed: false, released: false });
    expect(control.camera.position.isVector3).toBe(true);
    expect(() => control.pointer.lock()).not.toThrow();
    expect(() => control.setActions([])).not.toThrow();
  });

  it('gives every caller without PLAYER priority the inert control, whatever it passes', () => {
    const w = world();
    for (const options of [undefined, {}, { priority: 99 }, { priority: '0' }, { priority: null }]) {
      expect(w.controls.bind(options)).not.toBe(w.controls);
    }
  });

  it('does not show the agent\'s own keys in an app control', () => {
    const w = world();
    const control = w.controls.bind({ priority: ControlPriorities.APP });

    w.controls.setKey('keyW', true);

    expect(w.controls.keyW.down).toBe(true);
    expect(control.keyW.down).toBe(false);
  });

  it('presses keyX on app controls when the agent releases an item, until the control is released', () => {
    vi.useFakeTimers();
    try {
      const w = world();
      const onRelease = vi.fn();
      const control = w.controls.bind({ priority: ControlPriorities.APP, onRelease });
      const pressed = vi.fn();
      const released = vi.fn();
      control.keyX.onPress = pressed;
      control.keyX.onRelease = released;
      (w.actions as any).currentNode = { _onCancel: vi.fn() };

      expect(w.actions.releaseAction()).toBe(true);
      expect(pressed).toHaveBeenCalledTimes(1);
      expect(control.keyX.down).toBe(true);
      vi.advanceTimersByTime(500);
      expect(released).toHaveBeenCalledTimes(1);
      expect(control.keyX.down).toBe(false);

      control.release();
      control.release();
      expect(onRelease).toHaveBeenCalledTimes(1);
      (w.actions as any).currentNode = { _onCancel: vi.fn() };
      w.actions.releaseAction();
      expect(pressed).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('contains a key or release handler of a script that throws: releasing the item still completes', () => {
    vi.useFakeTimers();
    try {
      const w = world();
      const control = w.controls.bind({
        priority: ControlPriorities.APP,
        onRelease: () => {
          throw new Error('onRelease');
        },
      });
      control.keyX.onPress = () => {
        throw new Error('onPress');
      };
      control.keyX.onRelease = () => {
        throw new Error('onRelease');
      };
      (w.actions as any).currentNode = { _onCancel: vi.fn() };

      expect(w.actions.releaseAction()).toBe(true);
      vi.advanceTimersByTime(500);
      expect((w.actions as any).currentNode).toBeNull();
      // The engine calls release() while it tears the app down
      expect(() => control.release()).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets go of the item when the item's cancel handler throws, and tells the caller it failed", () => {
    vi.useFakeTimers();
    try {
      const w = world();
      const control = w.controls.bind({ priority: ControlPriorities.APP });
      (w.actions as any).currentNode = {
        _onCancel: () => {
          throw new Error('cancel refused');
        },
      };

      // The caller (HYPERFY_UNUSE_ITEM) reports this as a failed release
      expect(() => w.actions.releaseAction()).toThrow('cancel refused');
      expect(w.controls.keyX.down).toBe(true);
      expect(control.keyX.down).toBe(true);
      vi.advanceTimersByTime(500);
      // ...and the item is let go of all the same: nothing held, keyX up on both controls
      expect((w.actions as any).currentNode).toBeNull();
      expect(w.controls.keyX.down).toBe(false);
      expect(control.keyX.down).toBe(false);
      // so the agent can use an item again
      expect(w.actions.releaseAction()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('contains an item trigger handler that throws: the timer does not take the process down', () => {
    vi.useFakeTimers();
    try {
      const w = world();
      const node: any = {
        _duration: 10,
        _onTrigger: () => {
          throw new Error('onTrigger');
        },
        ctx: { entity: { data: { id: 'seat' }, root: { position: { distanceTo: () => 0 } } } },
      };
      w.actions.register(node);

      expect(w.actions.performAction('seat')).toBe('started');
      expect(() => vi.advanceTimersByTime(10)).not.toThrow();
      expect((w.actions as any).currentNode).toBe(node);
    } finally {
      vi.useRealTimers();
    }
  });
});

/*
 * Navigation with the signal of what it is for (a turn, or the connection). The player stands in
 * for the engine's: while the agent holds W it moves, as physics would move it.
 */
describe('AgentControls navigation and the signal of what it is for', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function walkable() {
    const player = {
      data: { id: 'coo' },
      base: { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() },
      cam: { rotation: { y: 0 } },
      teleport: vi.fn(),
    };
    const tower = { data: { id: 'tower' }, base: { position: new THREE.Vector3(10_000, 0, 0) } };
    const w: any = { rig: { position: { x: 0, y: 0, z: 0 } }, camera: { position: { z: 10 } }, entities: { player, items: new Map<string, unknown>([['tower', tower]]) } };
    const controls = new AgentControls(w);
    w.controls = controls;
    setInterval(() => {
      if (controls.keyW.down) player.base.position.x += 0.5;
    }, 100);
    const walking = () => controls.keyW.down === true;
    return { controls, player, walking };
  }

  it.each([
    ['goto', (controls: AgentControls, signal: AbortSignal) => controls.goto(10_000, 0, { signal })],
    ['followEntity', (controls: AgentControls, signal: AbortSignal) => controls.followEntity('tower', undefined, { signal })],
  ])('%s walks until its signal fires, then stops: the keys are released and its promise resolves', async (_name, start) => {
    const { controls, player, walking } = walkable();
    const stop = new AbortController();
    let ended = false;
    void start(controls, stop.signal).then(() => (ended = true));
    await vi.advanceTimersByTimeAsync(5_000);
    expect([controls.getIsNavigating(), walking(), ended]).toEqual([true, true, false]);
    const reached = player.base.position.x;
    expect(reached).toBeGreaterThan(10);

    stop.abort();
    // At once, not at the next tick
    expect([controls.getIsNavigating(), walking()]).toEqual([false, false]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ended).toBe(true);
    expect(player.base.position.x).toBe(reached);
  });

  it('starts nothing for a signal that has fired already', async () => {
    const { controls, walking } = walkable();
    const fired = new AbortController();
    fired.abort();
    await controls.goto(10_000, 0, { signal: fired.signal });
    await controls.followEntity('tower', undefined, { signal: fired.signal });
    await controls.startRandomWalk(1000, 5, 30_000, { signal: fired.signal });
    await controls.rotateTo('left', 500, { signal: fired.signal });
    await vi.advanceTimersByTimeAsync(1_000);
    expect([controls.getIsNavigating(), controls.getIsWalkingRandomly(), walking()]).toEqual([false, false, false]);
  });

  it('goes on walking while the signal never fires: a walk a completed turn left running', async () => {
    const { controls, walking } = walkable();
    const completed = new AbortController();
    void controls.followEntity('tower', undefined, { signal: completed.signal });
    await vi.advanceTimersByTimeAsync(60_000);
    expect([controls.getIsNavigating(), walking()]).toEqual([true, true]);
    // What the session's end does
    controls.stopAllActions('disconnect');
    expect([controls.getIsNavigating(), walking()]).toEqual([false, false]);
  });

  it('leaves a newer walk alone when the signal of the walk it replaced fires', async () => {
    const { controls, walking } = walkable();
    const older = new AbortController();
    const first = controls.goto(10_000, 0, { signal: older.signal });
    await vi.advanceTimersByTimeAsync(1_000);
    void controls.followEntity('tower');
    // At once, before the replaced walk's own loop has noticed that it was replaced
    older.abort();
    expect([controls.getIsNavigating(), walking()]).toEqual([true, true]);
    await vi.advanceTimersByTimeAsync(1_000);
    await first;
    expect([controls.getIsNavigating(), walking()]).toEqual([true, true]);
    controls.stopAllActions();
  });

  it('wandering stops when its signal fires, and goes on while it does not', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const { controls } = walkable();
    const stop = new AbortController();
    void controls.startRandomWalk(1000, 5, 600_000, { signal: stop.signal });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(controls.getIsWalkingRandomly()).toBe(true);
    stop.abort();
    expect([controls.getIsWalkingRandomly(), controls.getIsNavigating()]).toEqual([false, false]);
    await vi.advanceTimersByTimeAsync(20_000);
    expect([controls.getIsWalkingRandomly(), controls.getIsNavigating()]).toEqual([false, false]);
  });

  it('a turn stops where it is when its signal fires', async () => {
    const { controls, player } = walkable();
    const stop = new AbortController();
    let ended = false;
    void controls.rotateTo('back', 2_000, { signal: stop.signal }).then(() => (ended = true));
    await vi.advanceTimersByTimeAsync(500);
    expect(ended).toBe(false);
    stop.abort();
    await vi.advanceTimersByTimeAsync(100);
    expect(ended).toBe(true);
    const turned = player.base.quaternion.clone();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(player.base.quaternion.equals(turned)).toBe(true);
  });
});
