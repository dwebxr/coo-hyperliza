import { type IAgentRuntime, type UUID, createUniqueUuid } from '@elizaos/core'
import { BehaviorManager } from '../managers/behavior-manager'
import { BuildManager } from '../managers/build-manager'
import { EmoteManager } from '../managers/emote-manager'
import { MessageManager } from '../managers/message-manager'
import { VoiceManager } from '../managers/voice-manager'
import type { CaptureView } from '../managers/puppeteer-manager'
import { ChatIntake } from '../lib/chat-intake'
import { isDirectlyAddressed, parseAliases } from '../lib/addressing'
import { matchSimpleCommand } from '../lib/simple-commands'
import { ignoredAsMuted, namesAgent } from '../lib/room-state'
import { countOtherPlayers } from '../utils'
import type { UploadOptions } from '../lib/asset-upload'
import { describeUrl } from '../lib/log-url'
import { ScopedLock } from '../lib/scoped-lock'
import { TipWallet, signInHost, takeTipWalletAccount } from '../lib/tip-wallet'
import { TurnCancelled, type TurnContext, type TurnOrigin, currentTurn, runTurn } from '../lib/turn-context'
import { worldChat } from '../lib/world-chat'
import { destroyWorld } from '../lib/world-teardown'
import { Appearance } from './appearance'
import { type AgentWorld, createAgentWorld } from './create-agent-world'

// Teardown must not hang a reconnect on a stuck native/CDP call
const TEARDOWN_STEP_TIMEOUT_MS = 10000

/**
 * The part of the render page manager (process-wide, managers/puppeteer-manager.ts) a session
 * uses: pictures of its world, and giving the page back when the session ends.
 */
export interface SessionRenderPage {
  capture(world: any, view: CaptureView, options?: { signal?: AbortSignal }): Promise<string>
  resetPage(): Promise<void>
}

export interface SessionParts {
  runtime: IAgentRuntime
  /** The engine world of this connection (session/create-agent-world.ts) */
  world: any
  /** The service's id for the world (an elizaOS UUID, not the engine's) */
  worldId: UUID
  wsUrl: string
  tipWallet?: TipWallet | null
  renderPage?: SessionRenderPage | null
}

/** What the session tells whoever opened it (the service). */
export interface SessionEvents {
  /** The agent's player spawned: a real session with the world is established. */
  onEstablished?(session: ConnectionSession): void
  /**
   * The world's socket closed, or the agent cannot join the world it reached (its snapshot could
   * not be read, or none came: see SNAPSHOT_DEADLINE_MS). `kickCode`: the kick the server sent
   * before it, if it was read.
   */
  onDisconnect?(session: ConnectionSession, reason: unknown, kickCode: string | null): void
}

/**
 * How long a connection may go without the agent's player spawning (the snapshot read and applied)
 * before it is given up as one the agent cannot join: a snapshot of the largest frame comes in
 * well within this over any usable link.
 */
export const SNAPSHOT_DEADLINE_MS = 60_000

let lastGeneration = 0
const sessions = new WeakMap<object, ConnectionSession>()

/**
 * One connection to a world, and everything that exists only for it: the engine world, the
 * managers that keep state about it, the conversation queue, its timers and subscriptions, and
 * the signal that fires when it ends. A session is ended exactly once (a disconnect, a kick, a new
 * connection replacing it, the service stopping); from that moment its signal has fired, so every
 * turn that started on it may no longer act, and nothing of it runs on: no timer, no listener, no
 * navigation, no queued message (a speech request already sent to its provider is not aborted;
 * its result is dropped).
 *
 * What a session does not own is process-wide and outlives it: the Chromium render page
 * (managers/puppeteer-manager.ts; the session gives its page back when it ends), the usage budget,
 * the tip wallet's key, and the engine's shared emote table.
 */
export class ConnectionSession {
  /** Unique per session in this process; a turn records the one it started on. */
  readonly generation = ++lastGeneration
  readonly runtime: IAgentRuntime
  readonly world: any
  readonly worldId: UUID
  readonly wsUrl: string

  // Per session: each keeps state about this world and this connection's players
  readonly emotes: EmoteManager
  readonly messages: MessageManager
  readonly voice: VoiceManager
  readonly behavior: BehaviorManager
  readonly build: BuildManager
  readonly appearance: Appearance
  /** The agent's tip wallet on this connection; null when tips are not configured. */
  readonly tipWallet: TipWallet | null
  /** Chat messages and voice transcripts as turns, one at a time (lib/chat-intake.ts) */
  readonly conversation: ChatIntake
  /**
   * The avatar and the scene, for one section at a time: a walk somewhere, one scene edit (which
   * walks to its target first), a look (which turns or walks before the picture is taken). They
   * share this one lock because each of them moves the one avatar, and an edit or a look needs it
   * to stay where it was put until the effect is done. See withBody.
   */
  readonly body = new ScopedLock()

  /** Process-wide; null when there is no render page (tests) */
  readonly renderPage: SessionRenderPage | null
  private readonly abort = new AbortController()
  private readonly subscriptions: Array<() => void> = []
  private ending: Promise<void> | null = null
  /**
   * Stop commands, by the queued message itself: taken on arrival, claimed by their turn, or
   * dropped by the queue before their turn ('discarded': no longer live, nothing acts for it)
   */
  private readonly stops = new WeakMap<object, 'stopped' | 'claimed' | 'discarded'>()
  private started = false
  /** The agent's player spawned on this connection: the world's snapshot was read and applied */
  private established = false
  private events: SessionEvents = {}
  /** cannotJoin has given this connection up */
  private joinRefused = false
  private snapshotTimer: NodeJS.Timeout | null = null
  private init: ((authToken?: string) => Promise<void>) | null = null

  constructor({ runtime, world, worldId, wsUrl, tipWallet = null, renderPage = null }: SessionParts) {
    this.runtime = runtime
    this.world = world
    this.worldId = worldId
    this.wsUrl = wsUrl
    this.tipWallet = tipWallet
    this.renderPage = renderPage
    this.emotes = new EmoteManager(this)
    this.messages = new MessageManager(runtime, this)
    this.voice = new VoiceManager(runtime, this)
    this.behavior = new BehaviorManager(runtime, this)
    this.build = new BuildManager()
    this.appearance = new Appearance(runtime, this)
    // Stops with the session (its signal): what waits is dropped and the turn in progress is cancelled
    this.conversation = new ChatIntake({
      signal: this.signal,
      admitted: (msg) => this.stopOnArrival(msg),
      discarded: (msg) => this.stops.set(msg, 'discarded'),
      handle: async (msg, turn) => {
        // Before the agent's own player exists there is nobody to answer as
        if (!this.world.entities?.player) return
        await this.messages.handleMessage(msg, turn)
      },
    })
    sessions.set(world, this)
  }

  /**
   * Builds the world for a connection to `wsUrl` and the session around it. Nothing is connected
   * yet: see connect().
   */
  static open(
    runtime: IAgentRuntime,
    config: { wsUrl: string; worldId: UUID; sandboxedScripts: boolean; renderPage?: SessionRenderPage | null },
    events: SessionEvents = {}
  ): ConnectionSession {
    const agentWorld = createAgentWorld({ wsUrl: config.wsUrl, sandboxedScripts: config.sandboxedScripts })
    const session = new ConnectionSession({
      runtime,
      world: agentWorld.world,
      worldId: config.worldId,
      wsUrl: config.wsUrl,
      // Tips: the agent's wallet signs in on every connection (TIP_WALLET_PRIVATE_KEY)
      tipWallet: createTipWallet(agentWorld.world, config.wsUrl),
      renderPage: config.renderPage,
    })
    session.watch(agentWorld, events)
    return session
  }

  /** Registered before the world is initialised, so a socket that closes during init is not missed. */
  private watch(agentWorld: AgentWorld, events: SessionEvents): void {
    const world = this.world
    this.init = agentWorld.init
    this.events = events
    agentWorld.protocol.onUnreadableBeforeSnapshot?.((why) => this.cannotJoin(`its snapshot could not be read (${why})`))
    // Nothing is uploaded to the world for a connection that has ended, whoever asks (the avatar
    // and emotes of this session, a scene edit): checked before each request of an upload
    const upload: (file: File, options?: UploadOptions) => Promise<unknown> = world.network.upload
    world.network.upload = (file: File, options: UploadOptions = {}) =>
      upload(file, {
        ...options,
        check: () => {
          if (this.ended) throw new TurnCancelled('the connection ended')
          options.check?.()
        },
      })
    let kickCode: string | null = null
    this.listen(world, 'kick', (code: string) => {
      kickCode = code
      console.warn(`[Hyperfy] Kicked by server: ${code}`)
    })
    this.listen(world, 'disconnect', (reason: unknown) => {
      if (this.ended) return
      events.onDisconnect?.(this, reason, kickCode)
    })
    // The local player only spawns after a real session is established.
    this.listen(world, 'player', () => {
      if (this.ended) return
      this.established = true
      this.clearSnapshotTimer()
      events.onEstablished?.(this)
      this.tipWallet?.begin()
    })
  }

  /**
   * Gives up a connection whose world the agent cannot join (said once, at error level, with why),
   * as the service gives up one whose socket closed: it is ended and tried again with the usual
   * backoff (service.ts). Nothing after the player spawned counts here.
   */
  private cannotJoin(why: string): void {
    if (this.ended || this.established || this.joinRefused) return
    this.joinRefused = true
    this.clearSnapshotTimer()
    console.error(`[Hyperfy] Cannot join this world: ${why}. Leaving the connection; the agent tries again with the usual backoff.`)
    this.events.onDisconnect?.(this, `the agent could not join: ${why}`, null)
  }

  private clearSnapshotTimer(): void {
    if (this.snapshotTimer) clearTimeout(this.snapshotTimer)
    this.snapshotTimer = null
  }

  /** `listener` on `emitter` until the session ends. */
  private listen(emitter: { on(name: string, listener: (...args: any[]) => void): unknown; off(name: string, listener: (...args: any[]) => void): unknown }, name: string, listener: (...args: any[]) => void): void {
    emitter.on(name, listener)
    this.subscriptions.push(() => emitter.off(name, listener))
  }

  /** Fires when the session ends. */
  get signal(): AbortSignal {
    return this.abort.signal
  }

  /** True from the moment the session is ended. */
  get ended(): boolean {
    return this.abort.signal.aborted
  }

  /**
   * Whether the agent is in the world: it is initialised, its snapshot was read and the agent's
   * player spawned, the managers run, and the session has not ended.
   */
  get connected(): boolean {
    return this.started && this.established && !this.ended
  }

  /**
   * Opens the socket, starts the engine, then the managers. Rejects when the engine cannot start
   * or the session was ended meanwhile (the caller ends it in both cases).
   */
  async connect(authToken?: string): Promise<void> {
    if (!this.init) throw new Error('this session has no world to initialise')
    await this.init(authToken)
    if (this.ended) {
      // init may have started the tick loop / socket after the end destroyed the world
      destroyWorld(this.world)
      throw new Error('Hyperfy connection closed during initialization')
    }
    console.info('Hyperfy world initialized.')
    if (!this.established && !this.joinRefused) {
      this.snapshotTimer = setTimeout(() => this.cannotJoin(`no snapshot was read within ${SNAPSHOT_DEADLINE_MS / 1000} s`), SNAPSHOT_DEADLINE_MS)
      this.snapshotTimer.unref?.()
    }
    this.start()
  }

  /** Starts what runs for the whole connection. The world is initialised. */
  start(): void {
    if (this.ended || this.started) return
    this.started = true
    this.voice.start()
    this.behavior.start()
    this.subscribeToChat()
    this.appearance.start()
  }

  private subscribeToChat(): void {
    // Undefined (not installed) means nothing becomes a turn
    const chat = worldChat(this.world)
    if (!chat) {
      console.error('Cannot subscribe to chat: World or its chat is not available.')
      return
    }
    console.info('[HyperfyService] Initializing chat subscription...')
    // A message of the snapshot's history that the world sends again live is not a new turn
    this.subscriptions.push(chat.onHistory((ids) => this.conversation.markSeen(ids)))
    // Only what the world's server sent on this connection: not app scripts' chat (any fromId),
    // not the agent's own posts, not the snapshot's history (lib/world-chat.ts)
    this.subscriptions.push(chat.onLive((msg) => void this.conversation.accept(msg)))
  }

  /**
   * "Stop" does not wait its turn: an admitted chat message or transcript (lib/chat-intake.ts
   * admitted) that the message handler would take as a stop command addressed to the agent
   * (lib/simple-commands.ts matchSimpleCommand; addressed by name, or the only other player present,
   * as handlers/messageReceivedHandler.ts decides; not ignored as in a MUTED room,
   * lib/room-state.ts) stops walking, following and wandering at once, as the stop command does
   * (controls.stopAllActions). When the room state has to be read first, that is awaited here, not
   * behind the turn queue. Its turn comes later as usual and only acknowledges it (claimStop): the
   * mark is on the queued message itself, for as long as it exists.
   */
  private stopOnArrival(msg: { id: string; body: string; fromId: string | null }): void {
    if (this.ended || !msg.fromId || msg.fromId === this.world.entities?.player?.data?.id) return
    const names = [this.runtime.character.name, ...parseAliases(process.env.HYPERFY_AGENT_ALIASES)]
    if (matchSimpleCommand(msg.body, names) !== 'stop') return
    if (!isDirectlyAddressed(msg.body, names) && countOtherPlayers(this.world) !== 1) return
    if (typeof this.world.controls?.stopAllActions !== 'function') return
    // Naming the agent answers a muted room too: no room state to read
    if (namesAgent(this.runtime, msg.body)) return this.takeStop(msg)
    const roomId = createUniqueUuid(this.runtime, this.worldId || 'hyperfy-unknown-world')
    ignoredAsMuted(this.runtime, roomId, msg.body).then(
      (ignored) => {
        if (!ignored) this.takeStop(msg)
      },
      (error: unknown) => console.warn(`[Hyperfy] Could not read the room state for a stop on arrival; its turn handles it: ${error instanceof Error ? error.message : String(error)}`)
    )
  }

  /**
   * Stops on arrival of `msg`, unless the session ended, the message's own turn has begun meanwhile
   * (claimStop), or the queue dropped the message (it gets no turn: a later walk is not its to stop).
   */
  private takeStop(msg: object): void {
    if (this.ended || this.stops.has(msg)) return
    this.world.controls.stopAllActions('asked to stop')
    this.stops.set(msg, 'stopped')
    console.info('[Hyperfy] Stopped on arrival of a stop command; its turn will acknowledge it')
  }

  /**
   * Called once by the turn of `msg` as it begins: whether its stop already took effect on arrival
   * (the turn then only acknowledges it). From here, a room-state read still pending for it stops
   * nothing: the turn decides.
   */
  claimStop(msg: object): boolean {
    const taken = this.stops.get(msg) === 'stopped'
    this.stops.set(msg, 'claimed')
    return taken
  }

  /** Runs `fn` as a turn of this session (lib/turn-context.ts). `cancel`: the turn's slot in the conversation queue. */
  runTurn<T>({ origin, requesterId, cancel }: { origin: TurnOrigin; requesterId?: string; cancel?: AbortSignal }, fn: () => Promise<T>): Promise<T> {
    return runTurn({ origin, requesterId, world: this.world, generation: this.generation, signal: this.signal, cancel }, fn)
  }

  /**
   * Throws TurnCancelled once this session has ended, or when the caller runs in a turn that may
   * no longer act. Called after every await and right before each effect on the world.
   */
  assertLive(): void {
    if (this.ended) throw new TurnCancelled('the connection ended')
    currentTurn()?.assertLive()
  }

  /** What the caller's effects stop with: its turn's signal, or outside a turn the session's. */
  get actingSignal(): AbortSignal {
    return currentTurn()?.signal ?? this.signal
  }

  /**
   * Runs `section` with the avatar to itself (see `body`), once the sections that asked before it
   * are done. While it waits, the caller's turn being cancelled ends the wait (TurnCancelled); once
   * it runs it is checked like everything else, by assertLive after each await. `section` gets the
   * signal to hand to what it starts. Stopping (HYPERFY_STOP_MOVING, "stop") does not go through
   * here: it takes effect at once and ends the walk of whoever holds the lock.
   */
  withBody<T>(section: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const signal = this.actingSignal
    return this.body.run(signal, async () => {
      this.assertLive()
      return section(signal)
    })
  }

  /**
   * Ends the session: its signal fires (cancelling its turns), everything it runs stops, its world
   * is destroyed and its render page given back. Safe to call any number of times and at any
   * moment, also while connect() is in progress; every call resolves when the one teardown is done.
   */
  end(reason = 'disconnected'): Promise<void> {
    this.ending ??= this.teardown(reason)
    return this.ending
  }

  private async teardown(reason: string): Promise<void> {
    console.info('Handling Hyperfy disconnection...')
    // First, and synchronously: from here on no turn of this session acts (the conversation queue
    // stops and navigation started by a turn in progress stops through the same signal)
    this.abort.abort(new TurnCancelled(`the connection it started on ended (${reason})`))
    this.clearSnapshotTimer()
    for (const unsubscribe of this.subscriptions.splice(0)) {
      try {
        unsubscribe()
      } catch (e: any) {
        console.warn(`[Hyperfy Cleanup] Error removing a listener: ${e.message}`)
      }
    }
    this.appearance.stop()
    this.tipWallet?.stop()
    this.behavior.stop()
    this.voice.stop()
    this.emotes.stop()

    const world = this.world
    try {
      // Navigation loops keep driving the player entity, which outlives Entities.destroy()
      world.controls?.stopAllActions?.('disconnect')
    } catch (e: any) {
      console.warn(`[Hyperfy Cleanup] Error stopping controls: ${e.message}`)
    }
    const leavingRoom = world.livekit?.disconnectRoom?.()
    try {
      // Destroy before awaiting anything so the old world stops ticking (and loading assets
      // into the Puppeteer page) while we wait for LiveKit and the page to close.
      console.info('[Hyperfy Cleanup] Destroying the world...')
      // Each system on its own, then the socket and the tick timer, whatever failed before
      destroyWorld(world)
    } catch (e: any) {
      console.warn(`[Hyperfy Cleanup] Error during world destroy: ${e.message}`)
    }
    await settleWithin(leavingRoom, TEARDOWN_STEP_TIMEOUT_MS, 'leaving LiveKit room')
    // Drop this session's textures/avatars; the browser itself is reused.
    await settleWithin(this.renderPage?.resetPage(), TEARDOWN_STEP_TIMEOUT_MS, 'resetting Puppeteer page')
    console.info('Hyperfy disconnection handling complete.')
  }
}

/** The live session `turn` started on, or null: it ended, or the turn belongs to no session. */
export function sessionOfTurn(turn: TurnContext): ConnectionSession | null {
  const session = sessions.get(turn.world)
  // The same world object under another session is another connection
  return session && session.generation === turn.generation && !session.ended ? session : null
}

function createTipWallet(world: any, wsUrl: string): TipWallet | null {
  // Read once per process; every call also deletes the variable from the environment again (lib/tip-wallet.ts)
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
