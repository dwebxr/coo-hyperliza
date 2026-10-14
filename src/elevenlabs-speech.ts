import { Readable } from 'node:stream';
import { type IAgentRuntime, type Plugin, ModelType } from '@elizaos/core';
import { generateElevenLabsTTS, transcribeWithElevenLabs } from './plugin-hyperfy/utils';

/**
 * ElevenLabs speech for other plugins (e.g. Discord voice), which go through runtime models.
 * Hyperfy voice calls the same helpers directly. Replaces @elizaos/plugin-elevenlabs, whose
 * TRANSCRIPTION handler requests .../v1/v1/speech-to-text (404).
 */

async function toAudioBuffer(input: unknown): Promise<Buffer> {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) return Buffer.from(input);
  const audio = (input as { audio?: unknown } | null)?.audio;
  if (audio instanceof Uint8Array) return Buffer.from(audio);
  if (audio instanceof Blob) return Buffer.from(await audio.arrayBuffer());
  const url = typeof input === 'string' ? input : (input as { audioUrl?: string } | null)?.audioUrl;
  if (url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`[ElevenLabs] Failed to fetch audio from ${url}: ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }
  throw new Error('[ElevenLabs] TRANSCRIPTION expects audio bytes, an audio URL, { audio } or { audioUrl }');
}

async function transcribe(_runtime: IAgentRuntime, input: unknown): Promise<string> {
  const text = await transcribeWithElevenLabs(await toAudioBuffer(input));
  if (text === null) throw new Error('[ElevenLabs] Transcription failed');
  return text;
}

/** Returns a stream, like the plugin this replaces (Discord hands it to createAudioResource). */
async function textToSpeech(_runtime: IAgentRuntime, input: string | { text: string }): Promise<Readable> {
  const text = typeof input === 'string' ? input : input?.text;
  if (!text?.trim()) throw new Error('[ElevenLabs] TEXT_TO_SPEECH needs text');
  const audio = await generateElevenLabsTTS(text);
  if (!audio) throw new Error('[ElevenLabs] Speech synthesis failed');
  return Readable.from(audio);
}

const STRING_TTS_PATCHED = Symbol.for('coo.stringTtsParams');

/**
 * Core 1.7.2's useModel evaluates `"prompt" in params`, which throws a TypeError for a string,
 * and Discord calls useModel(TEXT_TO_SPEECH, text). Box that string so the call reaches a handler.
 */
function acceptStringSpeechParams(runtime: IAgentRuntime): void {
  const patched = runtime as IAgentRuntime & { [STRING_TTS_PATCHED]?: boolean };
  if (patched[STRING_TTS_PATCHED]) return;
  const useModel = runtime.useModel.bind(runtime);
  runtime.useModel = ((modelType: any, params: any, ...rest: any[]) =>
    useModel(
      modelType,
      modelType === ModelType.TEXT_TO_SPEECH && typeof params === 'string' ? { text: params } : params,
      ...rest
    )) as typeof runtime.useModel;
  patched[STRING_TTS_PATCHED] = true;
}

export const elevenLabsSpeechPlugin: Plugin = {
  name: 'elevenlabs-speech',
  description: 'ElevenLabs speech-to-text and text-to-speech as runtime models',
  init: async (_config, runtime) => acceptStringSpeechParams(runtime),
  // Above the chosen text provider's 100, so ElevenLabs wins speech even when plugin-openai writes text
  priority: 200,
  models: {
    [ModelType.TRANSCRIPTION]: (runtime: IAgentRuntime, input: unknown) => transcribe(runtime, input),
    // Core types this as returning a Buffer, but consumers expect a stream: @elizaos/plugin-elevenlabs
    // returned one and Discord's createAudioResource only accepts Readable | string.
    [ModelType.TEXT_TO_SPEECH]: ((runtime: IAgentRuntime, input: string | { text: string }) => textToSpeech(runtime, input)) as any,
  },
};
