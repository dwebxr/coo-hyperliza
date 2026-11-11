import { describe, expect, it } from 'vitest';

import { hyperfyTipsProvider } from './tips';
import { serviceFor, sessionFor } from '../test-support/session';

// The tip wallet of the current connection: receiving, not receiving, or none (tips not configured)
const runtime = (receiving: boolean | null): any => ({
  character: { name: 'Coo' },
  getService: () => serviceFor(sessionFor({}, { tipWallet: receiving === null ? null : ({ receiving } as never) })),
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
    // Not connected at all
    const none = await hyperfyTipsProvider.get({ character: { name: 'Coo' }, getService: () => null } as any, {} as any, {} as any);
    expect(none.values?.hyperfyTips).toBe('');
  });
});
