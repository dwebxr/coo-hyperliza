import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelType } from '@elizaos/core';
import * as THREE from 'three';
import { messageReceivedHandler } from './messageReceivedHandler';
import { AiBudgetExceededError, UsageBudget, resetUsageBudget } from '../../usage-budget';
import { AnthropicRefusalError } from '../../anthropic-models';
import { installWorldChat } from '../lib/world-chat';
import { connectedService, createRuntime } from '../test-support/core-runtime';
import { serviceFor, sessionFor, withParts } from '../test-support/session';
import type { ConnectionSession } from '../session/connection-session';
import { hyperfyEventType, hyperfyEvents } from '../events';
import { cooWorldSnapshot } from '../test-support/world-packets';
import { inChatTurn, inTurn, worldFromSnapshot } from '../test-support/turns';
import { currentTurn } from '../lib/turn-context';

function setup({ embeddingModel, embeddingError }: { embeddingModel: boolean; embeddingError?: Error }) {
  const runtime: any = {
    agentId: '00000000-0000-0000-0000-0000000000aa',
    character: { name: 'Coo', system: '' },
    emitEvent: vi.fn().mockResolvedValue(undefined),
    getModel: vi.fn((type: string) => (type === ModelType.TEXT_EMBEDDING && embeddingModel ? () => [] : undefined)),
    addEmbeddingToMemory: vi.fn(() => (embeddingError ? Promise.reject(embeddingError) : Promise.resolve())),
    createMemory: vi.fn().mockResolvedValue(undefined),
    getParticipantUserState: vi.fn().mockResolvedValue(null),
    composeState: vi.fn().mockResolvedValue({ values: {}, data: {}, text: '' }),
    useModel: vi.fn().mockResolvedValue('<response><thought>hi</thought><actions>REPLY</actions><text>Hello!</text></response>'),
    processActions: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue(undefined),
  };
  const message: any = {
    id: '00000000-0000-0000-0000-000000000001',
    entityId: '00000000-0000-0000-0000-0000000000bb',
    roomId: '00000000-0000-0000-0000-0000000000cc',
    // directly addressed, so the handler goes straight to the reply
    content: { text: 'Coo, hello', metadata: { directlyAddressed: true } },
  };
  return { runtime, message };
}

describe('messageReceivedHandler reply fields', () => {
  it('passes extra reply tags such as <productId> through to the actions', async () => {
    const { runtime, message } = setup({ embeddingModel: false });
    runtime.useModel.mockResolvedValue(
      '<response><thought>sell</thought><actions>REPLY,OPENPAY_SHARE_PRODUCT</actions><text>Here!</text><productId>h_board</productId></response>'
    );
    await messageReceivedHandler({ runtime, message, callback: vi.fn() } as any);
    const responses = runtime.processActions.mock.calls[0][1];
    expect(responses[0].content.productId).toBe('h_board');
    expect(responses[0].content.actions).toEqual(['REPLY', 'OPENPAY_SHARE_PRODUCT']);
  });

  it('drops blank action names (core would run its first registered action for "")', async () => {
    const { runtime, message } = setup({ embeddingModel: false });
    runtime.useModel.mockResolvedValue('<response><thought>t</thought><actions>REPLY, ,HYPERFY_GOTO_ENTITY,</actions><text>Hi</text></response>');
    await messageReceivedHandler({ runtime, message, callback: vi.fn() } as any);
    expect(runtime.processActions.mock.calls[0][1][0].content.actions).toEqual(['REPLY', 'HYPERFY_GOTO_ENTITY']);
  });
});

describe('messageReceivedHandler and a turn that may no longer act', () => {
  it("runs none of the plan when the model's answer comes back after the turn was cancelled, and answers nothing", async () => {
    const { runtime, message } = setup({ embeddingModel: false });
    const slot = new AbortController();
    runtime.useModel.mockImplementation(async () => {
      // The turn's slot runs out while Claude is asked
      slot.abort();
      return '<response><thought>t</thought><actions>REPLY,HYPERFY_GOTO_ENTITY</actions><text>On my way!</text></response>';
    });
    const callback = vi.fn();
    await inTurn({ origin: 'chat', world: {}, requesterId: 'p1', cancel: slot.signal }, () => messageReceivedHandler({ runtime, message, callback } as any));
    expect(runtime.useModel).toHaveBeenCalledTimes(1);
    expect(runtime.processActions).not.toHaveBeenCalled();
    expect(runtime.evaluate).not.toHaveBeenCalled();
    expect(callback).not.toHaveBeenCalled();
  });

  it('cancels the turn a newer message of the same room took the place of, so that nothing it started goes on', async () => {
    const { runtime, message } = setup({ embeddingModel: false });
    let finishFirst!: (answer: string) => void;
    const answer = '<response><thought>t</thought><actions>REPLY</actions><text>Hello!</text></response>';
    runtime.useModel.mockImplementationOnce(() => new Promise((resolve) => (finishFirst = resolve))).mockResolvedValue(answer);
    let older: ReturnType<typeof currentTurn>;
    const first = inTurn({ origin: 'chat', world: {}, requesterId: 'p1' }, async () => {
      older = currentTurn();
      await messageReceivedHandler({ runtime, message, callback: vi.fn() } as any);
    });
    await vi.waitFor(() => expect(runtime.useModel).toHaveBeenCalledTimes(1));
    // A second message in the same room is handled while the first still waits for its answer
    await inTurn({ origin: 'chat', world: {}, requesterId: 'p2' }, () => messageReceivedHandler({ runtime, message: { ...message, id: '00000000-0000-0000-0000-000000000002' }, callback: vi.fn() } as any));
    expect(runtime.processActions).toHaveBeenCalledTimes(1);
    finishFirst(answer);
    await first;
    expect(runtime.processActions).toHaveBeenCalledTimes(1);
    expect(older!.live).toBe(false);
    expect(() => older!.assertLive()).toThrow('a newer message took its place');
  });
});

describe('messageReceivedHandler embeddings', () => {
  it('replies without trying to embed when no embedding model is registered', async () => {
    const { runtime, message } = setup({ embeddingModel: false });
    await messageReceivedHandler({ runtime, message, callback: vi.fn() } as any);
    expect(runtime.addEmbeddingToMemory).not.toHaveBeenCalled();
    expect(runtime.createMemory).toHaveBeenCalled();
    expect(runtime.processActions).toHaveBeenCalled();
  });

  it('still replies when the embedding provider fails (e.g. out of API credits)', async () => {
    const { runtime, message } = setup({ embeddingModel: true, embeddingError: new Error('401 Unauthorized') });
    await messageReceivedHandler({ runtime, message, callback: vi.fn() } as any);
    expect(runtime.addEmbeddingToMemory).toHaveBeenCalled();
    expect(runtime.createMemory).toHaveBeenCalled();
    expect(runtime.processActions).toHaveBeenCalled();
  });
});

describe('messageReceivedHandler cost controls', () => {
  const noLimits = {
    aiCallsPerHour: null,
    aiTokensPerDay: null,
    visionPerHour: null,
    ttsCharsPerDay: null,
    sttSecondsPerDay: null,
    autonomyAiPerHour: null,
    autonomyAiMinIntervalMs: 0,
  };
  afterEach(() => resetUsageBudget());

  function world() {
    const controls = { followEntity: vi.fn().mockResolvedValue('arrived'), teleportToEntity: vi.fn(), stopAllActions: vi.fn() };
    const at = (x: number) => ({ base: { position: { distanceTo: (o: any) => Math.abs(o.x - x), x } } });
    const items = new Map<string, any>([['player-bob', at(5)]]);
    return { controls, entities: { items, player: at(0) } };
  }

  it('carries out "come here" from the speaker without a model call', async () => {
    const { runtime, message } = setup({ embeddingModel: false });
    const w = world();
    const session = sessionFor(w);
    runtime.getService = vi.fn(() => serviceFor(session));
    message.content = { text: 'Coo, come here!', metadata: { directlyAddressed: true, hyperfyFromId: 'player-bob' } };
    const callback = vi.fn();
    await messageReceivedHandler({ runtime, message, callback } as any);
    expect(runtime.useModel).not.toHaveBeenCalled();
    // The walk is tied to what it is for (here, outside a turn, the connection)
    expect(w.controls.followEntity).toHaveBeenCalledWith('player-bob', undefined, { signal: session.signal });
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ text: 'On my way!', actions: ['HYPERFY_GOTO_ENTITY'] }));
  });

  it('"come here" from far away teleports, and says it is on its way only when the teleport was made', async () => {
    for (const [made, answered] of [['arrived', true], ['unreachable', false]] as const) {
      const { runtime, message } = setup({ embeddingModel: false });
      const w = world();
      // Beyond walking distance
      w.entities.items.set('player-bob', { base: { position: { x: 500, distanceTo: (o: any) => Math.abs(o.x - 500) } } });
      w.controls.teleportToEntity.mockReturnValue(made);
      runtime.getService = vi.fn(() => serviceFor(sessionFor(w)));
      message.content = { text: 'Coo, come here!', metadata: { directlyAddressed: true, hyperfyFromId: 'player-bob' } };
      const callback = vi.fn();
      await messageReceivedHandler({ runtime, message, callback } as any);
      expect(w.controls.teleportToEntity).toHaveBeenCalledWith('player-bob');
      expect(w.controls.followEntity).not.toHaveBeenCalled();
      const said = callback.mock.calls.some(([content]) => content.text === 'On my way!');
      expect(said, made).toBe(answered);
      // Not handled as a simple command then: the turn goes on to the model like any other message
      expect(runtime.useModel.mock.calls.length > 0, made).toBe(!answered);
    }
  });

  it('stops on "stop" without a model call; one that already stopped the agent when it arrived is only acknowledged', async () => {
    const { runtime, message } = setup({ embeddingModel: false });
    const w = world();
    runtime.getService = vi.fn(() => serviceFor(sessionFor(w)));
    const callback = vi.fn();
    message.content = { text: 'Coo, stop!', metadata: { directlyAddressed: true, hyperfyFromId: 'player-bob' } };
    await messageReceivedHandler({ runtime, message, callback } as any);
    expect(w.controls.stopAllActions).toHaveBeenCalledTimes(1);
    message.content = { text: 'Coo, stop!', metadata: { directlyAddressed: true, hyperfyFromId: 'player-bob', hyperfyStopTaken: true } };
    await messageReceivedHandler({ runtime, message: { ...message, id: '00000000-0000-0000-0000-000000000003' }, callback } as any);
    expect(w.controls.stopAllActions).toHaveBeenCalledTimes(1);
    expect(runtime.useModel).not.toHaveBeenCalled();
    expect(callback.mock.calls.map(([content]) => content.actions)).toEqual([['HYPERFY_STOP_MOVING'], ['HYPERFY_STOP_MOVING']]);
  });

  it('ignores a bare "stop" in a MUTED room, by the rule a stop on arrival also follows (lib/room-state.ts), and takes "Coo, stop"', async () => {
    const { runtime, message } = setup({ embeddingModel: false });
    const w = world();
    runtime.getService = vi.fn(() => serviceFor(sessionFor(w)));
    runtime.getParticipantUserState = vi.fn().mockResolvedValue('MUTED');
    const callback = vi.fn();
    message.content = { text: 'stop', metadata: { soloPlayer: true, hyperfyFromId: 'player-bob' } };
    await messageReceivedHandler({ runtime, message, callback } as any);
    expect([w.controls.stopAllActions.mock.calls.length, callback.mock.calls.length]).toEqual([0, 0]);
    message.content = { text: 'Coo, stop', metadata: { directlyAddressed: true, hyperfyFromId: 'player-bob' } };
    await messageReceivedHandler({ runtime, message: { ...message, id: '00000000-0000-0000-0000-000000000004' }, callback } as any);
    expect([w.controls.stopAllActions.mock.calls.length, callback.mock.calls.length]).toEqual([1, 1]);
  });

  it('says it cannot find the speaker, and walks nowhere, when they left while "come here" waited for the avatar', async () => {
    const { runtime, message } = setup({ embeddingModel: false });
    const w = world();
    const session = sessionFor(w);
    runtime.getService = vi.fn(() => serviceFor(session));
    // Something else has the avatar for now
    let done!: () => void;
    const busy = session.withBody(() => new Promise<void>((resolve) => (done = resolve)));
    message.content = { text: 'Coo, come here!', metadata: { directlyAddressed: true, hyperfyFromId: 'player-bob' } };
    const callback = vi.fn();
    const handling = messageReceivedHandler({ runtime, message, callback } as any);
    await new Promise((resolve) => setTimeout(resolve, 10));
    w.entities.items.delete('player-bob');
    done();
    await busy;
    await handling;
    expect(w.controls.followEntity).not.toHaveBeenCalled();
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ text: "Hmm, I can't find you right now.", actions: ['REPLY'] }));
    expect(runtime.useModel).not.toHaveBeenCalled();
  });

  it('leaves "come here" to the model when it is not addressed to the agent', async () => {
    const { runtime, message } = setup({ embeddingModel: false });
    runtime.getService = vi.fn(() => serviceFor(sessionFor(world())));
    message.content = { text: 'come here', metadata: { hyperfyFromId: 'player-bob' } };
    await messageReceivedHandler({ runtime, message, callback: vi.fn() } as any);
    expect(runtime.useModel).toHaveBeenCalled();
  });

  it('answers without Claude once the budget is used up, and only once per player for a while', async () => {
    resetUsageBudget(new UsageBudget({ ...noLimits, aiCallsPerHour: 0 }));
    const { runtime, message } = setup({ embeddingModel: false });
    message.entityId = '00000000-0000-0000-0000-0000000000dd';
    const callback = vi.fn();
    await messageReceivedHandler({ runtime, message, callback } as any);
    await messageReceivedHandler({ runtime, message: { ...message, id: '00000000-0000-0000-0000-000000000002' }, callback } as any);
    expect(runtime.useModel).not.toHaveBeenCalled();
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback.mock.calls[0][0].text).toContain('short break');
  });

  it('stays silent when the budget is used up and the message was not for the agent', async () => {
    resetUsageBudget(new UsageBudget({ ...noLimits, aiCallsPerHour: 0 }));
    const { runtime, message } = setup({ embeddingModel: false });
    message.content = { text: 'hi all', metadata: {} };
    const callback = vi.fn();
    await messageReceivedHandler({ runtime, message, callback } as any);
    expect(callback).not.toHaveBeenCalled();
  });

  it('tags the reply call and does not regenerate a reply just because its thought is empty', async () => {
    const { runtime, message } = setup({ embeddingModel: false });
    runtime.useModel.mockResolvedValue('<response><actions>REPLY</actions><text>Hi!</text></response>');
    await messageReceivedHandler({ runtime, message, callback: vi.fn() } as any);
    expect(runtime.useModel).toHaveBeenCalledTimes(1);
    expect(runtime.useModel.mock.calls[0][1]).toMatchObject({ purpose: 'chat' });
  });

  it('retries an unparseable reply only once', async () => {
    const { runtime, message } = setup({ embeddingModel: false });
    runtime.useModel.mockResolvedValue('not xml at all');
    await messageReceivedHandler({ runtime, message, callback: vi.fn() } as any);
    expect(runtime.useModel).toHaveBeenCalledTimes(2);
  });
});

/*
 * The real handler driving real elizaOS core processActions and the plugin's real actions: what
 * the player gets when an action runs out of budget or the model declines.
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

describe('messageReceivedHandler answers when an action stops the turn before anything reached the player', () => {
  afterEach(() => {
    resetUsageBudget();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  function realTurn(plan: string, models: Record<string, unknown>, service: unknown) {
    const { runtime } = createRuntime({ service, models: { [ModelType.TEXT_LARGE]: plan, ...models } });
    const message: any = {
      id: crypto.randomUUID(),
      entityId: crypto.randomUUID(),
      roomId: crypto.randomUUID(),
      content: { text: 'Coo, use the crate', source: 'hyperfy', metadata: { directlyAddressed: true, hyperfyFromId: 'builder-1' } },
    };
    const callback = vi.fn().mockResolvedValue([]);
    return { runtime, message, callback };
  }
  const budgetError = () => {
    throw new AiBudgetExceededError('AI_MAX_CALLS_PER_HOUR=1');
  };

  it('gives the offline answer when an action-only plan runs out of budget', async () => {
    const world = { controls: { goto: vi.fn() }, actions: {}, entities: { items: new Map() } };
    const { runtime, message, callback } = realTurn('<response><thought>t</thought><actions>HYPERFY_USE_ITEM</actions></response>', { [ModelType.OBJECT_SMALL]: budgetError }, connectedService(world));
    await messageReceivedHandler({ runtime, message, callback });
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback.mock.calls[0][0].text).toContain('short break');
  });

  it('answers the second request too after an earlier "on a break" notice (the fallback is not throttled)', async () => {
    const world = { controls: { goto: vi.fn() }, actions: {}, entities: { items: new Map() } };
    const { runtime, message, callback } = realTurn('<response><thought>t</thought><actions>HYPERFY_USE_ITEM</actions></response>', { [ModelType.OBJECT_SMALL]: budgetError }, connectedService(world));
    // The budget is used up when the first message arrives: that notice is throttled per player...
    resetUsageBudget(new UsageBudget({ ...noLimits, aiCallsPerHour: 0 }));
    await messageReceivedHandler({ runtime, message, callback });
    // ...and runs out again during the next request's action, which still gets an answer
    resetUsageBudget(new UsageBudget(noLimits));
    await messageReceivedHandler({ runtime, message: { ...message, id: crypto.randomUUID() }, callback });
    expect(callback.mock.calls.map(([content]) => content.text)).toEqual([expect.stringContaining('short break'), expect.stringContaining('short break')]);
  });

  it('declines politely when the model refused to plan a scene edit', async () => {
    vi.stubEnv('HYPERFY_SCENE_EDITS', 'builders');
    const world = worldFromSnapshot(cooWorldSnapshot({ players: [{ id: 'builder-1', name: 'Bob', rank: 1 }] }), { controls: {} });
    const { runtime, message, callback } = realTurn(
      '<response><thought>t</thought><actions>HYPERFY_EDIT_ENTITY</actions></response>',
      {
        [ModelType.OBJECT_LARGE]: () => {
          throw new AnthropicRefusalError('claude', 'cyber');
        },
      },
      connectedService(world, { build: ({}) })
    );
    await inChatTurn(world, () => messageReceivedHandler({ runtime, message, callback }), 'builder-1');
    expect(callback.mock.calls.map(([content]) => content.text)).toEqual(["Sorry, I can't help with that."]);
  });

  it('adds no offline notice after a scene edit reported its edits and then ran out of budget', async () => {
    vi.stubEnv('HYPERFY_SCENE_EDITS', 'builders');
    const sent: [string, any][] = [];
    const box = { isApp: true, data: { id: 'box' }, root: { position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), scale: new THREE.Vector3(1, 1, 1) } };
    const world: any = worldFromSnapshot(cooWorldSnapshot({ selfId: 'coo', players: [{ id: 'builder-1', name: 'Bob', rank: 1 }] }), {
      network: { send: (name: string, data: unknown) => sent.push([name, data]) },
      chat: { msgs: [], listeners: new Set(), add: vi.fn() },
      events: { emit: vi.fn() },
      controls: { goto: vi.fn().mockResolvedValue('arrived') },
      entities: { items: new Map([['box', box]]), player: { data: { id: 'coo', name: 'Coo' } } },
    });
    installWorldChat(world);
    // The session's own managers: the real build manager, and the real message manager, which
    // posts to the world (and records that the turn delivered something)
    const service = connectedService(world);
    const plan = [{ success: true, operation: 'translate', target: 'box', parameters: { position: [0, 2, 0] }, description: 'Moved the box up' }];
    const { runtime, message, callback } = realTurn(
      '<response><thought>t</thought><actions>HYPERFY_EDIT_ENTITY</actions></response>',
      { [ModelType.OBJECT_LARGE]: { operations: plan }, [ModelType.TEXT_SMALL]: budgetError },
      service
    );
    await inChatTurn(world, () => messageReceivedHandler({ runtime, message, callback }), 'builder-1');
    expect(sent.filter(([name]) => name === 'chatAdded').map(([, msg]) => msg.body)).toEqual(['Moved the box up', 'I made the change.']);
    expect(sent).toContainEqual(['entityModified', expect.objectContaining({ id: 'box', position: [0, 2, 0] })]);
    expect(callback).not.toHaveBeenCalled();
  });
});

/*
 * A chat message all the way through: the real MessageManager (its turn and its reply callback),
 * the plugin's real chat event handler, real core and real actions, and the real world chat. What
 * counts is what the world was sent, not what callbacks were called with.
 */
describe('messageReceivedHandler counts what actually reached the world', () => {
  const budgetError = () => {
    throw new AiBudgetExceededError('AI_MAX_CALLS_PER_HOUR=1');
  };
  afterEach(() => {
    resetUsageBudget();
    vi.restoreAllMocks();
  });

  function chatTurn(plan: string, models: Record<string, unknown>, { failFirstPost = false } = {}) {
    resetUsageBudget(new UsageBudget(noLimits));
    const posted: string[] = [];
    let posts = 0;
    const world: any = {
      chat: { msgs: [], listeners: new Set(), add: vi.fn() },
      events: { emit: vi.fn() },
      network: {
        send: (name: string, msg: any) => {
          if (name !== 'chatAdded') return;
          if (failFirstPost && posts++ === 0) throw new Error('socket closed');
          posted.push(msg.body);
        },
      },
      controls: { goto: vi.fn() },
      actions: {},
      entities: { player: { data: { id: 'coo', name: 'Coo' } }, items: new Map() },
    };
    installWorldChat(world);
    // A real session around that world and the real runtime: its own message manager, and the one
    // delivery path (no speech here: nothing is configured to synthesize it)
    let session: ConnectionSession | null = null;
    const { runtime } = createRuntime({ service: serviceFor(() => session), models: { [ModelType.TEXT_LARGE]: plan, ...models } });
    vi.spyOn(runtime, 'ensureConnection').mockResolvedValue(undefined);
    vi.spyOn(runtime, 'getEntityById').mockResolvedValue({ id: crypto.randomUUID() } as never);
    for (const handler of hyperfyEvents[hyperfyEventType.MESSAGE_RECEIVED]) runtime.registerEvent(hyperfyEventType.MESSAGE_RECEIVED, handler as never);
    session = withParts(sessionFor(world, { runtime }), { emotes: { playEmote: vi.fn(), hasEmote: () => false } });
    const manager = session.messages;
    const say = (body: string) => manager.handleMessage({ id: crypto.randomUUID(), fromId: 'p1', from: 'Alice', body });
    return { posted, say };
  }

  it('adds nothing when the reply was posted before the action ran out of budget', async () => {
    const { posted, say } = chatTurn('<response><thought>t</thought><actions>REPLY,HYPERFY_USE_ITEM</actions><text>Sure, one moment!</text></response>', {
      [ModelType.OBJECT_SMALL]: budgetError,
    });
    await say('Coo, use the crate');
    expect(posted).toEqual(['Sure, one moment!']);
  });

  it('still answers when the reply could not be posted (a callback that was called is not a delivery)', async () => {
    const { posted, say } = chatTurn(
      '<response><thought>t</thought><actions>REPLY,HYPERFY_USE_ITEM</actions><text>Sure, one moment!</text></response>',
      { [ModelType.OBJECT_SMALL]: budgetError },
      { failFirstPost: true }
    );
    await say('Coo, use the crate');
    expect(posted).toEqual([expect.stringContaining('short break')]);
  });
});
