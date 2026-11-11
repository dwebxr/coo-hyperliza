import { EventType, ModelType } from '@elizaos/core';
import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hyperfyEventType, hyperfyEvents } from './events';
import { UsageBudget, resetUsageBudget } from '../usage-budget';
import { CHAT_TURN_SLOT_MS } from './lib/chat-intake';
import { installWorldChat } from './lib/world-chat';
import type { ConnectionSession } from './session/connection-session';
import { AgentActions } from './systems/actions';
import { AgentControls } from './systems/controls';
import { createRuntime } from './test-support/core-runtime';
import { serviceFor, sessionFor } from './test-support/session';
import { worldFromSnapshot } from './test-support/turns';
import { cooWorldChat, cooWorldSnapshot } from './test-support/world-packets';

/*
 * Whole turns, from a chat packet to what the world is sent: the real session with its real
 * conversation queue and managers, the plugin's real message handler, real elizaOS core
 * processActions, the real actions, the real controls and build manager, and the real world chat.
 * The model is a stub per call, and the player stands in for the engine's: while the agent holds
 * W it moves, as physics would move it. Time is the test's (fake timers).
 */

const noLimits = {
  aiCallsPerHour: null,
  aiTokensPerDay: null,
  visionPerHour: null,
  ttsCharsPerDay: null,
  sttSecondsPerDay: null,
  autonomyAiPerHour: null,
  autonomyAiMinIntervalMs: 0,
};
const FAR = 1_000_000;
const plan = (actions: string, text = '') => `<response><thought>t</thought><actions>${actions}</actions>${text ? `<text>${text}</text>` : ''}</response>`;
const move = (target: string, description: string) => ({ success: true, operation: 'translate', target, parameters: { position: [0, 2, 0] }, description });

const sessions: ConnectionSession[] = [];
let synthesize: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubEnv('HYPERFY_SCENE_EDITS', 'builders');
  resetUsageBudget(new UsageBudget(noLimits));
  for (const method of ['log', 'info', 'warn', 'debug'] as const) vi.spyOn(console, method).mockImplementation(() => {});
  // Nothing is synthesized here; what counts is whether speech was asked for at all
  const utils = await import('./utils');
  synthesize = vi.spyOn(utils, 'generateSpeech').mockResolvedValue(null) as never;
});
afterEach(async () => {
  for (const session of sessions.splice(0)) void session.end();
  await vi.advanceTimersByTimeAsync(0);
  vi.useRealTimers();
  resetUsageBudget();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/** A world with the real controls and actions systems, a builder (Bob), a box next to the agent and things far away. */
function scene() {
  const sent: [string, any][] = [];
  const app = (id: string, x: number) => ({ isApp: true, data: { id }, root: { position: new THREE.Vector3(x, 0, 0), quaternion: new THREE.Quaternion(), scale: new THREE.Vector3(1, 1, 1) } });
  const player = { data: { id: 'coo', name: 'Coo' }, base: { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() }, cam: { rotation: { y: 0 } }, teleport: vi.fn() };
  const bob = { isPlayer: true, data: { id: 'builder-1', type: 'player', name: 'Bob' }, base: { position: new THREE.Vector3(25, 0, 0) } };
  const items = new Map<string, any>([
    ['coo', player],
    ['builder-1', bob],
    ['box', app('box', 1)],
    ['far-box', app('far-box', FAR)],
    ['tower', { data: { id: 'tower', name: 'Tower' }, base: { position: new THREE.Vector3(FAR, 0, 0) } }],
  ]);
  const world: any = worldFromSnapshot(cooWorldSnapshot({ selfId: 'coo', players: [{ id: 'builder-1', name: 'Bob', rank: 1 }] }), {
    network: { send: (name: string, data: unknown) => void sent.push([name, data]) },
    chat: { msgs: [], listeners: new Set(), add: vi.fn() },
    events: { emit: vi.fn() },
    rig: { position: new THREE.Vector3() },
    camera: { position: { z: 10 } },
    entities: { player, items, getPlayer: (id: string) => (id === 'builder-1' ? bob : undefined) },
  });
  installWorldChat(world);
  const controls = new AgentControls(world);
  world.controls = controls;
  world.actions = new AgentActions(world);
  // 5 m/s while W is held
  setInterval(() => {
    if (controls.keyW.down) player.base.position.x += 0.5;
  }, 100);
  const posted = () => sent.filter(([name]) => name === 'chatAdded').map(([, msg]) => msg.body as string);
  const edits = () => sent.filter(([name]) => name === 'entityModified').map(([, data]) => data.id as string);
  const walking = () => controls.keyW.down === true;
  return { world, controls, player, bob, items, sent, posted, edits, walking };
}

/** The agent connected to `world` with the model answering as `models` say; `say` is a chat packet from Bob. */
function connected(on: ReturnType<typeof scene>, models: Record<string, unknown>, parts: Parameters<typeof sessionFor>[1] = {}) {
  let session: ConnectionSession | null = null;
  const { runtime, recorded, useModel } = createRuntime({ service: serviceFor(() => session), models });
  vi.spyOn(runtime, 'ensureConnection').mockResolvedValue(undefined);
  vi.spyOn(runtime, 'getEntityById').mockResolvedValue({ id: crypto.randomUUID() } as never);
  for (const handler of hyperfyEvents[hyperfyEventType.MESSAGE_RECEIVED]) runtime.registerEvent(hyperfyEventType.MESSAGE_RECEIVED, handler as never);
  const open = (world: object) => {
    const opened = sessionFor(world, { runtime, connected: false, ...parts });
    // Not what these tests are about, and they would run for the whole test
    for (const loop of [opened.voice, opened.behavior, opened.appearance]) loop.start = () => {};
    opened.start();
    sessions.push(opened);
    session = opened;
    return opened;
  };
  const first = open(on.world);
  let messages = 0;
  const say = (body: string, world: any = on.world) => world.network.onChatAdded(cooWorldChat(`m${++messages}`, 'builder-1', 'Bob', body));
  const calls = (type: string) => useModel.mock.calls.filter(([called]) => called === type).length;
  /** The actions core recorded a result for, with the status it stored */
  const results = () => recorded.memories.filter((m) => m.content.type === 'action_result').map((m) => `${m.content.actionName}: ${m.content.actionStatus}`);
  return { session: first, open, runtime, recorded, useModel, say, calls, results };
}

/**
 * A model answer that takes `ms`. A walk ends by itself after NAVIGATION_TIMEOUT_MS, which is less
 * than a turn's slot: for a slot to run out during a walk, the turn has to spend time before it.
 */
const after = (ms: number, answer: unknown) => () => new Promise((resolve) => setTimeout(() => resolve(answer), ms));
const THINKING_MS = 90_000;

/** Answers model calls of one type in turn: the n-th call gets the n-th answer (a value, or a function of the params) */
function inTurn(...answers: unknown[]) {
  let call = 0;
  return (params: unknown) => {
    const answer = answers[Math.min(call++, answers.length - 1)];
    return typeof answer === 'function' ? (answer as (params: unknown) => unknown)(params) : answer;
  };
}

describe('a turn that outlives its slot', () => {
  it('stops walking when its slot runs out, and after that edits nothing, posts nothing and says nothing: the rest of its plan is not run', async () => {
    const on = scene();
    const agent = connected(on, {
      [ModelType.TEXT_LARGE]: inTurn(plan('REPLY,HYPERFY_GOTO_ENTITY,HYPERFY_EDIT_ENTITY', 'On my way!'), plan('REPLY', 'Second answer')),
      // The walk's target; the scene edit's plan, should it ever be asked for
      [ModelType.OBJECT_LARGE]: inTurn(after(THINKING_MS, { navigationType: 'entity', parameter: { entityId: 'tower' } }), { operations: [move('box', 'Moved the box up')] }),
      [ModelType.TEXT_SMALL]: '<response><thought>t</thought><text>Box is up!</text></response>',
    });
    agent.say('Coo, go to the tower, then move the box up');
    await vi.advanceTimersByTimeAsync(100_000);
    expect(on.posted()).toEqual(['On my way!']);
    expect([on.controls.getIsNavigating(), on.walking(), agent.session.body.busy]).toEqual([true, true, true]);
    agent.say('Coo, are you there?');

    // Up to the last moment of its slot the turn walks on, and the next message waits
    await vi.advanceTimersByTimeAsync(CHAT_TURN_SLOT_MS - 100_000 - 100);
    expect([on.controls.getIsNavigating(), agent.session.conversation.waiting]).toEqual([true, 1]);
    const spoken = synthesize.mock.calls.length;

    await vi.advanceTimersByTimeAsync(200);
    // The walk has stopped where it was
    expect([on.controls.getIsNavigating(), on.walking()]).toEqual([false, false]);
    const stoppedAt = on.player.base.position.x;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(on.player.base.position.x).toBe(stoppedAt);
    expect(agent.session.body.busy).toBe(false);

    // The next message was answered; of the first turn nothing more reached the world
    expect(on.posted()).toEqual(['On my way!', 'Second answer']);
    expect(on.edits()).toEqual([]);
    expect(on.items.get('box').root.position.toArray()).toEqual([1, 0, 0]);
    // No "Arrived" and no summary were said aloud either: speech was asked for the second answer only
    expect(synthesize.mock.calls.slice(spoken).map(([text]) => text)).toEqual(['Second answer']);
    // The plan stopped at the walk: no navigation result was recorded as done, the edit never started
    expect(agent.results()).toEqual(['REPLY: completed', 'REPLY: completed']);
    expect(agent.calls(ModelType.OBJECT_LARGE)).toBe(1);
    expect(agent.calls(ModelType.TEXT_SMALL)).toBe(0);
  });

  it('a scene edit that outlives its slot announces nothing and edits nothing further (what it did before stands)', async () => {
    const on = scene();
    const agent = connected(on, {
      [ModelType.TEXT_LARGE]: inTurn(plan('HYPERFY_EDIT_ENTITY'), plan('REPLY', 'Second answer')),
      // The box next to the agent, then one it never reaches within its slot
      [ModelType.OBJECT_LARGE]: after(THINKING_MS, { operations: [move('box', 'Moved the box up'), move('far-box', 'Moved the far box up'), move('box', 'Moved the box again')] }),
      [ModelType.TEXT_SMALL]: '<response><thought>t</thought><text>All done!</text></response>',
    });
    agent.say('Coo, move the boxes up');
    await vi.advanceTimersByTimeAsync(100_000);
    expect(on.edits()).toEqual(['box']);
    expect(on.posted()).toEqual(['Moved the box up']);
    expect(on.walking()).toBe(true);
    agent.say('Coo, are you there?');

    await vi.advanceTimersByTimeAsync(CHAT_TURN_SLOT_MS - 100_000);
    expect([on.controls.getIsNavigating(), on.walking()]).toEqual([false, false]);
    await vi.advanceTimersByTimeAsync(60_000);
    // Nothing of the edit after its slot: no further change, no announcement, no summary, no closing line
    expect(on.edits()).toEqual(['box']);
    expect(on.items.get('far-box').root.position.toArray()).toEqual([FAR, 0, 0]);
    expect(on.posted()).toEqual(['Moved the box up', 'Second answer']);
    expect(agent.calls(ModelType.TEXT_SMALL)).toBe(0);
    // What core recorded of the edit says what was done and what was not
    const edit = agent.recorded.memories.find((m) => m.content.actionName === 'HYPERFY_EDIT_ENTITY')!.content as any;
    expect(edit.actionStatus).toBe('failed');
    expect(edit.actionResult.data).toMatchObject({ executed: 1, failed: 2 });
    expect(edit.actionResult.data.outcomes.map((o: any) => o.reason)).toEqual([undefined, 'not run: the turn was cancelled or its connection ended', 'not run: the turn was cancelled or its connection ended']);
  });
});

describe('a walk that "stop" ended', () => {
  it('is not reported as arrived: the walk\'s turn says it stopped, and core records the walk as failed', async () => {
    const on = scene();
    const agent = connected(on, {
      [ModelType.TEXT_LARGE]: plan('HYPERFY_GOTO_ENTITY'),
      [ModelType.OBJECT_LARGE]: { navigationType: 'entity', parameter: { entityId: 'tower' } },
    });
    agent.say('Coo, go to the tower');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(on.walking()).toBe(true);
    agent.say('Coo, stop!');
    // At once, on arrival
    expect(on.walking()).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    await agent.session.conversation.idle();
    expect(on.posted()).toEqual(['I stopped before I got there.', "Okay, I'll stay right here."]);
    expect(on.posted().join(' ')).not.toMatch(/Arrived/);
    expect(agent.results()).toEqual(['HYPERFY_GOTO_ENTITY: failed']);
    const walk = agent.recorded.memories.find((m) => m.content.actionName === 'HYPERFY_GOTO_ENTITY')!.content as any;
    expect(walk.actionResult).toMatchObject({ error: 'did not arrive (stopped)', data: { outcome: 'stopped' } });
  });

  it('leaves the scene edit it was walking to undone, and the edit says so', async () => {
    const on = scene();
    const agent = connected(on, {
      [ModelType.TEXT_LARGE]: plan('HYPERFY_EDIT_ENTITY'),
      [ModelType.OBJECT_LARGE]: { operations: [move('far-box', 'Moved the far box up')] },
      [ModelType.TEXT_SMALL]: (params: any) => `<response><thought>t</thought><text>${/NOT DONE \(skipped\): translate on "far-box" → I was stopped on the way there/.test(params.prompt) ? 'I stopped before moving it.' : 'Moved it!'}</text></response>`,
    });
    agent.say('Coo, move the far box up');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(on.walking()).toBe(true);
    agent.say('Coo, stop!');
    await vi.advanceTimersByTimeAsync(5_000);
    await agent.session.conversation.idle();
    // Nothing was changed and nothing announced as done
    expect(on.edits()).toEqual([]);
    expect(on.items.get('far-box').root.position.toArray()).toEqual([FAR, 0, 0]);
    expect(on.posted()).toEqual(['I stopped before moving it.', "Okay, I'll stay right here."]);
    const edit = agent.recorded.memories.find((m) => m.content.actionName === 'HYPERFY_EDIT_ENTITY')!.content as any;
    expect(edit.actionStatus).toBe('failed');
    expect(edit.actionResult.data).toMatchObject({ executed: 0, skipped: 1, failed: 0 });
    expect(edit.actionResult.data.outcomes).toEqual([{ operation: 'translate', target: 'far-box', outcome: 'skipped', reason: 'I was stopped on the way there' }]);
  });
});

describe('what a turn was about to do when its slot ran out', () => {
  it('does not use the item it was walking to', async () => {
    const on = scene();
    on.items.set('far-crate', { data: { id: 'far-crate' }, root: { position: new THREE.Vector3(FAR, 0, 0) } });
    const node = { ctx: { entity: on.items.get('far-crate') }, _duration: 0, _onTrigger: vi.fn() };
    on.world.actions.register(node);
    const agent = connected(on, { [ModelType.TEXT_LARGE]: plan('HYPERFY_USE_ITEM'), [ModelType.OBJECT_SMALL]: after(THINKING_MS, { entityId: 'far-crate' }) });
    agent.say('Coo, use the crate over there');
    await vi.advanceTimersByTimeAsync(CHAT_TURN_SLOT_MS - 1_000);
    expect(on.walking()).toBe(true);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(on.walking()).toBe(false);
    expect(on.controls.keyE.down).toBe(false);
    expect(node._onTrigger).not.toHaveBeenCalled();
    expect(agent.results()).toEqual([]);
    expect(on.posted()).toEqual([]);
  });

  it('takes no picture and asks no model about it, and gives the look back to the budget', async () => {
    const on = scene();
    const budget = new UsageBudget({ ...noLimits, visionPerHour: 1 });
    resetUsageBudget(budget);
    const renderPage = { capture: vi.fn(async () => 'data:image/jpeg;base64,aGVsbG8='), resetPage: vi.fn(async () => {}) };
    const agent = connected(on, { [ModelType.TEXT_LARGE]: after(THINKING_MS, plan('HYPERFY_SCENE_PERCEPTION')), [ModelType.IMAGE_DESCRIPTION]: '<response><thought>t</thought><text>A tower.</text></response>' }, { renderPage });
    // Looking at the tower means walking up to it first
    agent.say('Coo, look at the Tower');
    await vi.advanceTimersByTimeAsync(CHAT_TURN_SLOT_MS - 1_000);
    expect([on.walking(), budget.snapshot(60 * 60_000).vision]).toEqual([true, 1]);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(on.walking()).toBe(false);
    expect(renderPage.capture).not.toHaveBeenCalled();
    expect(agent.calls(ModelType.IMAGE_DESCRIPTION)).toBe(0);
    expect(budget.snapshot(60 * 60_000).vision).toBe(0);
    // The look ended with its turn: it is not recorded as a look that failed, and nothing is said about it
    expect(agent.results()).toEqual([]);
    expect(on.posted()).toEqual([]);
  });
});

describe('a walk a turn leaves running', () => {
  it('goes on after the turn completed (follow), and stops when the session ends', async () => {
    const on = scene();
    // Bob keeps walking away as fast as the agent follows
    setInterval(() => void (on.bob.base.position.x += 0.5), 100);
    const agent = connected(on, {});
    agent.say('Coo, come here!');
    await vi.advanceTimersByTimeAsync(1_000);
    await agent.session.conversation.idle();
    expect(on.posted()).toEqual(['On my way!']);
    expect(agent.useModel).not.toHaveBeenCalled();
    expect([on.controls.getIsNavigating(), on.walking(), agent.session.body.busy]).toEqual([true, true, false]);

    await vi.advanceTimersByTimeAsync(60_000);
    expect([on.controls.getIsNavigating(), on.walking()]).toEqual([true, true]);
    expect(on.player.base.position.x).toBeGreaterThan(250);

    void agent.session.end();
    expect([on.controls.getIsNavigating(), on.walking()]).toEqual([false, false]);
    const stoppedAt = on.player.base.position.x;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(on.player.base.position.x).toBe(stoppedAt);
  });

  it('goes on after the turn completed (wander), and stops when the session ends', async () => {
    const on = scene();
    const agent = connected(on, { [ModelType.TEXT_LARGE]: plan('HYPERFY_WALK_RANDOMLY') });
    agent.say('Coo, wander around a bit');
    await vi.advanceTimersByTimeAsync(1_000);
    await agent.session.conversation.idle();
    expect(agent.results()).toEqual(['HYPERFY_WALK_RANDOMLY: completed']);
    expect(on.controls.getIsWalkingRandomly()).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(on.controls.getIsWalkingRandomly()).toBe(true);

    void agent.session.end();
    expect([on.controls.getIsWalkingRandomly(), on.controls.getIsNavigating(), on.walking()]).toEqual([false, false, false]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect([on.controls.getIsWalkingRandomly(), on.walking()]).toEqual([false, false]);
  });
});

describe('a turn whose connection was replaced', () => {
  it.each([
    ['a new world object', () => scene()],
    ['the same world object', (on: ReturnType<typeof scene>) => on],
  ])('does not walk, edit or post on the new connection (%s)', async (_what, next) => {
    const on = scene();
    let replacement!: ReturnType<typeof scene>;
    let newer!: ConnectionSession;
    let postedBefore: string[] | undefined;
    const agent: ReturnType<typeof connected> = connected(on, {
      [ModelType.TEXT_LARGE]: plan('HYPERFY_GOTO_ENTITY,HYPERFY_EDIT_ENTITY,REPLY', 'Done!'),
      [ModelType.OBJECT_LARGE]: inTurn(() => {
        // The connection is replaced while the model is asked where to go
        postedBefore = on.posted();
        replacement = next(on);
        void agent.session.end();
        newer = agent.open(replacement.world);
        return { navigationType: 'entity', parameter: { entityId: 'tower' } };
      }, { operations: [move('box', 'Moved the box up')] }),
      [ModelType.TEXT_SMALL]: '<response><thought>t</thought><text>Box is up!</text></response>',
    });
    const follow = vi.spyOn(on.controls, 'followEntity');
    agent.say('Coo, go to the tower, then move the box up');
    await vi.advanceTimersByTimeAsync(30_000);

    expect(agent.session.ended).toBe(true);
    expect(newer.ended).toBe(false);
    // REPLY comes first in a plan and went out on the old connection, before it was replaced
    expect(postedBefore).toEqual(['Done!']);
    // Nothing was posted since, on the old world or on the new one
    expect(on.posted()).toEqual(['Done!']);
    expect(replacement.posted()).toEqual(replacement === on ? ['Done!'] : []);
    expect(follow).not.toHaveBeenCalled();
    for (const world of [on, replacement]) {
      expect([world.controls.getIsNavigating(), world.walking()]).toEqual([false, false]);
      expect(world.edits()).toEqual([]);
      expect(world.items.get('box').root.position.toArray()).toEqual([1, 0, 0]);
    }
    expect(agent.calls(ModelType.OBJECT_LARGE)).toBe(1);

    // The new connection works: a message on it gets its own turn
    agent.say('Coo, come here!', replacement.world);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(replacement.posted().at(-1)).toBe('On my way!');
    expect(replacement.controls.getIsNavigating()).toBe(true);
  });
});

describe("a scene edit's closing message", () => {
  it('is replaced by the neutral line when the requester was demoted after the edit handed it over: core delivers it later, and it is checked then', async () => {
    const on = scene();
    const agent = connected(on, {
      [ModelType.TEXT_LARGE]: plan('HYPERFY_EDIT_ENTITY'),
      [ModelType.OBJECT_LARGE]: { operations: [move('box', 'Moved the box up')] },
      [ModelType.TEXT_SMALL]: '<response><thought>t</thought><text>The box is up where you wanted it!</text><emote>cheer</emote></response>',
    });
    // Core announces that the action has completed, then delivers what the action handed its
    // callback. In between, the world takes the builder rank away.
    const order: string[] = [];
    agent.runtime.registerEvent(EventType.ACTION_COMPLETED, (async () => {
      order.push('action completed');
      on.world.network.onEntityModified({ id: 'builder-1', rank: 0 });
    }) as never);
    agent.say('Coo, move the box up');
    await vi.advanceTimersByTimeAsync(10_000);
    await agent.session.conversation.idle();

    expect(order).toEqual(['action completed']);
    // The edit itself was made and announced while the requester was a builder
    expect(on.edits()).toEqual(['box']);
    expect(agent.calls(ModelType.TEXT_SMALL)).toBe(1);
    expect(on.posted()).toEqual(['Moved the box up', "I can't go any further with that request."]);
    expect(synthesize.mock.calls.map(([text]) => text)).toEqual(["I can't go any further with that request."]);
    // Remembered as what was said, not as what the summary would have said
    const said = agent.recorded.memories.map((m) => JSON.stringify(m.content)).filter((content) => content.includes('where you wanted it'));
    expect(said).toEqual([]);
  });

  it('is delivered as the edit wrote it while the requester is still a builder (control)', async () => {
    const on = scene();
    const agent = connected(on, {
      [ModelType.TEXT_LARGE]: plan('HYPERFY_EDIT_ENTITY'),
      [ModelType.OBJECT_LARGE]: { operations: [move('box', 'Moved the box up')] },
      [ModelType.TEXT_SMALL]: '<response><thought>t</thought><text>The box is up where you wanted it!</text></response>',
    });
    agent.say('Coo, move the box up');
    await vi.advanceTimersByTimeAsync(10_000);
    await agent.session.conversation.idle();
    expect(on.posted()).toEqual(['Moved the box up', 'The box is up where you wanted it!']);
  });
});
