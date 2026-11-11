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
 *   - work (ASSET_WORK_POOL_BYTES): the download is then exchanged for what the rest costs, a
 *     weight from the actual bytes (workBytes): for a model, 4 × its bytes (the bytes, their base64
 *     and the message that carries it) plus 4 × the export the filter estimates (the returned
 *     base64, the decoded copy, and the engine's copies of its BIN chunk and buffer views); for a
 *     script 3 ×, for an image or HDR 4 × its bytes. Holders of work never wait on anything else.
 * A reservation larger than its pool is cut to the pool: such a load runs alone. Small files keep
 * the loader's concurrency; large ones serialise. The worst case stays at the two pools, 1 GiB,
 * plus what is not counted: three.js objects and the decoded scene graph, and the transient
 * buffers of a single step.
 */

const MiB = 1024 * 1024;
export const ASSET_DOWNLOAD_POOL_BYTES = 256 * MiB;
export const ASSET_WORK_POOL_BYTES = 768 * MiB;

export type AssetWorkKind = 'model' | 'avatar' | 'emote' | 'script' | 'image' | 'hdr';

/** What the rest of an asset's way costs in this process, from its actual size and (models) the export estimate. */
export function workBytes(kind: AssetWorkKind, bytes: number, exportEstimate = 0): number {
  if (kind === 'script') return 3 * bytes;
  if (kind === 'image' || kind === 'hdr') return 4 * bytes;
  return 4 * bytes + 4 * exportEstimate;
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
  fail: (error: Error) => void;
}

class Pool {
  used = 0;
  #queue: Waiter[] = [];
  constructor(readonly size: number) {}

  /** Waits for `bytes` (cut to the pool's size), first come first served */
  take(bytes: number, signal?: AbortSignal): Promise<number> {
    const wanted = Math.min(Math.max(0, Math.ceil(bytes)), this.size);
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
        fail: reject,
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

/** One asset's reservation: in the download pool, then in the work pool, until it is released. */
export class AssetLease {
  #pool: Pool;
  #held: number;
  #released = false;
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

  /** Holds less (never waits): what the asset is now known to need */
  shrink(bytes: number): void {
    if (this.#released) return;
    const to = Math.max(0, Math.min(this.#held, Math.ceil(bytes)));
    this.#pool.give(this.#held - to);
    this.#held = to;
  }

  /** Exchanges the download reservation for `bytes` of work; the download is given back once the work is granted. */
  async toWork(bytes: number, signal?: AbortSignal): Promise<void> {
    if (this.#released) return;
    if (this.#pool === this.memory.work) {
      // Already working: grow by what is missing (work holders never wait on anything else)
      if (bytes > this.#held) {
        const more = await this.memory.work.take(bytes - this.#held, signal);
        this.#held += more;
      }
      return;
    }
    const granted = await this.memory.work.take(bytes, signal);
    if (this.#released) {
      this.memory.work.give(granted);
      return;
    }
    this.#pool.give(this.#held);
    this.#pool = this.memory.work;
    this.#held = granted;
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

  /** What is held now (for tests and reports) */
  get held(): { downloads: number; work: number } {
    return { downloads: this.downloads.used, work: this.work.used };
  }
}

/** The reservation for this process: shared by every world's loader and sky */
export const assetMemory = new AssetMemory();
