#!/usr/bin/env node
/*
 * Scratch boot smoke: starts the BUILT agent under Bun with `elizaos start`, away from the
 * repository, and checks that it boots in both world-script modes without touching the live world,
 * the real database, any real key, or the repository's localstorage.json.
 *
 * This is the only safe way to boot the agent for a check. Never run `elizaos start`, `elizaos dev`
 * or `bun run start` in the repository for that: the CLI loads the repository's .env (live world,
 * real database, real keys).
 *
 *   bun run build && node scripts/smoke-boot.mjs --dir <empty scratch directory> [--modes off,sandboxed] [--no-locked] [--keep]
 *
 * The scratch directory must have no .env in it or in any directory above it.
 *
 * Each mode runs with SERVER_HOST=127.0.0.1 and an ELIZA_SERVER_AUTH_TOKEN the smoke chooses, and
 * the API is called with it. One more run (`off-locked`, skipped with --no-locked) sets neither: the
 * agent must then listen on loopback only and keep its API locked (401 without a token) while it
 * still boots, which is checked from its log.
 *
 * Per run, in <dir>/run-<mode>/ (created, and removed afterwards unless --keep):
 *   package.json   the repository's, with `scripts` replaced (see below)
 *   dist/          a copy of the repository's dist/
 *   dist-built/    the same copy again: `elizaos start` deletes dist/ and runs the project's build
 *                  script before starting, so the copied package.json's build script is
 *                  `cp -R dist-built dist` instead of the real build chain
 *   node_modules   a symlink to the repository's (package auto-install is switched off, so nothing
 *                  is written through it)
 *   pg/            a throwaway Postgres cluster (TCP on 127.0.0.1 only), stopped and deleted afterwards
 *   home/          an empty HOME, so no user-level configuration or Chromium is found
 *
 * The agent's environment is exactly the `agentEnv` object below: nothing is inherited but PATH.
 * No real key is passed. Two things that do reach out in normal operation are switched off here,
 * because the point is that nothing leaves the machine: Chromium is not found (empty
 * PUPPETEER_CACHE_DIR; its page still imports three.js from a CDN), and npm is offline (the
 * elizaOS CLI asks the npm registry for its latest version on every start).
 *
 * "No request left the machine" is checked two ways, both with limits: every HTTP(S)_PROXY-aware
 * client is pointed at a recorder on 127.0.0.1 that logs and refuses, and the sockets of the agent's
 * process group are sampled with lsof every 200 ms (a connection shorter than that, and DNS lookups,
 * would not be seen).
 */

import { spawn, spawnSync } from 'node:child_process';
import crypto, { randomBytes } from 'node:crypto';
import {
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PG_BIN = process.env.SMOKE_PG_BIN || '/opt/homebrew/opt/postgresql@17/bin';
const BOOT_TIMEOUT_MS = 180_000;
const EXIT_TIMEOUT_MS = 30_000;

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const baseDir = option('--dir') ? path.resolve(option('--dir')) : undefined;
const modes = (option('--modes') ?? 'off,sandboxed').split(',');
const keep = args.includes('--keep');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** stat facts that change when a file is created, written or replaced; never its contents */
function fingerprint(file) {
  try {
    const s = statSync(file);
    return `size=${s.size} mtimeMs=${s.mtimeMs} ino=${s.ino}`;
  } catch {
    return 'absent';
  }
}

const isLoopback = (address) => /^(127\.\d+\.\d+\.\d+|\[::1\]|localhost|\[::ffff:127\.\d+\.\d+\.\d+\])$/.test(address);

/**
 * A fake proxy: records what a proxy-aware client asked for, and refuses it. `who()` describes the
 * agent's processes at that moment, to tell which of them asked.
 */
function startRecorder(who) {
  const seen = [];
  const server = net.createServer((socket) => {
    socket.once('data', (data) => {
      seen.push(`${data.toString('latin1').split('\r\n')[0].slice(0, 200)} [running: ${who()}]`);
      socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    });
    socket.on('error', () => {});
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, seen, close: () => server.close() })));
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, { encoding: 'utf8', ...options });
  if (result.status !== 0) {
    throw new Error(`${command} ${commandArgs.join(' ')} failed (${result.status}): ${(result.stderr || result.stdout || '').slice(-800)}`);
  }
  return result.stdout;
}

/**
 * One Socket.IO connection attempt over Engine.IO v4 long-polling (no client library needed):
 * open a session, send the CONNECT packet with `auth`, read the answer. Resolves to 'accepted'
 * (CONNECT acknowledged), 'refused: <message>' (CONNECT_ERROR) or a description of anything else.
 */
async function socketHandshake(port, auth) {
  const base = `http://127.0.0.1:${port}/socket.io/?EIO=4&transport=polling`;
  const signal = AbortSignal.timeout(10_000);
  const opened = await (await fetch(base, { signal })).text();
  if (!opened.startsWith('0')) return `no session (${opened.slice(0, 80)})`;
  const { sid } = JSON.parse(opened.slice(1));
  await fetch(`${base}&sid=${sid}`, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body: `40${JSON.stringify(auth)}`, signal });
  const answer = await (await fetch(`${base}&sid=${sid}`, { signal })).text();
  const packets = answer.split('\x1e');
  if (packets.some((packet) => packet.startsWith('40'))) return 'accepted';
  const refusal = packets.find((packet) => packet.startsWith('44'));
  if (refusal) {
    try {
      return `refused: ${JSON.parse(refusal.slice(2)).message}`;
    } catch {
      return `refused: ${refusal.slice(2, 80)}`;
    }
  }
  return `unexpected answer (${answer.slice(0, 80)})`;
}

/** Remote ends of the TCP/UDP sockets held by the processes of one process group */
function sampleSockets(pgid, remotes, listeners) {
  const pids = spawnSync('pgrep', ['-g', String(pgid)], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
  if (!pids.length) return;
  const out = spawnSync('lsof', ['-nP', '-a', '-p', pids.join(','), '-iTCP', '-iUDP', '-Fn'], { encoding: 'utf8' }).stdout;
  for (const line of out.split('\n')) {
    if (!line.startsWith('n')) continue;
    const name = line.slice(1);
    const arrow = name.indexOf('->');
    if (arrow === -1) listeners.add(name);
    else remotes.add(name.slice(arrow + 2));
  }
}

async function smoke(mode, { locked = false } = {}) {
  const checks = [];
  const check = (name, ok, detail = '') => {
    checks.push({ name, ok: !!ok, detail });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  };
  const runDir = path.join(baseDir, `run-${mode}${locked ? '-locked' : ''}`);
  if (existsSync(runDir)) throw new Error(`${runDir} already exists; remove it or use another --dir`);
  console.log(`\n== HYPERFY_WORLD_SCRIPTS=${mode}${locked ? ', no SERVER_HOST and no ELIZA_SERVER_AUTH_TOKEN' : ', SERVER_HOST=127.0.0.1 and a token'} in ${runDir}`);

  const repoStorage = path.join(repo, 'localstorage.json');
  const submoduleStorage = path.join(repo, 'src/plugin-hyperfy/hyperfy/src/localstorage.json');
  const storageBefore = [fingerprint(repoStorage), fingerprint(submoduleStorage)];

  let agent = null;
  let pgStarted = false;
  let recorder = null;
  let sampler = null;
  const log = [];
  const pgData = path.join(runDir, 'pg');
  try {
    // ---- the run directory ----
    mkdirSync(path.join(runDir, 'home'), { recursive: true });
    mkdirSync(path.join(runDir, 'no-chromium'));
    const pkg = JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8'));
    pkg.scripts = { build: 'cp -R dist-built dist' };
    writeFileSync(path.join(runDir, 'package.json'), JSON.stringify(pkg, null, 2));
    cpSync(path.join(repo, 'dist'), path.join(runDir, 'dist'), { recursive: true });
    cpSync(path.join(repo, 'dist'), path.join(runDir, 'dist-built'), { recursive: true });
    symlinkSync(path.join(repo, 'node_modules'), path.join(runDir, 'node_modules'), 'dir');

    // The CLI loads every .env from the working directory up to 10 parents; the server's
    // /api/system/env/local looks all the way up to the filesystem root. So: none anywhere above.
    const envFiles = [];
    for (let dir = runDir; ; dir = path.dirname(dir)) {
      if (existsSync(path.join(dir, '.env'))) envFiles.push(path.join(dir, '.env'));
      if (path.dirname(dir) === dir) break;
    }
    check('no .env in the run directory or any directory above it', envFiles.length === 0, envFiles.join(', '));
    if (envFiles.length) throw new Error('Refusing to start the agent below a .env file');

    // ---- throwaway Postgres ----
    const pgPort = await freePort();
    run(path.join(PG_BIN, 'initdb'), ['-D', pgData, '-U', 'smoke', '--auth=trust', '-E', 'UTF8', '--no-locale']);
    // TCP on loopback only: the run directory's path is too long for a unix socket
    run(path.join(PG_BIN, 'pg_ctl'), ['-D', pgData, '-l', path.join(runDir, 'pg.log'), '-w', '-o', `-p ${pgPort} -c listen_addresses=127.0.0.1 -c unix_socket_directories=''`, 'start']);
    pgStarted = true;

    // ---- the agent ----
    const serverPort = await freePort();
    recorder = await startRecorder(() => {
      if (!agent?.pid) return 'not started';
      const pids = spawnSync('pgrep', ['-g', String(agent.pid)], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
      if (!pids.length) return 'no process';
      const commands = spawnSync('ps', ['-o', 'command=', '-p', pids.join(',')], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
      return commands.map((command) => command.replace(runDir, '.').replace(repo, '<repo>').slice(0, 90)).join(' ; ');
    });
    const dummyAnthropicKey = `smoke-dummy-anthropic-${randomBytes(12).toString('hex')}`;
    // A random throwaway key that has never held anything, so the API check below means something
    const dummyTipKey = `0x${randomBytes(32).toString('hex')}`;
    // The API token, except in the locked run (the agent then makes up its own and never shows it)
    const apiToken = locked ? undefined : `smoke-token-${randomBytes(16).toString('hex')}`;
    const agentEnv = {
      PATH: process.env.PATH,
      HOME: path.join(runDir, 'home'),
      POSTGRES_URL: `postgresql://smoke@127.0.0.1:${pgPort}/postgres`,
      WS_URL: 'ws://127.0.0.1:9',
      ...(locked ? {} : { SERVER_HOST: '127.0.0.1', ELIZA_SERVER_AUTH_TOKEN: apiToken }),
      SERVER_PORT: String(serverPort),
      ANTHROPIC_API_KEY: dummyAnthropicKey,
      TIP_WALLET_PRIVATE_KEY: dummyTipKey,
      HYPERFY_WORLD_SCRIPTS: mode,
      // Nothing may be installed: node_modules is a link to the repository's
      ELIZA_NO_AUTO_INSTALL: 'true',
      ELIZA_NO_PLUGIN_AUTO_INSTALL: 'true',
      PUPPETEER_CACHE_DIR: path.join(runDir, 'no-chromium'),
      HTTP_PROXY: `http://127.0.0.1:${recorder.port}`,
      HTTPS_PROXY: `http://127.0.0.1:${recorder.port}`,
      ALL_PROXY: `http://127.0.0.1:${recorder.port}`,
      NO_PROXY: '127.0.0.1,localhost',
      // Every `elizaos` command but `update` runs `npm view @elizaos/cli@<channel> version` first (its
      // update notice; there is no switch for it). This makes npm answer from nothing instead of
      // asking registry.npmjs.org, and keeps npm from checking for a newer npm; without these the
      // recorder below catches exactly those requests.
      npm_config_offline: 'true',
      npm_config_update_notifier: 'false',
      NO_COLOR: '1',
    };
    const out = createWriteStream(path.join(runDir, 'agent.log'));
    agent = spawn(path.join(runDir, 'node_modules/.bin/elizaos'), ['start'], { cwd: runDir, env: agentEnv, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let exited = null;
    agent.on('exit', (code, signal) => {
      exited = { code, signal };
    });
    for (const stream of [agent.stdout, agent.stderr]) {
      stream.on('data', (chunk) => {
        out.write(chunk);
        log.push(chunk.toString());
      });
    }
    const logText = () => log.join('');
    const remotes = new Set();
    const listeners = new Set();
    sampler = setInterval(() => sampleSockets(agent.pid, remotes, listeners), 200);

    const waitFor = async (what, test) => {
      const deadline = Date.now() + BOOT_TIMEOUT_MS;
      while (Date.now() < deadline) {
        if (exited) return false;
        if (await test()) return true;
        await sleep(250);
      }
      return false;
    };
    const api = async (route, { token = apiToken } = {}) => {
      const response = await fetch(`http://127.0.0.1:${serverPort}${route}`, {
        signal: AbortSignal.timeout(5000),
        ...(token ? { headers: { 'X-API-KEY': token } } : {}),
      });
      return { status: response.status, text: await response.text() };
    };

    // An empty list means dist/index.js failed to import: the CLI only warns and starts with no agent
    let agents = [];
    let coo;
    if (!locked) {
      await waitFor('the agent list', async () => {
        try {
          const { status, text } = await api('/api/agents');
          if (status !== 200) return false;
          agents = JSON.parse(text)?.data?.agents ?? [];
          return agents.length > 0;
        } catch {
          return false;
        }
      });
      coo = agents.find((entry) => entry.name === 'Coo');
      check('GET /api/agents lists Coo', !!coo, `agents: ${JSON.stringify(agents.map((entry) => entry.name))}${exited ? `, process exited ${JSON.stringify(exited)}` : ''}`);
      const anonymous = await api('/api/agents', { token: null });
      check('GET /api/agents without the token is refused (401)', anonymous.status === 401, `status ${anonymous.status}`);
      const entityId = crypto.randomUUID();
      const withKey = await socketHandshake(serverPort, { apiKey: apiToken, entityId });
      check('a Socket.IO handshake with the token is accepted', withKey === 'accepted', withKey);
      const withoutKey = await socketHandshake(serverPort, { entityId });
      check('a Socket.IO handshake without the token is refused', withoutKey.startsWith('refused'), withoutKey);
    }

    const scriptsLine = mode === 'sandboxed' ? /World scripts: sandbox self-test passed \(\d+ checks\)/ : /World scripts are off/;
    await waitFor('the Hyperfy service log lines', () => scriptsLine.test(logText()) && /\[Hyperfy Reconnect\] Next attempt in \d+s/.test(logText()));
    check(mode === 'sandboxed' ? 'the sandbox self-test line is logged' : 'the "world scripts are off" line is logged', scriptsLine.test(logText()), (logText().match(scriptsLine) ?? [''])[0]);
    if (mode === 'sandboxed') check('the service says scripts run sandboxed', /World scripts run sandboxed/.test(logText()));
    check('the Hyperfy connect attempt is logged', logText().includes('Attempting automatic connection to default Hyperfy URL: ws://127.0.0.1:9'));
    check('the reconnect schedule is logged', /\[Hyperfy Reconnect\] Next attempt in \d+s/.test(logText()), (logText().match(/\[Hyperfy Reconnect\] Next attempt in \d+s/) ?? [''])[0]);
    check('the scene-edit setting is logged at connect (off by default)', logText().includes('[Hyperfy] Scene edits by request: off'));

    if (locked) {
      // The agent booted (the lines above come from its Hyperfy service); its API stays locked
      check('the "web UI/API is locked" line is logged', logText().includes('the elizaOS web UI/API and its Socket.IO connections are locked for this run'));
      check('the "listens on 127.0.0.1 only" line is logged', logText().includes('SERVER_HOST is not set: the elizaOS web UI/API listens on 127.0.0.1 only'));
      for (const route of ['/api/agents', '/api/system/env/local']) {
        const { status } = await api(route, { token: null });
        check(`GET ${route} without a token is refused (401)`, status === 401, `status ${status}`);
      }
      const handshake = await socketHandshake(serverPort, { entityId: crypto.randomUUID() });
      check('a Socket.IO handshake without a token is refused', handshake.startsWith('refused'), handshake);
      sampleSockets(agent.pid, remotes, listeners);
      const onPort = [...listeners].filter((entry) => entry.endsWith(`:${serverPort}`));
      check(
        `the API listens on loopback only (SERVER_HOST unset)`,
        onPort.length > 0 && onPort.every((entry) => isLoopback(entry.replace(/:\d+$/, ''))),
        `listeners on ${serverPort}: ${JSON.stringify(onPort)}`
      );
    }

    // After the lines above, so in sandboxed mode this request is served by the locked-down process
    if (coo && !locked) {
      const { status, text } = await api(`/api/agents/${coo.id}`);
      // Names and value types only: POSTGRES_URL is in here by the CLI's doing
      let secrets = {};
      try {
        secrets = JSON.parse(text)?.data?.settings?.secrets ?? {};
      } catch {
        // reported through the status below
      }
      const shape = Object.entries(secrets).map(([name, value]) => `${name}:${value === null ? 'null' : typeof value}`);
      check('GET /api/agents/<id> answers', status === 200, `status ${status}, secrets (name:type): ${shape.join(' ')}`);
      check('GET /api/agents/<id> does not return the ANTHROPIC_API_KEY value', !text.includes(dummyAnthropicKey));
      check(
        'GET /api/agents/<id> does not return the tip wallet key',
        !text.includes(dummyTipKey) && !text.includes(dummyTipKey.slice(2)) && (secrets.TIP_WALLET_PRIVATE_KEY ?? null) === null
      );
    }
    // The server reads (GET) and writes (POST) the .env it finds from its working directory upwards,
    // for whoever has the API token (the agent locks it when none is set). Here there is none to
    // find. Names only are printed, never values.
    if (!locked) try {
      const { status, text } = await api('/api/system/env/local');
      check('GET /api/system/env/local answers with the token (200)', status === 200, `status ${status}`);
      let names = 'not JSON';
      try {
        names = JSON.stringify(Object.keys(JSON.parse(text)?.data ?? {}));
      } catch {
        // keep 'not JSON'
      }
      console.log(`  info  GET /api/system/env/local: status ${status}, ${text.length} bytes, variable names: ${names}; .env in the run directory afterwards: ${existsSync(path.join(runDir, '.env')) ? 'PRESENT' : 'absent'}`);
    } catch (error) {
      console.log(`  info  GET /api/system/env/local failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    check(
      'no secret value appears in the agent log',
      !logText().includes(dummyAnthropicKey) && !logText().includes(dummyTipKey.slice(2)) && !(apiToken && logText().includes(apiToken))
    );
    if (locked) {
      // The agent made its token up and never shows it, so nothing can be compared with it: no
      // 64-hex-character string (its format) may appear, except the ones plugin-sql labels as its
      // schema migration hash ("hash=<64 hex>")
      const hex = [...logText().matchAll(/(?<![0-9a-fA-F])[0-9a-fA-F]{64}(?![0-9a-fA-F])/g)];
      const unlabelled = hex.filter((match) => logText().slice(Math.max(0, match.index - 5), match.index) !== 'hash=');
      check(
        'no 64-hex-character string (the generated token\'s format) appears in the agent log, other than plugin-sql\'s "hash=" migration hashes',
        unlabelled.length === 0,
        `${hex.length - unlabelled.length} labelled hash=, ${unlabelled.length} other${unlabelled.length ? ` (first at offset ${unlabelled[0].index})` : ''}`
      );
    }

    // A little longer, for anything that phones home after start-up
    await sleep(3000);
    sampleSockets(agent.pid, remotes, listeners);
    const external = [...remotes].filter((remote) => !isLoopback(remote.replace(/:\d+$/, '')));
    check('no proxy-aware client tried to reach another host', recorder.seen.length === 0, recorder.seen.join(' | '));
    check('every sampled connection of the agent process group went to 127.0.0.1', external.length === 0, `remote ends seen: ${JSON.stringify([...remotes].map((remote) => remote.replace(/:\d+$/, '')).filter((v, i, a) => a.indexOf(v) === i))}${external.length ? `, EXTERNAL: ${external.join(', ')}` : ''}`);
    // With SERVER_HOST=127.0.0.1. Unset, elizaOS listens on every interface (*:port).
    console.log(`  info  the agent listens on: ${JSON.stringify([...listeners])} (SERVER_HOST=${agentEnv.SERVER_HOST}, SERVER_PORT=${serverPort})`);

    // ---- SIGTERM ----
    clearInterval(sampler);
    sampler = null;
    agent.kill('SIGTERM');
    const deadline = Date.now() + EXIT_TIMEOUT_MS;
    while (!exited && Date.now() < deadline) await sleep(100);
    check('the process exits on SIGTERM', !!exited, exited ? JSON.stringify(exited) : `still running after ${EXIT_TIMEOUT_MS / 1000}s`);

    const storageAfter = [fingerprint(repoStorage), fingerprint(submoduleStorage)];
    check("the repository's localstorage.json is untouched (stat only)", storageBefore[0] === storageAfter[0]);
    check('no storage file appeared in the engine submodule', storageAfter[1] === 'absent' && storageBefore[1] === 'absent', `before: ${storageBefore[1]}, after: ${storageAfter[1]}`);
    console.log(`  info  storage file in the run directory: ${fingerprint(path.join(runDir, 'localstorage.json'))}`);
    console.log(`  info  files in the run directory: ${readdirSync(runDir).join(' ')}`);
  } catch (error) {
    check('the smoke ran to the end', false, error instanceof Error ? error.message : String(error));
  } finally {
    if (sampler) clearInterval(sampler);
    if (agent && agent.pid) {
      try {
        process.kill(-agent.pid, 'SIGKILL');
      } catch {
        // the group is gone
      }
    }
    recorder?.close();
    if (pgStarted) spawnSync(path.join(PG_BIN, 'pg_ctl'), ['-D', pgData, '-m', 'immediate', '-w', 'stop'], { encoding: 'utf8' });
    if (checks.some((entry) => !entry.ok)) console.log(`  ---- last agent output ----\n${log.join('').slice(-3000)}`);
    if (!keep) rmSync(runDir, { recursive: true, force: true });
  }
  return checks;
}

if (!baseDir) {
  console.error('Usage: node scripts/smoke-boot.mjs --dir <empty scratch directory> [--modes off,sandboxed] [--keep]');
  process.exit(2);
}
if (baseDir === repo || baseDir.startsWith(repo + path.sep)) {
  console.error('The scratch directory must be outside the repository (the CLI loads .env files from parent directories).');
  process.exit(2);
}
if (!existsSync(path.join(repo, 'dist/index.js'))) {
  console.error('dist/index.js is missing: run `bun run build` first.');
  process.exit(2);
}
mkdirSync(baseDir, { recursive: true });
console.log(`Smoke of ${path.join(repo, 'dist/index.js')} (built ${statSync(path.join(repo, 'dist/index.js')).mtime.toISOString()})`);

const results = [];
for (const mode of modes) results.push(...(await smoke(mode)).map((entry) => ({ mode, ...entry })));
if (!args.includes('--no-locked')) results.push(...(await smoke('off', { locked: true })).map((entry) => ({ mode: 'off-locked', ...entry })));
const failed = results.filter((entry) => !entry.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? `; FAILED: ${failed.map((entry) => `[${entry.mode}] ${entry.name}`).join('; ')}` : ''}`);
process.exit(failed.length ? 1 : 0);
