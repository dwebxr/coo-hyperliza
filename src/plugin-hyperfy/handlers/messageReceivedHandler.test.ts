import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelType } from '@elizaos/core';
import { messageReceivedHandler } from './messageReceivedHandler';
import { UsageBudget, resetUsageBudget } from '../../usage-budget';

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
