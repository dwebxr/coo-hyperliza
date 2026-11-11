import { describe, expect, it, vi } from 'vitest';
import { currentOrigin, runWithOrigin } from '../../usage-budget';
import { TurnCancelled, assertTurnLive, cancelTurn, currentTurn, neverAbortedSignal, runTurn, type TurnContext, type TurnInit } from './turn-context';

const world = {};
const turn = (extra: Partial<TurnInit> = {}): TurnInit => ({ origin: 'chat', requesterId: 'p1', world, generation: 2, signal: neverAbortedSignal(), ...extra });
const pause = (ms = 1) => new Promise((resolve) => setTimeout(resolve, ms));
/** Runs a turn that waits for `release`, and hands out its context while it runs. */
function running(init: TurnInit) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let context!: TurnContext;
  const done = runTurn(init, async () => {
    context = currentTurn()!;
    await released;
  });
  return { context, release, done };
}

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

});

describe('a turn may act only while it is live', () => {
  it('is live, with a signal that has not fired, while nothing ended it', async () => {
    const { context, release, done } = running(turn());
    expect(context.live).toBe(true);
    expect(() => context.assertLive()).not.toThrow();
    expect(context.signal.aborted).toBe(false);
    release();
    await done;
  });

  it.each([
    ['its connection ends', 'signal', 'the connection it started on ended'],
    ['its slot runs out', 'cancel', 'the turn was cancelled'],
  ] as const)('stops being live, and its signal fires, when %s while it runs', async (_what, which, reason) => {
    const ends = { signal: new AbortController(), cancel: new AbortController() };
    const { context, release, done } = running(turn({ signal: ends.signal.signal, cancel: ends.cancel.signal }));
    const fired = vi.fn();
    context.signal.addEventListener('abort', fired);
    ends[which].abort();
    expect(fired).toHaveBeenCalledTimes(1);
    expect(context.live).toBe(false);
    expect(() => context.assertLive()).toThrow(TurnCancelled);
    expect(() => context.assertLive()).toThrow(reason);
    release();
    await done;
  });

  it('says why in the words of whoever cancelled it', async () => {
    const slot = new AbortController();
    const { context, release, done } = running(turn({ cancel: slot.signal }));
    slot.abort(new TurnCancelled('its turn took longer than 180 s'));
    expect(() => context.assertLive()).toThrow('its turn took longer than 180 s');
    expect(context.signal.reason).toBeInstanceOf(TurnCancelled);
    release();
    await done;
  });

  it('is cancelled by cancelTurn, and by nothing else of another turn', async () => {
    const a = running(turn());
    const b = running(turn());
    cancelTurn(a.context, 'a newer message took its place');
    expect(() => a.context.assertLive()).toThrow('a newer message took its place');
    expect(a.context.signal.aborted).toBe(true);
    expect(b.context.live).toBe(true);
    a.release();
    b.release();
    await Promise.all([a.done, b.done]);
  });

  it('starts dead when its connection had ended before it began', async () => {
    const ended = new AbortController();
    ended.abort();
    const seen = await runTurn(turn({ signal: ended.signal }), async () => [currentTurn()!.live, currentTurn()!.signal.aborted]);
    expect(seen).toEqual([false, true]);
  });

  it('leaves the signal of a turn that completed alone when its connection ends later, but the turn is no longer live', async () => {
    const connection = new AbortController();
    const slot = new AbortController();
    const { context, release, done } = running(turn({ signal: connection.signal, cancel: slot.signal }));
    release();
    await done;
    expect(context.live).toBe(true);
    connection.abort();
    // What the completed turn left running is not stopped through its signal...
    expect(context.signal.aborted).toBe(false);
    // ...but nothing may act for it any more
    expect(context.live).toBe(false);
    expect(() => context.assertLive()).toThrow(TurnCancelled);
  });

  it('assertTurnLive checks the turn the caller runs in, and nothing outside any turn', async () => {
    expect(() => assertTurnLive()).not.toThrow();
    const slot = new AbortController();
    await runTurn(turn({ cancel: slot.signal }), async () => {
      expect(() => assertTurnLive()).not.toThrow();
      slot.abort();
      await pause();
      expect(() => assertTurnLive()).toThrow(TurnCancelled);
    });
  });
});
