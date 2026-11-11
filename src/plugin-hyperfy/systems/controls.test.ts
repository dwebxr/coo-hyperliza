import { describe, expect, it, vi } from 'vitest';
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
