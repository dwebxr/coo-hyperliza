import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelType } from '@elizaos/core';
import * as THREE from 'three';
import { messageReceivedHandler } from './messageReceivedHandler';
import { AiBudgetExceededError, UsageBudget, resetUsageBudget } from '../../usage-budget';
import { AnthropicRefusalError } from '../../anthropic-models';
import { BuildManager } from '../managers/build-manager';
import { MessageManager } from '../managers/message-manager';
import { installWorldChat } from '../lib/world-chat';
import { connectedService, createRuntime } from '../test-support/core-runtime';
import { hyperfyEventType, hyperfyEvents } from '../events';
import { cooWorldSnapshot } from '../test-support/world-packets';
import { inChatTurn, worldFromSnapshot } from '../test-support/turns';

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
    const controls = { followEntity: vi.fn().mockResolvedValue(undefined), teleportToEntity: vi.fn(), stopAllActions: vi.fn() };
    const at = (x: number) => ({ base: { position: { distanceTo: (o: any) => Math.abs(o.x - x), x } } });
    const items = new Map<string, any>([['player-bob', at(5)]]);
    return { controls, entities: { items, player: at(0) } };
  }

  it('carries out "come here" from the speaker without a model call', async () => {
    const { runtime, message } = setup({ embeddingModel: false });
    const w = world();
    runtime.getService = vi.fn(() => ({ getWorld: () => w }));
    message.content = { text: 'Coo, come here!', metadata: { directlyAddressed: true, hyperfyFromId: 'player-bob' } };
    const callback = vi.fn();
    await messageReceivedHandler({ runtime, message, callback } as any);
    expect(runtime.useModel).not.toHaveBeenCalled();
    expect(w.controls.followEntity).toHaveBeenCalledWith('player-bob');
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ text: 'On my way!', actions: ['HYPERFY_GOTO_ENTITY'] }));
  });

  it('leaves "come here" to the model when it is not addressed to the agent', async () => {
    const { runtime, message } = setup({ embeddingModel: false });
    runtime.getService = vi.fn(() => ({ getWorld: () => world() }));
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
      connectedService(world, { getBuildManager: () => ({}) })
    );
    await inChatTurn(world, () => messageReceivedHandler({ runtime, message, callback }), 'builder-1');
    expect(callback.mock.calls.map(([content]) => content.text)).toEqual(["Sorry, I can't help with that."]);
  });

  it('adds no offline notice after a scene edit reported its edits and then ran out of budget', async () => {
    vi.stubEnv('HYPERFY_SCENE_EDITS', 'builders');
    const sent: [string, any][] = [];
    const box = { data: { id: 'box' }, root: { position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), scale: new THREE.Vector3(1, 1, 1) } };
    const world: any = worldFromSnapshot(cooWorldSnapshot({ selfId: 'coo', players: [{ id: 'builder-1', name: 'Bob', rank: 1 }] }), {
      network: { send: (name: string, data: unknown) => sent.push([name, data]) },
      chat: { msgs: [], listeners: new Set(), add: vi.fn() },
      events: { emit: vi.fn() },
      controls: { goto: vi.fn().mockResolvedValue(undefined) },
      entities: { items: new Map([['box', box]]), player: { data: { id: 'coo', name: 'Coo' } } },
    });
    installWorldChat(world);
    const service: any = connectedService(world, { getBuildManager: () => new BuildManager({} as never), getEntityName: () => 'Coo' });
    const plan = [{ success: true, operation: 'translate', target: 'box', parameters: { position: [0, 2, 0] }, description: 'Moved the box up' }];
    const { runtime, message, callback } = realTurn(
      '<response><thought>t</thought><actions>HYPERFY_EDIT_ENTITY</actions></response>',
      { [ModelType.OBJECT_LARGE]: { operations: plan }, [ModelType.TEXT_SMALL]: budgetError },
      service
    );
    // The real message manager posts to the world (and records that the turn delivered something)
    const messageManager = new MessageManager(runtime as never);
    service.getMessageManager = () => messageManager;
    await inChatTurn(world, () => messageReceivedHandler({ runtime, message, callback }), 'builder-1');
    expect(sent.filter(([name]) => name === 'chatAdded').map(([, msg]) => msg.body)).toEqual(['Moved the box up', 'I made 1 of the 1 changes.']);
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
    const service: any = connectedService(world, {
      getEntityName: () => 'Coo',
      currentWorldId: crypto.randomUUID(),
      getEmoteManager: () => ({ playEmote: vi.fn() }),
      getVoiceManager: () => null,
    });
    const { runtime } = createRuntime({ service, models: { [ModelType.TEXT_LARGE]: plan, ...models } });
    vi.spyOn(runtime, 'ensureConnection').mockResolvedValue(undefined);
    vi.spyOn(runtime, 'getEntityById').mockResolvedValue({ id: crypto.randomUUID() } as never);
    for (const handler of hyperfyEvents[hyperfyEventType.MESSAGE_RECEIVED]) runtime.registerEvent(hyperfyEventType.MESSAGE_RECEIVED, handler as never);
    const manager = new MessageManager(runtime as never);
    service.getMessageManager = () => manager;
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
