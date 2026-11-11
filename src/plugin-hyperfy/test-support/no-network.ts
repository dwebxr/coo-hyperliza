/**
 * Loaded before every test file (vitest.config.ts): the test process cannot reach anything but
 * this machine. A TCP connection to an address that is not loopback, a UDP datagram to one
 * (whoever resolved its name, a socket's own `lookup` included), a DNS lookup of any name but
 * `localhost`, the DNS queries of node:dns (dns.resolve*, dns.reverse, dns.lookupService, a
 * dns.Resolver, and their promise forms) and starting a worker thread are refused, and the test
 * that tried fails, also when the code under test swallowed the error. Tests are written against
 * servers on loopback (test-support/net.ts) and injected resolvers; this is for the one that forgets.
 *
 * It covers what goes through node:net, node:dgram and node:dns in this process, whether they are
 * imported whole or by name: node:http(s), node:tls, the global fetch, WebSockets, and
 * Socket.connect in the forms Node accepts (its own argument normalisation decides which is
 * which). A worker thread would be a new isolate without this guard, so none may be started.
 * Not covered: child processes a test starts (the Bun children of net-policy.child.test.ts and
 * the sandbox tests, where Bun.connect and Bun.udpSocket also exist; they are given loopback
 * servers only), and native modules with their own networking (none is loaded by a test:
 * @livekit/rtc-node is mocked).
 */
import dgram from 'node:dgram';
import dns from 'node:dns';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import workerThreads from 'node:worker_threads';
import { afterEach, expect } from 'vitest';

const attempts: string[] = [];
const isLoopback = (address: string) => /^127\.\d+\.\d+\.\d+$/.test(address) || address === '::1' || /^::ffff:127\.\d+\.\d+\.\d+$/i.test(address);
const isLocalName = (host: string) => host === 'localhost' || net.isIP(host) !== 0;
const refused = (what: string) => {
  attempts.push(what);
  return Object.assign(new Error(`A test tried to leave this machine: ${what}`), { code: 'ENETUNREACH' });
};

type AnyFunction = (...args: any[]) => any;

// ---- DNS: only `localhost` (answered from this machine) and addresses, which need no query ----
const systemLookup = dns.lookup as AnyFunction;
(dns as { lookup: AnyFunction }).lookup = function (hostname: string, ...rest: any[]) {
  if (isLocalName(hostname)) return systemLookup.call(dns, hostname, ...rest);
  const callback = rest.at(-1) as AnyFunction;
  queueMicrotask(() => callback(refused(`DNS lookup of ${hostname}`)));
  return {};
};
const systemLookupPromise = dns.promises.lookup as AnyFunction;
(dns.promises as { lookup: AnyFunction }).lookup = function (hostname: string, ...rest: any[]) {
  if (isLocalName(hostname)) return systemLookupPromise.call(dns.promises, hostname, ...rest);
  return Promise.reject(refused(`DNS lookup of ${hostname}`));
};

// ---- DNS queries: none at all (they go to the configured DNS server, never only to this machine) ----
const QUERIES = ['resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCaa', 'resolveCname', 'resolveMx', 'resolveNaptr', 'resolveNs', 'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTxt', 'reverse', 'lookupService'];
for (const target of [dns, dns.Resolver.prototype] as Record<string, unknown>[]) {
  for (const name of QUERIES) {
    if (typeof target[name] !== 'function') continue;
    target[name] = function (query: unknown, ...rest: any[]) {
      const callback = rest.at(-1) as AnyFunction;
      queueMicrotask(() => callback(refused(`DNS ${name} of ${String(query)}`)));
      return {};
    };
  }
}
for (const target of [dns.promises, dns.promises.Resolver.prototype] as Record<string, unknown>[]) {
  for (const name of QUERIES) {
    if (typeof target[name] !== 'function') continue;
    target[name] = (query: unknown) => Promise.reject(refused(`DNS ${name} of ${String(query)}`));
  }
}

// ---- UDP: only to loopback, whoever resolves the name ----

/**
 * A socket resolves a name through its handle's lookup (the `lookup` it was created with, or
 * dns.lookup), for where it sends and for where it binds: wrapped so that an answer that is
 * neither loopback nor the unspecified address (what a socket binds to by default) is refused.
 */
function guardUdpLookup(socket: dgram.Socket) {
  const state = Object.getOwnPropertySymbols(socket).find((symbol) => String(symbol) === 'Symbol(state symbol)');
  const handle = state ? (socket as any)[state]?.handle : undefined;
  if (!handle || typeof handle.lookup !== 'function' || handle.lookup[GUARDED]) return;
  const lookup = handle.lookup;
  handle.lookup = Object.assign(
    (address: string, callback: AnyFunction) =>
      lookup.call(handle, address, (error: Error | null, ip: string, family?: number) => {
        if (!error && !isLoopback(ip) && ip !== '0.0.0.0' && ip !== '::') return callback(refused(`UDP to ${address} (${ip})`));
        callback(error, ip, family);
      }),
    { [GUARDED]: true }
  );
}
const GUARDED = Symbol('guarded');

const dgramSend = dgram.Socket.prototype.send as AnyFunction;
(dgram.Socket.prototype as { send: AnyFunction }).send = function (this: dgram.Socket, message: unknown, ...rest: any[]) {
  guardUdpLookup(this);
  // send(msg[, offset, length][, port][, address][, callback]): the address is the only string
  const address = rest.find((arg) => typeof arg === 'string');
  if (address !== undefined && net.isIP(address) && !isLoopback(address)) {
    const error = refused(`UDP datagram to ${address}`);
    const callback = rest.at(-1);
    queueMicrotask(() => (typeof callback === 'function' ? callback(error) : this.emit('error', error)));
    return;
  }
  return dgramSend.call(this, message, ...rest);
};
const dgramConnect = dgram.Socket.prototype.connect as AnyFunction;
(dgram.Socket.prototype as { connect: AnyFunction }).connect = function (this: dgram.Socket, port: number, ...rest: any[]) {
  guardUdpLookup(this);
  const address = rest.find((arg) => typeof arg === 'string');
  if (address !== undefined && net.isIP(address) && !isLoopback(address)) {
    const error = refused(`UDP connection to ${address}:${port}`);
    queueMicrotask(() => this.emit('error', error));
    return;
  }
  return dgramConnect.call(this, port, ...rest);
};

// ---- TCP: only to loopback, whoever resolves the name ----

/**
 * The options of a Socket.connect call, as Node itself reads them: the array its own net.connect
 * passes, or whatever Node's argument normalisation (net._normalizeArgs) makes of the arguments.
 * A string is a port when Number() makes it a number of 0 or more ('0x50', '8e1', ' 80 ', ''),
 * and a local socket path otherwise.
 */
function connectOptions(args: any[]): Record<string, any> {
  if (Array.isArray(args[0])) return args[0][0];
  const normalize = (net as unknown as { _normalizeArgs?: (args: any[]) => [Record<string, any>] })._normalizeArgs;
  if (normalize) return normalize(args)[0];
  // The same rule, should a runtime not export it
  const first = args[0];
  if (first !== null && typeof first === 'object') return first;
  const asPort = Number(first);
  if (typeof first === 'string' && !(asPort >= 0)) return { path: first };
  return { port: first, host: typeof args[1] === 'string' ? args[1] : undefined };
}

const connect = net.Socket.prototype.connect as AnyFunction;
(net.Socket.prototype as { connect: AnyFunction }).connect = function (this: net.Socket, ...args: any[]) {
  const options = connectOptions(args);
  // A local (Unix domain) socket never leaves the machine
  if (typeof options.path === 'string') return connect.apply(this, args);
  const host: string = options.host ?? 'localhost';
  const fail = (what: string) => {
    const error = refused(what);
    queueMicrotask(() => this.destroy(error));
    return this;
  };
  if (net.isIP(host)) return isLoopback(host) ? connect.apply(this, args) : fail(`connection to ${host}:${options.port}`);
  const lookup = options.lookup as AnyFunction | undefined;
  // Without a resolver of the caller's, the runtime would ask DNS itself
  if (!lookup) return host === 'localhost' ? connect.apply(this, args) : fail(`connection to ${host}:${options.port}`);
  options.lookup = (name: string, lookupOptions: unknown, callback: AnyFunction) =>
    lookup(name, lookupOptions, (error: Error | null, address: string | { address: string }[], family?: number) => {
      const addresses = error ? [] : Array.isArray(address) ? address.map((entry) => entry.address) : [address];
      if (!addresses.every(isLoopback)) return callback(refused(`connection to ${name}:${options.port} (${addresses.join(', ')})`));
      callback(error, address, family);
    });
  return connect.apply(this, args);
};

// ---- worker threads: a new isolate would have none of the above ----
(workerThreads as { Worker: unknown }).Worker = function GuardedWorker(filename: unknown) {
  throw refused(`a worker thread (${String(filename).slice(0, 80)}), which this guard does not reach into`);
};

// Named imports of these modules (`import { lookup } from 'node:dns'`) see the patched functions too
syncBuiltinESMExports();

/** The attempts refused since the last call, for the guard's own test. */
export function takeNetworkAttempts(): string[] {
  return attempts.splice(0);
}

afterEach(() => {
  const made = attempts.splice(0);
  expect(made, 'this test tried to reach something outside this machine').toEqual([]);
});
