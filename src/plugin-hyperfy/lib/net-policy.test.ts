import { afterEach, describe, expect, it } from 'vitest';
import { MAX_REDIRECTS, NetPolicy, SafeFetchError, addressProblem, safeFetch, toResponse } from './net-policy';
import { PUBLIC_ADDRESS, closeServers, startServer, testNet } from '../test-support/net';

/*
 * The real policy over node:http(s), against servers on loopback. A "public" host is a name the
 * injected resolver answers with a public address and a `direct` route stands a loopback server in
 * for (test-support/net.ts); a name that resolves to loopback is reached through the policy's own
 * lookup hook. Every refusal test has a listening server where the request would land without the
 * check, and asserts that it saw nothing. No request leaves the machine.
 */

afterEach(closeServers);

const text = (body: Uint8Array) => new TextDecoder().decode(body);
const refusal = async (pending: Promise<unknown>): Promise<SafeFetchError> => {
  const error = await pending.then(
    () => new Error('the request was not refused'),
    (e: unknown) => e
  );
  expect(error).toBeInstanceOf(SafeFetchError);
  return error as SafeFetchError;
};
const ok = () => startServer((_request, response) => response.end('ok'), { tls: true });

describe('addressProblem', () => {
  it.each([
    // IPv4
    ['0.0.0.0', 'unspecified'],
    ['0.1.2.3', 'unspecified'],
    ['10.0.0.1', 'private'],
    ['10.255.255.255', 'private'],
    ['100.64.0.1', 'carrier-grade NAT'],
    ['100.127.255.254', 'carrier-grade NAT'],
    ['100.100.100.200', 'cloud metadata'],
    ['127.0.0.1', 'loopback'],
    ['127.255.255.254', 'loopback'],
    ['169.254.0.1', 'link-local'],
    ['169.254.169.254', 'cloud metadata'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.0.0.1', 'protocol-assignment'],
    ['192.0.0.192', 'cloud metadata'],
    ['192.0.2.1', 'documentation'],
    ['192.88.99.1', '6to4 relay'],
    ['192.168.1.1', 'private'],
    ['198.18.0.1', 'benchmarking'],
    ['198.19.255.255', 'benchmarking'],
    ['198.51.100.7', 'documentation'],
    ['203.0.113.7', 'documentation'],
    ['168.63.129.16', 'cloud metadata'],
    ['224.0.0.1', 'multicast'],
    ['239.255.255.255', 'multicast'],
    ['240.0.0.1', 'reserved'],
    ['255.255.255.255', 'broadcast'],
    // IPv6
    ['::', 'unspecified'],
    ['::1', 'loopback'],
    ['0:0:0:0:0:0:0:1', 'loopback'],
    ['::7f00:1', 'IPv4-compatible'],
    ['::0.0.0.2', 'IPv4-compatible'],
    ['::ffff:127.0.0.1', 'IPv4-mapped form of a loopback'],
    ['::ffff:7f00:1', 'IPv4-mapped form of a loopback'],
    ['::ffff:10.0.0.1', 'IPv4-mapped form of a private'],
    ['::ffff:a9fe:a9fe', 'IPv4-mapped form of a cloud metadata'],
    ['::FFFF:192.168.0.1', 'IPv4-mapped form of a private'],
    ['64:ff9b::127.0.0.1', 'NAT64 form of a loopback'],
    ['64:ff9b::a00:1', 'NAT64 form of a private'],
    ['64:ff9b::a9fe:a9fe', 'NAT64 form of a cloud metadata'],
    ['64:ff9b:1::a00:1', 'local-use NAT64'],
    ['2002:7f00:1::', '6to4 form of a loopback'],
    ['2002:a00:1::1', '6to4 form of a private'],
    ['2002:c0a8:101::1', '6to4 form of a private'],
    ['2002:a9fe:a9fe::', '6to4 form of a cloud metadata'],
    ['fc00::1', 'unique local'],
    ['fd12:3456:789a::1', 'unique local'],
    ['fd00:ec2::254', 'cloud metadata'],
    ['fe80::1', 'link-local'],
    ['fe80::1%en0', 'link-local'],
    ['febf::1', 'link-local'],
    ['fec0::1', 'site-local'],
    ['ff02::1', 'multicast'],
    ['ff0e::1', 'multicast'],
    ['2001::1', 'Teredo'],
    ['2001:0:7f00:1::', 'Teredo'],
    ['2001:2::1', 'protocol-assignment'],
    ['2001:10::1', 'protocol-assignment'],
    ['2001:db8::1', 'documentation'],
    ['3fff::1', 'documentation'],
    ['100::1', 'not a global unicast'],
    ['4000::1', 'not a global unicast'],
    ['e000::1', 'not a global unicast'],
    // not addresses at all
    ['localhost', 'not an IP address'],
    ['127.1', 'not an IP address'],
    ['0x7f.0.0.1', 'not an IP address'],
    ['', 'not an IP address'],
  ])('%s is refused (%s)', (address, why) => {
    expect(addressProblem(address)).toContain(why);
  });

  it.each([
    '1.1.1.1',
    '8.8.8.8',
    PUBLIC_ADDRESS,
    '100.63.255.255',
    '100.128.0.1',
    '169.253.255.255',
    '172.15.255.255',
    '172.32.0.1',
    '192.0.1.1',
    '192.167.255.255',
    '198.17.255.255',
    '198.20.0.1',
    '223.255.255.254',
    '2606:4700:4700::1111',
    '2001:4860:4860::8888',
    '2001:200::1',
    '2a00:1450:4001::1',
    '2003::1',
    '3ffe::1',
    '::ffff:8.8.8.8',
    '64:ff9b::808:808',
    '2002:808:808::1',
  ])('%s is a public address', (address) => {
    expect(addressProblem(address)).toBeNull();
  });
});

describe('what a request may reach', () => {
  it('fetches a public https host, with the URL host as Host and SNI, and nothing added', async () => {
    const server = await startServer((_request, response) => response.writeHead(200, { 'content-type': 'model/gltf-binary', 'x-one': 'a' }).end('glb-bytes'), { tls: true });
    const { policy, resolved } = testNet({ hosts: { 'cdn.test': PUBLIC_ADDRESS }, routes: { 'cdn.test:443': { port: server.port, direct: true } } });

    const answer = await policy.fetch('https://cdn.test/models/a.glb?v=1', { maxBytes: 100 });

    expect(answer).toMatchObject({ url: 'https://cdn.test/models/a.glb?v=1', status: 200, statusText: 'OK' });
    expect(answer.headers).toMatchObject({ 'content-type': 'model/gltf-binary', 'x-one': 'a' });
    expect(text(answer.body)).toBe('glb-bytes');
    expect(resolved).toEqual(['cdn.test']);
    expect(server.serverNames).toEqual(['cdn.test']);
    expect(server.hits).toHaveLength(1);
    const [{ method, url, headers }] = server.hits;
    expect([method, url, headers.host]).toEqual(['GET', '/models/a.glb?v=1', 'cdn.test']);
    expect(Object.keys(headers).sort()).toEqual(['accept-encoding', 'connection', 'host', 'user-agent']);
    expect(headers['accept-encoding']).toBe('identity');
  });

  it.each([
    ['a loopback literal', 'https://127.0.0.1/', 'loopback'],
    ['decimal', 'https://2130706433/', 'loopback'],
    ['hex', 'https://0x7f000001/', 'loopback'],
    ['hex parts', 'https://0x7f.0.0.1/', 'loopback'],
    ['octal', 'https://017700000001/', 'loopback'],
    ['short form', 'https://127.1/', 'loopback'],
    ['a trailing dot', 'https://127.0.0.1./', 'loopback'],
    ['full-width digits', 'https://１２７.0.0.1/', 'loopback'],
    ['zero', 'https://0/', 'unspecified'],
    ['bracketed IPv6 loopback', 'https://[::1]/', 'loopback'],
    ['bracketed IPv6 loopback, long form', 'https://[0:0:0:0:0:0:0:1]/', 'loopback'],
    ['IPv4-mapped IPv6', 'https://[::ffff:127.0.0.1]/', 'IPv4-mapped form of a loopback'],
    ['IPv4-mapped IPv6 in hex', 'https://[::ffff:7f00:1]/', 'IPv4-mapped form of a loopback'],
    ['NAT64', 'https://[64:ff9b::7f00:1]/', 'NAT64 form of a loopback'],
    ['6to4', 'https://[2002:7f00:1::]/', '6to4 form of a loopback'],
  ])('refuses an IP-literal host written as %s, and connects to nothing', async (_name, url, why) => {
    const server = await ok();
    // Where each of these would land if only the address check were missing
    const hostname = new URL(url).hostname.replace(/^\[|\]$/g, '');
    const { policy } = testNet({ routes: { [`${hostname}:443`]: { port: server.port, direct: true } } });

    const error = await refusal(policy.fetch(url, { maxBytes: 100 }));

    expect(error.kind).toBe('refused');
    expect(error.message).toContain(why);
    expect(policy.urlProblem(url)).toContain(why);
    expect(server.connections).toBe(0);
  });

  it.each([
    ['a private literal', 'https://10.0.0.8/', 'private'],
    ['a link-local literal', 'https://169.254.10.1/', 'link-local'],
    ['the metadata address', 'https://169.254.169.254/latest/meta-data/', 'cloud metadata'],
    ['a carrier-grade NAT literal', 'https://100.64.1.1/', 'carrier-grade NAT'],
    ['a multicast literal', 'https://224.0.0.251/', 'multicast'],
    ['the broadcast address', 'https://255.255.255.255/', 'broadcast'],
    ['a unique local IPv6 literal', 'https://[fd00::1]/', 'unique local'],
    ['a link-local IPv6 literal', 'https://[fe80::1]/', 'link-local'],
  ])('refuses %s', async (_name, url, why) => {
    const server = await ok();
    const hostname = new URL(url).hostname.replace(/^\[|\]$/g, '');
    const { policy } = testNet({ routes: { [`${hostname}:443`]: { port: server.port, direct: true } } });

    expect((await refusal(policy.fetch(url, { maxBytes: 100 }))).message).toContain(why);
    expect(server.connections).toBe(0);
  });

  it('refuses a name that resolves to loopback although a server is listening there: the lookup hook is the gate', async () => {
    const server = await ok();
    // Port only: the connection would go wherever the lookup hook's answer points
    const { policy, resolved } = testNet({ hosts: { 'rebind.test': '127.0.0.1', 'six.test': '::1' }, routes: { 'rebind.test:443': server.port, 'six.test:443': server.port } });

    const error = await refusal(policy.fetch('https://rebind.test/', { maxBytes: 100 }));
    expect(error.kind).toBe('refused');
    expect(error.message).toBe('rebind.test resolves to 127.0.0.1, which is a loopback address');
    expect((await refusal(policy.fetch('https://six.test/', { maxBytes: 100 }))).message).toContain('::1, which is a loopback address');
    expect(resolved).toEqual(['rebind.test', 'six.test']);
    expect(server.connections).toBe(0);
  });

  it.each([
    ['public first', [PUBLIC_ADDRESS, '10.0.0.5'], '10.0.0.5, which is a private address'],
    ['private first', ['192.168.1.9', PUBLIC_ADDRESS], '192.168.1.9, which is a private address'],
    ['an IPv6 loopback among public ones', [PUBLIC_ADDRESS, '2606:4700:4700::1111', '::1'], '::1, which is a loopback address'],
    ['an IPv4-mapped private address', ['2606:4700:4700::1111', '::ffff:10.1.2.3'], 'IPv4-mapped form of a private address'],
  ])('refuses a name whose DNS answer mixes public and other addresses (%s)', async (_name, addresses, why) => {
    const server = await ok();
    const { policy } = testNet({ hosts: { 'mixed.test': addresses }, routes: { 'mixed.test:443': { port: server.port, direct: true } } });

    const error = await refusal(policy.fetch('https://mixed.test/', { maxBytes: 100 }));

    expect(error.kind).toBe('refused');
    expect(error.message).toContain(why);
    expect(server.connections).toBe(0);
  });

  it('asks the resolver again for every request and never reuses a connection', async () => {
    const server = await ok();
    const hosts: Record<string, string> = { 'cdn.test': PUBLIC_ADDRESS };
    const { policy, resolved } = testNet({ hosts, routes: { 'cdn.test:443': { port: server.port, direct: true } } });

    await policy.fetch('https://cdn.test/', { maxBytes: 100 });
    await policy.fetch('https://cdn.test/', { maxBytes: 100 });
    expect(server.connections).toBe(2);
    expect(server.hits.map((hit) => hit.headers.connection)).toEqual(['close', 'close']);

    // The name now points inward (DNS rebinding): refused, whatever was fetched before
    hosts['cdn.test'] = '10.0.0.5';
    expect((await refusal(policy.fetch('https://cdn.test/', { maxBytes: 100 }))).kind).toBe('refused');
    expect(resolved).toEqual(['cdn.test', 'cdn.test', 'cdn.test']);
    expect(server.connections).toBe(2);
  });

  it('a connection another policy opened to a host is not reused to get around the check', async () => {
    const server = await ok();
    const world = testNet({ hosts: { 'secure.test': '127.0.0.1' }, worldOrigin: `https://secure.test:${server.port}` });
    await world.policy.fetch(`https://secure.test:${server.port}/`, { maxBytes: 100 });

    // Same host name, same real port, but no exception here
    const other = testNet({ hosts: { 'secure.test': '127.0.0.1' }, routes: { 'secure.test:443': server.port } });
    expect((await refusal(other.policy.fetch('https://secure.test/', { maxBytes: 100 }))).message).toContain('loopback');
    expect(server.hits).toHaveLength(1);
  });

  it('refuses plain http, other schemes and non-default ports outside the world origin', async () => {
    const plain = await startServer((_request, response) => response.end('ok'));
    const secure = await ok();
    const { policy } = testNet({
      hosts: { 'cdn.test': PUBLIC_ADDRESS },
      routes: { 'cdn.test:80': { port: plain.port, direct: true }, 'cdn.test:8443': { port: secure.port, direct: true }, 'cdn.test:443': { port: secure.port, direct: true } },
    });

    expect((await refusal(policy.fetch('http://cdn.test/a.glb', { maxBytes: 100 }))).message).toContain('http:// is only allowed on the world');
    expect((await refusal(policy.fetch('https://cdn.test:8443/a.glb', { maxBytes: 100 }))).message).toContain('port 8443 is not allowed');
    for (const url of ['file:///etc/hosts', 'ftp://cdn.test/a.glb', 'data:text/plain,hi', 'blob:nothing', 'javascript:alert(1)']) {
      expect((await refusal(policy.fetch(url, { maxBytes: 100 }))).message).toContain('URLs are not fetched');
    }
    for (const url of ['', 'cdn.test/a.glb', '//cdn.test/a.glb', 'https://']) {
      expect((await refusal(policy.fetch(url, { maxBytes: 100 }))).message).toBe('not a valid absolute URL');
    }
    expect(plain.connections + secure.connections).toBe(0);
    // The explicit default port is the default port
    await expect(policy.fetch('https://cdn.test:443/a.glb', { maxBytes: 100 })).resolves.toMatchObject({ status: 200 });
  });

  it('refuses a URL that carries a user name or password', async () => {
    const server = await ok();
    const { policy } = testNet({ hosts: { 'cdn.test': PUBLIC_ADDRESS }, routes: { 'cdn.test:443': { port: server.port, direct: true } } });

    for (const url of ['https://user:secret@cdn.test/a.glb', 'https://user@cdn.test/a.glb', 'https://:secret@cdn.test/a.glb']) {
      const error = await refusal(policy.fetch(url, { maxBytes: 100 }));
      expect(error.kind).toBe('refused');
      expect(error.message).toBe('URLs that carry a user name or password are not fetched');
      expect(error.message).not.toContain('secret');
    }
    expect(server.connections).toBe(0);
  });

  it('reports a name that does not resolve as a network failure, not a refusal', async () => {
    const { policy } = testNet();
    const error = await refusal(policy.fetch('https://nowhere.test/', { maxBytes: 100 }));
    expect(error.kind).toBe('network');
    expect(error.message).toBe('could not resolve nowhere.test (ENOTFOUND)');
  });

  it('safeFetch (no world) refuses loopback, by the system resolver, with nothing injected', async () => {
    const error = await refusal(safeFetch('https://localhost/', { maxBytes: 100, timeoutMs: 5000 }));
    expect(error.kind).toBe('refused');
    expect(error.message).toMatch(/^localhost resolves to (127\.0\.0\.1|::1), which is a loopback address$/);
  });
});

describe('the world-origin exception', () => {
  it('lets a loopback world be fetched over http on its own port, by address', async () => {
    const world = await startServer((_request, response) => response.end('asset'));
    const policy = new NetPolicy({ worldOrigin: `http://127.0.0.1:${world.port}` });

    const answer = await policy.fetch(`http://127.0.0.1:${world.port}/assets/a.glb`, { maxBytes: 100 });

    expect(text(answer.body)).toBe('asset');
    expect(world.hits[0].headers.host).toBe(`127.0.0.1:${world.port}`);
    expect(policy.isWorldOrigin(`http://127.0.0.1:${world.port}/x`)).toBe(true);
  });

  it('lets a world named by a host that resolves to a private address be fetched, through the lookup hook', async () => {
    const world = await startServer((_request, response) => response.end('asset'));
    const { policy, resolved } = testNet({ hosts: { 'world.test': '127.0.0.1' }, worldOrigin: `http://world.test:${world.port}` });

    const answer = await policy.fetch(`http://world.test:${world.port}/assets/a.glb`, { maxBytes: 100 });

    expect(text(answer.body)).toBe('asset');
    // world.test exists nowhere but in the injected resolver: the connection went where the hook said
    expect(resolved).toEqual(['world.test']);
    expect(world.hits[0].headers.host).toBe(`world.test:${world.port}`);
  });

  it('is for that exact origin and nothing else', async () => {
    const world = await startServer((_request, response) => response.end('asset'));
    const other = await startServer((_request, response) => response.end('internal'));
    const secure = await ok();
    const { policy } = testNet({
      hosts: { 'world.test': '127.0.0.1', localhost: '127.0.0.1', 'sub.world.test': '127.0.0.1' },
      worldOrigin: `http://world.test:${world.port}`,
      routes: { 'world.test:443': secure.port, 'sub.world.test:443': secure.port },
    });
    const fetch = (url: string) => policy.fetch(url, { maxBytes: 100 });

    await expect(fetch(`http://world.test:${world.port}/a`)).resolves.toMatchObject({ status: 200 });
    // Another port, the address instead of the name, another name for the same machine, a sub-domain
    expect((await refusal(fetch(`http://world.test:${other.port}/a`))).kind).toBe('refused');
    expect((await refusal(fetch(`http://127.0.0.1:${world.port}/a`))).kind).toBe('refused');
    expect((await refusal(fetch(`http://localhost:${world.port}/a`))).kind).toBe('refused');
    expect((await refusal(fetch(`http://sub.world.test:${world.port}/a`))).kind).toBe('refused');
    // The same host over the other scheme is another origin: judged as any public host, and it is loopback
    expect((await refusal(fetch('https://world.test/a'))).message).toContain('loopback');
    expect((await refusal(fetch('https://sub.world.test/a'))).message).toContain('loopback');
    expect((await refusal(fetch(`http://user:pw@world.test:${world.port}/a`))).message).toContain('user name or password');
    expect(world.hits).toHaveLength(1);
    expect(other.connections + secure.connections).toBe(0);
  });

  it('can be switched off for one request', async () => {
    const world = await startServer((_request, response) => response.end('asset'));
    const policy = new NetPolicy({ worldOrigin: `http://127.0.0.1:${world.port}` });

    const error = await refusal(policy.fetch(`http://127.0.0.1:${world.port}/a`, { maxBytes: 100, worldException: false }));

    expect(error.kind).toBe('refused');
    expect(policy.urlProblem(`http://127.0.0.1:${world.port}/a`)).toBeNull();
    expect(policy.urlProblem(`http://127.0.0.1:${world.port}/a`, { worldException: false })).toContain('http:// is only allowed');
    expect(world.connections).toBe(0);
  });

  it('a loopback world owns its scheme and port on every loopback spelling, in both directions', async () => {
    const world = await startServer((_request, response) => response.end('asset'));
    const port = world.port;
    const hosts = { localhost: '127.0.0.1' };
    // WS_URL on 127.0.0.1, assets announced on localhost; and the other way round
    const byAddress = testNet({ hosts, worldOrigin: `http://127.0.0.1:${port}`, tls: false }).policy;
    const byName = testNet({ hosts, worldOrigin: `http://localhost:${port}`, tls: false }).policy;

    await expect(byAddress.fetch(`http://localhost:${port}/a`, { maxBytes: 100 })).resolves.toMatchObject({ status: 200 });
    await expect(byName.fetch(`http://127.0.0.1:${port}/b`, { maxBytes: 100 })).resolves.toMatchObject({ status: 200 });
    expect(world.hits.map((hit) => hit.headers.host)).toEqual([`localhost:${port}`, `127.0.0.1:${port}`]);
    for (const policy of [byAddress, byName]) {
      for (const spelling of ['localhost', '127.0.0.1', '127.1.2.3', '[::1]', '[0:0:0:0:0:0:0:1]']) expect(policy.isWorldOrigin(`http://${spelling}:${port}/x`)).toBe(true);
      // Nothing wider: another port, another scheme, another name for the machine, IPv4-mapped loopback
      expect(policy.urlProblem(`http://localhost:${port + 1}/x`)).toContain('http:// is only allowed');
      expect(policy.isWorldOrigin(`https://localhost:${port}/x`)).toBe(false);
      expect(policy.isWorldOrigin(`http://me.localhost:${port}/x`)).toBe(false);
      expect(policy.isWorldOrigin(`http://[::ffff:127.0.0.1]:${port}/x`)).toBe(false);
      expect(policy.isWorldOrigin(`http://192.168.1.5:${port}/x`)).toBe(false);
    }
  });

  it('a world that is not on loopback gets no other spelling, even one that resolves to it', async () => {
    const world = await startServer((_request, response) => response.end('asset'));
    const { policy } = testNet({ hosts: { 'world.lan': '192.168.1.5', localhost: '127.0.0.1' }, worldOrigin: `http://192.168.1.5:${world.port}`, tls: false });

    expect(policy.isWorldOrigin(`http://192.168.1.5:${world.port}/x`)).toBe(true);
    expect(policy.isWorldOrigin(`http://world.lan:${world.port}/x`)).toBe(false);
    expect((await refusal(policy.fetch(`http://localhost:${world.port}/a`, { maxBytes: 100 }))).kind).toBe('refused');
    expect((await refusal(policy.fetch(`http://127.0.0.1:${world.port}/a`, { maxBytes: 100 }))).kind).toBe('refused');
    expect(world.connections).toBe(0);
  });

  it('a policy with no world has no exception, and an origin that is not http(s) gives none', async () => {
    const server = await startServer((_request, response) => response.end('x'));
    for (const policy of [new NetPolicy(), new NetPolicy({ worldOrigin: 'ftp://127.0.0.1' }), new NetPolicy({ worldOrigin: 'not a url' })]) {
      expect(policy.worldOrigin).toBeNull();
      expect((await refusal(policy.fetch(`http://127.0.0.1:${server.port}/`, { maxBytes: 100 }))).kind).toBe('refused');
    }
    expect(server.connections).toBe(0);
  });
});

describe('redirects', () => {
  it('follows a redirect between public hosts and reports the final URL', async () => {
    const second = await startServer((_request, response) => response.end('final'), { tls: true });
    const first = await startServer((_request, response) => response.writeHead(302, { location: 'https://assets.test/b.glb' }).end('moved'), { tls: true });
    const { policy } = testNet({
      hosts: { 'cdn.test': PUBLIC_ADDRESS, 'assets.test': '1.1.1.1' },
      routes: { 'cdn.test:443': { port: first.port, direct: true }, 'assets.test:443': { port: second.port, direct: true } },
    });

    const answer = await policy.fetch('https://cdn.test/a.glb', { maxBytes: 100 });

    expect(answer.url).toBe('https://assets.test/b.glb');
    expect(text(answer.body)).toBe('final');
  });

  it.each([
    ['a name that resolves to a private address', 'https://internal.test/secret', 'internal.test resolves to 10.0.0.5, which is a private address'],
    ['a loopback literal', 'https://127.0.0.1/secret', '127.0.0.1 is a loopback address'],
    ['the metadata address', 'https://169.254.169.254/latest/meta-data/', 'cloud metadata'],
    ['plain http', 'http://assets.test/secret', 'http:// is only allowed'],
    ['another port', 'https://assets.test:8443/secret', 'port 8443 is not allowed'],
    ['a URL with credentials', 'https://user:pw@assets.test/secret', 'user name or password'],
    ['a file URL', 'file:///etc/hosts', 'URLs are not fetched'],
  ])('refuses a redirect to %s, and the target sees nothing', async (_name, location, why) => {
    const target = await ok();
    const plain = await startServer((_request, response) => response.end('ok'));
    const first = await startServer((_request, response) => response.writeHead(302, { location }).end(), { tls: true });
    const { policy } = testNet({
      hosts: { 'cdn.test': PUBLIC_ADDRESS, 'internal.test': '10.0.0.5', 'assets.test': '1.1.1.1' },
      routes: {
        'cdn.test:443': { port: first.port, direct: true },
        'internal.test:443': { port: target.port, direct: true },
        '127.0.0.1:443': { port: target.port, direct: true },
        '169.254.169.254:443': { port: target.port, direct: true },
        'assets.test:8443': { port: target.port, direct: true },
        'assets.test:443': { port: target.port, direct: true },
        'assets.test:80': { port: plain.port, direct: true },
      },
    });

    const error = await refusal(policy.fetch('https://cdn.test/a.glb', { maxBytes: 100 }));

    expect(error.kind).toBe('refused');
    expect(error.message).toContain(why);
    expect(first.hits).toHaveLength(1);
    expect(target.connections + plain.connections).toBe(0);
  });

  it(`follows ${MAX_REDIRECTS} redirects and refuses one more`, async () => {
    const server = await startServer((request, response) => {
      const left = Number(new URL(request.url ?? '/', 'https://cdn.test').searchParams.get('left'));
      if (left > 0) response.writeHead(307, { location: `/hop?left=${left - 1}` }).end();
      else response.end('arrived');
    }, { tls: true });
    const { policy } = testNet({ hosts: { 'cdn.test': PUBLIC_ADDRESS }, routes: { 'cdn.test:443': { port: server.port, direct: true } } });

    await expect(policy.fetch(`https://cdn.test/hop?left=${MAX_REDIRECTS}`, { maxBytes: 100 })).resolves.toMatchObject({ url: 'https://cdn.test/hop?left=0' });
    const hitsSoFar = server.hits.length;
    const error = await refusal(policy.fetch(`https://cdn.test/hop?left=${MAX_REDIRECTS + 1}`, { maxBytes: 100 }));
    expect(error.message).toBe(`more than ${MAX_REDIRECTS} redirects`);
    // The first request and MAX_REDIRECTS redirects were made; the next one was not
    expect(server.hits.length - hitsSoFar).toBe(MAX_REDIRECTS + 1);
  });

  it('the world loses its exception on a redirect that leaves its origin', async () => {
    const internal = await startServer((_request, response) => response.end('internal'));
    const world = await startServer((request, response) => {
      if (request.url === '/stay') response.writeHead(302, { location: '/assets/a.glb' }).end();
      else if (request.url === '/leave') response.writeHead(302, { location: `http://127.0.0.1:${internal.port}/admin` }).end();
      else if (request.url === '/leave-by-name') response.writeHead(302, { location: `http://localhost:${internal.port}/admin` }).end();
      else response.end('asset');
    });
    const { policy } = testNet({ hosts: { localhost: '127.0.0.1' }, worldOrigin: `http://127.0.0.1:${world.port}` });

    await expect(policy.fetch(`http://127.0.0.1:${world.port}/stay`, { maxBytes: 100 })).resolves.toMatchObject({ url: `http://127.0.0.1:${world.port}/assets/a.glb` });
    for (const path of ['/leave', '/leave-by-name']) {
      const error = await refusal(policy.fetch(`http://127.0.0.1:${world.port}${path}`, { maxBytes: 100 }));
      expect(error.kind).toBe('refused');
      expect(error.message).toContain('http:// is only allowed');
    }
    expect(internal.connections).toBe(0);
  });

  it('turns a POST into a GET on 301/302/303, keeps it on 307/308, and drops Authorization when the origin changes', async () => {
    const second = await startServer((_request, response) => response.end('ok'), { tls: true });
    const first = await startServer((request, response) => {
      const status = Number(request.url?.slice(1, 4));
      const location = request.url?.endsWith('away') ? 'https://assets.test/landed' : '/landed';
      if (request.url?.includes('landed')) response.end('ok');
      else response.writeHead(status, { location }).end();
    }, { tls: true });
    const { policy } = testNet({
      hosts: { 'cdn.test': PUBLIC_ADDRESS, 'assets.test': '1.1.1.1' },
      routes: { 'cdn.test:443': { port: first.port, direct: true }, 'assets.test:443': { port: second.port, direct: true } },
    });
    const post = (path: string) => policy.fetch(`https://cdn.test${path}`, { maxBytes: 100, method: 'post', body: 'payload', headers: { Authorization: 'Bearer caller', 'Content-Type': 'text/plain' } });
    const landed = (server: typeof first) => server.hits.filter((hit) => hit.url === '/landed').at(-1)!;

    for (const status of [301, 302, 303]) {
      await post(`/${status}`);
      expect([landed(first).method, landed(first).body, landed(first).headers['content-type']]).toEqual(['GET', '', undefined]);
      expect(landed(first).headers.authorization).toBe('Bearer caller');
    }
    for (const status of [307, 308]) {
      await post(`/${status}`);
      expect([landed(first).method, landed(first).body, landed(first).headers['content-type']]).toEqual(['POST', 'payload', 'text/plain']);
    }
    await post('/307-away');
    expect([landed(second).method, landed(second).body]).toEqual(['POST', 'payload']);
    expect(landed(second).headers.authorization).toBeUndefined();
  });

  it('keeps a HEAD a HEAD (and a GET a GET) on every redirect, 303 included, and turns a PUT into a GET on 303', async () => {
    const server = await startServer((request, response) => {
      if (request.url?.includes('landed')) return void response.writeHead(200, { 'content-length': '5' }).end(request.method === 'HEAD' ? undefined : 'asset');
      response.writeHead(Number(request.url?.slice(1, 4)), { location: '/landed' }).end();
    }, { tls: true });
    const { policy } = testNet({ hosts: { 'cdn.test': PUBLIC_ADDRESS }, routes: { 'cdn.test:443': { port: server.port, direct: true } } });
    const landed = () => server.hits.filter((hit) => hit.url === '/landed').at(-1)!;

    for (const status of [301, 302, 303, 307, 308]) {
      const answer = await policy.fetch(`https://cdn.test/${status}`, { maxBytes: 0, method: 'HEAD' });
      expect([status, answer.status, answer.body.byteLength, landed().method]).toEqual([status, 200, 0, 'HEAD']);
      await policy.fetch(`https://cdn.test/${status}`, { maxBytes: 100 });
      expect([status, landed().method]).toEqual([status, 'GET']);
    }
    await policy.fetch('https://cdn.test/303', { maxBytes: 100, method: 'PUT', body: 'x' });
    expect([landed().method, landed().body]).toEqual(['GET', '']);
  });
});

describe('the voice server URL the world sends (voiceUrlProblem)', () => {
  const world = (origin: string) => testNet({ hosts: { 'lk.example': PUBLIC_ADDRESS, 'lk.internal': '10.0.0.7', 'lk.mixed': [PUBLIC_ADDRESS, '127.0.0.1'], 'world.test': '10.0.0.2' }, worldOrigin: origin });

  it("allows the world's own host on any scheme and port, loopback spellings included", async () => {
    const { policy, resolved } = world('http://world.test:3000');
    expect(await policy.voiceUrlProblem('ws://world.test:7880')).toBeNull();
    expect(await policy.voiceUrlProblem('wss://world.test/rtc')).toBeNull();
    const loopback = world('http://127.0.0.1:3000').policy;
    expect(await loopback.voiceUrlProblem('ws://localhost:7880')).toBeNull();
    expect(await loopback.voiceUrlProblem('ws://[::1]:7880')).toBeNull();
    // The world's host is trusted as its downloads are: not even resolved
    expect(resolved).toEqual([]);
  });

  it('allows wss: on the default port of a host whose every address is public', async () => {
    const { policy, resolved } = world('http://world.test:3000');
    expect(await policy.voiceUrlProblem('wss://lk.example')).toBeNull();
    expect(await policy.voiceUrlProblem(`wss://${PUBLIC_ADDRESS}/`)).toBeNull();
    expect(resolved).toEqual(['lk.example']);
  });

  it.each([
    ['plain ws: elsewhere', 'ws://lk.example', 'ws:// is only allowed'],
    ['another port', 'wss://lk.example:7880', 'port 7880 is not allowed'],
    ['a private host', 'wss://lk.internal', 'lk.internal resolves to 10.0.0.7, which is a private address'],
    ['a host with one loopback address among public ones', 'wss://lk.mixed', '127.0.0.1, which is a loopback address'],
    ['a loopback literal while the world is elsewhere', 'wss://127.0.0.1', '127.0.0.1 is a loopback address'],
    ['the metadata address', 'wss://169.254.169.254', 'cloud metadata'],
    ['a name nobody resolves', 'wss://nowhere.example', 'could not resolve nowhere.example'],
    ['credentials, even on the world', 'ws://user:pw@world.test:7880', 'user name or password'],
    ['another scheme', 'https://lk.example', 'https:// is not a voice server URL'],
    ['not a URL', 'lk.example', 'not a valid absolute URL'],
  ])('refuses %s', async (_name, url, why) => {
    expect(await world('http://world.test:3000').policy.voiceUrlProblem(url)).toContain(why);
  });

  it('refuses anything but a string, and a world with no origin gets no host exception', async () => {
    expect(await world('http://world.test:3000').policy.voiceUrlProblem(undefined)).toContain('not a string');
    expect(await new NetPolicy().voiceUrlProblem('ws://localhost:7880')).toContain('ws:// is only allowed');
  });
});

describe('bounds', () => {
  it('refuses a body that declares more than the cap without reading it', async () => {
    const server = await startServer((_request, response) => response.writeHead(200, { 'content-length': '1000' }).end(Buffer.alloc(1000)), { tls: true });
    const { policy } = testNet({ hosts: { 'cdn.test': PUBLIC_ADDRESS }, routes: { 'cdn.test:443': { port: server.port, direct: true } } });

    const error = await refusal(policy.fetch('https://cdn.test/big', { maxBytes: 999 }));

    expect(error.kind).toBe('too-large');
    expect(error.message).toBe('the response is larger than 999 bytes');
    await expect(policy.fetch('https://cdn.test/big', { maxBytes: 1000 })).resolves.toMatchObject({ status: 200 });
  });

  it('stops an endless body at the cap and closes the connection', async () => {
    let sent = 0;
    const server = await startServer((_request, response) => {
      response.writeHead(200);
      const timer = setInterval(() => {
        sent += 16384;
        response.write(Buffer.alloc(16384, 1));
      }, 1);
      response.on('close', () => clearInterval(timer));
    }, { tls: true });
    const { policy } = testNet({ hosts: { 'cdn.test': PUBLIC_ADDRESS }, routes: { 'cdn.test:443': { port: server.port, direct: true } } });

    const error = await refusal(policy.fetch('https://cdn.test/endless', { maxBytes: 100_000, timeoutMs: 20_000 }));

    expect(error.kind).toBe('too-large');
    await expect.poll(() => server.cutShort).toBe(1);
    // It stopped near the cap, not at the deadline
    const sentWhenClosed = sent;
    expect(sentWhenClosed).toBeLessThan(5_000_000);
  });

  it('gives up on a body that stalls when the deadline passes, and closes the connection', async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200, { 'content-length': '1000' });
      response.write('only the beginning');
    }, { tls: true });
    const { policy } = testNet({ hosts: { 'cdn.test': PUBLIC_ADDRESS }, routes: { 'cdn.test:443': { port: server.port, direct: true } } });

    const started = Date.now();
    const error = await refusal(policy.fetch('https://cdn.test/stalled', { maxBytes: 10_000, timeoutMs: 400 }));

    expect(error.kind).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(3000);
    await expect.poll(() => server.cutShort).toBe(1);
  });

  it('applies the one deadline across redirects and to a server that never answers', async () => {
    const server = await startServer((request, response) => {
      // Each hop answers after 150 ms: no single hop is slow, the chain is
      if (request.url === '/silent') return;
      setTimeout(() => response.writeHead(307, { location: '/slow' }).end(), 150);
    }, { tls: true });
    const { policy } = testNet({ hosts: { 'cdn.test': PUBLIC_ADDRESS }, routes: { 'cdn.test:443': { port: server.port, direct: true } } });

    expect((await refusal(policy.fetch('https://cdn.test/slow', { maxBytes: 100, timeoutMs: 400 }))).kind).toBe('timeout');
    expect((await refusal(policy.fetch('https://cdn.test/silent', { maxBytes: 100, timeoutMs: 300 }))).kind).toBe('timeout');
  });

  it("stops when the caller's signal fires, before or during the request", async () => {
    const server = await startServer(() => {}, { tls: true });
    const { policy } = testNet({ hosts: { 'cdn.test': PUBLIC_ADDRESS }, routes: { 'cdn.test:443': { port: server.port, direct: true } } });

    const before = await refusal(policy.fetch('https://cdn.test/', { maxBytes: 100, signal: AbortSignal.abort() }));
    expect(before.kind).toBe('aborted');
    expect(server.connections).toBe(0);

    const controller = new AbortController();
    const pending = refusal(policy.fetch('https://cdn.test/', { maxBytes: 100, signal: controller.signal }));
    await expect.poll(() => server.hits.length).toBe(1);
    controller.abort();
    expect((await pending).kind).toBe('aborted');
    await expect.poll(() => server.cutShort).toBe(1);
  });

  it('reports a connection that closes mid-body, and a compressed body nobody asked for, as failures', async () => {
    const server = await startServer((request, response) => {
      if (request.url === '/gzip') return void response.writeHead(200, { 'content-encoding': 'gzip' }).end('not really');
      response.writeHead(200, { 'content-length': '1000' });
      response.write('partial');
      setTimeout(() => response.destroy(), 20);
    }, { tls: true });
    const { policy } = testNet({ hosts: { 'cdn.test': PUBLIC_ADDRESS }, routes: { 'cdn.test:443': { port: server.port, direct: true } } });

    expect((await refusal(policy.fetch('https://cdn.test/cut', { maxBytes: 10_000 }))).kind).toBe('network');
    const gzip = await refusal(policy.fetch('https://cdn.test/gzip', { maxBytes: 10_000 }));
    expect([gzip.kind, gzip.message]).toEqual(['network', 'the server sent a gzip-encoded body although none was asked for']);
  });

  it('rejects options that would mean no bound', async () => {
    for (const maxBytes of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5]) {
      await expect(safeFetch('https://cdn.test/', { maxBytes })).rejects.toBeInstanceOf(TypeError);
    }
    for (const timeoutMs of [Number.NaN, 0, -5, Number.POSITIVE_INFINITY]) {
      await expect(safeFetch('https://cdn.test/', { maxBytes: 1, timeoutMs })).rejects.toBeInstanceOf(TypeError);
    }
  });
});

describe('requests', () => {
  it("never lets a caller set Host, lengths or connection headers, and a header value cannot start a new line", async () => {
    const server = await ok();
    const { policy } = testNet({ hosts: { 'cdn.test': PUBLIC_ADDRESS }, routes: { 'cdn.test:443': { port: server.port, direct: true } } });

    await policy.fetch('https://cdn.test/', {
      maxBytes: 100,
      method: 'POST',
      body: 'four',
      headers: { Host: 'internal.test', 'Content-Length': '999', 'Transfer-Encoding': 'chunked', Connection: 'keep-alive', 'Accept-Encoding': 'gzip', 'X-Ok': 'yes', 'X-Split': 'a\r\nX-Injected: 1', 'bad name': 'x' },
    });

    const [{ headers, body }] = server.hits;
    expect(headers).toMatchObject({ host: 'cdn.test', 'content-length': '4', connection: 'close', 'accept-encoding': 'identity', 'x-ok': 'yes' });
    expect(body).toBe('four');
    expect(headers['transfer-encoding']).toBeUndefined();
    expect(headers['x-split']).toBeUndefined();
    expect(headers['x-injected']).toBeUndefined();
    expect(Object.keys(headers)).not.toContain('bad name');
    expect(headers.cookie).toBeUndefined();
    expect(headers.authorization).toBeUndefined();
  });

  it('HEAD returns the status and no body, even with a cap of zero', async () => {
    const server = await startServer((_request, response) => response.writeHead(200, { 'content-length': '5000' }).end(), { tls: true });
    const { policy } = testNet({ hosts: { 'cdn.test': PUBLIC_ADDRESS }, routes: { 'cdn.test:443': { port: server.port, direct: true } } });

    const answer = await policy.fetch('https://cdn.test/a.glb', { maxBytes: 0, method: 'HEAD' });

    expect([answer.status, answer.body.byteLength, server.hits[0].method]).toEqual([200, 0, 'HEAD']);
  });

  it('returns a redirect as it is when asked not to follow, and asks the target nothing', async () => {
    const target = await ok();
    const server = await startServer((_request, response) => response.writeHead(307, { location: 'https://assets.test/landed' }).end('moved'), { tls: true });
    const { policy } = testNet({
      hosts: { 'cdn.test': PUBLIC_ADDRESS, 'assets.test': '1.1.1.1' },
      routes: { 'cdn.test:443': { port: server.port, direct: true }, 'assets.test:443': { port: target.port, direct: true } },
    });

    const answer = await policy.fetch('https://cdn.test/a', { maxBytes: 100, followRedirects: false });

    expect([answer.status, answer.headers.location, text(answer.body), answer.url]).toEqual([307, 'https://assets.test/landed', 'moved', 'https://cdn.test/a']);
    expect(target.connections).toBe(0);
    // By default the same request is followed
    await expect(policy.fetch('https://cdn.test/a', { maxBytes: 100 })).resolves.toMatchObject({ status: 200, url: 'https://assets.test/landed' });
  });

  it('toResponse gives code written against fetch() a Response', async () => {
    const response = toResponse({ url: 'https://cdn.test/', status: 404, statusText: 'Not Found', headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode('{"error":"nope"}') });
    expect([response.status, response.ok, response.headers.get('content-type')]).toEqual([404, false, 'application/json']);
    await expect(response.json()).resolves.toEqual({ error: 'nope' });
    expect(toResponse({ url: 'https://cdn.test/', status: 204, statusText: '', headers: {}, body: new Uint8Array() }).status).toBe(204);
  });
});

describe('TLS with a pinned address', () => {
  it('checks the certificate against the host name in the URL, not the address it dialled', async () => {
    const server = await ok();
    const hosts = { 'secure.test': '127.0.0.1', 'other.test': '127.0.0.1' };

    // The certificate names secure.test and no IP address: this passes only if the name was checked
    const trusted = testNet({ hosts, worldOrigin: `https://secure.test:${server.port}` });
    await expect(trusted.policy.fetch(`https://secure.test:${server.port}/`, { maxBytes: 100 })).resolves.toMatchObject({ status: 200 });
    expect(server.serverNames).toEqual(['secure.test']);

    // Same server, same address, a name the certificate does not cover
    const wrongName = testNet({ hosts, worldOrigin: `https://other.test:${server.port}` });
    const mismatch = await refusal(wrongName.policy.fetch(`https://other.test:${server.port}/`, { maxBytes: 100 }));
    expect([mismatch.kind, mismatch.message]).toEqual(['network', 'the request failed (ERR_TLS_CERT_ALTNAME_INVALID)']);

    // By address: the certificate does not cover 127.0.0.1 either
    const byAddress = testNet({ worldOrigin: `https://127.0.0.1:${server.port}` });
    expect((await refusal(byAddress.policy.fetch(`https://127.0.0.1:${server.port}/`, { maxBytes: 100 }))).message).toContain('ERR_TLS_CERT_ALTNAME_INVALID');

    // And an authority the runtime does not know is not trusted
    const untrusted = testNet({ hosts, worldOrigin: `https://secure.test:${server.port}`, tls: false });
    expect((await refusal(untrusted.policy.fetch(`https://secure.test:${server.port}/`, { maxBytes: 100 }))).kind).toBe('network');
    expect(server.hits).toHaveLength(1);
  });
});
