/**
 * Loaded before every test file (vitest.config.ts): the test process cannot reach anything but
 * this machine. A TCP connection to an address that is not loopback, and a DNS lookup of any name
 * but `localhost`, are refused, and the test that tried fails, also when the code under test
 * swallowed the error. Tests are written against servers on loopback (test-support/net.ts) and
 * injected resolvers; this is for the one that forgets.
 *
 * It covers what goes through node:net and node:dns in this process: node:http(s), the global
 * fetch, WebSockets. Child processes a test starts are on their own.
 */
import dns from 'node:dns';
import net from 'node:net';
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

// ---- TCP: only to loopback, whoever resolves the name ----
const connect = net.Socket.prototype.connect as AnyFunction;
(net.Socket.prototype as { connect: AnyFunction }).connect = function (this: net.Socket, ...args: any[]) {
  // connect(options[, listener]) is what node:http, node:tls and the global fetch use; the other
  // forms (port[, host], path) are normalised into it by Node before they get here
  const options = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (options === null || typeof options !== 'object' || typeof options.path === 'string') return connect.apply(this, args);
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

/** The attempts refused since the last call, for the guard's own test. */
export function takeNetworkAttempts(): string[] {
  return attempts.splice(0);
}

afterEach(() => {
  const made = attempts.splice(0);
  expect(made, 'this test tried to reach something outside this machine').toEqual([]);
});
