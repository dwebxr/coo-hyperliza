import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelType } from '@elizaos/core';

const { transcribeWithElevenLabs, generateElevenLabsTTS } = vi.hoisted(() => ({
  transcribeWithElevenLabs: vi.fn(),
  generateElevenLabsTTS: vi.fn(),
}));
vi.mock('./plugin-hyperfy/utils', () => ({ transcribeWithElevenLabs, generateElevenLabsTTS }));

import { elevenLabsSpeechPlugin, toAudioBuffer } from './elevenlabs-speech';
import { MAX_AUDIO_BYTES, SafeFetchError } from './plugin-hyperfy/lib/net-policy';
import { PUBLIC_ADDRESS, closeServers, startServer, testNet } from './plugin-hyperfy/test-support/net';

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

  it('accepts Uint8Array and { audio } inputs too', async () => {
    transcribeWithElevenLabs.mockResolvedValue('ok');
    await models[ModelType.TRANSCRIPTION](runtime, new Uint8Array([1, 2]));
    await models[ModelType.TRANSCRIPTION](runtime, { audio: new Uint8Array([3]) });
    await models[ModelType.TRANSCRIPTION](runtime, { audio: new Blob([Buffer.from('xyz')]) });
    expect(transcribeWithElevenLabs.mock.calls.map((c) => [...c[0]])).toEqual([[1, 2], [3], [...Buffer.from('xyz')]]);
  });

  it('outranks a text provider that also offers speech (e.g. plugin-openai at 100)', () => {
    expect((elevenLabsSpeechPlugin as any).priority).toBeGreaterThan(100);
  });

  it('downloads audio given as a URL or { audioUrl } from a public https host', async () => {
    const server = await startServer((_request, response) => response.end('audio'), { tls: true });
    const { policy } = testNet({ hosts: { 'cdn.test': PUBLIC_ADDRESS }, routes: { 'cdn.test:443': { port: server.port, direct: true } } });
    try {
      expect((await toAudioBuffer({ audioUrl: 'https://cdn.test/a.mp3' }, policy)).toString()).toBe('audio');
      expect((await toAudioBuffer('https://cdn.test/b.mp3', policy)).toString()).toBe('audio');
      expect(server.hits.map((hit) => hit.url)).toEqual(['/a.mp3', '/b.mp3']);
    } finally {
      await closeServers();
    }
  });

  it('names a failed download without its query, credentials or fragment (the error can reach chat)', async () => {
    const server = await startServer((_request, response) => response.writeHead(403).end(), { tls: true });
    const { policy } = testNet({ hosts: { 'cdn.test': PUBLIC_ADDRESS }, routes: { 'cdn.test:443': { port: server.port, direct: true } } });
    try {
      const error = await toAudioBuffer('https://cdn.test/a.mp3?X-Amz-Signature=sig-value&token=token-value#frag-value', policy).catch((e: Error) => e);
      expect((error as Error).message).toBe('[ElevenLabs] Failed to fetch audio from https://cdn.test/a.mp3?X-Amz-Signature=…&token=…: 403');
    } finally {
      await closeServers();
    }
  });

  it('downloads no audio from a private address, over http, or beyond the audio cap, and transcribes nothing then', async () => {
    const internal = await startServer((_request, response) => response.end('internal'));
    const huge = await startServer((_request, response) => response.writeHead(200, { 'content-length': String(MAX_AUDIO_BYTES + 1) }).end(), { tls: true });
    const { policy } = testNet({ hosts: { 'cdn.test': PUBLIC_ADDRESS }, routes: { 'cdn.test:443': { port: huge.port, direct: true } } });
    try {
      // The model handler itself, with nothing injected: the agent's own port, by address and by name
      for (const audioUrl of [`http://127.0.0.1:${internal.port}/api/agents`, `http://localhost:${internal.port}/api/agents`, 'https://localhost/a.mp3', 'https://169.254.169.254/latest/meta-data/']) {
        const error = await models[ModelType.TRANSCRIPTION](runtime, { audioUrl }).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(SafeFetchError);
        expect((error as SafeFetchError).kind).toBe('refused');
      }
      expect(await toAudioBuffer('https://cdn.test/huge.wav', policy).catch((e: SafeFetchError) => e.kind)).toBe('too-large');
      expect(internal.connections).toBe(0);
      expect(transcribeWithElevenLabs).not.toHaveBeenCalled();
    } finally {
      await closeServers();
    }
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

describe('elevenLabsSpeechPlugin through the real runtime', () => {
  it('serves useModel(TEXT_TO_SPEECH, "text") as Discord calls it, despite core\'s string-param bug', async () => {
    const { AgentRuntime } = await import('@elizaos/core');
    generateElevenLabsTTS.mockResolvedValue(Buffer.from('mp3-bytes'));
    const runtime = new AgentRuntime({ character: { name: 'probe', bio: [], plugins: [] } as any, plugins: [elevenLabsSpeechPlugin] });
    // registers the plugin (running its init), then stops for lack of a database adapter
    await runtime.initialize().catch(() => {});
    // useModel records each call through the database adapter
    (runtime as any).adapter = { log: vi.fn().mockResolvedValue(undefined) };

    const stream = await runtime.useModel(ModelType.TEXT_TO_SPEECH, 'hello Discord' as any);
    expect(generateElevenLabsTTS).toHaveBeenCalledWith('hello Discord');
    expect((await readAll(stream as any)).toString()).toBe('mp3-bytes');
  });
});

describe('core string-param bug the init shim works around', () => {
  it('still breaks useModel(TEXT_TO_SPEECH, "text") without the shim (remove the shim once this fails)', async () => {
    const { AgentRuntime } = await import('@elizaos/core');
    const { init: _shim, ...withoutShim } = elevenLabsSpeechPlugin;
    const runtime = new AgentRuntime({ character: { name: 'probe', bio: [], plugins: [] } as any, plugins: [withoutShim as any] });
    await runtime.initialize().catch(() => {});
    (runtime as any).adapter = { log: vi.fn().mockResolvedValue(undefined) };
    await expect(runtime.useModel(ModelType.TEXT_TO_SPEECH, 'hello' as any)).rejects.toThrow("Cannot use 'in' operator");
  });
});
