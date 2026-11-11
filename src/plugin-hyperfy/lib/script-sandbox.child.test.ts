import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'tsup';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Scenario } from '../test-support/sandbox/scenario';

/*
 * World scripts under real SES lockdown, in a child process per scenario: test-support/sandbox/child.ts
 * builds a real engine world with the agent's own loader, controls and actions, loads one app
 * (model + script) through them, and reports as JSON. test-support/sandbox/service-child.ts starts
 * the real HyperfyService. The vitest worker itself is never locked down.
 *
 * The children are bundled once into a temporary directory, with the engine's storage module (which
 * reads and writes localstorage.json) and Chromium replaced by stand-ins. Every scenario runs under
 * Bun, the agent's runtime, and under Node.
 *
 * Without `bun` on PATH the Bun runs FAIL. Set SANDBOX_TESTS_WITHOUT_BUN=1 to skip them instead,
 * knowingly: the agent runs under Bun, so a pass without them says nothing about the agent.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const support = path.join(here, '../test-support/sandbox');
const repo = path.resolve(here, '../../..');
const fixture = (name: string) => readFileSync(path.join(support, name), 'utf8');
const engineStorage = realpathSync(path.join(repo, 'src/plugin-hyperfy/hyperfy/src/core/storage.js'));

const hasBun = spawnSync('bun', ['--version'], { encoding: 'utf8' }).status === 0;
const withoutBun = process.env.SANDBOX_TESTS_WITHOUT_BUN === '1';
if (!hasBun) {
  console.warn(
    withoutBun
      ? '[script-sandbox.child.test] `bun` is not on PATH: the Bun runs are SKIPPED (SANDBOX_TESTS_WITHOUT_BUN=1). The agent runs under Bun.'
      : '[script-sandbox.child.test] `bun` is not on PATH: the Bun runs FAIL. Install Bun, or set SANDBOX_TESTS_WITHOUT_BUN=1 to skip them.'
  );
}

let dir = '';
let bundle = '';
let serviceBundle = '';
let scenarios = 0;

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'coo-sandbox-child-'));
  // Packages stay external, as in the real build, and resolve through this link
  symlinkSync(path.join(repo, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  await build({
    entry: { child: path.join(support, 'child.ts'), 'service-child': path.join(support, 'service-child.ts') },
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
        name: 'sandbox-child-stand-ins',
        setup(esbuild) {
          // By the resolved path, whoever imports it (service.ts does, as well as the engine)
          esbuild.onResolve({ filter: /(^|\/)storage(\.js)?$/ }, (args) => {
            const target = path.resolve(args.resolveDir, args.path);
            const isEngineStorage = [target, `${target}.js`].some((file) => existsSync(file) && realpathSync(file) === engineStorage);
            return isEngineStorage ? { path: path.join(support, 'storage-stub.ts') } : null;
          });
          esbuild.onResolve({ filter: /managers\/puppeteer-manager(\.js)?$/ }, () => ({ path: path.join(support, 'puppeteer-stub.ts') }));
        },
      },
    ],
  });
  bundle = path.join(dir, 'child.js');
  serviceBundle = path.join(dir, 'service-child.js');
  // The stand-in must really have replaced the module that touches localstorage.json
  const storageSource = readFileSync(engineStorage, 'utf8');
  expect(storageSource).toContain('error writing to storage file');
  for (const file of [bundle, serviceBundle]) expect(readFileSync(file, 'utf8')).not.toContain('error writing to storage file');
  expect(readFileSync(bundle, 'utf8')).not.toContain('localstorage.json');
}, 120_000);

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

interface Report {
  runtime: string;
  fatal?: string;
  activated?: boolean;
  physx?: string;
  logs: string[];
  outbound: string[];
  crashes: number;
  building: boolean;
  rootChildren: string[];
  actionNodes: number;
  sent: [string, [string, number, string, any]][];
  handlerCalls: string[];
  playerCalls: unknown[];
  chat: { id: string; body: string }[];
  appState: unknown;
  playerPosition: number[];
  useItem?: string;
  releaseItem?: boolean;
  host: Record<string, boolean>;
  endowedFrozen?: boolean;
}

function requireRuntime(runtime: string) {
  if (runtime === 'bun' && !hasBun) throw new Error('`bun` is not on PATH (set SANDBOX_TESTS_WITHOUT_BUN=1 to skip the Bun runs)');
}

function run(runtime: string, scenario: Scenario): Report {
  requireRuntime(runtime);
  const file = path.join(dir, `scenario-${++scenarios}.json`);
  const reportFile = path.join(dir, `report-${scenarios}.json`);
  writeFileSync(file, JSON.stringify(scenario));
  // No environment beyond what the runtime needs to start: nothing of the developer's reaches the child
  const result = spawnSync(runtime, [bundle, file, reportFile], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 60_000,
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
  });
  if (!existsSync(reportFile)) {
    throw new Error(`The sandbox child (${runtime}) ended with status ${result.status} and no report.\n${result.stdout.slice(-2000)}\n${result.stderr.slice(-2000)}`);
  }
  const report = JSON.parse(readFileSync(reportFile, 'utf8')) as Report;
  if (report.fatal) throw new Error(`The sandbox child (${runtime}) failed: ${report.fatal}`);
  return report;
}

/** App events the script sent to the world's server (app.send), by name */
const events = (report: Report, name: string) => report.sent.filter(([packet, data]) => packet === 'entityEvent' && data[2] === name).map(([, data]) => data[3]);
const packets = (report: Report) => [...new Set(report.sent.map(([packet]) => packet))];
const untouchedHost = Object.fromEntries(
  ['objectProto', 'arrayPush', 'functionCall', 'blobProto', 'timerProto', 'vector3Proto', 'quaternionProto', 'inspectDefaults', 'env', 'noMarker', 'endowedUntouched'].map((key) => [key, true])
);

// Without bun the Bun runs still run (and fail in requireRuntime) unless they are skipped knowingly
interface ServiceRun {
  status: number | null;
  stderr: string;
  report: { survived: boolean; logs: string[] } | null;
}

/** HyperfyService.start in a child (test-support/sandbox/service-child.ts), then an unhandled rejection */
function runService(runtime: string, mode: string): ServiceRun {
  requireRuntime(runtime);
  const reportFile = path.join(dir, `service-${++scenarios}.json`);
  const result = spawnSync(runtime, [serviceBundle, reportFile], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 120_000,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, HYPERFY_WORLD_SCRIPTS: mode, WS_URL: 'ftp://not-a-world' },
  });
  return {
    status: result.status,
    stderr: result.stderr,
    report: existsSync(reportFile) ? (JSON.parse(readFileSync(reportFile, 'utf8')) as ServiceRun['report']) : null,
  };
}

// Scripts for the species regressions (S-01): a promise whose species constructor records what it is handed
const SPECIES = `
  const handed = []
  function Species(executor) { executor((value) => { handed.push(value) }, () => {}); return Promise.resolve() }
  const speciesPromise = () => { const p = Promise.resolve(app); Object.defineProperty(p, 'constructor', { value: { [Symbol.species]: Species } }); return p }
`;
const SPECIES_REPORT = `
  setTimeout(() => {
    const describe = (value) => (value === undefined ? 'undefined' : value === app ? 'the app facade' : typeof value)
    const entity = (value) => { try { return typeof (value && value.constructor && value.constructor.world) } catch (e) { return 'threw' } }
    app.send('report', { handed: handed.map(describe), entity: handed.map(entity) })
  }, 100)
`;
const RECEIVER_REFUSED = 'A function cannot be the `this` of a world API function';

const runtimes: [string, boolean][] = [
  ['bun', hasBun || !withoutBun],
  ['node', true],
];

describe.each(runtimes)('world scripts in a locked-down %s process', (runtime, available) => {
  const test = available ? it : it.skip;

  test('activates: lockdown succeeds and the self-test passes with the real script runtime', () => {
    const report = run(runtime, { mode: 'sandboxed', script: '' });

    expect(report.runtime).toBe(runtime);
    expect(report.activated).toBe(true);
    expect(report.logs.join('\n')).toMatch(/sandbox self-test passed \(\d+ checks\)/);
    expect(report.crashes).toBe(0);
  });

  test('a hostile app script finds no way out, and the host is unchanged afterwards', () => {
    const report = run(runtime, { mode: 'sandboxed', script: fixture('hostile-app.js'), useItem: true, waitForEvent: 'report' });
    const [found] = events(report, 'report');

    expect(found, 'the hostile script did not get to its report').toBeDefined();
    expect(found.escapes).toEqual([]);
    // It did run to the end, walking what it was given and what its callbacks received
    expect(found.notes.walked).toBeGreaterThan(500);
    expect(found.notes.captured).toBeGreaterThan(10);
    expect(report.crashes).toBe(0);

    // Evaluators and intrinsics
    expect(found.notes.Function).toContain('threw');
    expect(found.notes.AsyncFunction).toContain('threw');
    expect(found.notes.GeneratorFunction).toContain('threw');
    expect(found.notes.AsyncGeneratorFunction).toContain('threw');
    expect(found.notes['Object.prototype']).toContain('threw');
    // Fake nodes: the raw engine calls node.activate({ world, entity }) on these
    expect(found.notes['app.add(fake)']).toBe('threw add() expects a node');
    expect(found.notes['world.add(fake)']).toBe('threw world.add() expects a node');
    expect(found.notes['world.attach(fake)']).toBe('threw world.attach() expects a node');
    // Math objects: no method replaced, on the instance or on the shared class
    expect(found.notes['math: shadow a method']).toContain('threw');
    expect(found.notes['math: prototype']).toContain('threw');
    expect(found.notes['player position: shadow copy()']).toContain('threw');
    expect(found.notes.storage).toBe('undefined');
    expect(found.notes.load).toBe('node');

    // The host side: nothing the script did reached the network handlers, prototypes or globals
    expect(report.handlerCalls).toEqual([]);
    expect(report.host).toEqual(untouchedHost);
    expect(packets(report)).toEqual(['entityEvent']);
    expect(report.playerPosition).toEqual([1, 2, 3]);
    // The item's trigger and the control's keyX handler ran with nothing but the script's own values
    expect(events(report, 'triggered')).toHaveLength(1);
    expect(events(report, 'keyX')).toHaveLength(1);
    // console.log of objects with custom-inspect hooks reached the host console as text
    expect(report.logs.filter((line) => line.includes('[script]')).every((line) => !line.includes('nodejs.util.inspect.custom'))).toBe(true);
  });

  test('the same script in the engine\'s own compartment (lockdown, no membrane) reaches the raw world', () => {
    const report = run(runtime, { mode: 'engine-compartment', script: fixture('hostile-app.js'), useItem: true, waitForEvent: 'report' });
    const [found] = events(report, 'report');
    const escapes: string[] = found.escapes;

    // Lockdown alone does stop the evaluators
    expect(found.notes.Function).toContain('threw');
    expect(escapes.filter((escape) => escape.startsWith('Function constructor'))).toEqual([]);
    // ...but the engine's proxies give the world away in several independent ways
    const reached = (pattern: RegExp) => escapes.filter((escape) => pattern.test(escape));
    expect(escapes).toContain('reached world.constructor.world: object');
    expect(reached(/^reached .*\.network: object$/)).not.toEqual([]);
    expect(reached(/^reached .*\.network\.ws: object$/)).not.toEqual([]);
    expect(reached(/^reached .*\.onChatAdded: function$/)).not.toEqual([]);
    expect(escapes).toContain('app.add accepted a fake node');
    expect(escapes).toContain('a node position exposes its change callback');
    expect(reached(/^writable prototype of /)).not.toEqual([]);
    expect(reached(/^console called a custom inspect/)).not.toEqual([]);
    expect(escapes).toContain('setTimeout returned object');
    // ...and its fetch reaches the agent's own API port
    expect(report.outbound).toContain('http://127.0.0.1:3000/api/agents');
  });

  test('fetch() is refused and makes no request; world.load() goes to the loader and reveals nothing about a failure', () => {
    const report = run(runtime, { mode: 'sandboxed', script: fixture('hostile-app.js'), waitForEvent: 'report' });
    const [found] = events(report, 'report');

    expect(found.notes.fetch).toBe('rejected: fetch is not available to world scripts in this agent');
    expect(report.logs.join('\n')).toContain('fetch() is not available');
    // Known and documented: until the outbound policy (plan D3) is applied in the loader, a script can
    // make the loader request a URL. This is that one request; fetch() itself produced none.
    expect(report.outbound).toEqual(['http://127.0.0.1:9/internal.glb']);
    expect(found.notes.loadFailure).toBe('world.load() failed');
  });

  test('with a network function plugged in, a script gets plain data and a blob facade, never a host Blob', () => {
    const report = run(runtime, { mode: 'sandboxed', script: fixture('hostile-app.js'), waitForEvent: 'report', networkBody: '{"hello":[1,2]}' });
    const [found] = events(report, 'report');

    expect(found.escapes).toEqual([]);
    expect(found.notes.fetch).toBe('resolved 200');
    expect(found.notes.blob).toEqual([15, 'image/png', '{"hello":[1,2]}']);
    expect(found.notes.objectUrl).toContain('threw URL.createObjectURL is not available');
    expect(report.outbound).toContain('script-network:http://127.0.0.1:3000/api/agents');
    expect(report.host).toEqual(untouchedHost);
  });

  test('after the engine extends three.js with PhysX, Vector3.toPxVec3() gives a script nothing', () => {
    const report = run(runtime, {
      mode: 'sandboxed',
      script: fixture('hostile-app.js'),
      waitForEvent: 'report',
      physxModule: path.join(repo, 'src/plugin-hyperfy/physx/loadPhysX.js'),
    });
    const [found] = events(report, 'report');

    // The engine's own extension is in place: the method exists and returns its shared PhysX object
    expect(report.physx).toBe('function');
    expect(found.notes.toPxVec3).toBe('object');
    expect(found.notes.toPxExtVec3).toBe('object');
    expect(found.escapes).toEqual([]);
    expect(report.host).toEqual(untouchedHost);
  });

  test('an ordinary interactive script works: item, updates, timer, chat, control, players, maths', () => {
    const report = run(runtime, { mode: 'sandboxed', script: fixture('friendly-app.js'), useItem: true, waitForEvent: 'keyX' });
    const [seen] = events(report, 'report');

    expect(report.crashes).toBe(0);
    expect(seen).toMatchObject({
      networkId: 'coo',
      isClient: true,
      props: 'hello:1,2,3',
      config: true,
      children: 2,
      camera: [0, 0, 0],
      player: ['coo', 'Player coo', 1, 2, 3],
      players: ['coo', 'visitor'],
      vector: [2, 3, 4, true, true, 4],
      distance: 1.732,
      position: [4, 5, 6],
      quaternion: [0, 0.707, 0, 0.707],
      fromEuler: [0, 0.707, 0, 0.707],
      matrix: [4, 5, 6],
      curve: 5,
      state: '{"count":1,"list":[1,2,3]}',
      helpers: ['string', 'number', 'number', 1, 'number', true],
    });
    // The agent used the item (HYPERFY_USE_ITEM) and released it again (HYPERFY_UNUSE_ITEM)
    expect(report.actionNodes).toBe(1);
    expect(report.useItem).toBe('started');
    expect(events(report, 'triggered')).toEqual([{ playerId: 'coo', label: 'Sit' }]);
    expect(report.releaseItem).toBe(true);
    expect(events(report, 'keyX')).toEqual([{ down: true }]);
    expect(events(report, 'frames')).toHaveLength(1);
    expect(events(report, 'timer')).toEqual([{ ok: true }]);
    expect(report.appState).toEqual({ count: 1, list: [1, 2, 3] });
    expect(report.logs.join('\n')).toContain("[script] friendly app ready [ 'coo', 'Player coo', 1, 2, 3 ]");
    // world.chat(msg, true): shown locally, heard by scripts, never sent to the world
    expect(report.chat.map((msg) => msg.body)).toEqual(['hello from the script']);
    expect(events(report, 'heard')).toEqual([{ body: 'hello from the script' }]);
    expect(packets(report)).toEqual(['entityEvent']);
  });

  test("world.chat(msg, true) is not broadcast even with the engine's own chat.add in place", () => {
    const report = run(runtime, { mode: 'sandboxed', script: fixture('friendly-app.js'), engineChat: true, waitForEvent: 'timer' });

    expect(report.chat.map((msg) => msg.body)).toEqual(['hello from the script']);
    expect(packets(report)).toEqual(['entityEvent']);
  });

  test('what a script throws into the engine is logged as a plain Error: its inspect hook never runs', () => {
    const script = `
      const hostile = () => ({ message: 'thrown by the script', [Symbol.for('nodejs.util.inspect.custom')](depth, options, inspect) { app.send('hook', { options: typeof options, inspect: typeof inspect }); return 'x' } })
      app.on('fixedUpdate', () => { throw hostile() })
    `;
    const report = run(runtime, { mode: 'sandboxed', script });

    // The engine caught it, logged it with console.error and crashed the app
    expect(report.crashes).toBeGreaterThan(0);
    expect(report.logs.some((line) => line.startsWith('error:') && line.includes('thrown by the script'))).toBe(true);
    expect(events(report, 'hook')).toEqual([]);
  });

  test('an unhandled rejection in a script neither ends the process nor hands its reason to the console', () => {
    const script = `
      const hostile = tag => ({ message: 'rejected by the script: ' + tag, [Symbol.for('nodejs.util.inspect.custom')](depth, options, inspect) { app.send('hook', { tag }); return 'x' } })
      Promise.reject(hostile('bare'))
      let once = false
      app.on('update', async () => { if (once) return; once = true; throw hostile('async listener') })
      setTimeout(() => app.send('alive', {}), 150)
    `;
    const report = run(runtime, { mode: 'sandboxed', script, waitForEvent: 'alive' });

    expect(events(report, 'alive')).toHaveLength(1);
    expect(events(report, 'hook')).toEqual([]);
    const logs = report.logs.join('\n');
    expect(logs).toContain('Unhandled promise rejection (the agent keeps running): Error: rejected by the script: bare');
    expect(logs).toContain('[script] an async callback failed: rejected by the script: async listener');
  });

  test('off: the script is never evaluated, and the app still shows its model', () => {
    const report = run(runtime, { mode: 'off', script: fixture('friendly-app.js'), useItem: true });

    expect(report.activated).toBeUndefined();
    expect(report.building).toBe(false);
    expect(report.crashes).toBe(0);
    // The model's node is there; the action node the script would have added is not
    expect(report.rootChildren).toEqual(['Root']);
    expect(report.actionNodes).toBe(0);
    expect(report.useItem).toBe('no-action-nodes');
    expect(report.sent).toEqual([]);
    expect(report.chat).toEqual([]);
    expect(report.appState).toEqual({});
    expect(report.logs.join('\n')).not.toContain('[script]');
    expect(report.outbound).toEqual([]);
  });

  // ---- regressions of the P1a2 review: before the fix each of these was a way out of the sandbox ----

  test('S-01: a promise a script passes to the host never hands its species constructor a host value', () => {
    const script = `${SPECIES} console.log('innocent', speciesPromise()); app.state = { p: speciesPromise() }; world.emit('species', speciesPromise()); ${SPECIES_REPORT}`;
    const report = run(runtime, { mode: 'sandboxed', script, waitForEvent: 'report' });
    const [found] = events(report, 'report');

    // Before the fix: the raw engine app proxy, and through it the World
    expect(found.handed.length).toBeGreaterThan(0);
    expect(found.handed.every((value: string) => value === 'undefined')).toBe(true);
    expect(found.entity.every((value: string) => value === 'undefined')).toBe(true);
    expect(packets(report)).toEqual(['entityEvent']);
    expect(report.handlerCalls).toEqual([]);
    expect(report.host).toEqual(untouchedHost);
  });

  test('S-01: a promise a script callback returns to the engine never hands its species constructor a host value', () => {
    const script = `${SPECIES} let once = false; app.on('update', () => { if (once) return; once = true; return speciesPromise() }); app.on('lateUpdate', async () => speciesPromise()); ${SPECIES_REPORT}`;
    const report = run(runtime, { mode: 'sandboxed', script, waitForEvent: 'report' });
    const [found] = events(report, 'report');

    expect(found.handed.length).toBeGreaterThan(0);
    expect(found.handed.every((value: string) => value === 'undefined')).toBe(true);
    expect(report.crashes).toBe(0);
    expect(packets(report)).toEqual(['entityEvent']);
    expect(report.handlerCalls).toEqual([]);
  });

  test('S-02: a buffer a script passes reaches the host as a copy made without its species, and is never taken for a node', () => {
    const script = `
      const out = { asked: 0, used: [] }
      const carrier = new ArrayBuffer(4)
      carrier._isRef = true
      Object.defineProperty(carrier, '_ref', { get() { out.used.push('_ref'); return { activate() { out.used.push('activate') }, children: [], traverse() {} } } })
      carrier.traverse = function () {}
      const viaSpecies = (result) => { const b = new ArrayBuffer(4); new Uint8Array(b)[0] = 1; Object.defineProperty(b, 'constructor', { value: { [Symbol.species]: function () { out.asked++; return result } } }); return b }
      try { app.add(viaSpecies(carrier)); out.add = 'accepted' } catch (e) { out.add = e.message }
      try { world.add(new Uint8Array(viaSpecies(carrier))); out.worldAdd = 'accepted' } catch (e) { out.worldAdd = e.message }
      const kept = new ArrayBuffer(4)
      const original = viaSpecies(kept)
      app.state = { bytes: original }
      new Uint8Array(kept)[0] = 42
      new Uint8Array(original)[0] = 2
      out.stored = Array.from(new Uint8Array(app.state.bytes))
      app.send('report', out)
    `;
    const report = run(runtime, { mode: 'sandboxed', script, waitForEvent: 'report' });
    const [found] = events(report, 'report');

    // Before the fix: asked 2, the carrier's activate() was handed the raw { world, entity }, and the
    // host's bytes were the script's own buffer
    expect(found).toEqual({ asked: 0, used: [], add: 'add() expects a node', worldAdd: 'world.add() expects a node', stored: [1, 0, 0, 0] });
    expect(packets(report)).toEqual(['entityEvent']);
  });

  test('S-05: what the host throws reaches a script with its name and message only, without frames or paths', () => {
    const script = `
      const out = {}
      const record = (name, e) => { out[name] = [e.name, e.message, String(e.stack)] }
      try { world.raycast({}, {}) } catch (e) { record('engine', e) }
      try { app.position.set.call(num, 1) } catch (e) { record('receiver', e) }
      try { app.add({}) } catch (e) { record('guard', e) }
      try { app.add({ _isRef: true }) } catch (e) { record('reference', e) }
      world.load('model', 'http://127.0.0.1:9/missing.glb').catch((e) => { record('load', e); app.send('report', out) })
    `;
    const [found] = events(run(runtime, { mode: 'sandboxed', script, waitForEvent: 'report' }), 'report');

    expect(Object.keys(found)).toEqual(['engine', 'receiver', 'guard', 'reference', 'load']);
    for (const [name, message, stack] of Object.values(found) as string[][]) {
      expect(stack).toBe(`${name}: ${message}`);
      expect(stack).not.toMatch(/\n\s*at |\/(Users|private|home|tmp|var)\//);
    }
    expect(found.engine).toEqual(['Error', '[raycast] origin must be Vector3', 'Error: [raycast] origin must be Vector3']);
    expect(found.load).toEqual(['Error', 'world.load() failed', 'Error: world.load() failed']);
  });

  test('S-06: no function can be the `this` of a host call, and the endowed helpers stay frozen and untouched', () => {
    const script = `
      const out = {}
      for (const [name, receiver] of [['num', num], ['Vector3', Vector3], ['world.add', world.add], ['own', function () {}]]) {
        try { app.position.set.call(receiver, 1, 2, 3); out[name] = 'ran' } catch (e) { out[name] = e.message }
      }
      app.state = { f: num }
      out.roundTrip = app.state.f === num
      app.send('report', out)
    `;
    const report = run(runtime, { mode: 'sandboxed', script, waitForEvent: 'report' });
    const [found] = events(report, 'report');

    // Before the fix: 'ran', and the engine's num() had own properties x, y, z
    expect(found).toEqual({ num: RECEIVER_REFUSED, Vector3: RECEIVER_REFUSED, 'world.add': RECEIVER_REFUSED, own: RECEIVER_REFUSED, roundTrip: true });
    expect(report.host.endowedUntouched).toBe(true);
    expect(report.endowedFrozen).toBe(true);
  });

  test('S-07 and every hook: a script handing the host values with language hooks finds no way out, and every member that takes a node refuses a forgery but takes the real thing', () => {
    const report = run(runtime, {
      mode: 'sandboxed',
      script: fixture('hostile-hooks.js'),
      waitForEvent: 'report',
      // Joints need PhysX
      physxModule: path.join(repo, 'src/plugin-hyperfy/physx/loadPhysX.js'),
    });
    const [found] = events(report, 'report');

    expect(found, 'the hooks fixture did not get to its report').toBeDefined();
    expect(found.escapes).toEqual([]);
    expect(report.crashes).toBe(0);
    expect(report.handlerCalls).toEqual([]);
    expect(report.host).toEqual(untouchedHost);
    expect(report.endowedFrozen).toBe(true);
    expect(packets(report)).toEqual(['entityEvent']);
    const notes = found.notes;
    // It did run its hooks
    expect(notes.speciesHanded).toBeGreaterThan(5);
    expect(notes.trapped).toBeGreaterThan(50);
    expect(notes.handed).toEqual(expect.arrayContaining(['valueOf', 'own then', 'error message', 'reentrant getter', 'getter this']));
    expect(notes.reThrown).toBe('thrown by the script');
    // Forged references and fake nodes, refused by every member that takes a node...
    for (const name of ['forged: app.add', 'forged: world.add', 'forged: lod.insert', 'forged: collider.geometry', 'forged: joint.body0', 'forged: video.geometry']) {
      expect(notes[name], name).toBe('threw A world script cannot pass a property named _isRef');
    }
    expect(notes['fake node: lod.insert']).toBe('threw insert() expects a node');
    // Shaped like a node proxy, made by the engine, but not a node: told apart by identity only
    expect(notes['lookalike: geometry reference with traverse']).toBe('threw add() expects a node');
    expect(notes['fake: collider.geometry']).toBe('threw geometry must be the geometry of a node');
    expect(notes['fake: joint.body1']).toBe('threw body1 must be a node');
    expect(notes['buffer species: app.add']).toBe('threw add() expects a node');
    expect(notes['buffer species: world.add']).toBe('threw world.add() expects a node');
    expect(notes['forged: props']).toMatch(/^threw /);
    // ...while the real uses still work (the joint then needs to be mounted, which it is not here)
    expect(notes['real node: lod.insert']).toBe('ok');
    expect(notes['real: collider.geometry']).toBe('ok');
    expect(notes['real: joint.body0']).not.toContain('must be a node');
    for (const name of ['receiver: endowed helper', 'receiver: class', 'receiver: world API function', 'receiver: own function', 'receiver: copy']) {
      expect(notes[name], name).toBe(`threw ${RECEIVER_REFUSED}`);
    }
    expect(notes['functions round trip']).toBe(true);
    expect(notes.captureStackTrace).toBe('empty');
    expect(notes.hostErrorConstructorIsScripts).toBe(true);
  });

  test('S-08 sandboxed: HyperfyService.start makes the process survive an unhandled rejection, and logs it as text', () => {
    const { status, report, stderr } = runService(runtime, 'sandboxed');

    expect(status, stderr.slice(-2000)).toBe(0);
    expect(report?.survived).toBe(true);
    const logs = report!.logs.join('\n');
    expect(logs).toMatch(/sandbox self-test passed \(\d+ checks\)/);
    expect(logs).toContain('Unhandled promise rejection (the agent keeps running): Error: unhandled in the agent');
  });

  test('S-08 off: the same unhandled rejection ends the process, as the runtime does by default', () => {
    const { status, report, stderr } = runService(runtime, 'off');

    expect(report).toBeNull();
    expect(status).not.toBe(0);
    expect(stderr).toContain('unhandled in the agent');
  });

  test('off: a hostile script changes nothing either', () => {
    const report = run(runtime, { mode: 'off', script: fixture('hostile-app.js') });

    expect(report.sent).toEqual([]);
    expect(report.handlerCalls).toEqual([]);
    expect(report.host).toEqual(untouchedHost);
    expect(report.outbound).toEqual([]);
  });
});
