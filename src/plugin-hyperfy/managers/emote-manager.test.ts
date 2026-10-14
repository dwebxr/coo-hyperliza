import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../service.js', () => ({ HyperfyService: { serviceType: 'hyperfy' } }));
const { access, readFile } = vi.hoisted(() => ({ access: vi.fn(), readFile: vi.fn() }));
vi.mock('fs/promises', async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, default: { ...actual, access, readFile } };
});

import { logger } from '@elizaos/core';
import { Emotes } from '../hyperfy/src/core/extras/playerEmotes.js';
import { EmoteManager } from './emote-manager';

const DEFAULT_TALK = 'asset://emote-talk.glb';
const HASHED = /^asset:\/\/[0-9a-f]{64}\.glb$/;
const original = { ...(Emotes as Record<string, string>) };

/** HEAD responses by file name; anything not listed is 404. */
function serveAssets(available: (file: string) => boolean) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => {
    const file = String(url).split('/').pop()!;
    return new Response(null, { status: available(file) ? 200 : 404 });
  });
}

const onlyHeadRequests = (fetchSpy: ReturnType<typeof serveAssets>) =>
  fetchSpy.mock.calls.every(([, init]) => (init as RequestInit | undefined)?.method === 'HEAD');

function newManager(upload = vi.fn().mockResolvedValue(undefined)) {
  const world = { assetsUrl: 'https://world.test/assets/', network: { upload } };
  return { manager: new EmoteManager({ getService: () => ({ getWorld: () => world }) } as any), upload };
}

describe('EmoteManager talking gesture', () => {
  beforeEach(() => {
    readFile.mockResolvedValue(Buffer.from('custom-talk-clip'));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    access.mockReset();
    Object.assign(Emotes as Record<string, string>, original);
  });

  it('uploads a bundled custom clip and uses it for TALK once the upload is verified', async () => {
    access.mockResolvedValue(undefined);
    const fetchSpy = serveAssets((file) => /^[0-9a-f]{64}\.glb$/.test(file));
    const { manager, upload } = newManager();
    await (manager as any).ensureTalkEmote();
    expect(upload).toHaveBeenCalledTimes(1);
    expect((Emotes as any).TALK).toMatch(HASHED);
    expect(String(fetchSpy.mock.calls[0][0])).toMatch(/^https:\/\/world\.test\/assets\/[0-9a-f]{64}\.glb$/);
    expect(onlyHeadRequests(fetchSpy)).toBe(true);
  });

  it("keeps the world's clip when a custom upload resolves but the asset never appears", async () => {
    access.mockResolvedValue(undefined);
    serveAssets((file) => file === 'emote-talk.glb'); // upload "succeeded", hash is 404
    const warn = vi.spyOn(logger, 'warn');
    const { manager } = newManager();
    await (manager as any).ensureTalkEmote();
    expect((Emotes as any).TALK).toBe(DEFAULT_TALK);
    expect(warn).not.toHaveBeenCalled();
  });

  it("keeps the world's own clip when there is no bundled one", async () => {
    access.mockRejectedValue(new Error('ENOENT'));
    const fetchSpy = serveAssets((file) => file === 'emote-talk.glb');
    const warn = vi.spyOn(logger, 'warn');
    const { manager, upload } = newManager();
    await (manager as any).ensureTalkEmote();
    expect(String(fetchSpy.mock.calls[0][0])).toBe('https://world.test/assets/emote-talk.glb');
    expect(upload).not.toHaveBeenCalled();
    expect((Emotes as any).TALK).toBe(DEFAULT_TALK);
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns when neither a bundled clip nor the world provides one', async () => {
    access.mockRejectedValue(new Error('ENOENT'));
    serveAssets(() => false);
    const warn = vi.spyOn(logger, 'warn');
    const { manager, upload } = newManager();
    await (manager as any).ensureTalkEmote();
    expect(upload).not.toHaveBeenCalled();
    expect(warn.mock.calls[0][0]).toContain('emote-talk.glb');
  });

  it("does not claim the world lacks the clip when it simply couldn't be checked", async () => {
    access.mockRejectedValue(new Error('ENOENT'));
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));
    const warn = vi.spyOn(logger, 'warn');
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { manager } = newManager();
    await (manager as any).ensureTalkEmote();
    expect(warn).not.toHaveBeenCalled();
    expect(String(consoleWarn.mock.calls[0][0])).toContain('Could not check');
    expect((Emotes as any).TALK).toBe(DEFAULT_TALK);
  });

  it('does not carry an override from a previous world into the next one', async () => {
    serveAssets(() => true);
    access.mockResolvedValue(undefined);
    await (newManager().manager as any).uploadLocomotionEmotes(); // world A, custom clip present
    expect((Emotes as any).TALK).toMatch(HASHED);

    access.mockRejectedValue(new Error('ENOENT'));
    await (newManager().manager as any).uploadLocomotionEmotes(); // world B, clip removed
    expect((Emotes as any).TALK).toBe(DEFAULT_TALK);
  });

  it('never points a locomotion emote at an upload that could not be verified', async () => {
    access.mockRejectedValue(new Error('ENOENT'));
    serveAssets((file) => file === 'emote-talk.glb'); // every uploaded hash is 404
    await (newManager().manager as any).uploadLocomotionEmotes();
    expect((Emotes as any).WALK).toBe(original.WALK);
    expect((Emotes as any).RUN).toBe(original.RUN);
  });
});
