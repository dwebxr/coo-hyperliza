/**
 * Entry of the network-policy child process (bundled and spawned by lib/net-policy.child.test.ts,
 * under Bun and under Node). The policy rests on what the runtime does with node:http(s): that it
 * asks the `lookup` hook for every connection, connects where the hook says, checks certificates
 * against the URL's host name, follows no redirect on its own and ignores proxy variables. Bun
 * implements node:http itself, so each of those is checked in the runtime the agent runs in.
 *
 * The servers live in the parent (argv: scenario file, report file). Every request made here goes
 * to 127.0.0.1 or ::1.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { AssetUploadError, uploadAsset } from '../lib/asset-upload';
import { NetPolicy, SafeFetchError, safeFetch } from '../lib/net-policy';

export interface NetChildScenario {
  /** The test certificate (its own authority) */
  ca: string;
  ports: {
    /** https; `localhost` is in its certificate. Nothing may ever connect to it. */
    gate: number;
    /** http on 127.0.0.1 and, same port, on ::1 (0 when ::1 cannot be bound) */
    v4: number;
    v6: number;
    /** https with the test certificate */
    tls: number;
    /** http: /endless never stops sending, /stalled sends a little and stops, /away redirects to `elsewhere` */
    bodies: number;
    /** http, the world's API: the upload-check passes, the upload is redirected to `elsewhere` */
    api: number;
    /** Nothing may ever connect to it */
    elsewhere: number;
  };
}

export type NetChildReport = { runtime: string; proxy: string | undefined; fatal?: string } & Record<string, unknown>;

const outcome = (pending: Promise<{ status: number; body: Uint8Array }>): Promise<string> =>
  pending.then(
    (answer) => `${answer.status} ${new TextDecoder().decode(answer.body)}`,
    (error: unknown) => (error instanceof SafeFetchError ? `${error.kind}: ${error.message}` : `unexpected ${String(error)}`)
  );

async function main(): Promise<NetChildReport> {
  const { ca, ports }: NetChildScenario = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  const report: NetChildReport = { runtime: (globalThis as { Bun?: unknown }).Bun ? 'bun' : 'node', proxy: process.env.HTTPS_PROXY };
  const resolver = (hosts: Record<string, string>) => async (hostname: string) => {
    const address = hosts[hostname];
    if (!address) throw Object.assign(new Error(`ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' });
    return [{ address, family: address.includes(':') ? 6 : 4 }];
  };

  // 1. The gate. `localhost` resolves to loopback by the system's own resolver, nothing injected;
  // a server with a certificate for localhost listens where the request would go. Only the port
  // is re-targeted (443 cannot be bound in a test), so the address is the lookup hook's to give.
  const gate = new NetPolicy({ ca, dial: (_hostname, port) => (port === 443 ? { port: ports.gate } : undefined) });
  report.gate = await outcome(gate.fetch('https://localhost/gate', { maxBytes: 100, timeoutMs: 10_000 }));
  // The same without any seam at all: the agent's own safeFetch
  report.gateProduction = await outcome(safeFetch('https://localhost/gate', { maxBytes: 100, timeoutMs: 10_000 }));
  // A runtime that did not ask the hook would resolve the made-up names below by itself, over the
  // network: stop here, with only `localhost` asked for
  if (![report.gate, report.gateProduction].every((result) => String(result).startsWith('refused: localhost resolves to'))) return report;

  // 2. The connection goes where the hook says: the same name, answered with ::1 and then with 127.0.0.1
  const origin = `http://localhost:${ports.v4}`;
  report.directionV4 = await outcome(new NetPolicy({ worldOrigin: origin, resolve: resolver({ localhost: '127.0.0.1' }) }).fetch(`${origin}/direction`, { maxBytes: 100 }));
  report.directionV6 = ports.v6 ? await outcome(new NetPolicy({ worldOrigin: origin, resolve: resolver({ localhost: '::1' }) }).fetch(`${origin}/direction`, { maxBytes: 100 })) : 'no ::1 on this machine';
  // ...and to a name that exists only in the resolver handed to the policy
  const invented = `http://only-in-the-resolver.test:${ports.v4}`;
  report.inventedName = await outcome(new NetPolicy({ worldOrigin: invented, resolve: resolver({ 'only-in-the-resolver.test': '127.0.0.1' }) }).fetch(`${invented}/invented`, { maxBytes: 100 }));

  // 3. TLS: the certificate names secure.test (and no address); the connection is to 127.0.0.1
  const hosts = resolver({ 'secure.test': '127.0.0.1', 'other.test': '127.0.0.1' });
  const tlsWorld = (host: string, withCa = true) => new NetPolicy({ worldOrigin: `https://${host}:${ports.tls}`, resolve: hosts, ...(withCa ? { ca } : {}) });
  report.tlsByName = await outcome(tlsWorld('secure.test').fetch(`https://secure.test:${ports.tls}/tls`, { maxBytes: 100 }));
  report.tlsWrongName = await outcome(tlsWorld('other.test').fetch(`https://other.test:${ports.tls}/tls-wrong-name`, { maxBytes: 100 }));
  report.tlsByAddress = await outcome(tlsWorld('127.0.0.1').fetch(`https://127.0.0.1:${ports.tls}/tls-by-address`, { maxBytes: 100 }));
  report.tlsUnknownAuthority = await outcome(tlsWorld('secure.test', false).fetch(`https://secure.test:${ports.tls}/tls-unknown-authority`, { maxBytes: 100 }));

  // 4. Every request asks the hook: after the request above, the same host and real port through a
  // policy with no exception must be refused, not served over a connection kept from before
  const strict = new NetPolicy({ ca, resolve: hosts, dial: (_hostname, port) => (port === 443 ? { port: ports.tls } : undefined) });
  report.noReuse = await outcome(strict.fetch('https://secure.test/reused', { maxBytes: 100 }));

  // 5. Bounds and redirects, as this runtime's node:http delivers them
  const bodies = `http://127.0.0.1:${ports.bodies}`;
  const world = new NetPolicy({ worldOrigin: bodies });
  const started = Date.now();
  report.endless = await outcome(world.fetch(`${bodies}/endless`, { maxBytes: 200_000, timeoutMs: 20_000 }));
  report.endlessMs = Date.now() - started;
  report.stalled = await outcome(world.fetch(`${bodies}/stalled`, { maxBytes: 200_000, timeoutMs: 500 }));
  report.redirectInside = await outcome(world.fetch(`${bodies}/moved`, { maxBytes: 100 }));
  report.redirectAway = await outcome(world.fetch(`${bodies}/away`, { maxBytes: 100 }));

  // 6. What this runtime's URL parser makes of loopback in other spellings
  report.spellings = ['https://2130706433/', 'https://0x7f000001/', 'https://0x7f.0.0.1/', 'https://017700000001/', 'https://127.1/', 'https://127.0.0.1./', 'https://１２７.0.0.1/', 'https://0/', 'https://[::1]/', 'https://[0:0:0:0:0:0:0:1]/', 'https://[::ffff:127.0.0.1]/', 'https://[::ffff:7f00:1]/', 'https://[64:ff9b::7f00:1]/', 'https://[2002:7f00:1::]/'].map(
    (url) => `${url} -> ${gate.urlProblem(url) ?? 'ALLOWED'}`
  );

  // 7. The session token: sent to the world, never along a redirect, never to another origin, never through a proxy
  const file = () => new File([new Uint8Array([1, 2, 3])], 'thing.glb');
  const upload = (apiUrl: string, worldOrigin: string) =>
    uploadAsset({ apiUrl }, file(), { net: new NetPolicy({ worldOrigin }), authToken: 'child-session-token' }).then(
      () => 'uploaded',
      (error: unknown) => (error instanceof AssetUploadError ? `${error.refusedHere ? 'refused here' : 'failed'}: ${error.message}` : `unexpected ${String(error)}`)
    );
  report.uploadRedirected = await upload(`http://127.0.0.1:${ports.api}/api`, `http://127.0.0.1:${ports.api}`);
  report.uploadForeign = await upload(`http://127.0.0.1:${ports.elsewhere}/api`, `http://127.0.0.1:${ports.api}`);
  return report;
}

const finish = (report: NetChildReport, status: number) => {
  writeFileSync(process.argv[3], JSON.stringify(report));
  process.exit(status);
};
main().then(
  (report) => finish(report, 0),
  (error) => finish({ runtime: 'unknown', proxy: undefined, fatal: String(error?.stack ?? error) }, 1)
);
