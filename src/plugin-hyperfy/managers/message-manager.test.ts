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
