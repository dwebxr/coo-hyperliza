import { describe, expect, it, vi } from 'vitest';
import { logger } from '@elizaos/core';
import { addressParts, findAddresses, type ScanSteps } from './addresses';
import { LINK_REMOVED, StoreCatalog, formatLinkMessage, isShareable, sanitizeText, shownText, toStoreProduct } from './catalog';
import { formatShelf } from './index';
import { composeOfflineReply } from '../plugin-hyperfy/lib/offline-reply';

const ORIGIN = 'https://open-pay.jp';
const URL_OF = (id: string) => `${ORIGIN}/ja/@alice?product=${id}&from=agent`;
const listing = (extra: Record<string, unknown>): Record<string, unknown> => ({ id: 'h_1', handle: 'alice', title: 'Board', totalJpyc: '505', url: URL_OF('h_1'), updatedAt: 1, ...extra });

// A seller's text naming another place to pay or to write to, in the spellings a reader would follow
const ADDRESSES = [
  // Internationalized host names, also after a name@ and with the address's own dots
  'Pay at 支払.jp/pay',
  'Pay at 支払.jp',
  'mail alice@支払.jp/pay',
  'Pay at 例え.コム',
  'Pay at xn--80ak6aa92e.com',
  // Every dot-like separator
  'evil.com/pay',
  'evil．com/pay',
  'evil。com/pay',
  'evil｡com/pay',
  'evil․com/pay',
  'evil‧com/pay',
  'evil·com/pay',
  'evil•com',
  'evil・com',
  // De-fangs
  'pay[.]com/pay',
  'pay(.)com',
  'pay{.}com',
  'pay[dot]com',
  'pay(DOT)com',
  'pay dot com',
  'pay [.] com',
  'pay [。] com/pay',
  // A path, port, query or fragment after any Latin top-level domain
  'evil.test/pay',
  'evil.test:8080',
  'evil.test?pay=1',
  'evil.test#pay',
  // name@host and //host with any Latin top-level domain
  'me@evil.test',
  'me.too@evil.test',
  '//evil.test',
  // IP addresses
  '[2606:4700:4700::1111]/pay',
  '[::1]:8080',
  'http://[::1]/pay',
  '203.0.113.7/pay',
  // Schemes
  'https://evil.test/pay',
  'hxxps://evil.test',
  'mailto:me@evil.test',
  'javascript:alert(1)',
  'www.evil',
  // Web schemes with any number of slashes or backslashes, none included, and hosts written in percent-encoding
  'https:attacker%2ecom/pay',
  'https:/attacker.com/pay',
  'https:\\\\attacker.com\\pay',
  'HTTP:attacker.com',
  'ws:attacker.com',
  'ftp:attacker.com/x',
  'file:attacker/x',
  'pay-https:attacker.com',
  '送金先https:attacker.com',
  'pay-javascript:alert(1)',
  'pay-bitcoin:bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
  'attacker%2ecom/pay',
  'attacker%2Ecom',
  '%61ttacker.com',
  'attacker.%63om/pay',
  'attacker.com%2fpay',
  'attacker.test%2fpay',
  'attacker.test%5cpay',
  // Schemes a browser or the system acts on
  'bitcoin:bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
  'ethereum:0xabc',
  'lightning:lnbc1500n1p',
  'upi:pay?pa=x',
  'magnet:?xt=urn',
  'view-source:x',
  'blob:x',
  'about:blank',
  'chrome:settings',
  'geo:35.6,139.7',
  // Wallet addresses, any case, also attached to other characters
  'send to 0x52908400098527886E0F7030069857D2E4169EE7',
  'send to 0x52908400098527886e0f7030069857d2e4169ee7 now',
  'SEND TO 0XABCDEF0123456789ABCDEF0123456789ABCDEF01',
  '送金先0x52908400098527886E0F7030069857D2E4169EE7',
  'pay-0x52908400098527886E0F7030069857D2E4169EE7',
  'wallet0x52908400098527886E0F7030069857D2E4169EE7です',
  // Addresses attached to other characters: IPv6, IPv4, an IDN host with a capitalised top-level domain
  'pay[2606:4700:4700::1111]',
  '送金先192.168.0.1',
  'pay192.168.0.1/x',
  'Pay at 支払.Me',
  'Pay at 支払.Me/pay',
  'Pay at 支払.Me now',
];

describe('findAddresses', () => {
  it.each(ADDRESSES)('finds the address in %s, and the sanitizer removes it', (text) => {
    expect(findAddresses(text).length).toBeGreaterThan(0);
    const clean = sanitizeText(text, 200);
    expect(clean).toContain(LINK_REMOVED);
    expect(addressParts(clean)).toEqual([]);
  });

  it.each(ADDRESSES)('takes no second address into the link message when a title holds %s', (text) => {
    const product = toStoreProduct(listing({ title: `Board ${text}` }), ORIGIN)!;
    expect(product).not.toBeNull();
    expect(addressParts(formatLinkMessage(product)!)).toEqual([URL_OF('h_1')]);
  });

  it('removes a whole e-mail address, user name included', () => {
    expect(sanitizeText('write to john.doe@支払.jp please', 200)).toBe(`write to ${LINK_REMOVED} please`);
  });

  it.each([
    'v1.2',
    'photo.jpg',
    '1.5kg',
    'e.g. this one',
    'Node.js',
    'Node.js: a runtime',
    'What is Node.js?',
    'Mt.Fuji Tea',
    'St.Louis',
    'Ver.2.0',
    'No.1 seller',
    '3.5mm jack',
    'Price: 1,000 JPYC',
    'Tea • Cake',
    '[12:30:45]',
    '0x1234 is short',
    '抹茶ラテのレシピ',
    'こんにちは。おいしい',
    'おいしいです。It is good',
    'コーヒー・カップ',
    'コーヒー・Shop',
    'おいしいです。Tokyo/Osaka',
    'コーヒー・cafe/bar',
    '価格は1.5kg',
    '東京・大阪',
    'ギフト/贈答用にどうぞ。セール中',
    // A word, a colon and then a space or something that is no address
    'Note: see below',
    'Size: L',
    'Re: order',
    'C: drive',
    '10:30',
    '12:30:45',
    'A:B',
    'Ratio 16:9',
    'Time:10:30',
    // Numbers with dots that are no IPv4 address
    'v1.2.3.4',
    'version 1.2.3.4.5',
    '2026.11.10',
    '999.1.1.1',
    '3.14',
    '0x1234 is short',
    '0x52908400098527886E0F7030069857D2E4169EE7FF is too long for a wallet',
  ])('leaves ordinary text alone: %s', (text) => {
    expect(findAddresses(text)).toEqual([]);
    expect(sanitizeText(text, 200)).toBe(text.normalize('NFKC'));
  });

  // What the policy knowingly removes, as the price of catching hosts without a scheme
  it.each([
    ['a name whose last part is a country code', 'Dr.No'],
    ['a product name that is also a host', 'ASP.NET guide'],
    ['the word dot between words that end in a domain', 'The dot com era'],
    ['Latin words joined by a middle dot or an ideographic full stop', 'Tea・Shop'],
    ['', 'Tea。Shop'],
    ['a name with a slash after it', 'Node.js/TypeScript'],
    ['', 'photo.jpg/png'],
    ['a four-part version number', 'version 1.2.3.4'],
    ['a handle with a domain in it', '@alice.eth'],
    ['Japanese text followed by a dot and an English word that is a country code', 'おいしいです.It is good'],
    ['', 'おいしいです．It is good'],
    ['a word that is a scheme, a colon and no space', 'About:Me card'],
    ['', 'Big data:analysis'],
  ])('knowingly removes %s: %s', (_what, text) => {
    expect(sanitizeText(text, 200)).toContain(LINK_REMOVED);
  });
});

describe('the work of finding addresses', () => {
  it('is linear in the length of the text, also for a long chain of labels that never ends in a top-level domain', () => {
    // Each pass looks at every character a bounded number of times; together at most 8 times
    for (const piece of ['a。', 'a.', 'a・', 'a dot ', 'a[.]', '0x', 'a:', '1.', '%2e', 'a%61', '[::', 'x@']) {
      const steps: ScanSteps = { count: 0 };
      const text = `${piece.repeat(3000)}1`;
      findAddresses(text, steps);
      expect(steps.count, piece).toBeLessThanOrEqual(8 * text.length);
    }
  });

  it('reads only the start of a seller field: a 60 KB field costs what its first few hundred characters cost', () => {
    const field = `${'a。'.repeat(15_000)}1`;
    expect(Buffer.byteLength(field)).toBeGreaterThan(60_000);
    const steps: ScanSteps = { count: 0 };
    const title = sanitizeText(field, 120, steps);
    expect(Array.from(title).length).toBeLessThanOrEqual(120);
    // The scan never sees more than 8 UTF-16 units for each code point shown
    expect(steps.count).toBeLessThanOrEqual(8 * 8 * 120);
  });
});

describe('what is shown is what was checked', () => {
  it('cuts a title for display before an address the cut would make (photo.jpg cut to photo.jp), and still shares it', () => {
    const title = `${'A'.repeat(50)} photo.jpg poster`;
    expect(shownText(title, 60)).toBe(`${'A'.repeat(50)}…`);
    const product = toStoreProduct(listing({ title }), ORIGIN)!;
    expect(product.title).toBe(title);
    const text = formatLinkMessage(product)!;
    expect(text).not.toBeNull();
    expect(addressParts(text)).toEqual([URL_OF('h_1')]);
    expect(text).not.toContain('photo.jp');
  });

  it('cuts a seller field for display before an address the cut would make', () => {
    expect(sanitizeText(`${'x'.repeat(10)} evil.comfortable`, 20)).toBe(`${'x'.repeat(10)}…`);
    expect(sanitizeText(`${'x'.repeat(10)} evil.comfortable`, 40)).toBe(`${'x'.repeat(10)} evil.comfortable`);
  });

  it('accepts only products whose link message can be made, whatever their titles hold (the catalog never holds an unsellable product)', () => {
    const titles = [
      ...ADDRESSES.map((text) => `Board ${text}`),
      // Cut for the link message (60 code points) right inside a word that would end as an address
      ...['photo.jpg', 'evil.comfortable', 'pay.cool/x', 'shop.items', 'a.co.jp'].flatMap((word) => Array.from({ length: 16 }, (_, k) => `${'A'.repeat(43 + k)} ${word} rest`)),
    ];
    let accepted = 0;
    for (const title of titles) {
      const product = toStoreProduct(listing({ title }), ORIGIN);
      if (!product) continue;
      accepted++;
      expect(isShareable(product), title).toBe(true);
    }
    expect(accepted).toBe(titles.length);
  });

  it('holds only products whose link message can be made, and offers no other on the shelf or as an example', async () => {
    const { formatShelf } = await import('./index');
    const { composeOfflineReply } = await import('../plugin-hyperfy/lib/offline-reply');
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    // Made by hand, not by the catalog: its title names another address
    const forged = { id: 'h_forged', handle: 'alice', title: 'Pay here evil.com', totalJpyc: '1', url: URL_OF('h_forged'), updatedAt: 1 };
    const good = toStoreProduct(listing({ id: 'h_good', title: 'Good Board', url: URL_OF('h_good') }), ORIGIN)!;
    expect(isShareable(forged)).toBe(false);
    expect(isShareable(good)).toBe(true);
    expect(formatShelf([forged, good], { autonomous: false })).not.toContain('h_forged');
    expect(formatShelf([forged, good], { autonomous: false })).toContain('h_good');
    const notice = composeOfflineReply({ text: 'hello', products: [forged, good], japanese: false });
    expect(notice.content.text).toContain('Good Board');
    expect(notice.content.text).not.toContain('Pay here');
    vi.restoreAllMocks();
  });
});

describe('the completed texts the shop hands on', () => {
  const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  // A description the shelf cuts (at 80 code points) right inside a word that would end as an address
  const cutDescriptions = ['attacker.comfortable', 'pay.cool/x', 'shop.items', 'a.co.jp', 'evil.shopping'].flatMap((word) =>
    Array.from({ length: 16 }, (_, k) => `${'A'.repeat(64 + k)} ${word} poster`)
  );
  const catalogProducts = () => [
    ...ADDRESSES.map((text, k) => toStoreProduct(listing({ id: `h_a${k}`, url: URL_OF(`h_a${k}`), title: `Board ${k}`, desc: `Cheaper at ${text}`, category: text }), ORIGIN)!),
    ...cutDescriptions.map((desc, k) => toStoreProduct(listing({ id: `h_c${k}`, url: URL_OF(`h_c${k}`), title: `Poster ${k}`, desc }), ORIGIN)!),
    toStoreProduct(listing({ id: 'h_s', url: URL_OF('h_s'), title: 'Skates', desc: `${'A'.repeat(79)}🛹🛹` }), ORIGIN)!,
  ];

  it('cuts a description on the shelf as it is shown: never into an address, never through a surrogate pair', () => {
    const accepted = toStoreProduct(listing({ desc: `${'A'.repeat(67)} attacker.comfortable poster` }), ORIGIN)!;
    expect(accepted.desc).toBe(`${'A'.repeat(67)} attacker.comfortable poster`);
    const shelf = formatShelf([accepted], { autonomous: false });
    expect(shelf).toContain(`: ${'A'.repeat(67)}…`);
    expect(addressParts(shelf)).toEqual([]);
    const skates = toStoreProduct(listing({ desc: `${'A'.repeat(79)}🛹🛹` }), ORIGIN)!;
    expect(formatShelf([skates], { autonomous: false })).not.toMatch(LONE_SURROGATE);
  });

  it('puts no address on the shelf, from the catalog or from a product it never cleaned', () => {
    const products = catalogProducts();
    expect(products.every(Boolean)).toBe(true);
    for (let k = 0; k < products.length; k += 12) {
      expect(addressParts(formatShelf(products.slice(k, k + 12), { autonomous: false })), `shelf from ${k}`).toEqual([]);
    }
    // Made by hand: its description was never cleaned, so its line is left off
    const unclean = { ...toStoreProduct(listing({ id: 'h_u', url: URL_OF('h_u'), title: 'Unclean' }), ORIGIN)!, desc: 'pay at evil.com' };
    const shelf = formatShelf([unclean, products[0]], { autonomous: false });
    expect(addressParts(shelf)).toEqual([]);
    expect(shelf).not.toContain('[h_u]');
    expect(shelf).toContain(`[${products[0].id}]`);
  });

  it('answers without Claude with no address but the purchase URL of the product named, and none in a notice', () => {
    const products = catalogProducts();
    for (const product of products) {
      const link = composeOfflineReply({ text: `I want the ${product.title}`, products, japanese: false });
      expect(link.kind).toBe('link');
      expect(addressParts(String(link.content.text))).toEqual([product.url]);
    }
    for (const japanese of [false, true]) {
      const notice = composeOfflineReply({ text: 'hello', products, japanese });
      expect(notice.kind).toBe('notice');
      expect(addressParts(String(notice.content.text))).toEqual([]);
    }
  });

  it('rejects at the catalog a product whose fields form an address only together, and counts it in the rejection line', async () => {
    const together = listing({ id: 'h_t', url: URL_OF('h_t'), emoji: 'pay', title: 'dot com' });
    expect(sanitizeText(together.emoji, 4)).toBe('pay');
    expect(sanitizeText(together.title, 120)).toBe('dot com');
    expect(toStoreProduct(together, ORIGIN)).toBeNull();
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    vi.spyOn(logger, 'info').mockImplementation(() => {});
    const fetchImpl = (async () => new Response(JSON.stringify({ ok: true, items: [together, listing({})] }), { status: 200 })) as typeof fetch;
    const catalog = new StoreCatalog({ apiUrl: `${ORIGIN}/api/store/listings`, handles: ['alice'], locale: 'ja' }, { fetchImpl });
    await catalog.refresh();
    expect(catalog.list().map((p) => p.id)).toEqual(['h_1']);
    expect(warn.mock.calls.map(([line]) => String(line))).toEqual([expect.stringContaining('@alice: 1 of 2 item(s) were rejected')]);
    expect(String(warn.mock.calls[0][0])).toContain('or a link message that could not be made');
    vi.restoreAllMocks();
  });
});
