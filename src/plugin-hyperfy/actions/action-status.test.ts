import { AgentRuntime, ModelType, type Action, type Content, type Memory, type UUID } from '@elizaos/core';
import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hyperfyPlugin } from '../index';
import { SHARE_ACTION, createOpenPayStorePlugin } from '../../openpay-store';
import { AgentActions } from '../systems/actions';
import { AgentControls } from '../systems/controls';

/*
 * Drives real elizaOS core processActions (1.7.2) with the plugin's real actions and records the
 * action memory core stores for each one: content.actionStatus is what later turns see.
 */

const uuid = () => crypto.randomUUID() as UUID;

interface Recorded {
  memories: Memory[];
  callbacks: Content[];
}

function createRuntime({ service = null, models = {} }: { service?: unknown; models?: Record<string, unknown> } = {}) {
  const runtime = new AgentRuntime({ character: { name: 'Coo', bio: [], settings: {} }, plugins: [] });
  const recorded: Recorded = { memories: [], callbacks: [] };
  // Only the two adapter calls processActions makes; runtime.createMemory itself stays real
  (runtime as { adapter: unknown }).adapter = {
    createMemory: async (memory: Memory) => {
      recorded.memories.push(memory);
      return memory.id;
    },
    log: async () => {},
  };
  vi.spyOn(runtime, 'composeState').mockResolvedValue({ values: {}, data: {}, text: '' });
  vi.spyOn(runtime, 'getService').mockReturnValue(service as never);
  vi.spyOn(runtime, 'useModel').mockImplementation((async (type: string) => {
    if (!(type in models)) throw new Error(`unexpected model call: ${type}`);
    return models[type];
  }) as never);
  for (const action of hyperfyPlugin.actions ?? []) runtime.registerAction(action);
  return { runtime, recorded };
}

type StoredAction = Content & { actionStatus: string; actionResult: Record<string, any> };

/** Runs one planned response naming `actionNames` (in order) and returns each one's stored action memory. */
async function runPlan(
  runtime: AgentRuntime,
  recorded: Recorded,
  actionNames: string[],
  { content = {}, message = {} }: { content?: Content; message?: Partial<Memory> } = {}
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
  expect(stored.map((m) => m.content.actionName)).toEqual(actionNames);
  return stored.map((m) => m.content as StoredAction);
}

async function run(runtime: AgentRuntime, recorded: Recorded, actionName: string, options?: Parameters<typeof runPlan>[3]) {
  return (await runPlan(runtime, recorded, [actionName], options))[0];
}

/** A world with the real AgentControls and AgentActions systems; navigation itself is stubbed per test. */
function createWorld({ withPlayer = true }: { withPlayer?: boolean } = {}) {
  const world: any = {
    rig: { position: new THREE.Vector3() },
    entities: {
      items: new Map<string, unknown>([['crate', { data: { id: 'crate' }, root: { position: new THREE.Vector3(1, 0, 2) } }]]),
      player: withPlayer
        ? { data: { id: 'agent' }, base: { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() }, teleport: vi.fn() }
        : undefined,
    },
  };
  world.controls = new AgentControls(world);
  world.actions = new AgentActions(world);
  return world;
}

const addPlayer = (world: any, id: string) =>
  world.entities.items.set(id, { isPlayer: true, data: { id }, base: { position: new THREE.Vector3(3, 0, 4) } });

const addActionNode = (world: any, entityId: string, extra: Record<string, unknown> = {}) => {
  const node = { ctx: { entity: { data: { id: entityId } } }, _duration: 0, _onTrigger: vi.fn(), ...extra };
  world.actions.register(node);
  return node;
};

const settleTimers = () => new Promise((resolve) => setTimeout(resolve, 10));

function connectedService(world: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { isConnected: () => true, getWorld: () => world, ...extra };
}

afterEach(() => vi.restoreAllMocks());

describe('core processActions contract (what the action-result helpers rely on)', () => {
  const stub = (name: string, result: unknown): Action => ({
    name,
    description: name,
    validate: async () => true,
    handler: async () => result as never,
  });

  it('stores a legacy void or boolean return as failed and an object without values/data/text as completed', async () => {
    const { runtime, recorded } = createRuntime();
    runtime.registerAction(stub('LEGACY_VOID', undefined));
    runtime.registerAction(stub('LEGACY_TRUE', true));
    runtime.registerAction(stub('BARE_FAILURE', { success: false }));
    expect((await run(runtime, recorded, 'LEGACY_VOID')).actionStatus).toBe('failed');
    expect((await run(runtime, recorded, 'LEGACY_VOID')).actionResult).toEqual({ legacy: undefined });
    expect((await run(runtime, recorded, 'LEGACY_TRUE')).actionStatus).toBe('failed');
    expect((await run(runtime, recorded, 'BARE_FAILURE')).actionStatus).toBe('completed');
  });
});

describe('action status recorded by core for every Hyperfy action', () => {
  it('records a completed IGNORE, REPLY and ambient speech that reuse the planned text', async () => {
    const { runtime, recorded } = createRuntime();
    expect((await run(runtime, recorded, 'IGNORE', { content: { thought: 'no' } })).actionStatus).toBe('completed');
    expect(recorded.callbacks.splice(0)).toEqual([expect.objectContaining({ thought: 'no', actions: ['IGNORE'] })]);
    const reply = await run(runtime, recorded, 'REPLY', { content: { text: 'Hello!' } });
    expect(reply.actionStatus).toBe('completed');
    expect(reply.actionResult).toEqual({ success: true, data: { actionName: 'REPLY' } });
    // No ActionResult text, so core keeps its own memory text and the world chat history is unchanged
    expect(reply.text).toBe('Executed action: REPLY');
    expect((await run(runtime, recorded, 'HYPERFY_AMBIENT_SPEECH', { content: { text: 'Quiet here.' } })).actionStatus).toBe('completed');
    expect(recorded.callbacks.map((c) => c.text)).toEqual(['Hello!', 'Quiet here.']);
  });

  it('records a generated REPLY as completed', async () => {
    const { runtime, recorded } = createRuntime({ models: { [ModelType.OBJECT_LARGE]: { thought: 't', message: 'Generated hi' } } });
    expect((await run(runtime, recorded, 'REPLY')).actionStatus).toBe('completed');
    expect(recorded.callbacks).toEqual([expect.objectContaining({ thought: 't', text: 'Generated hi', actions: ['REPLY'] })]);
  });

  it.each([
    'HYPERFY_STOP_MOVING',
    'HYPERFY_TELEPORT_TO_USER',
    'HYPERFY_UNUSE_ITEM',
    'HYPERFY_WALK_RANDOMLY',
    'HYPERFY_GOTO_ENTITY',
    'HYPERFY_USE_ITEM',
    'HYPERFY_SCENE_PERCEPTION',
    'HYPERFY_EDIT_ENTITY',
  ])('records %s as failed, with the reason, when there is no Hyperfy service', async (actionName) => {
    const { runtime, recorded } = createRuntime();
    const stored = await run(runtime, recorded, actionName);
    expect(stored.actionStatus).toBe('failed');
    expect(stored.actionResult).toMatchObject({ success: false, data: { actionName } });
    expect(typeof stored.actionResult.error).toBe('string');
  });

  it('records movement and item actions as completed when the real systems carry them out', async () => {
    const world = createWorld();
    addPlayer(world, 'player-1');
    const node = addActionNode(world, 'crate');
    const goto = vi.spyOn(world.controls, 'goto').mockResolvedValue(undefined);
    vi.spyOn(world.controls, 'startRandomWalk').mockResolvedValue(undefined);
    const { runtime, recorded } = createRuntime({
      service: connectedService(world),
      models: {
        [ModelType.OBJECT_LARGE]: { navigationType: 'position', parameter: { position: { x: 5, z: -3 } } },
        [ModelType.OBJECT_SMALL]: { entityId: 'crate' },
      },
    });
    for (const name of ['HYPERFY_STOP_MOVING', 'HYPERFY_TELEPORT_TO_USER', 'HYPERFY_WALK_RANDOMLY', 'HYPERFY_GOTO_ENTITY', 'HYPERFY_USE_ITEM']) {
      expect((await run(runtime, recorded, name)).actionStatus, name).toBe('completed');
    }
    // Holding the crate once its use timer fired, so there is something to release
    await settleTimers();
    expect(node._onTrigger).toHaveBeenCalledWith({ playerId: 'agent' });
    expect((await run(runtime, recorded, 'HYPERFY_UNUSE_ITEM')).actionStatus).toBe('completed');
    expect(world.entities.player.teleport).toHaveBeenCalledWith(expect.objectContaining({ position: expect.objectContaining({ x: 3, z: 4 }) }));
    expect(goto).toHaveBeenCalledWith(5, -3);
    expect(goto).toHaveBeenCalledWith(1, 2);
    expect(recorded.callbacks.map((c) => c.text)).toEqual(expect.arrayContaining(['Teleporting to you!', 'Using item: crate', 'Item released.']));
  });

  it('records teleport, use and release as failed, and announces nothing, when the real systems do nothing', async () => {
    // The sender left and nobody else is in the world; the crate has no action node; nothing is held
    const world = createWorld();
    vi.spyOn(world.controls, 'goto').mockResolvedValue(undefined);
    const { runtime, recorded } = createRuntime({
      service: connectedService(world),
      models: { [ModelType.OBJECT_SMALL]: { entityId: 'crate' } },
    });
    const teleport = await run(runtime, recorded, 'HYPERFY_TELEPORT_TO_USER');
    expect(teleport.actionStatus).toBe('failed');
    expect(teleport.actionResult.error).toBe('no player to teleport to');
    expect(world.entities.player.teleport).not.toHaveBeenCalled();

    const use = await run(runtime, recorded, 'HYPERFY_USE_ITEM');
    expect(use.actionStatus).toBe('failed');
    expect(use.actionResult.data).toMatchObject({ targetEntityId: 'crate', outcome: 'no-action-nodes' });

    addActionNode(world, 'lamp');
    const otherNode = await run(runtime, recorded, 'HYPERFY_USE_ITEM');
    expect(otherNode.actionResult.data).toMatchObject({ outcome: 'entity-has-no-action-node' });

    const release = await run(runtime, recorded, 'HYPERFY_UNUSE_ITEM');
    expect(release.actionStatus).toBe('failed');
    expect(release.actionResult.error).toBe('not holding or using anything');
    expect(recorded.callbacks).toEqual([]);
  });

  it('turns a rejected navigation into a failed result and still runs the next planned action', async () => {
    // Real AgentControls during teardown: the player entity is gone, so navigation rejects
    const world = createWorld({ withPlayer: false });
    const { runtime, recorded } = createRuntime({
      service: connectedService(world),
      models: { [ModelType.OBJECT_SMALL]: { entityId: 'crate' } },
    });
    const [use, ignore] = await runPlan(runtime, recorded, ['HYPERFY_USE_ITEM', 'IGNORE']);
    expect(use.actionStatus).toBe('failed');
    expect(use.actionResult.error).toMatch(/^could not reach or use the item: /);
    expect(ignore.actionStatus).toBe('completed');
  });

  it('turns a throwing teleport or release into a failed result', async () => {
    const world = createWorld();
    addPlayer(world, 'player-1');
    world.entities.player.teleport.mockImplementation(() => {
      throw new Error('socket closed');
    });
    addActionNode(world, 'crate', {
      _onCancel: () => {
        throw new Error('app script error');
      },
    });
    vi.spyOn(world.controls, 'goto').mockResolvedValue(undefined);
    const { runtime, recorded } = createRuntime({
      service: connectedService(world),
      models: { [ModelType.OBJECT_SMALL]: { entityId: 'crate' } },
    });
    const teleport = await run(runtime, recorded, 'HYPERFY_TELEPORT_TO_USER');
    expect(teleport.actionStatus).toBe('failed');
    expect(teleport.actionResult.error).toBe('teleport failed: socket closed');
    expect((await run(runtime, recorded, 'HYPERFY_USE_ITEM')).actionStatus).toBe('completed');
    await settleTimers();
    const release = await run(runtime, recorded, 'HYPERFY_UNUSE_ITEM');
    expect(release.actionStatus).toBe('failed');
    expect(release.actionResult.error).toBe('releasing failed: app script error');
  });

  it('records a failed navigation and an item it could not find as failed', async () => {
    const controls = { goto: vi.fn().mockRejectedValue(new Error('blocked')) };
    const world = { controls, actions: { performAction: vi.fn() }, entities: { items: new Map() } };
    const { runtime, recorded } = createRuntime({
      service: connectedService(world),
      models: {
        [ModelType.OBJECT_LARGE]: { navigationType: 'position', parameter: { position: { x: 5, z: -3 } } },
        [ModelType.OBJECT_SMALL]: { entityId: 'missing' },
      },
    });
    const goto = await run(runtime, recorded, 'HYPERFY_GOTO_ENTITY');
    expect(goto.actionStatus).toBe('failed');
    expect(goto.actionResult.error).toBe('navigation failed: blocked');
    expect((await run(runtime, recorded, 'HYPERFY_USE_ITEM')).actionStatus).toBe('failed');
  });

  it('records a scene edit as completed after running the planned operations', async () => {
    const buildManager = { translate: vi.fn().mockResolvedValue(undefined) };
    const messageManager = { sendMessage: vi.fn() };
    const world = { controls: {} };
    const { runtime, recorded } = createRuntime({
      service: connectedService(world, { getBuildManager: () => buildManager, getMessageManager: () => messageManager }),
      models: {
        [ModelType.OBJECT_LARGE]: {
          operations: [{ success: true, operation: 'translate', target: 'box', parameters: { position: [0, 2, 0] }, description: 'Moved the box up' }],
        },
        [ModelType.TEXT_SMALL]: '<response><thought>done</thought><text>Box is up!</text></response>',
      },
    });
    const stored = await run(runtime, recorded, 'HYPERFY_EDIT_ENTITY');
    expect(stored.actionStatus).toBe('completed');
    expect(stored.actionResult.data).toEqual({
      actionName: 'HYPERFY_EDIT_ENTITY',
      executed: 1,
      skipped: 0,
      failed: 0,
      outcomes: [{ operation: 'translate', target: 'box', outcome: 'executed' }],
    });
    expect(buildManager.translate).toHaveBeenCalledWith('box', [0, 2, 0]);
    expect(recorded.callbacks).toEqual([expect.objectContaining({ thought: 'done', text: 'Box is up!', emote: '' })]);
    expect(messageManager.sendMessage).toHaveBeenCalledWith('Moved the box up');
  });

  describe('scene edits whose plan did not fully run', () => {
    const summary = '<response><thought>t</thought><text>Summary</text></response>';
    const editService = (buildManager: Record<string, unknown>) =>
      connectedService({ controls: {} }, { getBuildManager: () => buildManager, getMessageManager: () => ({ sendMessage: vi.fn() }) });
    const refused = { success: false, operation: 'delete', requestedEntityName: 'stone throne', reason: 'not found' };
    const move = { success: true, operation: 'translate', target: 'box', parameters: { position: [0, 2, 0] }, description: 'Moved' };

    it('records a plan whose every operation was refused as failed, also when the summary cannot be written', async () => {
      // No TEXT_SMALL model: the summary call throws and the handler takes its summary-error branch
      const { runtime, recorded } = createRuntime({
        service: editService({ delete: vi.fn() }),
        models: { [ModelType.OBJECT_LARGE]: { operations: [refused] } },
      });
      const stored = await run(runtime, recorded, 'HYPERFY_EDIT_ENTITY');
      expect(stored.actionStatus).toBe('failed');
      expect(stored.actionResult.error).toBe('no operation was executed');
      expect(stored.actionResult.data).toMatchObject({ executed: 0, skipped: 1, failed: 0 });
      expect(recorded.callbacks).toHaveLength(1);
    });

    it('records an operation the manager threw on as failed', async () => {
      const { runtime, recorded } = createRuntime({
        service: editService({ translate: vi.fn().mockRejectedValue(new Error('locked')) }),
        models: { [ModelType.OBJECT_LARGE]: { operations: [move] }, [ModelType.TEXT_SMALL]: summary },
      });
      const stored = await run(runtime, recorded, 'HYPERFY_EDIT_ENTITY');
      expect(stored.actionStatus).toBe('failed');
      expect(stored.actionResult.error).toBe('1 of 1 operations failed');
      expect(stored.actionResult.data.outcomes).toEqual([{ operation: 'translate', target: 'box', outcome: 'failed', reason: 'locked' }]);
    });

    it('records a plan with a null entry as failed instead of throwing, and still answers', async () => {
      const { runtime, recorded } = createRuntime({
        service: editService({}),
        models: { [ModelType.OBJECT_LARGE]: { operations: [null] }, [ModelType.TEXT_SMALL]: summary },
      });
      const stored = await run(runtime, recorded, 'HYPERFY_EDIT_ENTITY');
      expect(stored.actionStatus).toBe('failed');
      expect(stored.actionResult.data).toMatchObject({ executed: 0, skipped: 0, failed: 1 });
      expect(recorded.callbacks).toEqual([expect.objectContaining({ text: 'Summary' })]);
    });

    it('records a partly refused plan as completed, with the counts', async () => {
      const translate = vi.fn().mockResolvedValue(undefined);
      const { runtime, recorded } = createRuntime({
        service: editService({ translate }),
        models: { [ModelType.OBJECT_LARGE]: { operations: [move, refused] }, [ModelType.TEXT_SMALL]: summary },
      });
      const stored = await run(runtime, recorded, 'HYPERFY_EDIT_ENTITY');
      expect(stored.actionStatus).toBe('completed');
      expect(stored.actionResult.data).toMatchObject({ executed: 1, skipped: 1, failed: 0 });
      expect(stored.actionResult.data.outcomes[1]).toEqual({ operation: 'delete', outcome: 'skipped', reason: 'not found' });
    });
  });

  it('records a scene edit with no usable plan from the model as failed', async () => {
    const world = { controls: {} };
    const { runtime, recorded } = createRuntime({
      service: connectedService(world, { getBuildManager: () => ({}), getMessageManager: () => ({}) }),
      models: { [ModelType.OBJECT_LARGE]: { nothing: true } },
    });
    const stored = await run(runtime, recorded, 'HYPERFY_EDIT_ENTITY');
    expect(stored.actionStatus).toBe('failed');
    expect(stored.actionResult.error).toBe('no edit plan from the model');
  });

  it('records the OpenPay share action as failed on an autonomous turn', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(() => {}));
    const shop = createOpenPayStorePlugin({ OPENPAY_STORE_HANDLES: 'someone' })!;
    const { runtime, recorded } = createRuntime();
    runtime.registerAction(shop.actions![0]);
    const stored = await run(runtime, recorded, SHARE_ACTION, { message: { entityId: runtime.agentId, content: { text: '' } } });
    expect(stored.actionStatus).toBe('failed');
    expect(stored.actionResult).toMatchObject({ success: false, data: { actionName: SHARE_ACTION } });
  });
});
