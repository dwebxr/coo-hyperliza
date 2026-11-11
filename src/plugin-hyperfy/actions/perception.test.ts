import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hyperfyScenePerceptionAction } from './perception';
import { serviceFor, sessionFor, sessionRuntime } from '../test-support/session';
import { UsageBudget, resetUsageBudget } from '../../usage-budget';
import { TurnCancelled } from '../lib/turn-context';

/*
 * The real look action over a real session: the walk to the entity ends as `outcome`, with the
 * entity `distance` m from where the agent stands then. The picture and the vision call are
 * stand-ins; what is counted is the real usage budget.
 */
const noLimits = { aiCallsPerHour: null, aiTokensPerDay: null, visionPerHour: 10, ttsCharsPerDay: null, sttSecondsPerDay: null, autonomyAiPerHour: null, autonomyAiMinIntervalMs: 0 };

function looking(outcome: string, distance: number, duringWalk?: (items: Map<string, unknown>) => void) {
  const budget = new UsageBudget(noLimits as any);
  resetUsageBudget(budget);
  const capture = vi.fn(async () => 'data:image/jpeg;base64,AAAA');
  // The looks counted while the agent walks: the look is reserved before the walk starts
  const countedDuringWalk: number[] = [];
  const world = {
    controls: {
      followEntity: vi.fn(async () => {
        countedDuringWalk.push(budget.snapshot(60_000).vision);
        duringWalk?.(world.entities.items);
        return outcome;
      }),
      stopAllActions: vi.fn(),
    },
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
  return { run, capture, runtime, callback, visionUsed, countedDuringWalk };
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
    const { run, capture, runtime, callback, visionUsed, countedDuringWalk } = looking(outcome, distance);
    const result: any = await run();
    expect(capture).not.toHaveBeenCalled();
    expect(runtime.useModel).not.toHaveBeenCalled();
    // Counted while it walked, and given back when no picture was taken
    expect(countedDuringWalk).toEqual([1]);
    expect(visionUsed()).toBe(0);
    expect(result).toMatchObject({ success: false, data: { actionName: 'HYPERFY_SCENE_PERCEPTION' } });
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining("So I couldn't take a look at treasure chest.") }));
  });

  it.each([
    ['arrived', 2],
    ['timed-out', 15],
    ['unreachable', 19],
  ])('looks when the walk ended %s with the entity %s m away: a picture from here still shows it', async (outcome, distance) => {
    const { run, capture, runtime, visionUsed, countedDuringWalk } = looking(outcome, distance);
    await run();
    expect(countedDuringWalk).toEqual([1]);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(runtime.useModel).toHaveBeenCalledTimes(1);
    expect(visionUsed()).toBe(1);
  });

  it.each([
    ['removed', 'arrived'],
    ['removed', 'timed-out'],
    ['replaced by another entity under its id', 'unreachable'],
    ['destroyed', 'timed-out'],
  ])('takes no picture and makes no paid call when the entity was %s during the walk (which ended %s), and says it is not there', async (what, outcome) => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const { run, capture, runtime, callback, visionUsed } = looking(outcome, 5, (items) => {
      if (what === 'removed') items.delete('chest');
      else if (what === 'destroyed') Object.assign(items.get('chest') as object, { destroyed: true });
      else items.set('chest', { data: { name: 'treasure chest' }, base: { position: new THREE.Vector3(5, 0, 0) } });
    });
    const result: any = await run();
    expect(capture).not.toHaveBeenCalled();
    expect(runtime.useModel).not.toHaveBeenCalled();
    expect(visionUsed()).toBe(0);
    expect(result).toMatchObject({ success: false });
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ text: "I couldn't take a look at treasure chest: it isn't there any more." }));
  });

  it.each([
    ['before its request went out: the look is given back', false, 0],
    ['while its request was in flight: the look stays counted', true, 1],
  ])('ends with a cancelled turn when the vision call is cancelled %s', async (_what, afterRequest, counted) => {
    const { run, runtime, visionUsed } = looking('arrived', 2);
    const cancelled = new TurnCancelled('its slot ran out', afterRequest);
    runtime.useModel.mockRejectedValue(cancelled);
    await expect(run()).rejects.toBe(cancelled);
    expect(visionUsed()).toBe(counted);
  });

  it('judges a walk that did not arrive by where the entity is now, and takes the picture toward it there', async () => {
    // Near when the walk began, 50 m away when it timed out: no look
    const away = looking('timed-out', 5, (items) => void ((items.get('chest') as any).base = { position: new THREE.Vector3(50, 0, 0) }));
    vi.spyOn(console, 'info').mockImplementation(() => {});
    await away.run();
    expect(away.capture).not.toHaveBeenCalled();
    expect(away.visionUsed()).toBe(0);
    // Far when it began, 12 m away when it timed out: a picture toward where it is now
    const near = looking('timed-out', 50, (items) => void ((items.get('chest') as any).base = { position: new THREE.Vector3(0, 0, 12) }));
    await near.run();
    expect(near.capture).toHaveBeenCalledWith(expect.anything(), { kind: 'target', position: [0, 0, 12] }, expect.anything());
    expect(near.visionUsed()).toBe(1);
  });
});
