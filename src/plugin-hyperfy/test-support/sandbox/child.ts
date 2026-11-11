/**
 * Entry of the sandbox child process (bundled and spawned by lib/script-sandbox.child.test.ts,
 * under Bun and Node). It builds a real engine world with the agent's own systems, loads one app
 * through the agent's loader, and reports what happened as JSON (argv: scenario file, report file).
 * It runs in a process of its own
 * because `sandboxed` locks the whole realm down, which a test runner's worker must never be.
 *
 * Not initialised, as in service.integration.test.ts: no socket, no physics, no tick loop. Asset
 * requests are answered by a fake fetch; every other request is recorded as outbound.
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
import type { ScriptNetwork } from '../../lib/script-facades';
import type { Scenario } from './scenario';
import { extendThreePhysX } from '../../hyperfy/src/core/extras/extendThreePhysX.js';
import { clamp, num, uuid } from '../../hyperfy/src/core/utils.js';
import { prng } from '../../hyperfy/src/core/extras/prng.js';
import { pathToFileURL } from 'node:url';

const ASSETS = 'http://assets.test';
const endowed: Function[] = [num, clamp, uuid, prng];
const THREE = engineThree as any;

function minimalGlb(): Uint8Array {
  const json = JSON.stringify({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: 'Root' }] });
  const text = new TextEncoder().encode(json.padEnd(Math.ceil(json.length / 4) * 4, ' '));
  const glb = new Uint8Array(12 + 8 + text.length);
  const view = new DataView(glb.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, glb.length, true);
  view.setUint32(12, text.length, true);
  view.setUint32(16, 0x4e4f534a, true);
  glb.set(text, 20);
  return glb;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const scenario: Scenario = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  const logs: string[] = [];
  const outbound: string[] = [];
  const report: Record<string, unknown> = { runtime: (globalThis as any).Bun ? 'bun' : 'node', logs, outbound };

  // Everything the agent or a script logs, as the strings the host console was given
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    console[level] = (...args: unknown[]) => void logs.push(`${level}: ${args.map((arg) => (typeof arg === 'string' ? arg : inspect(arg, { depth: 1 }))).join(' ')}`);
  }

  const glb = minimalGlb();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    if (url === `${ASSETS}/app.glb` || url === `${ASSETS}/crash-block.glb`) return new Response(glb);
    if (url === `${ASSETS}/app.js`) return new Response(scenario.script);
    // The PhysX loader reads its .wasm file this way
    if (url.startsWith('file:')) return realFetch(input as string);
    outbound.push(url);
    throw new TypeError(`unexpected request in the sandbox child: ${url}`);
  }) as typeof fetch;

  if (scenario.mode !== 'off') {
    report.activated = await activateWorldScripts({ info: (m: string) => void logs.push(`info: ${m}`), error: (m: string) => void logs.push(`error: ${m}`) });
    if (!report.activated) return report;
    // As HyperfyService.prepareWorldScripts does
    surviveUnhandledRejections({ error: (m: string) => void logs.push(`error: ${m}`) });
  }

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
    inspectDefaults: JSON.stringify(inspect.defaultOptions),
    env: Object.keys(process.env).length,
  };

  // The engine's world.open() calls window.open from a timer, which without this ends the process
  if (scenario.mode === 'engine-compartment') (globalThis as any).open = (url: unknown) => void outbound.push(`window.open:${url}`);

  const world: any = createNodeClientWorld();
  const sent: [string, unknown][] = [];
  const handlerCalls: string[] = [];
  world.network.id = 'coo';
  world.network.ws = { url: 'ws://world.test/ws?authToken=SECRET-SESSION-TOKEN', send() { handlerCalls.push('ws.send'); } };
  world.network.send = (name: string, data: unknown) => void sent.push([name, data]);
  world.assetsUrl = ASSETS;
  if (!scenario.engineChat) installWorldChat(world);
  // The handlers chat provenance, ranks and the tip wallet are fed from: a script must never call them
  for (const handler of ['onChatAdded', 'onEntityModified', 'onEntityAdded', 'onSnapshot', 'onEvmNonce', 'onSettingsModified', 'upload']) {
    const original = world.network[handler];
    world.network[handler] = (...args: unknown[]) => {
      handlerCalls.push(handler);
      return original?.apply(world.network, args);
    };
  }
  world.livekit = { marker: 'livekit' };
  world.controls = new AgentControls(world);
  world.actions = new AgentActions(world);
  const scripts = scenario.mode === 'sandboxed'
    ? createWorldScripts({
        network: scenario.networkBody === undefined
          ? null
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
    };
    world.entities.players.set(id, entity);
    world.entities.items.set(id, entity);
    return entity;
  };
  world.entities.player = player('coo', 1);
  player('visitor', 5);

  world.blueprints.add({ id: 'bp', version: 0, model: 'asset://app.glb', script: 'asset://app.js', props: { greeting: 'hello', nested: { list: [1, 2, 3] } } });
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
    await sleep(60);
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

  app.destroy();
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
    inspectDefaults: JSON.stringify(inspect.defaultOptions) === before.inspectDefaults,
    env: Object.keys(process.env).length === before.env,
    noMarker: !('__pwned' in globalThis) && !('__pwned' in Object.prototype) && !('__pwned' in world) && !('__pwned' in world.network),
    // The engine's helper functions endowed to scripts: nothing was written to them
    endowedUntouched: endowed.every((fn) => Object.getOwnPropertyNames(fn).every((name) => ['length', 'name', 'prototype', 'arguments', 'caller'].includes(name))),
  };
  // Frozen by the sandbox (script-api.ts), so only when scripts are sandboxed
  report.endowedFrozen = endowed.every((fn) => Object.isFrozen(fn));
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
