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

describe('EmoteManager talking gesture', () => {
  const upload = vi.fn().mockResolvedValue(undefined);
  const originalTalk = (Emotes as any).TALK;
  let manager: EmoteManager;

  beforeEach(() => {
    const world = { assetsUrl: 'https://world.test/assets/', network: { upload } };
    manager = new EmoteManager({ getService: () => ({ getWorld: () => world }) } as any);
    readFile.mockResolvedValue(Buffer.from('custom-talk-clip'));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    access.mockReset();
    upload.mockClear();
    (Emotes as any).TALK = originalTalk;
  });

  const ensureTalkEmote = () => (manager as any).ensureTalkEmote();

  it('uploads a bundled custom clip and uses it for TALK', async () => {
    access.mockResolvedValue(undefined);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await ensureTalkEmote();
    expect(upload).toHaveBeenCalledTimes(1);
    expect((Emotes as any).TALK).toMatch(/^asset:\/\/[0-9a-f]{64}\.glb$/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps the world's own clip when there is no bundled one", async () => {
    access.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));
    const warn = vi.spyOn(logger, 'warn');
    await ensureTalkEmote();
    expect(fetchSpy.mock.calls[0][0]).toBe('https://world.test/assets/emote-talk.glb');
    expect(upload).not.toHaveBeenCalled();
    expect((Emotes as any).TALK).toBe(originalTalk);
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns when neither a bundled clip nor the world provides one', async () => {
    access.mockRejectedValue(new Error('ENOENT'));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 404 }));
    const warn = vi.spyOn(logger, 'warn');
    await ensureTalkEmote();
    expect(upload).not.toHaveBeenCalled();
    expect(warn.mock.calls[0][0]).toContain('emote-talk.glb');
  });
});
