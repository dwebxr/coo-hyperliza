import { afterEach, describe, expect, it, vi } from 'vitest';

// Chromium is not needed to exercise the connection lifecycle.
vi.mock('./managers/puppeteer-manager', () => {
  class FakePuppeteerManager {
    static instance: FakePuppeteerManager | null = null;
    static getOrCreate() {
      return (this.instance ??= new FakePuppeteerManager());
    }
    static getInstance() {
      return this.getOrCreate();
    }
    resetPage = vi.fn(async () => {});
    async close() {
      FakePuppeteerManager.instance = null;
    }
    async registerTexture() {
      return undefined;
    }
    async loadEnvironmentHDR() {}
    async loadGlbBytes() {
      return [];
    }
    async loadVRMBytes() {
      return [];
    }
  }
  return { PuppeteerManager: FakePuppeteerManager };
});

import { HyperfyService, findQueuedKick } from './service';
import { RECONNECT_MAX_DELAY_MS } from './lib/reconnect';

// Nothing listens here, so the socket closes during or right after init.
const UNREACHABLE = { wsUrl: 'ws://127.0.0.1:9/ws', worldId: '00000000-0000-0000-0000-000000000001' as any };

// connect() rejects when the socket closes mid-init; either way the disconnect path runs.
const connectIgnoringClose = (service: HyperfyService) => service.connect(UNREACHABLE).catch(() => {});

function createRuntime() {
  const runtime: any = {
    agentId: '00000000-0000-0000-0000-0000000000aa',
    character: { name: 'Coo', templates: {} },
    emitEvent: vi.fn().mockResolvedValue(undefined),
    getEntityById: vi.fn().mockResolvedValue(null),
    updateEntity: vi.fn(),
    getModel: vi.fn(),
  };
  const service = new HyperfyService(runtime);
  runtime.getService = () => service;
  return { runtime, service };
}

describe('HyperfyService connection lifecycle (offline)', () => {
  let service: HyperfyService | null = null;

  afterEach(async () => {
    await service?.stop();
    service = null;
  });

  it('tears down and schedules a backoff reconnect when the socket closes', async () => {
    ({ service } = createRuntime());
    const controller = (service as any).reconnectController;

    await connectIgnoringClose(service);
    await vi.waitFor(() => expect(controller.isPending).toBe(true), { timeout: 15_000, interval: 50 });

    expect(service.isConnected()).toBe(false);
    expect(service.getWorld()).toBeNull();
    // the next session gets a fresh page (no stale textures)
    expect(service.getPuppeteerManager().resetPage).toHaveBeenCalled();
    // the player never spawned, so the backoff keeps growing
    expect(controller.attemptCount).toBe(1);
  });

  it('can build a fresh world in the same process after a disconnect', async () => {
    const { service: svc, runtime } = createRuntime();
    service = svc;
    const controller = (service as any).reconnectController;
    controller.stop();

    for (let i = 0; i < 2; i++) {
      await connectIgnoringClose(service);
      await vi.waitFor(() => expect(service!.getWorld()).toBeNull(), { timeout: 15_000, interval: 50 });
    }
    const worldLeft = runtime.emitEvent.mock.calls.filter(([event]: any[]) => event === 'WORLD_LEFT');
    expect(worldLeft).toHaveLength(2);
  });

  it('stop() cancels a pending reconnect', async () => {
    ({ service } = createRuntime());
    const controller = (service as any).reconnectController;

    await connectIgnoringClose(service);
    await vi.waitFor(() => expect(controller.isPending).toBe(true), { timeout: 15_000, interval: 50 });
    await service.stop();

    expect(controller.isPending).toBe(false);
    expect(controller.schedule()).toBeNull();
  });
});

describe('HyperfyService kick policy', () => {
  // A kick that arrived right before the close is still in the unflushed network queue.
  async function disconnectWithQueuedKick(code: string) {
    const { service } = createRuntime();
    const world = { network: { queue: [['onKick', code]] }, livekit: null, destroy: vi.fn() };
    (service as any).world = world;
    (service as any).lastConnectConfig = UNREACHABLE;
    await (service as any).onWorldDisconnect(world, { code: 1000 }, null);
    return { service, controller: (service as any).reconnectController };
  }

  it.each(['duplicate_user', 'player_limit'])('keeps retrying, at the maximum delay, after a %s kick', async (code) => {
    const { service, controller } = await disconnectWithQueuedKick(code);
    expect(controller.isStopped).toBe(false);
    expect(controller.isPending).toBe(true);
    controller.cancelPending();
    // the deferral was consumed by the retry onWorldDisconnect scheduled
    expect(controller.schedule()).not.toBe(RECONNECT_MAX_DELAY_MS);
    await service.stop();
  });

  it.each(['duplicate_user', 'player_limit'])('applies the %s delay even when another path schedules first', async (code) => {
    const { service } = createRuntime();
    const controller = (service as any).reconnectController;
    const world = { network: { queue: [['onKick', code]] }, livekit: null, destroy: vi.fn() };
    (service as any).world = world;
    (service as any).lastConnectConfig = UNREACHABLE;

    const handling = (service as any).onWorldDisconnect(world, { code: 1000 }, null);
    // e.g. a failed connect() racing with the disconnect handler
    expect(controller.schedule()).toBe(RECONNECT_MAX_DELAY_MS);
    await handling;
    await service.stop();
  });
});

describe('findQueuedKick', () => {
  it('finds a kick that arrived but was not yet flushed by a tick', () => {
    const world = { network: { queue: [['onSnapshot', {}], ['onKick', 'duplicate_user']] } };
    expect(findQueuedKick(world)).toBe('duplicate_user');
  });

  it('returns null when no kick is queued', () => {
    expect(findQueuedKick({ network: { queue: [['onChatAdded', {}]] } })).toBeNull();
    expect(findQueuedKick(null)).toBeNull();
  });
});

describe('HyperfyService chat handling', () => {
  it('handles messages one at a time, in order, each exactly once even when Coo\'s reply re-runs the listener', async () => {
    const { service } = createRuntime();
    let listener!: (msgs: any[]) => void;
    const world = {
      chat: { msgs: [] as any[], subscribe: (fn: any) => (listener = fn) },
      entities: { player: { data: { id: 'coo' } } },
    };
    const s = service as any;
    s.world = world;
    s.connectionTime = Date.now() - 1000;
    const at = new Date().toISOString();
    const m1 = { id: 'm1', fromId: 'p1', body: 'one', createdAt: at };
    const m2 = { id: 'm2', fromId: 'p2', body: 'two', createdAt: at };

    const handled: string[] = [];
    let active = 0;
    let maxActive = 0;
    s.messageManager = {
      handleMessage: async (msg: any) => {
        active++;
        maxActive = Math.max(maxActive, active);
        handled.push(msg.id);
        if (msg.id === 'm1') {
          // Coo posts its reply while still handling m1; chat.add re-runs the listener with the full history
          listener([m1, m2, { id: 'r1', fromId: 'coo', body: 'reply', createdAt: new Date().toISOString() }]);
        }
        await new Promise((r) => setTimeout(r, 20));
        active--;
      },
    };

    s.startChatSubscription();
    listener([m1, m2]);
    await vi.waitFor(() => expect(handled.length).toBeGreaterThanOrEqual(3), { timeout: 2000 });
    await s.chatQueue;

    expect(handled).toEqual(['m1', 'm2', 'r1']);
    expect(maxActive).toBe(1);
  });
});

describe('HyperfyService chat queue limits', () => {
  function chatSetup() {
    const { service } = createRuntime();
    const s = service as any;
    let listener!: (msgs: any[]) => void;
    s.world = { chat: { msgs: [], subscribe: (fn: any) => (listener = fn) }, entities: { player: { data: { id: 'coo' } } } };
    s.connectionTime = Date.now() - 1000;
    const handled: string[] = [];
    const turns: Record<string, any> = {};
    const send = (...ids: string[]) =>
      listener(ids.map((id) => ({ id, fromId: `from-${id}`, body: id, createdAt: new Date().toISOString() })));
    return { s, handled, turns, send };
  }

  it('cancels a turn that outlives its slot and moves on to the next message', async () => {
    vi.useFakeTimers();
    try {
      const { s, handled, turns, send } = chatSetup();
      s.messageManager = {
        handleMessage: (msg: any, turn: any) => {
          handled.push(msg.id);
          turns[msg.id] = turn;
          return msg.id === 'slow' ? new Promise(() => {}) : Promise.resolve();
        },
      };
      s.startChatSubscription();
      send('slow', 'next');

      await vi.advanceTimersByTimeAsync(0);
      expect(handled).toEqual(['slow']);

      await vi.advanceTimersByTimeAsync(180_000);
      expect(turns.slow.cancelled).toBe(true);
      expect(handled).toEqual(['slow', 'next']);
      expect(turns.next.cancelled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips queued messages from a connection that has been torn down', async () => {
    const { s, handled, send } = chatSetup();
    let finishFirst!: () => void;
    s.messageManager = {
      handleMessage: (msg: any) => {
        handled.push(msg.id);
        return msg.id === 'first' ? new Promise<void>((resolve) => (finishFirst = resolve)) : Promise.resolve();
      },
    };
    s.startChatSubscription();
    send('first', 'queued');
    await vi.waitFor(() => expect(handled).toEqual(['first']));

    s.connectionGeneration++; // what teardown does
    finishFirst();
    await s.chatQueue;
    expect(handled).toEqual(['first']);
  });
});

describe('HyperfyService appearance', () => {
  const fakeWorld = () => ({ entities: { player: {} }, network: {}, assetsUrl: 'https://world.test/assets' });

  it('ignores an avatar result from a connection that was replaced meanwhile', async () => {
    const { service } = createRuntime();
    let finish!: (result: unknown) => void;
    vi.spyOn(service as any, 'applyAvatar').mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    const uploadEmotes = vi.fn().mockResolvedValue(true);
    (service as any).world = fakeWorld();
    (service as any).emoteManager = { uploadEmotes };

    const pending = (service as any).uploadCharacterAssets();
    (service as any).world = fakeWorld(); // reconnected while the old upload was still running
    finish({ outcome: 'gave-up', error: 'upload requires a connected session' });

    expect(await pending).toMatchObject({ outcome: 'retry' });
    expect((service as any).avatarOutcome).toBeNull();
    expect(uploadEmotes).not.toHaveBeenCalled();
  });

  it('retries only the emotes once the avatar is settled', async () => {
    const { service } = createRuntime();
    const applyAvatar = vi.spyOn(service as any, 'applyAvatar').mockResolvedValue({ outcome: 'applied' });
    const uploadEmotes = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    (service as any).world = fakeWorld();
    (service as any).emoteManager = { uploadEmotes };

    expect(await (service as any).uploadCharacterAssets()).toMatchObject({ outcome: 'retry' });
    expect(await (service as any).uploadCharacterAssets()).toEqual({ outcome: 'applied' });
    expect(applyAvatar).toHaveBeenCalledTimes(1);
    expect(uploadEmotes).toHaveBeenCalledTimes(2);
  });

  it('stops polling once the world has refused the avatar for good', async () => {
    const { service } = createRuntime();
    const player = { data: { id: 'p1', name: 'Coo' }, modify: vi.fn() };
    (service as any).world = { entities: { player }, network: { id: 'n1', send: vi.fn() }, assetsUrl: 'https://world.test/assets' };
    const upload = vi
      .spyOn(service as any, 'uploadCharacterAssets')
      .mockResolvedValue({ outcome: 'gave-up', error: 'builder rank required' });

    (service as any).startAppearancePolling();
    try {
      await vi.waitFor(() => expect((service as any).appearanceSet).toBe(true));
      expect(upload).toHaveBeenCalledTimes(1);
    } finally {
      (service as any).stopAppearancePolling();
    }
  });
});
