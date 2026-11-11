import dgram from 'node:dgram';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { Worker } from 'node:worker_threads';
import { lookup as namedLookup, resolve4 as namedResolve4 } from 'node:dns';
import { resolveTxt as namedResolveTxt } from 'node:dns/promises';
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

  it('refuses Socket.connect in the forms Node accepts, on a Socket made directly, and tls.connect', async () => {
    const refusal = (socket: net.Socket) => new Promise<string>((resolve) => socket.on('error', (error) => resolve(error.message)).on('connect', () => resolve('reached')));
    expect(await refusal(new net.Socket().connect(80, '192.0.2.1'))).toContain('connection to 192.0.2.1:80');
    // A numeric string is a port (Node's normalizeArgs); the types do not list this form
    const byString = new net.Socket();
    expect(await refusal((byString.connect as (...args: unknown[]) => net.Socket).call(byString, '80', '192.0.2.1'))).toContain('connection to 192.0.2.1:80');
    expect(await refusal(new net.Socket().connect(80, '192.0.2.1', () => {}))).toContain('connection to 192.0.2.1:80');
    expect(await refusal(new net.Socket().connect({ port: 80, host: '2001:db8::1' }))).toContain('connection to 2001:db8::1:80');
    expect(await refusal(new net.Socket().connect(80, 'guard-test.invalid'))).toContain('connection to guard-test.invalid:80');
    expect(await refusal(net.createConnection({ port: 80, host: '192.0.2.1' }))).toContain('connection to 192.0.2.1:80');
    expect(await refusal(tls.connect({ port: 443, host: '192.0.2.1' }))).toContain('connection to 192.0.2.1:443');
    expect(await refusal(tls.connect(443, 'guard-test.invalid'))).toContain('connection to guard-test.invalid:443');
    // An empty path is no local socket to Node (it picks one by `!!path`): this is TCP
    expect(await refusal(new net.Socket().connect({ path: '', host: '192.0.2.1', port: 80 }))).toContain('connection to 192.0.2.1:80');
    // Strings Number() makes a port of 0 or more are ports to Node, not socket paths
    for (const port of ['0x50', '8e1', '+80', ' 80 ']) {
      const socket = new net.Socket();
      expect(await refusal((socket.connect as (...args: unknown[]) => net.Socket).call(socket, port, '192.0.2.1')), port).toContain('connection to 192.0.2.1:');
    }
    expect(takeNetworkAttempts()).toHaveLength(13);
  });

  it('lets the other forms reach this machine: a port alone (localhost), loopback by address, a local socket', async () => {
    const server = await startServer((_request, response) => response.end('here'));
    const reached = (socket: net.Socket) => new Promise<string>((resolve) => socket.on('error', (error) => resolve(error.message)).on('connect', () => (socket.destroy(), resolve('reached'))));
    expect(await reached(new net.Socket().connect(server.port, '127.0.0.1'))).toBe('reached');
    expect(await reached(new net.Socket().connect(server.port))).toMatch(/reached|ECONNREFUSED/);
    const socketPath = path.join(os.tmpdir(), `no-network-${process.pid}.sock`);
    const local = net.createServer((socket) => socket.end()).listen(socketPath);
    await new Promise((resolve) => local.once('listening', resolve));
    expect(await reached(new net.Socket().connect(socketPath))).toBe('reached');
    await new Promise((resolve) => local.close(resolve));
    expect(takeNetworkAttempts()).toEqual([]);
  });

  it('refuses the DNS queries of node:dns: dns.resolve*, reverse and lookupService, the promise forms, a Resolver, and named imports', async () => {
    const message = (run: (callback: (error: Error | null) => void) => void) => new Promise<string>((resolve) => run((error) => resolve(String(error?.message))));
    expect(await message((cb) => dns.resolve4('guard-test.invalid', cb))).toContain('DNS resolve4 of guard-test.invalid');
    expect(await message((cb) => dns.resolve('guard-test.invalid', 'TXT', cb))).toContain('DNS resolve of guard-test.invalid');
    expect(await message((cb) => dns.reverse('192.0.2.1', cb))).toContain('DNS reverse of 192.0.2.1');
    expect(await message((cb) => dns.lookupService('192.0.2.1', 80, cb))).toContain('DNS lookupService of 192.0.2.1');
    expect(await message((cb) => new dns.Resolver().resolve6('guard-test.invalid', cb))).toContain('DNS resolve6 of guard-test.invalid');
    expect(await outcome(dns.promises.resolveTxt('guard-test.invalid'))).toContain('DNS resolveTxt of guard-test.invalid');
    expect(await outcome(new dns.promises.Resolver().resolveMx('guard-test.invalid'))).toContain('DNS resolveMx of guard-test.invalid');
    // Methods the module has today, found at run time (resolveTlsa is newer than most lists)
    expect(await message((cb) => (dns as any).resolveTlsa('guard-test.invalid', cb))).toContain('DNS resolveTlsa of guard-test.invalid');
    expect(await outcome((dns.promises as any).resolveTlsa('guard-test.invalid'))).toContain('DNS resolveTlsa of guard-test.invalid');
    expect(await message((cb) => (new dns.Resolver() as any).resolveTlsa('guard-test.invalid', cb))).toContain('DNS resolveTlsa of guard-test.invalid');
    // Imported by name, not through the module object
    expect(await message((cb) => namedResolve4('guard-test.invalid', cb))).toContain('DNS resolve4 of guard-test.invalid');
    expect(await message((cb) => namedLookup('guard-test.invalid', cb))).toContain('DNS lookup of guard-test.invalid');
    expect(await outcome(namedResolveTxt('guard-test.invalid'))).toContain('DNS resolveTxt of guard-test.invalid');
    expect(takeNetworkAttempts()).toHaveLength(13);
  });

  it('refuses UDP to a name whose socket lookup answers with an address that is not loopback', async () => {
    // Addresses (the socket's own bind to 0.0.0.0) answer as themselves, names with `address`
    const answering = (address: string) => (name: string, _options: unknown, callback: (error: Error | null, address: string, family: number) => void) => callback(null, net.isIP(name) ? name : address, 4);
    const remote = dgram.createSocket({ type: 'udp4', lookup: answering('192.0.2.1') as never });
    const local = dgram.createSocket({ type: 'udp4', lookup: answering('127.0.0.1') as never });
    try {
      expect(await new Promise((resolve) => remote.send('x', 53, 'udp-target.invalid', (error) => resolve(error?.message)))).toContain('UDP to udp-target.invalid (192.0.2.1)');
      const failed = new Promise((resolve) => remote.once('error', (error) => resolve(error.message)));
      remote.connect(53, 'udp-target.invalid');
      expect(await failed).toContain('UDP to udp-target.invalid (192.0.2.1)');
      expect(await new Promise((resolve) => local.send('x', 9, 'udp-target.invalid', (error) => resolve(error?.message ?? 'sent')))).toBe('sent');
    } finally {
      remote.close();
      local.close();
    }
    expect(takeNetworkAttempts()).toHaveLength(2);
  });

  it('refuses to start a worker thread, which would run without the guard', () => {
    expect(() => new Worker('console.log(1)', { eval: true })).toThrow('A test tried to leave this machine: a worker thread');
    expect(takeNetworkAttempts()).toHaveLength(1);
  });

  it('refuses a UDP datagram or connection to an address that is not loopback, and lets loopback through', async () => {
    const socket = dgram.createSocket('udp4');
    try {
      expect(await new Promise((resolve) => socket.send('x', 53, '192.0.2.1', (error) => resolve(error?.message)))).toContain('UDP datagram to 192.0.2.1');
      expect(await new Promise((resolve) => socket.send(Buffer.from('xy'), 0, 1, 53, '192.0.2.1', (error) => resolve(error?.message)))).toContain('UDP datagram to 192.0.2.1');
      const other = dgram.createSocket('udp4');
      const failed = new Promise((resolve) => other.once('error', (error) => resolve(error.message)));
      other.connect(53, '192.0.2.1');
      expect(await failed).toContain('UDP connection to 192.0.2.1:53');
      other.close();
      expect(await new Promise((resolve) => socket.send('x', 9, '127.0.0.1', (error) => resolve(error?.message ?? 'sent')))).toBe('sent');
    } finally {
      socket.close();
    }
    expect(takeNetworkAttempts()).toHaveLength(3);
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
