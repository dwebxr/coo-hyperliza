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
