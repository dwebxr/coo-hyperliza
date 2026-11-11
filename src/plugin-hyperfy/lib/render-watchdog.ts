/**
 * The run-time bound on the render page (managers/puppeteer-manager.ts). A world decides what the
 * page loads, and what loading costs is only known while it happens (lib/gltf-budget.ts is a
 * filter for the known cheap amplifiers, not a limit). So while a page call is in flight, the
 * resident memory of Chromium's whole process tree (the browser and everything it started, found
 * by parent pid) is sampled every RENDER_SAMPLE_INTERVAL_MS; when it exceeds
 * RENDER_MEMORY_LIMIT_BYTES, or one page call runs longer than RENDER_CALL_DEADLINE_MS, the whole
 * tree is killed (SIGKILL) and every page call in flight fails with RenderPageKilled. The manager
 * starts a new browser and page on the next use.
 *
 * What this cannot do:
 *   - Memory can overshoot the limit by what the page allocates within one sampling interval
 *     (plus the time `ps` takes) before the kill.
 *   - A kill discards everything the page held: textures, avatars and the environment are gone
 *     until the next connection brings them again (the same as any page rebuild).
 *   - Only Chromium's tree is measured, by resident size (shared pages are counted in each
 *     process that maps them). Memory the agent's own process uses is not watched here.
 *   - Without `ps` (or with output it cannot read) there is no memory watch: that is logged once,
 *     and the deadline still applies.
 *   - Nothing is sampled while no page call is in flight.
 */
import { spawn } from 'node:child_process';
import { childEnv } from './child-env';

const MiB = 1024 * 1024;

/**
 * Resident memory of Chromium's tree above which it is killed. Measured by scripts/smoke-chromium.mjs
 * (macOS, the resident sizes of Chromium's processes summed, so shared pages count in each): 0.86 GiB
 * idle with the render page, at most 1.6 GiB through the bundled avatar, environment, HDR and
 * snapshots. A runaway page call was killed at 3.26 GiB.
 */
export const RENDER_MEMORY_LIMIT_BYTES = 3072 * MiB;
/** The longest one page call may take. The slowest bundled operation took 0.3 s in the same run. */
export const RENDER_CALL_DEADLINE_MS = 60_000;
export const RENDER_SAMPLE_INTERVAL_MS = 250;
/** How long one `ps` may take before the sample counts as unreadable */
const PS_TIMEOUT_MS = 5_000;

export interface ProcessRow {
  pid: number;
  ppid: number;
  rssBytes: number;
}

/** The process table, or null when it cannot be read. */
export type ProcessTable = () => Promise<ProcessRow[] | null>;

/** `ps -A -o pid=,ppid=,rss=` output (rss in KiB) as rows; null when no line reads as three numbers. */
export function parsePs(output: string): ProcessRow[] | null {
  const rows: ProcessRow[] = [];
  for (const line of output.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 3 || !fields.every((field) => /^\d+$/.test(field))) continue;
    const [pid, ppid, rss] = fields.map(Number);
    rows.push({ pid, ppid, rssBytes: rss * 1024 });
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
      ps = spawn('ps', ['-A', '-o', 'pid=,ppid=,rss='], { env: childEnv(), stdio: ['ignore', 'pipe', 'ignore'] });
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
  for (let i = 0; i < tree.length; i++) {
    for (const child of byParent.get(tree[i].pid) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      tree.push(child);
    }
  }
  return tree;
}

/** A page call that failed because the render page was killed: over its memory limit, or past its deadline. */
export class RenderPageKilled extends Error {
  constructor(
    readonly reason: 'memory' | 'deadline',
    message: string,
    /** The tree's resident memory in the sample that led to the kill, when one was read */
    readonly measuredBytes: number | null
  ) {
    super(message);
    this.name = 'RenderPageKilled';
  }
}

export interface RenderWatchdogOptions {
  /** The browser's pid now, or null while there is none */
  rootPid: () => number | null;
  /** Kills these processes (SIGKILL; none when no pid is known) and drops the browser */
  kill: (pids: number[]) => void;
  table?: ProcessTable;
  limitBytes?: number;
  deadlineMs?: number;
  intervalMs?: number;
  log?: { warn(message: string): void };
}

interface Call {
  reject: (error: RenderPageKilled) => void;
  deadline: ReturnType<typeof setTimeout>;
}

export class RenderWatchdog {
  readonly limitBytes: number;
  readonly deadlineMs: number;
  readonly intervalMs: number;
  /** The tree's resident memory in the latest sample (null before the first, or without `ps`) */
  lastSampleBytes: number | null = null;
  /** The largest sample so far, and the longest page call that finished (for scripts/smoke-chromium.mjs, which reports them) */
  peakSampleBytes = 0;
  longestCallMs = 0;
  #options: RenderWatchdogOptions;
  #table: ProcessTable;
  #calls = new Set<Call>();
  #timer: ReturnType<typeof setTimeout> | null = null;
  #sampling = false;
  #unavailable = false;
  #log: { warn(message: string): void };

  constructor(options: RenderWatchdogOptions) {
    this.#options = options;
    this.#table = options.table ?? psTable;
    this.limitBytes = options.limitBytes ?? RENDER_MEMORY_LIMIT_BYTES;
    this.deadlineMs = options.deadlineMs ?? RENDER_CALL_DEADLINE_MS;
    this.intervalMs = options.intervalMs ?? RENDER_SAMPLE_INTERVAL_MS;
    this.#log = options.log ?? console;
  }

  /** Page calls in flight */
  get inFlight(): number {
    return this.#calls.size;
  }

  /** Runs `work` (one page call) under the watch: it fails with RenderPageKilled if the page is killed meanwhile. */
  async watch<T>(work: () => Promise<T>): Promise<T> {
    let call!: Call;
    const killed = new Promise<never>((_, reject) => {
      call = {
        reject,
        deadline: setTimeout(() => void this.#breach('deadline', `a render page call ran longer than ${this.deadlineMs} ms`, null), this.deadlineMs),
      };
    });
    this.#calls.add(call);
    this.#schedule(0);
    const started = Date.now();
    try {
      const result = await Promise.race([work(), killed]);
      this.longestCallMs = Math.max(this.longestCallMs, Date.now() - started);
      return result;
    } finally {
      clearTimeout(call.deadline);
      this.#calls.delete(call);
      if (this.#calls.size === 0) this.#stop();
    }
  }

  #schedule(delay: number) {
    if (this.#unavailable || this.#timer !== null || this.#sampling || this.#calls.size === 0) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.#sample();
    }, delay);
  }

  #stop() {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
  }

  async #sample() {
    if (this.#calls.size === 0) return;
    this.#sampling = true;
    let rows: ProcessRow[] | null;
    try {
      rows = await this.#table();
    } catch {
      rows = null;
    } finally {
      this.#sampling = false;
    }
    if (rows === null) {
      if (!this.#unavailable) this.#log.warn('[RenderWatchdog] The process table cannot be read (ps): the render page runs without a memory watchdog; the per-call deadline still applies');
      this.#unavailable = true;
      return;
    }
    const root = this.#options.rootPid();
    if (root !== null) {
      const total = processTree(rows, root).reduce((sum, row) => sum + row.rssBytes, 0);
      this.lastSampleBytes = total;
      this.peakSampleBytes = Math.max(this.peakSampleBytes, total);
      if (total > this.limitBytes && this.#calls.size > 0) {
        await this.#breach('memory', `the render page used ${total} bytes, more than ${this.limitBytes}`, total, rows);
        return;
      }
    }
    this.#schedule(this.intervalMs);
  }

  /** Kills the tree once and fails every call in flight. */
  async #breach(reason: 'memory' | 'deadline', message: string, measured: number | null, rows?: ProcessRow[] | null) {
    const calls = [...this.#calls];
    if (calls.length === 0) return;
    this.#calls.clear();
    this.#stop();
    const error = new RenderPageKilled(reason, `[RenderWatchdog] ${message}: Chromium was killed and starts again on next use`, measured);
    this.#log.warn(error.message);
    const root = this.#options.rootPid();
    let pids: number[] = [];
    if (root !== null) {
      // The tree as it is now (a deadline has no recent sample); the browser alone when it cannot be read
      const table = rows ?? (this.#unavailable ? null : await this.#table().catch(() => null));
      pids = table ? processTree(table, root).map((row) => row.pid) : [];
      if (pids.length === 0) pids = [root];
    }
    // Also with no pid known: the owner drops its browser and starts a new one
    this.#options.kill(pids);
    for (const call of calls) {
      clearTimeout(call.deadline);
      call.reject(error);
    }
  }
}
