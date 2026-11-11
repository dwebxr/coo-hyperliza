import type { IAgentRuntime, UUID } from '@elizaos/core';
import { ConnectionSession, type SessionParts } from '../session/connection-session';
import { registerSession } from './session-registry';

export const TEST_WORLD_ID = '00000000-0000-0000-0000-0000000000f1' as UUID;

/** The least a runtime needs for a session to be built around it. */
export function sessionRuntime(extra: Record<string, unknown> = {}): IAgentRuntime {
  return { agentId: '00000000-0000-0000-0000-0000000000aa', character: { name: 'Coo', templates: {} }, ...extra } as unknown as IAgentRuntime;
}

/**
 * A real ConnectionSession around `world` (a stand-in, or an engine world that was never
 * initialised). Nothing is connected and none of its loops run; it counts as connected, as after
 * connect(), unless `connected` is false.
 */
export function sessionFor(world: object, { runtime = sessionRuntime(), connected = true, ...parts }: Partial<SessionParts> & { connected?: boolean } = {}): ConnectionSession {
  const session = new ConnectionSession({ runtime, world, worldId: TEST_WORLD_ID, wsUrl: 'wss://world.test/ws', ...parts });
  // What connect() sets once the world is initialised, and the spawn of the agent's player, without
  // starting the voice and behavior loops
  if (connected) Object.assign(session as unknown as { started: boolean; established: boolean }, { started: true, established: true });
  // So that the turn helpers (test-support/turns.ts) run their turns on this session
  registerSession(world, session);
  return session;
}

/** Members of a session a test replaces with its own (a manager, the render page). */
export type SessionOverrides = Partial<Record<'emotes' | 'messages' | 'voice' | 'behavior' | 'build' | 'renderPage' | 'tipWallet', unknown>>;

/** Replaces members of `session` with a test's own. */
export function withParts(session: ConnectionSession, overrides: SessionOverrides): ConnectionSession {
  return Object.assign(session, overrides);
}

/**
 * What runtime.getService('hyperfy') returns in a test: the service's accessors over one session
 * (or over whatever `session()` returns at the time, for a session built after the runtime).
 */
export function serviceFor(session: ConnectionSession | null | (() => ConnectionSession | null)) {
  const current = typeof session === 'function' ? session : () => session;
  return {
    getSession: current,
    getWorld: () => current()?.world ?? null,
    isConnected: () => current()?.connected ?? false,
    get currentWorldId() {
      return current()?.worldId ?? null;
    },
  };
}
