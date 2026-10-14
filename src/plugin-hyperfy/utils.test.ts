import { afterEach, describe, expect, it, vi } from 'vitest';
import { countOtherPlayers, resolveUrl, transcribeWithElevenLabs } from './utils';

const world = { assetsUrl: 'https://assets.example.com/' };

describe('resolveUrl', () => {
  it('maps asset:// to the world assets URL', async () => {
    expect(await resolveUrl('asset://abc.glb', world)).toBe('https://assets.example.com/abc.glb');
  });

  it('passes http(s), data and blob URLs through', async () => {
    for (const url of ['https://x.test/a.glb', 'http://x.test/a.glb', 'data:text/plain;base64,aGk=', 'blob:abc']) {
      expect(await resolveUrl(url, world)).toBe(url);
    }
  });

  it('reads module-relative files as data URLs', async () => {
    const result = await resolveUrl('constants.ts', world);
    expect(result).toMatch(/^data:application\/octet-stream;base64,/);
  });

  it('refuses paths that escape the module directory', async () => {
    expect(await resolveUrl('../../package.json', world)).toBeNull();
    expect(await resolveUrl('../../.env', world)).toBeNull();
  });

  it('refuses absolute paths', async () => {
    expect(await resolveUrl('/etc/hosts', world)).toBeNull();
  });

  it('refuses all local paths when allowLocal is false', async () => {
    expect(await resolveUrl('constants.ts', world, { allowLocal: false })).toBeNull();
    expect(await resolveUrl('https://x.test/a.glb', world, { allowLocal: false })).toBe('https://x.test/a.glb');
  });

  it('returns null for non-strings', async () => {
    expect(await resolveUrl(undefined, world)).toBeNull();
  });
});

describe('countOtherPlayers', () => {
  const entity = (id: string, type: string) => [id, { data: { id, type } }] as const;

  it('counts players other than the agent', () => {
    const world = {
      entities: {
        player: { data: { id: 'me' } },
        items: new Map([entity('me', 'player'), entity('p1', 'player'), entity('p2', 'player'), entity('a1', 'app')]),
      },
    };
    expect(countOtherPlayers(world)).toBe(2);
  });

  it('returns 0 without a world', () => {
    expect(countOtherPlayers(null)).toBe(0);
  });
});

describe('transcribeWithElevenLabs', () => {
  const realFetch = globalThis.fetch;
  const realKey = process.env.ELEVENLABS_XI_API_KEY;
  afterEach(() => {
    globalThis.fetch = realFetch;
    process.env.ELEVENLABS_XI_API_KEY = realKey;
  });

  it('posts the audio to the correct speech-to-text URL and returns the text', async () => {
    process.env.ELEVENLABS_XI_API_KEY = 'test-key';
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ text: 'こんにちは' }), { status: 200 }));
    globalThis.fetch = fetchMock as any;

    await expect(transcribeWithElevenLabs(Buffer.from('RIFF'))).resolves.toBe('こんにちは');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.elevenlabs.io/v1/speech-to-text');
    expect(init.headers['xi-api-key']).toBe('test-key');
    expect((init.body as FormData).get('model_id')).toBe('scribe_v2');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('returns null without a key or on an API error, so the caller can fall back', async () => {
    delete process.env.ELEVENLABS_XI_API_KEY;
    await expect(transcribeWithElevenLabs(Buffer.from('x'))).resolves.toBeNull();

    process.env.ELEVENLABS_XI_API_KEY = 'test-key';
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('{"detail":"missing_permissions"}', { status: 401 })) as any;
    await expect(transcribeWithElevenLabs(Buffer.from('x'))).resolves.toBeNull();
  });
});
