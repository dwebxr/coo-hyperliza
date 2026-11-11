import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Content, type Memory, type UUID, logger } from '@elizaos/core';
import { reportsPrivilegedAction } from '../lib/authorization';
import type { Played } from '../lib/playback';
import { type TurnContext, type TurnOrigin, currentTurn, neverAbortedSignal, runTurn } from '../lib/turn-context';
import { type ReplyContext, deliverReply } from './deliver-reply';

/*
 * deliverReply with the channels it is given (the session's emotes, chat and voice stand in as
 * recorders that say what they were asked, in order) and a real turn. What the real channels do
 * with a cancelled turn is tested with them (managers/message-manager.test.ts, voice-manager.test.ts).
 */

const ROOM = '00000000-0000-0000-0000-00000000000b' as UUID;
const AGENT = '00000000-0000-0000-0000-0000000000aa' as UUID;
const LINK: Content = { text: '🛒 HoverBoard — 505 JPYC\nhttps://open-pay.jp/ja/@a?product=x', metadata: { openpayLink: true } };

function channels({ spoken = 'all' as Played, posted = true } = {}) {
  const did: string[] = [];
  const stored: Memory[] = [];
  const session = {
    ended: false,
    emotes: { playEmote: vi.fn((name: string) => void did.push(`emote ${name}`)) },
    messages: { sendMessage: vi.fn(async (text: string) => (did.push(`post ${text}`), posted)) },
    voice: { speak: vi.fn(async (text: string) => (did.push(`speak ${text}`), spoken)) },
  };
  const runtime = {
    agentId: AGENT,
    createMemory: vi.fn(async (memory: Memory, table: string) => {
      did.push(`remember ${table}`);
      stored.push(memory);
      return memory.id as UUID;
    }),
  };
  return { did, stored, session, runtime };
}

/** Delivers `content` from inside a real turn of `origin`; `during` runs first (to end the turn, say). */
async function deliver(origin: TurnOrigin, content: Content, set: ReturnType<typeof channels>, { cancel, memory }: { cancel?: AbortSignal; memory?: Partial<Content> } = {}) {
  return runTurn({ origin, requesterId: origin === 'autonomy' ? undefined : 'p1', world: {}, generation: 1, signal: neverAbortedSignal(), cancel }, async () => {
    const ctx: ReplyContext = { turn: currentTurn() as TurnContext, session: set.session, runtime: set.runtime, roomId: ROOM, memory };
    return deliverReply(ctx, content);
  });
}

afterEach(() => vi.restoreAllMocks());

describe('deliverReply', () => {
  it.each(['chat', 'autonomy'] as const)('for a %s turn: the emote, then the text posted, then spoken, then remembered as delivered', async (origin) => {
    const set = channels();
    const delivery = await deliver(origin, { text: 'Hello!', emote: 'wave', thought: 't' }, set);
    expect(set.did).toEqual(['emote wave', 'post Hello!', 'speak Hello!', 'remember messages']);
    expect(delivery).toEqual({ posted: true, spoken: 'all', stored: true });
    expect(set.stored[0]).toMatchObject({ entityId: AGENT, agentId: AGENT, roomId: ROOM, content: { text: 'Hello!', emote: 'wave', thought: 't', channelType: 'WORLD' } });
  });

  it.each([
    ['all of it was played', 'all', ['emote TALK', 'speak Hello!', 'remember messages']],
    ['only part of it was played', 'partial', ['emote TALK', 'speak Hello!', 'post Hello!', 'remember messages']],
    ['none of it was played', 'none', ['emote TALK', 'speak Hello!', 'post Hello!', 'remember messages']],
  ] as const)('for a voice turn: spoken, and posted exactly once only when not all of it was played (%s)', async (_what, spoken, did) => {
    const set = channels({ spoken });
    const delivery = await deliver('voice', { text: 'Hello!' }, set, { memory: { isVoiceMessage: true, inReplyTo: ROOM } });
    expect(set.did).toEqual(did);
    expect(set.session.messages.sendMessage).toHaveBeenCalledTimes(spoken === 'all' ? 0 : 1);
    expect(delivery).toMatchObject({ posted: spoken !== 'all', spoken });
    expect(set.stored[0].content).toMatchObject({ text: 'Hello!', isVoiceMessage: true, inReplyTo: ROOM });
  });

  it("a voice turn's own emote replaces the talking gesture", async () => {
    const set = channels();
    await deliver('voice', { text: 'Hello!', emote: 'wave' }, set);
    // One emote, the reply's own: no TALK before or after it
    expect(set.did).toEqual(['emote wave', 'speak Hello!', 'remember messages']);
  });

  it('posts a shop link and never reads it aloud, in a chat and in a voice turn', async () => {
    for (const origin of ['chat', 'voice'] as const) {
      const set = channels();
      await deliver(origin, LINK, set);
      expect(set.did).toEqual([`post ${LINK.text}`, 'remember messages']);
    }
  });

  it('does not put a shop link in chat on an autonomous turn, says so, and does not remember it as said', async () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {});
    const set = channels();
    const delivery = await deliver('autonomy', LINK, set);
    expect(set.session.messages.sendMessage).not.toHaveBeenCalled();
    expect(set.session.voice.speak).not.toHaveBeenCalled();
    expect(delivery).toEqual({ posted: false, spoken: 'none', stored: false });
    // Memory matches what was delivered: nothing
    expect(set.runtime.createMemory).not.toHaveBeenCalled();
    expect(set.stored).toEqual([]);
    expect(info.mock.calls.flat().map(String)).toContain('[Reply] Not posting a shop link on an autonomous turn');
  });

  it('remembers a shop link a chat turn posted, exactly as it was posted', async () => {
    const set = channels();
    const delivery = await deliver('chat', LINK, set);
    expect(delivery).toEqual({ posted: true, spoken: 'none', stored: true });
    expect(set.stored.map((memory) => memory.content.text)).toEqual([LINK.text]);
  });

  it.each([
    ['an emote that throws', () => { throw new Error('no such clip'); }],
    ['an emote that throws something that is no error', () => { throw 'broken'; }],
  ])('delivers and remembers the reply whatever the emote does (%s)', async (_what, playEmote) => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const set = channels();
    set.session.emotes.playEmote.mockImplementation(playEmote);
    const delivery = await deliver('chat', { text: 'Hello!', emote: 'constructor' }, set);
    expect(set.did).toEqual(['post Hello!', 'speak Hello!', 'remember messages']);
    expect(delivery.stored).toBe(true);
  });

  it('plays no emote for an emote that is not a name, and remembers a reply without words (a decision to stay quiet)', async () => {
    const set = channels();
    const delivery = await deliver('chat', { thought: 'Nothing to add.', actions: ['IGNORE'], emote: 7 as unknown as string }, set);
    expect(set.did).toEqual(['remember messages']);
    expect(delivery).toEqual({ posted: false, spoken: 'none', stored: true });
  });

  it('delivers nothing for a turn that may no longer act: no emote, post, speech or memory', async () => {
    const slot = new AbortController();
    slot.abort();
    const set = channels();
    const delivery = await deliver('chat', { text: 'Too late', emote: 'wave' }, set, { cancel: slot.signal });
    expect(set.did).toEqual([]);
    expect(delivery).toMatchObject({ dropped: expect.any(String), posted: false, stored: false });
  });

  it('delivers nothing once the connection has ended, whatever the turn says', async () => {
    const set = channels();
    set.session.ended = true;
    const delivery = await deliver('voice', { text: 'Too late' }, set);
    expect(set.did).toEqual([]);
    expect(delivery.dropped).toBe('its connection ended');
  });

  it('remembers what was posted although the turn was cancelled while it was being spoken', async () => {
    const slot = new AbortController();
    const set = channels({ spoken: 'none' });
    set.session.voice.speak.mockImplementation(async () => {
      slot.abort();
      return 'none';
    });
    const delivery = await deliver('chat', { text: 'Hello!' }, set, { cancel: slot.signal });
    expect(delivery).toEqual({ posted: true, spoken: 'none', stored: true });
  });

  it('remembers nothing, and says that the reply reached nobody, when the turn was cancelled before any of it went out', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const slot = new AbortController();
    // As the real channels answer a cancelled turn: nothing played, nothing posted
    const set = channels({ spoken: 'none', posted: false });
    set.session.voice.speak.mockImplementation(async () => {
      slot.abort();
      return 'none';
    });
    const delivery = await deliver('voice', { text: 'Hello!' }, set, { cancel: slot.signal });
    expect(set.runtime.createMemory).not.toHaveBeenCalled();
    expect(delivery).toMatchObject({ posted: false, spoken: 'none', stored: false, dropped: expect.any(String) });
    expect(warn.mock.calls.flat().map(String).join('\n')).toContain('[Reply] A reply of a voice turn reached nobody');
  });

  it('says so when a live turn\'s reply could be neither posted nor spoken, and still remembers what was said', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const set = channels({ spoken: 'none', posted: false });
    const delivery = await deliver('chat', { text: 'Hello!' }, set);
    expect(warn.mock.calls.flat().map(String)).toContain('[Reply] A reply of a chat turn reached nobody: it could be neither posted nor spoken');
    expect(delivery).toEqual({ posted: false, spoken: 'none', stored: true });
  });

  it('does not fail the delivery when the memory cannot be written', async () => {
    vi.spyOn(logger, 'error').mockImplementation(() => {});
    const set = channels();
    set.runtime.createMemory.mockRejectedValue(new Error('database down'));
    await expect(deliver('chat', { text: 'Hello!' }, set)).resolves.toEqual({ posted: true, spoken: 'all', stored: false });
  });

  describe('a reply that reports what a privileged action did', () => {
    const report = (refusal: () => string | null) => reportsPrivilegedAction({ text: 'I moved the box up!', emote: 'cheer', thought: 'done' } as Content, { refusal, instead: { text: 'I cannot go any further with that request.', thought: 'The edit request ended.' } });

    it('is delivered as it is while the requester may still have it', async () => {
      const refusal = vi.fn(() => null);
      const set = channels();
      await deliver('chat', report(refusal), set);
      expect(refusal).toHaveBeenCalledTimes(1);
      expect(set.did).toEqual(['emote cheer', 'post I moved the box up!', 'speak I moved the box up!', 'remember messages']);
    });

    it('is replaced, whole, by the neutral line for a requester who lost the right before it was delivered: nothing of it is posted, spoken, shown or remembered', async () => {
      vi.spyOn(logger, 'warn').mockImplementation(() => {});
      const set = channels();
      await deliver('chat', report(() => 'the requester is not a builder in this world'), set);
      expect(set.did).toEqual(['post I cannot go any further with that request.', 'speak I cannot go any further with that request.', 'remember messages']);
      expect(JSON.stringify(set.stored)).not.toContain('box');
    });

    it('is checked when it is delivered, not when it was written', async () => {
      let allowed = true;
      const reply = report(() => (allowed ? null : 'demoted'));
      allowed = false;
      const set = channels();
      vi.spyOn(logger, 'warn').mockImplementation(() => {});
      await deliver('voice', reply, set);
      // The neutral line went out in its place, by the voice turn's own path
      expect(set.did).toEqual(['emote TALK', 'speak I cannot go any further with that request.', 'remember messages']);
      expect(JSON.stringify(set.stored)).not.toContain('box');
    });
  });
});
