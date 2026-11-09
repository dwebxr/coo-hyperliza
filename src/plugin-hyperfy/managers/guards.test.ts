import { describe, expect, it } from 'vitest';
import { AgentActivityLock } from './guards';

describe('AgentActivityLock', () => {
  it('is active only while run() is in progress, even when it throws', async () => {
    const lock = new AgentActivityLock();
    let seenActive = false;
    await lock.run(async () => {
      seenActive = lock.isActive();
    });
    expect(seenActive).toBe(true);
    expect(lock.isActive()).toBe(false);

    await expect(lock.run(async () => {
      throw new Error('boom');
    })).rejects.toThrow('boom');
    expect(lock.isActive()).toBe(false);
  });

  it('remembers when activity last ended', async () => {
    let t = 1000;
    const lock = new AgentActivityLock(() => t);
    expect(lock.lastActivityAt()).toBe(Number.NEGATIVE_INFINITY);
    await lock.run(async () => {
      t = 2000;
      expect(lock.lastActivityAt()).toBe(2000);
      t = 3000;
    });
    t = 5000;
    expect(lock.lastActivityAt()).toBe(3000);
  });

  it('never goes negative', () => {
    const lock = new AgentActivityLock();
    lock.exit();
    lock.enter();
    expect(lock.isActive()).toBe(true);
    lock.exit();
    expect(lock.isActive()).toBe(false);
  });
});
