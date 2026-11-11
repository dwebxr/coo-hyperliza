import { describe, expect, it, vi } from 'vitest';
import { logger } from '@elizaos/core';
import { addressParts, findAddresses, type ScanSteps } from './addresses';
import { LINK_REMOVED, formatLinkMessage, isShareable, sanitizeText, shownText, toStoreProduct } from './catalog';

const ORIGIN = 'https://open-pay.jp';
const URL_OF = (id: string) => `${ORIGIN}/ja/@alice?product=${id}&from=agent`;
const listing = (extra: Record<string, unknown>) => ({ id: 'h_1', handle: 'alice', title: 'Board', totalJpyc: '505', url: URL_OF('h_1'), updatedAt: 1, ...extra });

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
  // Wallet addresses, any case
  'send to 0x52908400098527886E0F7030069857D2E4169EE7',
  'send to 0x52908400098527886e0f7030069857d2e4169ee7 now',
  'SEND TO 0XABCDEF0123456789ABCDEF0123456789ABCDEF01',
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
    'おいしいです．It is good',
    'おいしいです.It is good',
    'コーヒー・カップ',
    'コーヒー・Shop',
    'おいしいです。Tokyo/Osaka',
    'コーヒー・cafe/bar',
    '価格は1.5kg',
    '東京・大阪',
    'ギフト/贈答用にどうぞ。セール中',
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
  ])('knowingly removes %s: %s', (_what, text) => {
    expect(sanitizeText(text, 200)).toContain(LINK_REMOVED);
  });
});

describe('the work of finding addresses', () => {
  it('is linear in the length of the text, also for a long chain of labels that never ends in a top-level domain', () => {
    for (const piece of ['a。', 'a.', 'a・', 'a dot ', 'a[.]']) {
      const steps: ScanSteps = { count: 0 };
      const text = `${piece.repeat(3000)}1`;
      expect(findAddresses(text, steps)).toEqual([]);
      expect(steps.count, piece).toBeLessThanOrEqual(4 * text.length);
    }
  });

  it('reads only the start of a seller field: a 60 KB field costs what its first few hundred characters cost', () => {
    const field = `${'a。'.repeat(15_000)}1`;
    expect(Buffer.byteLength(field)).toBeGreaterThan(60_000);
    const steps: ScanSteps = { count: 0 };
    const title = sanitizeText(field, 120, steps);
    expect(Array.from(title).length).toBeLessThanOrEqual(120);
    // The scan never sees more than 8 UTF-16 units for each code point shown
    expect(steps.count).toBeLessThanOrEqual(4 * 8 * 120);
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
