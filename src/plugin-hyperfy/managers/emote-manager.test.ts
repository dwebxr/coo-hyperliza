import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../service.js', () => ({ HyperfyService: { serviceType: 'hyperfy' } }));
const { access, readFile } = vi.hoisted(() => ({ access: vi.fn(), readFile: vi.fn() }));
vi.mock('fs/promises', async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, default: { ...actual, access, readFile } };
});

import { logger } from '@elizaos/core';
import { Emotes } from '../hyperfy/src/core/extras/playerEmotes.js';
import { AssetUploadError } from '../lib/asset-upload';
import { EmoteManager } from './emote-manager';

const DEFAULT_TALK = 'asset://emote-talk.glb';
const HASHED = /^asset:\/\/[0-9a-f]{64}\.glb$/;
const HASH_FILE = /^[0-9a-f]{64}\.glb$/;
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
    let uploaded = false;
    const fetchSpy = serveAssets((file) => uploaded && HASH_FILE.test(file));
    const { manager, upload } = newManager(vi.fn(async () => { uploaded = true; }));
    await (manager as any).ensureTalkEmote();
    expect(upload).toHaveBeenCalledTimes(1);
    expect((Emotes as any).TALK).toMatch(HASHED);
    expect(String(fetchSpy.mock.calls[0][0])).toMatch(/^https:\/\/world\.test\/assets\/[0-9a-f]{64}\.glb$/);
    expect(onlyHeadRequests(fetchSpy)).toBe(true);
  });

  it('uses a clip the world already serves without uploading it', async () => {
    access.mockResolvedValue(undefined);
    serveAssets((file) => HASH_FILE.test(file));
    const { manager, upload } = newManager();
    await (manager as any).ensureTalkEmote();
    expect(upload).not.toHaveBeenCalled();
    expect((Emotes as any).TALK).toMatch(HASHED);
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

  it('stops uploading once the world refuses, and keeps the defaults', async () => {
    access.mockRejectedValue(new Error('ENOENT'));
    serveAssets((file) => file === 'emote-talk.glb');
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const upload = vi.fn().mockRejectedValue(new AssetUploadError('Upload failed (HTTP 403): builder rank required', 403));
    const { manager } = newManager(upload);
    expect(await manager.uploadEmotes()).toBe(true); // nothing worth retrying
    expect(upload).toHaveBeenCalledTimes(1);
    const refusals = consoleWarn.mock.calls.filter(([msg]) => String(msg).includes('refused'));
    expect(refusals).toHaveLength(1);
    expect((Emotes as any).WALK).toBe(original.WALK);
    expect((manager as any).emoteHashMap.size).toBe(0);
  });

  it('only maps custom emotes the world serves', async () => {
    access.mockRejectedValue(new Error('ENOENT'));
    serveAssets((file) => file === 'emote-talk.glb'); // uploads "succeed", hashes stay 404
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { manager, upload } = newManager();
    expect(await manager.uploadEmotes()).toBe(false); // may still appear: try again later
    expect(upload).toHaveBeenCalled();
    expect((manager as any).emoteHashMap.size).toBe(0);
  });

  it('retries clips that failed for a passing reason, keeping the ones already settled', async () => {
    access.mockRejectedValue(new Error('ENOENT'));
    let uploaded = false;
    serveAssets((file) => file === 'emote-talk.glb' || (uploaded && HASH_FILE.test(file)));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const upload = vi
      .fn()
      .mockRejectedValueOnce(new AssetUploadError('Upload failed (HTTP 503): Service Unavailable', 503))
      .mockImplementation(async () => {
        uploaded = true;
      });
    const { manager } = newManager(upload);

    expect(await manager.uploadEmotes()).toBe(false);
    expect((Emotes as any).WALK).toBe(original.WALK);

    expect(await manager.uploadEmotes()).toBe(true);
    expect((Emotes as any).WALK).toMatch(HASHED);
    expect((manager as any).emoteHashMap.size).toBeGreaterThan(0);

    const calls = upload.mock.calls.length;
    expect(await manager.uploadEmotes()).toBe(true); // everything settled: nothing redone
    expect(upload.mock.calls.length).toBe(calls);
  });

  it('leaves the shared emotes alone when the world is replaced mid-way', async () => {
    access.mockRejectedValue(new Error('ENOENT'));
    serveAssets(() => true);
    vi.spyOn(console, 'info').mockImplementation(() => {});
    let world: any = { assetsUrl: 'https://world.test/assets/', network: { upload: vi.fn() } };
    const manager = new EmoteManager({ getService: () => ({ getWorld: () => world }) } as any);
    readFile.mockImplementation(async () => {
      world = { ...world }; // a reconnect happens while the first clip is read
      return Buffer.from('custom-talk-clip');
    });
    expect(await manager.uploadEmotes()).toBe(false);
    expect((Emotes as any).WALK).toBe(original.WALK);
  });

  it('gives up on clips that keep failing after a few rounds', async () => {
    access.mockRejectedValue(new Error('ENOENT'));
    serveAssets((file) => file === 'emote-talk.glb'); // uploads "succeed", hashes stay 404
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const { manager, upload } = newManager();

    const rounds: boolean[] = [];
    for (let i = 0; i < 5; i++) rounds.push(await manager.uploadEmotes());
    expect(rounds).toEqual([false, false, false, false, true]);
    expect(consoleWarn.mock.calls.some(([msg]) => String(msg).includes('giving up'))).toBe(true);
    expect((Emotes as any).WALK).toBe(original.WALK);

    const calls = upload.mock.calls.length;
    expect(await manager.uploadEmotes()).toBe(true);
    expect(upload.mock.calls.length).toBe(calls);
  });

  describe("without the agent's own locomotion clips", () => {
    const refused = () => vi.fn().mockRejectedValue(new AssetUploadError('Upload failed (HTTP 403): builder rank required', 403));

    beforeEach(() => {
      access.mockRejectedValue(new Error('ENOENT'));
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(console, 'info').mockImplementation(() => {});
    });

    it("uses the world's own clips when it does not serve the engine defaults", async () => {
      // coo-world: mp-* locomotion, emote-float/fall/flip/talk, no emote-idle/walk/run
      const fetchSpy = serveAssets((file) => /^mp-(idle|walk|jog)\.glb$/.test(file) || /^emote-(float|fall|flip|talk)\.glb$/.test(file));
      await (newManager(refused()).manager as any).uploadLocomotionEmotes();
      expect((Emotes as any).IDLE).toBe('asset://mp-idle.glb');
      expect((Emotes as any).WALK).toBe('asset://mp-walk.glb?s=2');
      expect((Emotes as any).RUN).toBe('asset://mp-jog.glb?s=1.87');
      expect((Emotes as any).FLOAT).toBe(original.FLOAT);
      // looked up without the speed query
      expect(fetchSpy.mock.calls.map(([url]) => String(url))).toContain('https://world.test/assets/mp-walk.glb');
    });

    it('keeps the engine defaults where the world serves them', async () => {
      serveAssets((file) => file.startsWith('emote-') || file.startsWith('mp-'));
      await (newManager(refused()).manager as any).uploadLocomotionEmotes();
      expect((Emotes as any).WALK).toBe(original.WALK);
      expect((Emotes as any).IDLE).toBe(original.IDLE);
    });

    /** HEAD answers by file name: a status, or 'down' for a network failure. */
    function answer(byFile: (file: string) => number | 'down') {
      return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => {
        const status = byFile(String(url).split('/').pop()!);
        if (status === 'down') throw new Error('network down');
        return new Response(null, { status });
      });
    }
    const COO_WORLD = (file: string) => (/^mp-(idle|walk|jog)\.glb$/.test(file) || /^emote-(float|fall|flip|talk)\.glb$/.test(file) ? 200 : 404);

    it('checks the fallback again after a lookup failed', async () => {
      let outage = true;
      answer((file) => (outage && file.startsWith('emote-walk') ? 503 : COO_WORLD(file)));
      const { manager } = newManager(refused());

      expect(await (manager as any).uploadLocomotionEmotes()).toBe(false);
      expect((Emotes as any).WALK).toBe(original.WALK);

      outage = false;
      expect(await (manager as any).uploadLocomotionEmotes()).toBe(true);
      expect((Emotes as any).WALK).toBe('asset://mp-walk.glb?s=2');
    });

    it("replaces the world's clip with the agent's own once that becomes available", async () => {
      let uploaded = false;
      answer((file) => (uploaded && HASH_FILE.test(file) ? 200 : COO_WORLD(file)));
      const upload = vi
        .fn()
        // WALK is the first locomotion clip, so it is the one that hits the outage
        .mockRejectedValueOnce(new AssetUploadError('Upload failed (HTTP 503): Service Unavailable', 503))
        .mockImplementation(async () => {
          uploaded = true;
        });
      const { manager } = newManager(upload);

      expect(await (manager as any).uploadLocomotionEmotes()).toBe(false);
      expect((Emotes as any).WALK).toBe('asset://mp-walk.glb?s=2'); // in use meanwhile
      expect(await (manager as any).uploadLocomotionEmotes()).toBe(true);
      expect((Emotes as any).WALK).toMatch(HASHED);
    });

    it('does not switch a newer connection to a fallback found for the old one', async () => {
      let world: any = { assetsUrl: 'https://world.test/assets/', network: { upload: refused() } };
      const manager = new EmoteManager({ getService: () => ({ getWorld: () => world }) } as any);
      answer((file) => {
        if (file === 'mp-walk.glb') world = { ...world }; // reconnect while the fallback is looked up
        return COO_WORLD(file);
      });
      await (manager as any).uploadLocomotionEmotes(world);
      expect((Emotes as any).WALK).toBe(original.WALK);
    });

    it('keeps the default when the world has neither', async () => {
      serveAssets(() => false);
      await (newManager(refused()).manager as any).uploadLocomotionEmotes();
      expect((Emotes as any).WALK).toBe(original.WALK);
    });
  });
});
