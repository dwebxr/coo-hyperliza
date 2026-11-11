import { afterEach, describe, expect, it, vi } from 'vitest';

const create = vi.fn();
const constructed: { apiKey?: string }[] = [];
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create };
    constructor(options: { apiKey?: string }) {
      constructed.push(options);
    }
  },
}));

import { AgentRuntime, ElizaOS, ModelType, logger, setAllowedEnvVars, type Character, type IAgentRuntime, type UUID } from '@elizaos/core';
import * as sql from '@elizaos/plugin-sql';
import { characterSecrets, removeStaleStoredSecrets, secureServerDefaults, staleSecretKeys } from './agent-secrets';
import { anthropicModelsPlugin } from './anthropic-models';

// The elizaOS CLI's own allow-list (cli/dist/index.js CORE_ALLOWED_VARS); no installed plugin declares more
const CLI_ALLOWED = new Set(['POSTGRES_URL', 'PGLITE_DATA_DIR', 'SERVER_PORT', 'SERVER_HOST', 'LOG_LEVEL', 'LOG_FORMAT', 'NODE_ENV', 'BUN_ENV', 'ELIZAOS_DATA_DIR', 'ELIZAOS_CONFIG_DIR']);

// What a .env file of this project holds, and the environment the CLI loads it into
const ENV_FILE = {
  ANTHROPIC_API_KEY: 'sk-live',
  ELEVENLABS_XI_API_KEY: 'el-live',
  OPENAI_API_KEY: 'oa-live',
  SECRET_SALT: 'salt-live',
  ELIZA_SERVER_AUTH_TOKEN: 'token-live',
  POSTGRES_URL: 'postgres://live/eliza',
  SERVER_PORT: '3001',
  USE_MULTI_STEP: 'false',
  WS_URL: 'wss://world.test/ws',
};

afterEach(() => {
  vi.unstubAllEnvs();
  setAllowedEnvVars(null);
});

describe('characterSecrets', () => {
  it('deletes every key the .env file had, and the tip key, except what elizaOS needs or copies itself', () => {
    const secrets = characterSecrets(Object.keys(ENV_FILE), { env: ENV_FILE, coreCopies: CLI_ALLOWED });
    expect(secrets).toEqual({
      ANTHROPIC_API_KEY: null,
      ELEVENLABS_XI_API_KEY: null,
      OPENAI_API_KEY: null,
      SECRET_SALT: null,
      ELIZA_SERVER_AUTH_TOKEN: null,
      WS_URL: null,
      TIP_WALLET_PRIVATE_KEY: null,
      SERVER_API_KEY: null,
      // Read by plugin-sql / core through runtime.getSetting: kept live, as before
      POSTGRES_URL: 'postgres://live/eliza',
      USE_MULTI_STEP: 'false',
      // SERVER_PORT is left out: the CLI copies it from the environment, and a null would replace that
    });
  });

  it('tombstones a key the environment no longer has even when elizaOS would copy it', () => {
    expect(characterSecrets(['SERVER_PORT', 'POSTGRES_URL'], { env: {}, coreCopies: CLI_ALLOWED })).toEqual({
      SERVER_PORT: null,
      POSTGRES_URL: null,
      TIP_WALLET_PRIVATE_KEY: null,
      ELIZA_SERVER_AUTH_TOKEN: null,
      SERVER_API_KEY: null,
      SECRET_SALT: null,
    });
  });

  it('shadows nothing elizaOS needs when it copies the whole environment (no allow-list), and never stores the tip key, API token or salt', () => {
    expect(characterSecrets(Object.keys(ENV_FILE), { env: ENV_FILE, coreCopies: null })).toEqual({
      POSTGRES_URL: 'postgres://live/eliza',
      USE_MULTI_STEP: 'false',
      TIP_WALLET_PRIVATE_KEY: null,
      ELIZA_SERVER_AUTH_TOKEN: null,
      SERVER_API_KEY: null,
      SECRET_SALT: null,
    });
  });
});

describe('staleSecretKeys', () => {
  it("keeps every per-model-type setting core's getModelSettings reads (e.g. OBJECT_SMALL_TEMPERATURE)", () => {
    const tuning = ['OBJECT_SMALL_TEMPERATURE', 'TEXT_LARGE_TOP_P', 'IMAGE_DESCRIPTION_MAX_TOKENS', 'TRANSCRIPTION_SEED', 'DEFAULT_MIN_P', 'MODEL_FREQ_PENALTY'];
    expect(staleSecretKeys(tuning, { env: {}, coreCopies: CLI_ALLOWED })).toEqual([]);
    const env = Object.fromEntries(tuning.map((key) => [key, '0.5']));
    expect(characterSecrets(tuning, { env, coreCopies: CLI_ALLOWED })).toMatchObject(env);
  });

  it('picks stored keys that are neither read by elizaOS nor copied by it', () => {
    const stored = ['OPENAI_API_KEY', 'POSTGRES_URL', 'SERVER_HOST', 'USE_MULTI_STEP', 'TEXT_SMALL_MAX_TOKENS', 'OLD_SECRET'];
    expect(staleSecretKeys(stored, { env: {}, coreCopies: CLI_ALLOWED })).toEqual(['OPENAI_API_KEY', 'OLD_SECRET']);
    // Without an allow-list elizaOS copies whatever the environment has
    expect(staleSecretKeys(stored, { env: { OLD_SECRET: 'x' }, coreCopies: null })).toEqual(['OPENAI_API_KEY', 'SERVER_HOST']);
  });
});

describe('character secrets against the real elizaOS store (core 1.7.2 + plugin-sql on in-memory PGLite)', () => {
  const agentId = '00000000-0000-4000-8000-00000000c00c' as UUID;

  async function store() {
    const adapter = sql.createDatabaseAdapter({ dataDir: 'memory://' }, agentId);
    await adapter.init();
    // Migrations normally run after the agent record is written; create the tables first
    const migrator = new AgentRuntime({ agentId, character: { name: 'Coo', bio: [] }, plugins: [] });
    migrator.registerDatabaseAdapter(adapter);
    await migrator.registerPlugin(sql.plugin);
    await migrator.runPluginMigrations();
    return adapter;
  }

  /** Starts the agent the way the elizaOS server does; `init` runs where the project's init runs (after initialize). */
  async function boot(
    adapter: Awaited<ReturnType<typeof store>>,
    secrets: Record<string, unknown>,
    init?: (runtime: IAgentRuntime) => Promise<void>
  ): Promise<IAgentRuntime> {
    const character: Character = { id: agentId, name: 'Coo', bio: [], settings: { secrets } };
    const eliza = new ElizaOS();
    const [id] = await eliza.addAgents([{ character, plugins: [], databaseAdapter: adapter, ...(init ? { init } : {}) }]);
    await eliza.startAgents([id]);
    return eliza.getAgent(id)!;
  }

  it('removes the copies earlier versions stored, keeps POSTGRES_URL working, and the live Anthropic key wins', async () => {
    for (const [key, value] of Object.entries(ENV_FILE)) vi.stubEnv(key, value);
    setAllowedEnvVars(CLI_ALLOWED);
    const adapter = await store();

    // An earlier run: the whole .env spread into the secrets, with a since revoked Anthropic key
    const before = await boot(adapter, { ...ENV_FILE, ANTHROPIC_API_KEY: 'sk-revoked' });
    expect(before.getSetting('ANTHROPIC_API_KEY')).toBe('sk-revoked');
    expect(Object.keys((await adapter.getAgent(agentId))!.settings!.secrets as object)).toEqual(expect.arrayContaining(['ANTHROPIC_API_KEY', 'SECRET_SALT', 'ELIZA_SERVER_AUTH_TOKEN']));
    // Merely no longer copying .env leaves those copies in the record
    const untouched = await boot(adapter, {});
    expect(untouched.getSetting('ANTHROPIC_API_KEY')).toBe('sk-revoked');

    const runtime = await boot(adapter, characterSecrets(Object.keys(ENV_FILE), { env: process.env, coreCopies: CLI_ALLOWED }));
    const stored = Object.keys((await adapter.getAgent(agentId))!.settings!.secrets as object);
    for (const key of ['ANTHROPIC_API_KEY', 'ELEVENLABS_XI_API_KEY', 'OPENAI_API_KEY', 'SECRET_SALT', 'ELIZA_SERVER_AUTH_TOKEN', 'WS_URL']) {
      expect(stored, key).not.toContain(key);
    }
    expect(stored).toEqual(expect.arrayContaining(['POSTGRES_URL', 'SERVER_PORT', 'USE_MULTI_STEP']));
    // Anything else stored is what the CLI copies from the environment on its own (e.g. NODE_ENV)
    for (const key of stored) expect(CLI_ALLOWED.has(key) || key === 'USE_MULTI_STEP', key).toBe(true);
    expect(runtime.getSetting('POSTGRES_URL')).toBe('postgres://live/eliza');
    expect(runtime.getSetting('SERVER_PORT')).toBe('3001');
    // The tombstone hides the key from getSetting, which never reads process.env...
    expect(runtime.getSetting('ANTHROPIC_API_KEY')).toBeNull();

    // ...and the model handler reads process.env first, so it calls Claude with the live key
    create.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } });
    const models = anthropicModelsPlugin.models as Record<string, (rt: IAgentRuntime, params: unknown) => Promise<unknown>>;
    await models[ModelType.TEXT_SMALL](runtime, { prompt: 'hi' });
    expect(constructed.at(-1)?.apiKey).toBe('sk-live');
  });

  it('deletes stored secrets whose keys are no longer in .env, at agent init', async () => {
    const before = { ANTHROPIC_API_KEY: 'sk-live', OPENAI_API_KEY: 'oa-old', LEGACY_TOKEN: 'leg-old', POSTGRES_URL: 'postgres://live/eliza', USE_MULTI_STEP: 'false' };
    // Today's .env: OPENAI_API_KEY and LEGACY_TOKEN were removed (or moved to the shell)
    const now = { ANTHROPIC_API_KEY: 'sk-live', POSTGRES_URL: 'postgres://live/eliza' };
    for (const [key, value] of Object.entries(now)) vi.stubEnv(key, value);
    setAllowedEnvVars(CLI_ALLOWED);
    const adapter = await store();
    await boot(adapter, { ...before }); // what an earlier version stored
    const storedKeys = async () => Object.keys(((await adapter.getAgent(agentId))!.settings!.secrets ?? {}) as object);

    // The tombstones from today's .env alone do not reach the removed keys
    const secrets = characterSecrets(Object.keys(now), { env: process.env, coreCopies: CLI_ALLOWED });
    await boot(adapter, secrets);
    expect(await storedKeys()).toEqual(expect.arrayContaining(['OPENAI_API_KEY', 'LEGACY_TOKEN']));

    // The project's init (src/index.ts) cleans them up from the stored inventory
    let deleted: string[] = [];
    const runtime = await boot(adapter, secrets, async (rt) => {
      deleted = await removeStaleStoredSecrets(rt, { env: process.env, coreCopies: CLI_ALLOWED });
    });
    expect(deleted.sort()).toEqual(['LEGACY_TOKEN', 'OPENAI_API_KEY']);
    const after = await storedKeys();
    expect(after).not.toContain('OPENAI_API_KEY');
    expect(after).not.toContain('LEGACY_TOKEN');
    // Kept: what elizaOS copies itself, and a setting it reads through getSetting
    expect(after).toEqual(expect.arrayContaining(['POSTGRES_URL', 'USE_MULTI_STEP']));
    expect(runtime.getSetting('OPENAI_API_KEY')).toBeNull();
    expect(runtime.getSetting('POSTGRES_URL')).toBe('postgres://live/eliza');
  });

  it('claims nothing, and leaves this run alone, when the database refuses the cleanup', async () => {
    const now = { ANTHROPIC_API_KEY: 'sk-live', POSTGRES_URL: 'postgres://live/eliza' };
    for (const [key, value] of Object.entries(now)) vi.stubEnv(key, value);
    setAllowedEnvVars(CLI_ALLOWED);
    const adapter = await store();
    await boot(adapter, { ...now, OPENAI_API_KEY: 'oa-old' });
    const secrets = characterSecrets(Object.keys(now), { env: process.env, coreCopies: CLI_ALLOWED });
    vi.spyOn(logger, 'error').mockImplementation(() => {});
    const errors = vi.spyOn(logger, 'error');
    let deleted: string[] = ['not called'];
    const runtime = await boot(adapter, secrets, async (rt) => {
      // plugin-sql's update returns false when its transaction fails
      vi.spyOn(adapter, 'updateAgent').mockResolvedValue(false);
      deleted = await removeStaleStoredSecrets(rt, { env: process.env, coreCopies: CLI_ALLOWED });
    });
    expect(deleted).toEqual([]);
    expect(String(errors.mock.calls.at(-1)?.[0])).toContain('Could not delete 1 stored secret(s)');
    expect(runtime.getSetting('OPENAI_API_KEY')).toBe('oa-old');
    expect(Object.keys((await adapter.getAgent(agentId))!.settings!.secrets as object)).toContain('OPENAI_API_KEY');
  });
});

describe('secureServerDefaults', () => {
  const token = () => 'generated-token-123';

  it('listens on loopback and locks the API when neither is configured, without logging the token', () => {
    const env: Record<string, string | undefined> = {};
    const lines = secureServerDefaults(env, token);
    // Socket.IO handshakes take the same token (the web UI sends one key for both)
    expect(env).toEqual({ SERVER_HOST: '127.0.0.1', ELIZA_SERVER_AUTH_TOKEN: 'generated-token-123', SERVER_API_KEY: 'generated-token-123' });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('listens on 127.0.0.1 only');
    expect(lines[1]).toContain('the elizaOS web UI/API and its Socket.IO connections are locked for this run');
    expect(lines[1]).toContain('GET /api/system/env/local returns the .env file');
    expect(lines.join(' ')).not.toContain('generated-token-123');
  });

  it('treats an empty SERVER_HOST and a blank token as unset (the server would bind 0.0.0.0 / accept a blank token)', () => {
    const env: Record<string, string | undefined> = { SERVER_HOST: '', ELIZA_SERVER_AUTH_TOKEN: '  ', SERVER_API_KEY: ' ' };
    secureServerDefaults(env, token);
    expect(env).toEqual({ SERVER_HOST: '127.0.0.1', ELIZA_SERVER_AUTH_TOKEN: 'generated-token-123', SERVER_API_KEY: 'generated-token-123' });
  });

  it("keeps the operator's settings, and warns when the API is reachable beyond this machine", () => {
    const local: Record<string, string | undefined> = { SERVER_HOST: '127.0.0.1', ELIZA_SERVER_AUTH_TOKEN: 'mine' };
    expect(secureServerDefaults(local, token)).toEqual([]);
    // The operator's token also unlocks Socket.IO, so the web UI works with the one key it stores
    expect(local).toEqual({ SERVER_HOST: '127.0.0.1', ELIZA_SERVER_AUTH_TOKEN: 'mine', SERVER_API_KEY: 'mine' });
    const own: Record<string, string | undefined> = { SERVER_HOST: '127.0.0.1', ELIZA_SERVER_AUTH_TOKEN: 'mine', SERVER_API_KEY: 'socket' };
    secureServerDefaults(own, token);
    expect(own.SERVER_API_KEY).toBe('socket');
    const wide: Record<string, string | undefined> = { SERVER_HOST: '0.0.0.0', ELIZA_SERVER_AUTH_TOKEN: 'mine' };
    const [warning] = secureServerDefaults(wide, token);
    expect(warning).toContain('listens on 0.0.0.0, protected only by ELIZA_SERVER_AUTH_TOKEN');
    expect(warning).toContain('/api/system/env/local');
    expect(wide.ELIZA_SERVER_AUTH_TOKEN).toBe('mine');
  });

  it('locks the API with a fresh random token by default', () => {
    const a: Record<string, string | undefined> = { SERVER_HOST: '127.0.0.1' };
    const b: Record<string, string | undefined> = { SERVER_HOST: '127.0.0.1' };
    secureServerDefaults(a);
    secureServerDefaults(b);
    expect(a.ELIZA_SERVER_AUTH_TOKEN).toMatch(/^[0-9a-f]{64}$/);
    expect(a.ELIZA_SERVER_AUTH_TOKEN).not.toBe(b.ELIZA_SERVER_AUTH_TOKEN);
  });
});

