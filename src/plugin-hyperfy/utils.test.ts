import { describe, expect, it } from 'vitest';
import { countOtherPlayers, resolveUrl } from './utils';

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
