import { describe, expect, it, vi } from 'vitest';

vi.mock('../service', () => ({ HyperfyService: { serviceType: 'hyperfy' } }));
vi.mock('../events', () => ({ hyperfyEventType: { MESSAGE_RECEIVED: 'HYPERFY_MESSAGE_RECEIVED' } }));

import { MessageManager } from './message-manager';

describe('MessageManager.formatMessages', () => {
  const manager = new MessageManager({ character: { templates: {} } } as any);
  const memory = (entityId: string, text: string): any => ({ entityId, content: { text }, createdAt: Date.UTC(2026, 0, 1, 12, 0) });

  it('does not throw for entities without hyperfy metadata', () => {
    const output = manager.formatMessages({
      messages: [memory('agent', 'hi there'), memory('user', 'hello')],
      entities: [
        { id: 'agent', names: ['Coo'], data: JSON.stringify({}) } as any,
        { id: 'user', names: ['Alice'], data: JSON.stringify({ hyperfy: { id: 'h-1', userName: 'Alice' } }) } as any,
      ],
    });
    expect(output).toContain('Coo []: hi there');
    expect(output).toContain('Alice [h-1]: hello');
  });

  it('tolerates malformed entity data', () => {
    expect(() =>
      manager.formatMessages({
        messages: [memory('user', 'hello')],
        entities: [{ id: 'user', names: ['Bob'], data: '{not json' } as any],
      })
    ).not.toThrow();
  });
});

describe('MessageManager.sendMessage', () => {
  function createChat() {
    const send = vi.fn();
    const add = vi.fn((msg, broadcast) => {
      if (broadcast) send('chatAdded', msg);
    });
    const world = {
      chat: { add },
      entities: { player: { data: { id: 'me', name: 'Coo' } } },
    };
    const runtime: any = {
      character: { templates: {} },
      getService: () => ({ isConnected: () => true, getWorld: () => world, getEntityName: () => 'Coo' }),
    };
    return { manager: new MessageManager(runtime), add, send };
  }

  it('broadcasts a long reply as separate chatAdded messages in order', async () => {
    const { manager, add, send } = createChat();
    const parts = ['a'.repeat(500), 'b'.repeat(500), 'c'.repeat(250)];
    await expect(manager.sendMessage(parts.join(''))).resolves.toBe(true);
    expect(add).toHaveBeenCalledTimes(3);
    expect(send).toHaveBeenCalledTimes(3);
    const messages = send.mock.calls.map(([event, msg], index) => {
      expect(event).toBe('chatAdded');
      expect(msg.body).toBe(parts[index]);
      expect(msg.body.length).toBeLessThanOrEqual(500);
      expect(msg.fromId).toBe('me');
      expect(msg.from).toBe('Coo');
      expect(Number.isNaN(Date.parse(msg.createdAt))).toBe(false);
      expect(add).toHaveBeenNthCalledWith(index + 1, msg, true);
      return msg;
    });
    expect(new Set(messages.map((msg) => msg.id)).size).toBe(3);
  });

  it.each(['', ' \t\r\n　'])('does not post an empty or whitespace reply (%j)', async (text) => {
    const { manager, add, send } = createChat();
    await expect(manager.sendMessage(text)).resolves.toBe(false);
    expect(add).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('returns false instead of throwing when not connected', async () => {
    const runtime: any = {
      character: { templates: {} },
      getService: () => ({ isConnected: () => false, getWorld: () => null }),
    };
    await expect(new MessageManager(runtime).sendMessage('hi')).resolves.toBe(false);
  });

  it('returns false instead of throwing when chat.add fails', async () => {
    const world = {
      chat: { add: () => { throw new Error('boom'); } },
      entities: { player: { data: { id: 'me', name: 'Coo' } } },
    };
    const runtime: any = {
      character: { templates: {} },
      getService: () => ({ isConnected: () => true, getWorld: () => world, getEntityName: () => 'Coo' }),
    };
    await expect(new MessageManager(runtime).sendMessage('hi')).resolves.toBe(false);
  });

  it('leaves the first chunk posted and returns false when chat.add throws on the second', async () => {
    const { manager, add, send } = createChat();
    add.mockImplementationOnce((msg, broadcast) => {
      if (broadcast) send('chatAdded', msg);
    }).mockImplementationOnce(() => { throw new Error('second chunk failed'); });
    const parts = ['a'.repeat(500), 'b'.repeat(500), 'c'.repeat(250)];

    await expect(manager.sendMessage(parts.join(''))).resolves.toBe(false);

    expect(add).toHaveBeenCalledTimes(2);
    expect(add).toHaveBeenNthCalledWith(2, expect.objectContaining({ body: parts[1] }), true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('chatAdded', expect.objectContaining({ body: parts[0] }));
  });
});

describe('MessageManager stale turns', () => {
  async function receiveAndCaptureCallback() {
    let world: any = { entities: { player: { data: { id: 'coo' } } } };
    const sendMessage = vi.fn();
    const speak = vi.fn();
    let callback: any;
    const runtime: any = {
      agentId: 'agent',
      character: { name: 'Coo', templates: {} },
      getService: () => ({
        getWorld: () => world,
        currentWorldId: 'w1',
        getEmoteManager: () => ({ playEmote: vi.fn() }),
        getVoiceManager: () => ({ speak }),
      }),
      ensureConnection: vi.fn(),
      getEntityById: vi.fn().mockResolvedValue({ id: 'e' }),
      createMemory: vi.fn(),
      emitEvent: vi.fn(async (_event: string, payload: any) => {
        callback = payload.callback;
      }),
    };
    const manager = new MessageManager(runtime);
    manager.sendMessage = sendMessage as any;
    const turn = { cancelled: false };
    await manager.handleMessage({ id: 'm1', fromId: 'p1', from: 'Alice', body: 'hi' }, turn);
    return { manager, turn, callback, sendMessage, speak, runtime, replaceWorld: () => (world = { entities: world.entities }) };
  }

  it('delivers replies for a live turn', async () => {
    const { callback, sendMessage, speak } = await receiveAndCaptureCallback();
    await callback({ text: 'Hello!' });
    expect(sendMessage).toHaveBeenCalledWith('Hello!');
    expect(speak).toHaveBeenCalledWith('Hello!');
  });

  it('passes the full original reply to voice even when chat needs splitting', async () => {
    const { callback, sendMessage, speak } = await receiveAndCaptureCallback();
    const text = 'Hello! '.repeat(400);
    await callback({ text });
    expect(sendMessage).toHaveBeenCalledWith(text);
    expect(speak).toHaveBeenCalledTimes(1);
    expect(speak).toHaveBeenCalledWith(text);
  });

  it.each([
    ['the turn timed out', (ctx: any) => (ctx.turn.cancelled = true)],
    ['the manager was stopped (disconnect)', (ctx: any) => ctx.manager.stop()],
    ['the world was replaced (reconnect)', (ctx: any) => ctx.replaceWorld()],
  ])('drops a late reply when %s', async (_label, invalidate) => {
    const ctx = await receiveAndCaptureCallback();
    invalidate(ctx);
    await ctx.callback({ text: 'Too late' });
    expect(ctx.sendMessage).not.toHaveBeenCalled();
    expect(ctx.speak).not.toHaveBeenCalled();
    expect(ctx.runtime.createMemory).not.toHaveBeenCalled();
  });
});

describe('MessageManager shop links', () => {
  it('posts a shop link to chat once and never reads it aloud', async () => {
    let callback: any;
    const sendMessage = vi.fn();
    const speak = vi.fn();
    const world = { entities: { player: { data: { id: 'coo' } } } };
    const runtime: any = {
      agentId: 'agent',
      character: { name: 'Coo', templates: {} },
      getService: () => ({ getWorld: () => world, currentWorldId: 'w1', getEmoteManager: () => ({ playEmote: vi.fn() }), getVoiceManager: () => ({ speak }) }),
      ensureConnection: vi.fn(),
      getEntityById: vi.fn().mockResolvedValue({ id: 'e' }),
      createMemory: vi.fn(),
      emitEvent: vi.fn(async (_e: string, payload: any) => { callback = payload.callback; }),
    };
    const manager = new MessageManager(runtime);
    manager.sendMessage = sendMessage as any;
    await manager.handleMessage({ id: 'm1', fromId: 'p1', from: 'Alice', body: 'link please' });
    await callback({ text: '🛒 HoverBoard — 505 JPYC\nhttps://open-pay.jp/ja/@a?product=x', metadata: { openpayLink: true } });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(speak).not.toHaveBeenCalled();
    expect(runtime.createMemory).toHaveBeenCalled();
  });
});

describe('MessageManager tip notices', () => {
  function setup() {
    const add = vi.fn();
    const faceEntity = vi.fn().mockResolvedValue(undefined);
    const self = { data: { id: 'me', type: 'player', name: 'Coo' } };
    const world = {
      chat: { add },
      controls: { faceEntity },
      entities: { player: self, items: new Map<string, any>([['me', self], ['p1', { data: { id: 'p1', type: 'player', name: 'Alice' } }]]) },
    };
    const speak = vi.fn().mockResolvedValue(true);
    const service = {
      isConnected: () => true,
      getWorld: () => world,
      getEntityName: () => 'Coo',
      getEmoteManager: () => ({ hasEmote: () => false, playEmote: vi.fn() }),
      getVoiceManager: () => ({ speak }),
      currentWorldId: '00000000-0000-0000-0000-0000000000ee',
    };
    const runtime: any = {
      agentId: '00000000-0000-0000-0000-0000000000aa',
      character: { name: 'Coo', templates: {} },
      getService: () => service,
      createMemory: vi.fn().mockResolvedValue(undefined),
      ensureConnection: vi.fn().mockResolvedValue(undefined),
      getEntityById: vi.fn().mockResolvedValue({ id: 'e' }),
      emitEvent: vi.fn().mockResolvedValue(undefined),
    };
    const notice = (body: string) => ({ id: `n-${body}`, from: null, fromId: null, body, createdAt: new Date().toISOString() });
    return { manager: new MessageManager(runtime), add, speak, faceEntity, runtime, notice };
  }

  it('thanks the tipper without a model call: faces them, speaks, and remembers it', async () => {
    const { manager, add, speak, faceEntity, runtime, notice } = setup();
    await manager.handleMessage(notice('Alice tipped Coo 100 JPYC'));
    expect(add).toHaveBeenCalledWith(expect.objectContaining({ body: expect.stringContaining('Aliceさん、100 JPYCの投げゼニ') }), true);
    expect(speak).toHaveBeenCalledWith(expect.stringContaining('ありがとうございます'));
    expect(faceEntity).toHaveBeenCalledWith('p1');
    expect(runtime.createMemory.mock.calls[0][0].content.thought).toBe('Alice tipped me 100 JPYC.');
    expect(runtime.emitEvent).not.toHaveBeenCalled();
  });

  it('thanks in English a player who last wrote in English', async () => {
    const { manager, add, notice } = setup();
    await manager.handleMessage({ id: 'm1', from: 'Alice', fromId: 'p1', body: 'hello Coo', createdAt: new Date().toISOString() });
    await manager.handleMessage(notice('(only you) Alice tipped you 5 JPYC'));
    expect(add).toHaveBeenCalledWith(expect.objectContaining({ body: expect.stringContaining('Thank you so much for the 5 JPYC tip, Alice') }), true);
  });

  it('ignores other world notices and tips to someone else', async () => {
    const { manager, add, speak, notice } = setup();
    await manager.handleMessage(notice('Alice tipped Bob 100 JPYC'));
    await manager.handleMessage(notice('The world will restart in 5 minutes'));
    expect(add).not.toHaveBeenCalled();
    expect(speak).not.toHaveBeenCalled();
  });
});
