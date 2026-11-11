// A hostile world app script (fixture for lib/script-sandbox.child.test.ts): unhandled rejections
// by every route a script has, each reason carrying a custom-inspect hook. A host listener that
// prints or inspects the reason (as elizaOS's Sentry integration does) would run the hook with the
// runtime's own `inspect`; the hook reports that with app.send('hook'). No 'hook' event is the pass.
//
// Parameters as in the engine's script wrapper: world, app, fetch, props, setTimeout.

const INSPECT = Symbol.for('nodejs.util.inspect.custom')
const hook = (tag) => function (depth, options, inspect) {
  app.send('hook', { tag, inspect: typeof inspect, options: typeof options })
  // The runtime's own inspect defaults, used by every console call of the agent
  try { inspect.defaultOptions = { depth: 0, maxStringLength: 3 } } catch {}
  return 'hooked'
}
const hooked = (tag) => ({ message: 'rejected by a script: ' + tag, [INSPECT]: hook(tag) })

// 1. a rejected promise nobody handles
Promise.reject(hooked('plain'))
// 2. a throw inside an async function of the script's that nobody awaits
;(async () => { throw hooked('async function') })()
// 3. a reason whose stack is an object with the hook (Sentry's handler prints `reason.stack`)
Promise.reject({ get stack() { return hooked('stack getter') } })
// 4. a reason whose getters throw
Promise.reject({
  get message() { throw hooked('message getter') },
  get stack() { throw hooked('stack getter') },
  get name() { throw hooked('name getter') },
  [INSPECT]: hook('throwing getters'),
})
// 5. a Proxy as the reason: every trap passes through to an object with the hook
Promise.reject(new Proxy(hooked('proxy'), {}))
// 6. a function as the reason
const fn = function scriptFunction() {}
fn[INSPECT] = hook('function')
Promise.reject(fn)
// 7. a thenable that rejects
Promise.resolve({ then(_resolve, reject) { reject(hooked('thenable')) } })
// 8. later, from a timer
setTimeout(() => { Promise.reject(hooked('timer')) }, 20)
// 9. a host promise the script never handles: it rejects with an error the membrane made
world.load('model', 'http://127.0.0.1:9/missing.glb')
// 10. an async callback the engine calls: the membrane handles its rejection itself
let once = false
app.on('update', async () => {
  if (once) return
  once = true
  throw hooked('async callback')
})

setTimeout(() => app.send('report', { done: true }), 300)
