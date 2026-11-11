/**
 * Entry of the sandbox child process (bundled and spawned by lib/script-sandbox.child.test.ts,
 * under Bun and Node). It builds a real engine world with the agent's own systems, loads one app
 * through the agent's loader, and reports what happened as JSON (argv: scenario file, report file).
 * It runs in a process of its own
 * because `sandboxed` locks the whole realm down, which a test runner's worker must never be.
 *
 * Not initialised, as in service.integration.test.ts: no socket, no physics, no tick loop.
 *
 * The world's assets are served by a server in this process on loopback, which is the world's own
 * origin for the agent's real network policy (lib/net-policy.ts). A second loopback server stands
 * for something inside the agent's network: scripts name it where the fixtures say
 * http://127.0.0.1:9, and whatever reaches it is recorded as outbound. So is every call of the
 * global fetch, which nothing here should make (the engine's own script fetch does).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { inspect } from 'node:util';
import { createNodeClientWorld } from '../../hyperfy/src/core/createNodeClientWorld.js';
import { createNode } from '../../hyperfy/src/core/extras/createNode.js';
import * as engineThree from '../../hyperfy/src/core/extras/three.js';
import { AgentActions } from '../../systems/actions';
import { AgentControls } from '../../systems/controls';
import { AgentLoader } from '../../systems/loader';
import { installWorldChat } from '../../lib/world-chat';
import { activateWorldScripts, createWorldScripts } from '../../lib/script-api';
import { surviveUnhandledRejections } from '../../lib/script-sandbox';
import { destroyWorld } from '../../lib/world-teardown';
import { AgentLiveKit } from '../../systems/liveKit';
import type { ScriptNetwork } from '../../lib/script-facades';
import { NetPolicy, installWorldNet } from '../../lib/net-policy';
import { createScriptNetwork } from '../../lib/script-network';
import { PUBLIC_ADDRESS, type TestServer, startServer, testNet } from '../net';
import type { Scenario } from './scenario';
import { extendThreePhysX } from '../../hyperfy/src/core/extras/extendThreePhysX.js';
import { clamp, num, uuid } from '../../hyperfy/src/core/utils.js';
import { prng } from '../../hyperfy/src/core/extras/prng.js';
import { pathToFileURL } from 'node:url';

const endowed: Function[] = [num, clamp, uuid, prng];
const THREE = engineThree as any;

function glb(gltf: object, bin?: Uint8Array): Uint8Array {
  const json = JSON.stringify(gltf);
  const text = new TextEncoder().encode(json.padEnd(Math.ceil(json.length / 4) * 4, ' '));
  const binLength = bin ? 8 + bin.length : 0;
  const bytes = new Uint8Array(12 + 8 + text.length + binLength);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, bytes.length, true);
  view.setUint32(12, text.length, true);
  view.setUint32(16, 0x4e4f534a, true);
  bytes.set(text, 20);
  if (bin) {
    view.setUint32(20 + text.length, bin.length, true);
    view.setUint32(24 + text.length, 0x004e4942, true);
    bytes.set(bin, 28 + text.length);
  }
  return bytes;
}

const minimalGlb = () => glb({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: 'Root' }] });

/** One mesh, 'Triangle', with a real geometry: what the engine's own geometries look like */
function triangleGlb(): Uint8Array {
  const positions = new Uint8Array(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer);
  return glb(
    {
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ name: 'Triangle', mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      buffers: [{ byteLength: positions.length }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positions.length }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
    },
    positions
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const scenario: Scenario = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  const logs: string[] = [];
  const outbound: string[] = [];
  const report: Record<string, unknown> = { runtime: (globalThis as any).Bun ? 'bun' : 'node', logs, outbound };

  // The runtime's own console, which formats objects with the host's util.inspect
  const realConsole = { warn: console.warn.bind(console), error: console.error.bind(console) };
  // Everything the agent or a script logs, as the strings the host console was given
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    console[level] = (...args: unknown[]) => void logs.push(`${level}: ${args.map((arg) => (typeof arg === 'string' ? arg : inspect(arg, { depth: 1 }))).join(' ')}`);
  }

  const model = minimalGlb();
  const triangle = triangleGlb();
  // Something inside the agent's network. Nothing may reach it: not a script's fetch, not the loader.
  const inward = (name: string, tls: boolean): Promise<TestServer> =>
    startServer((_request, response, hit) => {
      outbound.push(`${name}:${hit.method} ${hit.url}`);
      response.end('internal');
    }, { tls });
  const internal = await inward('internal', false);
  let script = scenario.script.replaceAll('http://127.0.0.1:9/', `http://127.0.0.1:${internal.port}/`);
  // The world: its assets, on its own origin
  const assets = await startServer((request, response) => {
    if (['/app.glb', '/crash-block.glb', '/app.vrm', '/npc.vrm'].includes(request.url ?? '')) response.end(Buffer.from(model));
    else if (request.url === '/mesh.glb') response.end(Buffer.from(triangle));
    else if (request.url === '/app.js') response.end(script);
    else response.writeHead(404).end();
  });
  const ASSETS = `http://127.0.0.1:${assets.port}`;
  script = script.replaceAll('%WORLD%', ASSETS);

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    // The PhysX loader reads its .wasm file this way
    if (url.startsWith('file:')) return realFetch(input as string);
    outbound.push(url);
    throw new TypeError(`unexpected request in the sandbox child: ${url}`);
  }) as typeof fetch;

  // scenario.policyNetwork: a public API scripts may call, and the real policy to call it through
  let scriptNetwork: ScriptNetwork | null = null;
  let api: TestServer | undefined;
  if (scenario.policyNetwork) {
    const internalTls = await inward('internal-tls', true);
    api = await startServer((request, response) => {
      if (request.url === '/redirect-inward') response.writeHead(302, { location: 'https://internal.test/secret' }).end();
      else response.writeHead(200, { 'content-type': 'application/json' }).end('{"pong":true}');
    }, { tls: true });
    const { policy } = testNet({
      hosts: { 'api.test': PUBLIC_ADDRESS, 'internal.test': '10.0.0.5', localhost: '127.0.0.1' },
      // localhost: only the port is re-targeted, so that request is judged in the policy's lookup hook, in this locked-down realm
      routes: { 'api.test:443': { port: api.port, direct: true }, 'internal.test:443': { port: internalTls.port, direct: true }, '127.0.0.1:443': { port: internalTls.port, direct: true }, 'localhost:443': internalTls.port },
      // The world's origin is known to this policy, and a script's fetch still gets no exception for it
      worldOrigin: ASSETS,
    });
    scriptNetwork = createScriptNetwork({ policy });
  }

  // scenario.errorListeners: what elizaOS's Sentry integration does with an unhandled rejection
  // (console.error of the reason, or of its stack), plus util.inspect, from listeners registered
  // before the sandbox is activated (as the elizaOS server's are) and after it (as a later plugin's)
  const errorListenerCalls: unknown[] = [];
  report.errorListenerCalls = errorListenerCalls;
  const sentryLike = (when: string) => (reason: any, promise: unknown) => {
    errorListenerCalls.push({
      when,
      isError: reason instanceof Error,
      ownSymbols: reason !== null && typeof reason === 'object' ? Object.getOwnPropertySymbols(reason).length : -1,
      message: typeof reason?.message === 'string' ? reason.message.slice(0, 200) : String(typeof reason),
      promiseIsPromise: promise instanceof Promise,
    });
    realConsole.warn('This error originated either by throwing inside of an async function without a catch block, or by rejecting a promise which was not handled with .catch().');
    realConsole.error(reason && typeof reason === 'object' && 'stack' in reason ? reason.stack : reason);
    inspect(reason);
    inspect(promise);
  };
  const listen = (when: string) => {
    process.on('unhandledRejection', sentryLike(when));
    process.on('uncaughtExceptionMonitor', (error: unknown) => void errorListenerCalls.push({ when, uncaught: true, isError: error instanceof Error }));
  };
  if (scenario.errorListeners === 'before' || scenario.errorListeners === 'both') listen('before');

  if (scenario.mode !== 'off') {
    const activationLog = { info: (m: string) => void logs.push(`info: ${m}`), error: (m: string) => void logs.push(`error: ${m}`) };
    // Two callers at once (two agents starting together) share one activation
    const results = await Promise.all(Array.from({ length: scenario.concurrentActivations ?? 1 }, () => activateWorldScripts(activationLog)));
    report.activations = results;
    report.activated = results.every(Boolean);
    if (!report.activated) return report;
    // As HyperfyService.prepareWorldScripts does
    surviveUnhandledRejections({ error: (m: string) => void logs.push(`error: ${m}`) });
  }
  if (scenario.errorListeners === 'after' || scenario.errorListeners === 'both') listen('after');

  if (scenario.physxModule) {
    // As the engine's Physics system does on init, which in the agent is after lockdown:
    // Vector3.prototype.toPxVec3 and friends
    const { loadPhysX } = await import(pathToFileURL(scenario.physxModule).href);
    await loadPhysX();
    extendThreePhysX();
    report.physx = typeof THREE.Vector3.prototype.toPxVec3;
  }

  // What the hostile fixture tries to change, captured before anything runs
  const before = {
    objectProto: Reflect.ownKeys(Object.prototype).length,
    arrayPush: Array.prototype.push,
    functionCall: Function.prototype.call,
    blobProto: Reflect.ownKeys(Blob.prototype).length,
    timerProto: Reflect.ownKeys(Object.getPrototypeOf(setTimeout(() => {}, 0))).length,
    vector3Proto: Reflect.ownKeys(THREE.Vector3.prototype).length,
    vector3Copy: THREE.Vector3.prototype.copy,
    quaternionProto: Reflect.ownKeys(THREE.Quaternion.prototype).length,
    matrix4Proto: Reflect.ownKeys(THREE.Matrix4.prototype).length,
    eulerProto: Reflect.ownKeys(THREE.Euler.prototype).length,
    inspectDefaults: JSON.stringify(inspect.defaultOptions),
    env: Object.keys(process.env).length,
  };

  // The engine's world.open() calls window.open from a timer, which without this ends the process
  // (the agent has no global window; its own script API makes open() do nothing)
  if (scenario.mode === 'engine-compartment') (globalThis as any).window = { open: (url: unknown) => void outbound.push(`window.open:${url}`) };

  const world: any = createNodeClientWorld();
  const sent: [string, unknown][] = [];
  const handlerCalls: string[] = [];
  world.network.id = 'coo';
  world.network.ws = {
    url: 'ws://world.test/ws?authToken=SECRET-SESSION-TOKEN',
    readyState: 1,
    send() { handlerCalls.push('ws.send'); },
    addEventListener() {},
    removeEventListener() {},
    close() { report.socketClosed = true; },
  };
  world.network.send = (name: string, data: unknown) => void sent.push([name, data]);
  world.assetsUrl = ASSETS;
  // As session/create-agent-world.ts does for a world the agent connects to
  installWorldNet(world, new NetPolicy({ worldOrigin: ASSETS }));
  if (!scenario.engineChat) installWorldChat(world);
  // The handlers chat provenance, ranks and the tip wallet are fed from: a script must never call them
  for (const handler of ['onChatAdded', 'onEntityModified', 'onEntityAdded', 'onSnapshot', 'onEvmNonce', 'onSettingsModified', 'upload']) {
    const original = world.network[handler];
    world.network[handler] = (...args: unknown[]) => {
      handlerCalls.push(handler);
      return original?.apply(world.network, args);
    };
  }
  // The agent's own LiveKit system where teardown is tested (nodes/Video.js calls it on unmount)
  world.livekit = scenario.worldDestroy ? new AgentLiveKit(world) : { marker: 'livekit' };
  world.controls = new AgentControls(world);
  world.actions = new AgentActions(world);
  const scripts = scenario.mode === 'sandboxed'
    ? createWorldScripts({
        network: scenario.networkBody === undefined
          ? scriptNetwork
          : ((async (url) => {
              outbound.push(`script-network:${url}`);
              return { status: 200, statusText: 'OK', headers: { 'Content-Type': 'image/png' }, body: new TextEncoder().encode(scenario.networkBody) };
            }) satisfies ScriptNetwork),
      })
    : null;
  world.loader = new AgentLoader(world, {
    scripts: scenario.mode === 'engine-compartment' ? { evaluate: (code: string) => world.scripts.evaluate(code) } : scripts,
  });

  // Stand-ins for player entities (the real ones need physics); the proxies scripts get are the engine's
  const playerCalls: unknown[] = [];
  const player = (id: string, x: number) => {
    const base = createNode('group');
    base.position.set(x, 2, 3);
    const entity: any = {
      isPlayer: true,
      world,
      data: { id, owner: id, name: `Player ${id}`, userId: `user-${id}`, roles: [], health: 100, effect: null },
      base,
      modify(data: unknown) { playerCalls.push(['modify', id, data]); },
      setEffect(effect: unknown) { playerCalls.push(['setEffect', id, effect]); },
      push(force: unknown) { playerCalls.push(['push', id, force]); },
      // The engine's own Chat.add shows a bubble over the sender
      chat(body: unknown) { playerCalls.push(['chat', id, body]); },
      destroy() {},
    };
    world.entities.players.set(id, entity);
    world.entities.items.set(id, entity);
    return entity;
  };
  world.entities.player = player('coo', 1);
  player('visitor', 5);

  world.blueprints.add({
    id: 'bp',
    version: 0,
    model: scenario.model === 'vrm' ? 'asset://app.vrm' : 'asset://app.glb',
    script: 'asset://app.js',
    props: { greeting: 'hello', nested: { list: [1, 2, 3] }, ...scenario.props },
  });
  let crashes = 0;
  const app = world.entities.add({ id: 'app', type: 'app', blueprint: 'bp', position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1], mover: null, uploader: null, pinned: false, state: {} });
  const crash = app.crash.bind(app);
  app.crash = () => {
    crashes++;
    return crash();
  };
  const built = async () => {
    for (let i = 0; i < 400 && app.building; i++) await sleep(10);
  };
  await built();

  // A few frames, as World.tick does for hot entities
  const frame = () => {
    for (const item of world.hot) item.fixedUpdate?.(1 / 50);
    for (const item of world.hot) item.update?.(1 / 60);
    for (const item of world.hot) item.lateUpdate?.(1 / 60);
  };
  for (let i = 0; i < 3; i++) frame();
  await sleep(60);
  frame();

  if (scenario.useItem) {
    report.useItem = world.actions.performAction('app');
    // The fixture apps' action takes one second of holding E (duration: 1, in seconds)
    await sleep(1100);
    frame();
    report.releaseItem = world.actions.releaseAction();
    await sleep(600);
  }
  await sleep(100);
  const reported = () => sent.some(([name, data]) => name === 'entityEvent' && (data as unknown[])[2] === scenario.waitForEvent);
  for (let i = 0; scenario.waitForEvent && i < 1000 && !reported(); i++) await sleep(10);
  await built();

  report.building = app.building;
  report.crashes = crashes;
  report.rootName = app.root?.name;
  report.rootChildren = app.root?.children.map((child: any) => child.id);
  report.actionNodes = world.actions.nodes.length;
  report.sent = sent;
  report.handlerCalls = handlerCalls;
  report.playerCalls = playerCalls;
  report.chat = world.chat.msgs;
  report.appState = app.data.state;
  report.playerPosition = world.entities.player.base.position.toArray();

  if (scenario.worldDestroy) {
    // As a session's end tears its world down: every system, then the socket and the tick timer
    const reached: string[] = [];
    for (const system of world.systems) {
      const original = system.destroy?.bind(system);
      system.destroy = () => {
        reached.push(system.constructor?.name);
        return original?.();
      };
    }
    world.client.timerId = setTimeout(() => void (report.tickedAfterDestroy = true), 100);
    report.teardownFailures = destroyWorld(world, { warn: (m: string) => void logs.push(`warn: ${m}`) });
    report.systemsDestroyed = reached;
    report.systemsTotal = world.systems.map((system: any) => system.constructor?.name);
    const sentAtDestroy = sent.length;
    await sleep(200);
    report.sentAfterWorldDestroy = sent.slice(sentAtDestroy);
  } else {
    const sentAtDestroy = sent.length;
    app.destroy();
    if (scenario.watchAfterDestroy) {
      await sleep(200);
      report.sentAfterAppDestroy = sent.slice(sentAtDestroy);
    }
  }
  await sleep(20);
  report.sentAfterDestroy = sent.slice();

  report.host = {
    objectProto: Reflect.ownKeys(Object.prototype).length === before.objectProto,
    arrayPush: Array.prototype.push === before.arrayPush,
    functionCall: Function.prototype.call === before.functionCall,
    blobProto: Reflect.ownKeys(Blob.prototype).length === before.blobProto,
    timerProto: Reflect.ownKeys(Object.getPrototypeOf(setTimeout(() => {}, 0))).length === before.timerProto,
    vector3Proto: Reflect.ownKeys(THREE.Vector3.prototype).length === before.vector3Proto && THREE.Vector3.prototype.copy === before.vector3Copy,
    quaternionProto: Reflect.ownKeys(THREE.Quaternion.prototype).length === before.quaternionProto,
    matrix4Proto: Reflect.ownKeys(THREE.Matrix4.prototype).length === before.matrix4Proto,
    eulerProto: Reflect.ownKeys(THREE.Euler.prototype).length === before.eulerProto,
    inspectDefaults: JSON.stringify(inspect.defaultOptions) === before.inspectDefaults,
    env: Object.keys(process.env).length === before.env,
    noMarker: !('__pwned' in globalThis) && !('__pwned' in Object.prototype) && !('__pwned' in world) && !('__pwned' in world.network),
    // The engine's helper functions endowed to scripts: nothing was written to them
    endowedUntouched: endowed.every((fn) => Object.getOwnPropertyNames(fn).every((name) => ['length', 'name', 'prototype', 'arguments', 'caller'].includes(name))),
  };
  // Frozen by the sandbox (script-api.ts), so only when scripts are sandboxed
  report.endowedFrozen = endowed.every((fn) => Object.isFrozen(fn));
  // What the public API was sent (scenario.policyNetwork)
  report.api = api?.hits.map((hit) => ({ method: hit.method, url: hit.url, body: hit.body, headers: hit.headers }));
  // What the world's own server was asked for (by the loader, and by nobody else)
  report.assetRequests = assets.hits.map((hit) => hit.url);
  globalThis.fetch = realFetch;
  return report;
}

// The report goes to a file: a large one written to a pipe is cut off when the process exits
const finish = (report: unknown, status: number) => {
  writeFileSync(process.argv[3], JSON.stringify(report, (_key, value) => (typeof value === 'bigint' ? String(value) : value)));
  process.exit(status);
};

main().then(
  (report) => finish(report, 0),
  (error) => finish({ fatal: String(error?.stack ?? error) }, 1)
);
