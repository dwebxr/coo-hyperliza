/**
 * coo-world announces a tip it has confirmed as a chat message without a sender (fromId null):
 * "Alice tipped Coo 100 JPYC" to everyone, or, when announcements are throttled,
 * "(only you) Alice tipped you 100 JPYC" to the recipient only.
 * (src/core/systems/ServerNetwork.js tipConfirmed / announceTip)
 *
 * An announcement is all the agent has: it checks nothing on chain. What is read from one is what
 * the world announced, not a payment the agent verified.
 */

import { SHOWN_NAME_MAX, escapeRegExp, shownName } from './text';

export interface TipNotice {
  /** At most TIP_NAME_MAX_CODE_POINTS code points, nothing invisible (as coo-world's shown() writes it). */
  fromName: string;
  amount: string;
  token: string;
}

export const TIP_NAME_MAX_CODE_POINTS = SHOWN_NAME_MAX;
// A whole part of up to 30 digits and up to 18 decimals (the most an ERC-20 token usually has).
// A longer amount is not a tip notice: cutting it would thank for a different amount.
const AMOUNT = '\\d{1,30}(?:\\.\\d{1,18})?';
const TOKEN = '[A-Za-z0-9.]{1,16}';
const AMOUNT_AND_TOKEN = `(${AMOUNT}) (${TOKEN})`;
const PRIVATE_NOTICE = new RegExp(`^\\(only you\\) (.+) tipped you ${AMOUNT_AND_TOKEN}$`);

/**
 * The tip in a world notice when it was sent to the agent (named agentName in the world); else
 * null. The tipper's name is cut to TIP_NAME_MAX_CODE_POINTS code points without control or
 * format characters, whatever the notice held.
 */
export function parseTipNotice(body: string | undefined | null, agentName: string): TipNotice | null {
  if (!body) return null;
  const text = body.trim();
  const privateMatch = text.match(PRIVATE_NOTICE);
  if (privateMatch) return tipNotice(privateMatch);
  if (!agentName.trim()) return null;
  const publicMatch = text.match(new RegExp(`^(.+) tipped ${escapeRegExp(agentName.trim())} ${AMOUNT_AND_TOKEN}$`));
  return publicMatch ? tipNotice(publicMatch) : null;
}

function tipNotice(match: RegExpMatchArray): TipNotice {
  // coo-world writes 'Anonymous' for a name with nothing visible in it
  return { fromName: shownName(match[1], TIP_NAME_MAX_CODE_POINTS) || 'Anonymous', amount: match[2], token: match[3] };
}

export function tipThanks(tip: TipNotice, japanese: boolean): string {
  return japanese
    ? `${tip.fromName}さん、${tip.amount} ${tip.token}の投げゼニありがとうございます！とってもうれしいです🎉`
    : `Thank you so much for the ${tip.amount} ${tip.token} tip, ${tip.fromName}! 🎉`;
}

/** What the agent remembers of an announcement: that the world said so. */
export function tipThought(tip: TipNotice): string {
  return `The world announced that ${tip.fromName} tipped me ${tip.amount} ${tip.token}. I did not check it on chain.`;
}

// The same name is thanked at most once in this time: coo-world announces one sender's tips
// publicly at most this often, too (TIP_ANNOUNCE_COOLDOWN_MS)
export const TIP_THANKS_NAME_COOLDOWN_MS = 30_000;
// Over all names: three thanks at once, then one every 10 s. A spoken thanks takes about 5 s.
export const TIP_THANKS_BURST = 3;
export const TIP_THANKS_REFILL_MS = 10_000;
// Names whose last thanks is remembered; the least recently thanked is forgotten first, and a
// forgotten name can be thanked again at once (still within the limit over all names)
export const TIP_THANKS_TRACKED_NAMES = 256;

/** Decides whether a tip announcement is thanked for: per name and over all names. */
export class TipThanksLimiter {
  /** Insertion order is recency: the first key is the least recently thanked name. */
  readonly #lastByName = new Map<string, number>();
  #tokens = TIP_THANKS_BURST;
  #at: number;

  constructor(private readonly now: () => number = Date.now) {
    this.#at = now();
  }

  /** Whether `name` may be thanked now; a yes counts as the thanks. */
  allow(name: string): boolean {
    const t = this.now();
    const last = this.#lastByName.get(name);
    if (last !== undefined && t - last < TIP_THANKS_NAME_COOLDOWN_MS) return false;
    this.#tokens = Math.min(TIP_THANKS_BURST, this.#tokens + Math.max(0, t - this.#at) / TIP_THANKS_REFILL_MS);
    this.#at = t;
    if (this.#tokens < 1) return false;
    this.#tokens--;
    this.#lastByName.delete(name);
    this.#lastByName.set(name, t);
    if (this.#lastByName.size > TIP_THANKS_TRACKED_NAMES) this.#lastByName.delete(this.#lastByName.keys().next().value as string);
    return true;
  }

  get trackedNames(): number {
    return this.#lastByName.size;
  }
}
