import { logger } from '@elizaos/core';

/**
 * Products from the public OpenPay Store listings API
 * (GET /api/store/listings: handle, q, category, limit, locale — any other param is a 400).
 */

export const DEFAULT_OPENPAY_STORE_API_URL = 'https://open-pay.jp/api/store/listings';
const LIMIT = 100; // API maximum
const TTL_MS = 5 * 60_000; // the API's data is up to ~4 minutes stale anyway
const TIMEOUT_MS = 10_000;

export type StoreLocale = 'ja' | 'en';

export interface StoreProduct {
  id: string;
  /** Seller-provided text, already sanitized for prompts and chat. */
  title: string;
  desc?: string;
  emoji?: string;
  category?: string;
  handle: string;
  /** What the buyer pays (price + fee), in JPYC. */
  totalJpyc: string;
  /** Purchase page, passed through unchanged (only accepted on the API's own origin). */
  url: string;
}

export interface StoreCatalogConfig {
  apiUrl: string;
  /** Seller handles to sell, or '*' for every Store product. */
  handles: string[] | '*';
  locale: StoreLocale;
}

/**
 * Collapses seller-provided text to one short line that cannot break the XML-ish prompt or
 * reply format (no <, >, backticks, control characters or newlines).
 */
export function sanitizeText(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const clean = value
    .replace(/[\u0000-\u001f\u007f<>`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

const HANDLE = /^[\w.-]{1,64}$/;
const ID = /^[\w.-]{1,128}$/;
const AMOUNT = /^\d+(\.\d+)?$/;

/** Parses OPENPAY_STORE_HANDLES. null when nothing usable is configured (feature off). */
export function parseHandles(raw: string | undefined): string[] | '*' | null {
  if (!raw?.trim()) return null;
  if (raw.trim() === '*') return '*';
  const handles: string[] = [];
  for (const part of raw.split(',')) {
    const handle = part.trim().replace(/^@/, '');
    if (!handle) continue;
    if (!HANDLE.test(handle)) {
      logger.warn(`[OpenPayStore] Ignoring invalid handle in OPENPAY_STORE_HANDLES: "${handle}"`);
      continue;
    }
    if (!handles.some((h) => h.toLowerCase() === handle.toLowerCase())) handles.push(handle);
  }
  return handles.length ? handles : null;
}

export function parseLocale(raw: string | undefined): StoreLocale {
  const locale = raw?.trim().toLowerCase();
  if (!locale) return 'ja';
  if (locale === 'ja' || locale === 'en') return locale;
  logger.warn(`[OpenPayStore] Unsupported OPENPAY_STORE_LOCALE "${raw}"; using ja`);
  return 'ja';
}

/** Whitelists one API item; null when it is malformed or its url is off the API's origin. */
export function toStoreProduct(item: any, allowedOrigin: string): StoreProduct | null {
  if (!item || typeof item !== 'object') return null;
  const { id, handle, totalJpyc, url } = item;
  if (typeof id !== 'string' || !ID.test(id)) return null;
  if (typeof handle !== 'string' || !HANDLE.test(handle)) return null;
  if (typeof totalJpyc !== 'string' || !AMOUNT.test(totalJpyc)) return null;
  const title = sanitizeText(item.title, 120);
  if (!title) return null;
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return null;
  }
  if (parsedUrl.origin !== allowedOrigin) return null;

  const product: StoreProduct = { id, title, handle, totalJpyc, url: parsedUrl.href };
  const desc = sanitizeText(item.desc, 200);
  if (desc) product.desc = desc;
  const emoji = sanitizeText(item.emoji, 4);
  if (emoji) product.emoji = emoji;
  const category = sanitizeText(item.category, 32);
  if (category) product.category = category;
  return product;
}

class TransientError extends Error {}

/**
 * In-memory copy of the configured products. list() never waits on the network: it returns what
 * is cached and refreshes in the background once the copy is older than the TTL. Transient
 * failures (503, timeouts) keep the last good list.
 */
export class StoreCatalog {
  private products: StoreProduct[] = [];
  private fetchedAt = 0;
  private inflight: Promise<void> | null = null;
  private readonly origin: string;

  constructor(
    private readonly config: StoreCatalogConfig,
    private readonly options: { fetchImpl?: typeof fetch; now?: () => number; ttlMs?: number } = {}
  ) {
    this.origin = new URL(config.apiUrl).origin;
  }

  list(): StoreProduct[] {
    const now = this.options.now?.() ?? Date.now();
    if (now - this.fetchedAt >= (this.options.ttlMs ?? TTL_MS)) void this.refresh();
    return this.products;
  }

  find(id: string): StoreProduct | undefined {
    return this.products.find((p) => p.id === id);
  }

  /** Single-flight; never rejects. */
  refresh(): Promise<void> {
    if (!this.inflight) {
      this.inflight = this.load().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  private async load(): Promise<void> {
    const handles = this.config.handles;
    try {
      const pages = await Promise.all(handles === '*' ? [this.fetchPage()] : handles.map((h) => this.fetchPage(h)));
      const seen = new Set<string>();
      const products: StoreProduct[] = [];
      for (const product of pages.flat()) {
        if (seen.has(product.id)) continue;
        seen.add(product.id);
        products.push(product);
      }
      this.products = products;
      this.fetchedAt = this.options.now?.() ?? Date.now();
      logger.info(`[OpenPayStore] Loaded ${products.length} product(s)`);
    } catch (error: any) {
      // Keep the previous list; try again on a later list() call
      logger.warn(`[OpenPayStore] Could not refresh products (keeping ${this.products.length}): ${error?.message || error}`);
    }
  }

  private async fetchPage(handle?: string): Promise<StoreProduct[]> {
    const url = new URL(this.config.apiUrl);
    // Only parameters the API accepts; anything else is a 400
    if (handle) url.searchParams.set('handle', handle);
    url.searchParams.set('limit', String(LIMIT));
    url.searchParams.set('locale', this.config.locale);

    let response: Response;
    try {
      response = await (this.options.fetchImpl ?? fetch)(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (error: any) {
      throw new TransientError(`request failed: ${error?.message || error}`);
    }
    if (response.status === 503 || response.status >= 500) {
      throw new TransientError(`HTTP ${response.status}`);
    }
    const body: any = await response.json().catch(() => null);
    if (!response.ok || body?.ok !== true || !Array.isArray(body.items)) {
      // 400 invalid_query / 404 not_found (store off): nothing to sell from this source
      logger.warn(`[OpenPayStore] ${handle ? `@${handle}` : 'All products'}: HTTP ${response.status} ${body?.error ?? ''}`.trim());
      return [];
    }
    return body.items.map((item: any) => toStoreProduct(item, this.origin)).filter(Boolean) as StoreProduct[];
  }
}
