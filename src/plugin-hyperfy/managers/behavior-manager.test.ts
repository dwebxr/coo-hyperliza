import { afterEach, describe, expect, it, vi } from 'vitest';

import { ModelType } from '@elizaos/core';
import { BehaviorManager } from './behavior-manager';
import { AiBudgetExceededError, UsageBudget, type UsageLimits, resetUsageBudget } from '../../usage-budget';
import { currentTurn } from '../lib/turn-context';
import { createRuntime } from '../test-support/core-runtime';
import { serviceFor, sessionFor, withParts } from '../test-support/session';
import type { ConnectionSession } from '../session/connection-session';

const AUTONOMY = { tickMinMs: 1, tickMaxMs: 1, patrolPoints: [{ x: 3, z: 4 }], wanderRadius: 6 };

const noLimits: UsageLimits = {
  aiCallsPerHour: null,
  aiTokensPerDay: null,
  visionPerHour: null,
  ttsCharsPerDay: null,
  sttSecondsPerDay: null,
  autonomyAiPerHour: null,
  autonomyAiMinIntervalMs: 0,
};

const position = (x: number) => ({ x, z: 0, distanceTo: (o: { x: number }) => Math.abs(o.x - x) });

function setup({ emoteClips = true }: { emoteClips?: boolean } = {}) {
  const controls = {
    goto: vi.fn().mockResolvedValue('arrived'),
    followEntity: vi.fn().mockResolvedValue('arrived'),
    faceEntity: vi.fn().mockResolvedValue(undefined),
    rotateTo: vi.fn().mockResolvedValue(undefined),
    getIsNavigating: () => false,
    getIsWalkingRandomly: () => false,
  };
  const self = { data: { id: 'agent', name: 'Coo', type: 'player' }, base: { position: position(0) } };
  const items = new Map<string, any>([
    ['agent', self],
    ['bob', { data: { id: 'bob', type: 'player' }, base: { position: position(2) } }],
  ]);
  const world = { controls, entities: { player: self, items } };
  const emotes = { playEmote: vi.fn(), hasEmote: vi.fn(() => emoteClips), stop: vi.fn() };
  const runtime: any = {
    agentId: '00000000-0000-0000-0000-0000000000aa',
    character: { name: 'Coo', templates: {} },
    composeState: vi.fn().mockResolvedValue({ values: {}, data: {}, text: '' }),
    actions: [],
    useModel: vi.fn().mockResolvedValue('<response><thought>t</thought><actions>IGNORE</actions></response>'),
    ensureConnection: vi.fn().mockResolvedValue(undefined),
    processActions: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue(undefined),
  };
  // The connection the behavior runs on: a real session around that world, with the test's emotes
  const session = withParts(sessionFor(world, { runtime }), { emotes, messages: { sendMessage: vi.fn() }, voice: { speak: vi.fn(), stop: vi.fn() } });
  runtime.getService = () => serviceFor(session);
  const manager = new BehaviorManager(runtime, session, AUTONOMY);
  const tick = () => (manager as any).executeBehavior() as Promise<boolean>;
  return { runtime, world, session, controls, emotes, tick, manager };
}

describe('BehaviorManager', () => {
  afterEach(() => {
    resetUsageBudget();
    vi.restoreAllMocks();
  });

  it('asks Claude only within the autonomous budget, and runs scripts otherwise', async () => {
    const budget = new UsageBudget({ ...noLimits, autonomyAiPerHour: 1 });
    resetUsageBudget(budget);
    const { runtime, emotes, tick } = setup();

    await tick();
    expect(runtime.useModel).toHaveBeenCalledTimes(1);
    expect(runtime.useModel.mock.calls[0][1]).toMatchObject({ purpose: 'autonomous' });

    // Over the hourly autonomous limit: a scripted greeting for the player nearby, no model call
    await tick();
    expect(runtime.useModel).toHaveBeenCalledTimes(1);
    expect(emotes.playEmote).toHaveBeenCalledWith('waving both hands');
    expect(budget.snapshot(60_000).autonomy).toEqual({ aiTicks: 1, scriptedTicks: 1 });
  });

  it('lists the actions an autonomous turn may use in the prompt, as text: braces in a description are not template syntax', async () => {
    resetUsageBudget(new UsageBudget(noLimits));
    const { runtime, tick } = setup();
    runtime.composeState.mockResolvedValue({ values: { secret: 'S3CRET', agentName: 'Coo' }, data: {}, text: '' });
    runtime.actions = [
      { name: 'HYPERFY_WALK_RANDOMLY', description: 'Wander {{secret}} {{#each x}}', validate: async () => true },
      { name: 'HYPERFY_EDIT_ENTITY', description: 'Edit the scene', validate: async () => true },
    ];
    await tick();
    const { prompt } = runtime.useModel.mock.calls[0][1];
    expect(prompt).toContain('# Available Actions:\n- **HYPERFY_WALK_RANDOMLY**: Wander {{secret}} {{#each x}}\n');
    expect(prompt).not.toContain('S3CRET');
    // Only what an autonomous turn is allowed
    expect(prompt).not.toContain('HYPERFY_EDIT_ENTITY');
  });

  it('keeps patrolling when the Claude budget is used up', async () => {
    resetUsageBudget(new UsageBudget({ ...noLimits, aiCallsPerHour: 0 }));
    vi.spyOn(Math, 'random').mockReturnValue(0.1);
    const { runtime, controls, tick } = setup();

    await tick(); // greets bob first
    await tick();
    expect(runtime.useModel).not.toHaveBeenCalled();
    expect(controls.goto).toHaveBeenCalledWith(3, 4);
  });

  it('turns toward players and looks around by turning when the world has no wave / look-around clips', async () => {
    resetUsageBudget(new UsageBudget({ ...noLimits, autonomyAiPerHour: 0 }));
    const { emotes, controls, tick } = setup({ emoteClips: false });

    await tick(); // greets bob, 2 m away
    expect(emotes.playEmote).not.toHaveBeenCalled();
    expect(controls.faceEntity).toHaveBeenCalledWith('bob');

    vi.spyOn(Math, 'random').mockReturnValue(0.6); // a look-around step
    await tick();
    expect(controls.rotateTo).toHaveBeenCalledTimes(1);
  });

  it('waves at a newcomer it walked up to only when the walk got there', async () => {
    for (const [walk, waved] of [['arrived', true], ['stopped', false], ['replaced', false], ['timed-out', false], ['unreachable', false]] as const) {
      resetUsageBudget(new UsageBudget({ ...noLimits, autonomyAiPerHour: 0 }));
      const { world, emotes, controls, tick, manager } = setup();
      // As while the behavior loop runs (start() sets it; these tests call the tick themselves)
      (manager as unknown as { isRunning: boolean }).isRunning = true;
      // Far enough to be approached first
      world.entities.items.get('bob').base.position = position(10);
      controls.followEntity.mockResolvedValue(walk);
      await tick();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(controls.followEntity, walk).toHaveBeenCalledWith('bob');
      expect(emotes.playEmote.mock.calls.length, walk).toBe(waved ? 1 : 0);
    }
  });

  it('does nothing, and calls nothing, when no one else is around', async () => {
    resetUsageBudget(new UsageBudget(noLimits));
    const { runtime, world, controls, emotes, tick } = setup();
    world.entities.items.delete('bob');
    await expect(tick()).resolves.toBe(false);
    expect(runtime.useModel).not.toHaveBeenCalled();
    expect(controls.goto).not.toHaveBeenCalled();
    expect(emotes.playEmote).not.toHaveBeenCalled();
  });
});

describe('BehaviorManager autonomous turns', () => {
  afterEach(() => {
    resetUsageBudget();
    vi.restoreAllMocks();
  });

  it('runs a Claude-decided tick as an autonomous turn with no requester', async () => {
    resetUsageBudget(new UsageBudget(noLimits));
    const { runtime, world, session, tick } = setup();
    let seen: any;
    runtime.processActions.mockImplementation(async () => {
      seen = currentTurn();
    });
    await tick();
    expect(seen).toMatchObject({ origin: 'autonomy', generation: session.generation, world, live: true });
    expect(seen.requesterId).toBeUndefined();
  });

  it('does nothing with the answer of a tick whose connection ended while Claude was asked, and no scripted step either', async () => {
    resetUsageBudget(new UsageBudget(noLimits));
    const { runtime, session, emotes, controls, tick } = setup();
    runtime.useModel.mockImplementation(async () => {
      void session.end();
      return '<response><thought>t</thought><actions>HYPERFY_WALK_RANDOMLY</actions><text>Hello</text></response>';
    });
    await expect(tick()).resolves.toBe(true);
    expect(runtime.processActions).not.toHaveBeenCalled();
    expect(emotes.playEmote).not.toHaveBeenCalled();
    expect(controls.goto).not.toHaveBeenCalled();
    expect(controls.followEntity).not.toHaveBeenCalled();
    // And nothing at all on a later tick of the ended connection
    await expect(tick()).resolves.toBe(false);
    expect(runtime.useModel).toHaveBeenCalledTimes(1);
  });

  it('starts no scripted walk while a turn has the avatar to itself', async () => {
    resetUsageBudget(new UsageBudget({ ...noLimits, autonomyAiPerHour: 0 }));
    vi.spyOn(Math, 'random').mockReturnValue(0.1);
    const { session, controls, tick } = setup();
    await tick(); // greets bob first
    let release: (() => void) | undefined;
    const held = session.withBody(() => new Promise<void>((resolve) => (release = resolve)));
    await vi.waitFor(() => expect(release).toBeDefined());
    await tick();
    expect(controls.goto).not.toHaveBeenCalled();
    release!();
    await held;
    await tick();
    expect(controls.goto).toHaveBeenCalledWith(3, 4);
  });

  /** The real BehaviorManager on a real core runtime with the plugin's real (guarded) actions. */
  function realRuntime(plan: string, models: Record<string, unknown> = {}) {
    const { emotes, controls, world } = setup();
    (world as any).actions = {};
    const buildManager = { translate: vi.fn(), delete: vi.fn(), importEntity: vi.fn() };
    let session: ConnectionSession | null = null;
    const { runtime, recorded, useModel } = createRuntime({
      service: serviceFor(() => session),
      models: { [ModelType.TEXT_LARGE]: plan, ...models },
    });
    vi.spyOn(runtime, 'ensureConnection').mockResolvedValue(undefined);
    session = withParts(sessionFor(world, { runtime }), { emotes, build: buildManager, messages: { sendMessage: vi.fn() }, voice: { speak: vi.fn(), stop: vi.fn() } });
    const manager = new BehaviorManager(runtime, session, AUTONOMY);
    const tick = () => (manager as any).executeBehavior() as Promise<boolean>;
    return { runtime, recorded, useModel, buildManager, emotes, controls, tick };
  }

  it('edits nothing when the plan names the scene edit by name, substring or simile, and drops an empty name', async () => {
    resetUsageBudget(new UsageBudget(noLimits));
    const { recorded, useModel, buildManager, tick } = realRuntime(
      '<response><thought>t</thought><actions>HYPERFY_EDIT_ENTITY,EDIT,MODIFY_SCENE,</actions></response>'
    );
    await tick();
    const results = recorded.memories.filter((m) => m.content.type === 'action_result').map((m) => m.content as any);
    expect(results.map((r) => r.actionResult.error)).toEqual(Array(3).fill('HYPERFY_EDIT_ENTITY is not allowed on an autonomous turn'));
    expect(useModel.mock.calls.map(([type]) => type)).toEqual([ModelType.TEXT_LARGE]);
    expect(buildManager.translate).not.toHaveBeenCalled();
  });

  it.each([
    ['HYPERFY_USE_ITEM', ModelType.OBJECT_SMALL],
    ['HYPERFY_GOTO_ENTITY', ModelType.OBJECT_LARGE],
  ])('falls back to scripted behavior when %s runs out of Claude budget mid-tick', async (action, model) => {
    const budget = new UsageBudget(noLimits);
    resetUsageBudget(budget);
    const { emotes, tick } = realRuntime(`<response><thought>t</thought><actions>${action}</actions></response>`, {
      [model]: () => {
        throw new AiBudgetExceededError('AI_MAX_CALLS_PER_HOUR=1');
      },
    });
    await expect(tick()).resolves.toBe(true);
    expect(budget.snapshot(60_000).autonomy).toEqual({ aiTicks: 1, scriptedTicks: 1 });
    // The scripted step: greeting the newcomer
    expect(emotes.playEmote).toHaveBeenCalledWith('waving both hands');
  });
});
