import { logger } from '@elizaos/core';
import { stripControlChars, stripInvisibleChars, truncateCodePoints } from '../plugin-hyperfy/lib/text';
import { safeFetch, toResponse } from '../plugin-hyperfy/lib/net-policy';

/**
 * Products from the public OpenPay Store listings API
 * (GET /api/store/listings: handle, q, category, limit, locale — any other param is a 400).
 */

export const DEFAULT_OPENPAY_STORE_API_URL = 'https://open-pay.jp/api/store/listings';
const LIMIT = 100; // API maximum
const TTL_MS = 5 * 60_000; // the API's data is up to ~4 minutes stale anyway
const TIMEOUT_MS = 10_000;
const RETRY_BASE_MS = 30_000; // after a failure: 30 s, 60 s, ... up to the TTL
// 100 listings are a few hundred kilobytes at most
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/**
 * The listings request, under the outbound policy (lib/net-policy.ts): the API must be a public
 * https host, a redirect cannot lead inside the agent's network, and the answer is cut off at
 * MAX_RESPONSE_BYTES and TIMEOUT_MS.
 */
const fetchListings = async (url: URL): Promise<Response> => toResponse(await safeFetch(url.href, { maxBytes: MAX_RESPONSE_BYTES, timeoutMs: TIMEOUT_MS }));

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
  /**
   * Purchase page, exactly as the API sent it. Only accepted when it is a plain https URL on the
   * API's own origin whose path names this product's seller (see purchaseUrlProblem).
   */
  url: string;
  /** Milliseconds; used to keep the merged list newest-first across sellers. */
  updatedAt: number;
}

export interface StoreCatalogConfig {
  apiUrl: string;
  /** Seller handles to sell, or '*' for every Store product. */
  handles: string[] | '*';
  locale: StoreLocale;
}

/**
 * Collapses seller-provided text to one short line that cannot break the XML-ish prompt or
 * reply format (no <, >, backticks, control characters or newlines) and shows as it reads:
 * format characters (bidi overrides and isolates, zero-width characters, tags) are removed.
 */
export function sanitizeText(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  // Controls and line separators become a space; format characters, which have no width, go
  const clean = stripInvisibleChars(stripControlChars(value, ' ').replace(/[\u2028\u2029]/g, ' '))
    .replace(/[<>`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return truncateCodePoints(clean, max, '…');
}

const HANDLE = /^[\w.-]{1,64}$/;
const ID = /^[\w.-]{1,128}$/;
// What the buyer pays: at most 15 digits and 18 decimals (JPYC's own precision). Anything longer
// is not an amount a person reads; the item is dropped
const AMOUNT = /^\d{1,15}(\.\d{1,18})?$/;
// A purchase URL as the Store writes it is well under this
const MAX_URL_LENGTH = 512;
const URL_UNSAFE = /[\s\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/**
 * Why `url` is not accepted as the purchase page of a product of seller `handle`, or null when it
 * is. It is posted to chat as it is, so it must be exactly what it parses to: a plain https URL on
 * `allowedOrigin` without credentials, whitespace, control or format characters, already in its
 * normal form (so nothing is hidden in an encoding the chat client might undo), and its path must
 * name the seller as a segment `@handle`.
 */
export function purchaseUrlProblem(url: unknown, { allowedOrigin, handle }: { allowedOrigin: string; handle: string }): string | null {
  if (typeof url !== 'string') return 'not text';
  if (url.length > MAX_URL_LENGTH) return 'too long';
  if (URL_UNSAFE.test(url)) return 'contains whitespace or an invisible character';
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'not a URL';
  }
  if (parsed.protocol !== 'https:') return 'not https';
  if (parsed.username || parsed.password) return 'has credentials';
  if (parsed.origin !== allowedOrigin) return "not on the API's origin";
  if (parsed.href !== url) return 'not in normal form';
  const seller = `@${handle.toLowerCase()}`;
  if (!parsed.pathname.split('/').some((segment) => segment.toLowerCase() === seller)) return 'its path does not name the seller';
  return null;
}

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

/**
 * Whitelists one API item; null when it is malformed, its seller is not one of `sellers` (the
 * configured handles, compared without case; '*' is every seller), or its url is not that
 * seller's purchase page (purchaseUrlProblem). The API is asked per seller, but what it answers is
 * checked here: an item of another seller is never sold.
 */
export function toStoreProduct(item: any, allowedOrigin: string, sellers: readonly string[] | '*' = '*'): StoreProduct | null {
  if (!item || typeof item !== 'object') return null;
  const { id, handle, url } = item;
  // Strings per the API contract; a finite number is tolerated in case that ever changes
  const totalJpyc = typeof item.totalJpyc === 'number' && Number.isFinite(item.totalJpyc) ? String(item.totalJpyc) : item.totalJpyc;
  if (typeof id !== 'string' || !ID.test(id)) return null;
  if (typeof handle !== 'string' || !HANDLE.test(handle)) return null;
  if (sellers !== '*' && !sellers.some((seller) => seller.toLowerCase() === handle.toLowerCase())) return null;
  if (typeof totalJpyc !== 'string' || !AMOUNT.test(totalJpyc)) return null;
  const title = sanitizeText(item.title, 120);
  if (!title) return null;
  if (purchaseUrlProblem(url, { allowedOrigin, handle }) !== null) return null;
  const updatedAt = typeof item.updatedAt === 'number' && Number.isFinite(item.updatedAt) ? item.updatedAt : 0;

  // The url string itself is kept as the API sent it
  const product: StoreProduct = { id, title, handle, totalJpyc, url, updatedAt };
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
 * is cached and refreshes in the background when due (every TTL after a success; with backoff
 * after a failure). Transient failures (5xx, timeouts, unreadable bodies) keep the last good list.
 */
export class StoreCatalog {
  private products: StoreProduct[] = [];
  private nextAttemptAt = 0;
  private failures = 0;
  private inflight: Promise<void> | null = null;
  private readonly origin: string;

  constructor(
    private readonly config: StoreCatalogConfig,
    private readonly options: { fetchImpl?: typeof fetch; now?: () => number; ttlMs?: number } = {}
  ) {
    this.origin = new URL(config.apiUrl).origin;
  }

  list(): StoreProduct[] {
    if (this.now() >= this.nextAttemptAt) void this.refresh();
    return this.products;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
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
    const ttl = this.options.ttlMs ?? TTL_MS;
    // allSettled: the refresh stays in flight until every seller's request has finished
    const results = await Promise.allSettled(handles === '*' ? [this.fetchPage()] : handles.map((h) => this.fetchPage(h)));
    const failure = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failure) {
      // Keep the previous list and back off before the next attempt
      this.failures++;
      this.nextAttemptAt = this.now() + Math.min(RETRY_BASE_MS * 2 ** (this.failures - 1), ttl);
      logger.warn(`[OpenPayStore] Could not refresh products (keeping ${this.products.length}): ${failure.reason?.message || failure.reason}`);
      return;
    }

    const seen = new Set<string>();
    const products: StoreProduct[] = [];
    for (const result of results as PromiseFulfilledResult<StoreProduct[]>[]) {
      for (const product of result.value) {
        if (seen.has(product.id)) continue;
        seen.add(product.id);
        products.push(product);
      }
    }
    // Newest first across sellers, like the API orders each page (stable for equal times)
    products.sort((a, b) => b.updatedAt - a.updatedAt);
    this.products = products;
    this.failures = 0;
    this.nextAttemptAt = this.now() + ttl;
    logger.info(`[OpenPayStore] Loaded ${products.length} product(s)`);
  }

  private async fetchPage(handle?: string): Promise<StoreProduct[]> {
    const url = new URL(this.config.apiUrl);
    // Only parameters the API accepts; anything else is a 400
    if (handle) url.searchParams.set('handle', handle);
    url.searchParams.set('limit', String(LIMIT));
    url.searchParams.set('locale', this.config.locale);

    let response: Response;
    try {
      response = this.options.fetchImpl ? await this.options.fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS) }) : await fetchListings(url);
    } catch (error: any) {
      throw new TransientError(`request failed: ${error?.message || error}`);
    }
    const source = handle ? `@${handle}` : 'All products';
    if (response.status === 400 || response.status === 404) {
      // invalid_query / not_found (store off): definitively nothing to sell from this source
      const body: any = await response.json().catch(() => null);
      logger.warn(`[OpenPayStore] ${source}: HTTP ${response.status} ${body?.error ?? ''}`.trim());
      return [];
    }
    if (!response.ok) throw new TransientError(`${source}: HTTP ${response.status}`);

    let body: any;
    try {
      body = await response.json();
    } catch (error: any) {
      // Includes the body read timing out after the headers arrived
      throw new TransientError(`${source}: unreadable response (${error?.message || error})`);
    }
    if (body?.ok !== true || !Array.isArray(body.items)) {
      throw new TransientError(`${source}: unexpected response shape`);
    }
    // A page asked for one seller holds that seller's products only; '*' takes every seller
    const sellers = handle ? [handle] : '*';
    // The API returns at most LIMIT items; more than that is not looked at
    const items: unknown[] = body.items.slice(0, LIMIT);
    const products = items.map((item) => toStoreProduct(item, this.origin, sellers)).filter(Boolean) as StoreProduct[];
    if (products.length < items.length) {
      logger.warn(`[OpenPayStore] ${source}: ${items.length - products.length} of ${items.length} item(s) were rejected (malformed, another seller's, or a purchase URL that is not a plain https link to that seller on the API's origin)`);
    }
    return products;
  }
}
