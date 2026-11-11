/**
 * The run-time bound on the render page (managers/puppeteer-manager.ts). A world decides what the
 * page loads, and what loading costs is only known while it happens (lib/gltf-budget.ts is a
 * filter for the known cheap amplifiers, not a limit).
 *
 * Each browser the manager launches is one generation. For as long as it exists, the resident
 * memory of the processes it owns is sampled: the next sample starts RENDER_SAMPLE_INTERVAL_MS
 * after the previous one finished while a page call runs, RENDER_IDLE_SAMPLE_INTERVAL_MS after it
 * otherwise (timers that do not keep the process up), so the time `ps` takes adds to the gap.
 * It owns the browser, its descendants by parent pid, every process in its process group (puppeteer
 * starts Chromium detached, so the browser leads a group of its own, which a helper keeps when its
 * parent exits), and every process seen in an earlier sample whose group has not changed since.
 *
 * Over RENDER_MEMORY_LIMIT_BYTES, or with one page call past its deadline (RENDER_CALL_DEADLINE_MS;
 * page initialisation has RENDER_INIT_DEADLINE_MS), the generation is torn down at once: it is
 * marked dead, every call in flight fails with RenderPageKilled, every later call on it fails the
 * same way (with callsInFlight 0: it was not in flight, so it is not blamed), the owner is told
 * (and starts the next browser on next use), and its group and its processes are killed
 * (SIGKILL), once from the latest sample and again from a fresh one.
 *
 * Kills are counted process-wide (renderBreaker): after RENDER_KILLS_PER_WINDOW within
 * RENDER_KILL_WINDOW_MS the render page stays down for RENDER_COOLDOWN_MS, and page calls fail at
 * once with RenderPageUnavailable (the manager checks before it admits page work, also when a
 * launch or a page build it waited for completes). One line is logged when that starts and one
 * when it ends.
 *
 * What this cannot do:
 *   - Memory can overshoot the limit by what the page allocates within one sampling interval
 *     (plus the time `ps` takes) before the kill.
 *   - A kill discards everything the page held: textures, avatars and the environment are gone
 *     until the next connection brings them again (the same as any page rebuild).
 *   - Only the browser's processes are measured, by resident size (shared pages are counted in
 *     each process that maps them). The agent's own memory is bounded elsewhere (lib/asset-memory.ts).
 *   - A process that leaves both the browser's tree and its group before any sample sees it is not
 *     owned, measured or killed.
 *   - While `ps` cannot be read (missing, failing or unreadable output) memory is not watched: that
 *     is logged once when it starts and once when it ends, sampling is retried with a backoff of up
 *     to RENDER_SAMPLE_BACKOFF_MAX_MS, and page calls go on under their deadline only.
 */
import { spawn } from 'node:child_process';
import { childEnv } from './child-env';

const MiB = 1024 * 1024;

/**
 * Resident memory of the browser's processes above which it is killed. Measured by
 * scripts/smoke-chromium.mjs (macOS, the resident sizes of Chromium's processes summed, so shared
 * pages count in each): 0.85 to 0.86 GiB idle with the render page, at most 1.63 GiB through the
 * bundled avatar, environment, HDR and snapshots. A runaway page call was killed at 3.13 to 3.26 GiB.
 */
export const RENDER_MEMORY_LIMIT_BYTES = 3072 * MiB;
/** The longest one page call may take. The slowest bundled operation took under 0.5 s. */
export const RENDER_CALL_DEADLINE_MS = 60_000;
/** The longest building a page may take (new tab, its content, the render page script) */
export const RENDER_INIT_DEADLINE_MS = 30_000;
/** Sampling while a page call runs, and while none does */
export const RENDER_SAMPLE_INTERVAL_MS = 250;
export const RENDER_IDLE_SAMPLE_INTERVAL_MS = 2_000;
/** The longest wait between attempts while the process table cannot be read */
export const RENDER_SAMPLE_BACKOFF_MAX_MS = 30_000;
/** The circuit breaker: this many kills within the window keep the render page down for the cooldown */
export const RENDER_KILLS_PER_WINDOW = 3;
export const RENDER_KILL_WINDOW_MS = 10 * 60_000;
export const RENDER_COOLDOWN_MS = 10 * 60_000;
/** How long one `ps` may take before the sample counts as unreadable */
const PS_TIMEOUT_MS = 5_000;

export interface ProcessRow {
  pid: number;
  ppid: number;
  pgid: number;
  rssBytes: number;
}

/** The process table, or null when it cannot be read. */
export type ProcessTable = () => Promise<ProcessRow[] | null>;

/** `ps -A -o pid=,ppid=,pgid=,rss=` output (rss in KiB) as rows; null when no line reads as four numbers. */
export function parsePs(output: string): ProcessRow[] | null {
  const rows: ProcessRow[] = [];
  for (const line of output.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 4 || !fields.every((field) => /^\d+$/.test(field))) continue;
    const [pid, ppid, pgid, rss] = fields.map(Number);
    rows.push({ pid, ppid, pgid, rssBytes: rss * 1024 });
  }
  return rows.length ? rows : null;
}

/** The process table through `ps` (no shell, the reduced environment of lib/child-env.ts). */
export const psTable: ProcessTable = () =>
  new Promise((resolve) => {
    let output = '';
    let settled = false;
    const finish = (rows: ProcessRow[] | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(rows);
    };
    let ps: ReturnType<typeof spawn>;
    try {
      ps = spawn('ps', ['-A', '-o', 'pid=,ppid=,pgid=,rss='], { env: childEnv(), stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return resolve(null);
    }
    const timer = setTimeout(() => {
      ps.kill('SIGKILL');
      finish(null);
    }, PS_TIMEOUT_MS);
    ps.stdout?.setEncoding('utf8');
    ps.stdout?.on('data', (chunk: string) => (output += chunk));
    ps.on('error', () => finish(null));
    ps.on('close', (code) => finish(code === 0 ? parsePs(output) : null));
  });

/** `root` and its descendants, by parent pid. */
export function processTree(rows: readonly ProcessRow[], root: number): ProcessRow[] {
  const byParent = new Map<number, ProcessRow[]>();
  for (const row of rows) byParent.set(row.ppid, [...(byParent.get(row.ppid) ?? []), row]);
  const tree = rows.filter((row) => row.pid === root);
  const seen = new Set([root]);
  // Also from a root that is gone: its children may still name it as their parent
  const queue = [root];
  for (let i = 0; i < queue.length; i++) {
    for (const child of byParent.get(queue[i]) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      tree.push(child);
      queue.push(child.pid);
    }
  }
  return tree;
}

/** A page call that failed because its browser was torn down: over the memory limit, or past a deadline. */
export class RenderPageKilled extends Error {
  constructor(
    readonly reason: 'memory' | 'deadline',
    message: string,
    /** The owned processes' resident memory in the sample that led to the kill, when one was read */
    readonly measuredBytes: number | null,
    /** The browser generation it belonged to */
    readonly generation: number,
    /** How many page calls were in flight on that generation when it was torn down (0 for a call that came later) */
    readonly callsInFlight: number,
    /** Whether building the page was among them (then no asset's call was alone) */
    readonly initInFlight = false
  ) {
    super(message);
    this.name = 'RenderPageKilled';
  }

  /** The same kill, as a call that came after it sees it: it was not in flight, so it is no one's to blame */
  forLaterCall(): RenderPageKilled {
    return new RenderPageKilled(this.reason, this.message, this.measuredBytes, this.generation, 0, false);
  }
}

/** The render page is down for a cooldown, after too many kills (RenderBreaker). */
export class RenderPageUnavailable extends Error {
  constructor(readonly until: number) {
    super(`[RenderWatchdog] The render page is down until ${new Date(until).toISOString()}: Chromium was killed ${RENDER_KILLS_PER_WINDOW} times within ${RENDER_KILL_WINDOW_MS / 60_000} minutes`);
    this.name = 'RenderPageUnavailable';
  }
}

/** Counts kills across every browser and reconnect; opens for a cooldown after too many in a window. */
export class RenderBreaker {
  #kills: number[] = [];
  #openUntil: number | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  readonly #options: { kills: number; windowMs: number; cooldownMs: number; now: () => number; log: { warn(message: string): void } };

  constructor({ kills = RENDER_KILLS_PER_WINDOW, windowMs = RENDER_KILL_WINDOW_MS, cooldownMs = RENDER_COOLDOWN_MS, now = Date.now, log = console as { warn(message: string): void } } = {}) {
    this.#options = { kills, windowMs, cooldownMs, now, log };
  }

  /** The time the cooldown ends, while it lasts */
  get openUntil(): number | null {
    this.#closeIfDue();
    return this.#openUntil;
  }

  recordKill(): void {
    const now = this.#options.now();
    this.#kills = this.#kills.filter((at) => now - at < this.#options.windowMs);
    this.#kills.push(now);
    if (this.#openUntil !== null || this.#kills.length < this.#options.kills) return;
    this.#openUntil = now + this.#options.cooldownMs;
    this.#kills = [];
    this.#options.log.warn(`[RenderWatchdog] Chromium was killed ${this.#options.kills} times within ${this.#options.windowMs / 60_000} minutes: the render page stays down for ${this.#options.cooldownMs / 60_000} minutes (snapshots and page loads fail until then)`);
    this.#timer = setTimeout(() => this.#closeIfDue(), this.#options.cooldownMs);
    this.#timer.unref?.();
  }

  /** Throws RenderPageUnavailable while the cooldown lasts. */
  check(): void {
    const until = this.openUntil;
    if (until !== null) throw new RenderPageUnavailable(until);
  }

  #closeIfDue() {
    if (this.#openUntil === null || this.#options.now() < this.#openUntil) return;
    this.#openUntil = null;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    this.#options.log.warn('[RenderWatchdog] The render page cooldown is over: it starts again on next use');
  }
}

/** The breaker for this process: it outlives every browser, manager and world connection */
export const renderBreaker = new RenderBreaker();

export interface RenderWatchdogOptions {
  /**
   * Kills a torn-down generation's processes (SIGKILL): its process group when it has one (`group`),
   * and `pids`. Called once from the latest sample and once more from a fresh one.
   */
  kill: (pids: number[], group: number | null) => void;
  /** Told, synchronously, that a generation was torn down: drop its handles if they are still the current ones */
  onTornDown?: (generation: number) => void;
  table?: ProcessTable;
  limitBytes?: number;
  deadlineMs?: number;
  initDeadlineMs?: number;
  intervalMs?: number;
  idleIntervalMs?: number;
  breaker?: RenderBreaker;
  log?: { warn(message: string): void };
}

interface Call {
  reject: (error: RenderPageKilled) => void;
  deadline: ReturnType<typeof setTimeout>;
  init: boolean;
}

interface Generation {
  id: number;
  root: number | null;
  /** The browser's process group, once a sample shows it leads one (not this process's own group) */
  group: number | null;
  /** Processes seen owned, with the group they had then */
  owned: Map<number, number>;
  calls: Set<Call>;
  timer: ReturnType<typeof setTimeout> | null;
  sampling: boolean;
  backoff: number;
  /** Set when it is torn down: what every later call on it fails with */
  killed: RenderPageKilled | null;
  ended: boolean;
}

export class RenderWatchdog {
  readonly limitBytes: number;
  readonly deadlineMs: number;
  /** The deadline of a page initialisation (the owner passes it to watch()) */
  readonly initDeadlineMs: number;
  readonly intervalMs: number;
  readonly idleIntervalMs: number;
  readonly breaker: RenderBreaker;
  /** The owned processes' resident memory in the latest sample (null before the first, or without `ps`) */
  lastSampleBytes: number | null = null;
  /** The largest sample so far, and the longest page call that finished (for scripts/smoke-chromium.mjs, which reports them) */
  peakSampleBytes = 0;
  longestCallMs = 0;
  #options: RenderWatchdogOptions;
  #table: ProcessTable;
  #generations = new Map<number, Generation>();
  #measuring = true;
  #log: { warn(message: string): void };

  constructor(options: RenderWatchdogOptions) {
    this.#options = options;
    this.#table = options.table ?? psTable;
    this.limitBytes = options.limitBytes ?? RENDER_MEMORY_LIMIT_BYTES;
    this.deadlineMs = options.deadlineMs ?? RENDER_CALL_DEADLINE_MS;
    this.initDeadlineMs = options.initDeadlineMs ?? RENDER_INIT_DEADLINE_MS;
    this.intervalMs = options.intervalMs ?? RENDER_SAMPLE_INTERVAL_MS;
    this.idleIntervalMs = options.idleIntervalMs ?? RENDER_IDLE_SAMPLE_INTERVAL_MS;
    this.breaker = options.breaker ?? renderBreaker;
    this.#log = options.log ?? console;
  }

  /** Page calls in flight, over every live generation */
  get inFlight(): number {
    let count = 0;
    for (const generation of this.#generations.values()) count += generation.calls.size;
    return count;
  }

  /** Whether `ps` could be read at the latest sample */
  get measuring(): boolean {
    return this.#measuring;
  }

  /** The processes `generation` was seen to own, and its group (for scripts/smoke-chromium.mjs) */
  ownership(generation: number): { pids: number[]; group: number | null } {
    const state = this.#generations.get(generation);
    return { pids: state ? [...state.owned.keys()] : [], group: state?.group ?? null };
  }

  /**
   * A browser of this generation is up (`root` is its pid when known): it is sampled from now on.
   * A generation already over (torn down, or ended) is not revived: its browser is killed instead.
   */
  started(generation: number, root: number | null): void {
    const existing = this.#generations.get(generation);
    if (existing && (existing.killed || existing.ended)) {
      if (root !== null) this.#options.kill([root], null);
      return;
    }
    if (existing) {
      // Watched before its pid was known
      existing.root = root;
      if (root !== null && !existing.owned.has(root)) existing.owned.set(root, -1);
      return;
    }
    const state: Generation = { id: generation, root, group: null, owned: new Map(), calls: new Set(), timer: null, sampling: false, backoff: 0, killed: null, ended: false };
    if (root !== null) state.owned.set(root, -1);
    this.#generations.set(generation, state);
    this.#schedule(state, 0);
  }

  /** The browser of this generation is gone (closed, or it disconnected): it is no longer sampled. */
  ended(generation: number): void {
    const state = this.#generations.get(generation);
    if (!state) return;
    state.ended = true;
    if (state.timer !== null) clearTimeout(state.timer);
    state.timer = null;
    this.#prune();
  }

  /** Generations that are over are kept (so a late call on one still fails), the oldest dropped beyond a few */
  #prune() {
    const over = [...this.#generations.values()].filter((state) => state.ended || state.killed);
    for (const state of over.slice(0, Math.max(0, over.length - 16))) this.#generations.delete(state.id);
  }

  /** Whether `generation` is up and not torn down */
  isLive(generation: number): boolean {
    const state = this.#generations.get(generation);
    return !!state && !state.killed && !state.ended;
  }

  /**
   * Runs `work` (one page call on the browser of `generation`) under the watch: it fails with
   * RenderPageKilled when that generation is torn down meanwhile, and at once when it already was.
   * `deadlineMs` replaces the per-call deadline (page initialisation has its own).
   */
  async watch<T>(generation: number, work: () => Promise<T>, { deadlineMs = this.deadlineMs, init = false }: { deadlineMs?: number; init?: boolean } = {}): Promise<T> {
    let state = this.#generations.get(generation);
    if (!state) {
      // A browser whose launch did not report its pid; watched by the deadline (and sampled from now on)
      this.started(generation, null);
      state = this.#generations.get(generation) as Generation;
    }
    if (state.killed) throw state.killed.forLaterCall();
    if (state.ended) throw new Error(`[RenderWatchdog] The browser of generation ${generation} is gone`);
    const live = state;
    let call!: Call;
    const killed = new Promise<never>((_, reject) => {
      call = { reject, init, deadline: setTimeout(() => this.#tearDown(live, 'deadline', `a render page call ran longer than ${deadlineMs} ms`, null), deadlineMs) };
    });
    live.calls.add(call);
    // Busy now: sample at the shorter interval from here on
    this.#reschedule(live);
    const started = Date.now();
    try {
      const result = await Promise.race([work(), killed]);
      // Torn down while it ran, also when it returned in the same moment: it did not succeed
      if (live.killed) throw live.killed;
      this.longestCallMs = Math.max(this.longestCallMs, Date.now() - started);
      return result;
    } finally {
      clearTimeout(call.deadline);
      live.calls.delete(call);
    }
  }

  #reschedule(state: Generation) {
    if (state.sampling || state.killed || state.ended) return;
    if (state.timer !== null) clearTimeout(state.timer);
    state.timer = null;
    this.#schedule(state, 0);
  }

  #schedule(state: Generation, delay: number) {
    if (state.killed || state.ended || state.timer !== null || state.sampling) return;
    state.timer = setTimeout(() => {
      state.timer = null;
      void this.#sample(state);
    }, delay);
    state.timer.unref?.();
  }

  async #sample(state: Generation) {
    if (state.killed || state.ended) return;
    state.sampling = true;
    let rows: ProcessRow[] | null;
    try {
      rows = await this.#table();
    } catch {
      rows = null;
    } finally {
      state.sampling = false;
    }
    if (state.killed || state.ended) return;
    const interval = state.calls.size > 0 ? this.intervalMs : this.idleIntervalMs;
    if (rows === null) {
      if (this.#measuring) this.#log.warn('[RenderWatchdog] The process table cannot be read (ps): memory is not watched until it can be again; page calls go on under their deadline');
      this.#measuring = false;
      state.backoff = Math.min(Math.max(state.backoff * 2, interval), RENDER_SAMPLE_BACKOFF_MAX_MS);
      this.#schedule(state, state.backoff);
      return;
    }
    if (!this.#measuring) this.#log.warn('[RenderWatchdog] The process table can be read again: memory is watched again');
    this.#measuring = true;
    state.backoff = 0;
    const owned = this.#owned(state, rows);
    const total = owned.reduce((sum, row) => sum + row.rssBytes, 0);
    this.lastSampleBytes = total;
    this.peakSampleBytes = Math.max(this.peakSampleBytes, total);
    if (total > this.limitBytes) {
      this.#tearDown(state, 'memory', `the render page used ${total} bytes, more than ${this.limitBytes}`, total, rows);
      return;
    }
    this.#schedule(state, interval);
  }

  /** The rows `state` owns now, remembering them (see the module header). */
  #owned(state: Generation, rows: readonly ProcessRow[]): ProcessRow[] {
    const own = rows.find((row) => row.pid === process.pid)?.pgid ?? null;
    if (state.group === null && state.root !== null) {
      const root = rows.find((row) => row.pid === state.root);
      if (root && root.pgid === root.pid && root.pgid !== own) state.group = root.pgid;
    }
    const tree = new Set(state.root !== null ? processTree(rows, state.root).map((row) => row.pid) : []);
    const owned = rows.filter(
      (row) =>
        row.pid !== process.pid &&
        (tree.has(row.pid) || (state.group !== null && row.pgid === state.group) || (state.owned.has(row.pid) && (state.owned.get(row.pid) === row.pgid || state.owned.get(row.pid) === -1)))
    );
    for (const row of owned) state.owned.set(row.pid, row.pgid);
    return owned;
  }

  /**
   * Tears `state` down, synchronously before anything is awaited: marked dead, every call in flight
   * failed and its deadline cleared, the owner told, the kill counted. Then its processes are killed.
   */
  #tearDown(state: Generation, reason: 'memory' | 'deadline', message: string, measured: number | null, rows?: readonly ProcessRow[]) {
    if (state.killed) return;
    const error = new RenderPageKilled(reason, `[RenderWatchdog] ${message}: Chromium was killed and starts again on next use`, measured, state.id, state.calls.size, [...state.calls].some((call) => call.init));
    state.killed = error;
    if (state.timer !== null) clearTimeout(state.timer);
    state.timer = null;
    const calls = [...state.calls];
    state.calls.clear();
    for (const call of calls) {
      clearTimeout(call.deadline);
      call.reject(error);
    }
    this.#log.warn(error.message);
    this.breaker.recordKill();
    this.#options.onTornDown?.(state.id);
    // From what the latest sample showed, then again from a fresh one (helpers started since)
    const pidsOf = (table: readonly ProcessRow[] | null | undefined) => (table ? this.#owned(state, table).map((row) => row.pid) : [...state.owned.keys()]);
    this.#options.kill(pidsOf(rows), state.group);
    void this.#table()
      .catch(() => null)
      .then((table) => {
        if (table) this.#options.kill(pidsOf(table), state.group);
        this.#prune();
      });
  }
}
