import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createNode } from '../hyperfy/src/core/extras/createNode.js';
import * as engineThree from '../hyperfy/src/core/extras/three.js';
import { secureRef } from '../hyperfy/src/core/nodes/Node.js';
import { findConstructionProperties, findReferenceReaders, read, sourceFiles } from '../test-support/engine-references';
import {
  CALLBACK_PROPERTY,
  CONSTRUCTION_REFERENCES,
  GEOMETRY_SETTERS,
  NODE_ARGUMENTS,
  NODE_SETTERS,
  WORLD_NODE_METHODS,
  createNodeGuards,
  isEngineGeometryRef,
} from './script-api';

// The guards in script-api.ts are tested through the real engine in script-sandbox.child.test.ts.
// This file keeps their lists complete: it reads the engine's sources (a third-party submodule
// that can change under the agent) and the agent's own node classes (systems/) for every member
// that turns a value into a node or geometry. It also checks the guards' decisions one by one.

const here = path.dirname(fileURLToPath(import.meta.url));
const core = path.resolve(here, '../hyperfy/src/core');
const systems = path.resolve(here, '../systems');
const THREE = engineThree as unknown as { BufferGeometry: new () => object };

function scan(): string[] {
  const findings = [
    ...sourceFiles(core, '.js').flatMap((file) => findReferenceReaders(path.relative(core, file), read(file))),
    ...sourceFiles(systems, '.ts').flatMap((file) => findReferenceReaders(`agent:systems/${path.relative(systems, file)}`, read(file))),
  ];
  return [...new Set(findings.map(({ file, member, how }) => `${file}:${member} (${how})`))].sort();
}

const constructionEntries = (file: string, text: string) =>
  findConstructionProperties(file, text).map(({ className, property, dataKey }) => `${className}.${property}${dataKey === property ? '' : ` <- data.${dataKey}`}`);

describe('the node and geometry guards of the script API', () => {
  it('cover every engine or agent member that turns a value into a node or geometry', () => {
    const readers = scan();

    // If this list changes, there is a new way for a script's value to become a node: give it a
    // guard in script-api.ts (NODE_ARGUMENTS, NODE_SETTERS, GEOMETRY_SETTERS, WORLD_NODE_METHODS)
    // and a forged-reference case in test-support/sandbox/hostile-hooks.js
    expect(readers).toEqual([
      'nodes/Collider.js:set geometry (getRef)',
      'nodes/Joint.js:set body0 (_ref)',
      'nodes/Joint.js:set body1 (_ref)',
      'nodes/LOD.js:insert (getRef)',
      'nodes/Node.js:add (getRef)',
      'nodes/Node.js:function getRef (_ref)',
      'nodes/Node.js:function secureRef (_ref)',
      'nodes/Node.js:remove (getRef)',
      'nodes/Video.js:set geometry (getRef)',
      'systems/Apps.js:add (getRef)',
      'systems/Apps.js:attach (getRef)',
      'systems/Apps.js:remove (getRef)',
    ]);
    for (const reader of readers) {
      const [file, rest] = reader.split(':');
      const member = rest.replace(/ \(.*\)$/, '');
      // The definitions of references themselves
      if (member === 'function getRef' || member === 'function secureRef') continue;
      const covered = file === 'systems/Apps.js'
        ? WORLD_NODE_METHODS.has(member)
        : member.startsWith('set ')
          ? NODE_SETTERS.has(member.slice(4)) || GEOMETRY_SETTERS.has(member.slice(4))
          : NODE_ARGUMENTS.has(member);
      expect(covered, reader).toBe(true);
    }
  });

  it('cover every construction property a node class hands to one of those setters', () => {
    const properties = sourceFiles(path.join(core, 'nodes'), '.js').flatMap((file) => findConstructionProperties(file, read(file)));
    const guarded = new Set([...NODE_SETTERS, ...GEOMETRY_SETTERS, 'material']);
    const relevant = properties.filter(({ property, dataKey }) => guarded.has(property) || guarded.has(dataKey) || property === '*');

    expect(relevant.map(({ className, property, dataKey }) => `${className}.${property} <- data.${dataKey}`).sort()).toEqual([
      'Collider.geometry <- data.geometry',
      'Mesh.geometry <- data.geometry',
      'Mesh.material <- data.material',
      'Video.geometry <- data.geometry',
    ]);
    for (const { dataKey } of relevant) expect(CONSTRUCTION_REFERENCES.has(dataKey), dataKey).toBe(true);
    // Callbacks a constructor stores are checked by name (CALLBACK_PROPERTY), whatever the class
    const callbacks = properties.filter(({ property }) => /^_?on[A-Z]/.test(property));
    for (const { property, dataKey } of callbacks) expect(CALLBACK_PROPERTY.test(dataKey), `${property} <- data.${dataKey}`).toBe(true);
    // (the node classes do store callbacks from their construction data: these among them)
    expect(callbacks.map(({ className, property }) => `${className}.${property}`)).toEqual(expect.arrayContaining(['Action.onTrigger', 'Node._onPointerDown', 'RigidBody.onContactStart']));
  });

  it('find the forms a line search misses (the scanner checked against a made-up node class)', () => {
    const fake = `
      import { getRef, getRef as ref, Node } from './Node'
      import * as N from './Node'
      const KEY = '_r' + 'ef'
      const lookUp = ref
      function adoptInto(parent, node) { parent.children.push(node) }
      export class Fake extends Node {
        getProxy() {
          if (!this.proxy) {
            const self = this
            const base = super.getProxy()
            let proxy = {
              ...base,
              insert(pNode, maxDistance) { const node = getRef(pNode); self.insert(node, maxDistance) },
              attachTo: pNode => { const node = getRef(pNode); self.add(node) },
              mount2(pNode) {
                const node = getRef(
                  pNode
                )
                self.add(node)
              },
              set target(value) { self.target = value && value['_ref'] },
              link(value) { const { _ref } = value; self.add(_ref) },
              adopt(child) { self.add(child) },
              wake(child) { child.activate(self.ctx) },
              renamed(pNode) { self.add(ref(pNode)) },
              namespaced(pNode) { self.add(N.getRef(pNode)) },
              aliased(pNode) { self.add(lookUp(pNode)) },
              called(pNode) { self.add(getRef.call(null, pNode)) },
              computed(value) { self.add(value[KEY]) },
              template(value) { self.add(value[\`_\${'r'}ef\`]) },
              reflected(value) { self.add(Reflect.get(value, '_ref')) },
              helper(child) { self.adoptChild(child) },
              deepHelper(child) { self.adoptLater(child) },
              fileHelper(child) { adoptInto(self, child) },
              pushed(child) { self.children.push(child); child.parent = self },
              placed(child) { self.children[0] = child },
              rest(...args) { self.add(args[0]) },
              spreadArgs(...args) { self.add(...args) },
              alias(child) { const c = child; self.add(c) },
              destructured({ node }) { self.add(node) },
              property(options) { self.add(options.node ?? null) },
              loop(list) { for (const item of list) self.add(item) },
              args() { self.add(arguments[0]) },
            }
            this.proxy = proxy
          }
          return this.proxy
        }
        adoptChild(n) { this.add(n) }
        adoptLater(n) { this.adoptChild(n) }
      }`;

    const found = findReferenceReaders('nodes/Fake.js', fake).map(({ member, how }) => `${member} (${how})`);

    expect([...new Set(found)].sort()).toEqual([
      '<top level> (_ref)',
      'adopt (adopts its argument)',
      'alias (adopts its argument)',
      'aliased (getRef)',
      'args (adopts its argument)',
      'attachTo (getRef)',
      'called (getRef)',
      'computed (_ref)',
      'computed (adopts its argument)',
      'deepHelper (adopts its argument)',
      'destructured (adopts its argument)',
      'fileHelper (adopts its argument)',
      'getProxy (spreads a proxy)',
      'helper (adopts its argument)',
      'insert (getRef)',
      'link (_ref)',
      'link (adopts its argument)',
      'loop (adopts its argument)',
      'mount2 (getRef)',
      'namespaced (getRef)',
      'placed (adopts its argument)',
      'property (adopts its argument)',
      'pushed (adopts its argument)',
      'reflected (_ref)',
      'renamed (getRef)',
      'rest (adopts its argument)',
      'set target (_ref)',
      'spreadArgs (adopts its argument)',
      'template (_ref)',
      'template (adopts its argument)',
      'wake (adopts its argument)',
    ]);
    // Object.assign() reads the getters of what it copies, as a spread does
    const assigning = `
      export class Fake extends Node {
        getProxy() {
          const base = super.getProxy()
          this.proxy = Object.assign({}, base, { extra() {} })
          return this.proxy
        }
      }`;
    expect(findReferenceReaders('nodes/Fake.js', assigning).map(({ member, how }) => `${member} (${how})`)).toEqual(['getProxy (spreads a proxy)']);
  });

  it('find construction data handed to a property in the forms a line search misses', () => {
    const fake = `
      export class Plain extends Node {
        constructor(data = {}) {
          super(data)
          this.geometry = data.geometry ?? null
          const { body0, body1: second = null } = data
          this.body0 = body0
          this.body1 = second
          this.material = data?.material
          this['shape'] = data['shape'] || 'box'
          this.size = flag ? data.size : 1
          this.unrelated = 7
        }
      }
      export class Renamed extends Node {
        constructor(opts) {
          super(opts)
          const self = this
          const d = opts ?? {}
          self.geometry = d.geom
        }
      }
      export class Destructuring extends Node {
        constructor({ geometry, material } = {}) {
          super()
          this.geometry = geometry
          this._material = material
        }
      }
      export class Assigning extends Node {
        constructor(data) {
          super(data)
          Object.assign(this, data)
        }
      }`;

    expect(constructionEntries('nodes/Fake.js', fake)).toEqual([
      'Plain.geometry',
      'Plain.body0',
      'Plain.body1',
      'Plain.material',
      'Plain.shape',
      'Plain.size',
      'Renamed.geometry <- data.geom',
      'Destructuring.geometry',
      'Destructuring._material <- data.material',
      'Assigning.*',
    ]);
  });
});

describe('createNodeGuards', () => {
  const node = { kind: 'node' };
  const otherNode = { kind: 'node' };
  const geometry = { kind: 'geometry' };
  const { guardFor, guardSet } = createNodeGuards(
    (value) => value === node || value === otherNode,
    (value) => value === geometry
  );
  const outcome = (guard: ((args: unknown[]) => void) | undefined, args: unknown[]) => {
    if (!guard) return 'unguarded';
    try {
      guard(args);
      return 'ok';
    } catch (err) {
      return (err as Error).message;
    }
  };

  it('on a recognised node: node members take a node, geometry setters a geometry, callbacks a function, all also nothing', () => {
    expect(outcome(guardFor(node, 'add'), [otherNode])).toBe('ok');
    expect(outcome(guardFor(node, 'add'), [{ fake: true }])).toBe('add() expects a node');
    expect(outcome(guardFor(node, 'insert'), [geometry, 10])).toBe('insert() expects a node');
    expect(outcome(guardFor(node, 'traverse'), [{}])).toBe('unguarded');
    expect(outcome(guardSet(node, 'body0'), [otherNode])).toBe('ok');
    expect(outcome(guardSet(node, 'body0'), [null])).toBe('ok');
    expect(outcome(guardSet(node, 'body1'), [{ _isRef: true }])).toBe('body1 must be a node');
    expect(outcome(guardSet(node, 'geometry'), [geometry])).toBe('ok');
    expect(outcome(guardSet(node, 'geometry'), [{ isBufferGeometry: true }])).toBe('geometry must be the geometry of a node');
    for (const callback of ['onLoad', 'onPointerDown', 'onContactStart', 'onEnd']) {
      expect(outcome(guardSet(node, callback), [() => {}])).toBe('ok');
      expect(outcome(guardSet(node, callback), [undefined])).toBe('ok');
      expect(outcome(guardSet(node, callback), [{ not: 'a function' }])).toBe(`${callback} must be a function`);
      expect(outcome(guardSet(node, callback), ['text'])).toBe(`${callback} must be a function`);
    }
    expect(outcome(guardSet(node, 'once'), ['text'])).toBe('unguarded');
    expect(outcome(guardSet(node, 'position'), [[1, 2, 3]])).toBe('unguarded');
  });

  it('fails closed on an object that claims to be a reference but is not a recognised node', () => {
    const unrecognised = [
      { _isRef: true },
      {
        get _isRef(): boolean {
          throw new Error('cannot tell');
        },
      },
    ];
    for (const owner of unrecognised) {
      expect(outcome(guardFor(owner, 'add'), [otherNode])).toBe('add() is not available on this node');
      expect(outcome(guardFor(owner, 'remove'), [otherNode])).toBe('remove() is not available on this node');
      expect(outcome(guardSet(owner, 'body0'), [otherNode])).toBe('body0 cannot be set on this node');
      expect(outcome(guardSet(owner, 'geometry'), [geometry])).toBe('geometry cannot be set on this node');
    }
    // An object that claims nothing (a vector, a plain facade) is left alone
    expect(guardFor({ x: 1 }, 'add')).toBeUndefined();
    expect(guardSet({ _isRef: false }, 'geometry')).toBeUndefined();
  });
});

describe('isEngineGeometryRef', () => {
  it("takes the engine's reference to one of its geometries or to none, and nothing shaped like one", () => {
    const real = createNode('mesh', { type: 'geometry', geometry: new THREE.BufferGeometry() });
    const empty = createNode('mesh', { type: 'box' });
    const forged = {
      _isRef: true,
      _ref: { isBufferGeometry: true, attributes: { position: { count: 3, array: [0, 0, 0, 1, 0, 0, 0, 1, 0], itemSize: 3 } }, index: null },
    };

    expect(isEngineGeometryRef(real.geometry)).toBe(true);
    expect(isEngineGeometryRef(real.getProxy().geometry)).toBe(true);
    expect(isEngineGeometryRef(empty.geometry)).toBe(true);
    // JSON from the world (props, app state, an event's data) or a copy of a script's object
    expect(isEngineGeometryRef(forged)).toBe(false);
    expect(isEngineGeometryRef(JSON.parse(JSON.stringify(forged)))).toBe(false);
    expect(isEngineGeometryRef({ _isRef: true, _ref: null })).toBe(false);
    expect(isEngineGeometryRef(new THREE.BufferGeometry())).toBe(false);
    // A reference the engine made, to something shaped like a geometry
    expect(isEngineGeometryRef(secureRef({}, () => forged._ref))).toBe(false);
    // A node's proxy is a reference too, to a node
    expect(isEngineGeometryRef(createNode('group').getProxy())).toBe(false);
  });
});
