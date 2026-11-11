import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '@elizaos/core';
import { privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import { verifyMessage } from 'viem';
import { SIGN_IN_STATEMENT, TipWallet, readTipWalletAccount, signInHost, signInMessageProblem } from './tip-wallet';

// A throwaway test key (never funded)
const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const account = privateKeyToAccount(KEY);
const HOST = 'play.dwebxr.xyz';
const NOW = Date.UTC(2026, 10, 9, 12, 0, 0);
const NONCE = 'a'.repeat(64);

function worldMessage(overrides: Partial<Parameters<typeof createSiweMessage>[0]> = {}) {
  return createSiweMessage({
    domain: HOST,
    address: account.address,
    statement: SIGN_IN_STATEMENT,
    uri: `https://${HOST}`,
    version: '1',
    chainId: 137,
    nonce: NONCE,
    issuedAt: new Date(NOW),
    expirationTime: new Date(NOW + 60_000),
    ...overrides,
  });
}

describe('readTipWalletAccount', () => {
  it('reads a hex private key, with or without 0x, and takes nothing else for one', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      expect(readTipWalletAccount({ TIP_WALLET_PRIVATE_KEY: KEY })?.address).toBe(account.address);
      expect(readTipWalletAccount({ TIP_WALLET_PRIVATE_KEY: KEY.slice(2) })?.address).toBe(account.address);
      expect(readTipWalletAccount({ TIP_WALLET_PRIVATE_KEY: ` ${KEY}\n` })?.address).toBe(account.address);
      expect(readTipWalletAccount({})).toBeNull();
      expect(readTipWalletAccount({ TIP_WALLET_PRIVATE_KEY: '  ' })).toBeNull();
      expect(warn).not.toHaveBeenCalled();
      // Not a key: too short, too long, not hex, not on the curve
      const invalid = ['0x1234', `${KEY}ab`, `0x${'g'.repeat(64)}`, `0x${'0'.repeat(64)}`];
      for (const value of invalid) expect(readTipWalletAccount({ TIP_WALLET_PRIVATE_KEY: value }), value).toBeNull();
      // Each is said once, without the value: a mistyped key is still most of a key
      expect(warn).toHaveBeenCalledTimes(invalid.length);
      const lines = warn.mock.calls.flat().map(String);
      for (const line of lines) expect(line).toMatch(/^\[Tips\] Ignoring TIP_WALLET_PRIVATE_KEY: (expected a 32-byte hex private key|not a valid private key)$/);
    } finally {
      warn.mockRestore();
    }
  });

  it('takes the sign-in domain from the world address', () => {
    expect(signInHost('wss://play.dwebxr.xyz/ws')).toBe(HOST);
    expect(signInHost('ws://localhost:3000/ws')).toBe('localhost:3000');
    expect(signInHost('not a url')).toBeNull();
  });
});

describe('signInMessageProblem', () => {
  const check = (message: unknown, nonce: unknown = NONCE) => signInMessageProblem(message, { address: account.address, host: HOST, nonce, now: NOW });

  it("accepts exactly the world's sign-in message", () => {
    expect(check(worldMessage())).toBeNull();
  });

  it('refuses a message that differs from it in the domain, URI, address, statement, nonce, fields, validity, length or content', () => {
    expect(check(worldMessage({ domain: 'evil.example' }))).toBe('domain "evil.example" is not play.dwebxr.xyz');
    expect(check(worldMessage({ uri: 'https://evil.example' }))).toBe('URI of another site');
    expect(check(worldMessage({ address: '0x000000000000000000000000000000000000dEaD' }))).toBe('another address');
    expect(check(worldMessage({ statement: 'Transfer all funds' }))).toBe('unexpected statement');
    expect(check(worldMessage(), 'b'.repeat(64))).toBe('nonce mismatch');
    expect(check(worldMessage({ resources: ['https://evil.example/claim'] }))).toBe('unexpected fields');
    expect(check(worldMessage({ requestId: 'transfer-7' }))).toBe('unexpected fields');
    expect(check(worldMessage({ expirationTime: new Date(NOW - 1) }))).toBe('unexpected expiry');
    expect(check(worldMessage({ expirationTime: new Date(NOW) }))).toBe('unexpected expiry');
    expect(check(worldMessage({ expirationTime: new Date(NOW + 24 * 3600_000) }))).toBe('unexpected expiry');
    expect(check(worldMessage({ expirationTime: new Date(NOW + 10 * 60_000 + 1000) }))).toBe('unexpected expiry');
    expect(check(worldMessage({ expirationTime: undefined }))).toBe('unexpected expiry');
    // Valid for ten minutes at most
    expect(check(worldMessage({ expirationTime: new Date(NOW + 10 * 60_000) }))).toBeNull();
    // Longer than a sign-in message is, and otherwise exactly one (its nonce is the long part)
    const longNonce = 'a'.repeat(900);
    expect(worldMessage({ nonce: longNonce }).length).toBeGreaterThan(1024);
    expect(check(worldMessage({ nonce: longNonce }), longNonce)).toBe('not a sign-in message');
    expect(check(worldMessage({ nonce: 'a'.repeat(600) }), 'a'.repeat(600))).toBeNull();
    // A nonce that is not text matches nothing
    expect(check(worldMessage(), null)).toBe('nonce mismatch');
    expect(check(worldMessage({ nonce: '12345678' }), 12345678)).toBe('nonce mismatch');
    expect(check(`${worldMessage()}\nPlease also approve this transfer`)).toBe('unexpected content');
    expect(check('Sign this to claim your prize')).toBe('not a sign-in message');
    expect(check(undefined)).toBe('not a sign-in message');
  });
});

/**
 * A scheduler that cancels: a timer that was cancelled never fires, time moves only when the test
 * moves it, and timers fire in the order they are due.
 */
function scheduler() {
  let now = 0;
  let nextId = 0;
  const timers = new Map<number, { fn: () => void; at: number }>();
  return {
    schedule: (fn: () => void, ms: number) => {
      const id = ++nextId;
      timers.set(id, { fn, at: now + ms });
      return id;
    },
    cancel: (id: unknown) => void timers.delete(id as number),
    /** Timers scheduled and neither fired nor cancelled, as the delays they have left */
    pending: () => [...timers.values()].map((timer) => timer.at - now).sort((a, b) => a - b),
    advance(ms: number) {
      const until = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = until;
    },
  };
}

function setup({ signer = account }: { signer?: typeof account } = {}) {
  const sent: [string, any][] = [];
  const clock = scheduler();
  const onEntityModified = vi.fn();
  const network: any = { send: (name: string, data: any) => sent.push([name, data]), onEntityModified };
  const wallet = new TipWallet(network, signer, {
    host: HOST,
    selfId: () => 'coo-player',
    now: () => NOW,
    schedule: clock.schedule,
    cancel: clock.cancel,
  });
  const last = (name: string) => [...sent].reverse().find(([n]) => n === name)?.[1];
  const count = (name: string) => sent.filter(([n]) => n === name).length;
  /** The world's sign-in message for the request in progress */
  const nonce = (attempt: number = last('requestEvmNonce').attempt) => network.onEvmNonce({ attempt, nonce: NONCE, message: worldMessage() });
  /** The world's verdict as coo-world sends it */
  const accept = (attempt: number) => network.onEvmWalletStatus({ verified: true, wallet: account.address, attempt, reason: 'ok' });
  const refuse = (attempt: number) => network.onEvmWalletStatus({ verified: false, attempt, reason: 'signature_invalid' });
  const tipsOn = () => network.onEntityModified({ id: 'coo-player', evmTips: true });
  return { wallet, network, sent, clock, last, count, nonce, accept, refuse, tipsOn, onEntityModified };
}

const ANSWER_TIMEOUT_MS = 20_000;
const RETRY_BASE_MS = 30_000;

describe('TipWallet', () => {
  beforeEach(() => {
    for (const method of ['warn', 'error', 'info'] as const) vi.spyOn(logger, method).mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('signs in once and turns tips on', async () => {
    const { wallet, network, sent, last, clock, accept, onEntityModified } = setup();
    wallet.begin();
    wallet.begin(); // a later 'player' event (e.g. a name change) must not sign in again
    expect(sent).toEqual([['requestEvmNonce', { address: account.address, attempt: 1 }]]);
    const { attempt } = last('requestEvmNonce');
    expect(clock.pending()).toEqual([ANSWER_TIMEOUT_MS]);

    await network.onEvmNonce({ attempt, nonce: NONCE, message: worldMessage() });
    const verify = last('requestEvmVerify');
    expect(verify).toMatchObject({ address: account.address, nonce: NONCE, attempt });
    expect(await verifyMessage({ address: account.address, message: worldMessage(), signature: verify.signature })).toBe(true);

    accept(attempt);
    expect(last('setEvmTipReceive')).toEqual({ enabled: true });
    expect(wallet.receiving).toBe(false);

    // The world announces the flag on the agent's player; the engine itself drops it
    network.onEntityModified({ id: 'coo-player', evmTips: true });
    expect(onEntityModified).toHaveBeenCalledWith({ id: 'coo-player', evmTips: true });
    expect(wallet.receiving).toBe(true);
    network.onEntityModified({ id: 'someone-else', evmTips: false });
    expect(wallet.receiving).toBe(true);
    // Nothing is left to fire but the one check that says whether tips came on
    expect(clock.pending()).toEqual([3_000]);
    clock.advance(24 * 3600_000);
    expect(clock.pending()).toEqual([]);
    expect(wallet.receiving).toBe(true);
    // Also once signed in, a later 'player' event asks for nothing: a new request would sign the wallet out
    wallet.begin();
    expect(sent.map(([name]) => name)).toEqual(['requestEvmNonce', 'requestEvmVerify', 'setEvmTipReceive']);
  });

  it('does not sign a message that is not the world sign-in, and stops for this connection: the right message afterwards is not signed either', async () => {
    const signMessage = vi.fn(account.signMessage);
    const { wallet, network, sent, last, clock, nonce } = setup({ signer: { ...account, signMessage } as typeof account });
    wallet.begin();
    const { attempt } = last('requestEvmNonce');
    await network.onEvmNonce({ attempt, nonce: NONCE, message: worldMessage({ domain: 'evil.example' }) });
    expect(signMessage).not.toHaveBeenCalled();
    expect(sent.map(([name]) => name)).toEqual(['requestEvmNonce']);
    expect(wallet.receiving).toBe(false);
    expect(clock.pending()).toEqual([]);
    expect(vi.mocked(logger.error).mock.calls.flat().map(String)).toEqual(['[Tips] Refused to sign the world\'s wallet message (domain "evil.example" is not play.dwebxr.xyz); tips stay off for this connection']);
    // Over for this connection: the world's real message for the same attempt comes too late
    await nonce(attempt);
    wallet.begin();
    clock.advance(24 * 3600_000);
    expect(signMessage).not.toHaveBeenCalled();
    expect(sent.map(([name]) => name)).toEqual(['requestEvmNonce']);
  });

  it('signs with the same signer when the message is the world sign-in (control for the test above)', async () => {
    const signMessage = vi.fn(account.signMessage);
    const { wallet, count, nonce } = setup({ signer: { ...account, signMessage } as typeof account });
    wallet.begin();
    await nonce();
    expect(signMessage).toHaveBeenCalledTimes(1);
    expect(signMessage).toHaveBeenCalledWith({ message: worldMessage() });
    expect(count('requestEvmVerify')).toBe(1);
  });

  it('asks again when the world does not answer the request, a few times, then gives up with no timer left', () => {
    const { wallet, count, clock } = setup();
    wallet.begin();
    for (const [failures, requests] of [[1, 2], [2, 3], [3, 4]] as const) {
      clock.advance(ANSWER_TIMEOUT_MS);
      expect(clock.pending()).toEqual([RETRY_BASE_MS * failures]);
      clock.advance(RETRY_BASE_MS * failures);
      expect(count('requestEvmNonce')).toBe(requests);
    }
    clock.advance(ANSWER_TIMEOUT_MS);
    expect(clock.pending()).toEqual([]);
    clock.advance(24 * 3600_000);
    expect(count('requestEvmNonce')).toBe(4);
  });

  it('has a deadline after the message too: a world that never says what it made of the signature is asked again', async () => {
    const { wallet, last, count, clock, nonce } = setup();
    wallet.begin();
    clock.advance(5_000);
    await nonce();
    expect(count('requestEvmVerify')).toBe(1);
    // A deadline of its own, counted from the message
    expect(clock.pending()).toEqual([ANSWER_TIMEOUT_MS]);
    clock.advance(ANSWER_TIMEOUT_MS - 1);
    expect(count('requestEvmNonce')).toBe(1);
    clock.advance(1);
    expect(clock.pending()).toEqual([RETRY_BASE_MS]);
    clock.advance(RETRY_BASE_MS);
    expect(count('requestEvmNonce')).toBe(2);
    expect(last('requestEvmNonce').attempt).toBe(2);
  });

  it('counts a signature that cannot be made as a failed attempt, and asks again', async () => {
    const failing = { ...account, signMessage: vi.fn().mockRejectedValue(new Error('signer unavailable')) } as unknown as typeof account;
    const { wallet, count, clock, nonce } = setup({ signer: failing });
    wallet.begin();
    await nonce();
    expect(count('requestEvmVerify')).toBe(0);
    expect(clock.pending()).toEqual([RETRY_BASE_MS]);
    clock.advance(RETRY_BASE_MS);
    expect(count('requestEvmNonce')).toBe(2);
  });

  it('retries a refused signature a few times, with one timer at a time', async () => {
    const { wallet, last, count, clock, nonce, refuse } = setup();
    wallet.begin();
    for (let failures = 1; failures <= 3; failures++) {
      await nonce();
      refuse(last('requestEvmNonce').attempt);
      expect(clock.pending()).toEqual([RETRY_BASE_MS * failures]);
      clock.advance(RETRY_BASE_MS * failures);
      expect(count('requestEvmNonce')).toBe(failures + 1);
      expect(clock.pending()).toEqual([ANSWER_TIMEOUT_MS]);
    }
    await nonce();
    refuse(last('requestEvmNonce').attempt);
    // 1 + 3 retries, then it gives up
    expect(clock.pending()).toEqual([]);
    clock.advance(24 * 3600_000);
    expect(count('requestEvmNonce')).toBe(4);
  });

  it("waits the world's cooldown when it is a finite number, and counts it as a failed attempt", async () => {
    const { wallet, network, last, count, clock } = setup();
    wallet.begin();
    await network.onEvmNonce({ attempt: last('requestEvmNonce').attempt, retryAfterMs: 4000 });
    expect(clock.pending()).toEqual([4250]);
    clock.advance(4250);
    expect(count('requestEvmNonce')).toBe(2);
    // A world that only ever answers with a cooldown is given up on like any other failure
    for (let i = 0; i < 10; i++) {
      await network.onEvmNonce({ attempt: last('requestEvmNonce').attempt, retryAfterMs: 0 });
      clock.advance(250);
    }
    expect(count('requestEvmNonce')).toBe(4);
    expect(clock.pending()).toEqual([]);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '4000', null, undefined, {}])('takes no wait from a cooldown of %s: a failed attempt with the usual wait, never a request at once', async (retryAfterMs) => {
    const { wallet, network, last, count, clock } = setup();
    wallet.begin();
    await network.onEvmNonce({ attempt: last('requestEvmNonce').attempt, retryAfterMs });
    expect(count('requestEvmNonce')).toBe(1);
    expect(clock.pending()).toEqual([RETRY_BASE_MS]);
    clock.advance(RETRY_BASE_MS - 1);
    expect(count('requestEvmNonce')).toBe(1);
    clock.advance(1);
    expect(count('requestEvmNonce')).toBe(2);
  });

  it.each([
    [1e12, 60_250],
    [60_001, 60_250],
    [-1e12, 250],
  ])('bounds a finite cooldown of %s ms: between none and a minute', async (retryAfterMs, wait) => {
    const { wallet, network, last, clock } = setup();
    wallet.begin();
    await network.onEvmNonce({ attempt: last('requestEvmNonce').attempt, retryAfterMs });
    expect(clock.pending()).toEqual([wait]);
  });

  it('ignores a message for another attempt than the one in progress, and anything after stop()', async () => {
    const { wallet, network, sent, last, clock, tipsOn } = setup();
    wallet.begin();
    const { attempt } = last('requestEvmNonce');
    for (const other of [attempt + 1, attempt - 1, String(attempt), undefined]) await network.onEvmNonce({ attempt: other, nonce: NONCE, message: worldMessage() });
    expect(sent.map(([name]) => name)).toEqual(['requestEvmNonce']);
    // Still waiting for the message of this attempt, on the same deadline
    expect(clock.pending()).toEqual([ANSWER_TIMEOUT_MS]);
    wallet.stop();
    expect(clock.pending()).toEqual([]);
    await network.onEvmNonce({ attempt, nonce: NONCE, message: worldMessage() });
    network.onEvmWalletStatus({ verified: true, wallet: account.address, attempt });
    tipsOn();
    expect(sent.map(([name]) => name)).toEqual(['requestEvmNonce']);
    expect(wallet.receiving).toBe(false);
  });

  it('ignores the message of an earlier attempt once the next one has been asked for', async () => {
    const { wallet, count, clock, nonce } = setup();
    wallet.begin();
    clock.advance(ANSWER_TIMEOUT_MS + RETRY_BASE_MS);
    expect(count('requestEvmNonce')).toBe(2);
    await nonce(1);
    expect(count('requestEvmVerify')).toBe(0);
    await nonce(2);
    expect(count('requestEvmVerify')).toBe(1);
  });

  it('signs the message of an attempt once: a second copy of it is not signed again', async () => {
    const { wallet, count, nonce } = setup();
    wallet.begin();
    await nonce();
    await nonce();
    expect(count('requestEvmVerify')).toBe(1);
  });

  describe('a status that is not the answer the wallet is waiting for', () => {
    /** Attempt 1 got its message and no verdict in time; attempt 2 has been asked for */
    async function secondAttempt() {
      const ctx = setup();
      ctx.wallet.begin();
      await ctx.nonce(1);
      ctx.clock.advance(ANSWER_TIMEOUT_MS + RETRY_BASE_MS);
      expect(ctx.last('requestEvmNonce').attempt).toBe(2);
      return ctx;
    }

    it('a late success for an earlier attempt does not sign the wallet in', async () => {
      const ctx = await secondAttempt();
      ctx.accept(1);
      ctx.tipsOn();
      expect(ctx.wallet.receiving).toBe(false);
      expect(ctx.count('setEvmTipReceive')).toBe(0);
      // The attempt in progress is untouched: its deadline still runs, and it can still succeed
      expect(ctx.clock.pending()).toEqual([ANSWER_TIMEOUT_MS]);
      await ctx.nonce(2);
      ctx.accept(2);
      expect(ctx.wallet.receiving).toBe(true);
      expect(ctx.count('setEvmTipReceive')).toBe(1);
    });

    it('a late failure for an earlier attempt neither counts as a failure nor disturbs the attempt in progress', async () => {
      const ctx = await secondAttempt();
      await ctx.nonce(2);
      for (let i = 0; i < 10; i++) ctx.refuse(1);
      // Still waiting for the verdict on attempt 2, on the same deadline; no retry was scheduled
      expect(ctx.clock.pending()).toEqual([ANSWER_TIMEOUT_MS]);
      expect(ctx.count('requestEvmNonce')).toBe(2);
      ctx.accept(2);
      ctx.tipsOn();
      expect(ctx.wallet.receiving).toBe(true);
    });

    it('a late failure for an earlier attempt does not sign a signed-in wallet out', async () => {
      const ctx = await secondAttempt();
      await ctx.nonce(2);
      ctx.accept(2);
      ctx.tipsOn();
      ctx.refuse(1);
      ctx.refuse(2);
      expect(ctx.wallet.receiving).toBe(true);
      ctx.clock.advance(24 * 3600_000);
      expect(ctx.count('requestEvmNonce')).toBe(2);
      expect(ctx.wallet.receiving).toBe(true);
    });

    it('a verdict on the attempt in progress before any signature was sent changes nothing', async () => {
      const ctx = setup();
      ctx.wallet.begin();
      ctx.accept(1);
      ctx.refuse(1);
      ctx.tipsOn();
      expect(ctx.wallet.receiving).toBe(false);
      expect(ctx.count('setEvmTipReceive')).toBe(0);
      expect(ctx.clock.pending()).toEqual([ANSWER_TIMEOUT_MS]);
      // ...and the sign-in still goes through
      await ctx.nonce(1);
      ctx.accept(1);
      expect(ctx.wallet.receiving).toBe(true);
    });

    it('a success without an attempt, or for another wallet, does not sign the wallet in', async () => {
      const ctx = setup();
      ctx.wallet.begin();
      await ctx.nonce(1);
      ctx.network.onEvmWalletStatus({ verified: true, wallet: account.address });
      ctx.network.onEvmWalletStatus({ verified: true, wallet: '0x000000000000000000000000000000000000dEaD', attempt: 1, reason: 'ok' });
      ctx.network.onEvmWalletStatus({ verified: true, attempt: 1, reason: 'ok' });
      ctx.network.onEvmWalletStatus({ verified: 'true', wallet: account.address, attempt: 1, reason: 'ok' });
      ctx.tipsOn();
      expect(ctx.wallet.receiving).toBe(false);
      expect(ctx.count('setEvmTipReceive')).toBe(0);
      // The verdict it waits for still signs it in
      ctx.accept(1);
      expect(ctx.wallet.receiving).toBe(true);
      expect(ctx.count('setEvmTipReceive')).toBe(1);
    });

    it('a sign-out (no attempt) signs a signed-in wallet out and starts a new attempt; while not signed in it changes nothing', async () => {
      const ctx = setup();
      ctx.wallet.begin();
      // While waiting for the message: nothing to sign out
      ctx.network.onEvmWalletStatus({ verified: false });
      expect(ctx.clock.pending()).toEqual([ANSWER_TIMEOUT_MS]);
      expect(ctx.count('requestEvmNonce')).toBe(1);
      await ctx.nonce(1);
      ctx.accept(1);
      ctx.tipsOn();
      expect(ctx.wallet.receiving).toBe(true);

      ctx.network.onEvmWalletStatus({ verified: false });
      expect(ctx.wallet.receiving).toBe(false);
      // It had been receiving on this connection
      expect(ctx.wallet.receivedOnThisConnection).toBe(true);
      expect(ctx.clock.pending()).toEqual([RETRY_BASE_MS]);
      ctx.clock.advance(RETRY_BASE_MS);
      expect(ctx.last('requestEvmNonce').attempt).toBe(2);
    });
  });

  it('keeps at most one timer through forty pseudo-random sequences of everything the world can send', async () => {
    // A fixed pseudo-random sequence
    let seed = 12345;
    const pick = (count: number) => {
      seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
      // The high bits: the low ones of this generator repeat after a few steps
      return (seed >>> 16) % count;
    };
    let signedIn = 0;
    let retried = 0;
    let gaveUp = 0;
    for (let run = 0; run < 40; run++) {
      const { wallet, network, clock, last, count } = setup();
      wallet.begin();
      const packets: (() => unknown)[] = [
        () => network.onEvmNonce({ attempt: last('requestEvmNonce').attempt, nonce: NONCE, message: worldMessage() }),
        () => network.onEvmNonce({ attempt: last('requestEvmNonce').attempt, retryAfterMs: 100 }),
        () => network.onEvmNonce({ attempt: 0, nonce: NONCE, message: worldMessage() }),
        () => network.onEvmWalletStatus({ verified: true, wallet: account.address, attempt: last('requestEvmNonce').attempt, reason: 'ok' }),
        () => network.onEvmWalletStatus({ verified: false, attempt: last('requestEvmNonce').attempt, reason: 'x' }),
        () => network.onEvmWalletStatus({ verified: false, attempt: 1 }),
        () => network.onEvmWalletStatus({ verified: false }),
        () => network.onEvmWalletStatus({ verified: true, wallet: account.address }),
        () => clock.advance(7_000),
        () => clock.advance(31_000),
      ];
      for (let i = 0; i < 40; i++) {
        await packets[pick(packets.length)]();
        expect(clock.pending().length).toBeLessThanOrEqual(1);
      }
      if (count('setEvmTipReceive')) signedIn++;
      if (count('requestEvmNonce') > 1) retried++;
      // Given up: nothing left to fire, and a day later still nothing asked
      const asked = count('requestEvmNonce');
      clock.advance(24 * 3600_000);
      if (!wallet.receiving && !clock.pending().length && count('requestEvmNonce') === asked && asked === 4) gaveUp++;
    }
    // The sequences took wallets through signing in, asking again, and giving up
    expect(signedIn).toBeGreaterThan(5);
    expect(retried).toBeGreaterThan(5);
    expect(gaveUp).toBeGreaterThan(0);
  });

  it('a timer that fires although it was replaced does nothing (a scheduler that cannot cancel)', async () => {
    const sent: [string, any][] = [];
    const fired: (() => void)[] = [];
    const network: any = { send: (name: string, data: any) => sent.push([name, data]) };
    const wallet = new TipWallet(network, account, { host: HOST, selfId: () => 'coo-player', now: () => NOW, schedule: (fn) => fired.push(fn), cancel: () => {} });
    wallet.begin();
    await network.onEvmNonce({ attempt: 1, nonce: NONCE, message: worldMessage() });
    network.onEvmWalletStatus({ verified: true, wallet: account.address, attempt: 1, reason: 'ok' });
    network.onEntityModified({ id: 'coo-player', evmTips: true });
    // The answer deadlines of the request and of the message, both replaced since
    fired[0]();
    fired[1]();
    expect(wallet.receiving).toBe(true);
    expect(sent.filter(([name]) => name === 'requestEvmNonce')).toHaveLength(1);
  });
});
