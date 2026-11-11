import { randomBytes } from 'node:crypto';
import { type IAgentRuntime, MODEL_SETTINGS, ModelType, logger } from '@elizaos/core';
import { describeUrl } from './plugin-hyperfy/lib/log-url';
import { TIP_WALLET_ENV } from './plugin-hyperfy/lib/tip-wallet';

/*
 * What the agent puts into elizaOS's character secrets, and the startup warning about who can
 * read them. elizaOS (1.7.2) stores character secrets in the agent's database record and the
 * local API returns that record (GET /api/agents/<id>); merging keeps every stored key unless the
 * new value for it is null, which deletes it.
 */

type Env = Record<string, string | undefined>;

// core's getModelSettings reads DEFAULT_<param> and <model type>_<param> for every model type, for
// the params MODEL_SETTINGS has DEFAULT_ entries for (MAX_TOKENS, TEMPERATURE, TOP_P, ...)
const MODEL_PARAMS = Object.keys(MODEL_SETTINGS)
  .filter((key) => key.startsWith('DEFAULT_'))
  .map((key) => key.slice('DEFAULT_'.length));
const PER_MODEL_SETTINGS = [...new Set(Object.values(ModelType))].flatMap((type) => MODEL_PARAMS.map((param) => `${type}_${param}`));

// What elizaOS 1.7.2 itself reads through runtime.getSetting (core, server, plugin-sql).
// getSetting never falls back to process.env, so these keep their live value in the secrets.
// (core's validateApiKeys also reads ANTHROPIC_API_KEY / OPENAI_API_KEY that way, but neither the
// CLI nor the server calls it; src/anthropic-models.ts reads process.env first. plugin-bootstrap
// reads WORLD_ID, but this project does not load plugin-bootstrap.)
const ELIZA_RUNTIME_SETTINGS: ReadonlySet<string> = new Set([
  'POSTGRES_URL',
  'PGLITE_DATA_DIR',
  'USE_MULTI_STEP',
  'MAX_MULTISTEP_ITERATIONS',
  'MULTISTEP_PARSE_RETRIES',
  'MULTISTEP_SUMMARY_PARSE_RETRIES',
  'BOOTSTRAP_DEFLLMOFF',
  'BOOTSTRAP_KEEP_RESP',
  'ALWAYS_RESPOND_CHANNELS',
  'ALWAYS_RESPOND_SOURCES',
  'SHOULD_RESPOND_BYPASS_TYPES',
  'SHOULD_RESPOND_BYPASS_SOURCES',
  'PROVIDERS_TOTAL_TIMEOUT_MS',
  'EMBEDDING_DIMENSION',
  'SESSION_TIMEOUT_MINUTES',
  'SESSION_MAX_DURATION_MINUTES',
  'SESSION_WARNING_THRESHOLD_MINUTES',
  'SESSION_AUTO_RENEW',
  ...Object.values(MODEL_SETTINGS),
  ...PER_MODEL_SETTINGS,
]);

// Read from process.env only, and never to be stored in the agent record
const NEVER_STORED = [TIP_WALLET_ENV, 'ELIZA_SERVER_AUTH_TOKEN', 'SERVER_API_KEY', 'SECRET_SALT'];

/**
 * The character's secrets. The .env file is not copied in. Every key of the .env file gets
 * null, which deletes a stored copy of it, except:
 * - settings elizaOS reads through runtime.getSetting keep their current value from the
 *   environment;
 * - keys elizaOS copies from the environment into the secrets on its own (`coreCopies`: the
 *   CLI's allow-list, core's getAllowedEnvVars(); null = it copies the whole environment) are
 *   left out while the environment has them: a null here would replace the live value it copies.
 *   Those stay in the stored record (e.g. POSTGRES_URL).
 * TIP_WALLET_PRIVATE_KEY, ELIZA_SERVER_AUTH_TOKEN, SERVER_API_KEY and SECRET_SALT always get null,
 * so they are never stored even when elizaOS copies the whole environment.
 * A null secret makes runtime.getSetting return null for that key even when process.env has it;
 * code in this project reads its configuration from process.env.
 */
export function characterSecrets(
  fileKeys: Iterable<string>,
  { env, coreCopies }: { env: Env; coreCopies: ReadonlySet<string> | null }
): Record<string, string | null> {
  const secrets: Record<string, string | null> = {};
  for (const key of new Set([...fileKeys, ...NEVER_STORED])) {
    const live = env[key];
    if (NEVER_STORED.includes(key)) {
      secrets[key] = null;
    } else if (ELIZA_RUNTIME_SETTINGS.has(key) && live !== undefined) {
      secrets[key] = live;
    } else if (live !== undefined && (coreCopies === null || coreCopies.has(key))) {
      continue;
    } else {
      secrets[key] = null;
    }
  }
  return secrets;
}

/**
 * Stored secret keys nothing needs: neither a setting elizaOS reads through getSetting nor a name
 * elizaOS copies from the environment itself (those are rewritten on every start that has them;
 * one on the allow-list that the environment lacks is kept). This catches stored keys that are
 * not in .env, whatever stored them.
 */
export function staleSecretKeys(storedKeys: Iterable<string>, { env, coreCopies }: { env: Env; coreCopies: ReadonlySet<string> | null }): string[] {
  return [...storedKeys].filter(
    (key) => !ELIZA_RUNTIME_SETTINGS.has(key) && !(coreCopies === null ? env[key] !== undefined : coreCopies.has(key))
  );
}

const storedSecretKeys = async (runtime: IAgentRuntime): Promise<string[]> => {
  const stored = (await runtime.getAgent(runtime.agentId))?.settings?.secrets;
  return stored && typeof stored === 'object' ? Object.keys(stored) : [];
};

/**
 * Deletes the stale stored secrets (staleSecretKeys) from the agent's database record, through the
 * same merge as the start (a null deletes the key), and then from this run's copy. Call once the
 * agent is initialized. Returns the key names the record no longer has; when the database refused
 * the update (or the keys are still there afterwards) that is logged as an error, and this run's
 * copy is left as it is.
 */
export async function removeStaleStoredSecrets(
  runtime: IAgentRuntime,
  options: { env: Env; coreCopies: ReadonlySet<string> | null }
): Promise<string[]> {
  const stale = staleSecretKeys(await storedSecretKeys(runtime), options);
  if (!stale.length) return [];
  const updated = await runtime.updateAgent(runtime.agentId, { settings: { secrets: Object.fromEntries(stale.map((key) => [key, null])) } });
  const remaining = new Set(await storedSecretKeys(runtime));
  const deleted = updated ? stale.filter((key) => !remaining.has(key)) : [];
  if (deleted.length < stale.length) {
    const kept = stale.filter((key) => !deleted.includes(key));
    logger.error(`[Secrets] Could not delete ${kept.length} stored secret(s) no longer in use from the agent record (${kept.join(', ')}); they are still stored`);
  }
  if (!deleted.length) return [];
  const live = [runtime.character.secrets, runtime.character.settings?.secrets];
  for (const holder of live) {
    if (holder && typeof holder === 'object') for (const key of deleted) delete (holder as Record<string, unknown>)[key];
  }
  logger.info(`[Secrets] Deleted ${deleted.length} stored secret(s) no longer in use from the agent record: ${deleted.join(', ')}`);
  return deleted;
}

const isLoopback = (host: string) =>
  host === 'localhost' || host === '::1' || host === '[::1]' || /^127(\.\d{1,3}){3}$/.test(host);

const ENV_ENDPOINT_RISK =
  'GET /api/system/env/local returns the .env file the server finds (every key, the tip wallet key included) and POST rewrites it; ' +
  'the API also returns the stored agent record, and the API and its Socket.IO connections control the agent and stream its logs';

/**
 * Safe defaults for the bundled elizaOS web UI/API, applied to `env` (process.env) before the
 * server starts; it reads them when it starts listening and on every request or Socket.IO
 * handshake. Only `elizaos start` / `dev` without --character load the project, so only those
 * starts get these defaults: values set in .env are what holds on every start path.
 * - Unset SERVER_HOST becomes 127.0.0.1 (the server would bind 0.0.0.0).
 * - Unset ELIZA_SERVER_AUTH_TOKEN (REST, X-API-KEY) becomes a random token held only in this
 *   process's environment, which locks the API for this run. The server's own clients send
 *   whatever token is set.
 * - Unset SERVER_API_KEY (Socket.IO handshakes) becomes the REST token: the bundled web UI sends
 *   the one key it stores for both, so an operator's token unlocks both and a random one locks both.
 * Returns what to log; no token is ever in it.
 */
export function secureServerDefaults(env: Env, newToken: () => string = () => randomBytes(32).toString('hex')): string[] {
  const lines: string[] = [];
  if (!env.SERVER_HOST) {
    env.SERVER_HOST = '127.0.0.1';
    lines.push('[Security] SERVER_HOST is not set: the elizaOS web UI/API listens on 127.0.0.1 only (this machine).');
  }
  const locked = !env.ELIZA_SERVER_AUTH_TOKEN?.trim();
  if (locked) {
    env.ELIZA_SERVER_AUTH_TOKEN = newToken();
    lines.push(
      '[Security] ELIZA_SERVER_AUTH_TOKEN is not set, so the elizaOS web UI/API and its Socket.IO connections are locked for this run (they require a random token that is not shown anywhere). ' +
        `Unlocked, anyone who could reach them could use them: ${ENV_ENDPOINT_RISK}. ` +
        'To use the web UI or API, set ELIZA_SERVER_AUTH_TOKEN in .env and restart; clients send it as X-API-KEY.'
    );
  }
  if (!env.SERVER_API_KEY?.trim()) env.SERVER_API_KEY = env.ELIZA_SERVER_AUTH_TOKEN;
  if (!locked && !isLoopback(env.SERVER_HOST)) {
    lines.push(
      `[Security] Warning: the elizaOS web UI/API listens on ${env.SERVER_HOST}, protected only by ELIZA_SERVER_AUTH_TOKEN. ` +
        `Whoever has the token and can reach it can use it: ${ENV_ENDPOINT_RISK}.`
    );
  }
  return lines;
}

/**
 * The Anthropic SDK reads ANTHROPIC_BASE_URL (and ANTHROPIC_AUTH_TOKEN, ANTHROPIC_CUSTOM_HEADERS)
 * from the environment: a base URL sends every Claude request, with the API key, there. The
 * operator's .env is trusted, so this only says where (the URL as describeUrl writes it).
 */
export function modelEndpointWarnings(env: Env): string[] {
  const base = env.ANTHROPIC_BASE_URL?.trim();
  if (!base) return [];
  return [`[Security] ANTHROPIC_BASE_URL is set: every Claude request, with the API key, goes to ${describeUrl(base)} instead of Anthropic's API.`];
}

/**
 * What SENTRY_DSN becomes when the operator set none. The elizaOS server (initializeServer) uses
 * `process.env.SENTRY_DSN?.trim() || <elizaOS's own DSN>`, so an unset or empty value sends error
 * reports to elizaOS's Sentry project. This value does not parse as a DSN: Sentry's client is
 * then created without a transport, so it sends nothing and sets up none of its integrations
 * (Sentry logs "Invalid Sentry Dsn: off" once).
 */
export const SENTRY_DSN_OFF = 'off';

/**
 * Turns elizaOS's default error reporting off for this run when SENTRY_DSN is unset or empty, and
 * leaves an operator's DSN alone. Applied to `env` (process.env) when the project is loaded, which
 * `elizaos start` does before the server starts. Returns what to log.
 */
export function errorReportingDefaults(env: Env): string[] {
  if (env.SENTRY_DSN?.trim()) return [];
  env.SENTRY_DSN = SENTRY_DSN_OFF;
  return [
    '[Security] SENTRY_DSN is not set, so error reporting is off for this run: elizaOS would otherwise send its error reports ' +
      '(which can hold chat text, file paths and settings) to its own Sentry project. Sentry reports the value "off" as an invalid DSN once for this. ' +
      'Set SENTRY_DSN to your own DSN to report there.',
  ];
}
