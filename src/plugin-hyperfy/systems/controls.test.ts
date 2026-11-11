import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentControls, NAVIGATION_TIMEOUT_MS, WORLD_COORDINATE_LIMIT } from './controls';
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
      const control = w.controls.bind(options);
      expect(control).not.toBe(w.controls);
      // Inert: frozen, and nothing in it leads to the controls system or the world
      const graph = reachable(control);
      expect([Object.isFrozen(control), graph.has(w.controls), graph.has(w), control.setKey, control.goto]).toEqual([true, false, false, undefined, undefined]);
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
      const thrower = (what: string) =>
        vi.fn(() => {
          throw new Error(what);
        });
      const handlers = { release: thrower('onRelease'), keyPress: thrower('onPress'), keyRelease: thrower('onRelease') };
      const control = w.controls.bind({ priority: ControlPriorities.APP, onRelease: handlers.release });
      control.keyX.onPress = handlers.keyPress;
      control.keyX.onRelease = handlers.keyRelease;
      (w.actions as any).currentNode = { _onCancel: vi.fn() };

      expect(w.actions.releaseAction()).toBe(true);
      vi.advanceTimersByTime(500);
      expect((w.actions as any).currentNode).toBeNull();
      // The engine calls release() while it tears the app down
      expect(() => control.release()).not.toThrow();
      // Each handler was called, and threw
      for (const handler of Object.values(handlers)) expect(handler.mock.results.map((result) => result.type)).toEqual(['throw']);
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
      const onTrigger = vi.fn(() => {
        throw new Error('onTrigger');
      });
      const node: any = {
        // Seconds, as the engine counts an action's duration
        _duration: 0.01,
        _onTrigger: onTrigger,
        ctx: { entity: { data: { id: 'seat' }, root: { position: { distanceTo: () => 0 } } } },
      };
      w.actions.register(node);

      expect(w.actions.performAction('seat')).toBe('started');
      expect(() => vi.advanceTimersByTime(10)).not.toThrow();
      expect(onTrigger.mock.results.map((result) => result.type)).toEqual(['throw']);
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

  it('starts nothing for a signal that has fired already: no walk, no wandering, no turn', async () => {
    const { controls, player, walking } = walkable();
    const fired = new AbortController();
    fired.abort();
    await controls.goto(10_000, 0, { signal: fired.signal });
    await controls.followEntity('tower', undefined, { signal: fired.signal });
    await controls.startRandomWalk(1000, 5, 30_000, { signal: fired.signal });
    await controls.rotateTo('left', 500, { signal: fired.signal });
    await controls.faceEntity('tower', 500, { signal: fired.signal });
    await vi.advanceTimersByTimeAsync(1_000);
    expect([controls.getIsNavigating(), controls.getIsWalkingRandomly(), walking()]).toEqual([false, false, false]);
    expect([player.base.position.toArray(), player.base.quaternion.toArray()]).toEqual([[0, 0, 0], [0, 0, 0, 1]]);
    // The same calls without a fired signal do turn the player (control)
    void controls.rotateTo('left', 500);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(player.base.quaternion.toArray()).not.toEqual([0, 0, 0, 1]);
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

/*
 * How a walk ends, and what is left pressed when it does. The player moves only while the test
 * says the ground lets it (`free`), so a walk can be made to get stuck and go into its recovery.
 */
describe('AgentControls walks: outcomes, and no key left down', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.25);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const MOVEMENT_KEYS = ['keyW', 'keyA', 'keyS', 'keyD', 'space', 'shiftLeft'] as const;

  function ground({ free = true }: { free?: boolean } = {}) {
    const state = { free };
    const player: any = {
      data: { id: 'coo' },
      base: { position: new THREE.Vector3(0, 7, 0), quaternion: new THREE.Quaternion() },
      cam: { rotation: { y: 0 } },
      teleport: vi.fn(({ position }: { position: THREE.Vector3 }) => player.base.position.copy(position)),
    };
    const tower = { data: { id: 'tower' }, base: { position: new THREE.Vector3(10_000, 0, 0) } };
    const items = new Map<string, any>([['tower', tower]]);
    const w: any = { rig: { position: { x: 0, y: 0, z: 0 } }, camera: { position: { z: 10 } }, entities: { player, items } };
    const controls = new AgentControls(w);
    w.controls = controls;
    // 5 m/s toward +x while W is held and the ground is free
    setInterval(() => {
      if (controls.keyW.down && state.free && player.base) player.base.position.x += 0.5;
    }, 100);
    const down = () => MOVEMENT_KEYS.filter((key) => controls[key].down);
    return { w, controls, player, tower, items, state, down };
  }

  it('says arrived only for a walk that got there', async () => {
    const { controls, player, down } = ground();
    const walk = controls.goto(20, 0);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(walk).resolves.toBe('arrived');
    expect(player.base.position.x).toBeGreaterThan(19);
    expect([controls.getIsNavigating(), down()]).toEqual([false, []]);
  });

  it.each([
    ['stopped', (c: AgentControls): void => c.stopAllActions('asked to stop')],
    ['stopped', (c: AgentControls): void => c.stopNavigation()],
    ['replaced', (c: AgentControls): void => void c.followEntity('tower')],
    ['replaced', (c: AgentControls): void => void c.teleportTo(new THREE.Vector3(1, 2, 3))],
  ] as const)('a walk ends as %s when that is what ended it, not as arrived', async (outcome, end) => {
    for (const start of [(c: AgentControls) => c.goto(10_000, 0), (c: AgentControls) => c.followEntity('tower')]) {
      const { controls } = ground();
      const walk = start(controls);
      await vi.advanceTimersByTimeAsync(1_050);
      end(controls);
      await vi.advanceTimersByTimeAsync(200);
      await expect(walk).resolves.toBe(outcome);
      controls.stopAllActions();
    }
  });

  it('a walk ends as cancelled when its signal fires, and as cancelled without starting when it had fired', async () => {
    const { controls, down } = ground();
    const turn = new AbortController();
    const walk = controls.goto(10_000, 0, { signal: turn.signal });
    await vi.advanceTimersByTimeAsync(1_000);
    turn.abort();
    expect(down()).toEqual([]);
    await vi.advanceTimersByTimeAsync(200);
    await expect(walk).resolves.toBe('cancelled');
    await expect(controls.goto(5, 5, { signal: turn.signal })).resolves.toBe('cancelled');
    await expect(controls.followEntity('tower', undefined, { signal: turn.signal })).resolves.toBe('cancelled');
    expect([controls.getIsNavigating(), down()]).toEqual([false, []]);
  });

  it('a walk that does not get there within its time ends as timed-out, with its keys released', async () => {
    const { controls, tower, player, down } = ground();
    // The tower moves away as fast as the agent follows
    setInterval(() => void (tower.base.position.x += 0.5), 100);
    const walk = controls.followEntity('tower');
    await vi.advanceTimersByTimeAsync(NAVIGATION_TIMEOUT_MS - 1_000);
    expect(down()).toContain('keyW');
    await vi.advanceTimersByTimeAsync(1_200);
    await expect(walk).resolves.toBe('timed-out');
    expect([controls.getIsNavigating(), down()]).toEqual([false, []]);
    const at = player.base.position.x;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(player.base.position.x).toBe(at);
  });

  it("a walk whose target goes away, or is not a place, ends as unreachable with its keys released, and the player's facing stays a facing", async () => {
    const { controls, items, tower, player, down } = ground();
    const gone = controls.followEntity('tower');
    await vi.advanceTimersByTimeAsync(1_000);
    items.delete('tower');
    await vi.advanceTimersByTimeAsync(200);
    await expect(gone).resolves.toBe('unreachable');
    expect([controls.getIsNavigating(), down()]).toEqual([false, []]);

    items.set('tower', tower);
    const nowhere = controls.followEntity('tower');
    await vi.advanceTimersByTimeAsync(1_000);
    tower.base.position.x = Number.NaN;
    await vi.advanceTimersByTimeAsync(200);
    await expect(nowhere).resolves.toBe('unreachable');
    expect([controls.getIsNavigating(), down()]).toEqual([false, []]);
    // Not turned toward a position that is not a number (the world would be sent that facing)
    expect(player.base.quaternion.toArray().every(Number.isFinite)).toBe(true);
  });

  it.each([
    ['a position that is not a number', (player: any) => void (player.base.position.x = Number.NaN)],
    ['an infinite position', (player: any) => void (player.base.position.z = Number.POSITIVE_INFINITY)],
    ['a facing that is not a number', (player: any) => void (player.base.quaternion.w = Number.NaN)],
    ['no body', (player: any) => void (player.base = null)],
  ])('a walk stops, with its keys released, when the player has %s', async (_what, spoil) => {
    const { controls, player, down } = ground();
    const walk = controls.goto(10_000, 0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(down()).toContain('keyW');
    spoil(player);
    await vi.advanceTimersByTimeAsync(200);
    await expect(walk).resolves.toBe('unreachable');
    expect([controls.getIsNavigating(), down()]).toEqual([false, []]);
  });

  it('a walk stops, with its keys released, when the player is gone', async () => {
    const { w, controls, down } = ground();
    const walk = controls.goto(10_000, 0);
    await vi.advanceTimersByTimeAsync(1_000);
    w.entities.player = null;
    await vi.advanceTimersByTimeAsync(200);
    await expect(walk).resolves.toBe('unreachable');
    expect([controls.getIsNavigating(), down()]).toEqual([false, []]);
  });

  it('starts no walk to coordinates that are not finite numbers', async () => {
    const { controls, down } = ground();
    for (const [x, z] of [[Number.NaN, 0], [0, Number.POSITIVE_INFINITY], ['5' as unknown as number, 0], [undefined as unknown as number, 1]]) {
      await expect(controls.goto(x, z)).resolves.toBe('unreachable');
      expect([controls.getIsNavigating(), down()]).toEqual([false, []]);
    }
  });

  it('walks no farther than the world takes as a position: a target beyond it is brought back to it', async () => {
    const { controls, player, state } = ground({ free: false });
    const walk = controls.goto(5e9, -5e9);
    // Stuck: after its recoveries the walk ends with a teleport next to its target
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(walk).resolves.toBe('arrived');
    const [{ position }] = player.teleport.mock.calls.at(-1)!;
    expect(Math.abs(position.x)).toBeLessThanOrEqual(WORLD_COORDINATE_LIMIT);
    expect(Math.abs(position.z)).toBeLessThanOrEqual(WORLD_COORDINATE_LIMIT);
    expect(position.x).toBeGreaterThan(WORLD_COORDINATE_LIMIT - 1);
    expect(state.free).toBe(false);
  });

  it('the teleport that ends a stuck walk keeps the height the agent stands at', async () => {
    const { controls, player } = ground({ free: false });
    const walk = controls.goto(30, 0);
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(walk).resolves.toBe('arrived');
    expect(player.teleport).toHaveBeenCalledTimes(1);
    const [{ position }] = player.teleport.mock.calls[0];
    // The agent stood at y = 7; the target (30, 0) has no height of its own
    expect(position.toArray()).toEqual([29.5, 7, 0]);
  });

  it("turns the player by writing into the player's own quaternion, never by replacing it", async () => {
    const { controls, player } = ground();
    const own = player.base.quaternion;
    void controls.goto(0, 10_000);
    await vi.advanceTimersByTimeAsync(500);
    expect(player.base.quaternion).toBe(own);
    // Facing +z now
    expect(new THREE.Vector3(0, 0, -1).applyQuaternion(own).z).toBeCloseTo(1);
    // A second walk elsewhere does not turn anything but the player
    const facing = own.clone();
    controls.stopAllActions();
    const other = ground();
    void other.controls.goto(-10_000, 0);
    await vi.advanceTimersByTimeAsync(500);
    expect(own.equals(facing)).toBe(true);
    other.controls.stopAllActions();
  });

  it("an older walk that notices it was replaced does not release the newer walk's keys", async () => {
    const { controls, down } = ground();
    const older = controls.goto(10_000, 0);
    // Off the older walk's ticks, so the two walks do not act at the same moments
    await vi.advanceTimersByTimeAsync(1_050);
    void controls.followEntity('tower');
    expect(down()).toContain('keyW');
    // The older walk's next tick comes before the newer one's
    await vi.advanceTimersByTimeAsync(60);
    await expect(older).resolves.toBe('replaced');
    expect(down()).toContain('keyW');
    expect(controls.getIsNavigating()).toBe(true);
    controls.stopAllActions();
  });

  it('a walk cancelled while it turns to get unstuck presses nothing afterwards, and a later stop leaves nothing down (P-01)', async () => {
    const { controls, player, down } = ground({ free: false });
    const turn = new AbortController();
    const walk = controls.goto(10_000, 0, { signal: turn.signal });
    // Ten ticks without progress, then the recovery turn begins
    await vi.advanceTimersByTimeAsync(1_150);
    expect(down()).toEqual(['keyW', 'shiftLeft']);
    const facingBefore = player.base.quaternion.clone();
    await vi.advanceTimersByTimeAsync(100);
    // It is turning
    expect(player.base.quaternion.equals(facingBefore)).toBe(false);
    turn.abort();
    expect(down()).toEqual([]);
    const facing = player.base.quaternion.clone();
    for (let elapsed = 0; elapsed < 3_000; elapsed += 50) {
      await vi.advanceTimersByTimeAsync(50);
      expect(down(), `${elapsed + 50} ms after the cancellation`).toEqual([]);
      // The recovery turn stopped with the walk
      expect(player.base.quaternion.equals(facing), `${elapsed + 50} ms after the cancellation`).toBe(true);
    }
    await expect(walk).resolves.toBe('cancelled');
    controls.stopAllActions('asked to stop');
    expect([controls.getIsNavigating(), down()]).toEqual([false, []]);
  });

  /*
   * Every await of every movement routine: a walk that moves, one that is stuck (its ticks, its
   * recovery turns, the jump after them), a follow, and wandering (its legs and the pauses between
   * them), each ended at every 50 ms of its first seconds, in each of the ways a walk is ended.
   * From that moment on no movement key may be down, at any later moment.
   */
  const routines: [string, (c: AgentControls, signal: AbortSignal) => unknown, boolean][] = [
    ['goto', (c, signal) => c.goto(10_000, 0, { signal }), true],
    ['goto while stuck', (c, signal) => c.goto(10_000, 0, { signal }), false],
    ['followEntity', (c, signal) => c.followEntity('tower', undefined, { signal }), true],
    ['followEntity while stuck', (c, signal) => c.followEntity('tower', undefined, { signal }), false],
    ['startRandomWalk', (c, signal) => c.startRandomWalk(400, 3, 600_000, { signal }), true],
    ['startRandomWalk while stuck', (c, signal) => c.startRandomWalk(400, 3, 600_000, { signal }), false],
  ];
  const endings: [string, (c: AgentControls, turn: AbortController) => void][] = [
    ['its signal fires', (_c, turn) => turn.abort()],
    ['stopAllActions', (c) => c.stopAllActions('asked to stop')],
    ['a teleport', (c) => void c.teleportTo(new THREE.Vector3(0, 7, 0))],
  ];
  it.each(routines.flatMap(([name, start, free]) => endings.map(([how, end]) => [name, how, start, free, end] as const)))(
    '%s ended by %s at any moment leaves no movement key down from then on',
    async (_name, _how, start, free, end) => {
      for (let endAt = 0; endAt <= 4_000; endAt += 50) {
        const { controls, down } = ground({ free });
        const turn = new AbortController();
        void start(controls, turn.signal);
        await vi.advanceTimersByTimeAsync(endAt);
        end(controls, turn);
        expect(down(), `ended at ${endAt} ms: at once`).toEqual([]);
        for (let later = 50; later <= 2_500; later += 50) {
          await vi.advanceTimersByTimeAsync(50);
          expect(down(), `ended at ${endAt} ms: ${later} ms later`).toEqual([]);
        }
        expect([controls.getIsNavigating(), controls.getIsWalkingRandomly()]).toEqual([false, false]);
        vi.clearAllTimers();
      }
    }
  );

  it('releases the movement keys on stop even when no walk is recorded as in progress', () => {
    const { controls, down } = ground();
    // What a routine that lost track would leave behind
    controls.setKey('keyW', true);
    controls.setKey('space', true);
    expect(controls.getIsNavigating()).toBe(false);
    controls.stopAllActions('asked to stop');
    expect(down()).toEqual([]);
  });

  it('teleports only to three finite numbers, brought back to what the world takes as a position', () => {
    const { controls, player, items } = ground();
    for (const bad of [new THREE.Vector3(Number.NaN, 0, 0), new THREE.Vector3(0, Number.POSITIVE_INFINITY, 0), null as unknown as THREE.Vector3]) {
      expect(controls.teleportTo(bad)).toBe('unreachable');
    }
    items.set('nowhere', { data: { id: 'nowhere' }, base: { position: new THREE.Vector3(1, Number.NaN, 1) } });
    items.set('bare', { data: { id: 'bare' } });
    expect(controls.teleportToEntity('nowhere')).toBe('unreachable');
    expect(controls.teleportToEntity('bare')).toBe('unreachable');
    expect(controls.teleportToEntity('nobody')).toBe('unreachable');
    expect(player.teleport).not.toHaveBeenCalled();

    expect(controls.teleportTo(new THREE.Vector3(5e9, -5e9, 3), Number.NaN)).toBe('arrived');
    const [{ position, rotationY }] = player.teleport.mock.calls[0];
    expect(position.toArray()).toEqual([WORLD_COORDINATE_LIMIT, -WORLD_COORDINATE_LIMIT, 3]);
    expect(rotationY).toBeUndefined();
    expect(controls.teleportToEntity('tower')).toBe('arrived');
  });

  it('turns to face an entity, and does not turn to face one whose position is not a number', async () => {
    const { controls, player, items } = ground();
    items.set('nowhere', { data: { id: 'nowhere' }, base: { position: new THREE.Vector3(Number.NaN, 0, 1) } });
    const before = player.base.quaternion.clone();
    await controls.faceEntity('nowhere');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(player.base.quaternion.equals(before)).toBe(true);
    expect(Number.isFinite(player.base.quaternion.w)).toBe(true);
    // The tower is at +x: facing it is a turn (control)
    void controls.faceEntity('tower');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(new THREE.Vector3(0, 0, -1).applyQuaternion(player.base.quaternion).x).toBeCloseTo(1);
  });
});
