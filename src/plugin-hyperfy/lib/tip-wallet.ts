import { logger } from '@elizaos/core';
import { type PrivateKeyAccount, privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage, parseSiweMessage } from 'viem/siwe';
import { shownName } from './text';

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
// The longest wait the world can make the agent take before the next request (coo-world's own cooldown is 5 s)
const MAX_COOLDOWN_MS = 60_000;
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
 * Where the sign-in of one connection stands:
 *  - 'idle': not begun;
 *  - 'awaiting-nonce': the world was asked for its sign-in message (attempt N) and has
 *    ANSWER_TIMEOUT_MS to send it;
 *  - 'answering': the message came and is being signed and verified; the world has
 *    ANSWER_TIMEOUT_MS from the message to say what it made of the signature;
 *  - 'verified': the world said this wallet is signed in;
 *  - 'waiting': an attempt failed (or the world asked to wait); the next one is scheduled;
 *  - 'stopped': over for this connection (stop(), a message it refused to sign, too many failures).
 * Of what the world sends, only the answer to the attempt in progress, in the phase that waits for
 * it, moves the sign-in on: that is checked before any state is touched. Besides that, a sign-out
 * notice (no attempt, verified false) while 'verified' counts as a failure, and the evmTips flag of
 * the agent's own player is recorded in any phase.
 */
type Phase = 'idle' | 'awaiting-nonce' | 'answering' | 'verified' | 'waiting' | 'stopped';

/**
 * Signs the agent's wallet in on one connection and turns on "Receive tips". Retries a few times
 * on failure; never retries a message it refused to sign.
 */
export class TipWallet {
  private phase: Phase = 'idle';
  private attempt = 0;
  private failures = 0;
  /** The one timer of the phase: its deadline, or the wait before the next attempt */
  private timer: unknown = null;
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
    return this.phase === 'verified' && this.tipsOn;
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
    if (this.phase !== 'idle') return;
    this.request();
  }

  private request(): void {
    if (this.phase === 'stopped') return;
    this.attempt = (this.attempt % MAX_REQUEST_ID) + 1;
    this.phase = 'awaiting-nonce';
    this.network.send('requestEvmNonce', { address: this.account.address, attempt: this.attempt });
    this.setTimer(() => this.failed('the world did not answer (are EVM wallets enabled there?)'), ANSWER_TIMEOUT_MS);
  }

  stop(): void {
    this.phase = 'stopped';
    this.clearTimer();
  }

  private async onNonce(data: any): Promise<void> {
    // Only the answer to the request in progress, and only once
    if (this.phase !== 'awaiting-nonce' || !data || typeof data !== 'object' || data.attempt !== this.attempt) return;
    if ('retryAfterMs' in data) {
      // The world's cooldown: a failed attempt like any other, so a world that keeps answering this
      // way is given up on. The wait it names is taken only when it is a finite number.
      const wait = data.retryAfterMs;
      const finite = typeof wait === 'number' && Number.isFinite(wait);
      this.failed('the world asked to wait', finite ? Math.min(Math.max(wait, 0), MAX_COOLDOWN_MS) + 250 : undefined);
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
    this.phase = 'answering';
    // From the message on: signing it, and the world's verdict on the signature
    this.setTimer(() => this.failed('the world did not say whether it accepted the signature'), ANSWER_TIMEOUT_MS);
    let signature: string;
    try {
      signature = await this.account.signMessage({ message: data.message });
    } catch (error: any) {
      if (this.phase === 'answering' && attempt === this.attempt) this.failed(`the message could not be signed (${error?.message ?? error})`);
      return;
    }
    if (this.phase !== 'answering' || attempt !== this.attempt) return;
    this.network.send('requestEvmVerify', { address: this.account.address, signature, nonce: data.nonce, attempt });
  }

  private onStatus(data: any): void {
    if (this.phase === 'stopped' || !data || typeof data !== 'object' || typeof data.verified !== 'boolean') return;
    if (Object.prototype.hasOwnProperty.call(data, 'attempt')) {
      // The world's verdict on a signature: only the one this wallet is waiting for. One for an
      // earlier attempt, or for a signature that was never sent, changes nothing.
      if (data.attempt !== this.attempt || this.phase !== 'answering') return;
      if (!data.verified) {
        this.failed(`the world refused the signature${typeof data.reason === 'string' && data.reason ? ` (${shownName(data.reason, 64)})` : ''}`);
        return;
      }
      if (typeof data.wallet !== 'string' || data.wallet.toLowerCase() !== this.account.address.toLowerCase()) return;
      this.phase = 'verified';
      this.failures = 0;
      this.noteReceiving();
      this.network.send('setEvmTipReceive', { enabled: true });
      this.setTimer(() => {
        if (this.tipsOn) logger.info(`[Tips] Receiving tips at ${this.account.address}`);
        else logger.warn('[Tips] Wallet signed in, but the world did not turn tips on (are tips enabled there?)');
      }, RECEIVE_CHECK_MS);
      return;
    }
    // Without an attempt the world only ever tells a signed-in wallet that it no longer is
    if (data.verified || this.phase !== 'verified') return;
    this.failed('the world signed the wallet out');
  }

  /**
   * The attempt in progress failed. The next one is made after `retryInMs` (by default longer
   * after each failure); after MAX_FAILURES retries have failed too (MAX_FAILURES + 1 failures in
   * a row) there is none on this connection.
   */
  private failed(what: string, retryInMs?: number): void {
    if (this.phase === 'stopped') return;
    logger.warn(`[Tips] Wallet sign-in: ${what}`);
    if (++this.failures > MAX_FAILURES) {
      logger.error(`[Tips] Giving up on the wallet sign-in for this connection after ${MAX_FAILURES} retries`);
      this.stop();
      return;
    }
    this.phase = 'waiting';
    this.setTimer(() => this.request(), retryInMs ?? RETRY_BASE_MS * this.failures);
  }

  /**
   * Puts `fn` on the one timer, in place of whatever was on it. A timer that was replaced or
   * cleared does nothing when it fires all the same.
   */
  private setTimer(fn: () => void, ms: number): void {
    this.clearTimer();
    const timer: unknown = this.schedule(() => {
      if (this.timer !== timer) return;
      this.timer = null;
      fn();
    }, ms);
    this.timer = timer;
  }

  private clearTimer(): void {
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
  }
}
