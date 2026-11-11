import { ChannelType, Content, HandlerCallback, IAgentRuntime, Memory, ModelType, UUID, createUniqueUuid, logger } from "@elizaos/core";
import type { ConnectionSession } from "../session/connection-session";
import { deliverReply } from "../session/deliver-reply";
import { TtsLimitReached, countOtherPlayers, generateSpeech, getWavHeader } from "../utils";
import { agentActivityLock } from "./guards";
import { hyperfyEventType } from "../events";
import { isDirectlyAddressed, parseAliases } from "../lib/addressing";
import { getUsageBudget, runWithOrigin } from "../../usage-budget";
import { TurnCancelled, currentTurn, noteDelivered } from "../lib/turn-context";
import type { PlaybackOutcome } from "../systems/liveKit";
import type { Played } from "../lib/playback";
import { oneLine, shownName, truncateCodePoints } from "../lib/text";
import { errorText } from "../lib/error-text";
import { CHAT_BODY_MAX_CODE_POINTS, CHAT_ID_MAX_LENGTH, type ChatTurn, type ReceivedChatMessage } from "../lib/chat-intake";

type LiveKitAudioData = {
  participant: string;
  buffer: Buffer;
};

// One utterance playing plus a couple queued; older replies beyond that are stale.
const MAX_PENDING_PLAYBACKS = 3;
const PLAYBACK_TIMEOUT_MS = 120_000;
// LiveKit delivers 48 kHz 16-bit mono PCM
const PCM_BYTES_PER_SECOND = 48000 * 2;
// How often the "voice is paused" chat notice / log may repeat
const VOICE_LIMIT_NOTICE_INTERVAL_MS = 10 * 60_000;

// --- Voice input. Everything a speaker can make the agent hold or spend is bounded here. ---
// A speaker's utterance ends after this much silence (no loud frame)
export const UTTERANCE_PAUSE_MS = 1500;
// One speaker without a pause: after 30 s the audio so far is transcribed and a new utterance starts
export const MAX_UTTERANCE_BYTES = 30 * PCM_BYTES_PER_SECOND;
// All speakers together, waiting or being transcribed: four full utterances (11.5 MB of PCM; a
// request holds its audio about twice while it builds the WAV)
export const MAX_HELD_VOICE_BYTES = 4 * MAX_UTTERANCE_BYTES;
// People held at once, whether their speech waits or is being transcribed: a ninth speaker is not
// heard until one of them is done
export const MAX_SPEAKERS = 8;
// Speech-to-text requests in flight at once, over all speakers. A request takes about a second;
// three people finishing a sentence at the same moment is a busy conversation. A fourth utterance
// waits for a free request (at most to its cap, like a speaker's next utterance waits for their
// previous one)
export const MAX_CONCURRENT_TRANSCRIPTIONS = 3;
// LiveKit frames are 10 ms (960 bytes); one second is already not a frame
export const MAX_FRAME_BYTES = PCM_BYTES_PER_SECOND;
// Whether speech-to-text is there and within its budget is looked up at most this often
const INGRESS_GATE_RECHECK_MS = 2000;
// At most one line about dropped audio in this time; the line carries the count
const VOICE_DROP_LOG_INTERVAL_MS = 10_000;
// What is said aloud of one reply. 600 code points are under a minute of speech in English and
// under two in Japanese, within PLAYBACK_TIMEOUT_MS; a longer reply is spoken up to a sentence end
// before that, and reported as partly spoken
export const MAX_SPOKEN_CODE_POINTS = 600;

interface Utterance {
  buffers: Buffer[];
  bytes: number;
  /** Fires when the speaker has been silent for UTTERANCE_PAUSE_MS */
  timer: NodeJS.Timeout | null;
}

/** Average absolute amplitude of 16-bit PCM above the threshold: someone is speaking. */
function isLoudEnough(pcm: Buffer, threshold = 1000): boolean {
  let sum = 0;
  const samples = Math.floor(pcm.length / 2);
  for (let i = 0; i + 1 < pcm.length; i += 2) sum += Math.abs(pcm.readInt16LE(i));
  return samples > 0 && sum / samples > threshold;
}

/** `text` for speech: whole when short enough, else up to the last sentence end within the cap. */
export function spokenPart(text: string): { text: string; cut: boolean } {
  if (Array.from(text).length <= MAX_SPOKEN_CODE_POINTS) return { text, cut: false };
  const head = truncateCodePoints(text, MAX_SPOKEN_CODE_POINTS);
  const end = Math.max(...['. ', '! ', '? ', '。', '！', '？', '\n'].map((mark) => head.lastIndexOf(mark)));
  // A sentence end in the second half; otherwise the cap itself
  return { text: end > head.length / 2 ? head.slice(0, end + 1).trimEnd() : head, cut: true };
}

/**
 * The voice of one connection: what players say (LiveKit audio, transcribed, then queued as a
 * turn of the connection's conversation, lib/chat-intake.ts) and what the agent says (speak).
 */
export class VoiceManager {
  private runtime: IAgentRuntime;
  private session: ConnectionSession;
  /** The utterance each speaker is in the middle of; gone as soon as it is handed to transcription. */
  private speakers: Map<string, Utterance> = new Map();
  /** Speakers whose previous utterance is being transcribed: at most one request per speaker. */
  private transcribing: Set<string> = new Set();
  private leaveListener: ((data: unknown) => void) | null = null;
  private leaveSource: any = null;
  /**
   * Each speaker's presence since they last left (the engine's 'leave'): a token taken when an
   * utterance goes to transcription, which must still be the speaker's when the transcript comes
   * back and again when its turn starts. Leaving drops it, so the same id rejoining is a new
   * presence. One entry per speaker heard and not gone since.
   */
  private presence = new Map<string, object>();
  /** PCM bytes held: buffered for all speakers, plus what is being transcribed. */
  private heldVoiceBytes = 0;
  private ingressGate = { checkedAt: Number.NEGATIVE_INFINITY, open: false };
  private droppedFrames = 0;
  private droppedFramesLoggedAt = Number.NEGATIVE_INFINITY;
  private isSpeaking: boolean = false;
  private audioListener: ((data: unknown) => void) | null = null;
  private audioSource: any = null;
  private playbackChain: Promise<void> = Promise.resolve();
  private pendingPlaybacks = 0;
  private playbackGeneration = 0;
  private activePlayback: AbortController | null = null;
  private halted = false;
  private lastSttLimitNoticeAt = Number.NEGATIVE_INFINITY;
  private lastTtsLimitLogAt = Number.NEGATIVE_INFINITY;

  constructor(runtime: IAgentRuntime, session: ConnectionSession) {
    this.runtime = runtime;
    this.session = session;
  }

  /** True once stop() ran or the connection ended: nothing more is heard, transcribed or played. */
  private get stopped(): boolean {
    return this.halted || this.session.ended;
  }

  start() {
    const world = this.session.world;
    if (!world || !world.livekit) {
      console.error('[VoiceManager] Cannot start - world or livekit not available');
      return;
    }
    if (!this.runtime.getModel(ModelType.TRANSCRIPTION)) {
      logger.warn('[VoiceManager] No TRANSCRIPTION model (set ELEVENLABS_XI_API_KEY with the speech_to_text permission): voice input is ignored');
    }

    this.audioListener = (data: unknown) => this.onAudio(data);
    this.audioSource = world.livekit;
    this.audioSource.on('audio', this.audioListener);
    // A player leaving the world (the engine's 'leave', when their entity is removed): what they
    // said and was not yet handed to speech-to-text is dropped. A transcript that comes back for
    // someone no longer in the world starts no turn (processTranscription).
    this.leaveListener = (data: unknown) => {
      const playerId = (data as { playerId?: unknown } | null)?.playerId;
      if (typeof playerId !== 'string') return;
      this.discard(playerId);
      this.presence.delete(playerId);
    };
    this.leaveSource = world.events;
    this.leaveSource?.on?.('leave', this.leaveListener);
  }

  /**
   * Detaches from LiveKit, cancels pending transcription and drops queued playback.
   */
  stop() {
    if (this.audioSource && this.audioListener) {
      this.audioSource.off?.('audio', this.audioListener);
    }
    this.audioSource = null;
    this.audioListener = null;
    if (this.leaveListener) this.leaveSource?.off?.('leave', this.leaveListener);
    this.leaveSource = null;
    this.leaveListener = null;
    for (const participant of [...this.speakers.keys()]) this.discard(participant);
    this.presence.clear();
    this.isSpeaking = false;
    this.halted = true;
    this.playbackGeneration++;
    this.playbackChain = Promise.resolve();
    this.pendingPlaybacks = 0;
    this.activePlayback?.abort();
    this.activePlayback = null;
  }

  /**
   * One audio frame from LiveKit. Never throws and starts nothing that can reject unhandled.
   * Dropped here, before anything is kept: frames while the agent itself is talking, quiet frames,
   * and every frame while speech-to-text is not available or its budget is used up.
   */
  private onAudio(data: unknown): void {
    try {
      if (this.stopped) return;
      const { participant, buffer } = (data ?? {}) as Partial<LiveKitAudioData>;
      // The LiveKit identity is the player id
      if (typeof participant !== 'string' || !participant || participant.length > CHAT_ID_MAX_LENGTH) return;
      if (!Buffer.isBuffer(buffer) || buffer.length < 2 || buffer.length > MAX_FRAME_BYTES) return;
      if (!isLoudEnough(buffer)) return;
      // Not while the agent is talking: its own voice comes back through open microphones
      if (this.isSpeaking) return this.discard(participant);
      if (!this.ingressOpen()) return this.discard(participant);

      let utterance = this.speakers.get(participant);
      if (utterance && utterance.bytes + buffer.length > MAX_UTTERANCE_BYTES) {
        // Their previous utterance is still with speech-to-text, or every request is taken: nowhere to put more
        if (!this.canTranscribe(participant)) return this.dropFrame('a speaker went on past the utterance limit while speech-to-text was busy');
        this.flush(participant);
        utterance = undefined;
      }
      if (this.heldVoiceBytes + buffer.length > MAX_HELD_VOICE_BYTES) {
        // Whoever has waited with the most audio is transcribed now instead of at their next pause
        this.flushLargest();
        return this.dropFrame('the voice buffers are full');
      }
      if (!utterance) {
        // Someone being transcribed still counts: the limit is on everyone held, not only on who waits
        if (!this.transcribing.has(participant) && this.heldSpeakers() >= MAX_SPEAKERS) return this.dropFrame(`more than ${MAX_SPEAKERS} people are speaking at once`);
        utterance = { buffers: [], bytes: 0, timer: null };
        this.speakers.set(participant, utterance);
      }
      // A copy: the frame's own memory is LiveKit's
      utterance.buffers.push(Buffer.from(buffer));
      utterance.bytes += buffer.length;
      this.heldVoiceBytes += buffer.length;
      if (utterance.timer) clearTimeout(utterance.timer);
      utterance.timer = setTimeout(() => this.onPause(participant), UTTERANCE_PAUSE_MS);
    } catch (error) {
      this.dropFrame(`handling it failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Whether voice input can be transcribed at all right now: a TRANSCRIPTION model is registered
   * and the speech-to-text budget is not used up. Looked up at most every INGRESS_GATE_RECHECK_MS.
   */
  private ingressOpen(): boolean {
    const now = Date.now();
    if (now - this.ingressGate.checkedAt < INGRESS_GATE_RECHECK_MS) return this.ingressGate.open;
    this.ingressGate.checkedAt = now;
    this.ingressGate.open = false;
    // ElevenLabs (src/elevenlabs-speech.ts) when configured, otherwise e.g. OpenAI. Without any,
    // voice input is simply unavailable (start() said so)
    if (!this.runtime.getModel(ModelType.TRANSCRIPTION)) return false;
    const budget = getUsageBudget();
    if (!budget.sttAvailable()) {
      budget.recordSkip('stt');
      this.noticeVoiceInputPaused();
      return false;
    }
    return (this.ingressGate.open = true);
  }

  /** Counts a frame that was not kept and says so at most once per VOICE_DROP_LOG_INTERVAL_MS. */
  private dropFrame(reason: string): void {
    this.droppedFrames++;
    if (Date.now() - this.droppedFramesLoggedAt < VOICE_DROP_LOG_INTERVAL_MS) return;
    this.droppedFramesLoggedAt = Date.now();
    logger.warn(`[VoiceManager] Dropped ${this.droppedFrames} audio frame(s): ${reason}`);
    this.droppedFrames = 0;
  }

  /** Forgets what a speaker has said so far in their current utterance. */
  private discard(participant: string): void {
    const utterance = this.speakers.get(participant);
    if (!utterance) return;
    if (utterance.timer) clearTimeout(utterance.timer);
    this.speakers.delete(participant);
    this.heldVoiceBytes -= utterance.bytes;
  }

  /** Everyone held: speakers whose speech waits, and speakers being transcribed (each counted once). */
  private heldSpeakers(): number {
    let held = this.speakers.size;
    for (const participant of this.transcribing) if (!this.speakers.has(participant)) held++;
    return held;
  }

  /** Whether an utterance of `participant` may go to speech-to-text now. */
  private canTranscribe(participant: string): boolean {
    return !this.transcribing.has(participant) && this.transcribing.size < MAX_CONCURRENT_TRANSCRIPTIONS;
  }

  /** The speaker has been silent for UTTERANCE_PAUSE_MS. */
  private onPause(participant: string): void {
    const utterance = this.speakers.get(participant);
    if (!utterance) return;
    utterance.timer = null;
    if (!this.canTranscribe(participant)) {
      // One request per speaker, MAX_CONCURRENT_TRANSCRIPTIONS in all: this utterance waits for a
      // free one, growing at most to its cap
      utterance.timer = setTimeout(() => this.onPause(participant), UTTERANCE_PAUSE_MS);
      return;
    }
    this.flush(participant);
  }

  private flushLargest(): void {
    let largest: string | undefined;
    for (const [participant, utterance] of this.speakers) {
      if (!this.canTranscribe(participant)) continue;
      if (largest === undefined || utterance.bytes > this.speakers.get(largest)!.bytes) largest = participant;
    }
    if (largest !== undefined) this.flush(largest);
  }

  /**
   * Hands a speaker's utterance to transcription and frees the speaker for the next utterance. Its
   * bytes stay counted until the speech-to-text request has ended.
   */
  private flush(participant: string): void {
    const utterance = this.speakers.get(participant);
    if (!utterance) return;
    if (utterance.timer) clearTimeout(utterance.timer);
    utterance.timer = null;
    this.speakers.delete(participant);
    const world = this.session.world;
    // Nobody who is not a player in the world now is transcribed (that costs money)
    if (this.stopped || !world || utterance.bytes === 0 || !world.entities?.getPlayer?.(participant)) {
      this.heldVoiceBytes -= utterance.bytes;
      return;
    }
    this.transcribing.add(participant);
    const presence = this.presenceOf(participant);
    // Not a turn yet: the transcript is queued as one below. Its cost counts as voice.
    runWithOrigin('voice', () => this.processTranscription(participant, utterance, presence))
      .catch((error) => console.error(`Error handling voice from ${participant}:`, error));
  }

  /** The speaker's presence token, taken on first use */
  private presenceOf(participant: string): object {
    let token = this.presence.get(participant);
    if (!token) this.presence.set(participant, (token = {}));
    return token;
  }

  /** Whether `participant` is the same presence that `token` was taken from, and in the world */
  private stillPresent(participant: string, token: object): boolean {
    return this.presence.get(participant) === token && !!this.session.world?.entities?.getPlayer?.(participant);
  }

  private async processTranscription(participant: string, utterance: Utterance, presence: object) {
    let transcript: unknown;
    try {
      // One attempt through the registered model
      if (!this.runtime.getModel(ModelType.TRANSCRIPTION)) return;
      const pcm = Buffer.concat(utterance.buffers, utterance.bytes);
      utterance.buffers.length = 0;
      const budget = getUsageBudget();
      // Counted before the request and whatever its result: billed by audio length. An utterance
      // that does not fit in what is left of the daily limit is not transcribed.
      if (!budget.reserveStt(pcm.length / PCM_BYTES_PER_SECOND)) {
        budget.recordSkip('stt');
        this.noticeVoiceInputPaused();
        return;
      }
      logger.debug('Starting transcription...');
      transcript = await this.runtime.useModel(ModelType.TRANSCRIPTION, Buffer.concat([getWavHeader(pcm.length, 48000), pcm]));
    } catch (error) {
      console.error(`Error transcribing audio for user ${participant}:`, error);
      return;
    } finally {
      // The audio is no longer held, and the speaker's next utterance may be transcribed
      this.transcribing.delete(participant);
      this.heldVoiceBytes -= utterance.bytes;
      utterance.buffers.length = 0;
    }

    if (this.stopped) return;
    if (typeof transcript !== 'string' || transcript.includes('[BLANK_AUDIO]')) return;
    // What was said enters memory and prompts like a chat message: one line, at most 500 code points
    const text = oneLine(transcript, CHAT_BODY_MAX_CODE_POINTS);
    if (!text || text.length < 3) return;
    // Only someone who is in the world now, and has been since they said it: a speaker who left
    // while being transcribed starts no turn, also when they have come back under the same id
    const speaker = this.session.world?.entities?.getPlayer?.(participant);
    if (!speaker || !this.stillPresent(participant, presence)) {
      logger.info('[VoiceManager] Dropping a transcript: its speaker left after saying it');
      return;
    }
    console.log("[VOICE MANAGER] Transcription: ", text)
    // Into the connection's one conversation queue, as a message of its speaker: it waits its turn
    // behind what was typed or said before it, by the queue's rules (lib/chat-intake.ts), so two
    // people speaking at once are answered one after the other instead of the later turn taking
    // the earlier one's answer away after its model call
    const admission = this.session.conversation.accept(
      {
        id: `voice-${crypto.randomUUID()}`,
        body: text,
        fromId: participant,
        from: shownName(speaker.data?.name) || null,
        createdAt: new Date().toISOString(),
      },
      (msg, slot) => this.handleTranscript(msg, slot, presence)
    );
    if (admission !== 'queued') logger.info(`[VoiceManager] Not answering a transcript: ${admission}`);
  }

  /** One transcript as a voice turn of its speaker. `slot`: the queue's turn (see MessageManager.handleMessage). */
  private async handleTranscript(msg: ReceivedChatMessage, slot: ChatTurn, presence: object): Promise<void> {
    const playerId = msg.fromId as UUID;
    // Someone who left while their transcript waited in the queue is not answered, back or not
    if (!this.stillPresent(playerId, presence)) {
      logger.info('[VoiceManager] Dropping a transcript: its speaker left after saying it');
      return;
    }
    await this.session.runTurn(
      // The LiveKit participant identity, which the world's server sets to the player id
      { origin: 'voice', requesterId: playerId, cancel: slot.signal },
      // Inside the activity lock, so the behavior loop stays paused until the reply has been spoken
      () => agentActivityLock.run(() => this.handleMessage(msg.body, playerId, this.session.stoppedOnArrival(msg.id)))
    );
  }

  private async handleMessage(
    message: string,
    playerId: UUID,
    /** A stop command that already stopped the agent when it was admitted: the turn only acknowledges it */
    stopTaken = false,
  ) {
    try {
      const session = this.session;
      const world = session.world;
      const turn = currentTurn();
      if (!turn?.live) return;

      const playerInfo = world.entities.getPlayer(playerId);
      // Someone who left while their transcript waited is not answered
      if (!playerInfo) {
        logger.info('[VoiceManager] Dropping a transcript: its speaker is not in the world (any more)');
        return;
      }
      // The name goes into memory and prompts: one short line, like a chat sender's
      const userName = shownName(playerInfo?.data?.name) || playerId;
      const name = userName;
      const _currentWorldId = session.worldId;
      const channelId = _currentWorldId;
      const roomId = createUniqueUuid(this.runtime, _currentWorldId || 'hyperfy-unknown-world')
      const entityId = createUniqueUuid(this.runtime, playerId) as UUID

      const type = ChannelType.WORLD;

      // Ensure connection for the sender entity
      await this.runtime.ensureConnection({
        entityId,
        roomId,
        userName,
        name,
        source: 'hyperfy',
        channelId,
        type: ChannelType.WORLD,
        worldId: _currentWorldId,
      })
      // Nothing is asked of the model for a turn that was cancelled while it was being set up
      if (!turn.live) return;

      const agentNames = [this.runtime.character.name, ...parseAliases(process.env.HYPERFY_AGENT_ALIASES)];
      const memory: Memory = {
        id: createUniqueUuid(this.runtime, `${channelId}-voice-message-${Date.now()}`),
        agentId: this.runtime.agentId,
        entityId: entityId,
        roomId,
        content: {
          text: message,
          source: 'hyperfy',
          name: name,
          userName: userName,
          isVoiceMessage: true,
          channelType: type,
          metadata: {
            // LiveKit participant identity is the Hyperfy player entity id
            hyperfyFromId: playerId,
            hyperfyFromName: userName,
            directlyAddressed: isDirectlyAddressed(message, agentNames),
            soloPlayer: countOtherPlayers(world) === 1,
            ...(stopTaken ? { hyperfyStopTaken: true } : {}),
          },
        },
        createdAt: Date.now(),
      };

      // Every reply of this turn goes out through the one delivery path (session/deliver-reply.ts):
      // a voice turn's reply is spoken, and posted as text only when not all of it could be said
      const reply = { turn, runtime: this.runtime, session, roomId, memory: { name: this.runtime.character.name, inReplyTo: memory.id, isVoiceMessage: true } };
      const callback: HandlerCallback = async (content: Content) => {
        await deliverReply(reply, content);
        return [];
      };

      await this.runtime.emitEvent(hyperfyEventType.VOICE_MESSAGE_RECEIVED as string, {
        runtime: this.runtime,
        message: memory,
        callback,
      } as any);
    } catch (error) {
      console.error('Error processing voice message:', error);
    }
  }

  /**
   * Synthesizes text and plays it in the world. Never throws. Resolves to how much of it was
   * played: 'none' when there is nothing to say, the voice limit is reached, TTS failed, `admit`
   * said no, or no audio went out; 'partial' when the playback stopped, failed, timed out or was
   * cut by the end of its turn after some of it went out, and also when all of it played but not
   * all of the reply was said (it was longer than what is said aloud, or it had links, which are
   * never read aloud). An utterance some of which was played counts as delivered for the turn.
   * `admit`, when given, is asked before synthesis and again right before playback (a reply that
   * reports a privileged action: deliver-reply.ts).
   */
  async speak(text: string, { admit }: { admit?: () => boolean } = {}): Promise<Played> {
    // Never read URLs aloud
    const hadLinks = /https?:\/\/\S+/.test(text ?? '');
    text = text?.replace(/https?:\/\/\S+/g, '').trim();
    // Nothing is synthesized (it costs money) or said for a turn that may no longer act
    const turn = currentTurn();
    if (!text || this.stopped || (turn && !turn.live)) return 'none';
    if (admit && !admit()) return 'none';
    // Capped before anything is synthesized or counted
    const spoken = spokenPart(text);
    text = spoken.text;
    // Captured before synthesis so a stop() during the TTS request discards the result
    const generation = this.playbackGeneration;
    try {
      // Each provider request is counted against the daily limit before it is sent (utils.ts)
      const audioBuffer = await generateSpeech(text);
      if (!audioBuffer) {
        console.log('[VoiceManager] No audio generated - check ELEVENLABS_XI_API_KEY or OPENAI_API_KEY in .env');
        return 'none';
      }
      const played = await this.playAudio(audioBuffer, generation, admit);
      if (played !== 'none') noteDelivered();
      // All of the capped text was played, but not all of the reply
      return played === 'all' && (spoken.cut || hadLinks) ? 'partial' : played;
    } catch (error) {
      if (error instanceof TurnCancelled) {
        logger.info(`[VoiceManager] Not speaking: ${error.message}`);
        return 'none';
      }
      if (error instanceof TtsLimitReached) {
        if (Date.now() - this.lastTtsLimitLogAt >= VOICE_LIMIT_NOTICE_INTERVAL_MS) {
          this.lastTtsLimitLogAt = Date.now();
          logger.info(`[VoiceManager] VOICE_TTS_MAX_CHARS_PER_DAY=${getUsageBudget().limits.ttsCharsPerDay} reached; replying in text only`);
        }
        return 'none';
      }
      logger.warn(`[VoiceManager] TTS failed, text-only response sent: ${errorText(error)}`);
      return 'none';
    }
  }

  /** Tells players (at most every 10 minutes) to type, while voice input is over its limit. */
  private noticeVoiceInputPaused(): void {
    if (Date.now() - this.lastSttLimitNoticeAt < VOICE_LIMIT_NOTICE_INTERVAL_MS) return;
    this.lastSttLimitNoticeAt = Date.now();
    logger.info(`[VoiceManager] VOICE_STT_MAX_SECONDS_PER_DAY=${getUsageBudget().limits.sttSecondsPerDay} reached; ignoring voice input`);
    this.session.messages.sendMessage('🎙️ Voice input is paused for now — please type in chat. / 音声入力は一時停止中です。チャットで話しかけてください。');
  }

  /**
   * Queues audio so overlapping replies play one after another instead of being dropped.
   * A failed or hung playback never blocks the ones after it. Resolves to how much of it went out
   * to the room (AgentLiveKit.publishAudioStream counts the frames as they go): 'partial' also when
   * the playback failed or timed out after some of it had played.
   */
  async playAudio(audioBuffer: Buffer, generation: number = this.playbackGeneration, admit?: () => boolean): Promise<Played> {
    if (this.stopped || generation !== this.playbackGeneration) return 'none';
    if (this.pendingPlaybacks >= MAX_PENDING_PLAYBACKS) {
      logger.warn(`[VoiceManager] ${this.pendingPlaybacks} utterances already queued, dropping audio`);
      return 'none';
    }

    this.pendingPlaybacks++;
    const current = this.playbackChain.then((): Played | Promise<Played> =>
      generation === this.playbackGeneration ? this.playNow(audioBuffer, admit) : 'none'
    );
    this.playbackChain = current.then(() => { }, () => { });

    try {
      return await current;
    } catch (error) {
      logger.error(`[VoiceManager] Audio playback failed: ${errorText(error)}`);
      return 'none';
    } finally {
      if (generation === this.playbackGeneration) this.pendingPlaybacks--;
    }
  }

  private async playNow(audioBuffer: Buffer, admit?: () => boolean): Promise<Played> {
    const world = this.session.world;
    if (this.stopped || !world?.livekit) return 'none';
    // Cancelled while it was synthesized or waited behind another utterance: it is not said into what came after
    const turn = currentTurn();
    if (turn && !turn.live) return 'none';
    // No longer admitted (a privileged report whose requester lost the right meanwhile): the audio is discarded
    if (admit && !admit()) {
      logger.info('[VoiceManager] Not playing an utterance that is no longer admitted');
      return 'none';
    }

    // Speaking state makes the engine play the TALK emote
    const player = world.entities?.player;
    this.isSpeaking = true;
    player?.setSpeaking?.(true);

    const abort = new AbortController();
    this.activePlayback = abort;
    // One that is playing when its turn is cancelled is cut there (and stop() cuts any)
    const cut = () => abort.abort();
    turn?.signal.addEventListener('abort', cut, { once: true });
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        abort.abort();
        reject(new Error(`Audio playback timed out after ${PLAYBACK_TIMEOUT_MS}ms`));
      }, PLAYBACK_TIMEOUT_MS);
    });

    // Survives a failure or a timeout of the playback: how many frames the room took
    const progress = { frames: 0 };
    try {
      const outcome: PlaybackOutcome = await Promise.race([
        world.livekit.publishAudioStream(audioBuffer, { signal: abort.signal, progress }),
        timeout,
      ]);
      const played: Played = outcome?.played === 'all' || outcome?.played === 'partial' ? outcome.played : progress.frames > 0 ? 'partial' : 'none';
      if (played !== 'all') logger.warn(`[VoiceManager] Audio ${played === 'none' ? 'not played' : 'only partly played'}: ${outcome?.reason ?? outcome?.error ?? 'no outcome'}`);
      return played;
    } catch (error) {
      const played: Played = progress.frames > 0 ? 'partial' : 'none';
      logger.warn(`[VoiceManager] Audio ${played === 'none' ? 'not played' : 'only partly played'}: ${error instanceof Error ? error.message : String(error)}`);
      return played;
    } finally {
      clearTimeout(timer);
      turn?.signal.removeEventListener('abort', cut);
      if (this.activePlayback === abort) this.activePlayback = null;
      this.isSpeaking = false;
      player?.setSpeaking?.(false);
    }
  }
}
