import { ModelType, type Action } from '@elizaos/core';
import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SHARE_ACTION, createOpenPayStorePlugin } from '../../openpay-store';
import { hyperfyPlugin } from '../index';
import { AgentActions } from '../systems/actions';
import { AgentControls } from '../systems/controls';
import { connectedService, createRuntime, run, runPlan } from '../test-support/core-runtime';
import { inAutonomousTurn, inChatTurn, worldWithBuilder } from '../test-support/turns';

/*
 * Drives real elizaOS core processActions (1.7.2) with the plugin's real actions and records the
 * action memory core stores for each one: content.actionStatus is what later turns see.
 */

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
  // As the engine's action nodes are: they know their entity, which has a place in the world
  const node = { ctx: { entity: world.entities.items.get(entityId) }, _duration: 0, _onTrigger: vi.fn(), ...extra };
  world.actions.register(node);
  return node;
};

const settleTimers = () => new Promise((resolve) => setTimeout(resolve, 10));

// Scene edits for builders switched on (they are off by default)
beforeEach(() => vi.stubEnv('HYPERFY_SCENE_EDITS', 'builders'));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

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
  // Scene edits run in a chat turn from player-1, a builder in a coo-world (see lib/authorization.ts)
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
    // A builder's chat turn, so the scene edit gets as far as looking for the service
    const stored = await inChatTurn(worldWithBuilder(), () => run(runtime, recorded, actionName));
    expect(stored.actionStatus).toBe('failed');
    expect(stored.actionResult).toMatchObject({ success: false, data: { actionName } });
    expect(typeof stored.actionResult.error).toBe('string');
  });

  it('records movement and item actions as completed when the real systems carry them out', async () => {
    const world = createWorld();
    addPlayer(world, 'player-1');
    const node = addActionNode(world, 'crate');
    const goto = vi.spyOn(world.controls, 'goto').mockResolvedValue('arrived');
    vi.spyOn(world.controls, 'startRandomWalk').mockResolvedValue(undefined);
    const service = connectedService(world);
    const { runtime, recorded } = createRuntime({
      service,
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
    // Each walk is handed the signal it stops with (outside a turn: the session's)
    const signal = service.session.signal;
    expect(goto).toHaveBeenCalledWith(5, -3, { signal });
    expect(goto).toHaveBeenCalledWith(1, 2, { signal });
    expect(recorded.callbacks.map((c) => c.text)).toEqual(expect.arrayContaining(['Teleporting to you!', 'Using item: crate', 'Item released.']));
  });

  describe('teleport, use and release when the real systems do nothing', () => {
    // The sender left and nobody else is in the world; the crate has no action node; nothing is held
    function setup() {
      const world = createWorld();
      vi.spyOn(world.controls, 'goto').mockResolvedValue('arrived');
      const { runtime, recorded } = createRuntime({
        service: connectedService(world),
        models: { [ModelType.OBJECT_SMALL]: { entityId: 'crate' } },
      });
      return { world, runtime, recorded };
    }

    it('records them as failed and tells the requester why', async () => {
      const { world, runtime, recorded } = setup();
      const teleport = await inChatTurn(world, () => run(runtime, recorded, 'HYPERFY_TELEPORT_TO_USER'));
      expect(teleport.actionStatus).toBe('failed');
      expect(teleport.actionResult.error).toBe('no player to teleport to');
      expect(world.entities.player.teleport).not.toHaveBeenCalled();

      const use = await inChatTurn(world, () => run(runtime, recorded, 'HYPERFY_USE_ITEM'));
      expect(use.actionStatus).toBe('failed');
      expect(use.actionResult.data).toMatchObject({ targetEntityId: 'crate', outcome: 'no-action-nodes' });

      world.entities.items.set('lamp', { data: { id: 'lamp' }, root: { position: new THREE.Vector3(2, 0, 2) } });
      addActionNode(world, 'lamp');
      const otherNode = await inChatTurn(world, () => run(runtime, recorded, 'HYPERFY_USE_ITEM'));
      expect(otherNode.actionResult.data).toMatchObject({ outcome: 'entity-has-no-action-node' });

      const release = await inChatTurn(world, () => run(runtime, recorded, 'HYPERFY_UNUSE_ITEM'));
      expect(release.actionStatus).toBe('failed');
      expect(release.actionResult.error).toBe('not holding or using anything');
      expect(recorded.callbacks.map((c) => c.text)).toEqual([
        "I couldn't find anyone to teleport to.",
        "There's nothing near me I can use.",
        "I can't use that one.",
        "I'm not holding or using anything.",
      ]);
    });

    it('records them as failed and posts nothing on an autonomous turn (nobody asked)', async () => {
      const { world, runtime, recorded } = setup();
      const errors = [];
      for (const name of ['HYPERFY_TELEPORT_TO_USER', 'HYPERFY_USE_ITEM', 'HYPERFY_UNUSE_ITEM']) {
        const stored = await inAutonomousTurn(world, () => run(runtime, recorded, name));
        expect(stored.actionStatus, name).toBe('failed');
        errors.push(stored.actionResult.error);
      }
      // The handlers ran (these actions are allowed on autonomous turns) and failed for their own reasons
      expect(errors).toEqual(['no player to teleport to', 'nothing was used (no-action-nodes)', 'not holding or using anything']);
      expect(recorded.callbacks).toEqual([]);
    });
  });

  it('turns a walk that has no player to walk with into a failed result that says so, uses nothing, and still runs the next planned action', async () => {
    // Real AgentControls during teardown: the player entity is gone, so the walk is 'unreachable'
    const world = createWorld({ withPlayer: false });
    const { runtime, recorded } = createRuntime({
      service: connectedService(world),
      models: { [ModelType.OBJECT_SMALL]: { entityId: 'crate' } },
    });
    const [use, ignore] = await runPlan(runtime, recorded, ['HYPERFY_USE_ITEM', 'IGNORE']);
    expect(use.actionStatus).toBe('failed');
    expect(use.actionResult.error).toBe('did not get to the item (unreachable)');
    expect(ignore.actionStatus).toBe('completed');
    expect(recorded.callbacks[0]).toMatchObject({ text: "I can't find where to go.", actions: ['HYPERFY_USE_ITEM'] });
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
    vi.spyOn(world.controls, 'goto').mockResolvedValue('arrived');
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
    expect(recorded.callbacks.map((c) => c.text)).toEqual(["I couldn't teleport just now.", 'Using item: crate', "I couldn't let go of it."]);
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

  describe('a walk that did not arrive is reported as it ended', () => {
    const NOT_ARRIVED = [
      ['stopped', 'I stopped before I got there.'],
      ['replaced', 'I headed somewhere else before I got there.'],
      ['timed-out', "I couldn't get there in time."],
      ['unreachable', "I can't find where to go."],
    ] as const;

    it.each(NOT_ARRIVED)('HYPERFY_GOTO_ENTITY whose walk ended as %s is failed and says so, never "Arrived" or "Reached"', async (outcome, said) => {
      for (const [target, walk] of [
        [{ navigationType: 'entity', parameter: { entityId: 'crate' } }, 'followEntity'],
        [{ navigationType: 'position', parameter: { position: { x: 5, z: -3 } } }, 'goto'],
      ] as const) {
        const world = createWorld();
        vi.spyOn(world.controls, walk).mockResolvedValue(outcome);
        const { runtime, recorded } = createRuntime({ service: connectedService(world), models: { [ModelType.OBJECT_LARGE]: target } });
        const stored = await run(runtime, recorded, 'HYPERFY_GOTO_ENTITY');
        expect(stored.actionStatus).toBe('failed');
        expect(stored.actionResult).toMatchObject({ success: false, error: `did not arrive (${outcome})`, data: { outcome } });
        expect(recorded.callbacks.map((c) => c.text)).toEqual([said]);
      }
    });

    it('HYPERFY_GOTO_ENTITY says it arrived when the walk did', async () => {
      const world = createWorld();
      vi.spyOn(world.controls, 'followEntity').mockResolvedValue('arrived');
      const { runtime, recorded } = createRuntime({ service: connectedService(world), models: { [ModelType.OBJECT_LARGE]: { navigationType: 'entity', parameter: { entityId: 'crate' } } } });
      expect((await run(runtime, recorded, 'HYPERFY_GOTO_ENTITY')).actionStatus).toBe('completed');
      expect(recorded.callbacks.map((c) => c.text)).toEqual(['Arrived at entity crate.']);
    });

    it.each(NOT_ARRIVED)('HYPERFY_USE_ITEM whose walk ended as %s uses nothing and says so', async (outcome, said) => {
      const world = createWorld();
      const node = addActionNode(world, 'crate');
      vi.spyOn(world.controls, 'goto').mockResolvedValue(outcome);
      const perform = vi.spyOn(world.actions, 'performAction');
      const { runtime, recorded } = createRuntime({ service: connectedService(world), models: { [ModelType.OBJECT_SMALL]: { entityId: 'crate' } } });
      const stored = await run(runtime, recorded, 'HYPERFY_USE_ITEM');
      await settleTimers();
      expect(stored.actionStatus).toBe('failed');
      expect(stored.actionResult).toMatchObject({ error: `did not get to the item (${outcome})`, data: { outcome } });
      expect(perform).not.toHaveBeenCalled();
      expect(node._onTrigger).not.toHaveBeenCalled();
      expect(world.controls.keyE.down).toBe(false);
      expect(recorded.callbacks.map((c) => c.text)).toEqual([said]);
    });

    it('HYPERFY_GOTO_ENTITY walks to a position only for finite numbers, brought back to what the world takes as one', async () => {
      const world = createWorld();
      const goto = vi.spyOn(world.controls, 'goto').mockResolvedValue('arrived');
      for (const position of [{ x: '5', z: 1 }, { x: Number.NaN, z: 1 }, { x: 1, z: Number.POSITIVE_INFINITY }, { x: 1 }]) {
        const { runtime, recorded } = createRuntime({ service: connectedService(world), models: { [ModelType.OBJECT_LARGE]: { navigationType: 'position', parameter: { position } } } });
        const stored = await run(runtime, recorded, 'HYPERFY_GOTO_ENTITY');
        expect(stored.actionStatus).toBe('failed');
        expect(stored.actionResult.error).toBe('navigation failed: Invalid position coordinates.');
      }
      expect(goto).not.toHaveBeenCalled();
      const { runtime, recorded } = createRuntime({ service: connectedService(world), models: { [ModelType.OBJECT_LARGE]: { navigationType: 'position', parameter: { position: { x: 4e9, z: -4e9 } } } } });
      expect((await run(runtime, recorded, 'HYPERFY_GOTO_ENTITY')).actionStatus).toBe('completed');
      expect(goto).toHaveBeenCalledWith(1e6, -1e6, expect.anything());
      expect(recorded.callbacks.map((c) => c.text)).toEqual(['Reached position (1000000, -1000000).']);
    });
  });

  it('walk, use and stop take nothing from handler options (core passes only its own bookkeeping there)', async () => {
    const world = createWorld();
    addActionNode(world, 'crate');
    world.entities.items.set('other', { data: { id: 'other' }, root: { position: new THREE.Vector3(9, 0, 9) } });
    const wander = vi.spyOn(world.controls, 'startRandomWalk').mockResolvedValue(undefined);
    const stopWander = vi.spyOn(world.controls, 'stopRandomWalk');
    const goto = vi.spyOn(world.controls, 'goto').mockResolvedValue('arrived');
    const stop = vi.spyOn(world.controls, 'stopAllActions');
    const { runtime, useModel } = createRuntime({ service: connectedService(world), models: { [ModelType.OBJECT_SMALL]: { entityId: 'crate' } } });
    const handler = (name: string) => hyperfyPlugin.actions!.find((action) => action.name === name)!.handler;
    const said: any[] = [];
    const callback = async (content: any) => (said.push(content), []);
    const message = { id: crypto.randomUUID(), entityId: crypto.randomUUID(), roomId: crypto.randomUUID(), content: { text: 'x' } } as never;
    const state = { values: {}, data: {}, text: '' };

    // What only a direct caller could pass; none of it changes what the action does
    await handler('HYPERFY_WALK_RANDOMLY')(runtime, message, state, { command: 'stop', interval: 1, distance: 2 } as never, callback);
    expect(stopWander).not.toHaveBeenCalled();
    expect(wander).toHaveBeenCalledWith(4000, 30, undefined, expect.anything());

    await handler('HYPERFY_USE_ITEM')(runtime, message, state, { entityId: 'other' } as never, callback);
    expect(useModel).toHaveBeenCalledTimes(1);
    expect(goto).toHaveBeenCalledWith(1, 2, expect.anything());

    await handler('HYPERFY_STOP_MOVING')(runtime, message, state, { reason: 'because a caller said so' } as never, callback);
    expect(stop).toHaveBeenCalledWith('stop action called');
    expect(JSON.stringify(said)).not.toContain('because a caller said so');
  });

  it('records a scene edit as completed after running the planned operations', async () => {
    const buildManager = { translate: vi.fn().mockResolvedValue({ outcome: 'applied' }) };
    const messageManager = { sendMessage: vi.fn() };
    const world = worldWithBuilder({ controls: {} });
    const { runtime, recorded } = createRuntime({
      service: connectedService(world, { build: buildManager, messages: messageManager }),
      models: {
        [ModelType.OBJECT_LARGE]: {
          operations: [{ success: true, operation: 'translate', target: 'box', parameters: { position: [0, 2, 0] }, description: 'Moved the box up' }],
        },
        [ModelType.TEXT_SMALL]: '<response><thought>done</thought><text>Box is up!</text></response>',
      },
    });
    const stored = await inChatTurn(world, () => run(runtime, recorded, 'HYPERFY_EDIT_ENTITY'));
    expect(stored.actionStatus).toBe('completed');
    expect(stored.actionResult.data).toEqual({
      actionName: 'HYPERFY_EDIT_ENTITY',
      executed: 1,
      skipped: 0,
      failed: 0,
      outcomes: [{ operation: 'translate', target: 'box', outcome: 'executed' }],
    });
    expect(buildManager.translate).toHaveBeenCalledWith(expect.objectContaining({ world }), 'box', [0, 2, 0]);
    expect(recorded.callbacks).toEqual([expect.objectContaining({ thought: 'done', text: 'Box is up!', emote: '' })]);
    expect(messageManager.sendMessage).toHaveBeenCalledWith('Moved the box up');
  });

  describe('scene edits whose plan did not fully run', () => {
    const summary = '<response><thought>t</thought><text>Summary</text></response>';
    const world = worldWithBuilder({ controls: {} });
    const editService = (buildManager: Record<string, unknown>) =>
      connectedService(world, { build: buildManager, messages: ({ sendMessage: vi.fn() }) });
    const refused = { success: false, operation: 'delete', requestedEntityName: 'stone throne', reason: 'not found' };
    const move = { success: true, operation: 'translate', target: 'box', parameters: { position: [0, 2, 0] }, description: 'Moved' };

    it('records a plan whose every operation was refused as failed, also when the summary cannot be written', async () => {
      // No TEXT_SMALL model: the summary call throws and the handler takes its summary-error branch
      const { runtime, recorded } = createRuntime({
        service: editService({ delete: vi.fn() }),
        models: { [ModelType.OBJECT_LARGE]: { operations: [refused] } },
      });
      const stored = await inChatTurn(world, () => run(runtime, recorded, 'HYPERFY_EDIT_ENTITY'));
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
      const stored = await inChatTurn(world, () => run(runtime, recorded, 'HYPERFY_EDIT_ENTITY'));
      expect(stored.actionStatus).toBe('failed');
      expect(stored.actionResult.error).toBe('1 of 1 operations failed');
      expect(stored.actionResult.data.outcomes).toEqual([{ operation: 'translate', target: 'box', outcome: 'failed', reason: 'locked' }]);
    });

    it('records a plan with a null entry as failed instead of throwing, and still answers', async () => {
      const { runtime, recorded } = createRuntime({
        service: editService({}),
        models: { [ModelType.OBJECT_LARGE]: { operations: [null] }, [ModelType.TEXT_SMALL]: summary },
      });
      const stored = await inChatTurn(world, () => run(runtime, recorded, 'HYPERFY_EDIT_ENTITY'));
      expect(stored.actionStatus).toBe('failed');
      expect(stored.actionResult.data).toMatchObject({ executed: 0, skipped: 0, failed: 1 });
      expect(recorded.callbacks).toEqual([expect.objectContaining({ text: 'Summary' })]);
    });

    it('records a partly refused plan as completed, with the counts', async () => {
      const translate = vi.fn().mockResolvedValue({ outcome: 'applied' });
      const { runtime, recorded } = createRuntime({
        service: editService({ translate }),
        models: { [ModelType.OBJECT_LARGE]: { operations: [move, refused] }, [ModelType.TEXT_SMALL]: summary },
      });
      const stored = await inChatTurn(world, () => run(runtime, recorded, 'HYPERFY_EDIT_ENTITY'));
      expect(stored.actionStatus).toBe('completed');
      expect(stored.actionResult.data).toMatchObject({ executed: 1, skipped: 1, failed: 0 });
      expect(stored.actionResult.data.outcomes[1]).toEqual({ operation: 'delete', outcome: 'skipped', reason: 'not found' });
    });
  });

  describe('what a scene-edit plan may make the agent do', () => {
    const summary = '<response><thought>t</thought><text>Summary</text></response>';
    const applied = { outcome: 'applied' };
    /** Runs the edit action over `operations` with a recording build manager; `summaryPrompts` are what the summary model was asked */
    async function edit(operations: unknown[], manager: Record<string, ReturnType<typeof vi.fn>> = {}) {
      const build: Record<string, ReturnType<typeof vi.fn>> = {};
      for (const name of ['translate', 'rotate', 'scale', 'duplicate', 'delete', 'importEntity']) build[name] = manager[name] ?? vi.fn().mockResolvedValue(applied);
      const world = worldWithBuilder({ controls: {} });
      const summaryPrompts: string[] = [];
      const { runtime, recorded } = createRuntime({
        service: connectedService(world, { build, messages: { sendMessage: vi.fn() } }),
        models: {
          [ModelType.OBJECT_LARGE]: { operations },
          [ModelType.TEXT_SMALL]: (params: any) => (summaryPrompts.push(params.prompt), summary),
        },
      });
      const stored = await inChatTurn(world, () => run(runtime, recorded, 'HYPERFY_EDIT_ENTITY'));
      const calls = Object.fromEntries(Object.entries(build).map(([name, fn]) => [name, fn.mock.calls.map((args) => args.slice(1))]));
      return { stored, calls, summaryPrompts, data: stored.actionResult.data as { executed: number; skipped: number; failed: number; outcomes: any[] } };
    }
    const move = (target: string, extra: Record<string, unknown> = {}) => ({ operation: 'translate', target, parameters: { position: [0, 2, 0] }, ...extra });

    it("runs an operation by its shape, whatever the plan says of its own success: no flag, true, or something that is not a boolean", async () => {
      const { calls, data } = await edit([move('a'), move('b', { success: true }), move('c', { success: 'no' }), move('d', { success: 0 }), move('e', { success: null })]);
      expect(calls.translate.map(([target]) => target)).toEqual(['a', 'b', 'c', 'd', 'e']);
      expect(data).toMatchObject({ executed: 5, skipped: 0, failed: 0 });
    });

    it('runs nothing for an entry that claims success but is not an operation in shape, and says which and why', async () => {
      const { calls, data } = await edit([
        { success: true, operation: 'translate', target: 'box' },
        { success: true, operation: 'translate', target: 'box', parameters: { position: ['0', '2', '0'] } },
        { success: true, operation: 'delete', target: { id: 'box' } },
        { success: true, operation: 'explode', target: 'box' },
        { success: true, operation: 'import', target: 'https://cdn.example.com/a.glb', parameters: { position: 'origin' } },
        'delete box',
      ]);
      expect(Object.values(calls).flat()).toEqual([]);
      expect(data).toMatchObject({ executed: 0, skipped: 0, failed: 6 });
      expect(data.outcomes.map((o) => o.reason)).toEqual([
        'invalid operation (parameters: Invalid input: expected object, received undefined)',
        'invalid operation (parameters.position.0: Invalid input: expected number, received string)',
        'invalid operation (target: Invalid input: expected string, received object)',
        'unsupported operation type',
        expect.stringMatching(/^invalid operation \(parameters\.position: /),
        'not an operation object',
      ]);
    });

    it("never runs an entry the plan itself declined, however complete the entry is", async () => {
      const { calls, data } = await edit([move('box', { success: false, reason: 'the owner said to leave it' })]);
      expect(calls.translate).toEqual([]);
      expect(data.outcomes).toEqual([{ operation: 'translate', target: 'box', outcome: 'skipped', reason: 'the owner said to leave it' }]);
    });

    it('hands the build manager exactly what the operation takes: its target and its own parameters', async () => {
      const { calls } = await edit([
        move('a', { parameters: { position: [1, 2, 3], rotation: [0, 0, 0, 1], extra: true }, speed: 9 }),
        { operation: 'rotate', target: 'b', parameters: { rotation: [0, 0, 0, 1] } },
        { operation: 'scale', target: 'c', parameters: { scale: [2, 2, 2] } },
        { operation: 'delete', target: 'd', parameters: { force: true } },
        { operation: 'import', target: 'https://cdn.example.com/a.glb' },
        { operation: 'import', target: 'https://cdn.example.com/b.glb', parameters: { position: [1, 0, 1], rotation: null } },
      ]);
      expect(calls.translate).toEqual([['a', [1, 2, 3]]]);
      expect(calls.rotate).toEqual([['b', [0, 0, 0, 1]]]);
      expect(calls.scale).toEqual([['c', [2, 2, 2]]]);
      expect(calls.delete).toEqual([['d']]);
      expect(calls.importEntity).toEqual([
        ['https://cdn.example.com/a.glb', undefined, undefined],
        ['https://cdn.example.com/b.glb', [1, 0, 1], undefined],
      ]);
    });

    it('runs at most 20 operations of one request and reports the rest as not run; entries that are no operations do not count', async () => {
      const operations = [{ success: false, operation: 'delete', reason: 'kept' }, null, ...Array.from({ length: 25 }, (_, i) => move(`box${i}`))];
      const { calls, data } = await edit(operations);
      expect(calls.translate.map(([target]) => target)).toEqual(Array.from({ length: 20 }, (_, i) => `box${i}`));
      expect(data).toMatchObject({ executed: 20, skipped: 1, failed: 6 });
      expect(data.outcomes.slice(-5)).toEqual(Array.from({ length: 5 }, (_, i) => ({ operation: 'translate', target: `box${20 + i}`, outcome: 'failed', reason: 'not run: one request runs at most 20 operations' })));
    });

    it('counts an operation that was tried and not done toward the 20 as well', async () => {
      const translate = vi.fn().mockResolvedValue({ outcome: 'skipped', reason: 'target not found' });
      const { calls } = await edit(Array.from({ length: 30 }, (_, i) => move(`box${i}`)), { translate });
      expect(calls.translate).toHaveLength(20);
    });

    it('lets a later entry act on the copy an earlier entry made, by the label the plan gave it; the duplicate reports the new id', async () => {
      const duplicate = vi.fn().mockResolvedValueOnce({ outcome: 'applied', newId: 'copy-of-block' }).mockResolvedValueOnce({ outcome: 'applied', newId: 'second-copy' });
      const { calls, data, summaryPrompts } = await edit(
        [
          { success: true, operation: 'duplicate', target: 'block', as: 'copy1', description: 'Duplicated the block' },
          { success: true, operation: 'translate', targetRef: 'copy1', parameters: { position: [0, 3, 0] }, description: 'Put the copy on top of the water' },
          { success: true, operation: 'duplicate', target: 'block', description: 'Another one' },
          { success: true, operation: 'delete', targetRef: 'copy1', description: 'Removed the first copy again' },
        ],
        { duplicate }
      );
      expect(calls.duplicate).toEqual([['block'], ['block']]);
      // The copy, not the original
      expect(calls.translate).toEqual([['copy-of-block', [0, 3, 0]]]);
      expect(calls.delete).toEqual([['copy-of-block']]);
      expect(data.outcomes).toEqual([
        { operation: 'duplicate', target: 'block', outcome: 'executed', newId: 'copy-of-block' },
        { operation: 'translate', target: 'copy-of-block', outcome: 'executed' },
        { operation: 'duplicate', target: 'block', outcome: 'executed', newId: 'second-copy' },
        { operation: 'delete', target: 'copy-of-block', outcome: 'executed' },
      ]);
      expect(summaryPrompts[0]).toContain('DONE: Duplicated the block (the copy is entity copy-of-block)');
    });

    it('does not guess at a copy: a reference to one that was not made fails, and nothing is done to the original', async () => {
      const duplicate = vi.fn().mockResolvedValue({ outcome: 'skipped', reason: "it is the world's scene" });
      const { calls, data } = await edit(
        [
          { operation: 'translate', targetRef: 'copy1', parameters: { position: [0, 3, 0] } },
          { operation: 'duplicate', target: 'scene-app', as: 'copy1' },
          { operation: 'translate', targetRef: 'copy1', parameters: { position: [0, 3, 0] } },
          { operation: 'delete', targetRef: 'copy2' },
        ],
        { duplicate }
      );
      expect(calls.translate).toEqual([]);
      expect(calls.delete).toEqual([]);
      expect(data.outcomes.map((o) => [o.operation, o.target, o.outcome, o.reason])).toEqual([
        ['translate', 'copy1', 'failed', 'no copy named "copy1" was made earlier in this request'],
        ['duplicate', 'scene-app', 'skipped', "it is the world's scene"],
        ['translate', 'copy1', 'failed', 'no copy named "copy1" was made earlier in this request'],
        ['delete', 'copy2', 'failed', 'no copy named "copy2" was made earlier in this request'],
      ]);
    });
  });

  it('records a scene edit with no usable plan from the model as failed', async () => {
    const world = worldWithBuilder({ controls: {} });
    const { runtime, recorded } = createRuntime({
      service: connectedService(world, { build: ({}), messages: ({}) }),
      models: { [ModelType.OBJECT_LARGE]: { nothing: true } },
    });
    const stored = await inChatTurn(world, () => run(runtime, recorded, 'HYPERFY_EDIT_ENTITY'));
    expect(stored.actionStatus).toBe('failed');
    expect(stored.actionResult.error).toBe('no edit plan from the model');
  });

  it('refuses the OpenPay share action on an autonomous turn, even for a message its own check would let through', async () => {
    // The Store's listings API never answers here (and the real one is never asked)
    const shop = createOpenPayStorePlugin({ OPENPAY_STORE_HANDLES: 'someone' }, { fetchImpl: (() => new Promise(() => {})) as typeof fetch })!;
    const { runtime, recorded } = createRuntime();
    runtime.registerAction(shop.actions![0]);
    // A player's message with text: the action's own isAutonomous() check would not refuse it
    const stored = await inAutonomousTurn(worldWithBuilder(), () =>
      run(runtime, recorded, SHARE_ACTION, { message: { content: { text: 'a link to the hoverboard please', source: 'hyperfy' } } })
    );
    expect(stored.actionStatus).toBe('failed');
    expect(stored.actionResult).toMatchObject({ success: false, error: `${SHARE_ACTION} is not allowed on an autonomous turn` });
    expect(recorded.callbacks).toEqual([]);
  });

  it('still refuses the OpenPay share action for a self-sent, empty message outside any turn (its own check)', async () => {
    // The Store's listings API never answers here (and the real one is never asked)
    const shop = createOpenPayStorePlugin({ OPENPAY_STORE_HANDLES: 'someone' }, { fetchImpl: (() => new Promise(() => {})) as typeof fetch })!;
    const { runtime, recorded } = createRuntime();
    runtime.registerAction(shop.actions![0]);
    const stored = await run(runtime, recorded, SHARE_ACTION, { message: { entityId: runtime.agentId, content: { text: '' } } });
    expect(stored.actionResult).toMatchObject({ success: false, error: 'links are only shared in a conversation' });
  });
});
