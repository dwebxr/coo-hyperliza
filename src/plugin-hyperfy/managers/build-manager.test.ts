import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BuildManager, type EditGuard, importByteCap } from './build-manager';
import { SceneEditStopped } from '../lib/authorization';
import { uploadAsset } from '../lib/asset-upload';
import { MAX_MODEL_BYTES, NetPolicy, installWorldNet } from '../lib/net-policy';
import { PUBLIC_ADDRESS, type TestServer, closeServers, startServer, testNet } from '../test-support/net';
import { adaptToWorldProtocol } from '../lib/world-protocol';

/*
 * The real BuildManager, with uploads going through the real upload helper (lib/asset-upload.ts,
 * wired the way session/create-agent-world.ts installs it as world.network.upload) against a fake world API whose
 * answers the test releases one by one. The guard's authorization and connection can be
 * withdrawn at any point; nothing may reach the world after that, whichever await it happened
 * during, except taking back what the edit itself added.
 *
 * Imports are downloaded through the real network policy (lib/net-policy.ts): cdn.test is a public
 * host that a server on loopback stands in for (test-support/net.ts).
 */

afterEach(async () => {
  vi.restoreAllMocks();
  await closeServers();
});

interface ApiRequest {
  method: string;
  url: string;
  answer: (response: Response) => void;
}

function setup() {
  const auth = { allowed: true, live: true };
  const guard: EditGuard = {
    world: null,
    check() {
      if (!auth.live) throw new SceneEditStopped('the connection to the world changed');
      if (!auth.allowed) throw new SceneEditStopped('the requester is not a builder in this world');
    },
  };
  const app = { onUploaded: vi.fn(), destroy: vi.fn() };
  const entity = {
    isApp: true,
    data: { id: 'box', pinned: false, blueprint: 'bp' },
    blueprint: { unique: false },
    root: { position: new THREE.Vector3(1, 0, 1), quaternion: new THREE.Quaternion(), scale: new THREE.Vector3(1, 1, 1) },
    destroy: vi.fn(),
  };
  // The world's upload API: every request waits until the test answers it
  const requests: ApiRequest[] = [];
  const fetchImpl = ((url: string, init?: RequestInit) =>
    new Promise<Response>((answer) => requests.push({ method: init?.method ?? 'GET', url: String(url), answer }))) as typeof fetch;
  const network: any = { id: 'coo', apiUrl: 'https://world.test/api', maxUploadSize: 10, send: vi.fn() };
  network.upload = vi.fn((file: File, { check }: { check?: () => void } = {}) => uploadAsset(network, file, { net: new NetPolicy({ worldOrigin: 'https://world.test' }), authToken: 'session', fetchImpl, check }));
  const world: any = {
    assetsUrl: 'https://world.test/assets',
    controls: { goto: vi.fn().mockResolvedValue('arrived') },
    network,
    blueprints: { add: vi.fn() },
    entities: { items: new Map<string, unknown>([['box', entity]]), add: vi.fn(() => app) },
  };
  (guard as { world: unknown }).world = world;
  const effects = () => ({
    sent: network.send.mock.calls.length,
    requests: requests.map((r) => `${r.method} ${new URL(r.url).pathname}`),
    blueprints: world.blueprints.add.mock.calls.length,
    added: world.entities.add.mock.calls.length,
    destroyed: entity.destroy.mock.calls.length,
    rolledBack: app.destroy.mock.calls.map((args) => args[0]),
    finished: app.onUploaded.mock.calls.length,
  });
  /** Waits for the n-th request to the world API and answers it. */
  const answer = async (n: number, status: number, body: unknown) => {
    await vi.waitFor(() => expect(requests.length).toBeGreaterThan(n));
    requests[n].answer(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
  };
  return { auth, guard, world, entity, app, requests, effects, answer, manager: new BuildManager() };
}

const none = { sent: 0, requests: [], blueprints: 0, added: 0, destroyed: 0, rolledBack: [], finished: 0 };

const glb = new Uint8Array([1, 2, 3, 4]);
// A .hyp: 4-byte header length, the JSON header, then the asset bytes
function hyp() {
  const header = new TextEncoder().encode(JSON.stringify({ blueprint: { name: 'Thing' }, assets: [{ type: 'model', url: 'asset://thing.glb', size: 4, mime: 'model/gltf-binary' }] }));
  const out = new Uint8Array(4 + header.length + 4);
  new DataView(out.buffer).setUint32(0, header.length, true);
  out.set(header, 4);
  out.set([9, 9, 9, 9], 4 + header.length);
  return out;
}
/** Serves `file` as https://cdn.test/… for `world`. `internal` is where a request the policy must refuse would land. */
async function download(world: object, file: Uint8Array, { status = 200, onFetch = () => {}, headers = {} }: { status?: number; onFetch?: () => void; headers?: Record<string, string> } = {}) {
  const cdn = await startServer((_request, response) => {
    onFetch();
    response.writeHead(status, { 'content-type': 'application/octet-stream', ...headers }).end(Buffer.from(file));
  }, { tls: true });
  const internal = await startServer((_request, response) => response.end('internal'), { tls: true });
  const { policy } = testNet({
    hosts: { 'cdn.test': PUBLIC_ADDRESS, 'internal.test': '10.0.0.5' },
    routes: {
      'cdn.test:443': { port: cdn.port, direct: true },
      'internal.test:443': { port: internal.port, direct: true },
      '127.0.0.1:443': { port: internal.port, direct: true },
      '169.254.169.254:443': { port: internal.port, direct: true },
    },
    worldOrigin: 'https://world.test',
  });
  installWorldNet(world, policy);
  return { cdn, internal };
}
const requestsTo = (server: TestServer) => server.hits.length;

describe('BuildManager stops when the authorization is withdrawn', () => {
  it.each([
    ['translate', (m: BuildManager, g: EditGuard) => m.translate(g, 'box', [0, 2, 0])],
    ['rotate', (m: BuildManager, g: EditGuard) => m.rotate(g, 'box', [0, 0, 0, 1])],
    ['scale', (m: BuildManager, g: EditGuard) => m.scale(g, 'box', [2, 2, 2])],
    ['duplicate', (m: BuildManager, g: EditGuard) => m.duplicate(g, 'box')],
    ['delete', (m: BuildManager, g: EditGuard) => m.delete(g, 'box')],
  ])('%s: changes nothing when it was withdrawn while walking over', async (_name, run) => {
    const { auth, guard, world, entity, effects, manager } = setup();
    world.controls.goto.mockImplementation(async () => {
      auth.allowed = false;
    });
    await expect(run(manager, guard)).rejects.toBeInstanceOf(SceneEditStopped);
    expect(effects()).toEqual(none);
    expect(entity.root.position.toArray()).toEqual([1, 0, 1]);
    expect(entity.root.scale.toArray()).toEqual([1, 1, 1]);
  });

  it('does not even walk for an edit that is no longer allowed', async () => {
    const { auth, guard, world, manager } = setup();
    auth.allowed = false;
    await expect(manager.translate(guard, 'box', [0, 2, 0])).rejects.toBeInstanceOf(SceneEditStopped);
    expect(world.controls.goto).not.toHaveBeenCalled();
  });
});

describe('BuildManager reports what each operation did', () => {
  it('applied: the change was made and sent', async () => {
    const { guard, world, entity, manager } = setup();
    await expect(manager.translate(guard, 'box', [0, 2, 0])).resolves.toEqual({ outcome: 'applied' });
    expect(entity.root.position.toArray()).toEqual([0, 2, 0]);
    expect(world.network.send).toHaveBeenCalledWith('entityModified', expect.objectContaining({ id: 'box' }));
    // A duplicate says which entity it made: the id it announced to the world
    const copy = await manager.duplicate(guard, 'box');
    const [added] = world.entities.add.mock.calls[0];
    expect(copy).toEqual({ outcome: 'applied', newId: added.id });
    expect(added.id).toMatch(/^[A-Za-z0-9_-]{6,}$/);
    expect(added.id).not.toBe('box');
    await expect(manager.delete(guard, 'box')).resolves.toEqual({ outcome: 'applied' });
  });

  it.each([
    ['translate', (m: BuildManager, g: EditGuard) => m.translate(g, 'gone', [0, 2, 0])],
    ['rotate', (m: BuildManager, g: EditGuard) => m.rotate(g, 'gone', [0, 0, 0, 1])],
    ['scale', (m: BuildManager, g: EditGuard) => m.scale(g, 'gone', [2, 2, 2])],
    ['duplicate', (m: BuildManager, g: EditGuard) => m.duplicate(g, 'gone')],
    ['delete', (m: BuildManager, g: EditGuard) => m.delete(g, 'gone')],
  ])('%s of a target that vanished is skipped, not a change', async (_name, run) => {
    const { guard, effects, manager } = setup();
    await expect(run(manager, guard)).resolves.toEqual({ outcome: 'skipped', reason: 'target not found' });
    expect(effects()).toEqual(none);
  });

  it('skips what the world would not change (pinned, not an app) and fails invalid parameters', async () => {
    const { guard, entity, effects, manager } = setup();
    entity.data.pinned = true;
    await expect(manager.delete(guard, 'box')).resolves.toEqual({ outcome: 'skipped', reason: 'the app is pinned' });
    entity.isApp = false;
    await expect(manager.delete(guard, 'box')).resolves.toEqual({ outcome: 'skipped', reason: 'only apps can be deleted' });
    await expect(manager.duplicate(guard, 'box')).resolves.toEqual({ outcome: 'skipped', reason: 'only apps can be duplicated' });
    entity.isApp = true;
    await expect(manager.translate(guard, 'box', ['up'] as never)).resolves.toEqual({ outcome: 'failed', reason: 'invalid position (three finite numbers within ±1e6)' });
    await expect(manager.scale(guard, 'box', undefined as never)).resolves.toEqual({ outcome: 'failed', reason: 'invalid scale (three finite numbers, none of them zero)' });
    expect(effects()).toEqual(none);
  });

  /*
   * What the world's own builder lets a builder do by hand (coo-world ClientBuilder.js): move,
   * rotate, scale and delete apps that are neither pinned nor the scene; duplicate any app but the
   * scene. The agent keeps to that for every operation, before it walks over and again after.
   */
  const everyOperation: [string, (m: BuildManager, g: EditGuard) => Promise<unknown>][] = [
    ['translate', (m, g) => m.translate(g, 'box', [0, 2, 0])],
    ['rotate', (m, g) => m.rotate(g, 'box', [0, 0, 0, 1])],
    ['scale', (m, g) => m.scale(g, 'box', [2, 2, 2])],
    ['duplicate', (m, g) => m.duplicate(g, 'box')],
    ['delete', (m, g) => m.delete(g, 'box')],
  ];

  it.each(everyOperation)('%s leaves a pinned app as it is (a duplicate, which the builder allows, is made)', async (name, run) => {
    const { guard, world, entity, effects, manager } = setup();
    entity.data.pinned = true;
    if (name === 'duplicate') {
      await expect(run(manager, guard)).resolves.toMatchObject({ outcome: 'applied' });
      // The copy is not pinned
      expect(world.entities.add.mock.calls[0][0]).toMatchObject({ pinned: false });
      return;
    }
    await expect(run(manager, guard)).resolves.toEqual({ outcome: 'skipped', reason: 'the app is pinned' });
    expect(effects()).toEqual(none);
    // Decided before walking over
    expect(world.controls.goto).not.toHaveBeenCalled();
    expect(entity.root.position.toArray()).toEqual([1, 0, 1]);
    expect(entity.root.scale.toArray()).toEqual([1, 1, 1]);
  });

  it.each(everyOperation)("%s leaves the world's scene app as it is", async (_name, run) => {
    const { guard, world, entity, effects, manager } = setup();
    Object.assign(entity.blueprint, { scene: true });
    await expect(run(manager, guard)).resolves.toEqual({ outcome: 'skipped', reason: "it is the world's scene" });
    expect(effects()).toEqual(none);
    expect(world.controls.goto).not.toHaveBeenCalled();
  });

  it.each(everyOperation.filter(([name]) => name !== 'duplicate'))('%s leaves an app that was pinned while the agent walked over as it is', async (_name, run) => {
    const { guard, world, entity, effects, manager } = setup();
    world.controls.goto.mockImplementation(async () => {
      entity.data.pinned = true;
      return 'arrived';
    });
    await expect(run(manager, guard)).resolves.toEqual({ outcome: 'skipped', reason: 'the app is pinned' });
    expect(effects()).toEqual(none);
    expect(entity.root.position.toArray()).toEqual([1, 0, 1]);
  });

  it('skips a player: the server takes transforms for apps only', async () => {
    const { guard, world, effects, manager } = setup();
    const player = { isApp: false, isPlayer: true, data: { id: 'p1' }, root: { position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), scale: new THREE.Vector3(1, 1, 1) } };
    world.entities.items.set('p1', player);
    for (const run of [() => manager.translate(guard, 'p1', [0, 2, 0]), () => manager.rotate(guard, 'p1', [0, 0, 0, 1]), () => manager.scale(guard, 'p1', [2, 2, 2])]) {
      await expect(run()).resolves.toEqual({ outcome: 'skipped', reason: 'only apps can be moved, rotated or scaled' });
    }
    expect(player.root.position.toArray()).toEqual([0, 0, 0]);
    expect(effects()).toEqual(none);
    expect(world.controls.goto).not.toHaveBeenCalled();
  });

  it.each([
    ['a position beyond ±1e6', (m: BuildManager, g: EditGuard) => m.translate(g, 'box', [1e6 + 1, 0, 0]), 'invalid position'],
    ['a position that is not finite', (m: BuildManager, g: EditGuard) => m.translate(g, 'box', [Number.NaN, 0, 0]), 'invalid position'],
    ['a quaternion far from unit length', (m: BuildManager, g: EditGuard) => m.rotate(g, 'box', [0, 0, 0, 2]), 'invalid quaternion'],
    ['a zero quaternion', (m: BuildManager, g: EditGuard) => m.rotate(g, 'box', [0, 0, 0, 0]), 'invalid quaternion'],
    ['a zero scale', (m: BuildManager, g: EditGuard) => m.scale(g, 'box', [0, 1, 1]), 'invalid scale'],
    ['a scale that vanishes as a 32-bit float', (m: BuildManager, g: EditGuard) => m.scale(g, 'box', [1e-50, 1, 1]), 'invalid scale'],
    ['a scale that overflows as a 32-bit float', (m: BuildManager, g: EditGuard) => m.scale(g, 'box', [1e39, 1, 1]), 'invalid scale'],
  ])('fails %s, which the world would drop, and sends nothing', async (_name, run, reason) => {
    const { guard, world, entity, effects, manager } = setup();
    const result = await run(manager, guard);
    expect(result).toMatchObject({ outcome: 'failed' });
    expect((result as { reason: string }).reason.startsWith(reason)).toBe(true);
    expect(effects()).toEqual(none);
    expect(world.controls.goto).not.toHaveBeenCalled();
    expect([entity.root.position.toArray(), entity.root.scale.toArray()]).toEqual([[1, 0, 1], [1, 1, 1]]);
  });

  it('applies and sends a nearly unit quaternion normalized, as the server stores it, and the largest allowed position', async () => {
    const { guard, world, entity, manager } = setup();
    await expect(manager.rotate(guard, 'box', [0, 0, 0, 1.05])).resolves.toEqual({ outcome: 'applied' });
    expect(entity.root.quaternion.toArray()).toEqual([0, 0, 0, 1]);
    await expect(manager.translate(guard, 'box', [-1e6, 0, 1e6])).resolves.toEqual({ outcome: 'applied' });
    expect(world.network.send).toHaveBeenLastCalledWith('entityModified', expect.objectContaining({ id: 'box', position: [-1e6, 0, 1e6], quaternion: [0, 0, 0, 1] }));
  });

  it.each([
    ['translate', (m: BuildManager, g: EditGuard) => m.translate(g, 'box', [0, 2, 0])],
    ['rotate', (m: BuildManager, g: EditGuard) => m.rotate(g, 'box', [0, 0, 0, 1])],
    ['scale', (m: BuildManager, g: EditGuard) => m.scale(g, 'box', [2, 2, 2])],
    ['duplicate', (m: BuildManager, g: EditGuard) => m.duplicate(g, 'box')],
    ['delete', (m: BuildManager, g: EditGuard) => m.delete(g, 'box')],
  ])('%s of a target removed, destroyed or replaced while the agent walked over is skipped, and nothing is sent', async (_name, run) => {
    for (const removal of ['removed', 'destroyed', 'replaced'] as const) {
      const { world, guard, entity, effects, manager } = setup();
      const replacement = { ...entity, root: { position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), scale: new THREE.Vector3(1, 1, 1) }, destroy: vi.fn() };
      world.controls.goto.mockImplementation(async () => {
        if (removal === 'removed') world.entities.items.delete('box');
        if (removal === 'destroyed') Object.assign(entity, { destroyed: true });
        if (removal === 'replaced') world.entities.items.set('box', replacement);
        return 'arrived';
      });
      await expect(run(manager, guard), removal).resolves.toEqual({ outcome: 'skipped', reason: 'the target was removed while I walked over' });
      expect(effects(), removal).toEqual(none);
      expect(replacement.destroy).not.toHaveBeenCalled();
      expect([entity.root.position.toArray(), entity.root.scale.toArray(), replacement.root.position.toArray()]).toEqual([[1, 0, 1], [1, 1, 1], [0, 0, 0]]);
    }
  });

  it.each([
    ['a zero scale', (e: any) => e.root.scale.set(0, 1, 1), 'invalid scale'],
    ['a scale that vanishes as a 32-bit float', (e: any) => e.root.scale.set(1e-50, 1, 1), 'invalid scale'],
    ['a position beyond ±1e6', (e: any) => e.root.position.set(2e6, 0, 0), 'invalid position'],
    ['a rotation far from unit length', (e: any) => e.root.quaternion.set(0, 0, 0, 2), 'invalid quaternion'],
  ])('fails a duplicate of an app that has %s (the world would refuse the copy), and adds nothing', async (_name, spoil, reason) => {
    const { guard, entity, effects, manager } = setup();
    spoil(entity);
    const result = await manager.duplicate(guard, 'box');
    expect(result).toMatchObject({ outcome: 'failed' });
    expect((result as { reason: string }).reason.startsWith(reason)).toBe(true);
    expect(effects()).toEqual(none);
  });

  it('duplicates with the rotation normalised, as the world stores it', async () => {
    const { guard, world, entity, manager } = setup();
    entity.root.quaternion.set(0, 0, 0, 1.05);
    await expect(manager.duplicate(guard, 'box')).resolves.toMatchObject({ outcome: 'applied' });
    expect(world.entities.add).toHaveBeenCalledWith(expect.objectContaining({ quaternion: [0, 0, 0, 1], position: [1, 0, 1], scale: [1, 1, 1] }), true);
  });

  it('fails a duplicate of a unique app whose blueprint names a file the world would refuse in a new blueprint', async () => {
    for (const [field, value] of [['model', 'file:///etc/hosts'], ['script', 'asset://../x.js'], ['image', { url: 'javascript:alert(1)' }]] as const) {
      const { guard, entity, effects, manager } = setup();
      Object.assign(entity.blueprint, { unique: true, model: 'asset://a.glb', [field]: value });
      await expect(manager.duplicate(guard, 'box'), field).resolves.toEqual({ outcome: 'failed', reason: "the app's blueprint names a file the world would refuse in a copy" });
      expect(effects()).toEqual(none);
    }
    const { guard, entity, effects, manager } = setup();
    Object.assign(entity.blueprint, { unique: true, model: 'asset://a.glb', script: 'https://cdn.example.com/a.js', image: null });
    await expect(manager.duplicate(guard, 'box')).resolves.toMatchObject({ outcome: 'applied' });
    expect(effects()).toMatchObject({ blueprints: 1, added: 1 });
  });

  it.each([
    ['stopped', 'I was stopped on the way there'],
    ['replaced', 'I was sent somewhere else on the way there'],
    ['timed-out', 'I could not get there in time'],
    ['unreachable', 'I could not find a way there'],
  ])('applies no edit whose walk ended as %s: the operation is skipped with that reason', async (outcome, reason) => {
    const operations: [string, (manager: BuildManager, guard: EditGuard) => Promise<unknown>][] = [
      ['translate', (manager, guard) => manager.translate(guard, 'box', [0, 2, 0])],
      ['rotate', (manager, guard) => manager.rotate(guard, 'box', [0, 0, 0, 1])],
      ['scale', (manager, guard) => manager.scale(guard, 'box', [2, 2, 2])],
      ['duplicate', (manager, guard) => manager.duplicate(guard, 'box')],
      ['delete', (manager, guard) => manager.delete(guard, 'box')],
    ];
    for (const [name, run] of operations) {
      const { world, guard, entity, effects, manager } = setup();
      world.controls.goto.mockResolvedValue(outcome);
      await expect(run(manager, guard), name).resolves.toEqual({ outcome: 'skipped', reason });
      expect(effects(), name).toEqual(none);
      expect(entity.root.position.toArray(), name).toEqual([1, 0, 1]);
      expect(entity.root.scale.toArray(), name).toEqual([1, 1, 1]);
    }
  });

  it('a request that may no longer edit stops after its walk, however the walk ended', async () => {
    const { world, guard, auth, effects, manager } = setup();
    world.controls.goto.mockImplementation(async () => {
      auth.allowed = false;
      return 'cancelled';
    });
    await expect(manager.translate(guard, 'box', [0, 2, 0])).rejects.toBeInstanceOf(SceneEditStopped);
    expect(effects()).toEqual(none);
  });

  it('fails an import placed where the world would refuse the app, before downloading anything', async () => {
    const { guard, world, effects, manager } = setup();
    const { cdn } = await download(world, glb);
    await expect(manager.importEntity(guard, 'https://cdn.test/thing.glb', [0, 2e6, 0])).resolves.toMatchObject({ outcome: 'failed', reason: expect.stringMatching(/^invalid position/) });
    await expect(manager.importEntity(guard, 'https://cdn.test/thing.glb', [0, 0, 0], [0, 0, 0, 0])).resolves.toMatchObject({ outcome: 'failed', reason: expect.stringMatching(/^invalid quaternion/) });
    expect(cdn.connections).toBe(0);
    expect(effects()).toEqual(none);
  });

  it('fails an import that was refused or could not be done', async () => {
    const { guard, world, effects, manager } = setup();
    await expect(manager.importEntity(guard, 'file:///etc/hosts')).resolves.toEqual({ outcome: 'failed', reason: 'only http(s):// and asset:// URLs can be imported' });
    await expect(manager.importEntity(guard, 'https://cdn.test/thing.exe')).resolves.toEqual({ outcome: 'failed', reason: 'only .hyp, .glb and .vrm files can be imported' });
    await download(world, glb, { status: 404 });
    await expect(manager.importEntity(guard, 'https://cdn.test/thing.glb')).resolves.toEqual({ outcome: 'failed', reason: 'download failed (HTTP 404)' });
    await download(world, new Uint8Array(2 * 1024 * 1024));
    world.network.maxUploadSize = 1;
    await expect(manager.importEntity(guard, 'https://cdn.test/thing.glb')).resolves.toEqual({ outcome: 'failed', reason: 'the file is too large for the world' });
    expect(effects()).toEqual(none);
  });
});

describe('BuildManager downloads imports under the network policy', () => {
  it.each([
    ["the agent's own API port", 'http://127.0.0.1:3000/api/agents/x.glb'],
    ['a loopback address over https', 'https://127.0.0.1/thing.glb'],
    ['a loopback address spelled as a number', 'https://2130706433/thing.glb'],
    ['a name that resolves to a private address', 'https://internal.test/thing.glb'],
    ['the cloud metadata address', 'https://169.254.169.254/latest/thing.glb'],
    ['a URL with credentials', 'https://user:pw@cdn.test/thing.glb'],
    ['a public host on another port', 'https://cdn.test:8443/thing.glb'],
    ['plain http', 'http://cdn.test/thing.glb'],
  ])('an import of %s makes no request at all and changes nothing', async (_name, url) => {
    const { guard, world, effects, manager } = setup();
    const { cdn, internal } = await download(world, glb);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // The reason given to the requester says nothing about what the name resolves to
    await expect(manager.importEntity(guard, url)).resolves.toEqual({ outcome: 'failed', reason: "the URL is not allowed by the agent's network policy" });

    expect(cdn.connections + internal.connections).toBe(0);
    expect(effects()).toEqual(none);
    expect(world.controls.goto).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('(refused)'));
  });

  it('logs a failed import without the query, credentials or fragment of its URL', async () => {
    const { guard, world, manager } = setup();
    await download(world, glb, { status: 404 });
    const logged = [vi.spyOn(console, 'warn').mockImplementation(() => {}), vi.spyOn(console, 'error').mockImplementation(() => {})];
    await manager.importEntity(guard, 'https://cdn.test/thing.glb?X-Amz-Signature=sig-value#frag-value');
    await manager.importEntity(guard, 'https://user:pw-value@cdn.test/thing.glb?token=token-value');
    const lines = logged.flatMap((spy) => spy.mock.calls.map((call) => call.join(' ')));
    expect(lines.join('\n')).toContain('https://cdn.test/thing.glb?X-Amz-Signature=…');
    expect(lines.join('\n')).not.toMatch(/sig-value|frag-value|pw-value|token-value/);
  });

  it('an import that is redirected inward stops at the redirect', async () => {
    const { guard, world, effects, manager } = setup();
    const { cdn, internal } = await download(world, glb, { status: 302, headers: { location: 'https://internal.test/secret.glb' } });
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(manager.importEntity(guard, 'https://cdn.test/thing.glb')).resolves.toEqual({ outcome: 'failed', reason: "the URL is not allowed by the agent's network policy" });

    expect(requestsTo(cdn)).toBe(1);
    expect(internal.connections).toBe(0);
    expect(effects()).toEqual(none);
  });

  it("the world's upload limit can lower the import cap and never raise it; a missing or unusable one means the operator's cap", () => {
    const MB = 1024 * 1024;
    expect(importByteCap('12')).toBe(12 * MB);
    expect(importByteCap(1)).toBe(MB);
    expect(importByteCap(0.5)).toBe(MB / 2);
    for (const raising of ['100000', 1e9, Number.MAX_VALUE, MAX_MODEL_BYTES]) expect(importByteCap(raising)).toBe(MAX_MODEL_BYTES);
    for (const unusable of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, undefined, null, '', '  ', 'none', {}, [], true]) expect(importByteCap(unusable)).toBe(MAX_MODEL_BYTES);
    // A world that allows nothing gets nothing
    for (const nothing of [0, -1, '0', '-5']) expect(importByteCap(nothing)).toBe(0);
  });

  it.each([
    ['NaN', Number.NaN],
    ['missing', undefined],
    ['not a number', 'unlimited'],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['far above the operator cap', '1000000'],
  ])("stops a download larger than the operator's cap when the world's limit is %s", async (_name, maxUploadSize) => {
    const { guard, world, effects, manager } = setup();
    world.network.maxUploadSize = maxUploadSize;
    // Declares one byte more than the cap; the test does not have to send it
    const { cdn } = await download(world, new Uint8Array(0), { headers: { 'content-length': String(MAX_MODEL_BYTES + 1) } });
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(manager.importEntity(guard, 'https://cdn.test/thing.glb')).resolves.toEqual({ outcome: 'failed', reason: 'the file is too large to import' });

    expect(requestsTo(cdn)).toBe(1);
    expect(effects()).toEqual(none);
  });

  it('stops a download at the cap when the server does not say how much it sends', async () => {
    const { guard, world, effects, manager } = setup();
    world.network.maxUploadSize = '1';
    let sent = 0;
    const cdn = await startServer((_request, response) => {
      response.writeHead(200);
      const timer = setInterval(() => {
        sent += 65536;
        response.write(Buffer.alloc(65536));
      }, 1);
      response.on('close', () => clearInterval(timer));
    }, { tls: true });
    installWorldNet(world, testNet({ hosts: { 'cdn.test': PUBLIC_ADDRESS }, routes: { 'cdn.test:443': { port: cdn.port, direct: true } } }).policy);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(manager.importEntity(guard, 'https://cdn.test/endless.glb')).resolves.toEqual({ outcome: 'failed', reason: 'the file is too large for the world' });

    await expect.poll(() => cdn.cutShort).toBe(1);
    expect(sent).toBeLessThan(20 * 1024 * 1024);
    expect(effects()).toEqual(none);
  });
});

describe('BuildManager imports through the real upload helper', () => {
  it('imports a model when nothing changes (control)', async () => {
    const { guard, world, effects, answer, manager } = setup();
    await download(world, glb);
    const result = manager.importEntity(guard, 'https://cdn.test/thing.glb', [0, 0, 0]);
    await answer(0, 200, { exists: false });
    await answer(1, 200, {});
    await expect(result).resolves.toEqual({ outcome: 'applied' });
    expect(effects()).toMatchObject({ requests: ['GET /api/upload-check', 'POST /api/upload'], blueprints: 1, added: 1, finished: 1 });
  });

  it('downloads nothing for an import that is no longer allowed', async () => {
    const { auth, guard, world, effects, manager } = setup();
    const { cdn } = await download(world, glb);
    auth.allowed = false;
    await expect(manager.importEntity(guard, 'https://cdn.test/thing.glb')).rejects.toBeInstanceOf(SceneEditStopped);
    expect(cdn.connections).toBe(0);
    expect(effects()).toEqual(none);
  });

  it('uploads and adds nothing when it was withdrawn during the download', async () => {
    const { auth, guard, world, effects, manager } = setup();
    await download(world, glb, { onFetch: () => (auth.allowed = false) });
    await expect(manager.importEntity(guard, 'https://cdn.test/thing.glb')).rejects.toBeInstanceOf(SceneEditStopped);
    expect(effects()).toEqual(none);
  });

  it.each([['a model', 'thing.glb', glb], ['an app', 'thing.hyp', hyp()]])('uploads and adds nothing for %s when it was withdrawn while walking to the spot', async (_what, name, bytes) => {
    const { auth, guard, world, effects, manager } = setup();
    await download(world, bytes);
    world.controls.goto.mockImplementation(async () => {
      auth.allowed = false;
    });
    await expect(manager.importEntity(guard, `https://cdn.test/${name}`)).rejects.toBeInstanceOf(SceneEditStopped);
    expect(effects()).toEqual(none);
  });

  it('never posts a model it was withdrawn for while the upload-check was pending', async () => {
    const { auth, guard, world, effects, answer, manager } = setup();
    await download(world, glb);
    const result = manager.importEntity(guard, 'https://cdn.test/thing.glb');
    await vi.waitFor(() => expect(effects().requests).toEqual(['GET /api/upload-check']));
    auth.allowed = false;
    await answer(0, 200, { exists: false });
    await expect(result).rejects.toBeInstanceOf(SceneEditStopped);
    expect(effects()).toEqual({ ...none, requests: ['GET /api/upload-check'] });
  });

  it('adds no model when it was withdrawn while the upload was posted', async () => {
    const { auth, guard, world, effects, answer, manager } = setup();
    await download(world, glb);
    const result = manager.importEntity(guard, 'https://cdn.test/thing.glb');
    await answer(0, 200, { exists: false });
    await vi.waitFor(() => expect(effects().requests).toHaveLength(2));
    auth.allowed = false;
    await answer(1, 200, {});
    await expect(result).rejects.toBeInstanceOf(SceneEditStopped);
    expect(effects()).toEqual({ ...none, requests: ['GET /api/upload-check', 'POST /api/upload'] });
  });

  /*
   * A .hyp import announces nothing (no blueprint, no app) until every one of its files is
   * uploaded: whatever stops or fails it before that leaves the world as it was.
   */
  it("never posts an app's asset it was withdrawn for, and has announced nothing to the world", async () => {
    const { auth, guard, world, effects, answer, manager } = setup();
    await download(world, hyp());
    const result = manager.importEntity(guard, 'https://cdn.test/thing.hyp');
    await vi.waitFor(() => expect(effects().requests).toEqual(['GET /api/upload-check']));
    // Nothing yet, while its file is being uploaded
    expect(effects()).toEqual({ ...none, requests: ['GET /api/upload-check'] });
    auth.allowed = false;
    await answer(0, 200, { exists: false });
    await expect(result).rejects.toBeInstanceOf(SceneEditStopped);
    expect(effects()).toEqual({ ...none, requests: ['GET /api/upload-check'] });
  });

  it.each([
    ['the requester still may build', (_auth: { allowed: boolean; live: boolean }) => {}],
    ['the requester was demoted meanwhile', (auth: { allowed: boolean; live: boolean }) => void (auth.allowed = false)],
    ['the connection changed meanwhile', (auth: { allowed: boolean; live: boolean }) => void (auth.live = false)],
  ])('an app whose upload failed leaves nothing in the world to take back (%s)', async (_what, meanwhile) => {
    const { auth, guard, world, effects, answer, manager } = setup();
    await download(world, hyp());
    const result = manager.importEntity(guard, 'https://cdn.test/thing.hyp');
    await answer(0, 200, { exists: false });
    await vi.waitFor(() => expect(effects().requests).toHaveLength(2));
    meanwhile(auth);
    await answer(1, 500, { error: 'disk full' });
    await expect(result).resolves.toEqual({ outcome: 'failed', reason: 'upload failed: Upload failed (HTTP 500): disk full' });
    // No blueprint, no app, nothing sent: only the two requests of the upload that failed
    expect(effects()).toEqual({ ...none, requests: ['GET /api/upload-check', 'POST /api/upload'] });
  });

  it('adds no app when it was withdrawn while its files were uploaded: nothing was announced, so nothing is taken back', async () => {
    const { auth, guard, world, effects, answer, manager } = setup();
    await download(world, hyp());
    const result = manager.importEntity(guard, 'https://cdn.test/thing.hyp');
    await answer(0, 200, { exists: false });
    await vi.waitFor(() => expect(effects().requests).toHaveLength(2));
    auth.allowed = false;
    await answer(1, 200, {});
    await expect(result).rejects.toBeInstanceOf(SceneEditStopped);
    expect(effects()).toEqual({ ...none, requests: ['GET /api/upload-check', 'POST /api/upload'] });
  });

  it('announces an app only once its files are uploaded: the blueprint, then the app that uses it, then the upload as finished', async () => {
    const { guard, world, app, effects, answer, manager } = setup();
    await download(world, hyp());
    const order: string[] = [];
    world.blueprints.add.mockImplementation(() => void order.push('blueprint'));
    world.entities.add.mockImplementation(() => (order.push('app'), app));
    app.onUploaded.mockImplementation(() => void order.push('uploaded'));
    const result = manager.importEntity(guard, 'https://cdn.test/thing.hyp', [1, 0, 2]);
    await answer(0, 200, { exists: false });
    await vi.waitFor(() => expect(effects().requests).toHaveLength(2));
    expect(order).toEqual([]);
    await answer(1, 200, {});
    await expect(result).resolves.toEqual({ outcome: 'applied' });
    expect(order).toEqual(['blueprint', 'app', 'uploaded']);
    const [blueprint] = world.blueprints.add.mock.calls[0];
    const [data] = world.entities.add.mock.calls[0];
    expect(blueprint).toMatchObject({ name: 'Thing', version: 0 });
    expect(data).toMatchObject({ type: 'app', blueprint: blueprint.id, position: [1, 0, 2], quaternion: [0, 0, 0, 1], uploader: 'coo', pinned: false });
  });
});

describe('BuildManager and packets the world would drop', () => {
  /** setup() with the real protocol adapter on its network, and the engine's add-and-announce */
  function announcing() {
    const ctx = setup();
    const frames: Uint8Array[] = [];
    const network = ctx.world.network;
    Object.assign(network, { queue: [], onClose: () => {}, flush: () => {}, ws: { send: (frame: Uint8Array) => void frames.push(frame) } });
    adaptToWorldProtocol(network, () => null);
    // As the engine's Blueprints.add and Entities.add do for a local change
    ctx.world.blueprints.add = vi.fn((data: unknown, local?: boolean) => void (local && network.send('blueprintAdded', data)));
    ctx.world.entities.add = vi.fn((data: unknown, local?: boolean) => (local && network.send('entityAdded', data), ctx.app));
    return { ...ctx, frames };
  }

  it('fails a duplicate whose blueprint is over what the world takes in one packet, and changes nothing here or there', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { manager, guard, entity, world, frames } = announcing();
    Object.assign(entity.blueprint, { unique: true, name: 'Big', model: 'asset://box.glb', props: { notes: 'x'.repeat(70 * 1024) } });
    const result = await manager.duplicate(guard, 'box');
    expect(result).toEqual({ outcome: 'failed', reason: expect.stringMatching(/^the blueprintAdded packet would be \d+ bytes, more than the 65536 the world accepts$/) });
    expect([world.blueprints.add.mock.calls.length, world.entities.add.mock.calls.length, frames.length]).toEqual([0, 0, 0]);
    // A copy that fits is announced: its blueprint and its entity
    (entity.blueprint as Record<string, unknown>).props = { notes: 'short' };
    await expect(manager.duplicate(guard, 'box')).resolves.toMatchObject({ outcome: 'applied' });
    expect(frames).toHaveLength(2);
  });
  it('fails the import of a .hyp whose blueprint is over what the world takes in one packet, and adds nothing', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { manager, guard, world, frames, answer } = announcing();
    const header = new TextEncoder().encode(JSON.stringify({ blueprint: { name: 'Big', props: { notes: 'x'.repeat(70 * 1024) } }, assets: [{ type: 'model', url: 'asset://thing.glb', size: 4, mime: 'model/gltf-binary' }] }));
    const bytes = new Uint8Array(4 + header.length + 4);
    new DataView(bytes.buffer).setUint32(0, header.length, true);
    bytes.set(header, 4);
    bytes.set([9, 9, 9, 9], 4 + header.length);
    const importing = manager.addApp(guard, new File([bytes], 'big.hyp'), { position: [0, 0, 0], quaternion: [0, 0, 0, 1] });
    await answer(0, 200, { exists: true });
    await expect(importing).resolves.toEqual({ outcome: 'failed', reason: expect.stringContaining('the blueprintAdded packet would be') });
    expect([world.blueprints.add.mock.calls.length, world.entities.add.mock.calls.length, frames.length]).toEqual([0, 0, 0]);
  });
});
