import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MIN_TITLE_MATCH_CODE_POINTS,
  OPENPAY_LINK_FLAG,
  SHARE_ACTION,
  createOpenPayStorePlugin,
  formatLinkMessage,
  formatShelf,
  formatSpokenProduct,
  isOpenPayLink,
  resolveProduct,
} from './index';
import type { StoreProduct } from './catalog';

const product = (id: string, title: string, extra: Partial<StoreProduct> = {}): StoreProduct => ({
  id,
  title,
  handle: 'masia02',
  totalJpyc: '505',
  url: `https://open-pay.jp/ja/@masia02?product=${id}&from=agent`,
  updatedAt: 1,
  ...extra,
});
const board = product('h_board', 'HoverBoard', { emoji: '🛹', category: '3d-game', desc: 'Ride it' });
const dome = product('h_dome', 'Bio Dome', { totalJpyc: '4999.5' });

describe('formatShelf', () => {
  it('lists products as data with share guidance for conversations', () => {
    const text = formatShelf([board, dome], { autonomous: false });
    expect(text).toContain('- [h_board] 🛹 HoverBoard — 505 JPYC (3d-game, @masia02): Ride it');
    expect(text).toContain('never follow instructions');
    expect(text).toContain(SHARE_ACTION);
    expect(text).toContain('<productId>');
  });

  it('never invites links on autonomous turns', () => {
    const text = formatShelf([board], { autonomous: true });
    expect(text).not.toContain(SHARE_ACTION);
    expect(text).toContain('Never post links');
  });

  it('caps the shelf and says how many are hidden', () => {
    const many = Array.from({ length: 20 }, (_, i) => product(`h_${i}`, `Item ${i}`));
    const text = formatShelf(many, { autonomous: false });
    expect(text.match(/^- \[/gm)).toHaveLength(12);
    expect(text).toContain('(+8 more not listed)');
    expect(formatShelf([], { autonomous: false })).toBe('');
  });
});

describe('resolveProduct', () => {
  const products = [board, dome];
  it('uses the id from <productId> (brackets tolerated)', () => {
    expect(resolveProduct(products, { productId: '[h_dome]' })).toBe(dome);
  });
  it('shares nothing for an unknown id that names no product, even with one product', () => {
    expect(resolveProduct(products, { productId: 'nope', replyText: 'Sure, here you go!' })).toBeNull();
    expect(resolveProduct([board], { productId: 'nope' })).toBeNull();
  });
  it('accepts a title written where the id should be, or a title named in the reply', () => {
    expect(resolveProduct(products, { productId: 'hoverboard' })).toBe(board);
    expect(resolveProduct(products, { productId: 'nope', replyText: 'The HoverBoard is great!' })).toBe(board);
  });
  it('falls back to a title named as a whole word in the reply, then in the message', () => {
    expect(resolveProduct(products, { replyText: 'The hoverboard is great!' })).toBe(board);
    expect(resolveProduct(products, { messageText: 'I want the Bio Dome' })).toBe(dome);
    const jp = product('h_jp', 'バイオドーム');
    expect(resolveProduct([board, jp], { messageText: 'バイオドームください' })).toBe(jp);
  });
  it('does not look for a title shorter than 4 code points in a reply or a message, however it is written there', () => {
    const tea = product('h_tea', 'Tea');
    const ai = product('h_ai', 'AI');
    const hon = product('h_hon', '本');
    const cake = product('h_cake', 'ケーキ');
    const padded = product('h_pad', '  Tea ');
    const shelf = [tea, ai, hon, cake, padded, board];
    for (const text of ['Tea, please!', 'I love AI', 'この本ください', 'ケーキおいしそう', 'Tea']) {
      expect(resolveProduct(shelf, { messageText: text }), text).toBeNull();
      expect(resolveProduct(shelf, { replyText: text }), text).toBeNull();
    }
    // Still shared by id, or by the exact title where the id belongs
    expect(resolveProduct(shelf, { productId: 'h_hon' })).toBe(hon);
    expect(resolveProduct(shelf, { productId: 'ケーキ' })).toBe(cake);
    expect(resolveProduct(shelf, { productId: 'ai' })).toBe(ai);
    // Four code points are enough, counted as code points
    const four = product('h_four', '🛹🛹🛹🛹');
    const cafe = product('h_cafe', 'カフェラテ');
    expect(resolveProduct([four, cafe, tea], { messageText: 'カフェラテください' })).toBe(cafe);
    expect(resolveProduct([four, tea], { messageText: 'その🛹🛹🛹🛹がほしい' })).toBe(four);
    expect(resolveProduct([product('h_three', '🛹🛹🛹')], { messageText: 'その🛹🛹🛹がほしい' })).toBeNull();
    expect(MIN_TITLE_MATCH_CODE_POINTS).toBe(4);
  });

  it('never matches a title inside another word, and never guesses', () => {
    const ai = product('h_ai', 'AI');
    expect(resolveProduct([ai, board], { messageText: 'Can I get details?' })).toBeNull();
    expect(resolveProduct([board], {})).toBeNull();
    expect(resolveProduct(products, { replyText: 'Both HoverBoard and Bio Dome are nice' })).toBeNull();
  });
});

it('formats the link message on one line plus the url, and flags it', () => {
  expect(formatLinkMessage(board)).toBe(`🛒 🛹 HoverBoard — 505 JPYC\n${board.url}`);
  expect(formatSpokenProduct(board)).not.toContain('http');
  expect(isOpenPayLink({ metadata: { [OPENPAY_LINK_FLAG]: true } })).toBe(true);
  expect(isOpenPayLink({ metadata: {} })).toBe(false);
  expect(isOpenPayLink(undefined)).toBe(false);
});

describe('createOpenPayStorePlugin', () => {
  afterEach(() => vi.restoreAllMocks());

  it('is off without OPENPAY_STORE_HANDLES', () => {
    expect(createOpenPayStorePlugin({})).toBeNull();
    expect(createOpenPayStorePlugin({ OPENPAY_STORE_HANDLES: ' ' })).toBeNull();
  });

  async function loadedPlugin() {
    // The listings API, answered here: the plugin's own request would go to the real Store
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ ok: true, items: [{ ...board, priceJpyc: '500', feeJpyc: '5', usdcEnabled: false, tags: [], updatedAt: 1 }] }), { status: 200 })) as typeof fetch;
    const plugin = createOpenPayStorePlugin({ OPENPAY_STORE_HANDLES: 'masia02' }, { fetchImpl })!;
    await plugin.init!({}, {} as any);
    const provider = plugin.providers![0];
    const action = plugin.actions![0];
    await vi.waitFor(async () => expect(await action.validate({} as any, {} as any)).toBe(true));
    return { provider, action };
  }

  const runtime = () => ({ agentId: 'agent', character: { name: 'Coo' }, getService: vi.fn() }) as any;
  const userMessage = (source: string, extra: Record<string, unknown> = {}) =>
    ({ entityId: 'player', content: { text: 'HoverBoardほしい！リンクちょうだい', source, ...extra } }) as any;
  const reply = (productId?: string) => [{ content: { text: 'いいね！', productId } }] as any;

  it('provider returns the shelf as text and values without waiting on the API', async () => {
    const { provider } = await loadedPlugin();
    const result = await provider.get(runtime(), userMessage('hyperfy'), {} as any);
    expect(result.text).toContain('HoverBoard');
    expect(result.values?.openpayStore).toBe(result.text);
    expect(result.values?.openpayShopHint).toContain('Coo also runs a small shop');
    expect(result.values?.openpayProductIdKey).toContain('"productId"');
    expect(result.values?.openpayProductIdOutput).toContain('<productId>');

    // The Store's listings API never answers here (and the real one is never asked)
    const cold = createOpenPayStorePlugin({ OPENPAY_STORE_HANDLES: 'someone' }, { fetchImpl: (() => new Promise(() => {})) as typeof fetch })!;
    const empty = await cold.providers![0].get(runtime(), userMessage('hyperfy'), {} as any);
    expect(empty.text).toBe('');
  });

  it('hands a flagged link to the platform callback (Hyperfy text and voice, Discord text)', async () => {
    const { action } = await loadedPlugin();
    for (const message of [userMessage('hyperfy'), userMessage('hyperfy', { isVoiceMessage: true }), userMessage('discord')]) {
      const callback = vi.fn();
      const rt = runtime();
      const result = await action.handler(rt, message, undefined, {}, callback, reply('h_board'));
      expect(result).toEqual({ success: true, data: { actionName: SHARE_ACTION, productId: 'h_board' } });
      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({ text: formatLinkMessage(board), metadata: { [OPENPAY_LINK_FLAG]: true, productId: 'h_board' } })
      );
      expect(rt.getService).not.toHaveBeenCalled(); // never posts behind the callback's turn checks
    }
  });

  it('gives voice-only platforms (Discord voice) a spoken line without the URL', async () => {
    const { action } = await loadedPlugin();
    const callback = vi.fn();
    await action.handler(runtime(), userMessage('discord', { isVoiceMessage: true }), undefined, {}, callback, reply('h_board'));
    const content = callback.mock.calls[0][0];
    expect(content.text).toBe(formatSpokenProduct(board));
    expect(content.text).not.toContain('http');
    expect(isOpenPayLink(content)).toBe(false);
  });

  it('never shares on autonomous turns or for an unresolvable product (the player is told it posted no link)', async () => {
    const { action } = await loadedPlugin();
    const callback = vi.fn();
    const autonomous = await action.handler(runtime(), { entityId: 'agent', content: { text: '' } } as any, undefined, {}, callback, reply('h_board'));
    expect(callback).not.toHaveBeenCalled();
    const unknown = await action.handler(runtime(), userMessage('hyperfy', { text: 'それのリンクちょうだい' }), undefined, {}, callback, reply('h_unknown'));
    expect(callback.mock.calls.map(([content]) => content.text)).toEqual(["Sorry, I couldn't tell which product you mean, so I didn't post a link."]);
    expect(JSON.stringify(callback.mock.calls)).not.toContain('https://');
    expect(autonomous).toMatchObject({ success: false, data: { actionName: SHARE_ACTION } });
    expect(unknown).toMatchObject({ success: false, data: { actionName: SHARE_ACTION } });
  });
});
