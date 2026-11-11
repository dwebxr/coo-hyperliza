import { describe, expect, it, vi } from 'vitest';
import { PageWork, REFUSED_KEPT } from './page-work';
import { RenderPageKilled } from './render-watchdog';

const killed = (callsInFlight: number, initInFlight = false) => new RenderPageKilled('memory', 'killed: too much memory', 4e9, 1, callsInFlight, initInFlight);

describe('PageWork', () => {
  it('refuses an asset again only when it was the only page call in flight, and logs that once', async () => {
    const log = vi.fn();
    const work = new PageWork({ log });
    await expect(work.run('model/a', 'the model a', async () => Promise.reject(killed(1)))).rejects.toBeInstanceOf(RenderPageKilled);
    await expect(work.run('model/b', 'the model b', async () => Promise.reject(killed(2)))).rejects.toBeInstanceOf(RenderPageKilled);
    await expect(work.run('model/c', 'the model c', async () => Promise.reject(killed(1, true)))).rejects.toBeInstanceOf(RenderPageKilled);
    expect([work.refusal('model/a'), work.refusal('model/b'), work.refusal('model/c')]).toEqual(['killed: too much memory', undefined, undefined]);
    const run = vi.fn(async () => 'never');
    await expect(work.run('model/a', 'the model a', run)).rejects.toThrow('Not handing the model a to the render page again');
    expect(run).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('runs page work one call at a time from the first kill on', async () => {
    const work = new PageWork({ log: () => {} });
    expect(work.serial).toBe(false);
    await work.run('model/a', 'a', async () => Promise.reject(killed(3))).catch(() => {});
    expect(work.serial).toBe(true);
    let running = 0;
    let most = 0;
    const job = async () => {
      most = Math.max(most, ++running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running--;
    };
    await Promise.all([work.run('x', 'x', job), work.run('y', 'y', async () => Promise.reject(new Error('fails on its own'))).catch(() => {}), work.run('z', 'z', job)]);
    expect(most).toBe(1);
  });

  it('does not run a call queued behind the one that got its asset refused', async () => {
    const work = new PageWork({ log: () => {} });
    // Serial already: an earlier kill with others in flight
    await work.run('other', 'other', async () => Promise.reject(killed(2))).catch(() => {});
    let finish!: (error: Error) => void;
    const first = work.run('image/x', 'the image x', () => new Promise<never>((_, reject) => (finish = reject))).catch((e: Error) => e);
    const queued = vi.fn(async () => 'ran');
    const second = work.run('image/x', 'the image x', queued).catch((e: Error) => e.message);
    await new Promise((resolve) => setTimeout(resolve, 0));
    finish(killed(1));
    expect(await first).toBeInstanceOf(RenderPageKilled);
    expect(await second).toContain('Not handing the image x to the render page again');
    expect(queued).not.toHaveBeenCalled();
  });

  it('keeps at most REFUSED_KEPT refusals, the oldest dropped first', async () => {
    const work = new PageWork({ log: () => {} });
    for (let i = 0; i <= REFUSED_KEPT; i++) await work.run(`model/${i}`, `${i}`, async () => Promise.reject(killed(1))).catch(() => {});
    expect(work.refusal('model/0')).toBeUndefined();
    expect(work.refusal('model/1')).toBeDefined();
    expect(work.refusal(`model/${REFUSED_KEPT}`)).toBeDefined();
  });
});
