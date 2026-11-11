/**
 * A process-wide reservation for the agent's own memory while assets are on their way: the
 * download, the base64 strings that carry it to the render page and back, the copy the page
 * returns, and the engine's parse of that copy in this process. The render page itself is bounded
 * by lib/render-watchdog.ts; this bounds the agent's side, which no watchdog measures.
 *
 * Two pools, so that no load waits while holding what another needs (no deadlock):
 *   - downloads (ASSET_DOWNLOAD_POOL_BYTES): a load reserves 2 × the kind's download cap before it
 *     asks (the chunks and the one copy they are joined into), 2 × the declared Content-Length once
 *     the answer says it is smaller, and 2 × the actual size once the bytes are in;
 *   - work (ASSET_WORK_POOL_BYTES): the download is then exchanged, once, for what the rest costs
 *     (workBytes). For a model or avatar that is sized from the ceiling the render page is held to
 *     for this load (modelReservation), which the page is passed as its maxExportBytes and refuses
 *     to exceed, not from an estimate; an emote is parsed in this process and reserves its download
 *     plus what the glTF filter charged for it (systems/loader.ts parseEmote). Holders of work
 *     never wait for memory again (they may wait for the render page, lib/page-work.ts, whose
 *     holder has its memory already).
 * After the exchange a reservation only shrinks; one that does not fit its pool is refused, never
 * cut (a model's ceiling is lowered to fit first, and the model refused when even its estimated
 * export would not fit). So what the pools hold is never less than what these copies take, and the
 * agent's memory for assets on their way stays within the two pools, 1 GiB. Not counted: three.js
 * objects and the scene graph the engine builds from a parsed model, the transient buffers of a
 * single step beyond the copies above, the text of a data: URL an asset is named by (as long as
 * its base64, and for an avatar sent to the page as its key), and the loader's cache of finished
 * loads (bounded by itself, systems/loader.ts LOADER_LIMITS).
 */

const MiB = 1024 * 1024;
export const ASSET_DOWNLOAD_POOL_BYTES = 256 * MiB;
export const ASSET_WORK_POOL_BYTES = 768 * MiB;

/**
 * Copies per byte sent to the render page: the bytes, and three copies of their base64 (the
 * string, the message that carries it, the frame written to the socket), 1 + 3 × 4/3 = 5, rounded
 * up for what the message adds.
 */
export const SEND_COPIES = 6;
/**
 * Copies per byte the page returns: three copies of its base64 (the frame, the message, the
 * string; 3 × 4/3 = 4), the decoded copy, and the engine's copies of its BIN chunk and of its
 * buffer views (an export's views do not overlap): 7.
 */
export const RETURN_COPIES = 7;
/** What is left of a model's reservation per returned byte once the page's answer is decoded: the base64 string, the decoded copy, the engine's BIN and view copies (4/3 + 3, rounded up) */
export const PARSE_COPIES = 5;

export type AssetWorkKind = 'model' | 'avatar' | 'emote' | 'script' | 'image' | 'hdr';

/**
 * What the rest of an asset's way costs in this process, from its actual size: a script is
 * decoded to a string (up to 2 bytes per byte), an image or HDR is sent to the page. For a model,
 * `exportBytes` is the ceiling the page is held to (modelReservation).
 */
export function workBytes(kind: AssetWorkKind, bytes: number, exportBytes = 0): number {
  if (kind === 'script') return 3 * bytes;
  if (kind === 'image' || kind === 'hdr') return SEND_COPIES * bytes;
  return SEND_COPIES * bytes + RETURN_COPIES * exportBytes;
}

/**
 * How much a model or avatar of `downloadBytes` may get back from the render page, and what
 * that reserves. The ceiling is twice the filter's export estimate, or the download times the
 * room re-encoded textures need (an avatar keeps its textures in the export: 8 ×; a model,
 * whose texture slots are stripped, 2 ×), at least 1 MiB, and at most `exportCap` (the kind's
 * export budget, lib/gltf-budget.ts). It is lowered until the reservation fits `pool`; when even
 * the estimate does not fit, the load is refused.
 */
export function modelReservation(
  kind: 'model' | 'avatar' | 'emote',
  downloadBytes: number,
  exportEstimate: number,
  exportCap: number,
  pool = ASSET_WORK_POOL_BYTES
): { exportBytes: number; workBytes: number } | { problem: string } {
  const room = kind === 'avatar' ? 8 : 2;
  const fits = Math.floor((pool - SEND_COPIES * downloadBytes) / RETURN_COPIES);
  const exportBytes = Math.min(exportCap, Math.max(2 * exportEstimate, room * downloadBytes, MiB), fits);
  if (exportBytes < exportEstimate || exportBytes <= 0) {
    const needed = workBytes(kind, downloadBytes, exportEstimate);
    return { problem: `the ${kind} would need ${needed} bytes of the agent's memory for assets on their way, more than the ${pool} there are` };
  }
  return { exportBytes, workBytes: workBytes(kind, downloadBytes, exportBytes) };
}

/** Waiting for a reservation stopped: the caller's signal fired. */
export class AssetMemoryAborted extends Error {
  constructor() {
    super('[AssetMemory] Stopped waiting for memory: the load was cancelled');
    this.name = 'AbortError';
  }
}

interface Waiter {
  bytes: number;
  grant: () => void;
}

class Pool {
  used = 0;
  #queue: Waiter[] = [];
  constructor(readonly size: number) {}

  /** Waits for `bytes`, first come first served; more than the pool holds is refused at once. */
  take(bytes: number, signal?: AbortSignal): Promise<number> {
    const wanted = Math.max(0, Math.ceil(bytes));
    if (wanted > this.size) return Promise.reject(new Error(`[AssetMemory] ${wanted} bytes asked for, more than the ${this.size} this pool holds`));
    if (signal?.aborted) return Promise.reject(new AssetMemoryAborted());
    if (this.#queue.length === 0 && this.used + wanted <= this.size) {
      this.used += wanted;
      return Promise.resolve(wanted);
    }
    return new Promise<number>((resolve, reject) => {
      const waiter: Waiter = {
        bytes: wanted,
        grant: () => {
          signal?.removeEventListener('abort', onAbort);
          this.used += wanted;
          resolve(wanted);
        },
      };
      const onAbort = () => {
        this.#queue = this.#queue.filter((entry) => entry !== waiter);
        reject(new AssetMemoryAborted());
        this.#drain();
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.#queue.push(waiter);
    });
  }

  give(bytes: number) {
    this.used = Math.max(0, this.used - bytes);
    this.#drain();
  }

  get waiting(): number {
    return this.#queue.length;
  }

  #drain() {
    while (this.#queue.length && this.used + this.#queue[0].bytes <= this.size) (this.#queue.shift() as Waiter).grant();
  }
}

/** One asset's reservation: in the download pool, then (once) in the work pool, until it is released. */
export class AssetLease {
  #pool: Pool;
  #held: number;
  #released = false;
  #moving = false;
  constructor(
    readonly memory: AssetMemory,
    pool: Pool,
    held: number
  ) {
    this.#pool = pool;
    this.#held = held;
  }

  /** What this lease holds now, and in which pool */
  get bytes(): number {
    return this.#released ? 0 : this.#held;
  }
  get phase(): 'download' | 'work' | 'released' {
    return this.#released ? 'released' : this.#pool === this.memory.downloads ? 'download' : 'work';
  }

  /** Holds less (never waits, never grows): what the asset is now known to need */
  shrink(bytes: number): void {
    if (this.#released) return;
    const to = Math.max(0, Math.min(this.#held, Math.ceil(bytes)));
    this.#pool.give(this.#held - to);
    this.#held = to;
  }

  /**
   * Exchanges the download reservation for `bytes` of work, once; the download is given back when
   * the work is granted. A second exchange, or growing afterwards, is refused: a lease only shrinks.
   */
  async toWork(bytes: number, signal?: AbortSignal): Promise<void> {
    if (this.#released) return;
    if (this.#moving || this.#pool !== this.memory.downloads) throw new Error('[AssetMemory] A reservation moves to work once; after that it only shrinks');
    this.#moving = true;
    try {
      const granted = await this.memory.work.take(bytes, signal);
      // Released while it waited: the late grant goes straight back
      if (this.#released) {
        this.memory.work.give(granted);
        return;
      }
      this.#pool.give(this.#held);
      this.#pool = this.memory.work;
      this.#held = granted;
    } finally {
      this.#moving = false;
    }
  }

  release(): void {
    if (this.#released) return;
    this.#released = true;
    this.#pool.give(this.#held);
    this.#held = 0;
  }
}

export class AssetMemory {
  readonly downloads: Pool;
  readonly work: Pool;
  constructor({ downloadBytes = ASSET_DOWNLOAD_POOL_BYTES, workBytes: workPool = ASSET_WORK_POOL_BYTES }: { downloadBytes?: number; workBytes?: number } = {}) {
    this.downloads = new Pool(downloadBytes);
    this.work = new Pool(workPool);
  }

  /** A reservation for a download of at most `maxBytes` (twice that is held: the chunks and their joined copy). */
  async download(maxBytes: number, signal?: AbortSignal): Promise<AssetLease> {
    const held = await this.downloads.take(2 * maxBytes, signal);
    return new AssetLease(this, this.downloads, held);
  }

  /** What is held now (for tests) */
  get held(): { downloads: number; work: number } {
    return { downloads: this.downloads.used, work: this.work.used };
  }
}

/** The reservation for this process: shared by every world's loader and sky */
export const assetMemory = new AssetMemory();
