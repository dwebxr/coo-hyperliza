import { logger } from '@elizaos/core';
import { type PrivateKeyAccount, privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage, parseSiweMessage } from 'viem/siwe';

/**
 * Lets the agent receive tips (投げゼニ) in coo-world. The world only offers the Tip button for a
 * player whose wallet signed in on the current connection, so the agent signs in on every
 * connection with its own key, then switches "Receive tips" on.
 *
 * The key only ever signs the world's own sign-in message, after checking that it is exactly that
 * (signInMessageProblem). Nothing here builds, signs or sends a transaction: moving the received
 * tokens is left to the operator.
 */

/** Not prefixed COO_: elizaOS copies <CHARACTER NAME>_* variables into the stored character secrets. */
export const TIP_WALLET_ENV = 'TIP_WALLET_PRIVATE_KEY';

// coo-world src/server/evm-gating.js EVM_STATEMENT
export const SIGN_IN_STATEMENT = 'Verify wallet ownership for this world. This does not authorize any transaction.';
// The world's challenges live 60 s; anything valid much longer is not one of them
const MAX_VALIDITY_MS = 10 * 60_000;
const ANSWER_TIMEOUT_MS = 20_000;
const RETRY_BASE_MS = 30_000;
const MAX_FAILURES = 3;
const RECEIVE_CHECK_MS = 3_000;
const MAX_REQUEST_ID = 0x7fffffff;

type Env = Record<string, string | undefined>;

/** The agent's tip wallet from TIP_WALLET_PRIVATE_KEY, or null when unset or invalid. */
export function readTipWalletAccount(env: Env = process.env): PrivateKeyAccount | null {
  const raw = env[TIP_WALLET_ENV]?.trim();
  if (!raw) return null;
  const key = raw.startsWith('0x') ? raw : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    logger.warn(`[Tips] Ignoring ${TIP_WALLET_ENV}: expected a 32-byte hex private key`);
    return null;
  }
  try {
    return privateKeyToAccount(key as `0x${string}`);
  } catch {
    logger.warn(`[Tips] Ignoring ${TIP_WALLET_ENV}: not a valid private key`);
    return null;
  }
}

let held: { account: PrivateKeyAccount | null } | null = null;

/**
 * The agent's tip wallet, read from TIP_WALLET_PRIVATE_KEY on the first call and kept in this
 * module (so every reconnect signs with it). Every call deletes the variable from `env`: the
 * elizaOS server re-reads .env (without overriding) after loading the project, which puts it back,
 * so the service calls this again when it starts. Whatever reads the environment between such a
 * re-read and the next call (or after a later re-read) can still see the key.
 */
export function takeTipWalletAccount(env: Env = process.env): PrivateKeyAccount | null {
  held ??= { account: readTipWalletAccount(env) };
  delete env[TIP_WALLET_ENV];
  return held.account;
}

/** Tests only: forgets the account taken by takeTipWalletAccount. */
export function forgetTipWalletAccount(): void {
  held = null;
}

/** The domain the world signs in as: the host of its address (e.g. play.dwebxr.xyz). */
export function signInHost(wsUrl: string): string | null {
  try {
    return new URL(wsUrl).host || null;
  } catch {
    return null;
  }
}

/**
 * Why the agent must not sign this message, or null when it is exactly the world's sign-in
 * request for this wallet: the world's domain and statement, this address and nonce, no extra
 * content, and a short validity.
 */
export function signInMessageProblem(
  message: unknown,
  { address, host, nonce, now }: { address: string; host: string; nonce: unknown; now: number }
): string | null {
  if (typeof message !== 'string' || message.length > 1024) return 'not a sign-in message';
  let parsed: ReturnType<typeof parseSiweMessage>;
  try {
    parsed = parseSiweMessage(message);
    // Rebuilding it must give the same text, so nothing is hidden outside the parsed fields
    if (createSiweMessage(parsed as Parameters<typeof createSiweMessage>[0]) !== message) return 'unexpected content';
  } catch {
    return 'not a sign-in message';
  }
  if (parsed.domain !== host) return `domain "${parsed.domain}" is not ${host}`;
  if (parsed.address?.toLowerCase() !== address.toLowerCase()) return 'another address';
  if (parsed.statement !== SIGN_IN_STATEMENT) return 'unexpected statement';
  if (typeof nonce !== 'string' || parsed.nonce !== nonce) return 'nonce mismatch';
  try {
    if (!parsed.uri || new URL(parsed.uri).host !== host) return 'URI of another site';
  } catch {
    return 'invalid URI';
  }
  if (parsed.resources?.length || parsed.requestId !== undefined) return 'unexpected fields';
  const expires = parsed.expirationTime?.getTime();
  if (!expires || expires <= now || expires - now > MAX_VALIDITY_MS) return 'unexpected expiry';
  return null;
}

interface WorldNetwork {
  send(name: string, data: unknown): void;
  [handler: string]: any;
}

export interface TipWalletOptions {
  /** The world's sign-in domain (signInHost). */
  host: string;
  /** The agent's player id in the world (the engine does not keep the world's evmTips flag on it). */
  selfId: () => string | undefined;
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (timer: unknown) => void;
}

/**
 * Signs the agent's wallet in on one connection and turns on "Receive tips". Retries a few times
 * on failure; never retries a message it refused to sign.
 */
export class TipWallet {
  private attempt = 0;
  private failures = 0;
  private timer: unknown = null;
  private stopped = false;
  private begun = false;
  private verified = false;
  /** The world's evmTips flag on the agent's player, read from entityModified. */
  private tipsOn = false;
  private hasReceived = false;
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => unknown;
  private readonly cancel: (timer: unknown) => void;

  constructor(
    private readonly network: WorldNetwork,
    private readonly account: PrivateKeyAccount,
    private readonly options: TipWalletOptions
  ) {
    this.now = options.now ?? Date.now;
    this.schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    this.cancel = options.cancel ?? ((timer) => clearTimeout(timer as NodeJS.Timeout));
    // The engine ignores the returned promise; it never rejects
    network.onEvmNonce = (data: unknown) =>
      this.onNonce(data).catch((error) => logger.error(`[Tips] Wallet sign-in failed: ${error?.message ?? error}`));
    network.onEvmWalletStatus = (data: unknown) => this.onStatus(data);
    const onEntityModified = network.onEntityModified;
    network.onEntityModified = (data: any) => {
      if (data && typeof data === 'object' && 'evmTips' in data && data.id === options.selfId()) {
        this.tipsOn = data.evmTips === true;
        this.noteReceiving();
      }
      return onEntityModified?.call(network, data);
    };
  }

  get address(): string {
    return this.account.address;
  }

  /** Signed in and shown as receiving tips on this connection. */
  get receiving(): boolean {
    return this.verified && !this.stopped && this.tipsOn;
  }

  /**
   * Whether this connection's wallet has been receiving tips at some point: the world then did the
   * sign-in and switched tips on, so tips it confirms later (after a sign-out, or with "Receive
   * tips" off again) were sent while it was.
   */
  get receivedOnThisConnection(): boolean {
    return this.hasReceived;
  }

  private noteReceiving(): void {
    if (this.receiving) this.hasReceived = true;
  }

  /**
   * Starts the sign-in once the agent's player is in the world. Later calls do nothing: asking the
   * world for a new message would sign the wallet out.
   */
  begin(): void {
    if (this.begun) return;
    this.begun = true;
    this.request();
  }

  private request(): void {
    if (this.stopped) return;
    this.clearTimer();
    this.attempt = (this.attempt % MAX_REQUEST_ID) + 1;
    this.network.send('requestEvmNonce', { address: this.account.address, attempt: this.attempt });
    const attempt = this.attempt;
    this.timer = this.schedule(() => {
      this.timer = null;
      if (attempt !== this.attempt || this.verified || this.stopped) return;
      logger.warn('[Tips] The world did not answer the wallet sign-in (are EVM wallets enabled there?)');
      this.retryLater();
    }, ANSWER_TIMEOUT_MS);
  }

  stop(): void {
    this.stopped = true;
    this.clearTimer();
  }

  private async onNonce(data: any): Promise<void> {
    if (this.stopped || !data || data.attempt !== this.attempt) return;
    this.clearTimer();
    if (typeof data.retryAfterMs === 'number') {
      this.timer = this.schedule(() => {
        this.timer = null;
        this.request();
      }, Math.min(Math.max(data.retryAfterMs, 0), 60_000) + 250);
      return;
    }
    const problem = signInMessageProblem(data.message, {
      address: this.account.address,
      host: this.options.host,
      nonce: data.nonce,
      now: this.now(),
    });
    if (problem) {
      // Not the world's sign-in request: never sign it, and don't ask again on this connection
      logger.error(`[Tips] Refused to sign the world's wallet message (${problem}); tips stay off for this connection`);
      this.stop();
      return;
    }
    const attempt = this.attempt;
    const signature = await this.account.signMessage({ message: data.message });
    if (this.stopped || attempt !== this.attempt) return;
    this.network.send('requestEvmVerify', { address: this.account.address, signature, nonce: data.nonce, attempt });
  }

  private onStatus(data: any): void {
    if (this.stopped || !data || typeof data.verified !== 'boolean') return;
    if (data.verified) {
      if (typeof data.wallet !== 'string' || data.wallet.toLowerCase() !== this.account.address.toLowerCase()) return;
      this.verified = true;
      this.noteReceiving();
      this.failures = 0;
      this.network.send('setEvmTipReceive', { enabled: true });
      this.timer = this.schedule(() => {
        this.timer = null;
        if (this.stopped) return;
        if (this.tipsOn) logger.info(`[Tips] Receiving tips at ${this.account.address}`);
        else logger.warn('[Tips] Wallet signed in, but the world did not turn tips on (are tips enabled there?)');
      }, RECEIVE_CHECK_MS);
      return;
    }
    const wasVerified = this.verified;
    this.verified = false;
    // A reply to an older attempt
    if (data.attempt !== undefined && data.attempt !== this.attempt) return;
    logger.warn(`[Tips] Wallet ${wasVerified ? 'signed out' : 'sign-in failed'}${data.reason ? ` (${data.reason})` : ''}`);
    this.retryLater();
  }

  private retryLater(): void {
    if (this.stopped) return;
    if (++this.failures > MAX_FAILURES) {
      logger.error(`[Tips] Giving up on the wallet sign-in for this connection after ${MAX_FAILURES} retries`);
      this.stop();
      return;
    }
    this.clearTimer();
    this.timer = this.schedule(() => {
      this.timer = null;
      this.request();
    }, RETRY_BASE_MS * this.failures);
  }

  private clearTimer(): void {
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
  }
}
