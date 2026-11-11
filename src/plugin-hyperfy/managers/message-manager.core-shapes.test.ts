import { AgentRuntime, ChannelType, type Entity, type Memory, type UUID, createUniqueUuid, getEntityDetails } from '@elizaos/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hyperfyProvider } from '../providers/world';
import { serviceFor, sessionFor } from '../test-support/session';
import { cooWorldChat } from '../test-support/world-packets';

/*
 * What the history and the world state read of a speaker (their name, and their Hyperfy player id)
 * comes from what elizaOS core stores for them. Here core itself stores it: real
 * AgentRuntime.ensureConnection (1.7.2) over an in-memory database, called by the real message and
 * voice managers, and core's real getEntityDetails reads it back.
 */

/** The parts of a database adapter that ensureConnection, getEntityDetails and getEntityById use. */
function memoryAdapter() {
  const entities = new Map<string, Entity>();
  const rooms = new Map<string, any>();
  const worlds = new Map<string, any>();
  const participants = new Map<string, Set<string>>();
  const copy = <T>(value: T): T => structuredClone(value);
  const adapter = {
    entities,
    getEntitiesByIds: async (ids: string[]) => ids.filter((id) => entities.has(id)).map((id) => copy(entities.get(id)!)),
    createEntities: async (created: Entity[]) => {
      for (const entity of created) entities.set(entity.id as string, copy(entity));
      return true;
    },
    updateEntity: async (entity: Entity) => void entities.set(entity.id as string, copy({ ...entities.get(entity.id as string), ...entity })),
    getWorld: async (id: string) => worlds.get(id) ?? null,
    createWorld: async (world: any) => (worlds.set(world.id, world), world.id),
    getRoomsByIds: async (ids: string[]) => ids.filter((id) => rooms.has(id)).map((id) => rooms.get(id)),
    createRooms: async (created: any[]) => created.map((room) => (rooms.set(room.id, room), room.id)),
    getParticipantsForRoom: async (roomId: string) => [...(participants.get(roomId) ?? [])],
    addParticipantsRoom: async (ids: string[], roomId: string) => {
      const set = participants.get(roomId) ?? new Set<string>();
      participants.set(roomId, set);
      for (const id of ids) set.add(id);
      return true;
    },
    getEntitiesForRoom: async (roomId: string) => [...(participants.get(roomId) ?? [])].filter((id) => entities.has(id)).map((id) => ({ ...copy(entities.get(id)!), components: [] })),
    getParticipantUserState: async () => null,
    getMemories: async () => [],
    log: async () => {},
  };
  return adapter;
}

function coreRuntime() {
  const runtime = new AgentRuntime({ character: { name: 'Coo', bio: [], settings: {} }, plugins: [] });
  const adapter = memoryAdapter();
  (runtime as { adapter: unknown }).adapter = adapter;
  // The agent's own entity, which core creates when the runtime is initialised
  adapter.entities.set(runtime.agentId, { id: runtime.agentId, names: ['Coo'], metadata: {}, agentId: runtime.agentId });
  // The turn itself is not what this is about: nothing handles the event
  const emitted: { message: Memory }[] = [];
  vi.spyOn(runtime, 'emitEvent').mockImplementation((async (_type: string, payload: { message: Memory }) => void emitted.push(payload)) as never);
  return { runtime, adapter, emitted };
}

const bob = { isPlayer: true, data: { id: 'bob-player-id', type: 'player', name: 'Bob' }, base: { position: { x: 1, y: 0, z: 1 } } };
function worldWithBob() {
  const coo = { data: { id: 'coo-player-id', name: 'Coo' } };
  return {
    entities: { player: coo, items: new Map<string, unknown>([['coo-player-id', coo], ['bob-player-id', bob]]), getPlayer: (id: string) => (id === 'bob-player-id' ? bob : undefined) },
    chat: { add: vi.fn() },
    network: { send: vi.fn() },
  };
}

afterEach(() => vi.restoreAllMocks());

describe('what core stores for a speaker, and what is read of it', () => {
  it("a chat sender's entity holds their name and their Hyperfy player id, and the history shows both", async () => {
    const { runtime, adapter, emitted } = coreRuntime();
    for (const method of ['info', 'debug', 'log', 'warn'] as const) vi.spyOn(console, method).mockImplementation(() => {});
    const session = sessionFor(worldWithBob(), { runtime });
    const turn = new AbortController();
    await session.runTurn({ origin: 'chat', requesterId: 'bob-player-id' }, () => session.messages.handleMessage(cooWorldChat('m1', 'bob-player-id', 'Bob', 'Coo, hello'), { signal: turn.signal, cancelled: false }));

    expect(emitted).toHaveLength(1);
    const entityId = createUniqueUuid(runtime, 'bob-player-id') as UUID;
    // As core's ensureConnection wrote it (not as a fixture imagines it)
    expect(adapter.entities.get(entityId)).toMatchObject({ names: ['Bob', 'Bob'], metadata: { hyperfy: { id: 'bob-player-id', name: 'Bob', userName: 'Bob' } } });

    const roomId = emitted[0].message.roomId;
    const details = await getEntityDetails({ runtime, roomId });
    const history = session.messages.formatMessages({ messages: [{ ...emitted[0].message, createdAt: Date.UTC(2026, 0, 1, 12, 0) }], entities: details as never });
    expect(history).toMatch(/Bob \[bob-player-id\]: Coo, hello$/);

    // The world state names the sender from the same stored record
    vi.spyOn(runtime, 'getService').mockReturnValue(serviceFor(session) as never);
    const state = await hyperfyProvider.get(runtime, emitted[0].message, {} as never);
    expect(String(state.values?.hyperfyStatus)).toContain('### Received Message\nBob: Coo, hello');
  });

  it("a speaker's entity (voice) holds the same, with channel type WORLD", async () => {
    const { runtime, adapter, emitted } = coreRuntime();
    for (const method of ['info', 'debug', 'log', 'warn'] as const) vi.spyOn(console, method).mockImplementation(() => {});
    const session = sessionFor(worldWithBob(), { runtime });
    await session.runTurn({ origin: 'voice', requesterId: 'bob-player-id' }, () => (session.voice as any).handleMessage('Coo, hello', 'bob-player-id'));
    expect(emitted).toHaveLength(1);
    expect(emitted[0].message.content.channelType).toBe(ChannelType.WORLD);
    expect(adapter.entities.get(createUniqueUuid(runtime, 'bob-player-id'))).toMatchObject({ names: ['Bob', 'Bob'], metadata: { hyperfy: { id: 'bob-player-id', name: 'Bob', userName: 'Bob' } } });
  });
});
