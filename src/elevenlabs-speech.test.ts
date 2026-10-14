import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelType } from '@elizaos/core';

const { transcribeWithElevenLabs, generateElevenLabsTTS } = vi.hoisted(() => ({
  transcribeWithElevenLabs: vi.fn(),
  generateElevenLabsTTS: vi.fn(),
}));
vi.mock('./plugin-hyperfy/utils', () => ({ transcribeWithElevenLabs, generateElevenLabsTTS }));

import { elevenLabsSpeechPlugin } from './elevenlabs-speech';

const models = elevenLabsSpeechPlugin.models as Record<string, (rt: any, input: any) => Promise<any>>;
const runtime: any = {};

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe('elevenLabsSpeechPlugin', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    transcribeWithElevenLabs.mockReset();
    generateElevenLabsTTS.mockReset();
  });

  it('transcribes a WAV buffer (what Discord voice passes)', async () => {
    transcribeWithElevenLabs.mockResolvedValue('こんにちは');
    const wav = Buffer.from('RIFF....');
    await expect(models[ModelType.TRANSCRIPTION](runtime, wav)).resolves.toBe('こんにちは');
    expect(transcribeWithElevenLabs).toHaveBeenCalledWith(wav);
  });

  it('fetches audio given as a URL or { audioUrl }', async () => {
    transcribeWithElevenLabs.mockResolvedValue('hi');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(Buffer.from('audio')));
    await models[ModelType.TRANSCRIPTION](runtime, { audioUrl: 'https://x.test/a.mp3' });
    expect(fetchSpy).toHaveBeenCalledWith('https://x.test/a.mp3');
    expect(transcribeWithElevenLabs.mock.calls[0][0].toString()).toBe('audio');
  });

  it('throws when transcription fails instead of returning null', async () => {
    transcribeWithElevenLabs.mockResolvedValue(null);
    await expect(models[ModelType.TRANSCRIPTION](runtime, Buffer.from('x'))).rejects.toThrow('Transcription failed');
  });

  it('returns speech as a readable stream (Discord passes it to createAudioResource)', async () => {
    generateElevenLabsTTS.mockResolvedValue(Buffer.from('mp3-bytes'));
    const stream = await models[ModelType.TEXT_TO_SPEECH](runtime, 'こんにちは');
    expect(stream).toBeInstanceOf(Readable);
    expect((await readAll(stream)).toString()).toBe('mp3-bytes');

    await models[ModelType.TEXT_TO_SPEECH](runtime, { text: 'hello' });
    expect(generateElevenLabsTTS).toHaveBeenLastCalledWith('hello');
  });

  it('throws when synthesis fails or there is no text', async () => {
    generateElevenLabsTTS.mockResolvedValue(null);
    await expect(models[ModelType.TEXT_TO_SPEECH](runtime, 'hi')).rejects.toThrow('synthesis failed');
    await expect(models[ModelType.TEXT_TO_SPEECH](runtime, '  ')).rejects.toThrow('needs text');
  });
});
