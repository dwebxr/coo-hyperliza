/**
 * Loopback servers and a test certificate for the outbound-policy tests. Nothing here, and no test
 * built on it, sends anything off the machine: "public" hosts are names an injected resolver
 * answers with a public address, and the policy's `dial` seam stands a loopback server in for it.
 */
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import https from 'node:https';
import { type AddressInfo, type Socket, isIP } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NetPolicy, type NetPolicyOptions, type ResolvedAddress } from '../lib/net-policy';

/** Host names the test certificate is valid for. `other.test` is deliberately not one of them. */
export const CERTIFIED_HOSTS = ['secure.test', 'cdn.test', 'world.test', 'api.test', 'assets.test', 'localhost'];

/** An address in public space that tests hand out as "the public internet". It is never dialled. */
export const PUBLIC_ADDRESS = '93.184.216.34';

export interface TestCertificate {
  key: string;
  cert: string;
}

let certificate: TestCertificate | undefined;

/**
 * A self-signed certificate for CERTIFIED_HOSTS, made once per process with the `openssl` command
 * (Node has no way to issue one). It is its own authority: pass `cert` as the policy's `ca`.
 */
export function testCertificate(): TestCertificate {
  if (certificate) return certificate;
  const dir = mkdtempSync(path.join(tmpdir(), 'coo-net-cert-'));
  try {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const key = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    writeFileSync(path.join(dir, 'key.pem'), key, { mode: 0o600 });
    writeFileSync(
      path.join(dir, 'openssl.cnf'),
      [
        '[req]',
        'distinguished_name = dn',
        'x509_extensions = ext',
        'prompt = no',
        '[dn]',
        'CN = coo net-policy tests',
        '[ext]',
        `subjectAltName = ${CERTIFIED_HOSTS.map((host) => `DNS:${host}`).join(',')}`,
        'basicConstraints = CA:TRUE',
      ].join('\n')
    );
    const made = spawnSync('openssl', ['req', '-new', '-x509', '-key', 'key.pem', '-out', 'cert.pem', '-days', '2', '-config', 'openssl.cnf'], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH } });
    if (made.status !== 0) {
      throw new Error(`The network tests need the \`openssl\` command to make a throwaway certificate: ${made.error?.message ?? made.stderr}`);
    }
    certificate = { key, cert: readFileSync(path.join(dir, 'cert.pem'), 'utf8') };
    return certificate;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface Hit {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}

export interface TestServer {
  port: number;
  /** Every request received, in order. */
  hits: Hit[];
  /** TCP connections accepted (a TLS handshake that fails still counts). */
  connections: number;
  /** Server names asked for in TLS handshakes. */
  serverNames: string[];
  /** Responses whose connection closed before the handler finished them. */
  cutShort: number;
  close(): Promise<void>;
}

export type Handler = (request: IncomingMessage, response: ServerResponse, hit: Hit) => void;

const servers = new Set<TestServer>();

/** A server on loopback (127.0.0.1 unless `host` says ::1), plain or with the test certificate. */
export async function startServer(handler: Handler, { tls = false, host = '127.0.0.1', port = 0 }: { tls?: boolean; host?: string; port?: number } = {}): Promise<TestServer> {
  const state: TestServer = { port: 0, hits: [], connections: 0, serverNames: [], cutShort: 0, close: async () => {} };
  const onRequest = (request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const hit: Hit = { method: request.method ?? '', url: request.url ?? '', headers: request.headers, body: Buffer.concat(chunks).toString() };
      state.hits.push(hit);
      response.on('close', () => {
        if (!response.writableFinished) state.cutShort++;
      });
      handler(request, response, hit);
    });
  };
  const server = tls
    ? https.createServer(
        {
          ...testCertificate(),
          SNICallback: (name, done) => {
            state.serverNames.push(name);
            done(null);
          },
        },
        onRequest
      )
    : http.createServer(onRequest);
  const sockets = new Set<Socket>();
  server.on('connection', (socket: Socket) => {
    state.connections++;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  state.port = (server.address() as AddressInfo).port;
  state.close = () =>
    new Promise<void>((resolve) => {
      servers.delete(state);
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    });
  servers.add(state);
  return state;
}

/** Closes every server started with startServer (for afterEach). */
export async function closeServers(): Promise<void> {
  await Promise.all([...servers].map((server) => server.close()));
}

const isLoopback = (address: string) => /^127\.\d+\.\d+\.\d+$/.test(address) || address === '::1';

export interface TestNet {
  policy: NetPolicy;
  /** Host names the resolver was asked for, in order. */
  resolved: string[];
}

/**
 * A policy over a made-up internet. `hosts` is the resolver (a name it does not know fails, as an
 * unknown name does). `routes` are the stand-ins, keyed `host:port` as the URL names them: a number
 * re-targets the port only, so the connection still goes to the address the policy's lookup hook
 * returns; `{ port, direct: true }` dials 127.0.0.1 directly, for a host that "resolves" to a
 * public address.
 */
export function testNet({
  hosts = {},
  routes = {},
  worldOrigin,
  tls = true,
}: {
  hosts?: Record<string, string | string[]>;
  routes?: Record<string, number | { port: number; direct: true }>;
  worldOrigin?: string;
  tls?: boolean;
} = {}): TestNet {
  const resolved: string[] = [];
  const options: NetPolicyOptions = {
    worldOrigin,
    resolve: async (hostname) => {
      resolved.push(hostname);
      const answer = hosts[hostname];
      if (answer === undefined) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' });
      return [answer].flat().map((address): ResolvedAddress => ({ address, family: address.includes(':') ? 6 : 4 }));
    },
    dial: (hostname, port) => {
      const route = routes[`${hostname}:${port}`];
      if (typeof route === 'object') return { address: '127.0.0.1', port: route.port };
      // Otherwise the connection goes where the name points (a name the resolver does not know
      // goes nowhere). That must be this machine, also when the check under test is missing.
      const addresses = [hosts[hostname] ?? (isIP(hostname) ? hostname : [])].flat();
      if (!addresses.every(isLoopback)) throw new Error(`Test bug: ${hostname}:${port} has no direct route and could be dialled off this machine`);
      return route === undefined ? undefined : { port: route };
    },
    ...(tls ? { ca: testCertificate().cert } : {}),
  };
  return { policy: new NetPolicy(options), resolved };
}
