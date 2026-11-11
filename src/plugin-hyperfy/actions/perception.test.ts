import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hyperfyScenePerceptionAction } from './perception';
import { serviceFor, sessionFor, sessionRuntime } from '../test-support/session';
import { UsageBudget, resetUsageBudget } from '../../usage-budget';

/*
 * The real look action over a real session: the walk to the entity ends as `outcome`, with the
 * entity `distance` m from where the agent stands then. The picture and the vision call are
 * stand-ins; what is counted is the real usage budget.
 */
const noLimits = { aiCallsPerHour: null, aiTokensPerDay: null, visionPerHour: 10, ttsCharsPerDay: null, sttSecondsPerDay: null, autonomyAiPerHour: null, autonomyAiMinIntervalMs: 0 };

function looking(outcome: string, distance: number) {
  const budget = new UsageBudget(noLimits as any);
  resetUsageBudget(budget);
  const capture = vi.fn(async () => 'data:image/jpeg;base64,AAAA');
  const world = {
    controls: { followEntity: vi.fn(async () => outcome), stopAllActions: vi.fn() },
    entities: {
      player: { data: { id: 'coo' }, base: { position: new THREE.Vector3(0, 0, 0) } },
      items: new Map<string, unknown>([['chest', { data: { name: 'treasure chest' }, base: { position: new THREE.Vector3(distance, 0, 0) } }]]),
    },
  };
  const runtime: any = sessionRuntime({
    composeState: vi.fn(async () => ({ values: {}, data: {}, text: '' })),
    useModel: vi.fn(async () => '<response><thought>seen</thought><text>A shiny chest.</text></response>'),
  });
  const session = sessionFor(world, { runtime, renderPage: { capture } as any });
  runtime.getService = () => serviceFor(session);
  const callback = vi.fn(async () => []);
  const run = () =>
    hyperfyScenePerceptionAction.handler(runtime, { content: { text: 'look at the treasure chest', metadata: { hyperfyFromId: 'p1' } } } as any, {} as any, {}, callback as any);
  const visionUsed = () => budget.snapshot(60_000).vision;
  return { run, capture, runtime, callback, visionUsed };
}

describe('the look at an entity, after the walk there', () => {
  afterEach(() => {
    resetUsageBudget();
    vi.restoreAllMocks();
  });

  it.each([
    ['stopped', 5],
    ['replaced', 5],
    ['unreachable', 50],
    ['timed-out', 50],
  ])('takes no picture and makes no paid call when the walk ended %s (the entity %s m away), gives the look back, and says so', async (outcome, distance) => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const { run, capture, runtime, callback, visionUsed } = looking(outcome, distance);
    const result: any = await run();
    expect(capture).not.toHaveBeenCalled();
    expect(runtime.useModel).not.toHaveBeenCalled();
    expect(visionUsed()).toBe(0);
    expect(result).toMatchObject({ success: false });
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining("So I couldn't take a look at treasure chest.") }));
  });

  it.each([
    ['arrived', 2],
    ['timed-out', 15],
    ['unreachable', 19],
  ])('looks when the walk ended %s with the entity %s m away: a picture from here still shows it', async (outcome, distance) => {
    const { run, capture, runtime, visionUsed } = looking(outcome, distance);
    await run();
    expect(capture).toHaveBeenCalledTimes(1);
    expect(runtime.useModel).toHaveBeenCalledTimes(1);
    expect(visionUsed()).toBe(1);
  });
});
