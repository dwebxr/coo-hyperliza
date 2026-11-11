import { ModelType, logger } from '@elizaos/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { hyperfyPlugin } from '../index';
import { SHARE_ACTION, createOpenPayStorePlugin } from '../../openpay-store';
import { AUTONOMY_ACTIONS, guardActions } from '../lib/authorization';
import { actionSucceeded } from '../lib/action-result';
import { TurnCancelled } from '../lib/turn-context';
import { AiBudgetExceededError } from '../../usage-budget';
import { AnthropicRefusalError } from '../../anthropic-models';
import { hyperfyEditEntityAction } from './build';
import { connectedService, createRuntime, run, runPlan } from '../test-support/core-runtime';
import { sessionFor, withParts } from '../test-support/session';
import { cooWorldSnapshot, upstreamSnapshot } from '../test-support/world-packets';
import { inAutonomousTurn, inChatTurn, inTurn, worldFromSnapshot } from '../test-support/turns';

/*
 * Authorization through real elizaOS core processActions (1.7.2), which never calls validate() and
 * resolves emitted names by exact, then substring, then simile match ("" matches the first action).
 */

const plan = [{ success: true, operation: 'translate', target: 'box', parameters: { position: [0, 2, 0] }, description: 'Moved the box up' }];
const summary = '<response><thought>t</thought><text>Box is up!</text></response>';

function coo() {
  return worldFromSnapshot(
    cooWorldSnapshot({
      players: [
        { id: 'builder-1', name: 'Bob', rank: 1 },
        { id: 'visitor-1', name: 'Vera', rank: 0 },
      ],
    }),
    { controls: {} }
  );
}

function editSetup(world: Record<string, unknown> = coo(), models: Record<string, unknown> = { [ModelType.OBJECT_LARGE]: { operations: plan }, [ModelType.TEXT_SMALL]: summary }) {
  const buildManager = { translate: vi.fn().mockResolvedValue({ outcome: 'applied' }), delete: vi.fn(), importEntity: vi.fn() };
  const sendMessage = vi.fn();
  const { runtime, recorded, useModel } = createRuntime({
    service: connectedService(world, { build: buildManager, messages: { sendMessage } }),
    models,
  });
  return { world, buildManager, sendMessage, runtime, recorded, useModel };
}

// Scene edits for builders switched on (they are off by default; see "with scene edits off")
beforeEach(() => vi.stubEnv('HYPERFY_SCENE_EDITS', 'builders'));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('HYPERFY_EDIT_ENTITY', () => {
  it('runs for a builder, by its name, a substring of it, or a simile', async () => {
    for (const [emitted, resolved] of [
      ['HYPERFY_EDIT_ENTITY', 'HYPERFY_EDIT_ENTITY'],
      ['EDIT', 'HYPERFY_EDIT_ENTITY'],
      ['MODIFY_SCENE', 'HYPERFY_EDIT_ENTITY'],
    ]) {
      const { world, buildManager, runtime, recorded } = editSetup();
      const [stored] = await inChatTurn(world, () => runPlan(runtime, recorded, [emitted], { resolvedNames: [resolved] }), 'builder-1');
      expect(stored.actionStatus, emitted).toBe('completed');
      expect(buildManager.translate, emitted).toHaveBeenCalledWith(expect.objectContaining({ world }), 'box', [0, 2, 0]);
    }
  });

  it("does nothing and makes no model call for a visitor's request, and tells them so", async () => {
    const { world, buildManager, sendMessage, runtime, recorded, useModel } = editSetup();
    const stored = await inChatTurn(world, () => run(runtime, recorded, 'HYPERFY_EDIT_ENTITY'), 'visitor-1');
    expect(stored.actionStatus).toBe('failed');
    expect(stored.actionResult.error).toBe('the requester is not a builder in this world');
    expect(useModel).not.toHaveBeenCalled();
    for (const op of Object.values(buildManager)) expect(op).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(recorded.callbacks).toEqual([
      expect.objectContaining({ text: 'Sorry, I can only change things in this world when a builder asks me to.', actions: ['HYPERFY_EDIT_ENTITY'] }),
    ]);
  });

  it('answers a refusal in Japanese to a Japanese request, by voice too', async () => {
    const { world, runtime, recorded } = editSetup();
    await inTurn({ origin: 'voice', world, requesterId: 'visitor-1' }, () =>
      run(runtime, recorded, 'HYPERFY_EDIT_ENTITY', { message: { content: { text: '箱を動かして', source: 'hyperfy' } } })
    );
    expect(recorded.callbacks[0].text).toMatch(/^ごめんなさい/);
  });

  it('on an upstream world, runs only for HYPERFY_OPERATOR_IDS', async () => {
    const upstream = () => worldFromSnapshot(upstreamSnapshot({ players: [{ id: 'p-admin', name: 'Root', roles: ['admin'] }] }), { controls: {} });
    const refused = editSetup(upstream());
    expect((await inChatTurn(refused.world, () => run(refused.runtime, refused.recorded, 'HYPERFY_EDIT_ENTITY'), 'p-admin')).actionStatus).toBe('failed');
    expect(refused.useModel).not.toHaveBeenCalled();

    vi.stubEnv('HYPERFY_OPERATOR_IDS', 'p-admin');
    const listed = editSetup(upstream());
    expect((await inChatTurn(listed.world, () => run(listed.runtime, listed.recorded, 'HYPERFY_EDIT_ENTITY'), 'p-admin')).actionStatus).toBe('completed');
    expect(listed.buildManager.translate).toHaveBeenCalled();
  });

  it('stops at the first budget error or model refusal, which propagate out of processActions', async () => {
    for (const error of [new AiBudgetExceededError('AI_MAX_CALLS_PER_HOUR=1'), new AnthropicRefusalError('m', 'cyber')]) {
      const { world, buildManager, runtime, recorded, useModel } = editSetup(coo(), {
        [ModelType.OBJECT_LARGE]: () => {
          throw error;
        },
      });
      await expect(inChatTurn(world, () => run(runtime, recorded, 'HYPERFY_EDIT_ENTITY'), 'builder-1')).rejects.toBe(error);
      // Not retried (MAX_RETRIES is 3 for other errors)
      expect(useModel).toHaveBeenCalledTimes(1);
      expect(buildManager.translate).not.toHaveBeenCalled();
    }
  });

  it('still retries other model errors', async () => {
    let calls = 0;
    const { world, buildManager, runtime, recorded } = editSetup(coo(), {
      [ModelType.OBJECT_LARGE]: () => {
        if (++calls === 1) throw new Error('Model did not return valid JSON');
        return { operations: plan };
      },
      [ModelType.TEXT_SMALL]: summary,
    });
    expect((await inChatTurn(world, () => run(runtime, recorded, 'HYPERFY_EDIT_ENTITY'), 'builder-1')).actionStatus).toBe('completed');
    expect(calls).toBe(2);
    expect(buildManager.translate).toHaveBeenCalledTimes(1);
  });
});

describe('the action allow-list on autonomous turns', () => {
  it.each([
    ['HYPERFY_EDIT_ENTITY', 'HYPERFY_EDIT_ENTITY'],
    ['EDIT', 'HYPERFY_EDIT_ENTITY'],
    ['MODIFY_SCENE', 'HYPERFY_EDIT_ENTITY'],
    ['BUILD_STRUCTURE', 'HYPERFY_EDIT_ENTITY'],
  ])('runs nothing for %s, whatever core resolves it to', async (emitted, resolved) => {
    const { world, buildManager, runtime, recorded, useModel } = editSetup();
    const [stored] = await inAutonomousTurn(world, () => runPlan(runtime, recorded, [emitted], { resolvedNames: [resolved] }));
    expect(stored.actionStatus).toBe('failed');
    // The wrapper's refusal: build.ts's own check (which also refuses autonomy) never ran
    expect(stored.actionResult.error).toBe('HYPERFY_EDIT_ENTITY is not allowed on an autonomous turn');
    expect(useModel).not.toHaveBeenCalled();
    expect(buildManager.translate).not.toHaveBeenCalled();
    expect(recorded.callbacks).toEqual([]);
  });

  it('runs nothing for an empty name, which core resolves to the first registered action', async () => {
    const edit = hyperfyPlugin.actions!.find((a) => a.name === 'HYPERFY_EDIT_ENTITY')!;
    // As if the scene edit were the first action registered
    const { world, buildManager, runtime, recorded, useModel } = editSetup();
    runtime.actions.splice(0, runtime.actions.length, edit, ...hyperfyPlugin.actions!.filter((a) => a !== edit));
    const [stored] = await inAutonomousTurn(world, () => runPlan(runtime, recorded, [''], { resolvedNames: ['HYPERFY_EDIT_ENTITY'] }));
    expect(stored.actionResult.error).toBe('HYPERFY_EDIT_ENTITY is not allowed on an autonomous turn');
    expect(useModel).not.toHaveBeenCalled();
    expect(buildManager.translate).not.toHaveBeenCalled();

    // With the plugin's own order, "" is the scene perception action, which is not allowed either
    const plain = editSetup();
    const [first] = await inAutonomousTurn(plain.world, () => runPlan(plain.runtime, plain.recorded, [''], { resolvedNames: ['HYPERFY_SCENE_PERCEPTION'] }));
    expect(first.actionResult.error).toBe('HYPERFY_SCENE_PERCEPTION is not allowed on an autonomous turn');
    expect(plain.useModel).not.toHaveBeenCalled();
  });

  it('refuses every registered action outside the autonomy list, and lets the listed ones run', async () => {
    // The Store's listings API never answers here (and the real one is never asked)
    const shop = createOpenPayStorePlugin({ OPENPAY_STORE_HANDLES: 'someone' }, { fetchImpl: (() => new Promise(() => {})) as typeof fetch })!;
    const actions = [...hyperfyPlugin.actions!, ...shop.actions!];
    const { runtime, recorded } = createRuntime({ actions, models: {} });
    const world = coo();
    for (const action of actions) {
      // Planned text, so REPLY and ambient speech need no model call of their own
      const stored = await inAutonomousTurn(world, () =>
        run(runtime, recorded, action.name, { content: { text: 'Hello' }, message: { entityId: runtime.agentId, content: { text: '' } } })
      );
      const refusedByList = stored.actionResult.error === `${action.name} is not allowed on an autonomous turn`;
      expect(refusedByList, action.name).toBe(!AUTONOMY_ACTIONS.includes(action.name));
    }
    expect(actions.map((a) => a.name)).toContain(SHARE_ACTION);
  });
});

describe('in a turn that may no longer act', () => {
  it('starts no further action: the plan ends there, through real core processActions', async () => {
    const ran: string[] = [];
    const slot = new AbortController();
    const probe = (name: string, after: () => void = () => {}) => ({
      name,
      description: name,
      validate: async () => true,
      handler: async () => {
        ran.push(name);
        after();
        return actionSucceeded(name);
      },
    });
    // The first action is the one during which the turn's slot runs out
    const actions = guardActions([probe('PROBE_FIRST', () => slot.abort()), probe('PROBE_SECOND'), probe('PROBE_THIRD')]);
    const { runtime, recorded } = createRuntime({ actions });
    const plan = ['PROBE_FIRST', 'PROBE_SECOND', 'PROBE_THIRD'];
    const cancelled = inTurn({ origin: 'chat', world: coo(), requesterId: 'builder-1', cancel: slot.signal }, () => runPlan(runtime, recorded, plan));
    await expect(cancelled).rejects.toBeInstanceOf(TurnCancelled);
    expect(ran).toEqual(['PROBE_FIRST']);

    // The same plan in a turn nothing cancels runs to its end (control)
    ran.length = 0;
    const live = guardActions([probe('PROBE_FIRST'), probe('PROBE_SECOND'), probe('PROBE_THIRD')]);
    const second = createRuntime({ actions: live });
    await inTurn({ origin: 'chat', world: coo(), requesterId: 'builder-1' }, () => runPlan(second.runtime, second.recorded, plan));
    expect(ran).toEqual(plan);
  });
});

describe('outside any turn', () => {
  it('the wrapper refuses the scene edit before its handler runs', async () => {
    const { buildManager, runtime, recorded, useModel } = editSetup();
    const stored = await run(runtime, recorded, 'HYPERFY_EDIT_ENTITY');
    expect(stored.actionResult.error).toBe('HYPERFY_EDIT_ENTITY runs only inside a chat or voice turn');
    expect(useModel).not.toHaveBeenCalled();
    expect(buildManager.translate).not.toHaveBeenCalled();
  });

  it('the unwrapped scene edit refuses on its own, without a model call or a reply', async () => {
    const { buildManager, runtime, recorded, useModel } = editSetup();
    runtime.actions.splice(0, runtime.actions.length, hyperfyEditEntityAction);
    const stored = await run(runtime, recorded, 'HYPERFY_EDIT_ENTITY');
    expect(stored.actionResult.error).toBe('scene edits run only for a player who asked in chat or voice');
    expect(useModel).not.toHaveBeenCalled();
    expect(buildManager.translate).not.toHaveBeenCalled();
    expect(recorded.callbacks).toEqual([]);
  });

  it('other actions still run (e.g. from the elizaOS web chat)', async () => {
    const stopAllActions = vi.fn();
    const { runtime, recorded } = createRuntime({ service: connectedService({ controls: { stopAllActions } }) });
    expect((await run(runtime, recorded, 'HYPERFY_STOP_MOVING')).actionStatus).toBe('completed');
    expect(stopAllActions).toHaveBeenCalled();
  });
});

describe('budget errors from actions', () => {
  it('propagate out of processActions from the item extraction', async () => {
    const error = new AiBudgetExceededError('AI_MAX_TOKENS_PER_DAY=1');
    const world = { controls: {}, actions: {}, entities: { items: new Map() } };
    const { runtime, recorded } = createRuntime({
      service: connectedService(world),
      models: {
        [ModelType.OBJECT_SMALL]: () => {
          throw error;
        },
      },
    });
    await expect(run(runtime, recorded, 'HYPERFY_USE_ITEM')).rejects.toBe(error);
  });

  it('other extraction errors still end as a failed use', async () => {
    const world = { controls: {}, actions: {}, entities: { items: new Map() } };
    const { runtime, recorded } = createRuntime({
      service: connectedService(world),
      models: {
        [ModelType.OBJECT_SMALL]: () => {
          throw new Error('bad json');
        },
      },
    });
    expect((await run(runtime, recorded, 'HYPERFY_USE_ITEM')).actionResult.error).toBe('no suitable item found');
  });
});

describe('with scene edits off (the default)', () => {
  it.each([[undefined], ['off'], ['everyone']])('refuses a builder (HYPERFY_SCENE_EDITS=%s) before any model call, and says so', async (value) => {
    vi.unstubAllEnvs();
    if (value !== undefined) vi.stubEnv('HYPERFY_SCENE_EDITS', value);
    vi.stubEnv('HYPERFY_OPERATOR_IDS', 'builder-1');
    const { world, buildManager, runtime, recorded, useModel } = editSetup();
    const stored = await inChatTurn(world, () => run(runtime, recorded, 'HYPERFY_EDIT_ENTITY'), 'builder-1');
    expect(stored.actionResult.error).toBe('scene edits are off (HYPERFY_SCENE_EDITS)');
    expect(useModel).not.toHaveBeenCalled();
    expect(buildManager.translate).not.toHaveBeenCalled();
    expect(recorded.callbacks.map((c) => c.text)).toEqual(["Sorry, I can't change things in this world."]);
  });
});

/*
 * A scene edit bound to the connection it was authorized on, with the real BuildManager: the
 * world, its network and the requester's rank change while the planner (or the walk) is awaited.
 */
describe('a scene edit that loses its authorization while it runs', () => {
  const box = () => ({
    isApp: true,
    data: { id: 'box' },
    root: { position: new THREE.Vector3(1, 0, 1), quaternion: new THREE.Quaternion(), scale: new THREE.Vector3(1, 1, 1) },
  });

  function worldWith(rank: number) {
    const send = vi.fn();
    const world = worldFromSnapshot(cooWorldSnapshot({ players: [{ id: 'builder-1', name: 'Bob', rank }] }), {
      network: { send },
      controls: { goto: vi.fn().mockResolvedValue('arrived') },
      entities: { items: new Map([['box', box()]]) },
    });
    return { world, send, box: world.entities.items.get('box')! };
  }

  function liveEdit(operations: unknown[], models: Record<string, unknown>) {
    const first = worldWith(1);
    const sendMessage = vi.fn();
    // Real sessions: the one the edit's turn starts on, and whatever replaces it
    const connection = { session: withParts(sessionFor(first.world), { messages: { sendMessage } }) };
    const service = { getSession: () => connection.session };
    /** What a reconnect does: the current session ends, and a new one (around `world`) is the current one */
    const reconnect = (world: object) => {
      void connection.session.end();
      connection.session = withParts(sessionFor(world), { messages: { sendMessage } });
    };
    const { runtime, recorded, useModel } = createRuntime({
      service,
      models: { [ModelType.OBJECT_LARGE]: { operations }, [ModelType.TEXT_SMALL]: summary, ...models },
    });
    const turnSession = connection.session;
    const edit = () => turnSession.runTurn({ origin: 'chat', requesterId: 'builder-1' }, () => run(runtime, recorded, 'HYPERFY_EDIT_ENTITY'));
    return { first, connection, reconnect, sendMessage, recorded, useModel, edit, runtime };
  }

  it('edits the world and announces it when nothing changed (control)', async () => {
    const { first, sendMessage, edit } = liveEdit(plan, {});
    expect((await edit()).actionStatus).toBe('completed');
    expect(first.send).toHaveBeenCalledWith('entityModified', expect.objectContaining({ id: 'box', position: [0, 2, 0] }));
    expect(sendMessage).toHaveBeenCalledWith('Moved the box up');
  });

  it.each([
    ['a new world object', () => worldWith(0)],
    ['the same world object under a new session', (ctx: ReturnType<typeof liveEdit>) => ctx.first],
  ])('sends nothing to a new connection when the connection was replaced during the planner call (%s)', async (_what, next) => {
    let second!: ReturnType<typeof worldWith>;
    const ctx = liveEdit(plan, {
      [ModelType.OBJECT_LARGE]: () => {
        // Reconnected meanwhile (on a new world object the requester is a visitor)
        second = next(ctx);
        ctx.reconnect(second.world);
        return { operations: plan };
      },
    });
    const stored = await ctx.edit();
    expect(stored.actionStatus).toBe('failed');
    expect(stored.actionResult.error).toBe('stopped: the turn was cancelled or its connection ended');
    expect(second.send).not.toHaveBeenCalled();
    expect(ctx.first.send).not.toHaveBeenCalled();
    expect(second.box.root.position.toArray()).toEqual([1, 0, 1]);
    expect(ctx.first.box.root.position.toArray()).toEqual([1, 0, 1]);
    expect(ctx.sendMessage).not.toHaveBeenCalled();
    // No summary call for a stopped edit
    expect(ctx.useModel.mock.calls.map(([type]) => type)).toEqual([ModelType.OBJECT_LARGE]);
  });

  it('changes nothing when the requester was demoted during the planner call', async () => {
    const ctx = liveEdit(plan, {
      [ModelType.OBJECT_LARGE]: () => {
        ctx.first.world.network.onEntityModified({ id: 'builder-1', rank: 0 });
        return { operations: plan };
      },
    });
    const stored = await ctx.edit();
    expect(stored.actionResult.error).toBe('stopped: the requester is not a builder in this world');
    expect(ctx.first.world.controls.goto).not.toHaveBeenCalled();
    expect(ctx.first.send).not.toHaveBeenCalled();
    expect(ctx.first.box.root.position.toArray()).toEqual([1, 0, 1]);
    // Told one neutral line, nothing about the scene
    expect(ctx.recorded.callbacks.map((c) => c.text)).toEqual(["I can't go any further with that request."]);
  });

  it('changes nothing, and runs no later operation, when the requester was demoted while the agent walked over', async () => {
    const twoMoves = [plan[0], { ...plan[0], parameters: { position: [5, 5, 5] }, description: 'Moved it again' }];
    const ctx = liveEdit(twoMoves, {});
    ctx.first.world.controls.goto.mockImplementation(async () => {
      ctx.first.world.network.onEntityModified({ id: 'builder-1', rank: 0 });
    });
    const stored = await ctx.edit();
    expect(stored.actionResult.data.outcomes).toEqual([
      { operation: 'translate', target: 'box', outcome: 'failed', reason: 'not run: the requester is not a builder in this world' },
      { operation: 'translate', target: 'box', outcome: 'failed', reason: 'not run: the requester is not a builder in this world' },
    ]);
    expect(ctx.first.world.controls.goto).toHaveBeenCalledTimes(1);
    expect(ctx.first.send).not.toHaveBeenCalled();
    expect(ctx.first.box.root.position.toArray()).toEqual([1, 0, 1]);
  });

  it('does not report to a new connection when the world was replaced during the summary call', async () => {
    const error = new AiBudgetExceededError('AI_MAX_CALLS_PER_HOUR=2');
    const ctx = liveEdit(plan, {
      [ModelType.TEXT_SMALL]: () => {
        ctx.reconnect(worldWith(1).world);
        throw error;
      },
    });
    await expect(ctx.edit()).rejects.toBe(error);
    expect(ctx.sendMessage.mock.calls.map(([text]) => text)).toEqual(['Moved the box up']);
  });

  it.each([
    ['a budget error', new AiBudgetExceededError('AI_MAX_CALLS_PER_HOUR=2')],
    ['a model refusal', new AnthropicRefusalError('claude', 'cyber')],
  ])('reports the edits it made and then propagates %s from the summary call', async (_what, error) => {
    const ctx = liveEdit(plan, {
      [ModelType.TEXT_SMALL]: () => {
        throw error;
      },
    });
    await expect(ctx.edit()).rejects.toBe(error);
    expect(ctx.first.send).toHaveBeenCalledWith('entityModified', expect.objectContaining({ id: 'box', position: [0, 2, 0] }));
    // Posted directly: core drops callback content when the action throws
    expect(ctx.sendMessage.mock.calls.map(([text]) => text)).toEqual(['Moved the box up', 'I made the change.']);
  });

  it.each([
    ['a budget error', new AiBudgetExceededError('AI_MAX_CALLS_PER_HOUR=2')],
    ['a model refusal', new AnthropicRefusalError('claude', 'cyber')],
  ])('ends with the neutral line, not the edits, for a requester demoted during a summary call that ended in %s', async (_what, error) => {
    const ctx = liveEdit(plan, {
      [ModelType.TEXT_SMALL]: () => {
        ctx.first.world.network.onEntityModified({ id: 'builder-1', rank: 0 });
        throw error;
      },
    });
    const stored = await ctx.edit();
    expect(stored.actionResult.data).toMatchObject({ executed: 1 });
    expect(ctx.sendMessage.mock.calls.map(([text]) => text)).toEqual(['Moved the box up']);
    expect(ctx.recorded.callbacks.map((c) => c.text)).toEqual(["I can't go any further with that request."]);
  });

  it('makes no summary call for a requester demoted while the summary state was composed', async () => {
    const ctx = liveEdit(plan, {});
    const compose = ctx.runtime.composeState.bind(ctx.runtime);
    ctx.runtime.composeState = async (...args: Parameters<typeof compose>) => {
      const state = await compose(...args);
      // The state composed once the edit went out is the summary's
      if (ctx.first.send.mock.calls.length > 0) ctx.first.world.network.onEntityModified({ id: 'builder-1', rank: 0 });
      return state;
    };
    await ctx.edit();
    expect(ctx.first.send).toHaveBeenCalledWith('entityModified', expect.objectContaining({ id: 'box' }));
    expect(ctx.useModel.mock.calls.map(([type]) => type)).toEqual([ModelType.OBJECT_LARGE]);
    expect(ctx.recorded.callbacks.map((c) => c.text)).toEqual(["I can't go any further with that request."]);
  });

  it.each([
    ['a summary', summary],
    ['a summary with no text', '<response><thought>t</thought></response>'],
    ['an unreadable summary', 'not xml'],
    ['a failed summary call', new Error('model down')],
  ])('tells a requester demoted during the summary call one neutral line instead of %s', async (_what, answer) => {
    const ctx = liveEdit(plan, {
      [ModelType.TEXT_SMALL]: () => {
        ctx.first.world.network.onEntityModified({ id: 'builder-1', rank: 0 });
        if (answer instanceof Error) throw answer;
        return answer;
      },
    });
    await ctx.edit();
    expect(ctx.recorded.callbacks.map((c) => c.text)).toEqual(["I can't go any further with that request."]);
    expect(JSON.stringify(ctx.recorded.callbacks)).not.toMatch(/box|Box|change/);
  });

  it('makes no summary call for a requester demoted after the edits, and tells them one neutral line', async () => {
    const ctx = liveEdit(plan, {});
    // Demoted once the edit went out (after its announcement)
    ctx.sendMessage.mockImplementation(() => ctx.first.world.network.onEntityModified({ id: 'builder-1', rank: 0 }));
    await ctx.edit();
    expect(ctx.useModel.mock.calls.map(([type]) => type)).toEqual([ModelType.OBJECT_LARGE]);
    expect(ctx.recorded.callbacks.map((c) => c.text)).toEqual(["I can't go any further with that request."]);
  });

  it.each([
    ['the change was made', [], 'I made the change.'],
    ['the target had vanished', ['box'], "I couldn't make any of those changes."],
  ])('says what the counts say when the summary has no text and %s', async (_what, vanish, text) => {
    const ctx = liveEdit(plan, {
      [ModelType.OBJECT_LARGE]: () => {
        for (const id of vanish) ctx.first.world.entities.items.delete(id);
        return { operations: plan };
      },
      [ModelType.TEXT_SMALL]: '<response><thought>t</thought></response>',
    });
    await ctx.edit();
    expect(ctx.recorded.callbacks.map((c) => c.text)).toEqual([text]);
  });

  it('logs, summarises and records an import target without its credentials or signed query', async () => {
    const target = 'https://user:secret-pw@cdn.example/a.glb?token=signed-secret#frag-secret';
    const ctx = liveEdit([{ success: true, operation: 'import', target, parameters: {}, description: 'Imported it' }], {});
    const lines: string[] = [];
    for (const level of ['warn', 'error', 'info'] as const) vi.spyOn(logger, level).mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(' ')));
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(' ')));
    const stored = await ctx.edit();
    const prompt = (ctx.useModel.mock.calls.find(([type]) => type === ModelType.TEXT_SMALL)![1] as { prompt: string }).prompt;
    const seen = [lines.join('\n'), prompt, JSON.stringify(stored.actionResult.data)].join('\n');
    expect(seen).toContain('https://cdn.example/a.glb?token=…');
    expect(seen).not.toMatch(/secret-pw|signed-secret|frag-secret/);
  });

  it.each([
    ['an import written with a leading space', 'import', ' https://cdn.example/a.glb?token=signed-secret'],
    ['an import written with leading whitespace and credentials', 'import', '\t\n https://user:secret-pw@cdn.example/a.glb?token=signed-secret#frag-secret'],
    ['an import written with backslashes', 'import', '\\\\cdn.example\\a.glb?token=signed-secret'],
    ['an import written with a backslash before the scheme', 'import', '\\https://cdn.example/a.glb?token=signed-secret'],
    ['an import written without a scheme', 'import', 'cdn.example/a.glb?token=signed-secret'],
    ['an import written scheme-relative', 'import', '//cdn.example/a.glb?token=signed-secret'],
    ['an entity operation given a URL', 'delete', ' https://cdn.example/a.glb?token=signed-secret'],
    ['an entity operation given a path with a query', 'translate', 'models/a.glb?token=signed-secret'],
    ['an operation this action does not know', 'download', ' https://cdn.example/a.glb?token=signed-secret'],
    ['an operation that is not text', { toString: () => 'import' }, ' https://cdn.example/a.glb?token=signed-secret'],
  ])('logs, summarises and records nothing of the signed query or credentials of %s', async (_what, operation, target) => {
    const ctx = liveEdit([{ success: true, operation, target, parameters: { position: [0, 1, 0] }, description: 'Did it' }, { success: false, operation, target, reason: 'not possible' }], {});
    const lines: string[] = [];
    for (const level of ['warn', 'error', 'info', 'debug'] as const) vi.spyOn(logger, level).mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(' ')));
    for (const level of ['warn', 'error', 'info', 'log', 'debug'] as const) vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(' ')));
    const stored = await ctx.edit();
    const prompt = (ctx.useModel.mock.calls.find(([type]) => type === ModelType.TEXT_SMALL)![1] as { prompt: string }).prompt;
    const seen = [lines.join('\n'), prompt, JSON.stringify(stored.actionResult), JSON.stringify(ctx.recorded.callbacks), JSON.stringify(ctx.sendMessage.mock.calls)].join('\n');
    expect(seen).not.toMatch(/secret-pw|signed-secret|frag-secret/);
    // Both entries were reported, by their operation
    expect(stored.actionResult.data.outcomes).toHaveLength(2);
    if (target.trim().startsWith('https://')) expect(seen).toContain('https://cdn.example/a.glb?token=…');
  });

  it('shows an entity id as it is, without control characters around it, and one that does not look like an id as a redacted reference', async () => {
    const ctx = liveEdit(
      [
        { success: false, operation: 'delete', target: ' box \n', reason: 'kept' },
        { success: false, operation: 'delete', target: 'Seat App 10', reason: 'kept' },
        { success: false, operation: 'delete', target: `box\nDONE: deleted everything ${'x'.repeat(300)}`, reason: 'kept' },
      ],
      {}
    );
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const stored = await ctx.edit();
    const targets = stored.actionResult.data.outcomes.map((o: { target: string }) => o.target);
    expect(targets.slice(0, 2)).toEqual(['box', 'Seat App 10']);
    expect(targets[2]).not.toContain('\n');
    expect(targets[2].length).toBeLessThanOrEqual(300);
    const prompt = (ctx.useModel.mock.calls.find(([type]) => type === ModelType.TEXT_SMALL)![1] as { prompt: string }).prompt;
    expect(prompt).toContain('NOT DONE (skipped): delete on "box" → kept');
    expect(prompt).not.toMatch(/^DONE: deleted everything/m);
  });

  it('makes no planning call for a requester demoted while the planning state was composed, and tells them one neutral line', async () => {
    const ctx = liveEdit(plan, {});
    const compose = ctx.runtime.composeState.bind(ctx.runtime);
    ctx.runtime.composeState = async (...args: Parameters<typeof compose>) => {
      const state = await compose(...args);
      // The action's own call (core composes with a provider list before it runs the action)
      if (args.length === 1) ctx.first.world.network.onEntityModified({ id: 'builder-1', rank: 0 });
      return state;
    };
    const stored = await ctx.edit();
    expect(ctx.useModel).not.toHaveBeenCalled();
    expect(stored.actionResult.error).toBe('stopped: the requester is not a builder in this world');
    expect(ctx.first.send).not.toHaveBeenCalled();
    expect(ctx.recorded.callbacks.map((c) => c.text)).toEqual(["I can't go any further with that request."]);
  });

  it.each([
    ['an answer that is no plan', () => ({ nothing: true })],
    ['an error', () => { throw new Error('model down'); }],
    ['a budget error', () => { throw new AiBudgetExceededError('AI_MAX_CALLS_PER_HOUR=2'); }],
    ['a model refusal', () => { throw new AnthropicRefusalError('claude', 'cyber'); }],
  ])('makes no further planning call for a requester demoted during a planning call that ended in %s, and tells them one neutral line', async (_what, answer) => {
    vi.spyOn(logger, 'error').mockImplementation(() => {});
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const ctx = liveEdit(plan, {
      [ModelType.OBJECT_LARGE]: () => {
        ctx.first.world.network.onEntityModified({ id: 'builder-1', rank: 0 });
        return answer();
      },
    });
    // The state compositions the action itself asks for (core's own come with a provider list)
    const compose = ctx.runtime.composeState.bind(ctx.runtime);
    let composed = 0;
    ctx.runtime.composeState = async (...args: Parameters<typeof compose>) => {
      if (args.length === 1) composed++;
      return compose(...args);
    };
    const stored = await ctx.edit();
    expect(ctx.useModel.mock.calls.map(([type]) => type)).toEqual([ModelType.OBJECT_LARGE]);
    // Nor is the state composed again for another attempt
    expect(composed).toBe(1);
    expect(stored.actionResult.error).toBe('stopped: the requester is not a builder in this world');
    // Not "I couldn't work out how to make that change"
    expect(ctx.recorded.callbacks.map((c) => c.text)).toEqual(["I can't go any further with that request."]);
  });

  it('tells a requester demoted during the last planning attempt the neutral line, not that the change could not be worked out', async () => {
    vi.spyOn(logger, 'error').mockImplementation(() => {});
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    let attempts = 0;
    const ctx = liveEdit(plan, {
      [ModelType.OBJECT_LARGE]: () => {
        if (++attempts === 3) ctx.first.world.network.onEntityModified({ id: 'builder-1', rank: 0 });
        return { nothing: true };
      },
    });
    const stored = await ctx.edit();
    expect(attempts).toBe(3);
    expect(stored.actionResult.error).toBe('stopped: the requester is not a builder in this world');
    expect(ctx.recorded.callbacks.map((c) => c.text)).toEqual(["I can't go any further with that request."]);
  });

  it('still retries the planning call three times for a requester who may build, then says it could not work the change out (control)', async () => {
    vi.spyOn(logger, 'error').mockImplementation(() => {});
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const ctx = liveEdit(plan, { [ModelType.OBJECT_LARGE]: { nothing: true } });
    const stored = await ctx.edit();
    expect(ctx.useModel.mock.calls.map(([type]) => type)).toEqual([ModelType.OBJECT_LARGE, ModelType.OBJECT_LARGE, ModelType.OBJECT_LARGE]);
    expect(stored.actionResult.error).toBe('no edit plan from the model');
    expect(ctx.recorded.callbacks.map((c) => c.text)).toEqual(["Sorry, I couldn't work out how to make that change."]);
  });

  it("does not announce an operation whose requester lost the right as it was sent", async () => {
    const ctx = liveEdit(plan, {});
    // Demoted while the change itself goes out (e.g. a packet handled in between)
    ctx.first.send.mockImplementation(() => ctx.first.world.network.onEntityModified({ id: 'builder-1', rank: 0 }));
    await ctx.edit();
    expect(ctx.sendMessage).not.toHaveBeenCalled();
  });

  it('counts and summarises what was done, not what was planned: a target that vanished is not a change', async () => {
    const ctx = liveEdit(plan, {
      [ModelType.OBJECT_LARGE]: () => {
        ctx.first.world.entities.items.delete('box');
        return { operations: plan };
      },
    });
    const stored = await ctx.edit();
    expect(stored.actionStatus).toBe('failed');
    expect(stored.actionResult.data).toMatchObject({ executed: 0, skipped: 1, outcomes: [{ operation: 'translate', target: 'box', outcome: 'skipped', reason: 'target not found' }] });
    expect(ctx.sendMessage).not.toHaveBeenCalled();
    const summaryPrompt = (ctx.useModel.mock.calls.find(([type]) => type === ModelType.TEXT_SMALL)![1] as { prompt: string }).prompt;
    expect(summaryPrompt).toContain('NOT DONE (skipped): translate on "box" → target not found');
    expect(summaryPrompt).not.toContain('Moved the box up');
  });

  it('says "none of those changes" when the summary cannot be written and the target had vanished', async () => {
    const error = new AiBudgetExceededError('AI_MAX_CALLS_PER_HOUR=2');
    const ctx = liveEdit(plan, {
      [ModelType.OBJECT_LARGE]: () => {
        ctx.first.world.entities.items.delete('box');
        return { operations: plan };
      },
      [ModelType.TEXT_SMALL]: () => {
        throw error;
      },
    });
    await expect(ctx.edit()).rejects.toBe(error);
    expect(ctx.sendMessage.mock.calls.map(([text]) => text)).toEqual(["I couldn't make any of those changes."]);
  });
});

describe('budget errors and model refusals at the other model calls in actions', () => {
  const stops = [
    ['budget error', () => new AiBudgetExceededError('AI_MAX_CALLS_PER_HOUR=1')],
    ['model refusal', () => new AnthropicRefusalError('claude', 'cyber')],
  ] as const;

  it.each(stops)('a %s propagates from the item pick and the navigation target extraction', async (_what, make) => {
    const error = make();
    const throwing = () => {
      throw error;
    };
    const use = createRuntime({ service: connectedService({ controls: {}, actions: {}, entities: { items: new Map() } }), models: { [ModelType.OBJECT_SMALL]: throwing } });
    await expect(run(use.runtime, use.recorded, 'HYPERFY_USE_ITEM')).rejects.toBe(error);
    const goto = createRuntime({ service: connectedService({ controls: { goto: vi.fn() } }), models: { [ModelType.OBJECT_LARGE]: throwing } });
    await expect(run(goto.runtime, goto.recorded, 'HYPERFY_GOTO_ENTITY')).rejects.toBe(error);
  });

  it('a model refusal propagates from the vision call', async () => {
    const error = new AnthropicRefusalError('claude', 'cyber');
    const world = { controls: { stopAllActions: vi.fn() }, entities: { items: new Map(), player: { data: { id: 'coo' } } } };
    const { runtime, recorded } = createRuntime({
      service: connectedService(world, { renderPage: { capture: async () => 'aGVsbG8=' } }),
      models: {
        [ModelType.IMAGE_DESCRIPTION]: () => {
          throw error;
        },
      },
    });
    await expect(run(runtime, recorded, 'HYPERFY_SCENE_PERCEPTION', { message: { content: { text: 'look around', source: 'hyperfy' } } })).rejects.toBe(error);
  });

  it('propagate from the navigation target extraction', async () => {
    const error = new AiBudgetExceededError('AI_MAX_CALLS_PER_HOUR=1');
    const { runtime, recorded } = createRuntime({
      service: connectedService({ controls: { goto: vi.fn() } }),
      models: {
        [ModelType.OBJECT_LARGE]: () => {
          throw error;
        },
      },
    });
    await expect(run(runtime, recorded, 'HYPERFY_GOTO_ENTITY')).rejects.toBe(error);
  });

  it('propagate from the vision call', async () => {
    const error = new AiBudgetExceededError('AI_MAX_CALLS_PER_HOUR=1');
    const world = { controls: { stopAllActions: vi.fn() }, entities: { items: new Map(), player: { data: { id: 'coo' } } } };
    const { runtime, recorded } = createRuntime({
      service: connectedService(world, { renderPage: { capture: async () => 'aGVsbG8=' } }),
      models: {
        [ModelType.IMAGE_DESCRIPTION]: () => {
          throw error;
        },
      },
    });
    await expect(run(runtime, recorded, 'HYPERFY_SCENE_PERCEPTION', { message: { content: { text: 'look around', source: 'hyperfy' } } })).rejects.toBe(error);
  });
});

describe('failures the requester is told about', () => {
  const noService = () => createRuntime({ service: null });

  it.each([
    ['navigation target extraction failing', 'HYPERFY_GOTO_ENTITY', () => ({ world: { controls: { goto: vi.fn() } }, models: { [ModelType.OBJECT_LARGE]: () => { throw new Error('bad json'); } } })],
    ['navigation failing', 'HYPERFY_GOTO_ENTITY', () => ({ world: { controls: { goto: vi.fn().mockRejectedValue(new Error('blocked')) } }, models: { [ModelType.OBJECT_LARGE]: { navigationType: 'position', parameter: { position: { x: 1, z: 1 } } } } })],
    ['a missing item', 'HYPERFY_USE_ITEM', () => ({ world: { controls: {}, actions: {}, entities: { items: new Map() } }, models: { [ModelType.OBJECT_SMALL]: { entityId: 'gone' } } })],
    ['no action system', 'HYPERFY_UNUSE_ITEM', () => ({ world: {}, models: {} })],
    ['no controls', 'HYPERFY_WALK_RANDOMLY', () => ({ world: {}, models: {} })],
  ])('%s is told in a chat turn and kept quiet on an autonomous one', async (_what, name, make) => {
    const chat = make();
    const inChat = createRuntime({ service: connectedService(chat.world), models: chat.models });
    await inChatTurn(chat.world, () => run(inChat.runtime, inChat.recorded, name));
    expect(inChat.recorded.callbacks).toHaveLength(1);
    expect(inChat.recorded.callbacks[0].text).toBeTruthy();
    const auto = make();
    const inAuto = createRuntime({ service: connectedService(auto.world), models: auto.models });
    expect((await inAutonomousTurn(auto.world, () => run(inAuto.runtime, inAuto.recorded, name))).actionStatus).toBe('failed');
    expect(inAuto.recorded.callbacks).toEqual([]);
  });

  it('a scene edit without a world, or without a plan from the model, says so', async () => {
    const chat = noService();
    expect((await inChatTurn(coo(), () => run(chat.runtime, chat.recorded, 'HYPERFY_EDIT_ENTITY'), 'builder-1')).actionStatus).toBe('failed');
    expect(chat.recorded.callbacks.map((c) => c.text)).toEqual(["I can't edit the world right now."]);
    const { world, recorded, runtime } = editSetup(coo(), { [ModelType.OBJECT_LARGE]: { nothing: true } });
    expect((await inChatTurn(world, () => run(runtime, recorded, 'HYPERFY_EDIT_ENTITY'), 'builder-1')).actionResult.error).toBe('no edit plan from the model');
    expect(recorded.callbacks.map((c) => c.text)).toEqual(["Sorry, I couldn't work out how to make that change."]);
  });

  it.each([
    ['HYPERFY_TELEPORT_TO_USER', "I can't teleport right now."],
    ['HYPERFY_GOTO_ENTITY', "I can't move right now."],
  ])('%s without a world says so in a chat turn and stays silent on an autonomous one', async (name, text) => {
    const chat = noService();
    await inChatTurn({}, () => run(chat.runtime, chat.recorded, name));
    expect(chat.recorded.callbacks.map((c) => c.text)).toEqual([text]);
    const auto = noService();
    await inAutonomousTurn({}, () => run(auto.runtime, auto.recorded, name));
    expect(auto.recorded.callbacks).toEqual([]);
  });

  it('a use request whose item the model could not pick says so', async () => {
    const world = { controls: { goto: vi.fn() }, actions: {}, entities: { items: new Map() } };
    const { runtime, recorded } = createRuntime({ service: connectedService(world), models: { [ModelType.OBJECT_SMALL]: {} } });
    const stored = await inChatTurn(world, () => run(runtime, recorded, 'HYPERFY_USE_ITEM'));
    expect(stored.actionResult.error).toBe('no suitable item found');
    expect(recorded.callbacks.map((c) => c.text)).toEqual(["I couldn't tell which item you mean."]);
  });

  it('a failed look says so', async () => {
    const world = { controls: { stopAllActions: vi.fn() }, entities: { items: new Map(), player: { data: { id: 'coo' } } } };
    const { runtime, recorded } = createRuntime({
      service: connectedService(world, {
        renderPage: {
          capture: async () => {
            throw new Error('page closed');
          },
        },
      }),
    });
    const stored = await inChatTurn(world, () => run(runtime, recorded, 'HYPERFY_SCENE_PERCEPTION', { message: { content: { text: 'look around', source: 'hyperfy' } } }));
    expect(stored.actionResult.error).toBe('snapshot failed');
    expect(recorded.callbacks.map((c) => c.text)).toEqual(["Sorry, I couldn't get a proper look just now."]);
  });

  it('a shop link the agent could not match to a product says so', async () => {
    // The Store's listings API never answers here (and the real one is never asked)
    const shop = createOpenPayStorePlugin({ OPENPAY_STORE_HANDLES: 'someone' }, { fetchImpl: (() => new Promise(() => {})) as typeof fetch })!;
    const { runtime, recorded } = createRuntime({ actions: shop.actions! });
    const stored = await inChatTurn({}, () => run(runtime, recorded, SHARE_ACTION, { message: { content: { text: 'the link please', source: 'hyperfy' } } }));
    expect(stored.actionResult.error).toBe('could not tell which product to share');
    expect(recorded.callbacks.map((c) => c.text)).toEqual(["Sorry, I couldn't tell which product you mean, so I didn't post a link."]);
  });
});
