// A second hostile world app script (fixture for lib/script-sandbox.child.test.ts). Where
// hostile-app.js walks what the script is given, this one hands the host values whose language
// hooks host code might consult while converting or using them: Symbol.species, then, constructor,
// toPrimitive/valueOf/toString, toJSON, iterators, accessors, Proxy traps, Symbol.hasInstance,
// error accessors and stack hooks, and getters that call back into the host while a copy is made.
// Every hook records what it was handed; afterwards everything recorded is searched for anything
// that only the raw engine has. It also forges node references for every engine member that takes
// one, and checks that the real uses of those members still work. An empty `escapes` is the pass.
//
// Parameters as in the engine's script wrapper: world, app, fetch, props, setTimeout.

const escapes = []
const notes = {}
const escaped = (what, detail) => escapes.push(detail === undefined ? what : what + ': ' + detail)
const attempt = (name, fn) => {
  try {
    const result = fn()
    // Only primitives go into the report: a node would be sent to the world as the engine's proxy
    notes[name] = result === undefined || (result !== null && typeof result === 'object') ? 'ok' : result
    return result
  } catch (err) {
    notes[name] = 'threw ' + (err && err.message)
    return undefined
  }
}

// Everything any hook was handed: [hook name, this, ...arguments]
const handed = []
const own = new Set() // objects this script made, so that a trap handed one of them is fine
const mine = (value) => (own.add(value), value)
const hook = (name, result) =>
  function (...args) {
    handed.push([name, this, ...args])
    return typeof result === 'function' ? result() : result
  }

// ---- what counts as escaped: names only the raw engine or the host has ----
const TROPHIES = [
  'network', 'world', 'ctx', 'entity', 'systems', 'ws', 'loader', 'livekit', 'entities', 'blueprints',
  'stage', 'apps', 'scripts', 'controls', 'env', 'argv', 'mainModule', 'onChatAdded', 'onEvmNonce',
  'onEntityModified', 'authToken', 'enqueue', 'queue', 'ptr', 'appControls', 'isApp',
]
const seen = new Set()
function explore(root, from) {
  const queue = [[root, from]]
  while (queue.length && seen.size < 50000) {
    const [value, path] = queue.pop()
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) continue
    if (seen.has(value)) continue
    seen.add(value)
    for (const name of TROPHIES) {
      let found
      try { found = value[name] } catch {}
      if (found !== undefined) escaped('reached ' + path + '.' + name, typeof found)
    }
    // The engine's app proxy answers `constructor` with the App entity
    try {
      const ctor = value.constructor
      if (!own.has(value) && ctor && typeof ctor === 'object') escaped('constructor of ' + path + ' is an object')
    } catch {}
    let keys = []
    try { keys = Reflect.ownKeys(value) } catch {}
    for (const key of keys) {
      try { queue.push([value[key], path + '.' + String(key)]) } catch {}
    }
  }
}

// ---- 1. promises: Symbol.species, constructor, then ----
// A species constructor chooses the resolve function Promise.prototype.then hands its result to
const speciesHanded = []
function speciesPromise(value) {
  const p = mine(Promise.resolve(value))
  Object.defineProperty(p, 'constructor', {
    value: { [Symbol.species]: function (executor) { executor((v) => { speciesHanded.push(v) }, () => {}); return Promise.resolve() } },
  })
  return p
}
attempt('species: argument', () => { console.log(speciesPromise(app)) })
attempt('species: nested argument', () => { app.send('species-nested', { inner: { p: speciesPromise(app) } }) })
attempt('species: assignment', () => { app.state = { p: speciesPromise(app) } })
attempt('species: world.emit', () => { world.emit('species-event', speciesPromise(app)) })
let speciesCallbacks = 0
app.on('update', () => { if (speciesCallbacks++ === 0) return speciesPromise(app) })
app.on('update', async () => { if (speciesCallbacks++ === 1) return speciesPromise(app) })
// `constructor` itself as a getter: read by species lookup and by Promise.resolve
attempt('species: constructor getter', () => {
  const p = mine(Promise.resolve(app))
  Object.defineProperty(p, 'constructor', { get: hook('constructor getter', () => ({ [Symbol.species]: function (ex) { ex((v) => speciesHanded.push(v), () => {}); return Promise.resolve() } })) })
  console.log(p)
})
// then hooks: an object with then, and a real promise with its own then
attempt('thenable argument', () => { console.log(mine({ then: hook('thenable then') })) })
attempt('promise with own then', () => {
  const p = mine(Promise.resolve(1))
  // Not an assignment: SES keeps Promise.prototype.then from being overridden by one
  Object.defineProperty(p, 'then', { value: hook('own then') })
  console.log(p)
})
app.on('update', () => mine({ then: hook('returned thenable then') }))
// A promise whose then is not callable fulfils with itself: the host must not follow it forever
attempt('then not callable', () => { const p = Promise.resolve(1); Object.defineProperty(p, 'then', { value: 1 }); console.log(p) })
// Shaped like a promise without being one
attempt('promise look-alike', () => { console.log(Object.create(Promise.prototype)) })

// ---- 2. binary data: ArrayBuffer species, typed arrays, DataView ----
let bufferSpeciesAsked = 0
const carrierHandled = []
const carrier = new ArrayBuffer(8)
carrier._isRef = true
Object.defineProperty(carrier, '_ref', { get() { carrierHandled.push('_ref getter'); return mine({ activate(ctx) { carrierHandled.push(ctx) }, children: [], traverse() {}, updateTransform() {} }) } })
carrier.traverse = function () {}
carrier.activate = function (ctx) { carrierHandled.push(ctx) }
const speciesBuffer = () => {
  const b = new ArrayBuffer(8)
  Object.defineProperty(b, 'constructor', { value: { [Symbol.species]: function () { bufferSpeciesAsked++; return carrier } } })
  return b
}
for (const [name, make] of [
  ['ArrayBuffer', () => speciesBuffer()],
  ['Uint8Array', () => new Uint8Array(speciesBuffer(), 2, 4)],
  ['Float64Array', () => new Float64Array(speciesBuffer())],
  ['DataView', () => new DataView(speciesBuffer())],
]) {
  attempt('buffer species: ' + name + ' as argument', () => { console.log(make()) })
  attempt('buffer species: ' + name + ' as data', () => { app.send('buffer-' + name, { bytes: make() }) })
}
attempt('buffer species: app.add', () => { app.add(speciesBuffer()); escaped('app.add accepted a buffer') })
attempt('buffer species: world.add', () => { world.add(speciesBuffer()); escaped('world.add accepted a buffer') })
// TypedArray/Array species on values the host might map or slice
attempt('typed array species', () => {
  class Evil extends Uint8Array { static get [Symbol.species]() { handed.push(['typed array species']); return Uint8Array } }
  console.log(new Evil(4))
  app.send('typed-species', { v: new Evil(4) })
})
attempt('array species', () => {
  class EvilArray extends Array { static get [Symbol.species]() { handed.push(['array species']); return Array } }
  const list = EvilArray.from([1, 2, 3])
  console.log(list)
  app.send('array-species', { list })
  app.state = { list }
})

// ---- 3. RegExp hooks ----
attempt('regexp hooks', () => {
  const re = mine(/x/g)
  for (const symbol of [Symbol.split, Symbol.replace, Symbol.match, Symbol.matchAll, Symbol.search]) {
    Object.defineProperty(re, symbol, { value: hook('regexp ' + String(symbol)), enumerable: true })
  }
  Object.defineProperty(re, 'exec', { value: hook('regexp exec', null), enumerable: true })
  Object.defineProperty(re, 'constructor', { value: { [Symbol.species]: hook('regexp species') } })
  console.log(re)
  app.send('regexp', { re })
  world.chat({ id: 'r', body: re, fromId: 'x', from: 'x', createdAt: '' })
})

// ---- 4. coercion: toPrimitive, valueOf, toString ----
const coercible = () =>
  mine({
    [Symbol.toPrimitive]: hook('toPrimitive', 5),
    valueOf: hook('valueOf', 5),
    toString: hook('toString', 'text'),
  })
attempt('coercion: setTimeout delay', () => { setTimeout(() => {}, coercible()) })
attempt('coercion: timestamp format', () => world.getTimestamp(coercible()))
attempt('coercion: event name', () => { app.send(coercible(), {}) })
attempt('coercion: emit name', () => { app.emit(coercible(), {}) })
attempt('coercion: console', () => { console.log(coercible(), `${'template'}`) })
attempt('coercion: position', () => { app.position.set(coercible(), coercible(), coercible()) })
attempt('coercion: teleport', () => { const p = world.getPlayer(); p.teleport(mine({ toArray: hook('toArray', () => [0, 0, 0]) }), coercible()) })

// ---- 5. toJSON ----
attempt('toJSON', () => {
  app.send('json', { inner: mine({ toJSON: hook('toJSON', 'json') }) })
  app.state = { toJSON: hook('state toJSON', () => ({ count: 1 })) }
})

// ---- 6. iteration protocols ----
attempt('iterators', () => {
  const iterable = mine({ [Symbol.iterator]: hook('iterator', () => [][Symbol.iterator]()), length: 2, 0: 'a', 1: 'b' })
  const list = mine([1, 2])
  Object.defineProperty(list, Symbol.iterator, { value: hook('array iterator', () => [][Symbol.iterator]()) })
  console.log(iterable, list)
  app.send('iterators', { iterable, list })
  world.createLayerMask(...['environment'])
})

// ---- 7. accessors and Proxy traps of the script's own ----
const trapped = []
const trapAll = (target, name) =>
  mine(
    new Proxy(mine(target), {
      get(t, prop, receiver) { trapped.push([name, 'get', t, receiver]); return Reflect.get(t, prop) },
      getOwnPropertyDescriptor(t, prop) { trapped.push([name, 'gopd', t]); return Reflect.getOwnPropertyDescriptor(t, prop) },
      ownKeys(t) { trapped.push([name, 'ownKeys', t]); return Reflect.ownKeys(t) },
      has(t, prop) { trapped.push([name, 'has', t]); return Reflect.has(t, prop) },
      getPrototypeOf(t) { trapped.push([name, 'getPrototypeOf', t]); return Reflect.getPrototypeOf(t) },
      apply(t, thisArg, args) { trapped.push([name, 'apply', t, thisArg, args]); return undefined },
    })
  )
attempt('proxy: argument', () => { console.log(trapAll({ a: 1, nested: { b: 2 } }, 'arg')) })
attempt('proxy: data', () => { app.send('proxy', { p: trapAll({ a: 1 }, 'data') }) })
attempt('proxy: assignment', () => { app.state = trapAll({ a: 1 }, 'state') })
attempt('proxy: array', () => { app.send('proxy-array', trapAll([1, 2, 3], 'array')) })
attempt('proxy: callback', () => { app.on('update', trapAll(function () {}, 'callback')) })
attempt('proxy: promise', () => { console.log(trapAll(Promise.resolve(app), 'promise')) })
attempt('accessors', () => {
  app.send('accessors', mine({ get a() { handed.push(['getter this', this]); return 1 }, set b(v) { handed.push(['setter', this, v]) } }))
})

// ---- 8. Symbol.hasInstance, classes handed to the host ----
attempt('hasInstance', () => {
  class Checker { static [Symbol.hasInstance](value) { handed.push(['hasInstance', this, value]); return true } }
  console.log(Checker)
  app.send('class', { Checker })
  app.state = { Checker }
})

// ---- 9. errors: accessors on what a script throws, and stack hooks on what it catches ----
const thrown = () =>
  mine({
    get name() { handed.push(['error name', this]); return 'TypeError' },
    get message() { handed.push(['error message', this]); return 'thrown by the script' },
    get stack() { handed.push(['error stack', this]); return 'fake stack' },
    get cause() { handed.push(['error cause', this]); return undefined },
    toString: hook('error toString', 'error'),
  })
// The engine's event system catches and logs what a listener throws (an update listener that
// throws would crash the app instead)
attempt('error: thrown by a listener', () => {
  world.on('hooks-throw', () => { throw thrown() })
  app.emit('hooks-throw', {})
})
attempt('error: thrown into the host', () => {
  try { console.log({ get bad() { throw thrown() } }) } catch (err) { notes.reThrown = err && err.message }
})
class ScriptError extends Error { get name() { handed.push(['subclass name', this]); return 'ScriptError' } }
attempt('error subclass', () => { try { console.log({ get bad() { throw new ScriptError('subclass') } }) } catch {} })
const stackHook = hook('prepareStackTrace', 'hooked')
attempt('error: prepareStackTrace', () => {
  try { Error.prepareStackTrace = stackHook } catch {}
  let hostError
  try { world.raycast({}, {}) } catch (err) { hostError = err }
  if (!hostError) return 'not thrown'
  try { hostError.constructor.prepareStackTrace = stackHook } catch {}
  void new Error('after').stack
  void hostError.stack
  if (/\n\s*at /.test(String(hostError.stack))) escaped('a host error has stack frames', String(hostError.stack).slice(0, 200))
  if (hostError.cause !== undefined) escaped('a host error has a cause')
  notes.hostErrorConstructorIsScripts = hostError.constructor === Error
  const capture = {}
  try { Error.captureStackTrace(capture) } catch {}
  notes.captureStackTrace = typeof capture.stack === 'string' ? (capture.stack === '' ? 'empty' : 'has a stack') : 'none'
  return hostError.message
})

// ---- 10. re-entrancy: a getter that calls into the host while its object is being copied ----
attempt('re-entrancy', () => {
  let depth = 0
  const data = mine({
    get first() {
      handed.push(['reentrant getter', this])
      // The inner copy reads this getter again: only once more
      if (depth++ > 0) return 'inner'
      const players = world.getPlayers()
      app.send('reentrant-inner', { players: players.length, again: data })
      data.second = speciesPromise(app)
      return players
    },
    second: 1,
  })
  app.send('reentrant', data)
  app.state = data
})

// ---- 11. receivers: a function as the `this` of a host method ----
for (const [name, receiver] of [['endowed helper', num], ['class', Vector3], ['world API function', world.add], ['own function', function () {}]]) {
  attempt('receiver: ' + name, () => { app.position.set.call(receiver, 1, 2, 3); escaped('a host method ran with a function as this: ' + name) })
}
attempt('receiver: copy', () => { new Vector3().copy.call(num, app.position); escaped('a host method ran with an endowed helper as this') })
attempt('functions round trip', () => { app.state = { f: num, V: Vector3 }; return app.state.f === num && app.state.V === Vector3 })

// ---- 12. forged node references, and the real uses of every member that takes a node ----
const forged = () => ({ _isRef: true, _ref: app })
attempt('forged: app.add', () => { app.add(forged()); escaped('app.add accepted a forged reference') })
attempt('forged: world.add', () => { world.add(forged()); escaped('world.add accepted a forged reference') })
attempt('forged: props', () => { props._isRef = true; props._ref = app; return String(props._isRef) })
const lod = attempt('lod', () => { const node = app.create('lod'); app.add(node); return node })
attempt('forged: lod.insert', () => { lod.insert(forged(), 10); escaped('lod.insert accepted a forged reference') })
attempt('fake node: lod.insert', () => { lod.insert(mine({ activate: hook('lod fake activate'), children: [] }), 10); escaped('lod.insert accepted a fake node') })
attempt('real node: lod.insert', () => { lod.insert(app.create('group'), 10) })
const mesh = attempt('mesh', () => app.create('mesh'))
const collider = attempt('collider', () => app.create('collider'))
attempt('forged: collider.geometry', () => { collider.geometry = forged(); escaped('collider.geometry accepted a forged reference') })
attempt('fake: collider.geometry', () => { collider.geometry = mine({ isBufferGeometry: true, attributes: {} }); escaped('collider.geometry accepted a fake geometry') })
attempt('real: collider.geometry', () => { collider.geometry = mesh.geometry })
// An engine object shaped like a node proxy (an accessor _ref, a traverse method): only identity tells it apart
attempt('lookalike: geometry reference with traverse', () => {
  const reference = mesh.geometry
  reference.traverse = function () {}
  app.add(reference)
  escaped('app.add accepted a geometry reference dressed as a node')
})
const joint = attempt('joint', () => app.create('joint'))
attempt('forged: joint.body0', () => { joint.body0 = forged(); escaped('joint.body0 accepted a forged reference') })
attempt('fake: joint.body1', () => { joint.body1 = mine({ actor: 1 }); escaped('joint.body1 accepted a fake body') })
// A real body passes the guard; the engine then needs the joint mounted (ctx), which it is not here
attempt('real: joint.body0', () => { joint.body0 = app.create('rigidbody') })
const video = attempt('video', () => app.create('video'))
attempt('forged: video.geometry', () => { video.geometry = forged(); escaped('video.geometry accepted a forged reference') })

// ---- report, once every promise job and the update callbacks above have run ----
setTimeout(() => {
  for (const value of speciesHanded) {
    if (value !== undefined) escaped('a species constructor was handed a value', typeof value)
  }
  if (bufferSpeciesAsked) escaped('an ArrayBuffer species constructor was asked for a buffer', bufferSpeciesAsked)
  if (carrierHandled.length) escaped('the host used a buffer of the script as a node', carrierHandled.length)
  for (const [name, what, target, receiver] of trapped) {
    if (!own.has(target)) escaped('a trap of ' + name + ' (' + what + ') was handed a target that is not the script\'s')
    if (receiver !== undefined && !own.has(receiver)) escaped('a trap of ' + name + ' (' + what + ') was handed a receiver that is not the script\'s')
  }
  if (handed.some(([name]) => name === 'prepareStackTrace')) escaped('Error.prepareStackTrace was called')
  if (handed.some(([name]) => /species|hasInstance|iterator|regexp/.test(name))) {
    escaped('a hook the host must never consult was called', handed.filter(([name]) => /species|hasInstance|iterator|regexp/.test(name)).map(([name]) => name).join(','))
  }
  for (let i = 0; i < handed.length; i++) explore(handed[i], 'handed[' + i + '](' + handed[i][0] + ')')
  for (let i = 0; i < trapped.length; i++) explore(trapped[i], 'trapped[' + i + ']')
  notes.handed = [...new Set(handed.map(([name]) => name))].sort()
  notes.trapped = trapped.length
  notes.speciesHanded = speciesHanded.length
  notes.speciesCallbacks = speciesCallbacks
  notes.walked = seen.size
  app.send('report', { escapes, notes })
}, 300)
