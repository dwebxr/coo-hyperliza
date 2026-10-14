import { Readable } from 'node:stream';
import { promises as fsPromises } from 'fs';
import type { Action, IAgentRuntime, Memory, State } from '@elizaos/core';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import path from 'path';


export async function hashFileBuffer(buffer: Buffer): Promise<string> {
  const hashBuf = await crypto.subtle.digest('SHA-256', buffer)
  const hash = Array.from(new Uint8Array(hashBuf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
  return hash
}

export async function convertToAudioBuffer(speechResponse: any): Promise<Buffer> {
  if (Buffer.isBuffer(speechResponse)) {
    return speechResponse;
  }

  if (typeof speechResponse?.getReader === 'function') {
    // Handle Web ReadableStream
    const reader = (speechResponse as ReadableStream<Uint8Array>).getReader();
    const chunks: Uint8Array[] = [];

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
      }
      return Buffer.concat(chunks);
    } finally {
      reader.releaseLock();
    }
  }

  if (
    speechResponse instanceof Readable ||
    (speechResponse &&
      speechResponse.readable === true &&
      typeof speechResponse.pipe === 'function' &&
      typeof speechResponse.on === 'function')
  ) {
    // Handle Node Readable Stream
    return new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      speechResponse.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      speechResponse.on('end', () => resolve(Buffer.concat(chunks)));
      speechResponse.on('error', (err) => reject(err));
    });
  }

  throw new Error('Unexpected response type from TEXT_TO_SPEECH model');
}

export function getModuleDirectory(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  return __dirname
}

const mimeTypes = {
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

function getMimeTypeFromPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return mimeTypes[ext] || 'application/octet-stream';
}

export const resolveUrl = async (
  url,
  world,
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
    console.warn(`[resolveUrl] Refusing to read local path "${url}".`);
    return null;
  }

  // Local files are only read from inside the module directory (bundled assets),
  // never from arbitrary paths supplied by world content.
  const moduleDir = path.resolve(getModuleDirectory());
  const fullPath = path.resolve(moduleDir, url);
  if (path.isAbsolute(url) || (fullPath !== moduleDir && !fullPath.startsWith(moduleDir + path.sep))) {
    console.warn(`[resolveUrl] Refusing to read "${url}" outside the module directory.`);
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

/**
 * Direct ElevenLabs TTS API call
 * @param text - Text to convert to speech
 * @returns Buffer containing the audio data (PCM format)
 */
const TTS_REQUEST_TIMEOUT_MS = 30_000;

export async function generateElevenLabsTTS(text: string): Promise<Buffer | null> {
  const apiKey = process.env.ELEVENLABS_XI_API_KEY;
  if (!apiKey) {
    console.error('[ElevenLabs TTS] No ELEVENLABS_XI_API_KEY found in environment');
    return null;
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

  try {
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=${outputFormat}`, {
      method: 'POST',
      signal: AbortSignal.timeout(TTS_REQUEST_TIMEOUT_MS),
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
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[ElevenLabs TTS] API error ${response.status}: ${errorText}`);
      return null;
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    console.log(`[ElevenLabs TTS] Successfully generated ${buffer.length} bytes of audio`);
    return buffer;
  } catch (error) {
    console.error('[ElevenLabs TTS] Error:', error);
    return null;
  }
}

/**
 * Direct OpenAI TTS API call - bypasses the @elizaos/plugin-openai which has issues reading the API key
 * @param text - Text to convert to speech
 * @returns Buffer containing the audio data (MP3 format)
 */
export async function generateOpenAITTS(text: string): Promise<Buffer | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error('[OpenAI TTS Direct] No OPENAI_API_KEY found in environment');
    return null;
  }

  const model = process.env.OPENAI_TTS_MODEL || 'tts-1';
  const voice = process.env.OPENAI_TTS_VOICE || 'nova';

  console.log(`[OpenAI TTS Direct] Generating speech with model=${model}, voice=${voice}`);

  try {
    const response = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      signal: AbortSignal.timeout(TTS_REQUEST_TIMEOUT_MS),
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
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[OpenAI TTS Direct] API error ${response.status}: ${errorText}`);
      return null;
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    console.log(`[OpenAI TTS Direct] Successfully generated ${buffer.length} bytes of audio`);
    return buffer;
  } catch (error) {
    console.error('[OpenAI TTS Direct] Error:', error);
    return null;
  }
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
  form.append('file', new Blob([audio]), fileName);

  try {
    const response = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
      method: 'POST',
      signal: AbortSignal.timeout(TTS_REQUEST_TIMEOUT_MS),
      headers: { 'xi-api-key': apiKey },
      body: form,
    });
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[ElevenLabs STT] API error ${response.status}: ${errorText}`);
      return null;
    }
    const data = (await response.json()) as { text?: unknown };
    return typeof data?.text === 'string' ? data.text : null;
  } catch (error) {
    console.error('[ElevenLabs STT] Error:', error);
    return null;
  }
}

/**
 * Generates speech audio, preferring ElevenLabs and falling back to OpenAI.
 */
export async function generateSpeech(text: string): Promise<Buffer | null> {
  const audio = await generateElevenLabsTTS(text);
  if (audio) return audio;
  console.log('[TTS] ElevenLabs unavailable, trying OpenAI TTS...');
  return generateOpenAITTS(text);
}
