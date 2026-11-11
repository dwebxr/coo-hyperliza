import { promises as fsPromises } from 'fs';
import type { Action, IAgentRuntime, Memory, State } from '@elizaos/core';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import path from 'path';
import { describeUrl } from './lib/log-url';
import { getUsageBudget } from '../usage-budget';
import { assertTurnLive } from './lib/turn-context';


export async function hashFileBuffer(buffer: Buffer): Promise<string> {
  // A copy on its own ArrayBuffer, which the Web Crypto types require (Node's Buffer may share one)
  const hashBuf = await crypto.subtle.digest('SHA-256', new Uint8Array(buffer))
  const hash = Array.from(new Uint8Array(hashBuf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
  return hash
}

export function getModuleDirectory(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  return __dirname
}

const mimeTypes: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.webp': 'image/webp',
  '.hdr': 'image/vnd.radiance',
  '.json': 'application/json',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.vrm': 'model/gltf-binary',
  '.hyp': 'application/octet-stream',
};

function getMimeTypeFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return mimeTypes[ext] || 'application/octet-stream';
}

export const resolveUrl = async (
  url: unknown,
  world: { assetsUrl?: string | null },
  { allowLocal = true }: { allowLocal?: boolean } = {}
): Promise<string | null> => {
  if (typeof url !== "string") {
    console.error(`Invalid URL type provided: ${typeof url}`);
    return null;
  }
  if (url.startsWith("asset://")) {
    if (!world.assetsUrl) {
      console.error(
        "Cannot resolve asset:// URL, world.assetsUrl not set."
      );
      return null;
    }
    const filename = url.substring("asset://".length);
    const baseUrl = world.assetsUrl.replace(/[/\\\\]$/, ""); // Remove trailing slash (either / or \)
    return `${baseUrl}/${filename}`;
  }
  if (url.startsWith("http://") || url.startsWith("https://") || url.startsWith("data:") || url.startsWith("blob:")) {
    return url;
  }

  if (!allowLocal) {
    console.warn(`[resolveUrl] Refusing to read local path "${describeUrl(url)}".`);
    return null;
  }

  // Local files are only read from inside the module directory (bundled assets),
  // never from arbitrary paths supplied by world content.
  const moduleDir = path.resolve(getModuleDirectory());
  const fullPath = path.resolve(moduleDir, url);
  if (path.isAbsolute(url) || (fullPath !== moduleDir && !fullPath.startsWith(moduleDir + path.sep))) {
    console.warn(`[resolveUrl] Refusing to read "${describeUrl(url)}" outside the module directory.`);
    return null;
  }

  try {
    const buffer = await fsPromises.readFile(fullPath);
    const mimeType = getMimeTypeFromPath(fullPath);
    return `data:${mimeType};base64,${buffer.toString('base64')}`;
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      console.error(`[AgentLoader] File not found at "${fullPath}"`);
    } else {
      console.error(`Error reading file at "${fullPath}":`, err);
    }
    return null;
  }
}

/**
 * Counts player entities other than the agent itself.
 */
export function countOtherPlayers(world: any): number {
  const selfId = world?.entities?.player?.data?.id;
  const entities = world?.entities?.items;
  if (!entities) return 0;
  let count = 0;
  for (const [id, entity] of entities.entries()) {
    if (entity?.data?.type === 'player' && id !== selfId) count++;
  }
  return count;
}

/**
 * Fetches and validates actions from the runtime.
 * If `includeList` is provided, filters actions by those names only.
 *
 * @param runtime - The agent runtime
 * @param message - The message memory
 * @param state - The state
 * @param includeList - Optional list of action names to include
 * @returns Array of validated actions
 */
export async function getHyperfyActions(
  runtime: IAgentRuntime,
  message: Memory,
  state: State,
  includeList?: string[]
): Promise<Action[]> {
  const availableActions = includeList
    ? runtime.actions.filter((action) => includeList.includes(action.name))
    : runtime.actions;

  const validated = await Promise.all(
    availableActions.map(async (action) => {
      const result = await action.validate(runtime, message, state);
      return result ? action : null;
    })
  );

  return validated.filter(Boolean) as Action[];
}

/**
 * Formats the provided actions into a detailed string listing each action's name and description, separated by commas and newlines.
 * @param actions - An array of `Action` objects to format.
 * @returns A detailed string of actions, including names and descriptions.
 */
export function formatActions(actions: Action[]) {
  return actions
    .sort(() => 0.5 - Math.random())
    .map((action: Action) => `- **${action.name}**: ${action.description}`)
    .join('\n\n');
}

export function getWavHeader(
  audioLength: number,
  sampleRate: number,
  channelCount: number = 1,
  bitsPerSample: number = 16
): Buffer {
  const wavHeader = Buffer.alloc(44);
  wavHeader.write('RIFF', 0);
  wavHeader.writeUInt32LE(36 + audioLength, 4);
  wavHeader.write('WAVE', 8);
  wavHeader.write('fmt ', 12);
  wavHeader.writeUInt32LE(16, 16);
  wavHeader.writeUInt16LE(1, 20);
  wavHeader.writeUInt16LE(channelCount, 22);
  wavHeader.writeUInt32LE(sampleRate, 24);
  wavHeader.writeUInt32LE(sampleRate * channelCount * (bitsPerSample / 8), 28);
  wavHeader.writeUInt16LE(channelCount * (bitsPerSample / 8), 32);
  wavHeader.writeUInt16LE(bitsPerSample, 34);
  wavHeader.write('data', 36);
  wavHeader.writeUInt32LE(audioLength, 40);
  return wavHeader;
}

// One deadline for a speech request and for reading its answer
const TTS_REQUEST_TIMEOUT_MS = 30_000;
// The audio of one utterance. A minute of speech is about 1 MB as 128 kbit/s MP3 and 6 MB as
// 48 kHz PCM; what is spoken of one reply is capped before it is sent (voice-manager.ts)
export const MAX_SPEECH_AUDIO_BYTES = 16 * 1024 * 1024;
// A transcript with word timings for at most 30 s of audio is a few kilobytes
export const MAX_TRANSCRIPT_RESPONSE_BYTES = 1024 * 1024;
// How much of an API's error answer is read, to be logged
const MAX_ERROR_BODY_BYTES = 2048;

/**
 * The body of a fetch response, read as it arrives and given up as soon as it is larger than
 * `maxBytes` (throws) or `signal` fires (throws). With `truncate` a larger body is cut at
 * `maxBytes` instead. Either way the rest of the body is cancelled, not downloaded.
 */
export async function readBodyWithin(response: Response, maxBytes: number, signal: AbortSignal, { truncate = false }: { truncate?: boolean } = {}): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length'));
  if (!truncate && Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`the response is ${declared} bytes, more than the ${maxBytes} allowed`);
  }
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const onAbort = () => void reader.cancel().catch(() => {});
  signal.addEventListener('abort', onAbort, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      if (signal.aborted) throw new Error('the response took too long');
      const { done, value } = await reader.read();
      if (signal.aborted) throw new Error('the response took too long');
      if (done) break;
      if (size + value.byteLength > maxBytes) {
        if (!truncate) throw new Error(`the response is larger than the ${maxBytes} bytes allowed`);
        chunks.push(value.subarray(0, maxBytes - size));
        break;
      }
      chunks.push(value);
      size += value.byteLength;
    }
    return Buffer.concat(chunks);
  } finally {
    signal.removeEventListener('abort', onAbort);
    // A no-op when the body was read to its end
    await reader.cancel().catch(() => {});
  }
}

/** Runs one request under a deadline that also covers reading its answer. */
async function withDeadline<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new Error(`no complete answer within ${ms} ms`)), ms);
  try {
    return await run(deadline.signal);
  } finally {
    clearTimeout(timer);
  }
}

/** The start of an API's error answer, on one line, for the log. */
async function errorText(response: Response, signal: AbortSignal): Promise<string> {
  const head = await readBodyWithin(response, MAX_ERROR_BODY_BYTES, signal, { truncate: true }).catch(() => Buffer.alloc(0));
  return head.toString('utf8').replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').trim();
}

/** One text-to-speech request to one provider, and whether it may be billed when it gave no audio. */
export interface SpeechAttempt {
  audio: Buffer | null;
  /**
   * False when no request was sent (no key) or the provider refused it with a 4xx answer (408 and
   * 409 excepted: they can follow work already done). True otherwise: audio came, or the request
   * went out and its outcome is not known (a connection error, a timeout, a 5xx, a body that failed
   * or stalled after the provider accepted the request).
   */
  mayBeBilled: boolean;
}

const refusedStatus = (status: number) => status >= 400 && status < 500 && status !== 408 && status !== 409;

/**
 * Runs one speech request under TTS_REQUEST_TIMEOUT_MS: `request` makes it, the answer is read as it
 * arrives (at most MAX_SPEECH_AUDIO_BYTES). Never throws.
 */
async function speechAttempt(label: string, request: (signal: AbortSignal) => Promise<Response>): Promise<SpeechAttempt> {
  try {
    return await withDeadline(TTS_REQUEST_TIMEOUT_MS, async (signal) => {
      const response = await request(signal);
      if (!response.ok) {
        console.error(`[${label}] API error ${response.status}: ${await errorText(response, signal)}`);
        return { audio: null, mayBeBilled: !refusedStatus(response.status) };
      }
      // Read as it arrives, at most MAX_SPEECH_AUDIO_BYTES and within the request's deadline
      const buffer = await readBodyWithin(response, MAX_SPEECH_AUDIO_BYTES, signal);
      console.log(`[${label}] Successfully generated ${buffer.length} bytes of audio`);
      return { audio: buffer, mayBeBilled: true };
    });
  } catch (error) {
    console.error(`[${label}] Error:`, error);
    return { audio: null, mayBeBilled: true };
  }
}

/** One ElevenLabs text-to-speech request (nothing is reserved here: the caller does, and settles it by `mayBeBilled`). */
export function elevenLabsSpeech(text: string): Promise<SpeechAttempt> {
  const apiKey = process.env.ELEVENLABS_XI_API_KEY;
  if (!apiKey) {
    console.error('[ElevenLabs TTS] No ELEVENLABS_XI_API_KEY found in environment');
    return Promise.resolve({ audio: null, mayBeBilled: false });
  }

  const voiceId = process.env.ELEVENLABS_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL';
  const modelId = process.env.ELEVENLABS_MODEL_ID || 'eleven_multilingual_v2';
  const stability = parseFloat(process.env.ELEVENLABS_VOICE_STABILITY || '0.5');
  const similarityBoost = parseFloat(process.env.ELEVENLABS_VOICE_SIMILARITY_BOOST || '0.9');
  const style = parseFloat(process.env.ELEVENLABS_VOICE_STYLE || '0.66');
  // Use mp3_44100_128 for better compatibility with LiveKit
  // pcm_16000 causes audio to play at wrong speed because LiveKit expects 48000Hz
  // mp3 format will be properly converted by ffmpeg to the correct sample rate
  const outputFormat = process.env.ELEVENLABS_OUTPUT_FORMAT || 'mp3_44100_128';

  console.log(`[ElevenLabs TTS] Generating speech with voiceId=${voiceId}, model=${modelId}, format=${outputFormat}`);

  return speechAttempt('ElevenLabs TTS', (signal) =>
    fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=${outputFormat}`, {
      method: 'POST',
      signal,
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: text,
        model_id: modelId,
        voice_settings: {
          stability: stability,
          similarity_boost: similarityBoost,
          style: style,
          use_speaker_boost: process.env.ELEVENLABS_VOICE_USE_SPEAKER_BOOST === 'true',
        },
      }),
    })
  );
}

/**
 * Direct OpenAI TTS API call - bypasses the @elizaos/plugin-openai which has issues reading the API key
 */
function openAISpeech(text: string): Promise<SpeechAttempt> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error('[OpenAI TTS Direct] No OPENAI_API_KEY found in environment');
    return Promise.resolve({ audio: null, mayBeBilled: false });
  }

  const model = process.env.OPENAI_TTS_MODEL || 'tts-1';
  const voice = process.env.OPENAI_TTS_VOICE || 'nova';

  console.log(`[OpenAI TTS Direct] Generating speech with model=${model}, voice=${voice}`);

  return speechAttempt('OpenAI TTS Direct', (signal) =>
    fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      signal,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: model,
        input: text,
        voice: voice,
        response_format: 'mp3',
      }),
    })
  );
}

/**
 * ElevenLabs text-to-speech (one request, nothing reserved here).
 * @returns the audio (MP3 by default), or null when ElevenLabs isn't configured or the call fails
 */
export async function generateElevenLabsTTS(text: string): Promise<Buffer | null> {
  return (await elevenLabsSpeech(text)).audio;
}

/** OpenAI text-to-speech (one request, nothing reserved here). The audio, or null. */
export async function generateOpenAITTS(text: string): Promise<Buffer | null> {
  return (await openAISpeech(text)).audio;
}

/**
 * Direct ElevenLabs speech-to-text call. Bypasses @elizaos/plugin-elevenlabs, whose TRANSCRIPTION
 * handler builds https://api.elevenlabs.io/v1/v1/speech-to-text (404) and reads a different key name.
 * @returns the transcript, or null when ElevenLabs isn't configured or the call fails
 */
export async function transcribeWithElevenLabs(audio: Buffer, fileName = 'speech.wav'): Promise<string | null> {
  const apiKey = process.env.ELEVENLABS_XI_API_KEY;
  if (!apiKey) return null;

  const form = new FormData();
  form.append('model_id', process.env.ELEVENLABS_STT_MODEL_ID || 'scribe_v2');
  if (process.env.ELEVENLABS_STT_LANGUAGE_CODE) {
    form.append('language_code', process.env.ELEVENLABS_STT_LANGUAGE_CODE);
  }
  form.append('file', new Blob([new Uint8Array(audio)]), fileName);

  try {
    return await withDeadline(TTS_REQUEST_TIMEOUT_MS, async (signal) => {
      const response = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
        method: 'POST',
        signal,
        headers: { 'xi-api-key': apiKey },
        body: form,
      });
      if (!response.ok) {
        console.error(`[ElevenLabs STT] API error ${response.status}: ${await errorText(response, signal)}`);
        return null;
      }
      const body = await readBodyWithin(response, MAX_TRANSCRIPT_RESPONSE_BYTES, signal);
      const data = JSON.parse(body.toString('utf8')) as { text?: unknown };
      return typeof data?.text === 'string' ? data.text : null;
    });
  } catch (error) {
    console.error('[ElevenLabs STT] Error:', error);
    return null;
  }
}

/** Thrown by generateSpeech when VOICE_TTS_MAX_CHARS_PER_DAY does not admit the text: nothing was sent. */
export class TtsLimitReached extends Error {
  constructor() {
    super('[TTS] VOICE_TTS_MAX_CHARS_PER_DAY does not admit this text');
    this.name = 'TtsLimitReached';
  }
}

const SPEECH_PROVIDERS = [
  { name: 'ElevenLabs', key: 'ELEVENLABS_XI_API_KEY', attempt: elevenLabsSpeech },
  { name: 'OpenAI', key: 'OPENAI_API_KEY', attempt: openAISpeech },
] as const;

/**
 * Speech audio for `text`: ElevenLabs, then OpenAI when that gave none. Each request is reserved
 * against VOICE_TTS_MAX_CHARS_PER_DAY on its own, before it is sent. A request the provider refused
 * (a 4xx answer) is given back; any other failed one stays counted, as it may have been billed. A
 * fallback the limit does not admit is not made, and neither is one for a turn that may no longer
 * act (lib/turn-context.ts: TurnCancelled is thrown, the requests already sent stay counted).
 * Resolves to null when no provider gave audio; throws TtsLimitReached when the limit admits not
 * even the first request.
 */
export async function generateSpeech(text: string): Promise<Buffer | null> {
  const budget = getUsageBudget();
  let sent = false;
  for (const provider of SPEECH_PROVIDERS) {
    if (!process.env[provider.key]) continue;
    // Before each reservation and request, the fallback's included
    assertTurnLive();
    const reservation = budget.reserveTts(text.length);
    if (!reservation) {
      budget.recordSkip('tts');
      if (!sent) throw new TtsLimitReached();
      console.log(`[TTS] Not trying ${provider.name}: the daily text-to-speech limit has no room for another request`);
      return null;
    }
    if (sent) console.log(`[TTS] Trying ${provider.name}...`);
    sent = true;
    const { audio, mayBeBilled } = await provider.attempt(text);
    if (audio) return audio;
    if (!mayBeBilled) reservation.release();
  }
  return null;
}
