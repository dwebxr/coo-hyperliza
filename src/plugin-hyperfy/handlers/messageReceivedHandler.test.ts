import { describe, expect, it, vi } from 'vitest';
import { ModelType } from '@elizaos/core';
import { messageReceivedHandler } from './messageReceivedHandler';

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
