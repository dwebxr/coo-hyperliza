/**
 * What a sandboxed world app script is given, and how the engine's script API is put behind the
 * membrane (lib/script-membrane.ts). The engine itself (hyperfy/, a third-party submodule) is not
 * changed; its entities/App.js still calls `script.exec(worldProxy, appProxy, fetch, props,
 * setTimeout)` with its own proxies, and this module decides what of that a script sees.
 *
 * Why the engine's proxies are not handed to scripts directly (all verified against the bundled
 * engine; a script holding any one of these has the raw world, and with it network.send, the
 * socket URL with the session token, and the handlers chat provenance, ranks and the tip wallet
 * are fed from):
 *   - App.getWorldProxy/getAppProxy look names up with `prop in table`, so `world.constructor`
 *     calls Object(entity) and returns the App entity (entity.world is the World)
 *   - Node.getProxy().add(x), LOD insert(x) and world.add(x) pass any object that is not a node
 *     proxy straight to Node.add/activate, which calls x.activate({ world, entity }); getRef(x)
 *     (and Joint's body0/body1 setters) turn any `{ _isRef, _ref }` into whatever `_ref` holds
 *   - world.load() resolves to a raw Node, not its proxy
 *   - callbacks stored on nodes are called as methods, so `this` is the raw node (node.ctx.world)
 *   - app.control() returns whatever world.controls.bind() returns
 *   - App.fetch / App.setTimeout return a host Blob / the runtime's timer object
 *   - Scripts.js endows the host's own three.js classes, whose prototypes any script could patch
 *     under the engine, and Vector3.prototype.toPxVec3() returns the engine's shared PhysX object
 *
 * Behind the membrane a script gets, per app:
 *   world  an object built here from a fixed list of the engine's world methods (below)
 *   app    the engine's app proxy through a facade: the app methods and the root node's properties
 *   props  the blueprint's props through a facade
 *   fetch, setTimeout, console  lib/script-facades.ts
 * and as globals the names Scripts.js endows, minus Object3D (see SCRIPT_CLASSES).
 */

import * as engineThree from '../hyperfy/src/core/extras/three.js';
import { LerpVector3 } from '../hyperfy/src/core/extras/LerpVector3.js';
import { LerpQuaternion } from '../hyperfy/src/core/extras/LerpQuaternion.js';
import { Curve } from '../hyperfy/src/core/extras/Curve.js';
import { prng } from '../hyperfy/src/core/extras/prng.js';
import { DEG2RAD, RAD2DEG } from '../hyperfy/src/core/extras/general.js';
import { clamp, num, uuid } from '../hyperfy/src/core/utils.js';
import { Node, getRef } from '../hyperfy/src/core/nodes/Node.js';
import { type CallGuard, type ScriptClass, type ScriptMembrane, createScriptMembrane } from './script-membrane';
import {
  type ConsoleTarget,
  type ScriptNetwork,
  createScriptConsole,
  createScriptFetch,
  createScriptSetTimeout,
} from './script-facades';
import {
  type ProbeResult,
  activateScriptSandbox,
  createScriptCompartment,
  createSelfTestCompartment,
  runEscapeProbes,
  wrapScriptCode,
} from './script-sandbox';

type Constructor = new (...args: any[]) => object;

// three.js ships no type declarations; these are the classes the engine endows to scripts
const THREE = engineThree as unknown as Record<'Vector3' | 'Quaternion' | 'Euler' | 'Matrix4', Constructor>;
// The engine exports its own Vector3 under that name. three.js's own is what LerpVector3 is made of.
const StockVector3: Constructor = Object.getPrototypeOf(new LerpVector3(new THREE.Vector3(), 1).current).constructor;

function keyframeClass(): Constructor | undefined {
  try {
    // Not exported by the engine; a Curve's keyframes are instances of it
    const keyframe: object = new Curve().add({ time: 0, value: 0 }).keyframes[0];
    return Object.getPrototypeOf(keyframe).constructor as Constructor;
  } catch {
    return undefined;
  }
}

/**
 * The host classes whose instances scripts may use, each through a facade that hides "_" names.
 * Instances of every other class are opaque to scripts. The first seven are constructible globals
 * (the names hyperfy/src/core/systems/Scripts.js endows). Object3D is deliberately not offered,
 * as in coo-world: its instances lead to whatever they are attached to.
 */
const Keyframe = keyframeClass();
const SCRIPT_GLOBAL_CLASSES: ScriptClass[] = [
  // The engine's Vector3 is its own class; plain three.js vectors (LerpVector3's, the agent's) show as the same
  { name: 'Vector3', ctor: THREE.Vector3, aliases: [StockVector3] },
  { name: 'Quaternion', ctor: THREE.Quaternion },
  { name: 'Euler', ctor: THREE.Euler },
  { name: 'Matrix4', ctor: THREE.Matrix4 },
  { name: 'LerpVector3', ctor: LerpVector3 as Constructor },
  { name: 'LerpQuaternion', ctor: LerpQuaternion as Constructor },
  { name: 'Curve', ctor: Curve as Constructor },
];
const SCRIPT_CLASSES: ScriptClass[] = [...SCRIPT_GLOBAL_CLASSES, ...(Keyframe ? [{ name: 'Keyframe', ctor: Keyframe }] : [])];

// ---- the engine's script-facing objects, as far as this module calls them ----

type Fn = (...args: any[]) => unknown;

/** entities/App.js getWorldProxy(): methods of systems/Apps.js worldMethods, bound to one app */
interface EngineWorld {
  networkId: unknown;
  isServer: unknown;
  isClient: unknown;
  add: Fn;
  remove: Fn;
  attach: Fn;
  on: Fn;
  off: Fn;
  emit: Fn;
  getTime: Fn;
  getTimestamp: Fn;
  chat: Fn;
  getPlayer: Fn;
  getPlayers: Fn;
  createLayerMask: Fn;
  raycast: Fn;
  overlapSphere: Fn;
  load: (type: unknown, url: unknown) => Promise<unknown>;
}

interface EngineApp {
  on: (name: string, callback: () => void) => void;
}

const isObject = (value: unknown): value is object => value !== null && typeof value === 'object';

/**
 * The node-proxy members that take a node or a geometry, by name. Every engine member that turns
 * a value into a node (Node.js getRef, Joint.js `value._ref`) is in one of these lists;
 * script-api.test.ts scans the engine's sources and fails when a new one appears.
 *   NODE_ARGUMENTS  methods and the index of the argument that must be a node
 *   NODE_SETTERS    properties whose new value must be a node (or nothing)
 *   GEOMETRY_SETTERS  properties whose new value must be a geometry a node handed out (or nothing)
 */
export const NODE_ARGUMENTS: ReadonlyMap<string, number> = new Map([
  ['add', 0], // nodes/Node.js
  ['remove', 0], // nodes/Node.js
  ['insert', 0], // nodes/LOD.js
]);
export const NODE_SETTERS: ReadonlySet<string> = new Set(['body0', 'body1']); // nodes/Joint.js
export const GEOMETRY_SETTERS: ReadonlySet<string> = new Set(['geometry']); // nodes/Collider.js, Video.js (Mesh.js checks itself)
/** The world methods (systems/Apps.js) that take a node; createWorldApi refuses anything else */
export const WORLD_NODE_METHODS: ReadonlySet<string> = new Set(['add', 'remove', 'attach']);

/** The node a node proxy stands for, or undefined. Asks the engine (getRef), never the shape. */
function engineNodeOf(value: object): object | undefined {
  const node: unknown = getRef(value);
  return node instanceof Node && (node as { proxy?: unknown }).proxy === value ? node : undefined;
}

/**
 * Whether `value` is a geometry reference (what a Mesh/Collider/Video `geometry` getter returns):
 * the engine's reference object, standing for a geometry or for none yet. Never a node.
 */
function isEngineGeometryRef(value: object): boolean {
  if ((value as { _isRef?: unknown })._isRef !== true) return false;
  const geometry: unknown = getRef(value);
  if (geometry === null || geometry === undefined) return true;
  return isObject(geometry) && (geometry as { isBufferGeometry?: unknown }).isBufferGeometry === true && !(geometry instanceof Node);
}

export interface WorldScriptsOptions {
  /** Outbound requests for scripts' fetch(). Absent or null: scripts have no fetch (see ScriptNetwork). */
  network?: ScriptNetwork | null;
  log?: ConsoleTarget;
}

export interface WorldScript {
  exec: (...args: unknown[]) => void;
  code: string;
}

export interface WorldScripts {
  /** A script asset, evaluated lazily in its own compartment on first exec (as the engine's Scripts.evaluate) */
  evaluate(code: string): WorldScript;
}

interface Runtime {
  membrane: ScriptMembrane;
  globals(): Record<string, unknown>;
  /** The engine's app proxies, which stand in for their root node in add()/remove()/world.add() */
  appProxies: WeakSet<object>;
  /** A node proxy or an app proxy */
  isNode(value: unknown): boolean;
}

/**
 * The helper functions endowed to scripts are the engine's own (utils.js, prng.js), shared with
 * the rest of the process. Scripts only ever hold wrappers of them, and no function can be the
 * `this` of a call, so nothing writes to them; frozen regardless.
 */
const ENDOWED_FUNCTIONS: Fn[] = [num, prng, clamp, uuid];
function freezeEndowedFunctions(): void {
  for (const fn of ENDOWED_FUNCTIONS) {
    Object.freeze(fn);
    const prototype: unknown = Object.getOwnPropertyDescriptor(fn, 'prototype')?.value;
    if (isObject(prototype)) Object.freeze(prototype);
  }
}

function createRuntime(log: ConsoleTarget): Runtime {
  freezeEndowedFunctions();
  const appProxies = new WeakSet<object>();
  // By identity only: an app proxy the engine handed to exec(), or a node proxy that this
  // membrane showed to a script and that the engine itself says is a node's own proxy
  const isNode = (value: unknown): boolean =>
    isObject(value) && (appProxies.has(value) || (membrane.handedOut(value) && engineNodeOf(value) !== undefined));
  const isGeometry = (value: unknown): boolean => isObject(value) && membrane.handedOut(value) && isEngineGeometryRef(value);
  const membrane: ScriptMembrane = createScriptMembrane({
    classes: SCRIPT_CLASSES,
    // node.add(x)/remove(x)/insert(x): the engine would call x.activate(ctx) on anything, and keep it as a child
    guardFor: (owner, prop): CallGuard | undefined => {
      const index = NODE_ARGUMENTS.get(prop);
      if (index === undefined || !isNode(owner)) return undefined;
      return (args) => {
        if (!isNode(args[index])) throw new TypeError(`${prop}() expects a node`);
      };
    },
    guardSet: (owner, prop): CallGuard | undefined => {
      if (!isNode(owner)) return undefined;
      if (NODE_SETTERS.has(prop)) {
        return ([value]) => {
          if (value != null && !isNode(value)) throw new TypeError(`${prop} must be a node`);
        };
      }
      if (GEOMETRY_SETTERS.has(prop)) {
        return ([value]) => {
          if (value != null && !isGeometry(value)) throw new TypeError(`${prop} must be the geometry of a node`);
        };
      }
      return undefined;
    },
    onAsyncError: (error) => log.error(`[script] an async callback failed: ${error.message}`),
  });
  const host = <T extends object>(value: T) => membrane.toScript(Object.freeze(value));
  const globals = (): Record<string, unknown> => ({
    console: membrane.toScript(createScriptConsole(log)),
    Date: host({ now: () => Date.now() }),
    URL: host({
      createObjectURL: () => {
        // Nothing in the agent displays an object URL, and one would pin its bytes in memory
        throw new TypeError('URL.createObjectURL is not available to world scripts in this agent');
      },
    }),
    Math,
    eval: undefined,
    harden: undefined,
    lockdown: undefined,
    Compartment: undefined,
    num: membrane.toScript(num),
    prng: membrane.toScript(prng),
    clamp: membrane.toScript(clamp),
    uuid: membrane.toScript(uuid),
    ...Object.fromEntries(SCRIPT_GLOBAL_CLASSES.map(({ name }) => [name, membrane.scriptClass(name)])),
    DEG2RAD,
    RAD2DEG,
  });
  return { membrane, globals, appProxies, isNode };
}

/**
 * The `world` object of one app. Only these names exist; each calls the engine's own world proxy
 * for that app. Differences from the engine's world proxy:
 *   - add/remove/attach take a node (or an app) and nothing else
 *   - chat never asks for a broadcast (the agent's chat.add would ignore it anyway: lib/world-chat.ts)
 *   - get/set (the engine's key-value storage) and open (browser navigation) do nothing
 *   - load resolves to the loaded node's proxy, and says nothing about why a load failed
 */
function createWorldApi(engine: EngineWorld, isNode: (value: unknown) => boolean) {
  const node = (value: unknown, method: string) => {
    if (!isNode(value)) throw new TypeError(`world.${method}() expects a node`);
    return value;
  };
  const text = (value: unknown, what: string) => {
    if (typeof value !== 'string') throw new TypeError(`${what} must be a string`);
    return value;
  };
  const callback = (value: unknown, what: string) => {
    if (typeof value !== 'function') throw new TypeError(`${what} must be a function`);
    return value;
  };
  return Object.freeze({
    get networkId() {
      return engine.networkId;
    },
    get isServer() {
      return engine.isServer;
    },
    get isClient() {
      return engine.isClient;
    },
    add: (pNode: unknown) => void engine.add(node(pNode, 'add')),
    remove: (pNode: unknown) => void engine.remove(node(pNode, 'remove')),
    attach: (pNode: unknown) => void engine.attach(node(pNode, 'attach')),
    on: (name: unknown, fn: unknown) => void engine.on(text(name, 'world.on() event name'), callback(fn, 'world.on() listener')),
    off: (name: unknown, fn: unknown) => void engine.off(text(name, 'world.off() event name'), fn),
    emit: (name: unknown, data: unknown) => void engine.emit(text(name, 'world.emit() event name'), data),
    getTime: () => engine.getTime(),
    getTimestamp: (format?: unknown) => engine.getTimestamp(typeof format === 'string' ? format : undefined),
    chat: (msg: unknown) => {
      if (!isObject(msg)) return;
      engine.chat(msg, false);
    },
    getPlayer: (playerId?: unknown) => engine.getPlayer(typeof playerId === 'string' ? playerId : undefined),
    getPlayers: () => engine.getPlayers(),
    createLayerMask: (...groups: unknown[]) => engine.createLayerMask(...groups.map((group) => text(group, 'layer group'))),
    raycast: (origin: unknown, direction: unknown, maxDistance?: unknown, layerMask?: unknown) =>
      engine.raycast(origin, direction, maxDistance, layerMask),
    overlapSphere: (radius: unknown, origin: unknown, layerMask?: unknown) => engine.overlapSphere(radius, origin, layerMask),
    get: () => undefined,
    set: () => undefined,
    open: () => undefined,
    load: (type: unknown, url: unknown) =>
      engine.load(text(type, 'world.load() type'), text(url, 'world.load() url')).then(
        (loaded) => {
          const getProxy = isObject(loaded) ? (loaded as { getProxy?: unknown }).getProxy : undefined;
          return typeof getProxy === 'function' ? (getProxy.call(loaded) as unknown) : undefined;
        },
        () => {
          // The loader's own message names the HTTP status or quotes what failed to parse: a script
          // that could read it would learn about whatever answers at a URL of its choosing
          throw new Error('world.load() failed');
        }
      ),
  });
}

// Names every object inherits (constructor, valueOf, __defineGetter__, ...): the engine's proxies
// resolve them against its method tables, see the header. They are served from the facade instead.
const appAllows = (prop: string) => !(prop in Object.prototype);

type ScriptMain = (world: unknown, app: unknown, fetch: unknown, props: unknown, setTimeout: unknown) => unknown;

/**
 * The script runtime for one world connection. Requires the sandbox to be active
 * (activateWorldScripts); evaluating before that throws.
 */
export function createWorldScripts({ network = null, log = console }: WorldScriptsOptions = {}): WorldScripts {
  const { membrane, globals, appProxies, isNode } = createRuntime(log);
  const worlds = new WeakMap<object, unknown>();

  return {
    evaluate(code) {
      let main: ScriptMain | undefined;
      const compartment = createScriptCompartment(globals());
      return {
        code,
        exec: (...args) => {
          const [engineWorld, engineApp, , props, engineSetTimeout] = args;
          if (!isObject(engineWorld) || !isObject(engineApp) || typeof engineSetTimeout !== 'function') {
            throw new Error('World script was started with unexpected arguments');
          }
          main ??= compartment.evaluate(wrapScriptCode(code)) as ScriptMain;
          appProxies.add(engineApp);
          let world = worlds.get(engineWorld);
          if (!world) {
            world = membrane.toScript(createWorldApi(engineWorld as EngineWorld, isNode));
            worlds.set(engineWorld, world);
          }
          // The engine emits 'destroy' to the app's listeners when it rebuilds or removes the app
          const run = new AbortController();
          (engineApp as EngineApp).on('destroy', () => run.abort());
          try {
            main(
              world,
              membrane.exposeDynamic(engineApp, appAllows),
              membrane.toScript(createScriptFetch(network, run.signal, log)),
              membrane.toScript(props),
              membrane.toScript(createScriptSetTimeout(engineSetTimeout as (fn: () => void, ms: number) => unknown, log))
            );
          } catch (err) {
            // Never the script's own object: the engine logs what it catches
            throw membrane.toHostError(err);
          }
        },
      };
    },
  };
}

const quiet: ConsoleTarget = { log() {}, warn() {}, error() {} };

/** The self-test, run against compartments and a membrane built exactly as for a world script */
export function selfTestWorldScripts(): Promise<ProbeResult[]> {
  const { membrane, globals } = createRuntime(quiet);
  return runEscapeProbes({
    toScript: membrane.toScript,
    evaluate: (code, extraGlobals) => createSelfTestCompartment({ ...globals(), ...extraGlobals }).evaluate(code),
  });
}

/**
 * Locks the process down (SES) and runs the self-test. False means the sandbox is not usable and
 * the process must not continue: see activateScriptSandbox.
 */
export function activateWorldScripts(log: Pick<Console, 'info' | 'error'> = console): Promise<boolean> {
  return activateScriptSandbox({ selfTest: selfTestWorldScripts, log });
}
