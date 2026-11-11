/**
 * coo-world announces a confirmed tip as a chat message without a sender (fromId null):
 * "Alice tipped Coo 100 JPYC" to everyone, or, when announcements are throttled,
 * "(only you) Alice tipped you 100 JPYC" to the recipient only.
 * (src/core/systems/ServerNetwork.js tipConfirmed / announceTip)
 */

import { escapeRegExp } from './text';

export interface TipNotice {
  fromName: string;
  amount: string;
  token: string;
}

const AMOUNT_AND_TOKEN = '(\\d+(?:\\.\\d+)?) ([A-Za-z0-9.]{1,16})';
const PRIVATE_NOTICE = new RegExp(`^\\(only you\\) (.+) tipped you ${AMOUNT_AND_TOKEN}$`);

/** The tip in a world notice when it was sent to the agent (named agentName in the world); else null. */
export function parseTipNotice(body: string | undefined | null, agentName: string): TipNotice | null {
  if (!body) return null;
  const text = body.trim();
  const privateMatch = text.match(PRIVATE_NOTICE);
  if (privateMatch) return { fromName: privateMatch[1], amount: privateMatch[2], token: privateMatch[3] };
  if (!agentName.trim()) return null;
  const publicMatch = text.match(new RegExp(`^(.+) tipped ${escapeRegExp(agentName.trim())} ${AMOUNT_AND_TOKEN}$`));
  if (publicMatch) return { fromName: publicMatch[1], amount: publicMatch[2], token: publicMatch[3] };
  return null;
}

export function tipThanks(tip: TipNotice, japanese: boolean): string {
  return japanese
    ? `${tip.fromName}さん、${tip.amount} ${tip.token}の投げゼニありがとうございます！とってもうれしいです🎉`
    : `Thank you so much for the ${tip.amount} ${tip.token} tip, ${tip.fromName}! 🎉`;
}
