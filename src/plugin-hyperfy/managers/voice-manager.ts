import { ChannelType, Content, HandlerCallback, IAgentRuntime, Memory, ModelType, UUID, createUniqueUuid, logger } from "@elizaos/core";
import { HyperfyService } from "../service";
import { countOtherPlayers, generateSpeech, getWavHeader } from "../utils";
import { agentActivityLock } from "./guards";
import { hyperfyEventType } from "../events";
import { isDirectlyAddressed, parseAliases } from "../lib/addressing";
import { isOpenPayLink } from "../../openpay-store";
import { getUsageBudget } from "../../usage-budget";
import { type TurnContext, currentTurn, neverAbortedSignal, noteDelivered, runTurn } from "../lib/turn-context";
import type { PlaybackOutcome, Played } from "../systems/liveKit";

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

export class VoiceManager {
  private runtime: IAgentRuntime;
  private userStates: Map<
    string,
    {
      buffers: Buffer[];
      totalLength: number;
      lastActive: number;
      transcriptionText: string;
    }
  > = new Map();
  private isTranscribing: boolean = false;
  private isSpeaking: boolean = false;
  private transcriptionTimeout: NodeJS.Timeout | null = null;
  private audioListener: ((data: LiveKitAudioData) => void) | null = null;
  private audioSource: any = null;
  private playbackChain: Promise<void> = Promise.resolve();
  private pendingPlaybacks = 0;
  private playbackGeneration = 0;
  private activePlayback: AbortController | null = null;
  // Managers are per connection; once stopped, late async work must not touch the next world.
  private stopped = false;
  private lastSttLimitNoticeAt = Number.NEGATIVE_INFINITY;
  private lastTtsLimitLogAt = Number.NEGATIVE_INFINITY;

  constructor(runtime: IAgentRuntime) {
    this.runtime = runtime;
  }

  start() {
    const service = this.getService();
    if (!service) {
      console.error('[VoiceManager] Cannot start - service not available');
      return;
    }
    const world = service.getWorld();
    if (!world || !world.livekit) {
      console.error('[VoiceManager] Cannot start - world or livekit not available');
      return;
    }
    if (!this.runtime.getModel(ModelType.TRANSCRIPTION)) {
      logger.warn('[VoiceManager] No TRANSCRIPTION model (set ELEVENLABS_XI_API_KEY with the speech_to_text permission): voice input is ignored');
    }

    this.audioListener = (data: LiveKitAudioData) => {
      function isLoudEnough(pcmBuffer: Buffer, threshold = 1000): boolean {
        let sum = 0;
        const sampleCount = Math.floor(pcmBuffer.length / 2); // 16-bit samples

        for (let i = 0; i + 1 < pcmBuffer.length; i += 2) {
          const sample = pcmBuffer.readInt16LE(i);
          sum += Math.abs(sample);
        }

        const avgAmplitude = sum / sampleCount;
        return avgAmplitude > threshold;
      }

      const playerId = data.participant;
      if (!this.userStates.has(playerId)) {
        this.userStates.set(playerId, {
          buffers: [],
          totalLength: 0,
          lastActive: Date.now(),
          transcriptionText: '',
        });
      }

      const pcmBuffer = data.buffer;
      if (isLoudEnough(pcmBuffer)) {
        this.handleUserBuffer(playerId, pcmBuffer)
      }
    };
    this.audioSource = world.livekit;
    this.audioSource.on('audio', this.audioListener);
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
    if (this.transcriptionTimeout) {
      clearTimeout(this.transcriptionTimeout);
      this.transcriptionTimeout = null;
    }
    this.userStates.clear();
    this.isTranscribing = false;
    this.isSpeaking = false;
    this.stopped = true;
    this.playbackGeneration++;
    this.playbackChain = Promise.resolve();
    this.pendingPlaybacks = 0;
    this.activePlayback?.abort();
    this.activePlayback = null;
  }

  async handleUserBuffer(playerId, buffer) {
    const state = this.userStates.get(playerId);
    try {
      state?.buffers.push(buffer);
      state!.totalLength += buffer.length;
      state!.lastActive = Date.now();
      this.debouncedProcessTranscription(playerId);
    } catch (error) {
      console.error(`Error processing buffer for user ${playerId}:`, error);
    }
  }

  async debouncedProcessTranscription(
    playerId: UUID,
  ) {
    const DEBOUNCE_TRANSCRIPTION_THRESHOLD = 1500; // wait for 1.5 seconds of silence

    // Don't listen while transcribing or while the agent itself is talking.
    if (this.isTranscribing || this.isSpeaking) {
      const state = this.userStates.get(playerId);
      state.buffers.length = 0;
      state.totalLength = 0;
      return;
    }

    if (this.transcriptionTimeout) {
      clearTimeout(this.transcriptionTimeout);
    }

    this.transcriptionTimeout = setTimeout(() => {
      this.transcriptionTimeout = null;
      const service = this.getService();
      const world = service?.getWorld();
      if (!world) return;
      const turn: TurnContext = {
        origin: 'voice',
        // The LiveKit participant identity, which the world's server sets to the player id
        requesterId: playerId,
        world,
        generation: service.getConnectionGeneration(),
        signal: neverAbortedSignal(),
      };
      agentActivityLock
        .run(() => runTurn(turn, () => this.processTranscription(playerId)))
        .catch((error) => console.error(`Error handling voice from ${playerId}:`, error));
    }, DEBOUNCE_TRANSCRIPTION_THRESHOLD) as unknown as NodeJS.Timeout;
  }

  private async processTranscription(
    playerId: UUID,
  ) {
    const state = this.userStates.get(playerId);
    if (!state || state.buffers.length === 0) return;

    let transcriptionText: string;
    this.isTranscribing = true;
    try {
      const inputBuffer = Buffer.concat(state.buffers, state.totalLength);
      state.buffers.length = 0; // Clear the buffers
      state.totalLength = 0;
      const wavHeader = getWavHeader(inputBuffer.length, 48000);
      const wavBuffer = Buffer.concat([wavHeader, inputBuffer]);
      logger.debug('Starting transcription...');

      // One attempt through the registered model: ElevenLabs (src/elevenlabs-speech.ts) when
      // configured, otherwise e.g. OpenAI. Without any, voice input is simply unavailable.
      if (!this.runtime.getModel(ModelType.TRANSCRIPTION)) return;
      const budget = getUsageBudget();
      if (!budget.sttAvailable()) {
        budget.recordSkip('stt');
        this.noticeVoiceInputPaused();
        return;
      }
      // Billed by audio length, whatever the result
      budget.recordStt(inputBuffer.length / PCM_BYTES_PER_SECOND);
      transcriptionText = await this.runtime.useModel(ModelType.TRANSCRIPTION, wavBuffer);
      console.log("[VOICE MANAGER] Transcription: ", transcriptionText)
    } catch (error) {
      console.error(`Error transcribing audio for user ${playerId}:`, error);
      return;
    } finally {
      this.isTranscribing = false;
      // Drop whatever anyone said during transcription
      this.userStates.forEach((userState) => {
        userState.buffers.length = 0;
        userState.totalLength = 0;
      });
    }

    if (this.stopped) return;

    function isValidTranscription(text: string): boolean {
      if (!text || text.includes('[BLANK_AUDIO]')) return false;
      return true;
    }

    if (transcriptionText && isValidTranscription(transcriptionText)) {
      state.transcriptionText += transcriptionText;
    }

    if (state.transcriptionText.length) {
      const finalText = state.transcriptionText;
      state.transcriptionText = '';
      await this.handleMessage(finalText, playerId);
    }
  }

  private async handleMessage(
    message: string,
    playerId: UUID,
  ) {
    try {
      if (!message || message.trim() === '' || message.length < 3) {
        return;
      }
      const service = this.getService();
      const world = service.getWorld();
      if (!world) return;
      // The connection the voice was heard on (the turn's): nothing is posted on another one
      const generation = currentTurn()?.generation ?? service.getConnectionGeneration();
      const live = () => !this.stopped && service.getWorld() === world && service.getConnectionGeneration() === generation;
      if (!live()) return;

      const playerInfo = world.entities.getPlayer(playerId);
      const userName = playerInfo?.data?.name || playerId;
      const name = userName;
      const _currentWorldId = service.currentWorldId;
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
          },
        },
        createdAt: Date.now(),
      };

      const callback: HandlerCallback = async (content: Content, _files: any[] = []) => {
        console.info(`[Hyperfy Voice Chat Callback] Received response: ${JSON.stringify(content)}`)
        // Checked again after every await below, right before anything is posted or played
        if (!live()) return [];
        try {
          const responseMemory: Memory = {
            id: createUniqueUuid(this.runtime, `${memory.id}-voice-response-${Date.now()}`),
            entityId: this.runtime.agentId,
            agentId: this.runtime.agentId,
            content: {
              ...content,
              name: this.runtime.character.name,
              inReplyTo: memory.id,
              isVoiceMessage: true,
              channelType: type,
            },
            roomId,
            createdAt: Date.now(),
          };

          await this.runtime.createMemory(responseMemory, 'messages');
          if (!live()) return [responseMemory];

          if (responseMemory.content.text?.trim() && isOpenPayLink(content)) {
            // Voice replies are only spoken, but a shop link has to be clickable: post it to chat
            service.getMessageManager()?.sendMessage(content.text);
          } else if (responseMemory.content.text?.trim()) {
            const emoteManager = service.getEmoteManager();
            const emote = content.emote as string || "TALK";
            emoteManager.playEmote(emote);
            // Voice replies are normally only spoken. When not all of it could be (voice limit, TTS
            // failure, a playback that failed part way), the whole reply is posted too, so none of it is lost
            const spoken = await this.speak(content.text);
            if (spoken !== 'all' && live()) {
              if (spoken === 'partial') logger.info('[VoiceManager] Reply partly spoken, then posted as text');
              service.getMessageManager()?.sendMessage(content.text);
            }
          }

          return [responseMemory];
        } catch (error) {
          console.error('Error in voice message callback:', error);
          return [];
        }
      };

      // Awaited inside the activity lock (see processTranscription) so the
      // behavior loop stays paused until the reply has been spoken.
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
   * played: 'none' when there is nothing to say, the voice limit is reached, TTS failed, or no
   * audio went out; 'partial' when the playback stopped, failed or timed out after some of it
   * went out. An utterance some of which was played counts as delivered for the turn.
   */
  async speak(text: string): Promise<Played> {
    // Never read URLs aloud
    text = text?.replace(/https?:\/\/\S+/g, '').trim();
    if (!text || this.stopped) return 'none';
    const budget = getUsageBudget();
    if (!budget.ttsAvailable()) {
      budget.recordSkip('tts');
      if (Date.now() - this.lastTtsLimitLogAt >= VOICE_LIMIT_NOTICE_INTERVAL_MS) {
        this.lastTtsLimitLogAt = Date.now();
        logger.info(`[VoiceManager] VOICE_TTS_MAX_CHARS_PER_DAY=${budget.limits.ttsCharsPerDay} reached; replying in text only`);
      }
      return 'none';
    }
    // Captured before synthesis so a stop() during the TTS request discards the result
    const generation = this.playbackGeneration;
    try {
      const audioBuffer = await generateSpeech(text);
      if (!audioBuffer) {
        console.log('[VoiceManager] No audio generated - check ELEVENLABS_XI_API_KEY or OPENAI_API_KEY in .env');
        return 'none';
      }
      budget.recordTts(text.length);
      const played = await this.playAudio(audioBuffer, generation);
      if (played !== 'none') noteDelivered();
      return played;
    } catch (error) {
      logger.warn('[VoiceManager] TTS failed, text-only response sent:', error);
      return 'none';
    }
  }

  /** Tells players (at most every 10 minutes) to type, while voice input is over its limit. */
  private noticeVoiceInputPaused(): void {
    if (Date.now() - this.lastSttLimitNoticeAt < VOICE_LIMIT_NOTICE_INTERVAL_MS) return;
    this.lastSttLimitNoticeAt = Date.now();
    logger.info(`[VoiceManager] VOICE_STT_MAX_SECONDS_PER_DAY=${getUsageBudget().limits.sttSecondsPerDay} reached; ignoring voice input`);
    this.getService()
      ?.getMessageManager()
      ?.sendMessage('🎙️ Voice input is paused for now — please type in chat. / 音声入力は一時停止中です。チャットで話しかけてください。');
  }

  /**
   * Queues audio so overlapping replies play one after another instead of being dropped.
   * A failed or hung playback never blocks the ones after it. Resolves to how much of it went out
   * to the room (AgentLiveKit.publishAudioStream counts the frames as they go): 'partial' also when
   * the playback failed or timed out after some of it had played.
   */
  async playAudio(audioBuffer: Buffer, generation: number = this.playbackGeneration): Promise<Played> {
    if (this.stopped || generation !== this.playbackGeneration) return 'none';
    if (this.pendingPlaybacks >= MAX_PENDING_PLAYBACKS) {
      logger.warn(`[VoiceManager] ${this.pendingPlaybacks} utterances already queued, dropping audio`);
      return 'none';
    }

    this.pendingPlaybacks++;
    const current = this.playbackChain.then((): Played | Promise<Played> =>
      generation === this.playbackGeneration ? this.playNow(audioBuffer) : 'none'
    );
    this.playbackChain = current.then(() => { }, () => { });

    try {
      return await current;
    } catch (error) {
      logger.error('[VoiceManager] Audio playback failed:', error);
      return 'none';
    } finally {
      if (generation === this.playbackGeneration) this.pendingPlaybacks--;
    }
  }

  private async playNow(audioBuffer: Buffer): Promise<Played> {
    const world = this.getService()?.getWorld();
    if (!world?.livekit) return 'none';

    // Speaking state makes the engine play the TALK emote
    const player = world.entities?.player;
    this.isSpeaking = true;
    player?.setSpeaking?.(true);

    const abort = new AbortController();
    this.activePlayback = abort;
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
      if (this.activePlayback === abort) this.activePlayback = null;
      this.isSpeaking = false;
      player?.setSpeaking?.(false);
    }
  }

  private getService() {
    return this.runtime.getService<HyperfyService>(HyperfyService.serviceType);
  }
}
