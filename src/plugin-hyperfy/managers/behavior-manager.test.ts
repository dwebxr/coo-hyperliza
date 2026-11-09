import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../service', () => ({ HyperfyService: { serviceType: 'hyperfy' } }));

import { BehaviorManager } from './behavior-manager';
import { UsageBudget, type UsageLimits, resetUsageBudget } from '../../usage-budget';

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
    goto: vi.fn().mockResolvedValue(undefined),
    followEntity: vi.fn().mockResolvedValue(undefined),
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
  const emotes = { playEmote: vi.fn(), hasEmote: vi.fn(() => emoteClips) };
  const service = {
    getWorld: () => world,
    currentWorldId: '00000000-0000-0000-0000-0000000000ee',
    getEmoteManager: () => emotes,
    getMessageManager: () => ({ sendMessage: vi.fn() }),
    getVoiceManager: () => ({ speak: vi.fn() }),
  };
  const runtime: any = {
    agentId: '00000000-0000-0000-0000-0000000000aa',
    getService: () => service,
    composeState: vi.fn().mockResolvedValue({ values: {}, data: {}, text: '' }),
    actions: [],
    useModel: vi.fn().mockResolvedValue('<response><thought>t</thought><actions>IGNORE</actions></response>'),
    ensureConnection: vi.fn().mockResolvedValue(undefined),
    processActions: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue(undefined),
  };
  const manager = new BehaviorManager(runtime, { tickMinMs: 1, tickMaxMs: 1, patrolPoints: [{ x: 3, z: 4 }], wanderRadius: 6 });
  const tick = () => (manager as any).executeBehavior() as Promise<boolean>;
  return { runtime, controls, emotes, tick };
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

  it('does nothing, and calls nothing, when no one else is around', async () => {
    resetUsageBudget(new UsageBudget(noLimits));
    const { runtime, controls, emotes, tick } = setup();
    runtime.getService().getWorld().entities.items.delete('bob');
    await expect(tick()).resolves.toBe(false);
    expect(runtime.useModel).not.toHaveBeenCalled();
    expect(controls.goto).not.toHaveBeenCalled();
    expect(emotes.playEmote).not.toHaveBeenCalled();
  });
});
