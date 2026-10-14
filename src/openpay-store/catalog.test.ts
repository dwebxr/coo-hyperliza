import { describe, expect, it, vi } from 'vitest';
import { StoreCatalog, parseHandles, parseLocale, sanitizeText, toStoreProduct } from './catalog';

const API = 'https://open-pay.jp/api/store/listings';
const ORIGIN = 'https://open-pay.jp';

function item(id: string, handle: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    title: `Product ${id}`,
    priceJpyc: '100',
    feeJpyc: '1',
    totalJpyc: '101',
    usdcEnabled: false,
    tags: [],
    handle,
    updatedAt: 1,
    url: `${ORIGIN}/ja/@${handle}?product=${id}&from=agent`,
    ...extra,
  };
}

const ok = (items: unknown[]) => new Response(JSON.stringify({ ok: true, items }), { status: 200 });

describe('config parsing', () => {
  it('parses handles: trims, strips @, dedupes case-insensitively, drops invalid ones', () => {
    expect(parseHandles(' masia02, @Cipherweb ,bad handle!, cipherweb')).toEqual(['masia02', 'Cipherweb']);
    expect(parseHandles('*')).toBe('*');
    expect(parseHandles('')).toBeNull();
    expect(parseHandles(' , ')).toBeNull();
    expect(parseHandles(undefined)).toBeNull();
  });

  it('accepts ja/en locales and falls back to ja', () => {
    expect(parseLocale('EN')).toBe('en');
    expect(parseLocale(undefined)).toBe('ja');
    expect(parseLocale('fr')).toBe('ja');
  });
});

describe('sanitizeText', () => {
  it('produces one safe line', () => {
    expect(sanitizeText('Nice\nboard <response>`x`</response>\t!', 100)).toBe('Nice board response x /response !');
    expect(sanitizeText('a'.repeat(10), 5)).toBe('aaaa…');
    expect(sanitizeText(42, 5)).toBe('');
  });

  it('never cuts an emoji in half', () => {
    const cut = sanitizeText('🛹🛹🛹', 2);
    expect(cut).toBe('🛹…');
    expect(cut).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
});

describe('toStoreProduct', () => {
  it('whitelists fields and passes the url through', () => {
    const product = toStoreProduct(item('h_1', 'alice', { desc: 'Desc', emoji: '🛹', category: '3d-game', secret: 'x' }), ORIGIN);
    expect(product).toEqual({
      id: 'h_1',
      title: 'Product h_1',
      handle: 'alice',
      totalJpyc: '101',
      url: `${ORIGIN}/ja/@alice?product=h_1&from=agent`,
      desc: 'Desc',
      emoji: '🛹',
      category: '3d-game',
      updatedAt: 1,
    });
  });

  it('keeps the url exactly as the API sent it', () => {
    const url = `${ORIGIN}/ja/@alice?product=h_1&from=agent&note=ホバー`;
    expect(toStoreProduct(item('h_1', 'alice', { url }), ORIGIN)?.url).toBe(url);
  });

  it('rejects items with a url off the API origin or malformed fields', () => {
    expect(toStoreProduct(item('h_1', 'alice', { url: 'https://evil.test/@alice' }), ORIGIN)).toBeNull();
    expect(toStoreProduct(item('h_1', 'alice', { url: 'not a url' }), ORIGIN)).toBeNull();
    expect(toStoreProduct(item('h_1', 'alice', { totalJpyc: '1e9' }), ORIGIN)).toBeNull();
    expect(toStoreProduct(item('h_1', 'alice', { title: '  ' }), ORIGIN)).toBeNull();
    expect(toStoreProduct(item('bad id!', 'alice'), ORIGIN)).toBeNull();
  });

  it('tolerates a numeric total', () => {
    expect(toStoreProduct(item('h_1', 'alice', { totalJpyc: 101 }), ORIGIN)?.totalJpyc).toBe('101');
  });
});

describe('StoreCatalog', () => {
  it('asks once per handle with only parameters the API accepts, then merges and dedupes in order', async () => {
    const fetchImpl = vi.fn(async (url: URL) =>
      url.searchParams.get('handle') === 'alice' ? ok([item('a1', 'alice'), item('shared', 'alice')]) : ok([item('shared', 'bob'), item('b1', 'bob')])
    );
    const catalog = new StoreCatalog({ apiUrl: API, handles: ['alice', 'bob'], locale: 'en' }, { fetchImpl: fetchImpl as any });
    await catalog.refresh();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    for (const [url] of fetchImpl.mock.calls) {
      expect([...url.searchParams.keys()].sort()).toEqual(['handle', 'limit', 'locale']);
      expect(url.searchParams.get('limit')).toBe('100');
      expect(url.searchParams.get('locale')).toBe('en');
    }
    expect(catalog.list().map((p) => p.id)).toEqual(['a1', 'shared', 'b1']);
  });

  it('asks once without a handle for "*"', async () => {
    const fetchImpl = vi.fn(async (_url: URL) => ok([item('x', 'anyone')]));
    const catalog = new StoreCatalog({ apiUrl: API, handles: '*', locale: 'ja' }, { fetchImpl: fetchImpl as any });
    await catalog.refresh();
    const url = fetchImpl.mock.calls[0][0] as URL;
    expect(url.searchParams.has('handle')).toBe(false);
    expect(catalog.list()).toHaveLength(1);
  });

  it('never waits on the network: a cold list() is empty and starts a fetch', async () => {
    let release!: (r: Response) => void;
    const fetchImpl = vi.fn(() => new Promise<Response>((r) => (release = r)));
    const catalog = new StoreCatalog({ apiUrl: API, handles: ['alice'], locale: 'ja' }, { fetchImpl: fetchImpl as any });
    expect(catalog.list()).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    release(ok([item('a1', 'alice')]));
    await vi.waitFor(() => expect(catalog.list()).toHaveLength(1));
  });

  it('refreshes only after the TTL and never runs two refreshes at once', async () => {
    let now = 0;
    const fetchImpl = vi.fn(async () => ok([item('a1', 'alice')]));
    const catalog = new StoreCatalog({ apiUrl: API, handles: ['alice'], locale: 'ja' }, { fetchImpl: fetchImpl as any, now: () => now, ttlMs: 1000 });
    await Promise.all([catalog.refresh(), catalog.refresh()]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    now = 500;
    catalog.list();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    now = 1000;
    catalog.list();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('keeps the last good list on 503 or a network error', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(ok([item('a1', 'alice')]));
    const catalog = new StoreCatalog({ apiUrl: API, handles: ['alice'], locale: 'ja' }, { fetchImpl: fetchImpl as any });
    await catalog.refresh();

    fetchImpl.mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error: 'storage_unavailable' }), { status: 503 }));
    await catalog.refresh();
    expect(catalog.list().map((p) => p.id)).toEqual(['a1']);

    fetchImpl.mockRejectedValueOnce(new Error('timeout'));
    await catalog.refresh();
    expect(catalog.list().map((p) => p.id)).toEqual(['a1']);
  });

  it('merges sellers newest-first so a new product from a later seller is not hidden', async () => {
    const fetchImpl = vi.fn(async (url: URL) =>
      url.searchParams.get('handle') === 'alice'
        ? ok([item('a_new', 'alice', { updatedAt: 50 }), item('a_old', 'alice', { updatedAt: 10 })])
        : ok([item('b_newest', 'bob', { updatedAt: 99 })])
    );
    const catalog = new StoreCatalog({ apiUrl: API, handles: ['alice', 'bob'], locale: 'ja' }, { fetchImpl: fetchImpl as any });
    await catalog.refresh();
    expect(catalog.list().map((p) => p.id)).toEqual(['b_newest', 'a_new', 'a_old']);
  });

  it('backs off after a failure instead of retrying on every list()', async () => {
    let now = 0;
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: false, error: 'storage_unavailable' }), { status: 503 }));
    const catalog = new StoreCatalog({ apiUrl: API, handles: ['alice'], locale: 'ja' }, { fetchImpl: fetchImpl as any, now: () => now });
    await catalog.refresh();
    for (let i = 0; i < 4; i++) catalog.list();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    now = 30_000;
    catalog.list();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    now = 30_000 + 59_999; // second failure: 60 s backoff
    catalog.list();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('stays in flight until every seller has answered, even if one fails fast', async () => {
    let releaseBob!: (r: Response) => void;
    const fetchImpl = vi.fn((url: URL) =>
      url.searchParams.get('handle') === 'alice'
        ? Promise.reject(new Error('reset'))
        : new Promise<Response>((r) => (releaseBob = r))
    );
    const catalog = new StoreCatalog({ apiUrl: API, handles: ['alice', 'bob'], locale: 'ja' }, { fetchImpl: fetchImpl as any });
    const first = catalog.refresh();
    await new Promise((r) => setTimeout(r, 0));
    expect(catalog.refresh()).toBe(first);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    releaseBob(ok([]));
    await first;
  });

  it('keeps the last good list when the body cannot be read or has the wrong shape', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(ok([item('a1', 'alice')]));
    const catalog = new StoreCatalog({ apiUrl: API, handles: ['alice'], locale: 'ja' }, { fetchImpl: fetchImpl as any });
    await catalog.refresh();

    fetchImpl.mockResolvedValueOnce({ status: 200, ok: true, json: () => Promise.reject(new Error('body timeout')) });
    await catalog.refresh();
    expect(catalog.list().map((p) => p.id)).toEqual(['a1']);

    fetchImpl.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await catalog.refresh();
    expect(catalog.list().map((p) => p.id)).toEqual(['a1']);
  });

  it('treats 404 (store off) and 400 as nothing to sell', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: false, error: 'not_found' }), { status: 404 }));
    const catalog = new StoreCatalog({ apiUrl: API, handles: ['alice'], locale: 'ja' }, { fetchImpl: fetchImpl as any });
    await catalog.refresh();
    expect(catalog.list()).toEqual([]);
  });
});
