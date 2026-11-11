import { createUniqueUuid, type IAgentRuntime } from '@elizaos/core'
import fs from 'fs/promises'
import path from 'path'
import { type AssetUploadError, ensureAsset } from '../lib/asset-upload'
import { describeUrl } from '../lib/log-url'
import { ASSET_LAYOUT } from '../lib/asset-root'

const LOCAL_AVATAR_PATH = path.join(ASSET_LAYOUT.root, 'avatars', 'avatar.vrm')

export const APPEARANCE_POLL_INTERVAL_MS = 30000

type Settled = { outcome: 'applied' | 'gave-up'; error?: string }
type AvatarResult = Settled | { outcome: 'retry'; error?: string }

/** What the appearance of one connection needs of its session. */
export interface AppearanceHost {
  readonly world: any
  /** True once the connection has ended: nothing more is sent or kept for it. */
  readonly ended: boolean
  readonly emotes: { uploadEmotes(): Promise<boolean> }
}

/**
 * The agent's name and avatar on one connection: set once the agent's player exists, retried on a
 * timer while the world is not ready or an upload failed for a reason that may pass. Every result
 * that arrives after the connection ended is dropped.
 */
export class Appearance {
  private interval: NodeJS.Timeout | null = null
  private inFlight = false
  private nameSet = false
  private avatarSet = false
  /** How the avatar ended for this connection; emotes may still be retried after it is settled. */
  private avatarOutcome: Settled | null = null

  constructor(private readonly runtime: IAgentRuntime, private readonly host: AppearanceHost) { }

  /** Whether the poll timer is running. */
  get polling(): boolean {
    return this.interval !== null
  }

  /** Whether the name, the avatar and the emotes are settled for this connection. */
  get settled(): boolean {
    return this.nameSet && this.avatarSet
  }

  start(): void {
    this.stop()
    if (this.host.ended || this.settled) return
    console.info(`[Appearance/Name Polling] Initializing interval every ${APPEARANCE_POLL_INTERVAL_MS}ms.`)
    // An avatar upload can take longer than the interval; don't start a second one.
    const tick = async () => {
      if (this.inFlight) return
      this.inFlight = true
      try {
        await this.poll()
      } catch (error) {
        console.error('[Appearance/Name Polling] Unexpected error:', error)
      } finally {
        this.inFlight = false
      }
    }
    this.interval = setInterval(tick, APPEARANCE_POLL_INTERVAL_MS)
    void tick()
  }

  stop(): void {
    if (!this.interval) return
    clearInterval(this.interval)
    this.interval = null
    console.info('[Appearance Polling] Stopped.')
  }

  private async poll(): Promise<void> {
    if (this.host.ended) return this.stop()
    if (this.settled) {
      this.stop()
      console.info(`[Appearance/Name Polling] Both avatar and name set. Polling stopped.`)
      return
    }

    const world = this.host.world
    const agentPlayer = world?.entities?.player
    const agentPlayerId = agentPlayer?.data?.id
    const networkReady = world?.network?.id != null
    const assetsUrlReady = !!world?.assetsUrl // Needed for avatar
    if (!agentPlayer || !agentPlayerId || !networkReady) {
      console.debug(`[Appearance/Name Polling] Waiting for: Player (${!!agentPlayer}), Player ID (${!!agentPlayerId}), Network (${networkReady})...`)
      return
    }

    const entityId = createUniqueUuid(this.runtime, this.runtime.agentId)
    const entity = await this.runtime.getEntityById(entityId)
    if (this.host.ended) return
    if (entity) {
      entity.metadata.hyperfy = {
        id: agentPlayerId,
        name: agentPlayer?.data?.name,
        userName: agentPlayer?.data?.name,
      }
      await this.runtime.updateEntity(entity)
      if (this.host.ended) return
    }

    if (!this.nameSet) {
      console.info(`[Name Polling] Player (ID: ${agentPlayerId}), network ready. Attempting name...`)
      try {
        this.changeName(this.runtime.character.name)
        this.nameSet = true
        console.info(`[Name Polling] Initial name successfully set to "${this.runtime.character.name}".`)
      } catch (error) {
        console.error(`[Name Polling] Failed to set initial name:`, error)
      }
    }

    if (!this.avatarSet && assetsUrlReady) {
      console.info(`[Appearance Polling] Player (ID: ${agentPlayerId}), network, assetsUrl ready. Attempting avatar upload and set...`)
      const result = await this.uploadCharacterAssets()
      if (this.host.ended) return
      if (result.outcome !== 'retry') {
        this.avatarSet = true
        console.info(
          result.outcome === 'applied'
            ? `[Appearance Polling] Avatar setting process successfully completed.`
            : `[Appearance Polling] Keeping the default avatar for this connection: ${result.error}`
        )
      } else {
        console.warn(`[Appearance Polling] Not done yet: ${result.error || 'Unknown reason'}. Will retry...`)
      }
    } else if (!this.avatarSet) {
      console.debug(`[Appearance Polling] Waiting for: Assets URL (${assetsUrlReady})...`)
    }
  }

  /** Changes the agent's display name in this connection's world. Throws when it cannot be sent. */
  changeName(newName: string): void {
    const world = this.host.world
    if (this.host.ended || !world?.network || !world?.entities?.player) {
      throw new Error('HyperfyService: Cannot change name. Network or player not ready.')
    }
    const agentPlayer = world.entities.player
    const agentPlayerId = agentPlayer.data.id
    if (!agentPlayerId) {
      throw new Error('HyperfyService: Cannot change name. Player ID not available.')
    }
    console.info(`[Action] Attempting to change name to "${newName}" for ID ${agentPlayerId}`)
    try {
      agentPlayer.modify({ name: newName })
      agentPlayer.data.name = newName
      world.network.send('entityModified', { id: agentPlayerId, name: newName })
    } catch (error: any) {
      console.error(`[Action] Error during changeName to "${newName}":`, error)
      throw error
    }
  }

  /**
   * Shows the agent's VRM (uploading it when the world does not have it yet) and prepares its emotes.
   * 'gave-up' when retrying cannot help, e.g. the world only lets builders upload and custom avatars
   * are off: the world's default avatar stays until the next connection. (The engine does not expose
   * the customAvatars setting, so a later change in the world is only noticed on reconnect.)
   * 'retry' also covers emotes that failed for a reason that may pass; the avatar is not redone then.
   */
  async uploadCharacterAssets(): Promise<AvatarResult> {
    const world = this.host.world
    if (!world || !world.entities?.player || !world.network || !world.assetsUrl) {
      console.warn('[Appearance] Cannot set avatar: World, player, network, or assetsUrl not ready.')
      return { outcome: 'retry', error: 'Prerequisites not met' }
    }
    const ended = { outcome: 'retry', error: 'the connection ended' } as const

    if (!this.avatarOutcome) {
      const avatar = await this.applyAvatar()
      if (this.host.ended) return ended
      if (avatar.outcome === 'retry') return avatar
      this.avatarOutcome = avatar
    }

    const emotesReady = await this.host.emotes.uploadEmotes()
    if (this.host.ended) return ended
    if (!emotesReady) return { outcome: 'retry', error: 'some emotes are not available yet' }
    return this.avatarOutcome
  }

  private async applyAvatar(): Promise<AvatarResult> {
    const world = this.host.world
    const localAvatarPath = LOCAL_AVATAR_PATH
    const fileName = path.basename(localAvatarPath)
    let buffer: Buffer
    try {
      buffer = await fs.readFile(localAvatarPath)
    } catch (error: any) {
      console.error(`[Appearance] Cannot read the avatar file at ${localAvatarPath}: ${error.message}`)
      return { outcome: 'gave-up', error: error.message }
    }
    if (this.host.ended) return { outcome: 'retry', error: 'the connection ended' }

    console.info(`[Appearance] Preparing avatar ${fileName} (${(buffer.length / 1024).toFixed(2)} KB)...`)
    const result = await ensureAsset(world, {
      buffer,
      name: fileName,
      type: fileName.endsWith('.vrm') ? 'model/gltf-binary' : 'application/octet-stream',
    })
    if (result.ok === false) {
      const { error } = result
      if (!result.retryable) {
        const hint = (error as AssetUploadError).status === 403
          ? ' A world admin can allow it by turning on custom avatars in the world settings.'
          : ''
        console.warn(`[Appearance] The world refused the avatar upload (${error.message}). Keeping the default avatar for this connection.${hint}`)
        return { outcome: 'gave-up', error: error.message }
      }
      console.error(`[Appearance] Avatar not available yet: ${error.message}`)
      return { outcome: 'retry', error: error.message }
    }
    console.info(`[Appearance] Avatar ${result.uploaded ? 'uploaded' : 'already on the server'}: ${describeUrl(result.url)}`)

    // A destroyed world has no socket to send it on
    if (this.host.ended) return { outcome: 'retry', error: 'the connection ended' }
    const agentPlayer = world.entities.player
    if (typeof agentPlayer?.setSessionAvatar !== 'function') {
      console.warn('[Appearance] agentPlayer.setSessionAvatar not available.')
      return { outcome: 'gave-up', error: 'setSessionAvatar unavailable' }
    }
    // Applies it locally and sends it to the world as this session's avatar
    agentPlayer.setSessionAvatar(result.url)
    return { outcome: 'applied' }
  }
}
