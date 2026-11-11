import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ProcessRow,
  RENDER_CALL_DEADLINE_MS,
  RENDER_IDLE_SAMPLE_INTERVAL_MS,
  RENDER_MEMORY_LIMIT_BYTES,
  RENDER_SAMPLE_INTERVAL_MS,
  RenderBreaker,
  RenderPageKilled,
  RenderPageUnavailable,
  RenderWatchdog,
  parsePs,
  processTree,
  psTable,
} from './render-watchdog';

/*
 * The watchdog over a stand-in process table (deferred where an interleaving needs it) and fake
 * timers: what it samples and when, what it owns, when it tears a generation down, and what calls
 * on it then see. The real `ps` is read once (psTable), locally.
 */

const MiB = 1024 * 1024;
const own = process.pid;
/** Browser 100 leads group 100; 101 its renderer; 102 a helper whose parent exited (ppid 1), still in the group */
const rows = (browserMiB: number, rendererMiB = 0, helperMiB = 0): ProcessRow[] => [
  { pid: own, ppid: 1, pgid: own, rssBytes: 50 * MiB },
  { pid: 100, ppid: 1, pgid: 100, rssBytes: browserMiB * MiB },
  { pid: 101, ppid: 100, pgid: 100, rssBytes: rendererMiB * MiB },
  { pid: 102, ppid: 1, pgid: 100, rssBytes: helperMiB * MiB },
  // Not the browser's
  { pid: 200, ppid: 1, pgid: 200, rssBytes: 4000 * MiB },
];
type Table = () => Promise<ProcessRow[] | null>;

function setup({ table = vi.fn<Table>(async () => rows(100, 100)), limitMiB = 500, deadlineMs = 10_000, breaker = new RenderBreaker({ log: { warn: () => {} } }) }: { table?: ReturnType<typeof vi.fn<Table>>; limitMiB?: number; deadlineMs?: number; breaker?: RenderBreaker } = {}) {
  const kills: [number[], number | null][] = [];
  const tornDown: number[] = [];
  const warn = vi.fn();
  const watchdog = new RenderWatchdog({ kill: (pids, group) => void kills.push([pids, group]), onTornDown: (generation) => void tornDown.push(generation), table, limitBytes: limitMiB * MiB, deadlineMs, breaker, log: { warn } });
  const pending = <T,>(value?: T) => {
    let finish!: (value: T) => void;
    const promise = new Promise<T>((resolve) => (finish = resolve));
    return { promise, finish: () => finish(value as T) };
  };
  const deferredTable = () => {
    const answers: ((rows: ProcessRow[] | null) => void)[] = [];
    table.mockImplementation(() => new Promise((resolve) => answers.push(resolve)));
    return answers;
  };
  return { watchdog, table, kills, tornDown, warn, pending, deferredTable };
}

describe('RenderWatchdog', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('samples for as long as the browser exists: at the busy interval during a call, at the idle interval otherwise', async () => {
    const { watchdog, table, pending } = setup();
    watchdog.started(1, 100);
    await vi.advanceTimersByTimeAsync(10_000);
    // Idle: one at the start, then every RENDER_IDLE_SAMPLE_INTERVAL_MS
    expect(table.mock.calls.length).toBe(1 + Math.floor(10_000 / RENDER_IDLE_SAMPLE_INTERVAL_MS));
    const idleSamples = table.mock.calls.length;

    const work = pending('done');
    const call = watchdog.watch(1, () => work.promise);
    await vi.advanceTimersByTimeAsync(1000);
    expect(table.mock.calls.length - idleSamples).toBeGreaterThanOrEqual(1000 / RENDER_SAMPLE_INTERVAL_MS);
    work.finish();
    await expect(call).resolves.toBe('done');

    // Back to idle; and nothing once the browser is gone
    const busy = table.mock.calls.length;
    await vi.advanceTimersByTimeAsync(4000);
    expect(table.mock.calls.length - busy).toBeLessThanOrEqual(3);
    watchdog.ended(1);
    const ended = table.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(table.mock.calls.length).toBe(ended);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('owns the browser, its descendants, its process group (a helper whose parent exited) and nothing else', async () => {
    const table = vi.fn<Table>(async () => rows(100, 100, 100));
    const owned = setup({ table });
    owned.watchdog.started(1, 100);
    await vi.advanceTimersByTimeAsync(10);
    expect(owned.watchdog.lastSampleBytes).toBe(300 * MiB);
    expect(owned.watchdog.ownership(1)).toEqual({ pids: [100, 101, 102], group: 100 });
    // A browser in this process's own group (not detached): no group is used, the parent chain alone counts
    const shared = setup({ table: vi.fn<Table>(async () => [{ pid: own, ppid: 1, pgid: own, rssBytes: MiB }, { pid: 300, ppid: own, pgid: own, rssBytes: 10 * MiB }, { pid: 301, ppid: 1, pgid: own, rssBytes: 999 * MiB }]) });
    shared.watchdog.started(2, 300);
    await vi.advanceTimersByTimeAsync(10);
    expect(shared.watchdog.ownership(2)).toEqual({ pids: [300], group: null });
  });

  it('tears a generation down at the deadline at once, while ps is still pending: the call fails, a later call fails too, and the kill follows', async () => {
    const { watchdog, kills, tornDown, pending, deferredTable } = setup({ deadlineMs: 2000 });
    const answers = deferredTable();
    watchdog.started(1, 100);
    const a = watchdog.watch(1, () => pending().promise).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(2100);
    // The sample is still pending; A failed anyway, and the owner was told
    expect(answers.length).toBeGreaterThan(0);
    expect(await a).toMatchObject({ name: 'RenderPageKilled', reason: 'deadline', generation: 1, callsInFlight: 1 });
    expect(tornDown).toEqual([1]);
    // From what it knew (the browser itself), at once
    expect(kills).toEqual([[[100], null]]);
    // A call arriving now, on the torn-down generation, fails the same way, and its work is not started
    const late = vi.fn(async () => 'too late');
    await expect(watchdog.watch(1, late)).rejects.toBeInstanceOf(RenderPageKilled);
    expect(late).not.toHaveBeenCalled();
    // The fresh sample sweeps again, with the group it shows
    for (const answer of answers.splice(0)) answer(rows(100, 100, 100));
    await vi.advanceTimersByTimeAsync(10);
    expect(kills.at(-1)).toEqual([[100, 101, 102], 100]);
  });

  it('does not let a call that returns in the same moment as the teardown succeed', async () => {
    const { watchdog, deferredTable, pending } = setup();
    const answers = deferredTable();
    watchdog.started(1, 100);
    const work = pending('result');
    const call = watchdog.watch(1, () => work.promise).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(300);
    // The work returns first, then the sample over the limit is read, before the call's caller resumes
    work.finish();
    for (const answer of answers.splice(0)) answer(rows(1000));
    expect(await call).toBeInstanceOf(RenderPageKilled);
  });

  it('tears down once when two reasons come together, and counts one kill', async () => {
    const breaker = new RenderBreaker({ log: { warn: () => {} } });
    const record = vi.spyOn(breaker, 'recordKill');
    const { watchdog, kills, tornDown, deferredTable, pending } = setup({ deadlineMs: 300, breaker });
    const answers = deferredTable();
    watchdog.started(1, 100);
    const calls = [watchdog.watch(1, () => pending().promise), watchdog.watch(1, () => pending().promise)].map((call) => call.catch((error: unknown) => error));
    await vi.advanceTimersByTimeAsync(350);
    for (const answer of answers.splice(0)) answer(rows(1000));
    await vi.advanceTimersByTimeAsync(10);
    const errors = await Promise.all(calls);
    expect(errors[0]).toBe(errors[1]);
    expect(errors[0]).toMatchObject({ reason: 'deadline', callsInFlight: 2 });
    expect([tornDown, record.mock.calls.length, kills.length]).toEqual([[1], 1, 2]);
  });

  it('kills an idle browser that goes over the limit', async () => {
    let usage = 100;
    const { watchdog, kills, tornDown } = setup({ table: vi.fn<Table>(async () => rows(usage, usage)) });
    watchdog.started(1, 100);
    await vi.advanceTimersByTimeAsync(5000);
    expect(kills).toEqual([]);
    usage = 300;
    await vi.advanceTimersByTimeAsync(RENDER_IDLE_SAMPLE_INTERVAL_MS + 10);
    expect(tornDown).toEqual([1]);
    expect(kills[0]).toEqual([[100, 101, 102], 100]);
    await expect(watchdog.watch(1, async () => 'x')).rejects.toMatchObject({ reason: 'memory', measuredBytes: 600 * MiB, callsInFlight: 0 });
  });

  it('goes on under the deadline while ps cannot be read, retries with a backoff, and watches memory again when it can', async () => {
    let readable = false;
    let usage = 100;
    const table = vi.fn<Table>(async () => (readable ? rows(usage, usage) : null));
    const { watchdog, warn, tornDown, pending } = setup({ table, deadlineMs: 60_000 });
    watchdog.started(1, 100);
    const work = pending('ok');
    const call = watchdog.watch(1, () => work.promise);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(watchdog.measuring).toBe(false);
    // Backing off: far fewer attempts than samples every 250 ms would be
    expect(table.mock.calls.length).toBeLessThan(15);
    work.finish();
    await expect(call).resolves.toBe('ok');
    expect(warn.mock.calls.filter(([line]) => String(line).includes('cannot be read'))).toHaveLength(1);

    readable = true;
    usage = 300;
    await vi.advanceTimersByTimeAsync(31_000);
    expect(watchdog.measuring).toBe(true);
    expect(warn.mock.calls.filter(([line]) => String(line).includes('can be read again'))).toHaveLength(1);
    expect(tornDown).toEqual([1]);
  });

  it("never takes the agent's own process group for the browser's, whatever the table says", async () => {
    // A table in which the browser seems to lead the group this process is in
    const table = vi.fn<Table>(async () => [
      { pid: own, ppid: 1, pgid: 400, rssBytes: MiB },
      { pid: 400, ppid: own, pgid: 400, rssBytes: 10 * MiB },
      { pid: 401, ppid: 1, pgid: 400, rssBytes: 20 * MiB },
    ]);
    const { watchdog } = setup({ table });
    watchdog.started(1, 400);
    await vi.advanceTimersByTimeAsync(10);
    expect(watchdog.ownership(1)).toEqual({ pids: [400], group: null });
  });

  it('keeps owning a process it saw while its group stays the same, also once its parent is gone (a browser without a group of its own)', async () => {
    let later = false;
    const table = vi.fn<Table>(async () => [
      { pid: own, ppid: 1, pgid: own, rssBytes: MiB },
      { pid: 300, ppid: own, pgid: own, rssBytes: 10 * MiB },
      { pid: 302, ppid: later ? 1 : 300, pgid: own, rssBytes: 20 * MiB },
      // Was the browser's; later the pid belongs to another program, in another group
      { pid: 303, ppid: later ? 1 : 300, pgid: later ? 999 : own, rssBytes: 30 * MiB },
    ]);
    const { watchdog } = setup({ table });
    watchdog.started(1, 300);
    await vi.advanceTimersByTimeAsync(10);
    expect([watchdog.ownership(1).pids, watchdog.lastSampleBytes]).toEqual([[300, 302, 303], 60 * MiB]);
    later = true;
    await vi.advanceTimersByTimeAsync(RENDER_IDLE_SAMPLE_INTERVAL_MS + 10);
    expect(watchdog.lastSampleBytes).toBe(30 * MiB);
  });

  it('does not revive a generation that is over when its launch reports in late: that browser is killed', async () => {
    const { watchdog, kills, pending } = setup({ deadlineMs: 100 });
    // Watched before the launch said its pid, and torn down at the deadline
    const call = watchdog.watch(1, () => pending().promise).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(150);
    expect(await call).toBeInstanceOf(RenderPageKilled);
    watchdog.started(1, 100);
    expect(kills.at(-1)).toEqual([[100], null]);
    expect(watchdog.isLive(1)).toBe(false);
    await expect(watchdog.watch(1, async () => 'x')).rejects.toBeInstanceOf(RenderPageKilled);
  });

  it('a call that fails on its own passes its error through, and the generation stays up', async () => {
    const { watchdog, tornDown } = setup();
    watchdog.started(1, 100);
    await expect(watchdog.watch(1, async () => {
      throw new Error('page error');
    })).rejects.toThrow('page error');
    expect([tornDown, watchdog.isLive(1)]).toEqual([[], true]);
  });

  it('has a limit, a deadline and intervals chosen from the measurements in the module header', () => {
    expect([RENDER_MEMORY_LIMIT_BYTES, RENDER_CALL_DEADLINE_MS, RENDER_SAMPLE_INTERVAL_MS, RENDER_IDLE_SAMPLE_INTERVAL_MS]).toEqual([3072 * MiB, 60_000, 250, 2000]);
  });
});

describe('RenderBreaker', () => {
  it('opens after three kills within ten minutes, fails page calls fast for the cooldown, and logs when it opens and closes', () => {
    let now = 0;
    const warn = vi.fn();
    const breaker = new RenderBreaker({ now: () => now, log: { warn } });
    breaker.recordKill();
    now += 4 * 60_000;
    breaker.recordKill();
    expect(() => breaker.check()).not.toThrow();
    // The first has left the window: still two
    now += 7 * 60_000;
    breaker.recordKill();
    expect(() => breaker.check()).not.toThrow();
    now += 60_000;
    breaker.recordKill();
    expect(() => breaker.check()).toThrow(RenderPageUnavailable);
    expect(warn).toHaveBeenCalledTimes(1);
    now += 9 * 60_000;
    expect(() => breaker.check()).toThrow(RenderPageUnavailable);
    now += 60_000;
    expect(() => breaker.check()).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[1][0]).toContain('cooldown is over');
  });
});

describe('the process table', () => {
  it('reads ps output and finds a tree by parent pid, also below a root that is gone', () => {
    const parsed = parsePs('  100     1   100  2048\n  101   100   100  1024\nnot a row\n  102   101   100   512\n  300     1   300  1\n');
    expect(parsed).toEqual([
      { pid: 100, ppid: 1, pgid: 100, rssBytes: 2048 * 1024 },
      { pid: 101, ppid: 100, pgid: 100, rssBytes: 1024 * 1024 },
      { pid: 102, ppid: 101, pgid: 100, rssBytes: 512 * 1024 },
      { pid: 300, ppid: 1, pgid: 300, rssBytes: 1024 },
    ]);
    expect(processTree(parsed!, 100).map((row) => row.pid)).toEqual([100, 101, 102]);
    // The root has exited; its children still name it
    expect(processTree(parsed!.slice(1), 100).map((row) => row.pid)).toEqual([101, 102]);
    expect(parsePs('')).toBeNull();
    expect(parsePs('PID PPID PGID RSS\nx y z w')).toBeNull();
  });

  it('reads this machine through ps, and finds this process in it with its group', async () => {
    const table = await psTable();
    expect(table).not.toBeNull();
    const me = table!.find((row) => row.pid === process.pid);
    expect(me?.rssBytes).toBeGreaterThan(0);
    expect(me?.pgid).toBeGreaterThan(0);
  });
});
