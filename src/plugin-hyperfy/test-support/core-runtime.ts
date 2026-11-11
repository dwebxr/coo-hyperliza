import { AgentRuntime, type Action, type Content, type Memory, type UUID } from '@elizaos/core';
import { expect, vi } from 'vitest';
import { hyperfyPlugin } from '../index';

/*
 * A real elizaOS core AgentRuntime (1.7.2) for driving real processActions in tests: only the two
 * adapter calls processActions makes, composeState, getService and useModel are stubbed.
 */

export const uuid = () => crypto.randomUUID() as UUID;

export interface Recorded {
  memories: Memory[];
  callbacks: Content[];
}

/** A model's canned result, or a function computing it (e.g. one that throws). */
type ModelStub = unknown | ((params: unknown) => unknown);

export function createRuntime({
  service = null,
  models = {},
  actions = hyperfyPlugin.actions ?? [],
}: { service?: unknown; models?: Record<string, ModelStub>; actions?: Action[] } = {}) {
  const runtime = new AgentRuntime({ character: { name: 'Coo', bio: [], settings: {} }, plugins: [] });
  const recorded: Recorded = { memories: [], callbacks: [] };
  // Only the two adapter calls processActions makes; runtime.createMemory itself stays real
  (runtime as { adapter: unknown }).adapter = {
    createMemory: async (memory: Memory) => {
      recorded.memories.push(memory);
      return memory.id;
    },
    log: async () => {},
    // For the message handler
    getParticipantUserState: async () => null,
  };
  vi.spyOn(runtime, 'composeState').mockResolvedValue({ values: {}, data: {}, text: '' });
  vi.spyOn(runtime, 'getService').mockReturnValue(service as never);
  const useModel = vi.spyOn(runtime, 'useModel').mockImplementation((async (type: string, params: unknown) => {
    if (!(type in models)) throw new Error(`unexpected model call: ${type}`);
    const stub = models[type];
    return typeof stub === 'function' ? (stub as (params: unknown) => unknown)(params) : stub;
  }) as never);
  for (const action of actions) runtime.registerAction(action);
  return { runtime, recorded, useModel };
}

export type StoredAction = Content & { actionStatus: string; actionResult: Record<string, any> };

/** Runs one planned response naming `actionNames` (in order) and returns each one's stored action memory. */
export async function runPlan(
  runtime: AgentRuntime,
  recorded: Recorded,
  actionNames: string[],
  { content = {}, message = {}, resolvedNames }: { content?: Content; message?: Partial<Memory>; resolvedNames?: string[] } = {}
): Promise<StoredAction[]> {
  const roomId = uuid();
  const incoming: Memory = {
    id: uuid(),
    entityId: uuid(),
    roomId,
    content: { text: 'please do it', source: 'hyperfy', metadata: { hyperfyFromId: 'player-1' } },
    ...message,
  };
  const planned: Memory = { id: uuid(), entityId: runtime.agentId, roomId, content: { ...content, actions: actionNames } };
  const before = recorded.memories.length;
  await runtime.processActions(incoming, [planned], { values: {}, data: {}, text: '' }, async (reply) => {
    recorded.callbacks.push(reply);
    return [];
  });
  const stored = recorded.memories.slice(before).filter((m) => m.content.type === 'action_result');
  // Core stores the name of the action it resolved, which differs from the emitted one for substring/simile matches
  expect(stored.map((m) => m.content.actionName)).toEqual(resolvedNames ?? actionNames);
  return stored.map((m) => m.content as StoredAction);
}

export async function run(runtime: AgentRuntime, recorded: Recorded, actionName: string, options?: Parameters<typeof runPlan>[3]) {
  return (await runPlan(runtime, recorded, [actionName], options))[0];
}

export function connectedService(world: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { isConnected: () => true, getWorld: () => world, getConnectionGeneration: () => 0, ...extra };
}
