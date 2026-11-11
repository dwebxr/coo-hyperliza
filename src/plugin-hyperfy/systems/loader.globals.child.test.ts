import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'tsup';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/*
 * The agent process has no browser globals: nothing the plugin loads puts a `window` or a
 * `document` on globalThis, its loader parses the bundled models without them, and PGLite (which
 * will not start next to a `window`) starts in the same process. Checked in a
 * child process (test-support/globals-child.ts) under Bun, the agent's runtime, and under Node,
 * with the engine's storage module (localstorage.json) and Chromium replaced by stand-ins.
 *
 * Without `bun` on PATH the Bun run FAILS. Set SANDBOX_TESTS_WITHOUT_BUN=1 to skip it, knowingly.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const support = path.join(here, '../test-support');
const repo = path.resolve(here, '../../..');
const engineStorage = realpathSync(path.join(repo, 'src/plugin-hyperfy/hyperfy/src/core/storage.js'));
// PGLite as @elizaos/plugin-sql (a dependency of this project) resolves it
const pglite = createRequire(fileURLToPath(import.meta.resolve('@elizaos/plugin-sql'))).resolve('@electric-sql/pglite');
const hasBun = spawnSync('bun', ['--version'], { encoding: 'utf8' }).status === 0;
const withoutBun = process.env.SANDBOX_TESTS_WITHOUT_BUN === '1';

let dir = '';
let bundle = '';

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'coo-globals-child-'));
  symlinkSync(path.join(repo, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  await build({
    entry: { 'globals-child': path.join(support, 'globals-child.ts') },
    outDir: dir,
    format: ['esm'],
    platform: 'node',
    target: 'esnext',
    config: false,
    silent: true,
    clean: false,
    dts: false,
    sourcemap: false,
    tsconfig: path.join(repo, 'tsconfig.build.json'),
    esbuildPlugins: [
      {
        name: 'child-stand-ins',
        setup(esbuild) {
          esbuild.onResolve({ filter: /(^|\/)storage(\.js)?$/ }, (args) => {
            const target = path.resolve(args.resolveDir, args.path);
            const isEngineStorage = [target, `${target}.js`].some((file) => existsSync(file) && realpathSync(file) === engineStorage);
            return isEngineStorage ? { path: path.join(support, 'sandbox/storage-stub.ts') } : null;
          });
          esbuild.onResolve({ filter: /managers\/puppeteer-manager(\.js)?$/ }, () => ({ path: path.join(support, 'sandbox/puppeteer-stub.ts') }));
        },
      },
    ],
  });
  bundle = path.join(dir, 'globals-child.js');
  // The stand-in must really have replaced the module that touches localstorage.json
  expect(readFileSync(engineStorage, 'utf8')).toContain('error writing to storage file');
  expect(readFileSync(bundle, 'utf8')).not.toContain('error writing to storage file');
}, 120_000);

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const none = { window: false, document: false };

describe.each(['bun', 'node'])('the agent process under %s', (runtime) => {
  it.skipIf(runtime === 'bun' && !hasBun && withoutBun)('has no window or document after loading the plugin, building a world and parsing its bundled models; the models parse and PGLite starts', () => {
    if (runtime === 'bun' && !hasBun) throw new Error('`bun` is not on PATH (set SANDBOX_TESTS_WITHOUT_BUN=1 to skip the Bun run)');
    const reportFile = path.join(dir, `report-${runtime}.json`);
    // No environment beyond what the runtime needs to start
    const result = spawnSync(runtime, [bundle, path.join(repo, 'src/plugin-hyperfy/public'), path.join(repo, 'src/plugin-hyperfy/physx/loadPhysX.js'), pglite, reportFile], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 60_000,
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
    });
    if (!existsSync(reportFile)) throw new Error(`The child (${runtime}) ended with status ${result.status} and no report.\n${result.stdout.slice(-2000)}\n${result.stderr.slice(-2000)}`);
    const report = JSON.parse(readFileSync(reportFile, 'utf8'));
    expect(report.fatal).toBeUndefined();
    expect(report).toMatchObject({ runtime, plugin: 'hyperfy', physx: 'number', afterImport: none, afterWorld: none, afterParse: none });
    // The scene, the avatar (with its embedded textures: there is no DOM to decode them, and none
    // is needed, the render page draws them) and an emote's animation
    expect(report.parsed.model.meshes).toBeGreaterThan(0);
    expect(report.parsed.avatar.meshes).toBeGreaterThan(0);
    expect(report.parsed.avatar.images).toBeGreaterThan(0);
    expect(report.parsed.emote.tracks).toBeGreaterThan(10);
    expect(report.parsed.emote.duration).toBeGreaterThan(1);
    // The embedded database elizaOS can use instead of Postgres starts in such a process
    expect(report.pglite).toEqual({ two: 2 });
  }, 90_000);
});
