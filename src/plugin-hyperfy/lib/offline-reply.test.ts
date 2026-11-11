import { describe, expect, it } from 'vitest';
import { NoticeThrottle, OFFLINE_NOTICE_TRACKED_KEYS, composeOfflineReply } from './offline-reply';
import { isOpenPayLink } from '../../openpay-store';

const product = (id: string, title: string) =>
  ({ id, title, handle: 'coo', totalJpyc: '1000', url: `https://open-pay.jp/ja/@coo?product=${id}`, emoji: '', category: '', desc: '' }) as any;
const products = [product('h_board', 'Hyper Board'), product('h_mug', 'Coo Mug'), product('h_tee', 'Coo Tee'), product('h_cap', 'Cap')];

describe('composeOfflineReply', () => {
  it('posts the purchase link when the message names a product', () => {
    const reply = composeOfflineReply({ text: 'I want the Coo Mug', products, japanese: false });
    expect(reply.kind).toBe('link');
    expect(reply.content.text).toBe('🛒 Coo Mug — 1000 JPYC\nhttps://open-pay.jp/ja/@coo?product=h_mug');
    expect(isOpenPayLink(reply.content)).toBe(true);
  });

  it('otherwise sends a short notice that says how to still get a link', () => {
    const ja = composeOfflineReply({ text: 'おすすめある？', products, japanese: true });
    expect(ja.kind).toBe('notice');
    expect(ja.content.text).toContain('休憩中');
    expect(ja.content.text).toContain('Hyper Board、Coo Mug、Coo Tee');
    expect(isOpenPayLink(ja.content)).toBe(false);

    const en = composeOfflineReply({ text: 'hello', products: [], japanese: false });
    expect(en.content.text).toBe("Sorry, I'm on a short break and can't chat properly right now.");
  });
});

describe('composeOfflineReply and short titles', () => {
  it('posts no link for a message that merely contains a short title, and does not offer that title as an example', () => {
    const shelf = [product('h_cap', 'Cap'), product('h_ai', 'AI'), product('h_hon', '本'), product('h_board', 'Hyper Board')];
    for (const text of ['Nice cap!', 'I work on AI', 'この本は何？']) {
      const reply = composeOfflineReply({ text, products: shelf, japanese: false });
      expect(reply.kind, text).toBe('notice');
      expect(reply.content.text).toBe("Sorry, I'm on a short break and can't chat properly right now. Tell me a product name and I'll post its purchase link (e.g. Hyper Board).");
    }
    // With nothing recognisable on the shelf there is nothing to offer
    expect(composeOfflineReply({ text: 'hello', products: shelf.slice(0, 3), japanese: false }).content.text).toBe("Sorry, I'm on a short break and can't chat properly right now.");
    expect(composeOfflineReply({ text: 'the Hyper Board please', products: shelf, japanese: false }).kind).toBe('link');
  });
});

describe('NoticeThrottle', () => {
  it('allows one notice per key per interval', () => {
    let t = 0;
    const throttle = new NoticeThrottle(1000, () => t);
    expect(throttle.allow('a')).toBe(true);
    expect(throttle.allow('a')).toBe(false);
    expect(throttle.allow('b')).toBe(true);
    t = 1000;
    expect(throttle.allow('a')).toBe(true);
  });

  it('remembers at most 256 keys however many players ask within the interval, forgetting the least recently noticed', () => {
    let t = 0;
    const throttle = new NoticeThrottle(5 * 60_000, () => t);
    for (let i = 0; i < 10 * OFFLINE_NOTICE_TRACKED_KEYS; i++) {
      t += 10;
      expect(throttle.allow(`player-${i}`)).toBe(true);
      expect(throttle.trackedKeys).toBeLessThanOrEqual(OFFLINE_NOTICE_TRACKED_KEYS);
    }
    // The most recent ones are still throttled; the first ones were forgotten
    expect(throttle.allow(`player-${10 * OFFLINE_NOTICE_TRACKED_KEYS - 1}`)).toBe(false);
    expect(throttle.allow('player-0')).toBe(true);
  });
});
