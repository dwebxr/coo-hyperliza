import 'ses'

import type { UUID } from '@elizaos/core'
import {
  createUniqueUuid,
  type IAgentRuntime,
  Service,
} from '@elizaos/core'
import { PuppeteerManager } from './managers/puppeteer-manager.js'
import { ReconnectController } from './lib/reconnect'
import { PROTOCOL_VERSION } from './lib/world-protocol'
import { takeTipWalletAccount } from './lib/tip-wallet'
import { resolveWorldWsUrl } from './lib/world-url'
import { resolveWorldScriptsMode, surviveUnhandledRejections } from './lib/script-sandbox'
import { activateWorldScripts } from './lib/script-api'
import { describeUrl } from './lib/log-url'
import { currentTurn } from './lib/turn-context'
import { ConnectionSession, sessionOfTurn } from './session/connection-session'
import { type HyperfyDisconnectedPayload, hyperfyEventType } from './events'

type ConnectConfig = { wsUrl: string; authToken?: string; worldId: UUID }

/**
 * Coordinates the agent's connection to a Hyperfy world: starting and stopping, connecting,
 * disconnecting and reconnecting. Everything that belongs to one connection lives in its
 * ConnectionSession (session/connection-session.ts); the accessors here answer from the current
 * session, or null while there is none.
 */
export class HyperfyService extends Service {
  static serviceType = 'hyperfy'
  capabilityDescription = 'Manages connection and interaction with a Hyperfy world.'

  private session: ConnectionSession | null = null
  private lastConnectConfig: ConnectConfig | null = null
  private connectPromise: Promise<void> | null = null
  /** The teardown of the session that was current last, while it runs */
  private teardownPromise: Promise<void> | null = null
  private isStopping: boolean = false
  private reconnectController: ReconnectController
  /** Process-wide: one Chromium for every connection (managers/puppeteer-manager.ts) */
  private puppeteerManager: PuppeteerManager | null = null
  /** HYPERFY_WORLD_SCRIPTS=sandboxed and the sandbox passed its self-test; false means scripts are off */
  private worldScriptsSandboxed: boolean = false

  /** The current connection, from the moment it is being set up until it ends; null otherwise. */
  public getSession(): ConnectionSession | null {
    return this.session
  }

  public get currentWorldId(): UUID | null {
    return this.session?.worldId ?? null
  }

  public getWorld(): any | null {
    return this.session?.world ?? null
  }

  /** Whether the current connection's world is initialised and its managers run. */
  public isConnected(): boolean {
    return this.session?.connected ?? false
  }

  public getPuppeteerManager(): PuppeteerManager | null {
    return this.puppeteerManager
  }

  constructor(protected runtime: IAgentRuntime) {
    super()
    this.reconnectController = new ReconnectController(
      async () => {
        if (!this.lastConnectConfig) return
        console.info(`[Hyperfy Reconnect] Reconnecting to ${describeUrl(this.lastConnectConfig.wsUrl)} (attempt ${this.reconnectController.attemptCount})...`)
        await this.connect(this.lastConnectConfig)
      },
      { onError: (error: any) => console.error(`[Hyperfy Reconnect] Reconnect failed: ${error?.message || error}`) }
    )
    console.info('HyperfyService instance created')
  }

  static async start(runtime: IAgentRuntime): Promise<HyperfyService> {
    console.info('*** Starting Hyperfy service ***')
    // The key leaves the environment again here: the elizaOS server re-reads .env after the
    // project is loaded (see takeTipWalletAccount)
    takeTipWalletAccount()
    const service = new HyperfyService(runtime)
    service.worldScriptsSandboxed = await HyperfyService.prepareWorldScripts()
    let wsUrl: string
    try {
      wsUrl = resolveWorldWsUrl(process.env.WS_URL)
    } catch (error: any) {
      // No connection, and so no retries, until WS_URL is fixed and the agent restarted
      console.error(`[Hyperfy] ${error.message}. Not connecting to any world.`)
      return service
    }
    console.info(`Attempting automatic connection to default Hyperfy URL: ${describeUrl(wsUrl)}`)
    const defaultWorldId = createUniqueUuid(runtime, runtime.agentId + '-default-hyperfy') as UUID

    service
      .connect({ wsUrl, worldId: defaultWorldId })
      .then(() => console.info(`Automatic Hyperfy connection initiated.`))
      .catch(err => {
        console.error(`Automatic Hyperfy connection failed: ${err.message}`)
        service.scheduleReconnect()
      })

    return service
  }

  /**
   * Applies HYPERFY_WORLD_SCRIPTS before any world exists. `sandboxed` locks the whole process
   * down (SES) and self-tests the sandbox; if that fails the process exits, because a realm that
   * is locked down halfway, or locked down and still leaking, must neither run scripts nor carry on.
   */
  private static async prepareWorldScripts(): Promise<boolean> {
    const { mode, problem } = resolveWorldScriptsMode(process.env.HYPERFY_WORLD_SCRIPTS)
    if (problem) console.error(`[Hyperfy] ${problem}`)
    if (mode === 'off') {
      console.info('[Hyperfy] World scripts are off: app scripts sent by the world are not run (HYPERFY_WORLD_SCRIPTS=sandboxed runs them in a sandbox; see README).')
      return false
    }
    if (!(await activateWorldScripts())) {
      console.error('[Hyperfy] HYPERFY_WORLD_SCRIPTS=sandboxed could not be made safe in this runtime. Exiting; set HYPERFY_WORLD_SCRIPTS=off to run without world scripts.')
      process.exit(1)
    }
    // One unhandled rejection in a script would otherwise end the process
    surviveUnhandledRejections()
    console.info('[Hyperfy] World scripts run sandboxed (HYPERFY_WORLD_SCRIPTS=sandboxed). The sandbox does not stop a script from hanging the agent; see README.')
    return true
  }

  static async stop(runtime: IAgentRuntime): Promise<void> {
    console.info('*** Stopping Hyperfy service ***')
    const service = runtime.getService<HyperfyService>(HyperfyService.serviceType)
    if (service) await service.stop()
    else console.warn('Hyperfy service not found during stop.')
  }

  /**
   * Connects to a Hyperfy world. Concurrent calls share the in-flight attempt.
   * Note: the auth token comes from localstorage.json (ClientNetwork ignores initialAuthToken).
   */
  connect(config: ConnectConfig): Promise<void> {
    if (!this.connectPromise) {
      this.connectPromise = this.doConnect(config).finally(() => {
        this.connectPromise = null
      })
    }
    return this.connectPromise
  }

  private scheduleReconnect(): void {
    if (this.isStopping || !this.lastConnectConfig) return
    const delay = this.reconnectController.schedule()
    if (delay !== null) {
      console.info(`[Hyperfy Reconnect] Next attempt in ${Math.round(delay / 1000)}s`)
    }
  }

  private async doConnect(config: ConnectConfig): Promise<void> {
    if (this.teardownPromise) await this.teardownPromise
    if (this.session) {
      console.warn(`HyperfyService already connected to world ${this.currentWorldId}. Disconnecting first.`)
      await this.handleDisconnect()
    }
    if (this.isStopping) throw new Error('HyperfyService is stopping')
    // This attempt supersedes any retry that was waiting to fire
    this.reconnectController.cancelPending()

    console.info(`Attempting to connect HyperfyService to ${describeUrl(config.wsUrl)} for world ${config.worldId}`)
    this.lastConnectConfig = config

    try {
      // Before any world: its loader and its sky hand their assets to the render page
      this.puppeteerManager = PuppeteerManager.getOrCreate()
      const session = ConnectionSession.open(
        this.runtime,
        { wsUrl: config.wsUrl, worldId: config.worldId, sandboxedScripts: this.worldScriptsSandboxed, renderPage: this.puppeteerManager },
        {
          onEstablished: (established) => {
            if (established === this.session) this.reconnectController.markEstablished()
          },
          onDisconnect: (closed, reason, kickCode) => {
            this.onWorldDisconnect(closed, reason, kickCode).catch(error => {
              console.error('[Hyperfy] Error while handling disconnect:', error)
            })
          },
        }
      )
      // Current from here on, so a socket that closes during init ends this session
      this.session = session
      await session.connect(config.authToken)
      console.info(`HyperfyService connected successfully to ${describeUrl(config.wsUrl)}`)
    } catch (error: any) {
      console.error(`HyperfyService connection failed for ${config.worldId} at ${describeUrl(config.wsUrl)}: ${error.message}`, error.stack)
      await this.handleDisconnect()
      throw error
    }
  }

  private async onWorldDisconnect(session: ConnectionSession, reason: any, kickCode: string | null): Promise<void> {
    // Ignore events from a session we already replaced or ended
    if (session !== this.session) return

    // Classify before any await so every retry path (this one, a failed connect, a failed
    // reconnect) sees the policy. A kick sent right before the close is still sitting in the
    // network queue, which is only flushed on the next tick.
    // The close reason also carries 'outdated', in case the kick packet itself was unreadable
    const kick = kickCode ?? findQueuedKick(session.world) ?? (reason?.reason === 'outdated' ? 'outdated' : null)
    if (kick === 'duplicate_user') {
      // The server rejects the newer connection, so retrying never disturbs the other session;
      // it just lets us rejoin once that session leaves.
      console.warn('[Hyperfy Reconnect] Another session is using this auth token. Retrying at the maximum delay.')
      this.reconnectController.deferNextRetry()
    } else if (kick === 'player_limit') {
      console.warn('[Hyperfy Reconnect] World is full. Waiting the maximum delay before retrying.')
      this.reconnectController.deferNextRetry()
    } else if (kick === 'outdated') {
      // Retrying cannot help until the agent is updated; keep it slow
      console.error(
        `[Hyperfy Reconnect] The world requires a newer protocol than this agent speaks (v${PROTOCOL_VERSION}). ` +
        `Update src/plugin-hyperfy/lib/world-protocol.ts to match the world's src/core/packets.js. Retrying at the maximum delay.`
      )
      this.reconnectController.deferNextRetry()
    }

    // ClientNetwork passes the raw CloseEvent
    reason = reason?.code ?? reason
    console.warn(`Hyperfy world disconnected: ${reason}`)
    const disconnected: HyperfyDisconnectedPayload = {
      runtime: this.runtime,
      source: 'hyperfy',
      worldId: session.worldId,
      reason,
    }
    this.runtime.emitEvent(hyperfyEventType.DISCONNECTED, disconnected)
      .catch(error => console.warn(`[Hyperfy] ${hyperfyEventType.DISCONNECTED} handler failed:`, error))

    await this.handleDisconnect()
    this.scheduleReconnect()
  }

  /**
   * Ends the current session. Concurrent calls share one teardown; from the first call on the
   * service has no session (the accessors answer null).
   */
  handleDisconnect(): Promise<void> {
    const session = this.session
    if (session) {
      this.session = null
      // Ended here and now: from this line on none of its turns may act
      const ending = session.end()
      const before = this.teardownPromise
      const teardown: Promise<void> = (async () => {
        await before
        await ending
      })().finally(() => {
        if (this.teardownPromise === teardown) this.teardownPromise = null
      })
      this.teardownPromise = teardown
    }
    return this.teardownPromise ?? Promise.resolve()
  }

  async disconnect(): Promise<void> {
    console.info(`Disconnecting HyperfyService from world ${this.currentWorldId}`)
    // An explicit disconnect should not be undone by a retry that was already waiting
    this.reconnectController.cancelPending()
    await this.handleDisconnect()
    console.info('HyperfyService disconnect complete.')
  }

  async stop(): Promise<void> {
    console.info('*** Stopping Hyperfy service instance ***')
    this.isStopping = true
    this.reconnectController.stop()
    // Ends the session a connect in progress is setting up, so that connect gives up
    await this.handleDisconnect()
    if (this.connectPromise) {
      await this.connectPromise.catch(() => { })
    }
    await this.disconnect()
    await this.puppeteerManager?.close()
  }
}

/** Thrown by requireHyperfy: the plugin's service is not registered with this runtime (yet). */
export class HyperfyUnavailable extends Error {
  constructor() {
    super('The Hyperfy service is not available')
    this.name = 'HyperfyUnavailable'
  }
}

/** The Hyperfy service of `runtime`. Throws HyperfyUnavailable when there is none. */
export function requireHyperfy(runtime: IAgentRuntime): HyperfyService {
  const service = runtime.getService<HyperfyService>(HyperfyService.serviceType)
  if (!service) throw new HyperfyUnavailable()
  return service
}

/**
 * The connection the agent is on now (set up and not ended), or null: also when there is no
 * service. For code that runs outside a turn (providers, an action's validate()).
 */
export function connectedSession(runtime: IAgentRuntime): ConnectionSession | null {
  let service: HyperfyService
  try {
    service = requireHyperfy(runtime)
  } catch (error) {
    if (error instanceof HyperfyUnavailable) return null
    throw error
  }
  const session = service.getSession()
  return session?.connected ? session : null
}

/**
 * The session whose world a provider describes to the model: inside a turn the turn's own (null
 * once it has ended), never a newer connection's; outside any turn the current connection.
 */
export function observedSession(runtime: IAgentRuntime): ConnectionSession | null {
  const turn = currentTurn()
  return turn ? sessionOfTurn(turn) : connectedSession(runtime)
}

/**
 * The session an action acts on. Inside a turn: the turn's own, never whatever connection is
 * current now; throws TurnCancelled when the turn may no longer act, null when its session is
 * gone. Outside any turn (another plugin's message handling): the current connection, or null.
 */
export function actingSession(runtime: IAgentRuntime): ConnectionSession | null {
  const turn = currentTurn()
  if (!turn) return connectedSession(runtime)
  turn.assertLive()
  return sessionOfTurn(turn)
}

export function findQueuedKick(world: any): string | null {
  const queue: any[] = world?.network?.queue ?? []
  const entry = queue.find(item => Array.isArray(item) && item[0] === 'onKick')
  return entry ? entry[1] : null
}
