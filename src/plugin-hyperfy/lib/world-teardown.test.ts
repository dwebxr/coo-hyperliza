import { describe, expect, it, vi } from 'vitest';
import { destroyWorld } from './world-teardown';

// The real engine world is torn down in script-sandbox.child.test.ts; here each step is faked
class Entities {}
class NodeClient {}
class ClientNetwork {}

function world({ failingSystem = false, failingEntity = false } = {}) {
  const destroyed: string[] = [];
  const system = (name: string, Kind: new () => object, fails = false) =>
    Object.assign(new Kind(), {
      destroy: () => {
        destroyed.push(name);
        if (fails) throw new Error(`${name} failed`);
      },
    });
  const app = (id: string, fails: boolean) => ({
    isApp: true,
    data: { id },
    deadHook: { dead: false },
    clearEventListeners: vi.fn(),
    destroy: vi.fn(() => {
      if (fails) throw new Error(`a script of ${id} broke its teardown`);
    }),
  });
  const apps = [app('first', failingEntity), app('second', false)];
  const ws = { readyState: 1, close: vi.fn() };
  const timer = setTimeout(() => {}, 60_000);
  const w = {
    systems: [system('Entities', Entities, failingSystem), system('NodeClient', NodeClient), system('ClientNetwork', ClientNetwork)],
    entities: { items: new Map(apps.map((a) => [a.data.id, a])) },
    setHot: vi.fn(),
    network: { ws },
    client: { timerId: timer },
  };
  return { w, destroyed, apps, ws, timer };
}

describe('destroyWorld', () => {
  it('destroys every system and closes the socket when nothing fails', () => {
    const { w, destroyed, ws } = world();
    const log = { warn: vi.fn() };

    expect(destroyWorld(w, log)).toEqual([]);
    expect(destroyed).toEqual(['Entities', 'NodeClient', 'ClientNetwork']);
    expect(ws.close).toHaveBeenCalledTimes(1);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('goes on past a system that throws, and stops the tick timer and the socket all the same', () => {
    const { w, destroyed, ws, timer } = world({ failingSystem: true });
    const log = { warn: vi.fn() };
    const clear = vi.spyOn(globalThis, 'clearTimeout');
    try {
      const failures = destroyWorld(w, log);

      expect(destroyed).toEqual(['Entities', 'NodeClient', 'ClientNetwork']);
      expect(failures).toEqual(['Entities: Entities failed']);
      expect(ws.close).toHaveBeenCalledTimes(1);
      expect(clear).toHaveBeenCalledWith(timer);
      // One warning for all of it
      expect(log.warn).toHaveBeenCalledTimes(1);
      expect(log.warn.mock.calls[0][0]).toContain('Entities: Entities failed');
    } finally {
      clear.mockRestore();
    }
  });

  it('goes on past an app whose teardown throws, and leaves no app running', () => {
    const { w, apps } = world({ failingEntity: true });

    const failures = destroyWorld(w, { warn: vi.fn() });

    expect(failures).toEqual(['entity first: a script of first broke its teardown']);
    for (const app of apps) {
      expect(app.destroy).toHaveBeenCalled();
      // Its timers stop (App.setTimeout checks the dead hook) and its listeners go
      expect(app.deadHook.dead).toBe(true);
      expect(app.clearEventListeners).toHaveBeenCalled();
      expect(w.setHot).toHaveBeenCalledWith(app, false);
    }
  });

  it.each([
    ['closing', 2],
    ['closed', 3],
  ])('does not close a socket that is already %s', (_state, readyState) => {
    const { w, ws } = world();
    ws.readyState = readyState;
    destroyWorld(w, { warn: vi.fn() });
    expect(ws.close).not.toHaveBeenCalled();
  });

  it('closes a socket that is still connecting', () => {
    const { w, ws } = world();
    ws.readyState = 0;
    destroyWorld(w, { warn: vi.fn() });
    expect(ws.close).toHaveBeenCalledTimes(1);
  });
});
