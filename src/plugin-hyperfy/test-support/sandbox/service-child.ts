/**
 * Entry of a child process (bundled and spawned by lib/script-sandbox.child.test.ts, under Bun and
 * Node): starts the real HyperfyService with HYPERFY_WORLD_SCRIPTS from its environment and a
 * WS_URL it refuses, so that start() returns right after applying the script policy and no world
 * is built. Then it raises an unhandled promise rejection and, if the process is still alive
 * shortly after, reports so (argv: report file).
 *
 * With `sandboxed` the process is locked down and HyperfyService installs the handler that logs
 * and survives the rejection. With `off` nothing is installed, so the runtime's default applies
 * and the process ends without a report.
 *
 * Bundled with the engine's storage module and Chromium replaced, as child.ts is.
 */
import { writeFileSync } from 'node:fs';
import { HyperfyService } from '../../service';

const reportFile = process.argv[2];
const logs: string[] = [];
for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
  console[level] = (...args: unknown[]) => void logs.push(`${level}: ${args.map((arg) => (typeof arg === 'string' ? arg : String(arg))).join(' ')}`);
}

const runtime = {
  agentId: '00000000-0000-0000-0000-0000000000aa',
  character: { name: 'Coo', templates: {} },
  emitEvent: async () => {},
  getEntityById: async () => null,
  updateEntity: async () => {},
  getModel: () => undefined,
  getSetting: () => undefined,
  getService: () => null,
};

await HyperfyService.start(runtime as never);
void Promise.reject(new Error('unhandled in the agent'));
setTimeout(() => {
  writeFileSync(reportFile, JSON.stringify({ survived: true, logs }));
  process.exit(0);
}, 300);
