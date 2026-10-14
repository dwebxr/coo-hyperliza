import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OPENPAY_LINK_FLAG,
  SHARE_ACTION,
  createOpenPayStorePlugin,
  formatLinkMessage,
  formatShelf,
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
  it('prefers the id from <productId> (brackets tolerated)', () => {
    expect(resolveProduct(products, { productId: '[h_dome]' })).toBe(dome);
  });
  it('falls back to a title named in the reply, then in the message', () => {
    expect(resolveProduct(products, { productId: 'nope', replyText: 'The hoverboard is great!' })).toBe(board);
    expect(resolveProduct(products, { messageText: 'I want the Bio Dome' })).toBe(dome);
  });
  it('uses the only product, and gives up when ambiguous', () => {
    expect(resolveProduct([board], {})).toBe(board);
    expect(resolveProduct(products, { replyText: 'Both HoverBoard and Bio Dome are nice' })).toBeNull();
    expect(resolveProduct(products, {})).toBeNull();
  });
});

it('formats the link message on one line plus the url, and flags it', () => {
  expect(formatLinkMessage(board)).toBe(`🛒 🛹 HoverBoard — 505 JPYC\n${board.url}`);
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
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true, items: [{ ...board, priceJpyc: '500', feeJpyc: '5', usdcEnabled: false, tags: [], updatedAt: 1 }] }), { status: 200 })
    );
    const plugin = createOpenPayStorePlugin({ OPENPAY_STORE_HANDLES: 'masia02' })!;
    await plugin.init!({}, {} as any);
    const provider = plugin.providers![0];
    const action = plugin.actions![0];
    await vi.waitFor(async () => expect(await action.validate({} as any, {} as any)).toBe(true));
    return { provider, action };
  }

  const runtime = (sendMessage = vi.fn()) =>
    ({
      agentId: 'agent',
      character: { name: 'Coo' },
      getService: (name: string) => (name === 'hyperfy' ? { getMessageManager: () => ({ sendMessage }) } : null),
    }) as any;
  const userMessage = (source: string, text = 'HoverBoardほしい！リンクちょうだい') =>
    ({ entityId: 'player', content: { text, source } }) as any;
  const reply = (productId?: string) => [{ content: { text: 'いいね！', productId } }] as any;

  it('provider returns the shelf as text and values without waiting on the API', async () => {
    const { provider } = await loadedPlugin();
    const result = await provider.get(runtime(), userMessage('hyperfy'), {} as any);
    expect(result.text).toContain('HoverBoard');
    expect(result.values?.openpayStore).toBe(result.text);
    expect(result.values?.openpayShopHint).toContain('Coo also runs a small shop');

    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(() => {}));
    const cold = createOpenPayStorePlugin({ OPENPAY_STORE_HANDLES: 'someone' })!;
    const empty = await cold.providers![0].get(runtime(), userMessage('hyperfy'), {} as any);
    expect(empty.text).toBe('');
  });

  it('in Hyperfy: posts the link to world chat itself (voice replies are not posted) and flags the callback', async () => {
    const { action } = await loadedPlugin();
    const sendMessage = vi.fn().mockResolvedValue(true);
    const callback = vi.fn();
    await action.handler(runtime(sendMessage), userMessage('hyperfy'), undefined, {}, callback, reply('h_board'));
    expect(sendMessage).toHaveBeenCalledWith(formatLinkMessage(board));
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ text: formatLinkMessage(board), metadata: { [OPENPAY_LINK_FLAG]: true, productId: 'h_board' } }));
  });

  it('elsewhere (e.g. Discord): leaves posting to the callback', async () => {
    const { action } = await loadedPlugin();
    const sendMessage = vi.fn();
    const callback = vi.fn();
    await action.handler(runtime(sendMessage), userMessage('discord'), undefined, {}, callback, reply('h_board'));
    expect(sendMessage).not.toHaveBeenCalled();
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('never shares on autonomous turns, even if the model emits the action', async () => {
    const { action } = await loadedPlugin();
    const sendMessage = vi.fn();
    const callback = vi.fn();
    await action.handler(runtime(sendMessage), { entityId: 'agent', content: { text: '' } } as any, undefined, {}, callback, reply('h_board'));
    expect(sendMessage).not.toHaveBeenCalled();
    expect(callback).not.toHaveBeenCalled();
  });
});
