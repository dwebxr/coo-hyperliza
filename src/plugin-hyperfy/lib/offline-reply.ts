import type { Content } from '@elizaos/core';
import { OPENPAY_LINK_FLAG, SHARE_ACTION, formatLinkMessage, resolveProduct } from '../../openpay-store';
import type { StoreProduct } from '../../openpay-store/catalog';
import { IDLE_EMOTES } from './idle-behavior';

/**
 * What the agent says when the Claude budget is used up, so it never just goes silent:
 * a purchase link when the message names a product on the shelf, otherwise a short notice
 * (at most once per player per NOTICE_INTERVAL_MS) that says how to still get a link.
 */

export const OFFLINE_NOTICE_INTERVAL_MS = 5 * 60_000;
const EXAMPLE_TITLES = 3;

export function composeOfflineReply({
  text,
  products,
  japanese,
}: {
  text: string;
  products: StoreProduct[];
  japanese: boolean;
}): { kind: 'link' | 'notice'; content: Content } {
  const product = resolveProduct(products, { messageText: text });
  if (product) {
    return {
      kind: 'link',
      content: {
        text: formatLinkMessage(product),
        actions: [SHARE_ACTION],
        source: 'hyperfy',
        // Posted to chat, never read aloud (see the Hyperfy callbacks)
        metadata: { [OPENPAY_LINK_FLAG]: true, productId: product.id },
      },
    };
  }

  const examples = products.slice(0, EXAMPLE_TITLES).map((p) => p.title);
  const shopHint = examples.length
    ? japanese
      ? ` 商品名を言ってもらえれば、購入リンクをお送りします（例: ${examples.join('、')}）。`
      : ` Tell me a product name and I'll post its purchase link (e.g. ${examples.join(', ')}).`
    : '';
  return {
    kind: 'notice',
    content: {
      text: (japanese ? 'ごめんなさい、今は少し休憩中で、くわしくお話しできません。' : "Sorry, I'm on a short break and can't chat properly right now.") + shopHint,
      actions: ['REPLY'],
      emote: IDLE_EMOTES.wave,
      thought: 'The Claude budget is used up; answering without it.',
    },
  };
}

/** Allows one notice per key per interval. */
export class NoticeThrottle {
  private last = new Map<string, number>();

  constructor(
    private readonly intervalMs: number = OFFLINE_NOTICE_INTERVAL_MS,
    private readonly now: () => number = Date.now
  ) {}

  allow(key: string): boolean {
    const t = this.now();
    const previous = this.last.get(key);
    if (previous !== undefined && t - previous < this.intervalMs) return false;
    this.last.set(key, t);
    // Forget players who have not asked for a while
    if (this.last.size > 500) {
      for (const [k, at] of this.last) if (t - at >= this.intervalMs) this.last.delete(k);
    }
    return true;
  }
}
