import { describe, expect, it, vi } from 'vitest';

vi.mock('../service', () => ({ HyperfyService: { serviceType: 'hyperfy' } }));

import { hyperfyProvider } from './world';

const message: any = { entityId: 'user-1', content: { text: 'Coo, come here' } };

describe('hyperfyProvider', () => {
  it('exposes hyperfyStatus when disconnected', async () => {
    const runtime: any = { getService: () => ({ isConnected: () => false }) };
    const result = await hyperfyProvider.get(runtime, message, {} as any);
    expect(result.values?.hyperfyStatus).toContain('Disconnected');
    expect(result.values).not.toHaveProperty('hyperfy_status');
  });

  it('keeps the received message in hyperfyStatus when building state fails', async () => {
    const runtime: any = {
      getService: () => ({
        isConnected: () => true,
        getWorld: () => {
          throw new Error('world exploded');
        },
      }),
    };
    const result = await hyperfyProvider.get(runtime, message, {} as any);
    expect(result.values?.hyperfyStatus).toContain('Error retrieving state');
    expect(result.values?.hyperfyStatus).toContain('Coo, come here');
  });
});
