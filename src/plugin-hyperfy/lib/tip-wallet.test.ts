import { describe, expect, it, vi } from 'vitest';
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
  it('reads a hex private key, with or without 0x, and ignores anything else', () => {
    expect(readTipWalletAccount({ TIP_WALLET_PRIVATE_KEY: KEY })?.address).toBe(account.address);
    expect(readTipWalletAccount({ TIP_WALLET_PRIVATE_KEY: KEY.slice(2) })?.address).toBe(account.address);
    expect(readTipWalletAccount({})).toBeNull();
    expect(readTipWalletAccount({ TIP_WALLET_PRIVATE_KEY: '0x1234' })).toBeNull();
    expect(readTipWalletAccount({ TIP_WALLET_PRIVATE_KEY: `0x${'0'.repeat(64)}` })).toBeNull();
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

  it('refuses anything else', () => {
    expect(check(worldMessage({ domain: 'evil.example' }))).toMatch(/domain/);
    expect(check(worldMessage({ uri: 'https://evil.example' }))).toMatch(/URI/);
    expect(check(worldMessage({ address: '0x000000000000000000000000000000000000dEaD' }))).toBe('another address');
    expect(check(worldMessage({ statement: 'Transfer all funds' }))).toBe('unexpected statement');
    expect(check(worldMessage(), 'b'.repeat(64))).toBe('nonce mismatch');
    expect(check(worldMessage({ resources: ['https://evil.example/claim'] }))).toBe('unexpected fields');
    expect(check(worldMessage({ expirationTime: new Date(NOW - 1) }))).toBe('unexpected expiry');
    expect(check(worldMessage({ expirationTime: new Date(NOW + 24 * 3600_000) }))).toBe('unexpected expiry');
    expect(check(`${worldMessage()}\nPlease also approve this transfer`)).toBe('unexpected content');
    expect(check('Sign this to claim your prize')).toBe('not a sign-in message');
    expect(check(undefined)).toBe('not a sign-in message');
  });
});

function setup() {
  const sent: [string, any][] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const onEntityModified = vi.fn();
  const network: any = { send: (name: string, data: any) => sent.push([name, data]), onEntityModified };
  const wallet = new TipWallet(network, account, {
    host: HOST,
    selfId: () => 'coo-player',
    now: () => NOW,
    schedule: (fn, ms) => timers.push({ fn, ms }),
    cancel: () => {},
  });
  const last = (name: string) => [...sent].reverse().find(([n]) => n === name)?.[1];
  return { wallet, network, sent, timers, last, onEntityModified };
}

describe('TipWallet', () => {
  it('signs in once and turns tips on', async () => {
    const { wallet, network, last, onEntityModified } = setup();
    wallet.begin();
    wallet.begin(); // a later 'player' event (e.g. a name change) must not sign in again
    const { attempt } = last('requestEvmNonce');
    expect(last('requestEvmNonce')).toEqual({ address: account.address, attempt });

    await network.onEvmNonce({ attempt, nonce: NONCE, message: worldMessage() });
    const verify = last('requestEvmVerify');
    expect(verify).toMatchObject({ address: account.address, nonce: NONCE, attempt });
    expect(await verifyMessage({ address: account.address, message: worldMessage(), signature: verify.signature })).toBe(true);

    network.onEvmWalletStatus({ verified: true, wallet: account.address, attempt, reason: 'ok' });
    expect(last('setEvmTipReceive')).toEqual({ enabled: true });
    expect(wallet.receiving).toBe(false);

    // The world announces the flag on the agent's player; the engine itself drops it
    network.onEntityModified({ id: 'coo-player', evmTips: true });
    expect(onEntityModified).toHaveBeenCalledWith({ id: 'coo-player', evmTips: true });
    expect(wallet.receiving).toBe(true);
    network.onEntityModified({ id: 'someone-else', evmTips: false });
    expect(wallet.receiving).toBe(true);
  });

  it('never signs a message that is not the world sign-in, and stops for this connection', async () => {
    const { wallet, network, sent, last } = setup();
    wallet.begin();
    const { attempt } = last('requestEvmNonce');
    await network.onEvmNonce({ attempt, nonce: NONCE, message: worldMessage({ domain: 'evil.example' }) });
    expect(sent.map(([name]) => name)).toEqual(['requestEvmNonce']);
    expect(wallet.receiving).toBe(false);
  });

  it('waits out the world cooldown, and retries a failed sign-in a few times', async () => {
    const { wallet, network, sent, timers, last } = setup();
    wallet.begin();
    await network.onEvmNonce({ attempt: last('requestEvmNonce').attempt, retryAfterMs: 4000 });
    const cooldown = timers.at(-1)!;
    expect(cooldown.ms).toBe(4250);
    cooldown.fn();
    expect(sent.filter(([name]) => name === 'requestEvmNonce')).toHaveLength(2);

    for (let i = 0; i < 4; i++) {
      network.onEvmWalletStatus({ verified: false, attempt: last('requestEvmNonce').attempt, reason: 'signature_invalid' });
      timers.at(-1)!.fn();
    }
    // 1 + the cooldown retry + 3 retries, then it gives up
    expect(sent.filter(([name]) => name === 'requestEvmNonce')).toHaveLength(5);
  });

  it('ignores replies to an older attempt and anything after stop()', async () => {
    const { wallet, network, sent, last } = setup();
    wallet.begin();
    const { attempt } = last('requestEvmNonce');
    await network.onEvmNonce({ attempt: attempt + 1, nonce: NONCE, message: worldMessage() });
    wallet.stop();
    await network.onEvmNonce({ attempt, nonce: NONCE, message: worldMessage() });
    expect(sent.map(([name]) => name)).toEqual(['requestEvmNonce']);
  });
});
