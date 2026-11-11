import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BuildManager, type EditGuard } from './build-manager';
import { SceneEditStopped } from '../lib/authorization';
import { uploadAsset } from '../lib/asset-upload';

/*
 * The real BuildManager, with uploads going through the real upload helper (lib/asset-upload.ts,
 * wired the way service.ts installs it as world.network.upload) against a fake world API whose
 * answers the test releases one by one. The guard's authorization and connection can be
 * withdrawn at any point; nothing may reach the world after that, whichever await it happened
 * during, except taking back what the edit itself added.
 */

afterEach(() => vi.restoreAllMocks());

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
    connectionLive: () => auth.live,
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
  network.upload = vi.fn((file: File, { check }: { check?: () => void } = {}) => uploadAsset(network, file, { authToken: 'session', fetchImpl, check }));
  const world: any = {
    assetsUrl: 'https://world.test/assets',
    controls: { goto: vi.fn().mockResolvedValue(undefined) },
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
  return { auth, guard, world, entity, app, requests, effects, answer, manager: new BuildManager({} as never) };
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
function download(file: Uint8Array, { status = 200, onFetch = () => {} }: { status?: number; onFetch?: () => void } = {}) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    onFetch();
    return new Response(file, { status, headers: { 'content-type': 'application/octet-stream' } });
  });
}

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
    await expect(manager.duplicate(guard, 'box')).resolves.toEqual({ outcome: 'applied' });
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
    await expect(manager.translate(guard, 'box', ['up'] as never)).resolves.toEqual({ outcome: 'failed', reason: 'invalid position' });
    await expect(manager.scale(guard, 'box', undefined as never)).resolves.toEqual({ outcome: 'failed', reason: 'invalid scale' });
    expect(effects()).toEqual(none);
  });

  it('fails an import that was refused or could not be done', async () => {
    const { guard, world, effects, manager } = setup();
    await expect(manager.importEntity(guard, 'file:///etc/hosts')).resolves.toEqual({ outcome: 'failed', reason: 'only http(s):// and asset:// URLs can be imported' });
    await expect(manager.importEntity(guard, 'https://cdn.test/thing.exe')).resolves.toEqual({ outcome: 'failed', reason: 'only .hyp, .glb and .vrm files can be imported' });
    download(glb, { status: 404 });
    await expect(manager.importEntity(guard, 'https://cdn.test/thing.glb')).resolves.toEqual({ outcome: 'failed', reason: 'download failed (HTTP 404)' });
    vi.restoreAllMocks();
    download(new Uint8Array(2 * 1024 * 1024));
    world.network.maxUploadSize = 1;
    await expect(manager.importEntity(guard, 'https://cdn.test/thing.glb')).resolves.toEqual({ outcome: 'failed', reason: 'the file is too large for the world' });
    expect(effects()).toEqual(none);
  });
});

describe('BuildManager imports through the real upload helper', () => {
  it('imports a model when nothing changes (control)', async () => {
    const { guard, effects, answer, manager } = setup();
    download(glb);
    const result = manager.importEntity(guard, 'https://cdn.test/thing.glb', [0, 0, 0]);
    await answer(0, 200, { exists: false });
    await answer(1, 200, {});
    await expect(result).resolves.toEqual({ outcome: 'applied' });
    expect(effects()).toMatchObject({ requests: ['GET /api/upload-check', 'POST /api/upload'], blueprints: 1, added: 1, finished: 1 });
  });

  it('downloads nothing for an import that is no longer allowed', async () => {
    const { auth, guard, effects, manager } = setup();
    const fetch = download(glb);
    auth.allowed = false;
    await expect(manager.importEntity(guard, 'https://cdn.test/thing.glb')).rejects.toBeInstanceOf(SceneEditStopped);
    expect(fetch).not.toHaveBeenCalled();
    expect(effects()).toEqual(none);
  });

  it('uploads and adds nothing when it was withdrawn during the download', async () => {
    const { auth, guard, effects, manager } = setup();
    download(glb, { onFetch: () => (auth.allowed = false) });
    await expect(manager.importEntity(guard, 'https://cdn.test/thing.glb')).rejects.toBeInstanceOf(SceneEditStopped);
    expect(effects()).toEqual(none);
  });

  it.each([['a model', 'thing.glb', glb], ['an app', 'thing.hyp', hyp()]])('uploads and adds nothing for %s when it was withdrawn while walking to the spot', async (_what, name, bytes) => {
    const { auth, guard, world, effects, manager } = setup();
    download(bytes);
    world.controls.goto.mockImplementation(async () => {
      auth.allowed = false;
    });
    await expect(manager.importEntity(guard, `https://cdn.test/${name}`)).rejects.toBeInstanceOf(SceneEditStopped);
    expect(effects()).toEqual(none);
  });

  it('never posts a model it was withdrawn for while the upload-check was pending', async () => {
    const { auth, guard, effects, answer, manager } = setup();
    download(glb);
    const result = manager.importEntity(guard, 'https://cdn.test/thing.glb');
    await vi.waitFor(() => expect(effects().requests).toEqual(['GET /api/upload-check']));
    auth.allowed = false;
    await answer(0, 200, { exists: false });
    await expect(result).rejects.toBeInstanceOf(SceneEditStopped);
    expect(effects()).toEqual({ ...none, requests: ['GET /api/upload-check'] });
  });

  it('adds no model when it was withdrawn while the upload was posted', async () => {
    const { auth, guard, effects, answer, manager } = setup();
    download(glb);
    const result = manager.importEntity(guard, 'https://cdn.test/thing.glb');
    await answer(0, 200, { exists: false });
    await vi.waitFor(() => expect(effects().requests).toHaveLength(2));
    auth.allowed = false;
    await answer(1, 200, {});
    await expect(result).rejects.toBeInstanceOf(SceneEditStopped);
    expect(effects()).toEqual({ ...none, requests: ['GET /api/upload-check', 'POST /api/upload'] });
  });

  it("never posts an app's asset it was withdrawn for, and takes the app back from the world", async () => {
    const { auth, guard, effects, answer, manager } = setup();
    download(hyp());
    const result = manager.importEntity(guard, 'https://cdn.test/thing.hyp');
    await vi.waitFor(() => expect(effects().requests).toEqual(['GET /api/upload-check']));
    auth.allowed = false;
    await answer(0, 200, { exists: false });
    await expect(result).rejects.toBeInstanceOf(SceneEditStopped);
    // destroy(true) broadcasts entityRemoved; the blueprint stays (no packet removes one)
    expect(effects()).toEqual({ ...none, requests: ['GET /api/upload-check'], blueprints: 1, added: 1, rolledBack: [true] });
  });

  it("takes back an app whose upload failed, even though the requester was demoted meanwhile (same connection)", async () => {
    const { auth, guard, effects, answer, manager } = setup();
    download(hyp());
    const result = manager.importEntity(guard, 'https://cdn.test/thing.hyp');
    await answer(0, 200, { exists: false });
    await vi.waitFor(() => expect(effects().requests).toHaveLength(2));
    auth.allowed = false;
    await answer(1, 500, { error: 'disk full' });
    await expect(result).resolves.toEqual({ outcome: 'failed', reason: 'upload failed: Upload failed (HTTP 500): disk full' });
    expect(effects()).toMatchObject({ rolledBack: [true], finished: 0 });
  });

  it('does not touch a new connection when an upload fails after the connection changed', async () => {
    const { auth, guard, effects, answer, manager } = setup();
    download(hyp());
    const result = manager.importEntity(guard, 'https://cdn.test/thing.hyp');
    await answer(0, 200, { exists: false });
    await vi.waitFor(() => expect(effects().requests).toHaveLength(2));
    auth.live = false;
    await answer(1, 500, { error: 'gone' });
    await expect(result).resolves.toMatchObject({ outcome: 'failed' });
    expect(effects()).toMatchObject({ rolledBack: [], finished: 0 });
  });

  it('takes back an app whose uploads finished after it was withdrawn, instead of finishing it', async () => {
    const { auth, guard, effects, answer, manager } = setup();
    download(hyp());
    const result = manager.importEntity(guard, 'https://cdn.test/thing.hyp');
    await answer(0, 200, { exists: false });
    await vi.waitFor(() => expect(effects().requests).toHaveLength(2));
    auth.allowed = false;
    await answer(1, 200, {});
    await expect(result).rejects.toBeInstanceOf(SceneEditStopped);
    expect(effects()).toMatchObject({ rolledBack: [true], finished: 0 });
  });
});
