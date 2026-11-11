import 'ses'

import type { UUID } from '@elizaos/core'
import {
  createUniqueUuid,
  type IAgentRuntime,
  Service,
} from '@elizaos/core'
import fs from 'fs/promises'
import path from 'path'
import { createNodeClientWorld } from './hyperfy/src/core/createNodeClientWorld.js'
import { AgentControls } from './systems/controls'
import { AgentEnvironment } from './systems/environment.js'
import { AgentLoader } from './systems/loader'
import { AgentLiveKit } from './systems/liveKit.js'
import { AgentActions } from './systems/actions.js'
import { loadPhysX } from './physx/loadPhysX.js'
import { BehaviorManager } from "./managers/behavior-manager.js"
import { EmoteManager } from './managers/emote-manager.js'
import { MessageManager, type ChatTurn } from './managers/message-manager.js'
import { VoiceManager } from './managers/voice-manager.js'
import { PuppeteerManager } from './managers/puppeteer-manager.js'
import { BuildManager } from './managers/build-manager.js'
import { getModuleDirectory } from './utils'
import { ReconnectController } from './lib/reconnect'
import { type AssetUploadError, type UploadOptions, ensureAsset, uploadAsset, worldEndpointProblems } from './lib/asset-upload'
import { NetPolicy, installWorldNet } from './lib/net-policy'
import { createScriptNetwork } from './lib/script-network'
import { PROTOCOL_VERSION, adaptToWorldProtocol } from './lib/world-protocol'
import { storage } from './hyperfy/src/core/storage.js'
import { TipWallet, signInHost, takeTipWalletAccount } from './lib/tip-wallet'
import { resolveWorldWsUrl, worldHttpOrigin } from './lib/world-url'
import { installWorldChat, worldChat } from './lib/world-chat'
import { trackWorldIdentity } from './lib/world-identity'
import { describeSceneEditsMode, readSceneEditsMode } from './lib/authorization'
import { resolveWorldScriptsMode, surviveUnhandledRejections } from './lib/script-sandbox'
import { activateWorldScripts, createWorldScripts } from './lib/script-api'
import { destroyWorld } from './lib/world-teardown'
import { describeUrl } from './lib/log-url'
import { type HyperfyDisconnectedPayload, hyperfyEventType } from './events'

const moduleDirPath = getModuleDirectory();
const LOCAL_AVATAR_PATH = `${moduleDirPath}/avatars/avatar.vrm`;

const HYPERFY_APPEARANCE_POLL_INTERVAL = 30000

type AvatarResult = { outcome: 'applied' | 'gave-up'; error?: string } | { outcome: 'retry'; error?: string }
// Teardown must not hang a reconnect on a stuck native/CDP call
const TEARDOWN_STEP_TIMEOUT_MS = 10000
// Chat is handled one message at a time; a handler stuck longer than this (e.g. an action that
// keeps navigating) stops holding up the next message, though it keeps running in the background.
const CHAT_MESSAGE_SLOT_MS = 180000


export class HyperfyService extends Service {
  static serviceType = 'hyperfy'
  capabilityDescription = 'Manages connection and interaction with a Hyperfy world.'

  private world: any | null = null
  private controls: AgentControls | null = null
  private isConnectedState: boolean = false
  private wsUrl: string | null = null
  private _currentWorldId: UUID | null = null
  private processedMsgIds: Set<string> = new Set()

  private playerNamesMap: Map<string, string> = new Map()
  private appearanceIntervalId: NodeJS.Timeout | null = null
  private appearanceSet: boolean = false
  /** How the avatar ended for this connection; emotes may still be retried after it is settled. */
  private avatarOutcome: { outcome: 'applied' | 'gave-up'; error?: string } | null = null
  private nameSet: boolean = false

  private connectionTime: number | null = null
  private appearancePollInFlight: boolean = false
  private lastConnectConfig: { wsUrl: string; authToken?: string; worldId: UUID } | null = null
  private connectPromise: Promise<void> | null = null
  private teardownPromise: Promise<void> | null = null
  private isStopping: boolean = false
  // Bumped by every teardown so an in-flight connect can tell its world was torn down
  private connectionGeneration: number = 0
  private chatQueue: Promise<void> = Promise.resolve()
  private reconnectController: ReconnectController
  private behaviorManager: BehaviorManager;
  private emoteManager: EmoteManager;
  private messageManager: MessageManager;
  private voiceManager: VoiceManager;
  private puppeteerManager: PuppeteerManager;
  private buildManager: BuildManager;
  private tipWallet: TipWallet | null = null;
  /** HYPERFY_WORLD_SCRIPTS=sandboxed and the sandbox passed its self-test; false means scripts are off */
  private worldScriptsSandboxed: boolean = false;

  public get currentWorldId(): UUID | null {
    return this._currentWorldId
  }

  public getWorld(): any | null {
    return this.world;
  }

  /** Bumped by every teardown; a turn records the one it started on. */
  public getConnectionGeneration(): number {
    return this.connectionGeneration;
  }

  constructor(protected runtime: IAgentRuntime) {
    super();
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
  connect(config: { wsUrl: string; authToken?: string; worldId: UUID }): Promise<void> {
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

  private async doConnect(config: { wsUrl: string; authToken?: string; worldId: UUID }): Promise<void> {
    if (this.teardownPromise) await this.teardownPromise
    if (this.isConnectedState || this.world) {
      console.warn(`HyperfyService already connected to world ${this._currentWorldId}. Disconnecting first.`)
      await this.handleDisconnect()
    }
    if (this.isStopping) throw new Error('HyperfyService is stopping')
    // This attempt supersedes any retry that was waiting to fire
    this.reconnectController.cancelPending()

    console.info(`Attempting to connect HyperfyService to ${describeUrl(config.wsUrl)} for world ${config.worldId}`)
    this.lastConnectConfig = config
    this.wsUrl = config.wsUrl
    this._currentWorldId = config.worldId
    this.appearanceSet = false
    this.avatarOutcome = null
    this.nameSet = false

    try {
      const world: any = createNodeClientWorld()
      this.world = world
      const generation = this.connectionGeneration

      // The engine's packet table, encoding and socket URL predate the world's protocol version
      adaptToWorldProtocol(world.network, () => storage.get('authToken'))
      // Ranks and account ids as the world's server reports them (lib/authorization.ts reads them)
      trackWorldIdentity(world)
      // Only chat the server sent becomes a turn; chat.add never broadcasts (lib/world-chat.ts)
      installWorldChat(world)
      const sceneEdits = readSceneEditsMode(process.env)
      if (sceneEdits.problem) console.error(`[Hyperfy] ${sceneEdits.problem}`)
      console.info(describeSceneEditsMode(process.env))

      // Everything this world makes the agent download goes through one policy (lib/net-policy.ts):
      // public https hosts, plus this world's own origin whatever its address
      const net = installWorldNet(world, new NetPolicy({ worldOrigin: worldHttpOrigin(config.wsUrl) }))
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
      // may issue a new one. It is sent to the world's own origin only.
      world.network.upload = (file: File, { check }: UploadOptions = {}) =>
        uploadAsset(world.network, file, { net, authToken: storage.get('authToken'), check })

      // Registered before init so a socket that closes during init is not missed.
      let kickCode: string | null = null
      world.on('kick', (code: string) => {
        kickCode = code
        console.warn(`[Hyperfy] Kicked by server: ${code}`)
      })
      world.on('disconnect', (reason: any) => {
        this.onWorldDisconnect(world, reason, kickCode).catch(error => {
          console.error('[Hyperfy] Error while handling disconnect:', error)
        })
      })
      // Tips: the agent's wallet signs in on every connection (TIP_WALLET_PRIVATE_KEY)
      this.tipWallet = this.createTipWallet(world, config.wsUrl)

      // The local player only spawns after a real session is established.
      world.on('player', () => {
        if (world !== this.world) return
        this.reconnectController.markEstablished()
        this.tipWallet?.begin()
      })

      this.puppeteerManager = PuppeteerManager.getOrCreate(this.runtime);
      this.emoteManager = new EmoteManager(this.runtime);
      this.messageManager = new MessageManager(this.runtime);
      this.voiceManager = new VoiceManager(this.runtime);
      this.behaviorManager = new BehaviorManager(this.runtime);
      this.buildManager = new BuildManager(this.runtime);

      ; (world as any).playerNamesMap = this.playerNamesMap

      globalThis.self = globalThis

      const livekit = new AgentLiveKit(world);
      ; (world as any).livekit = livekit
      world.systems.push(livekit);

      const actions = new AgentActions(world);
      ; (world as any).actions = actions
      world.systems.push(actions);

      this.controls = new AgentControls(world)
        ; (world as any).controls = this.controls
      world.systems.push(this.controls)
      // Temporarily comment out AgentLoader to test for updateTransform error
      // A sandboxed script's fetch() reaches public https hosts only (lib/script-network.ts)
      const loader = new AgentLoader(world, { scripts: this.worldScriptsSandboxed ? createWorldScripts({ network: createScriptNetwork() }) : null })
        ; (world as any).loader = loader
      world.systems.push(loader);

      const environment = new AgentEnvironment(world);
      ; (world as any).environment = environment
      world.systems.push(environment);

      const mockElement = {
        appendChild: () => { },
        removeChild: () => { },
        offsetWidth: 1920,
        offsetHeight: 1080,
        addEventListener: () => { },
        removeEventListener: () => { },
        style: {},
      }

      const hyperfyConfig = {
        wsUrl: this.wsUrl,
        viewport: mockElement,
        ui: mockElement,
        initialAuthToken: config.authToken,
        loadPhysX
      }

      if (typeof this.world.init !== 'function') {
        throw new Error('world.init is not a function')
      }
      await world.init(hyperfyConfig)
      // Everything after this point is synchronous, so one check is enough.
      if (this.world !== world || this.connectionGeneration !== generation) {
        // init may have started the tick loop / socket after teardown destroyed the world
        destroyWorld(world)
        throw new Error('Hyperfy connection closed during initialization')
      }
      console.info('Hyperfy world initialized.')

      this.processedMsgIds.clear()
      if (this.world.chat?.msgs) {
        console.info(`Processing ${this.world.chat.msgs.length} existing chat messages.`)
        this.world.chat.msgs.forEach((msg: any) => {
          if (msg && msg.id) {
            this.processedMsgIds.add(msg.id)
          }
        })
        console.info(`Populated ${this.processedMsgIds.size} processed message IDs from history.`)
      }

      this.voiceManager.start();

      this.behaviorManager.start();

      this.subscribeToHyperfyEvents()

      this.isConnectedState = true

      this.startAppearancePolling()

      this.connectionTime = Date.now(); // Record connection time

      console.info(`HyperfyService connected successfully to ${describeUrl(this.wsUrl)}`)
    } catch (error: any) {
      console.error(`HyperfyService connection failed for ${config.worldId} at ${describeUrl(config.wsUrl)}: ${error.message}`, error.stack)
      await this.handleDisconnect()
      throw error
    }
  }

  private async onWorldDisconnect(world: any, reason: any, kickCode: string | null): Promise<void> {
    // Ignore events from a world we already replaced or tore down
    if (world !== this.world) return

    // Classify before any await so every retry path (this one, a failed connect, a failed
    // reconnect) sees the policy. A kick sent right before the close is still sitting in the
    // network queue, which is only flushed on the next tick.
    // The close reason also carries 'outdated', in case the kick packet itself was unreadable
    const kick = kickCode ?? findQueuedKick(world) ?? (reason?.reason === 'outdated' ? 'outdated' : null)
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
      worldId: this._currentWorldId,
      reason,
    }
    this.runtime.emitEvent(hyperfyEventType.DISCONNECTED, disconnected)
      .catch(error => console.warn(`[Hyperfy] ${hyperfyEventType.DISCONNECTED} handler failed:`, error))

    await this.handleDisconnect()
    this.scheduleReconnect()
  }

  private subscribeToHyperfyEvents(): void {
    if (!this.world || typeof this.world.on !== 'function') {
      console.warn("[Hyperfy Events] Cannot subscribe: World or world.on not available.")
      return
    }

    if (this.world.chat?.subscribe) {
      this.startChatSubscription()
    } else {
      console.warn('[Hyperfy Events] world.chat.subscribe not available.')
    }
  }

  /**
   * Shows the agent's VRM (uploading it when the world does not have it yet) and prepares its emotes.
   * 'gave-up' when retrying cannot help, e.g. the world only lets builders upload and custom avatars
   * are off: the world's default avatar stays until the next connection. (The engine does not expose
   * the customAvatars setting, so a later change in the world is only noticed on reconnect.)
   * 'retry' also covers emotes that failed for a reason that may pass; the avatar is not redone then.
   */
  private async uploadCharacterAssets(): Promise<{ outcome: 'applied' | 'gave-up' | 'retry'; error?: string }> {
    const world = this.world
    const emoteManager = this.emoteManager
    if (!world || !world.entities?.player || !world.network || !world.assetsUrl) {
      console.warn(
        "[Appearance] Cannot set avatar: World, player, network, or assetsUrl not ready."
      );
      return { outcome: 'retry', error: "Prerequisites not met" };
    }
    const replaced = { outcome: 'retry', error: 'the connection was replaced' } as const

    if (!this.avatarOutcome) {
      const avatar = await this.applyAvatar(world);
      if (this.world !== world) return replaced;
      if (avatar.outcome === 'retry') return avatar;
      this.avatarOutcome = avatar;
    }

    const emotesReady = await emoteManager.uploadEmotes();
    if (this.world !== world) return replaced;
    if (!emotesReady) return { outcome: 'retry', error: "some emotes are not available yet" };
    return this.avatarOutcome;
  }

  private async applyAvatar(world: any): Promise<AvatarResult> {
    const localAvatarPath = path.resolve(LOCAL_AVATAR_PATH);
    const fileName = path.basename(localAvatarPath);
    let buffer: Buffer;
    try {
      buffer = await fs.readFile(localAvatarPath);
    } catch (error: any) {
      console.error(
        `[Appearance] Cannot read the avatar file at ${localAvatarPath} (CWD: ${process.cwd()}): ${error.message}`
      );
      return { outcome: 'gave-up', error: error.message };
    }

    console.info(`[Appearance] Preparing avatar ${fileName} (${(buffer.length / 1024).toFixed(2)} KB)...`);
    const result = await ensureAsset(world, {
      buffer,
      name: fileName,
      type: fileName.endsWith(".vrm") ? "model/gltf-binary" : "application/octet-stream",
    });
    if (result.ok === false) {
      const { error } = result;
      if (!result.retryable) {
        const hint = (error as AssetUploadError).status === 403
          ? " A world admin can allow it by turning on custom avatars in the world settings."
          : "";
        console.warn(
          `[Appearance] The world refused the avatar upload (${error.message}). Keeping the default avatar for this connection.${hint}`
        );
        return { outcome: 'gave-up', error: error.message };
      }
      console.error(`[Appearance] Avatar not available yet: ${error.message}`);
      return { outcome: 'retry', error: error.message };
    }
    console.info(`[Appearance] Avatar ${result.uploaded ? "uploaded" : "already on the server"}: ${describeUrl(result.url)}`);

    // A destroyed world has no socket to send it on
    if (this.world !== world) return { outcome: 'retry', error: 'the connection was replaced' };
    const agentPlayer = world.entities.player;
    if (typeof agentPlayer?.setSessionAvatar !== "function") {
      console.warn("[Appearance] agentPlayer.setSessionAvatar not available.");
      return { outcome: 'gave-up', error: "setSessionAvatar unavailable" };
    }
    // Applies it locally and sends it to the world as this session's avatar
    agentPlayer.setSessionAvatar(result.url);
    return { outcome: 'applied' };
  }

  private startAppearancePolling(): void {
    if (this.appearanceIntervalId) clearInterval(this.appearanceIntervalId);
    // Check if both are already set
    let pollingTasks = { avatar: this.appearanceSet, name: this.nameSet }; // Track tasks locally

    if (pollingTasks.avatar && pollingTasks.name) {
      console.info("[Appearance/Name Polling] Already set, skipping start.");
      return;
    }
    console.info(`[Appearance/Name Polling] Initializing interval every ${HYPERFY_APPEARANCE_POLL_INTERVAL}ms.`);


    const poll = async () => {
      // Stop polling if both tasks are complete
      if (pollingTasks.avatar && pollingTasks.name) {
        if (this.appearanceIntervalId) clearInterval(this.appearanceIntervalId);
        this.appearanceIntervalId = null;
        console.info(`[Appearance/Name Polling] Both avatar and name set. Polling stopped.`);
        return;
      }

      // Results that arrive after this connection was replaced must not touch the new one
      const world = this.world;
      const agentPlayer = world?.entities?.player; // Get player once
      const agentPlayerReady = !!agentPlayer;
      const agentPlayerId = agentPlayer?.data?.id;
      const agentPlayerIdReady = !!agentPlayerId;
      const networkReady = this.world?.network?.id != null;
      const assetsUrlReady = !!this.world?.assetsUrl; // Needed for avatar

      // Condition checks player/ID/network readiness for name, adds assetsUrl for avatar
      if (agentPlayerReady && agentPlayerIdReady && networkReady) {
        const entityId = createUniqueUuid(this.runtime, this.runtime.agentId);
        const entity = await this.runtime.getEntityById(entityId)
        if (entity) {
          entity.metadata.hyperfy = {
            id: agentPlayerId,
            name: agentPlayer?.data?.name,
            userName: agentPlayer?.data?.name
          }

          await this.runtime.updateEntity(entity)
        }
        if (this.world !== world) return;

        // --- Set Name (if not already done) ---
        if (!pollingTasks.name) {
          console.info(`[Name Polling] Player (ID: ${agentPlayerId}), network ready. Attempting name...`);
          try {
            await this.changeName(this.runtime.character.name);
            if (this.world !== world) return;
            this.nameSet = true; // Update global state
            pollingTasks.name = true; // Update local task tracker
            console.info(`[Name Polling] Initial name successfully set to "${this.runtime.character.name}".`);
          } catch (error) {
            console.error(`[Name Polling] Failed to set initial name:`, error);
          }
        }

        // --- Set Avatar (if not already done AND assets URL ready) ---
        if (!pollingTasks.avatar && assetsUrlReady) {
          console.info(`[Appearance Polling] Player (ID: ${agentPlayerId}), network, assetsUrl ready. Attempting avatar upload and set...`);
          const result = await this.uploadCharacterAssets();
          if (this.world !== world) return;

          if (result.outcome !== 'retry') {
            this.appearanceSet = true; // Update global state
            pollingTasks.avatar = true; // Update local task tracker
            console.info(
              result.outcome === 'applied'
                ? `[Appearance Polling] Avatar setting process successfully completed.`
                : `[Appearance Polling] Keeping the default avatar for this connection: ${result.error}`
            );
          } else {
            console.warn(`[Appearance Polling] Not done yet: ${result.error || 'Unknown reason'}. Will retry...`);
          }
        } else if (!pollingTasks.avatar) {
          console.debug(`[Appearance Polling] Waiting for: Assets URL (${assetsUrlReady})...`);
        }
      } else {
        // Update waiting log
        console.debug(`[Appearance/Name Polling] Waiting for: Player (${agentPlayerReady}), Player ID (${agentPlayerIdReady}), Network (${networkReady})...`);
      }
    }
    // An avatar upload can take longer than the interval; don't start a second one.
    const f = async () => {
      if (this.appearancePollInFlight) return;
      this.appearancePollInFlight = true;
      try {
        await poll();
      } catch (error) {
        console.error('[Appearance/Name Polling] Unexpected error:', error);
      } finally {
        this.appearancePollInFlight = false;
      }
    }
    this.appearanceIntervalId = setInterval(f, HYPERFY_APPEARANCE_POLL_INTERVAL);
    f();
  }

  private stopAppearancePolling(): void {
    if (this.appearanceIntervalId) {
      clearInterval(this.appearanceIntervalId)
      this.appearanceIntervalId = null
      console.info("[Appearance Polling] Stopped.")
    }
  }

  /**
   * Checks if the service is currently connected to a Hyperfy world.
   */
  public isConnected(): boolean {
    return this.isConnectedState;
  }

  public getEntityById(entityId: string): any | null {
    return this.world?.entities?.items?.get(entityId) || null
  }

  public getEntityName(entityId: string): string | null {
    const entity = this.world?.entities?.items?.get(entityId)
    return entity?.data?.name || entity?.blueprint?.name || 'Unnamed';
  }

  /**
   * Tears down the current world. Concurrent calls share one teardown.
   */
  handleDisconnect(): Promise<void> {
    if (!this.teardownPromise) {
      this.teardownPromise = this.teardown().finally(() => {
        this.teardownPromise = null
      })
    }
    return this.teardownPromise
  }

  private async teardown(): Promise<void> {
    if (!this.isConnectedState && !this.world) return
    console.info('Handling Hyperfy disconnection...')
    this.isConnectedState = false
    this.connectionGeneration++

    this.stopAppearancePolling()
    this.tipWallet?.stop();
    this.tipWallet = null;
    this.behaviorManager?.stop();
    this.voiceManager?.stop();
    this.emoteManager?.stop();
    this.messageManager?.stop();

    if (this.world) {
      try {
        // Navigation loops keep driving the player entity, which outlives Entities.destroy()
        this.controls?.stopAllActions?.('disconnect')
      } catch (e: any) {
        console.warn(`[Hyperfy Cleanup] Error stopping controls: ${e.message}`)
      }
      const leavingRoom = this.world.livekit?.disconnectRoom?.()
      try {
        // Destroy before awaiting anything so the old world stops ticking (and loading assets
        // into the Puppeteer page) while we wait for LiveKit and the page to close.
        console.info("[Hyperfy Cleanup] Destroying the world...")
        // Each system on its own, then the socket and the tick timer, whatever failed before
        destroyWorld(this.world)
      } catch (e: any) {
        console.warn(`[Hyperfy Cleanup] Error during world destroy: ${e.message}`)
      }
      await settleWithin(leavingRoom, TEARDOWN_STEP_TIMEOUT_MS, 'leaving LiveKit room')
      // Drop this session's textures/avatars; the browser itself is reused.
      await settleWithin(this.puppeteerManager?.resetPage(), TEARDOWN_STEP_TIMEOUT_MS, 'resetting Puppeteer page')
    }

    this.world = null
    this.controls = null
    this.playerNamesMap.clear()
    this.wsUrl = null
    this.appearanceSet = false
    this.avatarOutcome = null

    this.processedMsgIds.clear()

    this.connectionTime = null; // Clear connection time

    if (this.appearanceIntervalId) { clearInterval(this.appearanceIntervalId); this.appearanceIntervalId = null; }

    console.info('Hyperfy disconnection handling complete.')
  }

  async disconnect(): Promise<void> {
    console.info(`Disconnecting HyperfyService from world ${this._currentWorldId}`)
    // An explicit disconnect should not be undone by a retry that was already waiting
    this.reconnectController.cancelPending()
    await this.handleDisconnect()
    console.info('HyperfyService disconnect complete.')
  }

  /**
   * Changes the agent's display name.
   */
  async changeName(newName: string): Promise<void> {
    if (!this.isConnected() || !this.world?.network || !this.world?.entities?.player) {
      throw new Error('HyperfyService: Cannot change name. Network or player not ready.');
    }
    const agentPlayerId = this.world.entities.player.data.id;
    if (!agentPlayerId) {
      throw new Error('HyperfyService: Cannot change name. Player ID not available.');
    }

    console.info(`[Action] Attempting to change name to "${newName}" for ID ${agentPlayerId}`);

    try {

      // 2. Update local state immediately
      // Update the name map
      if (this.playerNamesMap.has(agentPlayerId)) {
        console.info(`[Name Map Update] Setting name via changeName for ID ${agentPlayerId}: '${newName}'`);
        this.playerNamesMap.set(agentPlayerId, newName);
      } else {
        console.warn(`[Name Map Update] Attempted changeName for ID ${agentPlayerId} not currently in map. Adding.`);
        this.playerNamesMap.set(agentPlayerId, newName);
      }

      // --- Use agentPlayer.modify for local update --- >
      const agentPlayer = this.world.entities.player;
      agentPlayer.modify({ name: newName });
      agentPlayer.data.name = newName

      this.world.network.send('entityModified', { id: agentPlayer.data.id, name: newName })
      console.debug(`[Action] Called agentPlayer.modify({ name: "${newName}" })`);

    } catch (error: any) {
      console.error(`[Action] Error during changeName to "${newName}":`, error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    console.info('*** Stopping Hyperfy service instance ***')
    this.isStopping = true
    this.reconnectController.stop()
    if (this.connectPromise) {
      await this.connectPromise.catch(() => { })
    }
    await this.disconnect()
    await this.puppeteerManager?.close()
  }

  private startChatSubscription(): void {
    if (!this.world || !this.world.chat) {
      console.error('Cannot subscribe to chat: World or Chat system not available.')
      return
    }

    console.info('[HyperfyService] Initializing chat subscription...')
    const generation = this.connectionGeneration
    this.chatQueue = Promise.resolve()
    // Undefined (not installed) means nothing becomes a turn
    const chat = worldChat(this.world)

    this.world.chat.subscribe((msgs: any[]) => {
      // Wait for player entity (ensures world/chat exist too)
      if (!this.world || !this.world.chat || !this.world.entities?.player || !this.connectionTime) return

      const newMessagesFound: any[] = [] // Temporary list for new messages

      // Step 1: Identify new messages and update processed set
      msgs.forEach((msg: any) => {
        // Only what the world's server sent on this connection: not app scripts' chat (any
        // fromId), not the agent's own posts, not the snapshot's history
        if (!chat?.isLiveFromNetwork(msg)) return

        // Check timestamp FIRST - only consider messages newer than connection time
        const messageTimestamp = msg.createdAt ? new Date(msg.createdAt).getTime() : 0;
        // Also check for NaN (invalid date)
        if (!messageTimestamp || isNaN(messageTimestamp) || messageTimestamp <= this.connectionTime) {
          // Ensure historical messages are marked processed if encountered *before* connectionTime was set (edge case)
          if (msg?.id && !this.processedMsgIds.has(msg.id.toString())) {
            this.processedMsgIds.add(msg.id.toString());
          }
          return; // Skip this message
        }

        // Check if we've already processed this message ID (secondary check for duplicates)
        const msgIdStr = msg.id?.toString();
        if (msgIdStr && !this.processedMsgIds.has(msgIdStr)) {
          newMessagesFound.push(msg) // Add the full message object
          this.processedMsgIds.add(msgIdStr) // Mark ID as processed immediately
        }
      })

      // Step 2: Process only the newly found messages
      if (newMessagesFound.length > 0) {
        console.info(`[Chat] Found ${newMessagesFound.length} new messages to process.`)

        // In arrival order, one at a time. IDs are reserved above, so the listener re-running
        // (e.g. when another message arrives) cannot queue the same message twice.
        for (const msg of newMessagesFound) {
          this.chatQueue = this.chatQueue.then(async () => {
            if (generation !== this.connectionGeneration) return
            if (!this.messageManager) return
            const turn: ChatTurn = { cancelled: false }
            // Logs and swallows failures, so one bad message never breaks the chain
            const settled = await settleWithin(this.messageManager.handleMessage(msg, turn), CHAT_MESSAGE_SLOT_MS, `handling chat message ${msg?.id}`)
            // Whatever the timed-out turn produces later is dropped instead of overlapping the next one
            if (!settled) turn.cancelled = true
          }).catch(error => {
            // Never let one failure stop every later message on this connection
            console.error('[Chat] Unexpected error in the chat queue:', error)
          })
        }
      }
    })
  }

  getEmoteManager() {
    return this.emoteManager;
  }

  getBehaviorManager() {
    return this.behaviorManager;
  }

  getMessageManager() {
    return this.messageManager;
  }

  getVoiceManager() {
    return this.voiceManager;
  }

  getPuppeteerManager() {
    return this.puppeteerManager;
  }

  getBuildManager() {
    return this.buildManager;
  }

  /** The agent's tip wallet on this connection; null when tips are not configured. */
  getTipWallet(): TipWallet | null {
    return this.tipWallet;
  }

  private createTipWallet(world: any, wsUrl: string): TipWallet | null {
    // Read once per process; the environment no longer has the key after the first read
    const account = takeTipWalletAccount()
    if (!account) return null
    const host = signInHost(wsUrl)
    if (!host) {
      console.warn(`[Tips] Cannot tell the world's sign-in domain from ${describeUrl(wsUrl)}; tips stay off`)
      return null
    }
    return new TipWallet(world.network, account, {
      host,
      selfId: () => world.entities?.player?.data?.id,
    })
  }
}

export function findQueuedKick(world: any): string | null {
  const queue: any[] = world?.network?.queue ?? []
  const entry = queue.find(item => Array.isArray(item) && item[0] === 'onKick')
  return entry ? entry[1] : null
}

/** Waits for `promise` (logging, not throwing, its failure) at most `ms`. Returns false on timeout. */
async function settleWithin(promise: Promise<unknown> | undefined, ms: number, label: string): Promise<boolean> {
  if (!promise) return true
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<boolean>(resolve => {
    timer = setTimeout(() => {
      console.warn(`[Hyperfy] Gave up ${label} after ${ms}ms`)
      resolve(false)
    }, ms)
  })
  try {
    return await Promise.race([promise.then(() => true, (e: any) => {
      console.warn(`[Hyperfy] Error ${label}: ${e?.message || e}`)
      return true
    }), timeout])
  } finally {
    clearTimeout(timer)
  }
}
