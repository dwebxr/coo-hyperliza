import { describe, expect, it } from 'vitest';
import { currentOrigin, runWithOrigin } from '../../usage-budget';
import { currentTurn, neverAbortedSignal, runTurn, type TurnContext } from './turn-context';

const world = {};
const turn = (extra: Partial<TurnContext> = {}): TurnContext => ({ origin: 'chat', requesterId: 'p1', world, generation: 2, signal: neverAbortedSignal(), ...extra });

describe('TurnContext', () => {
  it('is visible to everything the turn awaits, and only there', async () => {
    expect(currentTurn()).toBeUndefined();
    const seen = await runTurn(turn(), async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return currentTurn();
    });
    expect(seen).toMatchObject({ origin: 'chat', requesterId: 'p1', world, generation: 2 });
    expect(currentTurn()).toBeUndefined();
  });

  it('keeps concurrent turns apart', async () => {
    const pause = () => new Promise((resolve) => setTimeout(resolve, 2));
    const [a, b] = await Promise.all([
      runTurn(turn({ requesterId: 'a' }), async () => (await pause(), currentTurn()?.requesterId)),
      runTurn(turn({ origin: 'autonomy', requesterId: undefined }), async () => (await pause(), currentTurn()?.origin)),
    ]);
    expect([a, b]).toEqual(['a', 'autonomy']);
  });

  it('cannot be changed by code inside the turn', async () => {
    await runTurn(turn(), async () => {
      expect(() => ((currentTurn() as { requesterId?: string }).requesterId = 'someone-else')).toThrow(TypeError);
      expect(currentTurn()?.requesterId).toBe('p1');
    });
  });

  it("attributes usage to the turn's origin, and runWithOrigin still works on its own", async () => {
    expect(await runTurn(turn({ origin: 'voice' }), async () => currentOrigin())).toBe('voice');
    expect(await runTurn(turn({ origin: 'autonomy' }), async () => currentOrigin())).toBe('autonomous');
    expect(await runWithOrigin('chat', async () => [currentOrigin(), currentTurn()])).toEqual(['chat', undefined]);
    expect(currentOrigin()).toBe('other');
    // Re-attributing usage inside a turn keeps the turn
    const inner = await runTurn(turn({ requesterId: 'p9' }), () => runWithOrigin('other', async () => [currentOrigin(), currentTurn()?.requesterId]));
    expect(inner).toEqual(['other', 'p9']);
  });

  it('carries a signal that is not aborted (cancellation is not wired up yet)', () => {
    expect(turn().signal.aborted).toBe(false);
  });
});
