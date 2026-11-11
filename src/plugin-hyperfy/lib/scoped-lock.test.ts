import { describe, expect, it } from 'vitest';
import { ScopedLock } from './scoped-lock';

const gate = () => {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

describe('ScopedLock', () => {
  it('runs one section at a time, in the order they asked', async () => {
    const lock = new ScopedLock();
    const order: string[] = [];
    const gates = [gate(), gate(), gate()];
    const sections = ['a', 'b', 'c'].map((name, i) =>
      lock.run(undefined, async () => {
        order.push(`${name} starts`);
        await gates[i].opened;
        order.push(`${name} ends`);
        return name;
      })
    );
    await tick();
    expect(order).toEqual(['a starts']);
    expect(lock.busy).toBe(true);
    // Opening a later section's gate first changes nothing: it has not started
    gates[2].open();
    await tick();
    expect(order).toEqual(['a starts']);
    gates[0].open();
    gates[1].open();
    expect(await Promise.all(sections)).toEqual(['a', 'b', 'c']);
    expect(order).toEqual(['a starts', 'a ends', 'b starts', 'b ends', 'c starts', 'c ends']);
    expect(lock.busy).toBe(false);
  });

  it('lets the next section run after one that failed', async () => {
    const lock = new ScopedLock();
    const failed = lock.run(undefined, async () => {
      throw new Error('boom');
    });
    const next = lock.run(undefined, async () => 'ran');
    await expect(failed).rejects.toThrow('boom');
    expect(await next).toBe('ran');
    expect(lock.busy).toBe(false);
  });

  it('a waiter whose signal fires gives up with the signal\'s reason, never runs, and does not hold up the one behind it', async () => {
    const lock = new ScopedLock();
    const first = gate();
    const order: string[] = [];
    const holder = lock.run(undefined, async () => {
      await first.opened;
      order.push('holder');
    });
    const stop = new AbortController();
    const reason = new Error('its turn was cancelled');
    const waiter = lock.run(stop.signal, async () => void order.push('waiter'));
    const behind = lock.run(undefined, async () => void order.push('behind'));
    await tick();
    stop.abort(reason);
    await expect(waiter).rejects.toBe(reason);
    // The one behind still waits for the holder
    await tick();
    expect(order).toEqual([]);
    first.open();
    await Promise.all([holder, behind]);
    expect(order).toEqual(['holder', 'behind']);
    expect(lock.busy).toBe(false);
  });

  it('starts nothing for a signal that has fired already, and does not start a waiter whose signal fired while the section before it ended', async () => {
    const lock = new ScopedLock();
    const fired = new AbortController();
    fired.abort(new Error('gone'));
    let ran = false;
    await expect(lock.run(fired.signal, async () => void (ran = true))).rejects.toThrow('gone');
    expect(ran).toBe(false);
    expect(lock.busy).toBe(false);

    const stop = new AbortController();
    const first = gate();
    const holder = lock.run(undefined, async () => {
      await first.opened;
      // The last thing the section before it does
      stop.abort(new Error('too late'));
    });
    const waiter = lock.run(stop.signal, async () => void (ran = true));
    first.open();
    await holder;
    await expect(waiter).rejects.toThrow('too late');
    expect(ran).toBe(false);
  });

  it('does not interrupt a section that has started when its signal fires', async () => {
    const lock = new ScopedLock();
    const stop = new AbortController();
    const inside = gate();
    const section = lock.run(stop.signal, async () => {
      await inside.opened;
      return 'finished';
    });
    await tick();
    stop.abort(new Error('cancelled'));
    inside.open();
    expect(await section).toBe('finished');
  });
});
