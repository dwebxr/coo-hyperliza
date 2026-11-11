import fs from 'fs/promises'
import path from 'path'
import { EMOTES_LIST, LOCOMOTION_EMOTES, TALK_EMOTE } from '../constants.js'
import { Emotes } from '../hyperfy/src/core/extras/playerEmotes.js'
import { getModuleDirectory, resolveUrl } from '../utils'
import { AssetUploadError, assetServed, ensureAsset } from '../lib/asset-upload'
import { worldNet } from '../lib/net-policy'
import { describeUrl } from '../lib/log-url'
import { logger } from '@elizaos/core'

// Emotes is shared process-wide and overridden per world below; keep the engine defaults to reset to
const DEFAULT_EMOTES: Record<string, string> = { ...(Emotes as Record<string, string>) };
// Rounds (one per appearance poll) before clips that keep failing are left out for this connection
const MAX_EMOTE_ROUNDS = 5;

/**
 * The world's own locomotion clips, for when the agent cannot use its own and the world does not
 * serve the engine's emote-*.glb (newer Hyperfy worlds such as coo-world ship Hyperfy's mp-* set).
 * ?s= is the playback speed other clients apply. Those worlds tune it for walking at 3 m/s
 * (s=1.5) and running at 6 m/s (s=1.4); the agent's engine moves at 4 and 8, so the clips play
 * proportionally faster to keep the feet in step.
 */
const WORLD_LOCOMOTION_FALLBACKS: Record<string, string> = {
  IDLE: 'asset://mp-idle.glb',
  WALK: 'asset://mp-walk.glb?s=2',
  RUN: 'asset://mp-jog.glb?s=1.87',
};

/** The engine's clip for `name`, if it has one of its own (not something every object inherits). */
function engineEmote(name: string): string | undefined {
  const clip = Object.prototype.hasOwnProperty.call(Emotes, name) ? (Emotes as Record<string, unknown>)[name] : undefined
  return typeof clip === 'string' && clip ? clip : undefined
}

/** What the emotes of one connection need of its session. */
export interface EmoteHost {
  readonly world: any
  /** True once the connection has ended: its world is no longer touched. */
  readonly ended: boolean
}

/**
 * The agent's emotes on one connection: which clips its world serves, and the one playing. The
 * engine's Emotes table is shared by the whole process and overridden per world here; a
 * connection that has ended no longer writes to it.
 */
export class EmoteManager {
  private emoteHashMap: Map<string, string>
  private currentEmoteTimeout: NodeJS.Timeout | null
  private movementCheckInterval: NodeJS.Timeout | null = null;
  private session: EmoteHost;

  constructor(session: EmoteHost) {
    this.session = session;
    this.emoteHashMap = new Map()
    this.currentEmoteTimeout = null
  }

  /** Clips settled for this connection: in use, or unavailable for a reason that will not pass. */
  private settled = new Set<string>()
  private emotesReset = false
  private rounds = 0
  /** Set when the world refuses this session's uploads; the remaining clips are only looked up. */
  private uploadRefusal: string | null = null

  /**
   * Makes the agent's clips available in the current world. false while some clip failed for a
   * reason that may pass (network, server error); calling again retries only those.
   */
  async uploadEmotes(): Promise<boolean> {
    const world = this.session.world;
    if (!world || this.session.ended) return false;
    // Locomotion emotes first: they update the shared Emotes object
    let complete = await this.uploadLocomotionEmotes(world);
    if (!this.isCurrent(world)) return false;

    for (const emote of EMOTES_LIST) {
      if (this.settled.has(emote.name)) continue;
      const result = await this.ensureClip(world, emote, '[Appearance]');
      if (!this.isCurrent(world)) return false;
      if ('fileName' in result) this.emoteHashMap.set(emote.name, result.fileName);
      if ('fileName' in result || !result.retry) this.settled.add(emote.name);
      else complete = false;
    }
    if (complete) return true;

    if (++this.rounds < MAX_EMOTE_ROUNDS) return false;
    // Stop retrying: what is in use stays, the rest keeps its default until the next connection
    for (const emote of [...LOCOMOTION_EMOTES, TALK_EMOTE, ...EMOTES_LIST]) this.settled.add(emote.name);
    console.warn(`[Emote] Some emotes are still not available after ${MAX_EMOTE_ROUNDS} attempts; giving up on them for this connection.`);
    return true;
  }

  /** Whether playEmote(name) has a clip to play in this world (some worlds refuse emote uploads). */
  hasEmote(name: string): boolean {
    return this.emoteHashMap.has(name) || engineEmote(name) !== undefined;
  }

  /**
   * Plays the emote `name` (a model chooses it: any text). A name that is not an emote of this
   * world does nothing; so does a connection that has ended.
   */
  playEmote(name: string) {
    const hashName = this.emoteHashMap.get(name) || engineEmote(name);
    const world = this.session.world;
    if (!world || this.session.ended) {
      console.warn('[Emote] Cannot play emote - world not available');
      return;
    }

    if (!hashName) {
      console.warn(`[Emote] Emote '${name}' not found.`);
      return;
    }

    const agentPlayer = world?.entities?.player;
    if (!agentPlayer) {
      console.warn("[Emote] Player entity not found.");
      return;
    }

    const emoteUrl = hashName.startsWith('asset://') ? hashName : `asset://${hashName}`;
    agentPlayer.data.effect = agentPlayer.data.effect || {};
    agentPlayer.data.effect.emote = emoteUrl;

    console.info(`[Emote] Playing '${name}' → ${describeUrl(emoteUrl)}`);

    this.clearTimers();

    // Get duration from EMOTES_LIST
    const emoteMeta = EMOTES_LIST.find(e => e.name === name);
    const duration = emoteMeta?.duration || 1.5;

    this.movementCheckInterval = setInterval(() => {
      if (agentPlayer.moving) {
        logger.info(`[EmoteManager] '${name}' cancelled early due to movement`);
        this.clearEmote(agentPlayer);
      }
    }, 100);

    this.currentEmoteTimeout = setTimeout(() => {
      if (agentPlayer.data.effect?.emote === emoteUrl) {
        logger.info(`[EmoteManager] '${name}' finished after ${duration}s`);
        this.clearEmote(agentPlayer);
      }
    }, duration * 1000);
  }

  private clearEmote(player: any) {
    if (player.data?.effect) {
      player.data.effect.emote = null;
    }
    this.clearTimers();
  }

  stop() {
    this.clearTimers();
  }

  private clearTimers() {
    if (this.currentEmoteTimeout) {
      clearTimeout(this.currentEmoteTimeout);
      this.currentEmoteTimeout = null;
    }
    if (this.movementCheckInterval) {
      clearInterval(this.movementCheckInterval);
      this.movementCheckInterval = null;
    }
  }

  /** Whether `world` is this connection's and the connection has not ended. */
  private isCurrent(world: any): boolean {
    return !this.session.ended && this.session.world === world;
  }

  /**
   * Whether the world's asset server serves `fileName`, as clients resolve asset:// names.
   * null when that could not be checked (cause already logged).
   */
  private async assetExists(fileName: string, world: any = this.session.world): Promise<boolean | null> {
    const url = await resolveUrl(`asset://${fileName}`, world ?? {});
    if (!url) return null;
    try {
      return await assetServed(url, worldNet(world));
    } catch (error: any) {
      // The network policy does not allow asking this world's assets URL
      console.warn(`[Assets] Could not check ${describeUrl(url)}: ${error?.message || error}`);
      return null;
    }
  }

  /**
   * The hashed name the world serves this clip under, uploading it when the world does not have it
   * yet; otherwise whether it is worth trying again (cause logged).
   */
  private async ensureClip(
    world: any,
    emote: { name: string; path: string },
    tag: string
  ): Promise<{ fileName: string } | { retry: boolean }> {
    if (!world) return { retry: true };
    let buffer: Buffer;
    try {
      buffer = await fs.readFile(getModuleDirectory() + emote.path);
    } catch (err: any) {
      console.error(`${tag} Cannot read emote '${emote.name}': ${err.message}`);
      return { retry: false };
    }
    const result = await ensureAsset(
      world,
      { buffer, name: path.basename(emote.path), type: "model/gltf-binary" },
      { upload: !this.uploadRefusal }
    );
    if (result.ok === true) {
      console.info(`${tag} Emote '${emote.name}' ${result.uploaded ? 'uploaded' : 'already on the server'}: asset://${result.fileName}`);
      return { fileName: result.fileName };
    }

    const { error } = result;
    if (this.uploadRefusal && !result.retryable) {
      console.debug(`${tag} Emote '${emote.name}' is not on the server; skipped`);
    } else if (error instanceof AssetUploadError && (error.status === 401 || error.status === 403)) {
      // Every other clip would be refused the same way
      this.uploadRefusal = error.message;
      console.warn(
        `${tag} The world refused the emote upload (${error.message}); only builders can upload .glb clips. Clips the world already serves are still used; missing ones are skipped until a builder uploads them.`
      );
    } else if (result.retryable) {
      console.warn(`${tag} Emote '${emote.name}' is not available yet: ${error.message}`);
    } else {
      console.error(`${tag} Emote '${emote.name}' is not available: ${error.message}`);
    }
    return { retry: result.retryable };
  }

  private async uploadLocomotionEmotes(world: any = this.session.world): Promise<boolean> {
    if (!this.emotesReset) {
      // Don't carry another world's uploaded hashes into this one
      Object.assign(Emotes as Record<string, string>, DEFAULT_EMOTES);
      this.emotesReset = true;
    }
    let complete = true;
    for (const emote of LOCOMOTION_EMOTES) {
      if (this.settled.has(emote.name)) continue;
      const result = await this.uploadLocomotionEmote(world, emote);
      if (result === 'stale') return false;
      if (result === 'retry') complete = false;
      else this.settled.add(emote.name);
    }
    if (!this.settled.has(TALK_EMOTE.name)) {
      if (await this.ensureTalkEmote(world)) this.settled.add(TALK_EMOTE.name);
      else complete = false;
    }
    return complete && this.isCurrent(world);
  }

  /** Points the shared Emotes entry at the clip once the world serves it; 'kept' leaves the default for good. */
  private async uploadLocomotionEmote(
    world: any,
    emote: { name: string; path: string }
  ): Promise<'ok' | 'kept' | 'retry' | 'stale'> {
    const result = await this.ensureClip(world, emote, '[Locomotion]');
    // Emotes is shared: a world that was replaced meanwhile must not overwrite the new one's entries
    if (!this.isCurrent(world)) return 'stale';
    if ('fileName' in result) {
      (Emotes as Record<string, string>)[emote.name] = `asset://${result.fileName}`;
      return 'ok';
    }
    const fallback = await this.useWorldFallback(world, emote.name);
    if (!this.isCurrent(world)) return 'stale';
    const retry = result.retry || fallback === 'unknown';
    console.info(`[Locomotion] Keeping ${(Emotes as Record<string, string>)[emote.name]} for '${emote.name}'${retry ? ' for now' : ''}`);
    return retry ? 'retry' : 'kept';
  }

  /**
   * Without the agent's own clip: the engine default if the world serves it, else the world's own
   * clip. 'unknown' when a lookup failed, so a later round checks again.
   */
  private async useWorldFallback(world: any, name: string): Promise<'done' | 'unknown'> {
    const fallback = WORLD_LOCOMOTION_FALLBACKS[name];
    if (!fallback) return 'done';
    const fileOf = (url: string) => url.replace('asset://', '').split('?')[0];
    const current = (Emotes as Record<string, string>)[name];
    const currentServed = await this.assetExists(fileOf(current), world);
    if (currentServed !== false) return currentServed === true ? 'done' : 'unknown';
    const fallbackServed = await this.assetExists(fileOf(fallback), world);
    if (fallbackServed === null) return 'unknown';
    if (fallbackServed === false) {
      console.warn(`[Locomotion] The world serves neither ${current} nor ${fallback}; '${name}' will not animate for other players.`);
      return 'done';
    }
    if (!this.isCurrent(world)) return 'done';
    (Emotes as Record<string, string>)[name] = fallback;
    console.info(`[Locomotion] The world does not serve ${current}; using its own ${fallback} for '${name}'`);
    return 'done';
  }

  /**
   * Speaking shows Emotes.TALK. A clip at public/emotes/emote-talk.glb takes precedence;
   * otherwise the world's own emote-talk.glb is used, with a warning if it has none.
   * false when the bundled clip should be tried again.
   */
  private async ensureTalkEmote(world: any = this.session.world): Promise<boolean> {
    const bundled = getModuleDirectory() + TALK_EMOTE.path;
    const hasBundled = await fs.access(bundled).then(() => true, () => false);
    if (hasBundled) {
      const result = await this.uploadLocomotionEmote(world, TALK_EMOTE);
      if (result === 'ok') return true;
      if (result === 'retry' || result === 'stale') return false;
    }

    if ((await this.assetExists("emote-talk.glb", world)) === false) {
      logger.warn(
        `[Emote] The world does not serve emote-talk.glb, so no talking gesture is shown while speaking. Put a clip at public/emotes/emote-talk.glb to upload one.`
      );
    }
    return true;
  }
}
