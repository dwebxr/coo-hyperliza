import 'ses'

import type { UUID } from '@elizaos/core'
import {
  createUniqueUuid,
  EventType,
  type IAgentRuntime,
  Service,
} from '@elizaos/core'
import crypto from 'crypto'
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
import { MessageManager } from './managers/message-manager.js'
import { VoiceManager } from './managers/voice-manager.js'
import { PuppeteerManager } from './managers/puppeteer-manager.js'
import { BuildManager } from './managers/build-manager.js'
import { hashFileBuffer, getModuleDirectory } from './utils'
import { ReconnectController } from './lib/reconnect'

const moduleDirPath = getModuleDirectory();
const LOCAL_AVATAR_PATH = `${moduleDirPath}/avatars/avatar.vrm`;

const HYPERFY_WS_URL = process.env.WS_URL || 'wss://chill.hyperfy.xyz/ws'
const HYPERFY_APPEARANCE_POLL_INTERVAL = 30000
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

  public get currentWorldId(): UUID | null {
    return this._currentWorldId
  }

  public getWorld(): any | null {
    return this.world;
  }

  constructor(protected runtime: IAgentRuntime) {
    super();
    this.reconnectController = new ReconnectController(
      async () => {
        if (!this.lastConnectConfig) return
        console.info(`[Hyperfy Reconnect] Reconnecting to ${this.lastConnectConfig.wsUrl} (attempt ${this.reconnectController.attemptCount})...`)
        await this.connect(this.lastConnectConfig)
      },
      { onError: (error: any) => console.error(`[Hyperfy Reconnect] Reconnect failed: ${error?.message || error}`) }
    )
    console.info('HyperfyService instance created')
  }

  static async start(runtime: IAgentRuntime): Promise<HyperfyService> {
    console.info('*** Starting Hyperfy service ***')
    const service = new HyperfyService(runtime)
    console.info(`Attempting automatic connection to default Hyperfy URL: ${HYPERFY_WS_URL}`)
    const defaultWorldId = createUniqueUuid(runtime, runtime.agentId + '-default-hyperfy') as UUID

    service
      .connect({ wsUrl: HYPERFY_WS_URL, worldId: defaultWorldId })
      .then(() => console.info(`Automatic Hyperfy connection initiated.`))
      .catch(err => {
        console.error(`Automatic Hyperfy connection failed: ${err.message}`)
        service.scheduleReconnect()
      })

    return service
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

    console.info(`Attempting to connect HyperfyService to ${config.wsUrl} for world ${config.worldId}`)
    this.lastConnectConfig = config
    this.wsUrl = config.wsUrl
    this._currentWorldId = config.worldId
    this.appearanceSet = false
    this.nameSet = false

    try {
      const world: any = createNodeClientWorld()
      this.world = world
      const generation = this.connectionGeneration

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
      // The local player only spawns after a real session is established.
      world.on('player', () => {
        if (world === this.world) this.reconnectController.markEstablished()
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
      const loader = new AgentLoader(world)
        ; (world as any).loader = loader
      world.systems.push(loader);

      const environment = new AgentEnvironment(world);
      ; (world as any).environment = environment
      world.systems.push(environment);

      // HACK: Overwriting `chat.add` to prevent crashes caused by the original implementation.
      // This ensures safe handling of chat messages and avoids unexpected errors from undefined fields.
      (world as any).chat.add = (msg, broadcast) => {
        const chat = (world as any).chat;
        const MAX_MSGS = 50;

        chat.msgs = [...chat.msgs, msg]

        if (chat.msgs.length > MAX_MSGS) {
          chat.msgs.shift()
        }
        for (const callback of chat.listeners) {
          callback(chat.msgs)
        }

        // emit chat event
        const readOnly = Object.freeze({ ...msg })
        world.events.emit('chat', readOnly)
        // maybe broadcast
        if (broadcast) {
          world.network.send('chatAdded', msg)
        }
      };

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
        world.destroy()
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

      console.info(`HyperfyService connected successfully to ${this.wsUrl}`)
    } catch (error: any) {
      console.error(`HyperfyService connection failed for ${config.worldId} at ${config.wsUrl}: ${error.message}`, error.stack)
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
    const kick = kickCode ?? findQueuedKick(world)
    if (kick === 'duplicate_user') {
      // The server rejects the newer connection, so retrying never disturbs the other session;
      // it just lets us rejoin once that session leaves.
      console.warn('[Hyperfy Reconnect] Another session is using this auth token. Retrying at the maximum delay.')
      this.reconnectController.deferNextRetry()
    } else if (kick === 'player_limit') {
      console.warn('[Hyperfy Reconnect] World is full. Waiting the maximum delay before retrying.')
      this.reconnectController.deferNextRetry()
    }

    // ClientNetwork passes the raw CloseEvent
    reason = reason?.code ?? reason
    console.warn(`Hyperfy world disconnected: ${reason}`)
    this.runtime.emitEvent(EventType.WORLD_LEFT, {
      runtime: this.runtime,
      eventName: 'HYPERFY_DISCONNECTED',
      data: { worldId: this._currentWorldId, reason: reason },
    }).catch(error => console.warn('[Hyperfy] WORLD_LEFT handler failed:', error))

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
   * Uploads the character's avatar model and associated emote animations,
   * sets the avatar URL locally, updates emote hash mappings,
   * and notifies the server of the new avatar.
   * 
   * This function handles all assets required for character expression and animation.
   */
  private async uploadCharacterAssets(): Promise<{
    success: boolean;
    error?: string;
  }> {
    if (
      !this.world ||
      !this.world.entities?.player ||
      !this.world.network ||
      !this.world.assetsUrl
    ) {
      console.warn(
        "[Appearance] Cannot set avatar: World, player, network, or assetsUrl not ready."
      );
      return { success: false, error: "Prerequisites not met" };
    }

    const agentPlayer = this.world.entities.player;
    const localAvatarPath = path.resolve(LOCAL_AVATAR_PATH);
    let fileName = "";

    try {
      console.info(`[Appearance] Reading avatar file from: ${localAvatarPath}`);
      const fileBuffer: Buffer = await fs.readFile(localAvatarPath);
      fileName = path.basename(localAvatarPath);
      const mimeType = fileName.endsWith(".vrm")
        ? "model/gltf-binary"
        : "application/octet-stream";

      console.info(
        `[Appearance] Uploading ${fileName} (${(fileBuffer.length / 1024).toFixed(2)} KB, Type: ${mimeType})...`
      );

      if (!crypto.subtle || typeof crypto.subtle.digest !== "function") {
        throw new Error(
          "crypto.subtle.digest is not available. Ensure Node.js version supports Web Crypto API."
        );
      }

      const hash = await hashFileBuffer(fileBuffer);
      const ext = fileName.split(".").pop()?.toLowerCase() || "vrm";
      const fullFileNameWithHash = `${hash}.${ext}`;
      const baseUrl = this.world.assetsUrl.replace(/\/$/, "");
      const constructedHttpUrl = `${baseUrl}/${fullFileNameWithHash}`;

      if (typeof this.world.network.upload !== "function") {
        console.warn(
          "[Appearance] world.network.upload function not found. Cannot upload."
        );
        return { success: false, error: "Upload function unavailable" };
      }

      try {
        console.info(
          `[Appearance] Uploading avatar to ${constructedHttpUrl}...`
        );
        const fileForUpload = new File([fileBuffer], fileName, {
          type: mimeType,
        });

        const uploadPromise = this.world.network.upload(fileForUpload);
        const timeoutPromise = new Promise((_resolve, reject) =>
          setTimeout(() => reject(new Error("Upload timed out")), 30000)
        );

        await Promise.race([uploadPromise, timeoutPromise]);
        console.info(`[Appearance] Avatar uploaded successfully.`);
      } catch (uploadError: any) {
        console.error(
          `[Appearance] Avatar upload failed: ${uploadError.message}`,
          uploadError.stack
        );
        return {
          success: false,
          error: `Upload failed: ${uploadError.message}`,
        };
      }

      // Apply avatar locally
      if (agentPlayer && typeof agentPlayer.setSessionAvatar === "function") {
        agentPlayer.setSessionAvatar(constructedHttpUrl);
      } else {
        console.warn(
          "[Appearance] agentPlayer.setSessionAvatar not available."
        );
      }

      // Upload emotes
      await this.emoteManager.uploadEmotes();

      // Notify server
      if (typeof this.world.network.send === "function") {
        this.world.network.send("playerSessionAvatar", {
          avatar: constructedHttpUrl,
        });
        console.info(
          `[Appearance] Sent playerSessionAvatar with: ${constructedHttpUrl}`
        );
      } else {
        console.error(
          "[Appearance] Upload succeeded but world.network.send is not available."
        );
      }

      return { success: true };
    } catch (error: any) {
      if (error.code === "ENOENT") {
        console.error(
          `[Appearance] Avatar file not found at ${localAvatarPath}. CWD: ${process.cwd()}`
        );
      } else {
        console.error(
          "[Appearance] Unexpected error during avatar process:",
          error.message,
          error.stack
        );
      }
      return { success: false, error: error.message };
    }
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

      const agentPlayer = this.world?.entities?.player; // Get player once
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

        // --- Set Name (if not already done) ---
        if (!pollingTasks.name) {
          console.info(`[Name Polling] Player (ID: ${agentPlayerId}), network ready. Attempting name...`);
          try {
            await this.changeName(this.runtime.character.name);
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

          if (result.success) {
            this.appearanceSet = true; // Update global state
            pollingTasks.avatar = true; // Update local task tracker
            console.info(`[Appearance Polling] Avatar setting process successfully completed.`);
          } else {
            console.warn(`[Appearance Polling] Avatar setting process failed: ${result.error || 'Unknown reason'}. Will retry...`);
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
    this.behaviorManager?.stop();
    this.voiceManager?.stop();
    this.emoteManager?.stop();

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
        console.info("[Hyperfy Cleanup] Calling world.destroy()...")
        this.world.destroy()
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

    this.world.chat.subscribe((msgs: any[]) => {
      // Wait for player entity (ensures world/chat exist too)
      if (!this.world || !this.world.chat || !this.world.entities?.player || !this.connectionTime) return

      const newMessagesFound: any[] = [] // Temporary list for new messages

      // Step 1: Identify new messages and update processed set
      msgs.forEach((msg: any) => {
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
        // (e.g. when Coo posts its reply) cannot queue the same message twice.
        for (const msg of newMessagesFound) {
          this.chatQueue = this.chatQueue.then(async () => {
            if (generation !== this.connectionGeneration) return
            // Logs and swallows failures, so one bad message never breaks the chain
            await settleWithin(this.messageManager.handleMessage(msg), CHAT_MESSAGE_SLOT_MS, `handling chat message ${msg?.id}`)
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
}

export function findQueuedKick(world: any): string | null {
  const queue: any[] = world?.network?.queue ?? []
  const entry = queue.find(item => Array.isArray(item) && item[0] === 'onKick')
  return entry ? entry[1] : null
}

async function settleWithin(promise: Promise<unknown> | undefined, ms: number, label: string): Promise<void> {
  if (!promise) return
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<void>(resolve => {
    timer = setTimeout(() => {
      console.warn(`[Hyperfy] Gave up ${label} after ${ms}ms`)
      resolve()
    }, ms)
  })
  try {
    await Promise.race([promise.then(() => { }, (e: any) => {
      console.warn(`[Hyperfy] Error ${label}: ${e?.message || e}`)
    }), timeout])
  } finally {
    clearTimeout(timer)
  }
}
