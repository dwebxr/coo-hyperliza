import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ProcessRow, RENDER_CALL_DEADLINE_MS, RENDER_MEMORY_LIMIT_BYTES, RenderPageKilled, RenderWatchdog, parsePs, processTree, psTable } from './render-watchdog';

/*
 * The watchdog over a stand-in process table and fake timers: what it samples, when it kills,
 * and what the page calls in flight then see. The real `ps` is read once (psTable), locally.
 */

const MiB = 1024 * 1024;
const rows = (browserMiB: number, rendererMiB = 0): ProcessRow[] => [
  { pid: 1, ppid: 0, rssBytes: 10 * MiB },
  { pid: 100, ppid: 1, rssBytes: browserMiB * MiB },
  { pid: 101, ppid: 100, rssBytes: rendererMiB * MiB },
  { pid: 102, ppid: 101, rssBytes: 1 * MiB },
  // Not Chromium's
  { pid: 200, ppid: 1, rssBytes: 4000 * MiB },
];

type Table = ReturnType<typeof vi.fn<() => Promise<ProcessRow[] | null>>>;
function setup({ table = vi.fn<() => Promise<ProcessRow[] | null>>(async () => rows(100, 100)), limitMiB = 500, deadlineMs = 10_000 }: { table?: Table; limitMiB?: number; deadlineMs?: number } = {}) {
  const killed: number[][] = [];
  const warn = vi.fn();
  const watchdog = new RenderWatchdog({ rootPid: () => 100, kill: (pids) => void killed.push(pids), table, limitBytes: limitMiB * MiB, deadlineMs, intervalMs: 250, log: { warn } });
  const pending = <T,>(value?: T) => {
    let finish!: (value: T) => void;
    const promise = new Promise<T>((resolve) => (finish = resolve));
    return { promise, finish: () => finish(value as T) };
  };
  return { watchdog, table, killed, warn, pending };
}

describe('RenderWatchdog', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('samples only while a page call is in flight, and measures the browser and its descendants only', async () => {
    const { watchdog, table, pending } = setup();
    await vi.advanceTimersByTimeAsync(5000);
    expect(table).not.toHaveBeenCalled();

    const work = pending('done');
    const call = watchdog.watch(() => work.promise);
    await vi.advanceTimersByTimeAsync(1000);
    expect(table.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(watchdog.lastSampleBytes).toBe(201 * MiB);
    work.finish();
    await expect(call).resolves.toBe('done');
    // No timer is left behind: neither the deadline nor the next sample
    expect(vi.getTimerCount()).toBe(0);

    const after = table.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(table.mock.calls.length).toBe(after);
    expect(watchdog.inFlight).toBe(0);
  });

  it('kills the whole tree once when it goes over the limit, and fails every call in flight with RenderPageKilled', async () => {
    let usage = 100;
    const table = vi.fn<() => Promise<ProcessRow[] | null>>(async () => rows(usage, usage));
    const { watchdog, killed, warn, pending } = setup({ table });
    const calls = [watchdog.watch(() => pending().promise), watchdog.watch(() => pending().promise)].map((call) => call.catch((error: unknown) => error));
    await vi.advanceTimersByTimeAsync(600);
    expect(killed).toEqual([]);

    usage = 300;
    await vi.advanceTimersByTimeAsync(300);
    const errors = await Promise.all(calls);
    for (const error of errors) {
      expect(error).toBeInstanceOf(RenderPageKilled);
      expect(error).toMatchObject({ reason: 'memory', measuredBytes: 601 * MiB });
    }
    expect(killed).toEqual([[100, 101, 102]]);
    expect(warn).toHaveBeenCalledTimes(1);
    // Nothing is in flight now: no more samples, no second kill
    const after = table.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect([table.mock.calls.length, killed.length]).toEqual([after, 1]);

    // The next call (on the next browser) is watched afresh
    usage = 100;
    const next = pending('again');
    const call = watchdog.watch(() => next.promise);
    await vi.advanceTimersByTimeAsync(300);
    next.finish();
    await expect(call).resolves.toBe('again');
  });

  it('kills the tree when one call runs past its deadline, also while memory is fine', async () => {
    const { watchdog, killed, pending } = setup({ deadlineMs: 2000 });
    const call = watchdog.watch(() => pending().promise).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1900);
    expect(killed).toEqual([]);
    await vi.advanceTimersByTimeAsync(200);
    expect(await call).toMatchObject({ name: 'RenderPageKilled', reason: 'deadline' });
    expect(killed).toEqual([[100, 101, 102]]);
  });

  it('without a readable process table, says so once and still applies the deadline', async () => {
    const table = vi.fn<() => Promise<ProcessRow[] | null>>(async () => null);
    const { watchdog, killed, warn, pending } = setup({ table, deadlineMs: 2000 });
    const first = watchdog.watch(() => pending().promise).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1000);
    // Read once, then not again
    expect(table).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('runs without a memory watchdog'));
    await vi.advanceTimersByTimeAsync(1100);
    expect(await first).toMatchObject({ reason: 'deadline' });
    // The browser alone is killed when its tree cannot be read
    expect(killed).toEqual([[100]]);
    const second = pending('ok');
    const call = watchdog.watch(() => second.promise);
    await vi.advanceTimersByTimeAsync(500);
    second.finish();
    await expect(call).resolves.toBe('ok');
    expect(warn.mock.calls.filter(([message]) => String(message).includes('runs without a memory watchdog'))).toHaveLength(1);
  });

  it('a call that fails on its own passes its error through, and the watchdog stops sampling', async () => {
    const { watchdog, table } = setup();
    await expect(watchdog.watch(async () => {
      throw new Error('page error');
    })).rejects.toThrow('page error');
    const after = table.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2000);
    expect(table.mock.calls.length).toBe(after);
  });

  it('has a limit and a deadline chosen from the measurements in the module header', () => {
    expect(RENDER_MEMORY_LIMIT_BYTES).toBe(3072 * MiB);
    expect(RENDER_CALL_DEADLINE_MS).toBe(60_000);
  });
});

describe('the process table', () => {
  it('reads ps output and finds a tree by parent pid', () => {
    const parsed = parsePs('  100     1  2048\n  101   100   1024\nnot a row\n  102   101   512\n  300     1  1\n');
    expect(parsed).toEqual([
      { pid: 100, ppid: 1, rssBytes: 2048 * 1024 },
      { pid: 101, ppid: 100, rssBytes: 1024 * 1024 },
      { pid: 102, ppid: 101, rssBytes: 512 * 1024 },
      { pid: 300, ppid: 1, rssBytes: 1024 },
    ]);
    expect(processTree(parsed!, 100).map((row) => row.pid)).toEqual([100, 101, 102]);
    expect(processTree(parsed!, 999)).toEqual([]);
    expect(parsePs('')).toBeNull();
    expect(parsePs('PID PPID RSS\nx y z')).toBeNull();
  });

  it('reads this machine through ps, and finds this process in it', async () => {
    const table = await psTable();
    expect(table).not.toBeNull();
    expect(table!.find((row) => row.pid === process.pid)?.rssBytes).toBeGreaterThan(0);
  });
});
