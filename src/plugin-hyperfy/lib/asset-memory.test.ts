import { describe, expect, it } from 'vitest';
import { ASSET_DOWNLOAD_POOL_BYTES, ASSET_WORK_POOL_BYTES, AssetMemory, AssetMemoryAborted, workBytes } from './asset-memory';

const settled = async (promise: Promise<unknown>) => {
  let done = false;
  promise.then(
    () => (done = true),
    () => (done = true)
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  return done;
};

describe('AssetMemory', () => {
  it('holds twice a download, shrinks to what is known, exchanges it for work, and gives everything back', async () => {
    const memory = new AssetMemory({ downloadBytes: 1000, workBytes: 3000 });
    const lease = await memory.download(400);
    expect(memory.held).toEqual({ downloads: 800, work: 0 });
    lease.shrink(200);
    expect(memory.held).toEqual({ downloads: 200, work: 0 });
    await lease.toWork(1500);
    expect([memory.held, lease.phase]).toEqual([{ downloads: 0, work: 1500 }, 'work']);
    lease.shrink(500);
    lease.release();
    lease.release();
    expect(memory.held).toEqual({ downloads: 0, work: 0 });
  });

  it('lets small loads run together and makes a large one wait, first come first served', async () => {
    const memory = new AssetMemory({ downloadBytes: 1000, workBytes: 3000 });
    const a = await memory.download(200);
    const b = await memory.download(200);
    // 800 held: a 300-byte download (600) waits, and so does a small one behind it
    const large = memory.download(300);
    const small = memory.download(10);
    expect([await settled(large), await settled(small)]).toEqual([false, false]);
    a.release();
    expect(await settled(large)).toBe(true);
    // 1000 held now: the small one waits for more to be given back
    expect(await settled(small)).toBe(false);
    b.release();
    expect(await settled(small)).toBe(true);
  });

  it('cuts a reservation larger than its pool to the pool: that load runs alone', async () => {
    const memory = new AssetMemory({ downloadBytes: 1000, workBytes: 3000 });
    const huge = await memory.download(10_000);
    expect(huge.bytes).toBe(1000);
    const next = memory.download(1);
    expect(await settled(next)).toBe(false);
    huge.release();
    expect(await settled(next)).toBe(true);
  });

  it('never deadlocks: loads holding downloads all waiting for work still get it as work is given back', async () => {
    const memory = new AssetMemory({ downloadBytes: 1000, workBytes: 1000 });
    const worker = await memory.download(100);
    await worker.toWork(900);
    const waiting = await Promise.all([memory.download(100), memory.download(100), memory.download(100)]);
    const grown = waiting.map((lease) => lease.toWork(600));
    expect(await Promise.all(grown.map(settled))).toEqual([false, false, false]);
    worker.release();
    // One at a time: each takes 600 of the 1000
    expect(await settled(grown[0])).toBe(true);
    waiting[0].release();
    expect(await settled(grown[1])).toBe(true);
    waiting[1].release();
    expect(await settled(grown[2])).toBe(true);
    waiting[2].release();
    expect(memory.held).toEqual({ downloads: 0, work: 0 });
  });

  it('stops waiting when the signal fires, and lets the next one through', async () => {
    const memory = new AssetMemory({ downloadBytes: 100, workBytes: 100 });
    const holder = await memory.download(50);
    const stop = new AbortController();
    const stopped = memory.download(50, stop.signal);
    const next = memory.download(10);
    stop.abort();
    await expect(stopped).rejects.toBeInstanceOf(AssetMemoryAborted);
    holder.release();
    expect(await settled(next)).toBe(true);
    await expect(memory.download(1, stop.signal)).rejects.toBeInstanceOf(AssetMemoryAborted);
  });

  it('weighs the rest of the way by kind, and comes to 1 GiB in all', () => {
    expect(workBytes('model', 10, 100)).toBe(40 + 400);
    expect(workBytes('script', 10)).toBe(30);
    expect(workBytes('image', 10)).toBe(40);
    expect(ASSET_DOWNLOAD_POOL_BYTES + ASSET_WORK_POOL_BYTES).toBe(1024 * 1024 * 1024);
  });
});
