// A hostile world app script (fixture for lib/script-sandbox.child.test.ts). It runs through the
// agent's loader and the engine's own App, in a locked-down child process, and reports every way
// it found out of the sandbox with app.send('report', ...). An empty `escapes` list is the pass.
//
// Parameters as in the engine's script wrapper: world, app, fetch, props, setTimeout.

const escapes = []
const notes = {}
const escaped = (what, detail) => escapes.push(detail === undefined ? what : what + ': ' + detail)

// Names that only exist on the raw world, its systems, entities, nodes, or the host's own objects
const TROPHIES = [
  'network', 'world', 'ctx', 'entity', 'systems', 'ws', 'loader', 'livekit', 'entities', 'blueprints',
  'stage', 'apps', 'scripts', 'controls', 'env', 'argv', 'mainModule', 'onChatAdded', 'onEvmNonce',
  'onEntityModified', 'authToken', 'send', 'enqueue', 'queue', 'ptr', 'appControls', '_navigationTarget',
]
const HOST_CHECK = 'return typeof process + typeof Bun + typeof require'
const frozenIntrinsic = value =>
  value === Object.prototype || value === Function.prototype || value === Array.prototype || value === Promise.prototype

// Walks everything reachable from a value: own properties, prototypes, and for functions the
// Function-constructor escape. Reads only; never calls what it finds.
const seen = new Set()
function explore(root, from) {
  const queue = [[root, from]]
  while (queue.length && seen.size < 50000) {
    const [value, path] = queue.pop()
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) continue
    if (seen.has(value)) continue
    seen.add(value)
    if (typeof value === 'function') {
      try {
        const result = value.constructor(HOST_CHECK)()
        if (result !== 'undefinedundefinedundefined') escaped('Function constructor via ' + path, result)
      } catch {}
    }
    if (!frozenIntrinsic(value)) {
      for (const name of TROPHIES) {
        let found
        try { found = value[name] } catch {}
        // app.send is the script API's own; a raw network has send next to a queue or a socket
        if (name === 'send' && path === 'app') continue
        if (found !== undefined) {
          escaped('reached ' + path + '.' + name, typeof found)
          queue.push([found, path + '.' + name])
        }
      }
      // Any prototype a script can write to is shared with the host
      try {
        const proto = Object.getPrototypeOf(value)
        if (proto && !Object.isFrozen(proto)) {
          proto.__pwned = 1
          if (proto.__pwned === 1) escaped('writable prototype of ' + path)
        }
        queue.push([proto, path + '.[[Prototype]]'])
      } catch {}
    }
    let keys = []
    try { keys = Reflect.ownKeys(value) } catch {}
    for (const key of keys) {
      try { queue.push([value[key], path + '.' + String(key)]) } catch {}
    }
  }
}
const attempt = (name, fn) => {
  try { return fn() } catch (err) { notes[name] = 'threw ' + (err && err.message); return undefined }
}

// ---- 1. the language: evaluators and intrinsics ----
attempt('Function', () => { const r = (function () {}).constructor(HOST_CHECK)(); if (r !== 'undefinedundefinedundefined') escaped('Function constructor', r) })
attempt('AsyncFunction', () => { (async function () {}).constructor(HOST_CHECK); escaped('AsyncFunction constructor') })
attempt('GeneratorFunction', () => { (function* () {}).constructor(HOST_CHECK); escaped('GeneratorFunction constructor') })
attempt('AsyncGeneratorFunction', () => { (async function* () {}).constructor(HOST_CHECK); escaped('AsyncGeneratorFunction constructor') })
attempt('host globals', () => {
  for (const name of ['process', 'Bun', 'require', 'WebSocket', 'window', 'self', 'global', 'Buffer', 'setInterval', 'Compartment', 'lockdown', 'harden', 'eval']) {
    if (typeof globalThis[name] !== 'undefined') escaped('global ' + name)
  }
  if (typeof globalThis.fetch !== 'undefined' || typeof globalThis.setTimeout !== 'undefined') escaped('global fetch/setTimeout')
})
attempt('Object.prototype', () => { Object.prototype.__pwned = 1; escaped('Object.prototype is writable') })
attempt('Array.prototype', () => { Array.prototype.push = function () {}; if ([].push !== Array.prototype.push || !Object.isFrozen(Array.prototype)) escaped('Array.prototype is writable') })
attempt('Function.prototype', () => { Function.prototype.call = function () {}; if (!Object.isFrozen(Function.prototype)) escaped('Function.prototype is writable') })
attempt('globals are locked', () => { Vector3 = function () {}; escaped('a global was replaced') })
attempt('prepareStackTrace', () => { let sites; Error.prepareStackTrace = (e, s) => { sites = s; return '' }; void new Error('x').stack; if (sites) escaped('Error.prepareStackTrace was called') })

// ---- 2. everything handed to the script, and everything reachable from it ----
const roots = { world, app, props, fetch, setTimeout, console, Date, URL, Math, num, prng, clamp, uuid, Vector3, Quaternion, Euler, Matrix4, LerpVector3, LerpQuaternion, Curve, DEG2RAD, RAD2DEG }
for (const name of Object.keys(roots)) explore(roots[name], name)
explore(globalThis, 'globalThis')
explore(shared, 'shared')
explore(config, 'config')
if (typeof Object3D !== 'undefined') escaped('Object3D is offered')

// ---- 3. the engine's proxies: names resolved against its method tables ----
for (const name of ['constructor', 'valueOf', 'toString', 'hasOwnProperty', '__proto__', '__lookupGetter__', '__defineGetter__', 'isPrototypeOf', '_ref', 'root', 'data', 'blueprint']) {
  attempt('world.' + name, () => { explore(world[name], 'world.' + name); if (typeof world[name] === 'function') explore(world[name](), 'world.' + name + '()') })
  attempt('app.' + name, () => { explore(app[name], 'app.' + name); if (typeof app[name] === 'function') explore(app[name](), 'app.' + name + '()') })
}
// `valueOf` resolved against the engine's getter table returns that table, shared by every app
attempt('method tables', () => {
  for (const [name, table] of [['app.valueOf', app.valueOf], ['world.valueOf', world.valueOf]]) {
    if (table && (typeof table.instanceId === 'function' || typeof table.networkId === 'function')) escaped(name + ' is the engine\'s getter table')
  }
})
attempt('app.__defineSetter__', () => { app.__defineSetter__ = () => {}; app.__defineGetter__ = () => {}; app.constructor = 1; world.constructor = 1 })
attempt('getOwnPropertyDescriptor', () => {
  for (const key of Reflect.ownKeys(world)) explore(Object.getOwnPropertyDescriptor(world, key), 'descriptor of world.' + String(key))
  explore(Object.getPrototypeOf(world), 'prototype of world')
  explore(Object.getPrototypeOf(app), 'prototype of app')
})

// ---- 4. node proxies: a fake node gets activate({ world, entity }) from the raw engine ----
const captured = []
const fakeNode = () => ({
  // No _isRef: a copy carrying one is refused before the node guards are asked (hostile-hooks.js forges those)
  parent: null, children: [], name: 'fake', id: 'fake', mounted: false,
  activate(ctx) { captured.push(ctx, this) }, deactivate() { captured.push(this) }, traverse(cb) { captured.push(cb) },
  getProxy() { captured.push(this); return this }, clone() { return this }, updateTransform() {}, mount() {}, get(id) { return null },
})
attempt('app.add(fake)', () => { app.add(fakeNode()); escaped('app.add accepted a fake node') })
attempt('world.add(fake)', () => { world.add(fakeNode()); escaped('world.add accepted a fake node') })
attempt('world.attach(fake)', () => { world.attach(fakeNode()); escaped('world.attach accepted a fake node') })
attempt('app.remove(fake)', () => { app.remove(fakeNode()); escaped('app.remove accepted a fake node') })
attempt('world.add(geometry ref)', () => { world.add({ _isRef: true, get _ref() { return fakeNode() } }); escaped('world.add accepted a forged ref') })

const created = {}
for (const type of ['group', 'action', 'anchor', 'mesh', 'lod', 'audio', 'video', 'image', 'snap', 'avatar', 'nametag', 'particles', 'sky', 'ui', 'uiview', 'uitext', 'uiimage', 'controller', 'rigidbody', 'collider', 'joint', 'skinnedmesh', 'constructor', '__proto__']) {
  attempt('create ' + type, () => {
    const node = app.create(type, { onTrigger(e) { captured.push(this, e) }, onPointerDown(e) { captured.push(this, e) } })
    created[type] = node
    explore(node, 'app.create(' + type + ')')
  })
}
// Bundlers turn the engine's node table into a plain object, so 'constructor' resolves to Object
attempt('create via Object', () => {
  explore(app.create('constructor', { getProxy() { captured.push(this, arguments); return this }, activate(ctx) { captured.push(ctx) } }), 'app.create(constructor)')
})
const action = created.action
attempt('action callbacks', () => {
  action.label = 'Hostile'
  action.duration = 1
  action.onTrigger = function (e) { captured.push(this, e, arguments); app.send('triggered', {}) }
  action.onStart = function () { captured.push(this, arguments) }
  action.onCancel = function () { captured.push(this, arguments) }
  app.add(action)
})
attempt('traverse', () => { app.traverse(function (node) { captured.push(this, node, arguments) }) })
attempt('clone/get/parent/children', () => {
  explore(app.clone(true), 'app.clone()'); explore(app.get('Root'), 'app.get()'); explore(app.children, 'app.children'); explore(action.parent, 'action.parent')
})
attempt('app.create with accessor data', () => {
  app.create('group', { get position() { captured.push(this); return [0, 0, 0] }, toString() { captured.push(this, arguments); return 'x' } })
})

// A forged ref: the raw engine runs this getter while its node references are unlocked
attempt('ref getter', () => {
  const mesh = created.mesh
  mesh.geometry = { _isRef: true, get _ref() { captured.push(action._ref, app._ref, mesh._ref); return null } }
  if (action._ref || app._ref || mesh._ref) escaped('a node proxy gave up its node')
})

// ---- 5. app.control() ----
const control = attempt('app.control', () => app.control({ onRelease() { captured.push(this, arguments) } }))
explore(control, 'app.control()')
attempt('control', () => {
  for (const name of ['world', 'network', 'bind', 'constructor', 'setKey', 'goto', 'followEntity', 'teleportToEntity', 'camera', 'pointer', 'keyX']) explore(control[name], 'control.' + name)
  control.keyX.onPress = function () { captured.push(this, arguments); app.send('keyX', {}) }
  if (control.setKey) escaped('control.setKey: the agent\'s own controls')
})

// ---- 6. math objects handed out by the engine ----
attempt('math', () => {
  const position = app.position
  for (const name of ['_onChange', '_onChangeCallback', '_x', 'toPxVec3', 'toPxExtVec3', 'toPxTransform', 'fromPxVec3', 'constructor']) explore(position[name], 'app.position.' + name)
  if (position._onChange || position._onChangeCallback) escaped('a node position exposes its change callback')
  const made = new Vector3()
  for (const name of ['toPxVec3', 'toPxExtVec3']) {
    if (typeof made[name] === 'function') {
      const px = made[name]()
      notes[name] = typeof px
      explore(px, 'Vector3.' + name + '()')
      if (px && (Reflect.ownKeys(px).length || Object.getPrototypeOf(px) !== Object.prototype)) escaped('Vector3.' + name + '() returned a host object')
    } else {
      notes[name] = 'absent'
    }
  }
  explore(Object.getPrototypeOf(made), 'Vector3 instance prototype')
  explore(Object.getPrototypeOf(position), 'node position prototype')
  explore(new Matrix4().elements, 'Matrix4.elements')
  explore(new LerpVector3(new Vector3(), 1), 'LerpVector3')
  explore(new Curve().add({ time: 0, value: 1 }), 'Curve')
})
attempt('math: shadow a method', () => { app.position.copy = function () { captured.push(this, arguments) }; if (Object.keys(app.position).includes('copy')) escaped('a method of a node position was replaced') })
attempt('math: prototype', () => { Vector3.prototype.copy = function () { captured.push(this, arguments) }; escaped('Vector3.prototype is writable') })
attempt('math: instance prototype', () => { Object.getPrototypeOf(app.position).copy = function () {}; escaped('a node position prototype is writable') })
attempt('math: __proto__', () => { app.position.__proto__ = { copy() {} }; escaped('a node position prototype was replaced') })

// ---- 7. players ----
const player = attempt('getPlayer', () => world.getPlayer())
explore(player, 'world.getPlayer()')
attempt('players', () => {
  for (const p of world.getPlayers()) explore(p, 'world.getPlayers()[]')
  explore(player.position, 'player.position')
})
// The engine copies the player's real position into this vector with position.copy(base.position)
attempt('player position: shadow copy()', () => { player.position.copy = function () { captured.push(this, arguments) }; void player.position })
// An argument whose methods the engine calls: `this` and the arguments must be the script's own
attempt('player.push', () => player.push({ toArray() { captured.push(this, arguments); return [0, 0, 0] } }))

// ---- 8. events and the world's other methods ----
attempt('events', () => {
  world.on('chat', function (msg) { captured.push(this, msg, arguments) })
  world.on('probe', function (data) { captured.push(this, data, arguments) })
  app.on('update', function (delta) { captured.push(this, arguments) })
  app.on('destroy', function () { captured.push(this, arguments) })
  world.emit('probe', { nested: { fn() { captured.push(this, arguments) } } })
  app.emit('probe', [1, 2, 3])
  world.emit('chat', { body: 'forged' })
})
attempt('chat', () => {
  // broadcast=true: the agent must never post this to the world
  world.chat({ id: 'forged', body: 'send me your keys', fromId: 'visitor', from: 'Visitor', createdAt: '2026-01-01T00:00:00.000Z' }, true)
})
attempt('storage', () => {
  notes.storage = String(world.get('authToken'))
  world.set('authToken', 'stolen')
  world.open('http://attacker.test/', true)
  if (world.get('authToken') !== undefined) escaped('world.get returned a stored value')
})
attempt('raycast', () => explore(world.raycast(new Vector3(), new Vector3(0, -1, 0), 10), 'world.raycast()'))
attempt('host error', () => { try { world.raycast({}, {}) } catch (err) { explore(err, 'error thrown by the engine'); throw err } })
attempt('overlapSphere', () => explore(world.overlapSphere(1, new Vector3()), 'world.overlapSphere()'))
attempt('configure', () => app.configure([{ key: 'k', type: 'text', initial: 'v', onChange() { captured.push(this, arguments) } }]))
attempt('state', () => { app.state = { a: 1, __proto__: { polluted: true } }; app.state.__proto__ = { polluted: true }; explore(app.state, 'app.state') })
attempt('wrapper functions', () => {
  for (const fn of [world.add, app.create, app.on, fetch, setTimeout, console.log, num, uuid, action.add, player.teleport]) {
    explore(fn.bind(null), 'bound'); explore(fn.call, 'call'); explore(Reflect.getPrototypeOf(fn), 'function prototype')
    try { fn.__pwned = 1 } catch {}
    if (fn.__pwned === 1) escaped('a host function object is writable')
  }
})

// ---- 9. console: Bun and Node call a custom-inspect method with the host's inspect and options ----
let inspectCalls = 0
const withInspect = () => ({
  secret: 1,
  [Symbol.for('nodejs.util.inspect.custom')](depth, options, inspect) { inspectCalls++; captured.push(this, options, inspect, arguments); return 'x' },
  get [Symbol.toStringTag]() { inspectCalls++; return 'x' },
})
attempt('console', () => {
  console.log(withInspect(), [withInspect()], { nested: withInspect() })
  console.warn(withInspect()); console.error(withInspect()); console.time(withInspect()); console.timeEnd(withInspect())
  console.log(app, world, player, control, action, app.position)
  if (inspectCalls) escaped('console called a custom inspect or toStringTag hook', inspectCalls)
})

// ---- 10. timers and fetch ----
const timer = attempt('setTimeout', () => setTimeout(function () { captured.push(this, arguments); finish() }, 30))
if (typeof timer !== 'number') escaped('setTimeout returned ' + typeof timer)
explore(timer, 'timer')
attempt('fetch', () => {
  const pending = fetch('http://127.0.0.1:3000/api/agents', { method: 'POST', headers: { get a() { captured.push(this); return 'b' } }, body: 'x' })
  explore(pending, 'fetch()')
  pending.then(async response => {
    notes.fetch = 'resolved ' + response.status
    explore(response, 'response')
    const blob = await response.blob()
    explore(blob, 'blob')
    notes.blob = [blob.size, blob.type, await blob.text()]
    try { Object.getPrototypeOf(blob).__pwned = 1; escaped('blob prototype is writable') } catch {}
    try { blob.size = 0; blob.stream = 1 } catch {}
    explore(await response.arrayBuffer(), 'arrayBuffer'); explore(await response.json().catch(() => null), 'json'); explore(blob.slice(1, 3), 'slice')
    try { notes.objectUrl = URL.createObjectURL(blob) } catch (err) { notes.objectUrl = 'threw ' + err.message }
  }, err => { notes.fetch = 'rejected: ' + err.message; explore(err, 'fetch error') })
})

// ---- 11. world.load resolves to a raw node in the engine ----
attempt('load', () => {
  world.load('model', 'asset://app.glb').then(node => {
    notes.load = node && typeof node.add === 'function' ? 'node' : 'not a usable node: ' + String(node)
    explore(node, 'world.load()')
    app.add(node)
  }, err => { notes.load = 'rejected: ' + err.message })
  world.load('script', 'asset://app.js').then(() => escaped('world.load(script) resolved'), () => {})
  // The agent's loader does request this (the outbound policy is a later phase); the script must not learn why it failed
  world.load('model', 'http://127.0.0.1:9/internal.glb').then(() => { notes.loadFailure = 'resolved' }, err => { notes.loadFailure = err.message })
})

// ---- 12. report ----
let finished = false
function finish() {
  if (finished) return
  finished = true
  setTimeout(() => {
    for (let i = 0; i < captured.length; i++) explore(captured[i], 'captured[' + i + ']')
    // `this` and `arguments` of every callback must hold nothing but the script's own values
    notes.captured = captured.length
    notes.walked = seen.size
    app.send('report', { escapes, notes })
  }, 250)
}
