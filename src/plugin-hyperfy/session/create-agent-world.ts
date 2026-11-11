import { createNodeClientWorld } from '../hyperfy/src/core/createNodeClientWorld.js'
import * as engineStorage from '../hyperfy/src/core/storage.js'
import { AgentControls } from '../systems/controls'
import { AgentEnvironment } from '../systems/environment.js'
import { AgentLoader } from '../systems/loader'
import { AgentLiveKit } from '../systems/liveKit.js'
import { AgentActions } from '../systems/actions.js'
import { loadPhysX } from '../physx/loadPhysX.js'
import { type UploadOptions, uploadAsset, worldEndpointProblems } from '../lib/asset-upload'
import { NetPolicy, installWorldNet } from '../lib/net-policy'
import { createScriptNetwork } from '../lib/script-network'
import { adaptToWorldProtocol } from '../lib/world-protocol'
import { worldHttpOrigin } from '../lib/world-url'
import { installWorldChat } from '../lib/world-chat'
import { trackWorldIdentity } from '../lib/world-identity'
import { describeSceneEditsMode, readSceneEditsMode } from '../lib/authorization'
import { createWorldScripts } from '../lib/script-api'

// The engine's key-value store: localstorage.json next to the engine's own files
const engine = engineStorage as { storage: { get(key: string): string | null } }

/** An engine world as the agent uses it, before it is connected. */
export interface AgentWorld {
  world: any
  controls: AgentControls
  /** The session token the world's server issued on this connection (lib/world-protocol.ts) */
  protocol: { sessionToken(): string | null }
  net: NetPolicy
  /** Opens the socket and starts the engine. Rejects when the engine cannot start. */
  init(authToken?: string): Promise<void>
}

/**
 * Builds the engine world for one connection to `wsUrl`, with everything that stands between the
 * world's server and the agent installed before a single packet is read: the protocol adapter,
 * rank and account tracking, chat provenance, the network policy for downloads and uploads, and the
 * agent's own systems. `sandboxedScripts`: HYPERFY_WORLD_SCRIPTS=sandboxed and the sandbox passed
 * its self-test; otherwise app scripts are never evaluated.
 */
export function createAgentWorld({ wsUrl, sandboxedScripts }: { wsUrl: string; sandboxedScripts: boolean }): AgentWorld {
  const world: any = createNodeClientWorld()

  // The engine's packet table, encoding and socket URL predate the world's protocol version
  const protocol = adaptToWorldProtocol(world.network, () => engine.storage.get('authToken'))
  // Ranks and account ids as the world's server reports them (lib/authorization.ts reads them)
  trackWorldIdentity(world)
  // Only chat the server sent becomes a turn; chat.add never broadcasts (lib/world-chat.ts)
  installWorldChat(world)
  const sceneEdits = readSceneEditsMode(process.env)
  if (sceneEdits.problem) console.error(`[Hyperfy] ${sceneEdits.problem}`)
  console.info(describeSceneEditsMode(process.env))

  // Everything this world makes the agent download goes through one policy (lib/net-policy.ts):
  // public https hosts, plus this world's own origin whatever its address
  const net = installWorldNet(world, new NetPolicy({ worldOrigin: worldHttpOrigin(wsUrl) }))
  console.info(`[Hyperfy] Downloads for this world: public https hosts, and the world's own origin ${net.worldOrigin ?? '(none: WS_URL has no usable origin)'}`)
  const engineOnSnapshot = world.network.onSnapshot
  world.network.onSnapshot = function (this: unknown, data: unknown) {
    const result = engineOnSnapshot.call(world.network, data)
    // The snapshot names the world's API and assets URLs; say so now if the agent will not use them
    for (const problem of worldEndpointProblems(net, { apiUrl: world.network.apiUrl, assetsUrl: world.assetsUrl })) console.warn(`[Hyperfy] ${problem}`)
    return result
  }

  // The engine's upload sends no session token and ignores the response, but the world only
  // accepts uploads from an authenticated session. The token is read per call: the snapshot
  // may issue a new one. It is sent to the world's own origin only, and not at all when it was
  // withheld from the socket (lib/world-protocol.ts): that world's API is not encrypted either.
  world.network.upload = (file: File, { check }: UploadOptions = {}) =>
    uploadAsset(world.network, file, { net, authToken: protocol.sessionToken() ?? undefined, check })

  ;(globalThis as { self?: unknown }).self = globalThis

  const livekit = new AgentLiveKit(world)
  world.livekit = livekit
  world.systems.push(livekit)

  const actions = new AgentActions(world)
  world.actions = actions
  world.systems.push(actions)

  const controls = new AgentControls(world)
  world.controls = controls
  world.systems.push(controls)

  // A sandboxed script's fetch() reaches public https hosts only (lib/script-network.ts)
  const loader = new AgentLoader(world, { scripts: sandboxedScripts ? createWorldScripts({ network: createScriptNetwork() }) : null })
  world.loader = loader
  world.systems.push(loader)

  const environment = new AgentEnvironment(world)
  world.environment = environment
  world.systems.push(environment)

  // What the engine's client systems expect of a page's viewport
  const mockElement = {
    appendChild: () => { },
    removeChild: () => { },
    offsetWidth: 1920,
    offsetHeight: 1080,
    addEventListener: () => { },
    removeEventListener: () => { },
    style: {},
  }

  return {
    world,
    controls,
    protocol,
    net,
    async init(authToken?: string) {
      if (typeof world.init !== 'function') throw new Error('world.init is not a function')
      // The auth token comes from localstorage.json (ClientNetwork ignores initialAuthToken)
      await world.init({ wsUrl, viewport: mockElement, ui: mockElement, initialAuthToken: authToken, loadPhysX })
    },
  }
}
