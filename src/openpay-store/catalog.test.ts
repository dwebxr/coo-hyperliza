import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from '@elizaos/core';
import { StoreCatalog, parseHandles, parseLocale, purchaseUrlProblem, sanitizeText, toStoreProduct } from './catalog';
import { createOpenPayStorePlugin } from './index';

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

  it('also replaces C1 controls such as NEL (U+0085), which \\s does not match', () => {
    expect(sanitizeText('Nice\u0085board\u009b2J', 100)).toBe('Nice board 2J');
  });

  it('removes bidi overrides and isolates, zero-width characters and tag characters, so the text shows as it reads', () => {
    // "HoverBoard" spelled so that it displays reversed, and with invisible characters inside
    expect(sanitizeText('\u202edraoBrevoH\u202c', 100)).toBe('draoBrevoH');
    expect(sanitizeText('Ho\u200bver\u200cBo\u2060ard\ufeff', 100)).toBe('HoverBoard');
    expect(sanitizeText('\u2066Free\u2069 \u061c\u200e\u200fgift', 100)).toBe('Free gift');
    expect(sanitizeText('Sale\u{e0041}\u{e007f}', 100)).toBe('Sale');
    expect(sanitizeText('line\u2028break\u2029s', 100)).toBe('line break s');
    // Counted after they are gone
    expect(sanitizeText(`${'\u200b'.repeat(50)}abcdef`, 5)).toBe('abcd…');
    expect(sanitizeText('\u200b\u202e', 5)).toBe('');
  });
});

describe('toStoreProduct', () => {
  it('whitelists fields and keeps the url as the API sent it', () => {
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

  it('accepts a purchase URL only when it is exactly what it parses to: the value posted to chat is the value that was checked', () => {
    const good = `${ORIGIN}/ja/@alice?product=h_1&from=agent`;
    expect(toStoreProduct(item('h_1', 'alice', { url: good }), ORIGIN)?.url).toBe(good);
    expect(toStoreProduct(item('h_1', 'alice', { url: `${ORIGIN}/en/@alice/items?product=h_1&note=%E3%83%9B%E3%83%90%E3%83%BC` }), ORIGIN)).not.toBeNull();
    for (const [why, url] of [
      ['a newline in it', `${ORIGIN}/ja/@alice?product=h_1\nhttps://evil.test/pay`],
      ['a trailing newline', `${good}\n`],
      ['a leading space', ` ${good}`],
      ['a space in it', `${ORIGIN}/ja/@alice?product=h_1 https://evil.test/pay`],
      ['a tab in it', `${ORIGIN}/ja/@alice?product=h_1\tx`],
      ['a zero-width character in it', `${ORIGIN}/ja/@alice?product=h_1\u200b`],
      ['a bidi override in it', `${ORIGIN}/ja/@alice?product=\u202eh_1`],
      ['unencoded non-ASCII text', `${good}&note=ホバー`],
      ['an upper-case host', 'https://OPEN-PAY.JP/ja/@alice?product=h_1'],
      ['the default port written out', 'https://open-pay.jp:443/ja/@alice?product=h_1'],
      ['dot segments', `${ORIGIN}/ja/x/../@alice?product=h_1`],
      ['a backslash', `${ORIGIN}\\ja/@alice?product=h_1`],
      ['credentials', 'https://open-pay.jp@open-pay.jp/ja/@alice?product=h_1'],
      ['a user name that looks like the host', 'https://open-pay.jp:x@open-pay.jp/ja/@alice'],
      ['http', 'http://open-pay.jp/ja/@alice?product=h_1'],
      ['another origin', 'https://evil.test/ja/@alice?product=h_1'],
      ['a subdomain', 'https://pay.open-pay.jp/ja/@alice?product=h_1'],
      ['another scheme', 'javascript:alert(1)//open-pay.jp/@alice'],
      ['no scheme', 'open-pay.jp/ja/@alice'],
      ['more than 512 characters', `${good}&pad=${'a'.repeat(500)}`],
      ['a number', 42],
      ['nothing', undefined],
    ] as const) {
      expect(toStoreProduct(item('h_1', 'alice', { url }), ORIGIN), why).toBeNull();
    }
  });

  it('says why a purchase URL is refused: each check on its own', () => {
    const check = (url: unknown, allowedOrigin = ORIGIN) => purchaseUrlProblem(url, { allowedOrigin, handle: 'alice' });
    expect(check(`${ORIGIN}/ja/@alice?product=h_1`)).toBeNull();
    expect(check(`${ORIGIN}/ja/@alice?product=h_1\n`)).toBe('contains whitespace or an invisible character');
    expect(check(` ${ORIGIN}/ja/@alice`)).toBe('contains whitespace or an invisible character');
    expect(check(`${ORIGIN}/ja/@alice?x=\u200b`)).toBe('contains whitespace or an invisible character');
    expect(check(`${ORIGIN}/ja/@alice?x=${'a'.repeat(600)}`)).toBe('too long');
    expect(check('https://open-pay.jp:443/ja/@alice')).toBe('not in normal form');
    expect(check('https://user@open-pay.jp/ja/@alice')).toBe('has credentials');
    expect(check('https://evil.test/ja/@alice')).toBe("not on the API's origin");
    // Also when the listings API itself is configured without TLS: links are https or nothing
    expect(check('http://open-pay.jp/ja/@alice', 'http://open-pay.jp')).toBe('not https');
    expect(check('not a url')).toBe('contains whitespace or an invisible character');
    expect(check('nourl')).toBe('not a URL');
  });

  it("accepts a purchase URL only when its path names the item's own seller", () => {
    for (const url of [`${ORIGIN}/ja/@alice`, `${ORIGIN}/@alice/products/h_1`, `${ORIGIN}/en/@Alice?product=h_1`]) {
      expect(toStoreProduct(item('h_1', 'alice', { url }), ORIGIN), url).not.toBeNull();
    }
    for (const [why, url] of [
      ["another seller's page", `${ORIGIN}/ja/@mallory?product=h_1`],
      ['the seller only in the query', `${ORIGIN}/ja/@mallory?seller=@alice&x=/@alice`],
      ['the seller only in the fragment', `${ORIGIN}/ja/@mallory#/@alice`],
      ['the handle as a prefix of the segment', `${ORIGIN}/ja/@alice2?product=h_1`],
      ['the handle without @', `${ORIGIN}/ja/alice?product=h_1`],
      ['no seller at all', `${ORIGIN}/ja/store?product=h_1`],
      ['an encoded @', `${ORIGIN}/ja/%40alice?product=h_1`],
    ] as const) {
      expect(toStoreProduct(item('h_1', 'alice', { url }), ORIGIN), why).toBeNull();
      expect(purchaseUrlProblem(url, { allowedOrigin: ORIGIN, handle: 'alice' }), why).toBe('its path does not name the seller');
    }
  });

  it('rejects an item of a seller that is not configured, whatever the API was asked for', () => {
    const mallory = item('h_9', 'mallory');
    expect(toStoreProduct(mallory, ORIGIN, ['alice', 'bob'])).toBeNull();
    expect(toStoreProduct(mallory, ORIGIN, ['mallory'])).not.toBeNull();
    // Handles compare without case, as OPENPAY_STORE_HANDLES is read
    expect(toStoreProduct(item('h_1', 'Alice'), ORIGIN, ['alice'])).not.toBeNull();
    expect(toStoreProduct(mallory, ORIGIN, '*')).not.toBeNull();
    expect(toStoreProduct(mallory, ORIGIN)).not.toBeNull();
  });

  it('rejects items with malformed fields', () => {
    expect(toStoreProduct(item('h_1', 'alice', { totalJpyc: '1e9' }), ORIGIN)).toBeNull();
    expect(toStoreProduct(item('h_1', 'alice', { title: '  ' }), ORIGIN)).toBeNull();
    expect(toStoreProduct(item('h_1', 'alice', { title: '\u200b\u202e' }), ORIGIN)).toBeNull();
    expect(toStoreProduct(item('bad id!', 'alice'), ORIGIN)).toBeNull();
    expect(toStoreProduct(null, ORIGIN)).toBeNull();
  });

  it('rejects an amount longer than 15 digits or 18 decimals instead of showing it', () => {
    expect(toStoreProduct(item('h_1', 'alice', { totalJpyc: `${'9'.repeat(15)}.${'9'.repeat(18)}` }), ORIGIN)).not.toBeNull();
    expect(toStoreProduct(item('h_1', 'alice', { totalJpyc: '9'.repeat(16) }), ORIGIN)).toBeNull();
    expect(toStoreProduct(item('h_1', 'alice', { totalJpyc: `1.${'9'.repeat(19)}` }), ORIGIN)).toBeNull();
    expect(toStoreProduct(item('h_1', 'alice', { totalJpyc: `1${'0'.repeat(5000)}` }), ORIGIN)).toBeNull();
    // A number that only has an exponent form
    expect(toStoreProduct(item('h_1', 'alice', { totalJpyc: 1e21 }), ORIGIN)).toBeNull();
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

describe('StoreCatalog and what the API answers', () => {
  afterEach(() => vi.restoreAllMocks());

  it("sells only the seller a page was asked for: another seller's items in the answer are dropped, and said so once per page", async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    // The API ignores the handle and answers with everyone's products
    const fetchImpl = vi.fn(async () => ok([item('a1', 'alice'), item('m1', 'mallory'), item('m2', 'mallory', { url: `${ORIGIN}/ja/@alice?product=m2` }), item('b1', 'bob')]));
    const catalog = new StoreCatalog({ apiUrl: API, handles: ['alice', 'bob'], locale: 'ja' }, { fetchImpl: fetchImpl as any });
    await catalog.refresh();
    expect(catalog.list().map((p) => `${p.handle}/${p.id}`)).toEqual(['alice/a1', 'bob/b1']);
    expect(warn.mock.calls.flat().map(String).filter((line) => line.includes('rejected'))).toEqual([
      expect.stringContaining('@alice: 3 of 4 item(s) were rejected'),
      expect.stringContaining('@bob: 3 of 4 item(s) were rejected'),
    ]);
  });

  it('with "*" takes every seller, each with a purchase URL that names that seller', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => ok([item('a1', 'alice'), item('m1', 'mallory'), item('x1', 'carol', { url: `${ORIGIN}/ja/@mallory?product=x1` })]));
    const catalog = new StoreCatalog({ apiUrl: API, handles: '*', locale: 'ja' }, { fetchImpl: fetchImpl as any });
    await catalog.refresh();
    expect(catalog.list().map((p) => p.id)).toEqual(['a1', 'm1']);
  });

  it('looks at no more than the 100 items the API returns at most', async () => {
    const fetchImpl = vi.fn(async () => ok(Array.from({ length: 5000 }, (_, i) => item(`a${i}`, 'alice', { updatedAt: 5000 - i }))));
    const catalog = new StoreCatalog({ apiUrl: API, handles: ['alice'], locale: 'ja' }, { fetchImpl: fetchImpl as any });
    await catalog.refresh();
    expect(catalog.list()).toHaveLength(100);
    expect(catalog.list()[99].id).toBe('a99');
  });
});

/*
 * A SYNTHETIC listings response (fixtures/listings.synthetic.json): written by hand from the shape
 * this module and its tests document, not recorded from the Store. It guards against a change here
 * that would silently empty the shop for responses of that shape. What only a recorded real
 * response would prove is listed in the fixture's own note and in the README.
 */
describe('the synthetic listings fixture (not a recorded response)', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/listings.synthetic.json', import.meta.url), 'utf8')) as { _synthetic: string; ok: boolean; items: Record<string, any>[] };
  // The API answers a request for one seller with that seller's items
  const listingsApi = vi.fn(async (url: URL) => {
    const handle = url.searchParams.get('handle');
    return new Response(JSON.stringify({ ok: true, items: fixture.items.filter((entry) => !handle || entry.handle === handle) }), { status: 200 });
  });

  it('says of itself that it is synthetic', () => {
    expect(fixture._synthetic).toContain('NOT a recorded response');
  });

  it.each([
    ['the handles of .env.example', ['coo', 'cipherweb'] as string[] | '*'],
    ['every seller', '*' as string[] | '*'],
  ])('still yields every product of the fixture, unchanged, for %s', async (_what, handles) => {
    const catalog = new StoreCatalog({ apiUrl: API, handles, locale: 'ja' }, { fetchImpl: listingsApi as any });
    await catalog.refresh();
    const products = catalog.list();
    expect(products).toHaveLength(fixture.items.length);
    expect(products.map((p) => p.id)).toEqual(fixture.items.map((entry) => entry.id));
    for (const entry of fixture.items) {
      const product = products.find((p) => p.id === entry.id)!;
      expect(product).toMatchObject({ title: entry.title, handle: entry.handle, totalJpyc: entry.totalJpyc, url: entry.url });
      expect(product.desc).toBe(entry.desc);
      expect(product.category).toBe(entry.category);
    }
    // A ZWJ emoji loses its joiners (format characters) and stays an emoji
    expect(products.find((p) => p.id === 'h_avatar04')!.emoji).toBe('🧑🎤');
    expect(products.find((p) => p.id === 'h_hoverboard01')!.emoji).toBe('🛹');
  });

  it('puts the fixture on the shelf of the shop plugin and shares its purchase links', async () => {
    const plugin = createOpenPayStorePlugin({ OPENPAY_STORE_HANDLES: 'coo,cipherweb' }, { fetchImpl: listingsApi as unknown as typeof fetch })!;
    await plugin.init!({}, { agentId: 'fixture-agent' } as any);
    const [provider] = plugin.providers!;
    const [action] = plugin.actions!;
    await vi.waitFor(async () => expect(await action.validate({} as any, {} as any)).toBe(true));
    const shelf = await provider.get({ agentId: 'fixture-agent', character: { name: 'Coo' } } as any, { entityId: 'player', content: { text: 'what do you sell?' } } as any, {} as any);
    for (const entry of fixture.items) expect(shelf.text).toContain(`[${entry.id}]`);
    const callback = vi.fn();
    await action.handler({ agentId: 'fixture-agent' } as any, { entityId: 'player', content: { text: 'link please', source: 'hyperfy' } } as any, undefined, {}, callback, [{ content: { text: 'Sure!', productId: 'h_matcha03' } }] as any);
    expect(callback.mock.calls[0][0].text).toBe('🛒 🍵 抹茶ラテのレシピ — 110 JPYC\nhttps://open-pay.jp/ja/@coo?product=h_matcha03&from=agent');
  });
});
