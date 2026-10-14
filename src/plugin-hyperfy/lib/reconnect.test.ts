import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RECONNECT_BASE_DELAY_MS,
  RECONNECT_MAX_DELAY_MS,
  ReconnectController,
  computeReconnectDelay,
} from './reconnect';

describe('computeReconnectDelay', () => {
  const noJitter = { random: () => 0.5 };

  it('doubles per attempt from the base delay', () => {
    expect(computeReconnectDelay(0, noJitter)).toBe(RECONNECT_BASE_DELAY_MS);
    expect(computeReconnectDelay(1, noJitter)).toBe(RECONNECT_BASE_DELAY_MS * 2);
    expect(computeReconnectDelay(3, noJitter)).toBe(RECONNECT_BASE_DELAY_MS * 8);
  });

  it('never exceeds the max delay, even with positive jitter', () => {
    expect(computeReconnectDelay(50, { random: () => 1 })).toBe(RECONNECT_MAX_DELAY_MS);
    expect(computeReconnectDelay(10_000, noJitter)).toBe(RECONNECT_MAX_DELAY_MS);
  });

  it('applies at most +/-20% jitter', () => {
    expect(computeReconnectDelay(0, { random: () => 0 })).toBe(RECONNECT_BASE_DELAY_MS * 0.8);
    expect(computeReconnectDelay(0, { random: () => 1 })).toBe(RECONNECT_BASE_DELAY_MS * 1.2);
  });
});

describe('ReconnectController', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const options = { random: () => 0.5 };

  it('keeps a single pending timer', async () => {
    const reconnect = vi.fn().mockResolvedValue(undefined);
    const controller = new ReconnectController(reconnect, options);

    expect(controller.schedule()).toBe(RECONNECT_BASE_DELAY_MS);
    expect(controller.schedule()).toBeNull();
    expect(controller.isPending).toBe(true);

    await vi.advanceTimersByTimeAsync(RECONNECT_BASE_DELAY_MS);
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(controller.isPending).toBe(false);
  });

  it('refuses to schedule while a reconnect is running', async () => {
    let finish!: () => void;
    const reconnect = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const controller = new ReconnectController(reconnect, options);

    controller.schedule();
    await vi.advanceTimersByTimeAsync(RECONNECT_BASE_DELAY_MS);
    expect(controller.schedule()).toBeNull();

    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.schedule()).not.toBeNull();
  });

  it('backs off until a session is established, then resets', async () => {
    const reconnect = vi.fn().mockResolvedValue(undefined);
    const controller = new ReconnectController(reconnect, options);

    expect(controller.schedule()).toBe(RECONNECT_BASE_DELAY_MS);
    await vi.advanceTimersByTimeAsync(RECONNECT_BASE_DELAY_MS);
    // init "succeeded" but the socket closed before the player spawned
    expect(controller.schedule()).toBe(RECONNECT_BASE_DELAY_MS * 2);
    await vi.advanceTimersByTimeAsync(RECONNECT_BASE_DELAY_MS * 2);

    controller.markEstablished();
    expect(controller.schedule()).toBe(RECONNECT_BASE_DELAY_MS);
  });

  it('schedules the next attempt itself when a reconnect fails', async () => {
    const onError = vi.fn();
    const reconnect = vi.fn().mockRejectedValueOnce(new Error('refused')).mockResolvedValue(undefined);
    const controller = new ReconnectController(reconnect, { ...options, onError });

    controller.schedule();
    await vi.advanceTimersByTimeAsync(RECONNECT_BASE_DELAY_MS);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(controller.isPending).toBe(true);

    await vi.advanceTimersByTimeAsync(RECONNECT_BASE_DELAY_MS * 2);
    expect(reconnect).toHaveBeenCalledTimes(2);
    expect(controller.isPending).toBe(false);
  });

  it('stop() cancels the pending timer and blocks further scheduling', async () => {
    const reconnect = vi.fn().mockResolvedValue(undefined);
    const controller = new ReconnectController(reconnect, options);

    controller.schedule();
    controller.stop();
    await vi.advanceTimersByTimeAsync(RECONNECT_MAX_DELAY_MS);
    expect(reconnect).not.toHaveBeenCalled();
    expect(controller.schedule()).toBeNull();

    controller.resume();
    expect(controller.schedule()).not.toBeNull();
  });

  it('cancelPending() drops a waiting retry without disabling the controller', async () => {
    const reconnect = vi.fn().mockResolvedValue(undefined);
    const controller = new ReconnectController(reconnect, options);

    controller.schedule();
    controller.cancelPending();
    await vi.advanceTimersByTimeAsync(RECONNECT_MAX_DELAY_MS);
    expect(reconnect).not.toHaveBeenCalled();
    expect(controller.schedule()).not.toBeNull();
  });

  it('markEstablished() cancels a retry that became obsolete', async () => {
    const reconnect = vi.fn().mockResolvedValue(undefined);
    const controller = new ReconnectController(reconnect, options);

    controller.schedule();
    controller.markEstablished();
    await vi.advanceTimersByTimeAsync(RECONNECT_MAX_DELAY_MS);
    expect(reconnect).not.toHaveBeenCalled();
  });

  it('deferNextRetry() makes only the next schedule use the max delay, whoever calls it', () => {
    const controller = new ReconnectController(vi.fn().mockResolvedValue(undefined), options);
    controller.deferNextRetry();
    expect(controller.schedule()).toBe(RECONNECT_MAX_DELAY_MS);
    controller.cancelPending();
    expect(controller.schedule()).toBe(RECONNECT_BASE_DELAY_MS * 2);
  });

  it('useMaxDelay waits the maximum delay', () => {
    const controller = new ReconnectController(vi.fn().mockResolvedValue(undefined), options);
    expect(controller.schedule({ useMaxDelay: true })).toBe(RECONNECT_MAX_DELAY_MS);
  });
});
