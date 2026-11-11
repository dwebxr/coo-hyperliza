// An ordinary interactive app script (fixture for lib/script-sandbox.child.test.ts): an item the
// agent can use, per-frame updates, a timer, chat, a control, player and node maths. It reports
// what it saw with app.send('report', ...).

const seen = {}
seen.networkId = world.networkId
seen.isClient = world.isClient
seen.props = props.greeting + ':' + props.nested.list.join(',')
seen.config = config === props

const action = app.create('action', { label: 'Sit', distance: 3, duration: 1 })
action.onTrigger = e => { app.send('triggered', { playerId: e.playerId, label: action.label }) }
app.add(action)
seen.children = app.children.length

let frames = 0
app.on('update', delta => {
  frames++
  if (frames === 2) app.send('frames', { delta })
})
setTimeout(() => app.send('timer', { ok: true }), 10)

world.on('chat', msg => app.send('heard', { body: msg.body }))
world.chat({ id: 'c1', body: 'hello from the script', fromId: 'visitor', from: 'Visitor', createdAt: '2026-01-01T00:00:00.000Z' }, true)

const control = app.control()
control.keyX.onPress = () => app.send('keyX', { down: control.keyX.down })
seen.camera = control.camera.position.toArray()

const player = world.getPlayer()
seen.player = [player.id, player.name, player.position.x, player.position.y, player.position.z]
seen.players = world.getPlayers().map(p => p.id)

const v = new Vector3(1, 2, 3).add(new Vector3(1, 1, 1))
seen.vector = [v.x, v.y, v.z, v instanceof Vector3, v.isVector3, v.clone().multiplyScalar(2).x]
seen.distance = +v.distanceTo(player.position).toFixed(3)
app.position.set(4, 5, 6)
app.rotation.y = Math.PI / 2
seen.position = app.position.toArray()
seen.quaternion = app.quaternion.toArray().map(n => +n.toFixed(3))
seen.fromEuler = new Quaternion().setFromEuler(new Euler(0, Math.PI / 2, 0)).toArray().map(n => +n.toFixed(3))
seen.matrix = new Matrix4().compose(app.position, app.quaternion, app.scale).elements.slice(12, 15)
seen.curve = new Curve().add({ time: 0, value: 0 }).add({ time: 1, value: 10 }).evaluate(0.5)
seen.lerp = new LerpVector3(new Vector3(), 1).update(0.5).value.x

app.state.count = 1
app.state.list = [1, 2]
app.state.list.push(3)
seen.state = JSON.stringify(app.state)
seen.helpers = [typeof uuid(), typeof num(0, 10), typeof Date.now(), clamp(5, 0, 1), typeof prng(1)(0, 10), DEG2RAD > 0]
console.log('friendly app ready', seen.player)

app.send('report', seen)
