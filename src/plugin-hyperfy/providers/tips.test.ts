import { describe, expect, it, vi } from 'vitest';

vi.mock('../service', () => ({ HyperfyService: { serviceType: 'hyperfy' } }));

import { hyperfyTipsProvider } from './tips';

const runtime = (receiving: boolean | null): any => ({
  character: { name: 'Coo' },
  getService: () => ({ getTipWallet: () => (receiving === null ? null : { receiving }) }),
});

describe('hyperfyTipsProvider', () => {
  it('explains tipping only while the world shows the agent as receiving tips', async () => {
    const on = await hyperfyTipsProvider.get(runtime(true), {} as any, {} as any);
    expect(on.values?.hyperfyTips).toContain('Tip button next to Coo');
    expect(on.values?.hyperfyTips).toContain('Never ask for tips');
    for (const state of [false, null]) {
      const off = await hyperfyTipsProvider.get(runtime(state), {} as any, {} as any);
      expect(off.values?.hyperfyTips).toBe('');
    }
  });
});
