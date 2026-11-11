import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IAgentRuntime } from '@elizaos/core';
import { APPEARANCE_POLL_INTERVAL_MS, Appearance, type AppearanceHost } from './appearance';

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

  it('sets the name, and stops polling on the tick after the world has refused the avatar for good', async () => {
    vi.useFakeTimers();
    for (const method of ['info', 'warn', 'debug'] as const) vi.spyOn(console, method).mockImplementation(() => {});
    const player = { data: { id: 'p1', name: 'Guest' }, modify: vi.fn() };
    const send = vi.fn();
    const { appearance } = connection({ entities: { player }, network: { id: 'n1', send }, assetsUrl: 'https://world.test/assets' });
    const upload = vi.spyOn(appearance, 'uploadCharacterAssets').mockResolvedValue({ outcome: 'gave-up', error: 'builder rank required' });

    appearance.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(appearance.settled).toBe(true);
    expect(send.mock.calls).toEqual([['entityModified', { id: 'p1', name: 'Coo' }]]);
    expect(player.data.name).toBe('Coo');
    // Settled by the first poll; its timer runs until the next tick finds nothing left to do
    expect(appearance.polling).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(APPEARANCE_POLL_INTERVAL_MS);
    expect(appearance.polling).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    // That tick neither uploaded nor sent anything again
    expect(upload).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("records the player on the agent's entity, and writes and sends nothing once the connection ended while that entity was looked up", async () => {
    for (const method of ['info', 'warn', 'debug', 'error'] as const) vi.spyOn(console, method).mockImplementation(() => {});
    const polled = async (endedMeanwhile: boolean) => {
      const player = { data: { id: 'p1', name: 'Guest' }, modify: vi.fn() };
      const send = vi.fn();
      const host = { world: { entities: { player }, network: { id: 'n1', send }, assetsUrl: 'https://world.test/assets' }, ended: false, emotes: { uploadEmotes: vi.fn().mockResolvedValue(true) } };
      const updateEntity = vi.fn();
      const agent = {
        agentId: '00000000-0000-0000-0000-0000000000aa',
        character: { name: 'Coo' },
        getEntityById: vi.fn(async () => {
          host.ended = endedMeanwhile;
          return { metadata: {} };
        }),
        updateEntity,
      } as unknown as IAgentRuntime;
      const appearance = new Appearance(agent, host as AppearanceHost);
      const upload = vi.spyOn(appearance, 'uploadCharacterAssets').mockResolvedValue({ outcome: 'applied' });
      await (appearance as unknown as { poll(): Promise<void> }).poll();
      return { updateEntity, send, upload, name: player.data.name };
    };

    const live = await polled(false);
    expect(live.updateEntity.mock.calls).toEqual([[{ metadata: { hyperfy: { id: 'p1', name: 'Guest', userName: 'Guest' } } }]]);
    expect(live.send).toHaveBeenCalledWith('entityModified', { id: 'p1', name: 'Coo' });
    expect(live.upload).toHaveBeenCalledTimes(1);

    const ended = await polled(true);
    expect(ended.updateEntity).not.toHaveBeenCalled();
    expect(ended.send).not.toHaveBeenCalled();
    expect(ended.upload).not.toHaveBeenCalled();
    expect(ended.name).toBe('Guest');
  });

  it('starts no second upload on a later tick while the avatar upload of an earlier one is still running', async () => {
    vi.useFakeTimers();
    for (const method of ['info', 'warn', 'debug'] as const) vi.spyOn(console, method).mockImplementation(() => {});
    const player = { data: { id: 'p1', name: 'Guest' }, modify: vi.fn() };
    const { appearance } = connection({ entities: { player }, network: { id: 'n1', send: vi.fn() }, assetsUrl: 'https://world.test/assets' });
    let finish!: (result: AvatarOutcome) => void;
    const upload = vi.spyOn(appearance, 'uploadCharacterAssets').mockImplementation(() => new Promise((resolve) => (finish = resolve)));

    appearance.start();
    await vi.advanceTimersByTimeAsync(3 * APPEARANCE_POLL_INTERVAL_MS);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(appearance.settled).toBe(false);
    // Not done: the tick after it has answered tries again
    finish({ outcome: 'retry', error: 'the world is busy' });
    await vi.advanceTimersByTimeAsync(APPEARANCE_POLL_INTERVAL_MS);
    expect(upload).toHaveBeenCalledTimes(2);
    appearance.stop();
  });

  it('keeps polling on its timer while the world is not ready: a later tick sets the name once the world is', async () => {
    vi.useFakeTimers();
    for (const method of ['info', 'warn', 'debug'] as const) vi.spyOn(console, method).mockImplementation(() => {});
    const player = { data: { id: 'p1', name: 'Guest' }, modify: vi.fn() };
    const send = vi.fn();
    // No network id yet: the snapshot has not arrived
    const world = { entities: { player }, network: { id: null as string | null, send }, assetsUrl: null };
    const { appearance } = connection(world);
    appearance.start();
    await vi.advanceTimersByTimeAsync(APPEARANCE_POLL_INTERVAL_MS);
    expect(send).not.toHaveBeenCalled();
    expect(appearance.polling).toBe(true);

    world.network.id = 'n1';
    await vi.advanceTimersByTimeAsync(APPEARANCE_POLL_INTERVAL_MS - 1);
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(send.mock.calls).toEqual([['entityModified', { id: 'p1', name: 'Coo' }]]);
    appearance.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops its timer and sends nothing on the first tick after its connection ended, although the world is ready by then', async () => {
    vi.useFakeTimers();
    for (const method of ['info', 'warn', 'debug'] as const) vi.spyOn(console, method).mockImplementation(() => {});
    const player = { data: { id: 'p1', name: 'Guest' }, modify: vi.fn() };
    const send = vi.fn();
    const world = { entities: { player }, network: { id: null as string | null, send }, assetsUrl: null };
    const { host, appearance } = connection(world);
    appearance.start();
    await vi.advanceTimersByTimeAsync(APPEARANCE_POLL_INTERVAL_MS);
    expect(appearance.polling).toBe(true);

    // Ready, as in the test above, but ended
    host.ended = true;
    world.network.id = 'n1';
    await vi.advanceTimersByTimeAsync(APPEARANCE_POLL_INTERVAL_MS);
    expect(send).not.toHaveBeenCalled();
    expect(player.data.name).toBe('Guest');
    expect(appearance.polling).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(() => appearance.changeName('Coo')).toThrow('Cannot change name');
    // A start() on the ended connection starts no timer
    appearance.start();
    expect(appearance.polling).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
