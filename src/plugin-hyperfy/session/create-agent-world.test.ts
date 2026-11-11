import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Never the agent's saved session (the engine's storage is localstorage.json next to its own files)
vi.mock('../hyperfy/src/core/storage.js', () => ({ storage: { get: () => null, set: () => {}, remove: () => {} } }));
// What the engine's own PhysX loader gives once PhysX could not start: a promise that never
// settles (the failure itself surfaces as an unhandled rejection, see boundPhysicsInit)
vi.mock('../hyperfy/src/core/loadPhysX.js', () => ({ loadPhysX: () => new Promise(() => {}) }));

import { PHYSICS_INIT_TIMEOUT_MS, boundPhysicsInit, createAgentWorld } from './create-agent-world';
import { destroyWorld } from '../lib/world-teardown';

beforeEach(() => {
  vi.useFakeTimers();
  for (const method of ['info', 'log', 'warn'] as const) vi.spyOn(console, method).mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('starting the engine when PhysX cannot start', () => {
  it("world.init() of the agent's world rejects after the physics deadline instead of waiting for ever", async () => {
    // The real engine world with the engine's real Physics system; nothing is connected: physics
    // starts before the network system does
    const agentWorld = createAgentWorld({ wsUrl: 'ws://127.0.0.1:9/ws', sandboxedScripts: false });
    try {
      let outcome: unknown = 'pending';
      void agentWorld.init().then(
        () => (outcome = 'started'),
        (error: unknown) => (outcome = error)
      );
      await vi.advanceTimersByTimeAsync(PHYSICS_INIT_TIMEOUT_MS - 1);
      expect(outcome).toBe('pending');
      await vi.advanceTimersByTimeAsync(1);
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toBe(`[Hyperfy] The engine's physics (PhysX) did not start within ${PHYSICS_INIT_TIMEOUT_MS} ms`);
      // The socket was never opened: the engine stopped at its physics
      expect(agentWorld.world.network.ws).toBeFalsy();
    } finally {
      destroyWorld(agentWorld.world);
    }
  });
});

describe('boundPhysicsInit', () => {
  it('passes the engine init through when it finishes in time, with its arguments, and leaves no timer behind', async () => {
    const physics = { name: 'physics', init: vi.fn(async function (this: unknown, options: unknown) { return [this, options]; }) };
    const engineInit = physics.init;
    boundPhysicsInit(physics);
    const options = { wsUrl: 'x' };
    await expect(physics.init(options)).resolves.toEqual([physics, options]);
    expect(engineInit).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects with the engine's own error when the engine init rejects or throws", async () => {
    const rejecting = { init: async () => { throw new Error('no scene'); } };
    boundPhysicsInit(rejecting);
    await expect(rejecting.init()).rejects.toThrow('no scene');
    const throwing = { init: (() => { throw new Error('threw at once'); }) as () => Promise<unknown> };
    boundPhysicsInit(throwing);
    await expect(throwing.init()).rejects.toThrow('threw at once');
    expect(vi.getTimerCount()).toBe(0);
  });
});
