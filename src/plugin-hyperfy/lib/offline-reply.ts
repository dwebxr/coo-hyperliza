import type { Content } from '@elizaos/core';
import { OPENPAY_LINK_FLAG, SHARE_ACTION, formatLinkMessage, isShareable, isSpecificTitle, resolveProduct } from '../../openpay-store';
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
  // null when the link cannot be posted safely (logged): the notice instead
  const link = product ? formatLinkMessage(product) : null;
  if (product && link) {
    return {
      kind: 'link',
      content: {
        text: link,
        actions: [SHARE_ACTION],
        source: 'hyperfy',
        // Posted to chat, never read aloud (see the Hyperfy callbacks)
        metadata: { [OPENPAY_LINK_FLAG]: true, productId: product.id },
      },
    };
  }

  // Only names that would be recognised when said (resolveProduct looks for specific titles only),
  // of products whose link can be posted
  const examples = products
    .filter((p) => isSpecificTitle(p.title) && isShareable(p))
    .map((p) => p.title)
    .slice(0, EXAMPLE_TITLES);
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

// Players whose last notice is remembered, more than a world's player limit. The least recently
// noticed is forgotten first, and a forgotten one can get a notice again at once.
export const OFFLINE_NOTICE_TRACKED_KEYS = 256;

/** Allows one notice per key per interval; remembers at most OFFLINE_NOTICE_TRACKED_KEYS keys. */
export class NoticeThrottle {
  /** Insertion order is recency: the first key is the least recently noticed. */
  private last = new Map<string, number>();

  constructor(
    private readonly intervalMs: number = OFFLINE_NOTICE_INTERVAL_MS,
    private readonly now: () => number = Date.now
  ) {}

  allow(key: string): boolean {
    const t = this.now();
    const previous = this.last.get(key);
    if (previous !== undefined && t - previous < this.intervalMs) return false;
    this.last.delete(key);
    this.last.set(key, t);
    if (this.last.size > OFFLINE_NOTICE_TRACKED_KEYS) this.last.delete(this.last.keys().next().value as string);
    return true;
  }

  get trackedKeys(): number {
    return this.last.size;
  }
}
