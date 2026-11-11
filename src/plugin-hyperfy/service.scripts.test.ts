import { afterEach, describe, expect, it, vi } from 'vitest';

// Never read the agent's saved session, start Chromium, or lock this worker down
vi.mock('./hyperfy/src/core/storage.js', () => ({ storage: { get: () => null, set: () => {}, remove: () => {} } }));
vi.mock('./managers/puppeteer-manager', () => {
  const manager = { resetPage: async () => {}, close: async () => {}, registerTexture: async () => undefined, loadEnvironmentHDR: async () => {} };
  return { PuppeteerManager: { getOrCreate: () => manager, getInstance: () => manager } };
});
const { activate, created } = vi.hoisted(() => ({ activate: vi.fn(async (): Promise<boolean> => true), created: vi.fn(() => ({ evaluate: vi.fn() })) }));
vi.mock('./lib/script-api', () => ({ activateWorldScripts: activate, createWorldScripts: created }));

import { HyperfyService } from './service';

const runtime = (): any => ({
  agentId: '00000000-0000-0000-0000-0000000000aa',
  character: { name: 'Coo', templates: {} },
  emitEvent: vi.fn().mockResolvedValue(undefined),
  getEntityById: vi.fn().mockResolvedValue(null),
  updateEntity: vi.fn(),
  getModel: vi.fn(),
});

// Nothing listens here: the world is built, its systems are attached, and the socket closes
const UNREACHABLE = { wsUrl: 'ws://127.0.0.1:9/ws', worldId: '00000000-0000-0000-0000-000000000001' };

/** start() with a WS_URL it refuses, so it returns right after applying the script policy */
async function start(worldScripts: string | undefined) {
  vi.stubEnv('WS_URL', 'ftp://not-a-world');
  if (worldScripts === undefined) delete process.env.HYPERFY_WORLD_SCRIPTS;
  else vi.stubEnv('HYPERFY_WORLD_SCRIPTS', worldScripts);
  const logs = { info: vi.spyOn(console, 'info').mockImplementation(() => {}), error: vi.spyOn(console, 'error').mockImplementation(() => {}) };
  const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as never);
  const text = (spy: typeof logs.info) => spy.mock.calls.map((call) => String(call[0])).join('\n');
  try {
    const service = await HyperfyService.start(runtime());
    return { service: service as any, exit, info: text(logs.info), error: text(logs.error), failed: null as Error | null };
  } catch (error) {
    return { service: null, exit, info: text(logs.info), error: text(logs.error), failed: error as Error };
  }
}

describe('HyperfyService and HYPERFY_WORLD_SCRIPTS', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    activate.mockReset().mockResolvedValue(true);
    created.mockClear();
  });

  it('leaves scripts off by default, without locking the process down, and says so once', async () => {
    const { service, info, exit } = await start(undefined);

    expect(activate).not.toHaveBeenCalled();
    expect(service.worldScriptsSandboxed).toBe(false);
    expect(info.match(/World scripts are off/g)).toHaveLength(1);
    expect(exit).not.toHaveBeenCalled();
  });

  it('treats an unknown value as a configuration error and stays off', async () => {
    const { service, error, info } = await start('unsafe');

    expect(activate).not.toHaveBeenCalled();
    expect(service.worldScriptsSandboxed).toBe(false);
    expect(error).toContain('HYPERFY_WORLD_SCRIPTS="unsafe" is not a known value');
    expect(info).toContain('World scripts are off');
  });

  // That `sandboxed` then survives an unhandled rejection is shown with a real one, in a locked-down
  // child process that runs HyperfyService.start (lib/script-sandbox.child.test.ts, S-08)
  it('activates the sandbox for `sandboxed`, and waits for its self-test before returning', async () => {
    let finished = false;
    activate.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      finished = true;
      return true;
    });
    const { service, info } = await start('sandboxed');

    expect(activate).toHaveBeenCalledTimes(1);
    expect(finished).toBe(true);
    expect(service.worldScriptsSandboxed).toBe(true);
    expect(info).toContain('World scripts run sandboxed');
  });

  it('hands the loader a script runtime only when scripts are sandboxed', async () => {
    const off = await start(undefined);
    await off.service.connect(UNREACHABLE).catch(() => {});
    await off.service.stop();
    expect(created).not.toHaveBeenCalled();

    const sandboxed = await start('sandboxed');
    await sandboxed.service.connect(UNREACHABLE).catch(() => {});
    await sandboxed.service.stop();
    expect(created).toHaveBeenCalledTimes(1);
  });

  it('exits the process when the sandbox cannot be activated, before any world is created', async () => {
    activate.mockResolvedValue(false);

    const { failed, exit, error } = await start('sandboxed');

    expect(exit).toHaveBeenCalledWith(1);
    expect(failed?.message).toBe('process.exit(1)');
    expect(error).toContain('could not be made safe in this runtime');
    expect(created).not.toHaveBeenCalled();
  });
});
