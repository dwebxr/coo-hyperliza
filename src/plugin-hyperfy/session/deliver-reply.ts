import { ChannelType, type Content, type Memory, type UUID, logger } from '@elizaos/core';
import { isOpenPayLink } from '../../openpay-store';
import { privilegedReport } from '../lib/authorization';
import type { Played } from '../lib/playback';
import type { TurnContext } from '../lib/turn-context';

/**
 * The one way a reply of a turn reaches the world: chat turns, voice turns, autonomous ticks and
 * the thanks for a tip all end here.
 *
 * In order:
 *  1. Liveness. A turn that may no longer act (its connection ended, or its slot ran out) delivers
 *     nothing; the drop is logged.
 *  2. Authorization at delivery, for a reply that reports what a privileged action did
 *     (lib/authorization.ts reportsPrivilegedAction): elizaOS core holds an action's replies until
 *     the action has returned, so the requester's right is checked again here, and one who lost it
 *     gets the action's neutral line instead. It is checked once more right before such a reply is
 *     played (after its synthesis) and right before its text fallback; one who lost the right by
 *     then gets the neutral line instead, by the same path, once, and the report's audio is
 *     discarded.
 *  3. Emote, when the reply names one (a voice reply with words shows TALK otherwise). A name that
 *     is no emote, or an emote that fails, never stops the reply.
 *  4. Words. A chat turn, an autonomous tick and a tip thanks are posted to chat and then spoken. A
 *     voice turn is spoken, and posted only when not all of it was played ('none' or 'partial':
 *     the voice limit, a failed or cut playback, a reply longer than what is said aloud, or one with
 *     a link, which is never read aloud), so it is never posted twice and never lost; a turn that
 *     was cancelled meanwhile posts nothing more. A shop link is posted and never read aloud; an
 *     autonomous tick does not post one at all.
 *  5. Memory: the reply (the neutral line, where step 2 replaced it). Not written for a turn that
 *     died before any of it went out, nor for a shop link an autonomous tick did not post (step
 *     4): what was deliberately not said is not remembered as said. A reply whose words reached
 *     nobody while its turn was live because nothing could be posted or played is still
 *     remembered (the agent tried to say it; the log says so).
 *
 * Posting and speaking check the turn themselves (MessageManager.sendMessage, VoiceManager.speak),
 * so a turn cancelled between two steps stops at the next one.
 */

/** What a reply goes out through: the session of the turn. */
export interface ReplyChannels {
  /** True once the connection has ended. */
  readonly ended: boolean;
  readonly emotes: { playEmote(name: string): void };
  readonly messages: { sendMessage(text: string): Promise<boolean> };
  readonly voice: { speak(text: string, options?: { admit?: () => boolean }): Promise<Played> };
}

export interface ReplyContext {
  readonly turn: TurnContext;
  readonly session: ReplyChannels;
  readonly runtime: { readonly agentId: UUID; createMemory(memory: Memory, tableName: string): Promise<UUID> };
  /** The elizaOS room the reply is remembered in */
  readonly roomId: UUID;
  /** Added to the stored memory's content (a voice turn marks its replies) */
  readonly memory?: Partial<Content>;
}

export interface Delivery {
  /** Why nothing was delivered or stored: the turn may no longer act */
  dropped?: string;
  posted: boolean;
  spoken: Played;
  stored: boolean;
}

const TALK_EMOTE = 'TALK';

function deadReason(ctx: ReplyContext): string | null {
  if (ctx.session.ended) return 'its connection ended';
  try {
    ctx.turn.assertLive();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export async function deliverReply(ctx: ReplyContext, content: Content): Promise<Delivery> {
  const { turn, session } = ctx;
  const delivery: Delivery = { posted: false, spoken: 'none', stored: false };
  const dead = deadReason(ctx);
  if (dead) {
    logger.info(`[Reply] Dropping a reply of a ${turn.origin} turn: ${dead}`);
    return { ...delivery, dropped: dead };
  }

  logger.info(`[Reply] ${turn.origin} turn: ${JSON.stringify(content)}`);

  let report = privilegedReport(content);
  /** Whether a privileged report may still go out; when not, `content` becomes its neutral line (once) */
  const stillReportable = (when: string): boolean => {
    const refusal = report?.refusal() ?? null;
    if (!report || !refusal) return true;
    logger.warn(`[Reply] Not reporting what a privileged action did (${when}): ${refusal}`);
    content = report.instead;
    report = undefined;
    return false;
  };
  stillReportable('at delivery');
  // Asked by the voice right before it plays a report: no answer changes `content` from there
  const admit = () => !report || report.refusal() === null;

  const text = typeof content.text === 'string' ? content.text : '';
  const words = text.trim() !== '';
  const link = words && isOpenPayLink(content);
  // Nobody asked an autonomous tick for a link
  const say = words && !(link && turn.origin === 'autonomy');
  if (words && !say) logger.info('[Reply] Not posting a shop link on an autonomous turn');

  const emote = typeof content.emote === 'string' && content.emote ? content.emote : turn.origin === 'voice' && say && !link ? TALK_EMOTE : '';
  if (emote) {
    try {
      session.emotes.playEmote(emote);
    } catch (error) {
      logger.warn(`[Reply] The emote could not be played: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (say) {
    if (link) {
      delivery.posted = await session.messages.sendMessage(text);
    } else if (turn.origin === 'voice') {
      // Spoken, then posted when not all of it was played, unless the turn ended meanwhile. A
      // privileged report whose requester lost the right meanwhile is replaced by its neutral line,
      // which goes the same way (once: the neutral line is no report).
      const voiced = async (text: string, reporting: boolean): Promise<void> => {
        delivery.spoken = await (reporting ? session.voice.speak(text, { admit }) : session.voice.speak(text));
        if (delivery.spoken === 'all') return;
        if (reporting && !stillReportable('before its text fallback')) {
          if (delivery.spoken !== 'none') logger.warn('[Reply] Part of a privileged report had been played when its requester lost the right');
          const neutral = typeof content.text === 'string' ? content.text : '';
          if (neutral.trim()) await voiced(neutral, false);
          return;
        }
        const dead = deadReason(ctx);
        if (dead) {
          logger.info(`[Reply] Not posting the rest of a voice reply as text: ${dead}`);
          return;
        }
        if (delivery.spoken === 'partial') logger.info('[Reply] Reply partly spoken, then posted as text');
        delivery.posted = await session.messages.sendMessage(text);
      };
      await voiced(text, !!report);
    } else {
      delivery.posted = await session.messages.sendMessage(text);
      delivery.spoken = await (report ? session.voice.speak(text, { admit }) : session.voice.speak(text));
    }
    if (!delivery.posted && delivery.spoken === 'none') {
      logger.warn(`[Reply] A reply of a ${turn.origin} turn reached nobody: ${deadReason(ctx) ?? 'it could be neither posted nor spoken'}`);
    }
  }

  // Withheld on purpose: memory holds what was said, and this was not
  if (words && !say) return delivery;

  // What reached the world is remembered even when the turn was cancelled while it went out
  const reached = delivery.posted || delivery.spoken !== 'none';
  const deadNow = reached ? null : deadReason(ctx);
  if (deadNow) return { ...delivery, dropped: deadNow };
  try {
    await ctx.runtime.createMemory(
      {
        id: crypto.randomUUID() as UUID,
        entityId: ctx.runtime.agentId,
        agentId: ctx.runtime.agentId,
        content: { ...content, channelType: ChannelType.WORLD, ...ctx.memory },
        roomId: ctx.roomId,
        createdAt: Date.now(),
      },
      'messages'
    );
    delivery.stored = true;
  } catch (error) {
    logger.error(`[Reply] The reply was delivered but could not be remembered: ${error instanceof Error ? error.message : String(error)}`);
  }
  return delivery;
}
