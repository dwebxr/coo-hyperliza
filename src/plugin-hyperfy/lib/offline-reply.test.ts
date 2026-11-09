import { describe, expect, it } from 'vitest';
import { NoticeThrottle, composeOfflineReply } from './offline-reply';
import { isOpenPayLink } from '../../openpay-store';

const product = (id: string, title: string) =>
  ({ id, title, handle: 'coo', totalJpyc: '1,000', url: `https://store.example/p/${id}`, emoji: '', category: '', desc: '' }) as any;
const products = [product('h_board', 'Hyper Board'), product('h_mug', 'Coo Mug'), product('h_tee', 'Coo Tee'), product('h_cap', 'Cap')];

describe('composeOfflineReply', () => {
  it('posts the purchase link when the message names a product', () => {
    const reply = composeOfflineReply({ text: 'I want the Coo Mug', products, japanese: false });
    expect(reply.kind).toBe('link');
    expect(reply.content.text).toContain('https://store.example/p/h_mug');
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
});
