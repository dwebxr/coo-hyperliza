import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'tsup';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NetChildReport, NetChildScenario } from '../test-support/net-child';
import { type TestServer, closeServers, startServer, testCertificate } from '../test-support/net';

/*
 * The network policy in the runtime the agent runs in. lib/net-policy.ts relies on node:http(s)
 * behaving in particular ways, and Bun has its own implementation of node:http: every assumption
 * is checked here in a child process under Bun, and under Node for comparison
 * (test-support/net-child.ts). If a later Bun stopped asking the `lookup` hook, these tests fail;
 * the guard does not silently go away.
 *
 * The servers are in this process, on loopback; the child is given their ports. The child runs with
 * HTTP(S)_PROXY pointing at a recorder (and NODE_USE_ENV_PROXY=1), which must see nothing.
 *
 * Without `bun` on PATH the Bun run FAILS. Set SANDBOX_TESTS_WITHOUT_BUN=1 to skip it instead,
 * knowingly (the same switch as lib/script-sandbox.child.test.ts).
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const hasBun = spawnSync('bun', ['--version'], { encoding: 'utf8' }).status === 0;
const withoutBun = process.env.SANDBOX_TESTS_WITHOUT_BUN === '1';

let dir = '';
let bundle = '';

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'coo-net-child-'));
  symlinkSync(path.join(repo, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  await build({
    entry: { 'net-child': path.join(here, '../test-support/net-child.ts') },
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
  });
  bundle = path.join(dir, 'net-child.js');
}, 120_000);

afterAll(async () => {
  await closeServers();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

interface Run {
  report: NetChildReport;
  servers: Record<'gate' | 'v4' | 'tls' | 'bodies' | 'api' | 'elsewhere', TestServer> & { v6: TestServer | null };
  /** First lines of whatever was sent to the proxy the child's environment names */
  proxied: string[];
}

async function run(runtime: string): Promise<Run> {
  const text = (body: string) => (_request: unknown, response: { end: (body: string) => void }) => response.end(body);
  const elsewhere = await startServer(text('elsewhere'));
  const v4 = await startServer(text('v4'));
  // The same port on ::1, to tell the two loopback addresses of one name apart
  const v6 = await startServer(text('v6'), { host: '::1', port: v4.port }).catch(() => null);
  const servers: Run['servers'] = {
    gate: await startServer(text('the gate is open'), { tls: true }),
    v4,
    v6,
    tls: await startServer(text('tls'), { tls: true }),
    bodies: await startServer((request, response) => {
      if (request.url === '/endless') {
        response.writeHead(200);
        const timer = setInterval(() => response.write(Buffer.alloc(65536, 1)), 1);
        response.on('close', () => clearInterval(timer));
      } else if (request.url === '/stalled') {
        response.writeHead(200, { 'content-length': '1000' });
        response.write('only the beginning');
      } else if (request.url === '/moved') response.writeHead(302, { location: '/landed' }).end();
      else if (request.url === '/away') response.writeHead(302, { location: `http://127.0.0.1:${elsewhere.port}/secret` }).end();
      else response.end('landed');
    }),
    api: await startServer((request, response) => {
      if (request.url?.includes('upload-check')) response.setHeader('content-type', 'application/json').end('{"exists":false}');
      else response.writeHead(307, { location: `http://127.0.0.1:${elsewhere.port}/api/upload` }).end();
    }),
    elsewhere,
  };
  const proxied: string[] = [];
  const proxy = net.createServer((socket) => {
    socket.once('data', (data) => {
      proxied.push(data.toString('latin1').split('\r\n')[0]);
      socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
    });
    socket.on('error', () => {});
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const proxyUrl = `http://127.0.0.1:${(proxy.address() as net.AddressInfo).port}`;

  const scenario: NetChildScenario = {
    ca: testCertificate().cert,
    ports: { gate: servers.gate.port, v4: v4.port, v6: v6 ? v6.port : 0, tls: servers.tls.port, bodies: servers.bodies.port, api: servers.api.port, elsewhere: elsewhere.port },
  };
  const scenarioFile = path.join(dir, `scenario-${runtime}.json`);
  const reportFile = path.join(dir, `report-${runtime}.json`);
  writeFileSync(scenarioFile, JSON.stringify(scenario));
  try {
    // Not spawnSync: the servers above need this process's event loop
    const child = spawn(runtime, [bundle, scenarioFile, reportFile], {
      cwd: dir,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, ALL_PROXY: proxyUrl, http_proxy: proxyUrl, https_proxy: proxyUrl, all_proxy: proxyUrl, NODE_USE_ENV_PROXY: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    const timer = setTimeout(() => child.kill('SIGKILL'), 90_000);
    const status = await new Promise<number | null>((resolve) => child.on('close', resolve));
    clearTimeout(timer);
    if (!existsSync(reportFile)) throw new Error(`The network child (${runtime}) ended with status ${status} and no report.\n${output.slice(-3000)}`);
    const report = JSON.parse(readFileSync(reportFile, 'utf8')) as NetChildReport;
    if (report.fatal) throw new Error(`The network child (${runtime}) failed: ${report.fatal}`);
    return { report, servers, proxied };
  } finally {
    proxy.close();
  }
}

const paths = (server: TestServer) => server.hits.map((hit) => hit.url);

const runtimes: [string, boolean][] = [
  ['bun', hasBun || !withoutBun],
  ['node', true],
];

describe.each(runtimes)('the network policy in a %s process', (runtime, available) => {
  const test = available ? it : it.skip;
  let result: Run;

  beforeAll(async () => {
    if (!available) return;
    if (runtime === 'bun' && !hasBun) throw new Error('`bun` is not on PATH (set SANDBOX_TESTS_WITHOUT_BUN=1 to skip the Bun run)');
    result = await run(runtime);
  }, 120_000);

  test('runs in that runtime, with proxy variables set', () => {
    expect(result.report.runtime).toBe(runtime);
    expect(result.report.proxy).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  test('the lookup hook gates the connection: a name that resolves to loopback is refused although a server is listening there', () => {
    const { report, servers } = result;

    // If the runtime resolved the name itself, this would be "200 the gate is open"
    expect(report.gate).toMatch(/^refused: localhost resolves to (127\.0\.0\.1|::1), which is a loopback address$/);
    expect(report.gateProduction).toMatch(/^refused: localhost resolves to (127\.0\.0\.1|::1), which is a loopback address$/);
    expect(servers.gate.connections).toBe(0);
  });

  test('the connection goes to the address the hook returned', () => {
    const { report, servers } = result;

    expect(report.directionV4).toBe('200 v4');
    expect(report.inventedName).toBe('200 v4');
    expect(paths(servers.v4)).toEqual(['/direction', '/invented']);
    expect(servers.v4.hits.map((hit) => hit.headers.host)).toEqual([`localhost:${servers.v4.port}`, `only-in-the-resolver.test:${servers.v4.port}`]);
    // The same name and port, answered with the other loopback address
    expect(servers.v6, 'this machine has no ::1 to listen on, so half of this check cannot run').not.toBeNull();
    expect(report.directionV6).toBe('200 v6');
    expect(paths(servers.v6!)).toEqual(['/direction']);
  });

  test('TLS: the certificate is checked against the URL host name, which is also sent as SNI, while the address is pinned', () => {
    const { report, servers } = result;

    expect(report.tlsByName).toBe('200 tls');
    // Same server and address: a name the certificate does not cover, the bare address, an unknown authority
    expect(report.tlsWrongName).toBe('network: the request failed (ERR_TLS_CERT_ALTNAME_INVALID)');
    expect(report.tlsByAddress).toBe('network: the request failed (ERR_TLS_CERT_ALTNAME_INVALID)');
    expect(report.tlsUnknownAuthority).toMatch(/^network: the request failed \((DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE)\)$/);
    expect(paths(servers.tls)).toEqual(['/tls']);
    // What the client asked for in its handshakes (this server runs under Node, whatever the client is)
    expect(servers.tls.serverNames.filter((name) => name === 'secure.test').length).toBeGreaterThanOrEqual(1);
    expect(servers.tls.serverNames).not.toContain('127.0.0.1');
  });

  test('every request asks the hook again: an earlier connection to the same host is not reused', () => {
    expect(result.report.noReuse).toBe('refused: secure.test resolves to 127.0.0.1, which is a loopback address');
    expect(paths(result.servers.tls)).not.toContain('/reused');
  });

  test('bodies are cut at the cap and at the deadline, and redirects are followed by the policy, not the runtime', () => {
    const { report, servers } = result;

    expect(report.endless).toBe('too-large: the response is larger than 200000 bytes');
    expect(report.endlessMs).toBeLessThan(10_000);
    expect(report.stalled).toBe('timeout: no complete response within 500 ms');
    expect(report.redirectInside).toBe('200 landed');
    expect(report.redirectAway).toBe("refused: http:// is only allowed on the world's own origin (use https://)");
    expect(servers.bodies.cutShort).toBe(2);
  });

  test("loopback in other spellings is refused by this runtime's URL parser and the policy together", () => {
    const spellings = result.report.spellings as string[];
    expect(spellings).toHaveLength(14);
    for (const line of spellings) expect(line).toMatch(/ -> .*(loopback|unspecified)/);
  });

  test('the session token goes to the world only: not along a redirect, not to another origin', () => {
    const { report, servers } = result;

    expect(report.uploadRedirected).toMatch(/^refused here: Upload refused: the world's API answered with a redirect \(HTTP 307\)/);
    expect(report.uploadForeign).toMatch(/^refused here: Upload refused: the world's API URL is on http:\/\/127\.0\.0\.1:\d+, not on the world's own origin/);
    expect(servers.api.hits.map((hit) => [hit.method, hit.headers.authorization])).toEqual([
      ['GET', 'Bearer child-session-token'],
      ['POST', 'Bearer child-session-token'],
    ]);
    // Neither the redirected upload, nor the redirected download, nor the foreign API ever got there
    expect(servers.elsewhere.connections).toBe(0);
  });

  test('nothing went through the proxy the environment names', () => {
    expect(result.proxied).toEqual([]);
  });
});
