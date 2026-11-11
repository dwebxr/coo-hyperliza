import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { closeServers, startServer } from './net';
import { takeNetworkAttempts } from './no-network';

/*
 * The guard every test file runs under (no-network.ts, a vitest setup file). Each case here tries
 * to leave the machine on purpose and takes the recorded attempt back, which is what would
 * otherwise fail the test. The targets are documentation addresses (192.0.2.1, 2001:db8::1) and a
 * name under .invalid, which belong to nobody: should the guard ever stop working, that is all
 * these tests would send.
 */

afterEach(closeServers);

const outcome = (pending: Promise<unknown>) => pending.then(() => 'reached', (error: Error & { cause?: Error }) => `${error.message} ${error.cause?.message ?? ''}`);
const get = (module: typeof http | typeof https, options: http.RequestOptions) =>
  new Promise<string>((resolve) => {
    const request = module.request(options, (response) => {
      response.resume();
      response.on('end', () => resolve(`reached ${response.statusCode}`));
    });
    request.on('error', (error) => resolve(error.message));
    request.end();
  });

describe('the no-network guard of the test process', () => {
  it('refuses a connection to an address that is not loopback, before anything is sent', async () => {
    expect(await outcome(fetch('http://192.0.2.1/'))).toContain('A test tried to leave this machine: connection to 192.0.2.1:80');
    expect(await get(http, { host: '192.0.2.1', port: 80, agent: false })).toBe('A test tried to leave this machine: connection to 192.0.2.1:80');
    expect(await get(https, { host: '2001:db8::1', port: 443, agent: false })).toContain('connection to 2001:db8::1:443');
    expect(await new Promise((resolve) => net.connect(9, '10.0.0.1').on('error', (error) => resolve(error.message)))).toContain('connection to 10.0.0.1:9');
    expect(takeNetworkAttempts()).toHaveLength(4);
  });

  it('refuses a host name without asking DNS, in the global fetch, node:http and node:dns', async () => {
    expect(await outcome(fetch('https://guard-test.invalid/'))).toContain('A test tried to leave this machine: connection to guard-test.invalid:443');
    expect(await get(http, { host: 'guard-test.invalid', port: 80, agent: false })).toBe('A test tried to leave this machine: connection to guard-test.invalid:80');
    expect(await outcome(dns.promises.lookup('guard-test.invalid'))).toContain('DNS lookup of guard-test.invalid');
    expect(await new Promise((resolve) => dns.lookup('guard-test.invalid', (error) => resolve(error?.message)))).toContain('DNS lookup of guard-test.invalid');
    expect(await new Promise((resolve) => dns.lookup('guard-test.invalid', { all: true }, (error) => resolve(error?.message)))).toContain('DNS lookup of guard-test.invalid');
    expect(takeNetworkAttempts()).toEqual(['connection to guard-test.invalid:443', 'connection to guard-test.invalid:80', 'DNS lookup of guard-test.invalid', 'DNS lookup of guard-test.invalid', 'DNS lookup of guard-test.invalid']);
  });

  it("refuses a name that a caller's own resolver sends off the machine, and lets one that stays here through", async () => {
    const server = await startServer((_request, response) => response.end('here'));
    const lookup = (address: string) => ((_name: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) =>
      options.all ? callback(null, [{ address, family: 4 }]) : callback(null, address, 4)) as unknown as net.LookupFunction;

    expect(await get(http, { host: 'anything.test', port: server.port, agent: false, lookup: lookup('127.0.0.1') })).toBe('reached 200');
    expect(takeNetworkAttempts()).toEqual([]);
    expect(await get(http, { host: 'anything.test', port: server.port, agent: false, lookup: lookup('192.0.2.1') })).toContain(`connection to anything.test:${server.port} (192.0.2.1)`);
    expect(takeNetworkAttempts()).toHaveLength(1);
  });

  it('leaves this machine reachable: loopback addresses, localhost, and the lookup of localhost', async () => {
    const server = await startServer((_request, response) => response.end('here'));

    expect(await outcome(fetch(`http://127.0.0.1:${server.port}/`).then((r) => r.text()))).toBe('reached');
    expect(await get(http, { host: '127.0.0.1', port: server.port, agent: false })).toBe('reached 200');
    expect((await dns.promises.lookup('localhost', { all: true })).length).toBeGreaterThan(0);
    expect((await dns.promises.lookup('127.0.0.1')).address).toBe('127.0.0.1');
    expect(takeNetworkAttempts()).toEqual([]);
  });
});
