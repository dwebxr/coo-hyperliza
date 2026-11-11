/**
 * Requests simple enough to carry out without asking Claude: "come here" walks to the speaker,
 * "stop" stops moving. Only whole, short commands match ("Coo, come here!" does, "can you come
 * here tomorrow and explain X?" does not); everything else goes through the normal reply.
 */

import { escapeRegExp } from './text';

export type SimpleCommand = 'come' | 'stop';

const ASCII_ONLY = /^[\x00-\x7F]+$/;

const COME = [
  // English, spaces removed
  /^(please)?(come(over)?here|comeover|cometome|comewithme|followme|comehereplease|followmeplease)(please)?$/,
  // Japanese: (こっち|ここ)(に|へ) + 来て, おいで, ついてきて, with polite endings
  /^(ちょっと)?(こっち|ここ|こちら)?(に|へ)?(来て|きて|来い|こい|来れる|これる|おいで)(ください|くださいな|くれる|くれ|くれない|ほしい|欲しい|もらえる)?(よ|ね|な|ー)*$/,
  /^(ついて|付いて)(きて|来て|こい|来い)(ください|くれる|くれ|ほしい)?(よ|ね|な|ー)*$/,
];

const STOP = [
  /^(please)?(stop|stopmoving|stopthere|stophere|freeze|staythere|stayhere|staystill)(please)?$/,
  /^(そこで|ここで)?(止まって|とまって|止まれ|とまれ|ストップ|動かないで|うごかないで)(ください|くれる|くれ)?(よ|ね|な|ー)*$/,
];

/** Leading words and sentence punctuation that don't change the command. */
const FILLER_PREFIX = /^(hey|hi|ok|okay|ねえ|ねぇ|ねー|おーい|あの|すみません|ちょっと待って)+/;
const PUNCTUATION = /[\s、。,.!！?？~〜…・「」『』"'()（）]+/g;
const HONORIFIC = '(さん|ちゃん|くん|君|様|さま)?';

function stripNames(text: string, names: string[]): string {
  let out = text;
  for (const raw of names) {
    const name = raw?.trim().toLowerCase();
    if (!name) continue;
    const pattern = ASCII_ONLY.test(name)
      ? new RegExp(`(^|[^a-z0-9_])${escapeRegExp(name)}${HONORIFIC}(?=$|[^a-z0-9_])`, 'g')
      : new RegExp(`()${escapeRegExp(name)}${HONORIFIC}`, 'g');
    out = out.replace(pattern, '$1 ');
  }
  return out;
}

export function matchSimpleCommand(text: string | undefined | null, agentNames: string[]): SimpleCommand | null {
  if (!text || text.length > 60) return null;
  const core = stripNames(text.toLowerCase(), agentNames).replace(PUNCTUATION, '').replace(FILLER_PREFIX, '');
  if (!core) return null;
  if (COME.some((re) => re.test(core))) return 'come';
  if (STOP.some((re) => re.test(core))) return 'stop';
  return null;
}

/** Japanese replies for Japanese messages; the character speaks English otherwise. */
export function isJapanese(text: string | undefined | null): boolean {
  return !!text && /[぀-ヿ㐀-鿿]/.test(text);
}

export function simpleCommandReply(command: SimpleCommand, japanese: boolean): string {
  if (command === 'come') return japanese ? '今行きます！' : 'On my way!';
  return japanese ? 'はい、ここで止まりますね。' : "Okay, I'll stay right here.";
}
