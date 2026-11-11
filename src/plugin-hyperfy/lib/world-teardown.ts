/**
 * Destroys an engine world (hyperfy/src/core/World.js) so that one failing step does not leave
 * the rest running. World.destroy() calls each system's destroy() in turn with no try/catch, and
 * the Entities system destroys its entities the same way, so one throw (an app's teardown runs
 * node unmounts and world scripts' code) would leave the other apps, Physics, Stage, the tick loop
 * (NodeClient) and the socket (ClientNetwork) alive. Here every entity is destroyed on its own,
 * then every app is marked dead (its script timers check that) and loses its listeners, then every
 * system is destroyed on its own, the socket is closed and the tick timer cleared, whatever failed
 * before.
 */

interface EntityLike {
  isApp?: unknown;
  data?: { id?: unknown };
  destroy?: () => void;
  deadHook?: { dead?: boolean };
  clearEventListeners?: () => void;
}

interface WorldLike {
  systems?: unknown;
  entities?: { items?: unknown } | null;
  setHot?: (entity: unknown, hot: boolean) => void;
  network?: { ws?: { readyState?: unknown; close?: () => void } | null } | null;
  client?: { timerId?: unknown } | null;
}

const OPEN_OR_CONNECTING = new Set([0, 1]);

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Destroys `world`. Returns one line per step that failed (also logged, once, as one warning). */
export function destroyWorld(world: WorldLike, log: Pick<Console, 'warn'> = console): string[] {
  const failures: string[] = [];
  const items = world.entities?.items;
  const entities = items instanceof Map ? ([...items.values()] as EntityLike[]) : [];
  for (const entity of entities) {
    try {
      entity?.destroy?.();
    } catch (error) {
      failures.push(`entity ${String(entity?.data?.id)}: ${describe(error)}`);
    }
  }
  // Whatever failed above, no app's script runs on: App.setTimeout drops a callback whose dead
  // hook is set, and the app's own and world listeners go
  for (const entity of entities) {
    if (!entity?.isApp) continue;
    try {
      if (entity.deadHook) entity.deadHook.dead = true;
      entity.clearEventListeners?.();
      world.setHot?.(entity, false);
    } catch (error) {
      failures.push(`stopping app ${String(entity.data?.id)}: ${describe(error)}`);
    }
  }
  const systems = Array.isArray(world.systems) ? (world.systems as unknown[]) : [];
  for (const system of systems) {
    const destroy = (system as { destroy?: unknown } | null)?.destroy;
    if (typeof destroy !== 'function') continue;
    try {
      Reflect.apply(destroy, system, []);
    } catch (error) {
      const name = (system as { constructor?: { name?: unknown } }).constructor?.name;
      failures.push(`${typeof name === 'string' ? name : 'a system'}: ${describe(error)}`);
    }
  }
  try {
    const ws = world.network?.ws;
    if (ws && typeof ws.close === 'function' && OPEN_OR_CONNECTING.has(ws.readyState as number)) ws.close();
  } catch (error) {
    failures.push(`closing the socket: ${describe(error)}`);
  }
  const timer = world.client?.timerId;
  if (timer !== undefined && timer !== null) clearTimeout(timer as ReturnType<typeof setTimeout>);
  if (failures.length) log.warn(`[Hyperfy Cleanup] Destroying the world: ${failures.length} step(s) failed: ${failures.join('; ')}`);
  return failures;
}
