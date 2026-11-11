import { describe, expect, it } from 'vitest';
import { ASSET_DOWNLOAD_POOL_BYTES, ASSET_WORK_POOL_BYTES, AssetMemory, AssetMemoryAborted, modelReservation, workBytes } from './asset-memory';

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

  it('refuses a reservation larger than its pool at once, instead of holding less than it needs', async () => {
    const memory = new AssetMemory({ downloadBytes: 1000, workBytes: 3000 });
    await expect(memory.download(501)).rejects.toThrow('more than the 1000 this pool holds');
    const lease = await memory.download(500);
    await expect(lease.toWork(3001)).rejects.toThrow('more than the 3000 this pool holds');
    expect([lease.phase, memory.held]).toEqual(['download', { downloads: 1000, work: 0 }]);
    lease.release();
    expect(memory.held).toEqual({ downloads: 0, work: 0 });
  });

  it('moves a reservation to work once, then only shrinks: growing is refused, so two leases cannot wait on each other', async () => {
    // Two leases of 50 in a pool of 100, each wanting 60: refused at once, nothing waits
    const memory = new AssetMemory({ downloadBytes: 1000, workBytes: 100 });
    const [a, b] = await Promise.all([memory.download(10), memory.download(10)]);
    await a.toWork(50);
    await b.toWork(50);
    await expect(a.toWork(60)).rejects.toThrow('moves to work once');
    await expect(b.toWork(60)).rejects.toThrow('moves to work once');
    a.release();
    b.release();
    expect(memory.held).toEqual({ downloads: 0, work: 0 });
  });

  it('leaves nothing held when a lease that asked to grow is released (no late grant to a released lease)', async () => {
    // A holds 60, B 40; A asks for 80 (refused), then both are released
    const memory = new AssetMemory({ downloadBytes: 1000, workBytes: 100 });
    const a = await memory.download(10);
    const b = await memory.download(10);
    await a.toWork(60);
    await b.toWork(40);
    await expect(a.toWork(80)).rejects.toThrow('moves to work once');
    a.release();
    b.release();
    a.release();
    expect(memory.held).toEqual({ downloads: 0, work: 0 });
    // And a lease released while its first exchange still waits gives the late grant straight back
    const holder = await memory.download(10);
    await holder.toWork(100);
    const waiting = await memory.download(10);
    const exchange = waiting.toWork(30);
    expect(await settled(exchange)).toBe(false);
    waiting.release();
    holder.release();
    await exchange;
    expect(memory.held).toEqual({ downloads: 0, work: 0 });
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

  it('weighs the rest of the way by kind, sizes a model by the ceiling the page is held to, and comes to 1 GiB in all', () => {
    const MiB = 1024 * 1024;
    // 6 copies of what is sent, 7 of what comes back
    expect(workBytes('model', 10, 100)).toBe(60 + 700);
    expect(workBytes('script', 10)).toBe(30);
    expect(workBytes('image', 10)).toBe(60);
    // A model: twice its estimate, twice its download, or 1 MiB, whichever is most
    expect(modelReservation('model', 10 * MiB, 2 * MiB, 200 * MiB)).toEqual({ exportBytes: 20 * MiB, workBytes: 60 * MiB + 140 * MiB });
    expect(modelReservation('emote', 1000, 10, 64 * MiB)).toEqual({ exportBytes: MiB, workBytes: 6000 + 7 * MiB });
    // An avatar has room for 8 x its download, at most its export budget, lowered until it fits the pool
    expect(modelReservation('avatar', 10 * MiB, MiB, 64 * MiB)).toMatchObject({ exportBytes: 64 * MiB });
    expect(modelReservation('avatar', 40 * MiB, MiB, 200 * MiB)).toMatchObject({ exportBytes: Math.floor((768 * MiB - 240 * MiB) / 7) });
    expect(ASSET_DOWNLOAD_POOL_BYTES + ASSET_WORK_POOL_BYTES).toBe(1024 * 1024 * 1024);
  });
});
