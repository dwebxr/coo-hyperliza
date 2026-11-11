import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IAgentRuntime } from '@elizaos/core';
import { Appearance, type AppearanceHost } from './appearance';

type AvatarOutcome = { outcome: 'applied' | 'gave-up' | 'retry'; error?: string };
/** The parts of Appearance the tests below replace or read: applying the avatar is asset-upload's (lib/asset-upload.test.ts) */
type Internals = { applyAvatar(): Promise<AvatarOutcome>; avatarOutcome: AvatarOutcome | null };
const internals = (appearance: Appearance) => appearance as unknown as Internals;

const runtime = (): IAgentRuntime =>
  ({
    agentId: '00000000-0000-0000-0000-0000000000aa',
    character: { name: 'Coo' },
    getEntityById: vi.fn().mockResolvedValue(null),
    updateEntity: vi.fn(),
  }) as unknown as IAgentRuntime;

function connection(world: unknown = { entities: { player: {} }, network: {}, assetsUrl: 'https://world.test/assets' }) {
  const uploadEmotes = vi.fn().mockResolvedValue(true);
  const host = { world, ended: false, emotes: { uploadEmotes } };
  const appearance = new Appearance(runtime(), host as AppearanceHost);
  return { host, appearance, uploadEmotes };
}

describe('the appearance of one connection', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('ignores an avatar result that arrives after its connection ended', async () => {
    const { host, appearance, uploadEmotes } = connection();
    let finish!: (result: AvatarOutcome) => void;
    vi.spyOn(internals(appearance), 'applyAvatar').mockImplementation(() => new Promise((resolve) => (finish = resolve)));

    const pending = appearance.uploadCharacterAssets();
    host.ended = true; // ended (e.g. replaced by a reconnect) while the upload was still running
    finish({ outcome: 'gave-up', error: 'upload requires a connected session' });

    expect(await pending).toMatchObject({ outcome: 'retry' });
    expect(internals(appearance).avatarOutcome).toBeNull();
    expect(uploadEmotes).not.toHaveBeenCalled();
  });

  it('retries only the emotes once the avatar is settled', async () => {
    const { appearance, uploadEmotes } = connection();
    const applyAvatar = vi.spyOn(internals(appearance), 'applyAvatar').mockResolvedValue({ outcome: 'applied' });
    uploadEmotes.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    expect(await appearance.uploadCharacterAssets()).toMatchObject({ outcome: 'retry' });
    expect(await appearance.uploadCharacterAssets()).toEqual({ outcome: 'applied' });
    expect(applyAvatar).toHaveBeenCalledTimes(1);
    expect(uploadEmotes).toHaveBeenCalledTimes(2);
  });

  it('sets the name, and stops polling once the world has refused the avatar for good', async () => {
    for (const method of ['info', 'warn', 'debug'] as const) vi.spyOn(console, method).mockImplementation(() => {});
    const player = { data: { id: 'p1', name: 'Guest' }, modify: vi.fn() };
    const send = vi.fn();
    const { appearance } = connection({ entities: { player }, network: { id: 'n1', send }, assetsUrl: 'https://world.test/assets' });
    const upload = vi.spyOn(appearance, 'uploadCharacterAssets').mockResolvedValue({ outcome: 'gave-up', error: 'builder rank required' });

    appearance.start();
    expect(appearance.polling).toBe(true);
    await vi.waitFor(() => expect(appearance.settled).toBe(true));
    expect(upload).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('entityModified', { id: 'p1', name: 'Coo' });
    expect(player.data.name).toBe('Coo');
    // Settled: the next tick only stops the timer
    vi.useFakeTimers();
    appearance.stop();
    expect(appearance.polling).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps polling on its timer while the world is not ready, and neither polls nor sends anything once its connection ended', async () => {
    vi.useFakeTimers();
    for (const method of ['info', 'warn', 'debug'] as const) vi.spyOn(console, method).mockImplementation(() => {});
    const player = { data: { id: 'p1', name: 'Guest' }, modify: vi.fn() };
    const send = vi.fn();
    // No network id yet: the snapshot has not arrived
    const world = { entities: { player }, network: { id: null as string | null, send }, assetsUrl: null };
    const { host, appearance } = connection(world);
    appearance.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(send).not.toHaveBeenCalled();
    expect(appearance.polling).toBe(true);

    host.ended = true;
    world.network.id = 'n1';
    await vi.advanceTimersByTimeAsync(30_000);
    expect(send).not.toHaveBeenCalled();
    expect(appearance.polling).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(() => appearance.changeName('Coo')).toThrow('Cannot change name');
  });
});
