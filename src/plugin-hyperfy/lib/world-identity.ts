/**
 * Who is who in the connected world, as far as the world's server says: each player's rank and
 * userId, the world-wide rank and whether the world has an admin code, kept per connection. Fed
 * from the world.network handlers the server's packets are dispatched to (snapshot,
 * settingsModified, entityAdded/Modified/Removed); app scripts using their script API cannot call
 * those, but code with the raw world object could.
 *
 * The bundled engine drops this data: Settings.deserialize keeps no `rank`, onSnapshot ignores
 * `hasAdminCode`, and PlayerRemote.modify applies `roles` but not `rank`. coo-world sends `rank`;
 * an upstream Hyperfy server sends `roles` instead, which are not read here (such worlds also let
 * a client choose its chat sender id), so every player there counts as a visitor.
 */

/** coo-world src/core/extras/ranks.js */
export const Ranks = { VISITOR: 0, BUILDER: 1, ADMIN: 2 } as const;

interface PlayerIdentity {
  rank?: number;
  userId?: string;
}

type Data = Record<string, unknown>;
type Handler = (data: unknown) => unknown;

const isData = (value: unknown): value is Data => !!value && typeof value === 'object' && !Array.isArray(value);
const own = (data: Data, key: string) => Object.prototype.hasOwnProperty.call(data, key);
const rankOf = (value: unknown): number | undefined =>
  value === Ranks.VISITOR || value === Ranks.BUILDER || value === Ranks.ADMIN ? value : undefined;

export class WorldIdentity {
  private settingsRank: number | undefined;
  private hasAdminCode: boolean | undefined;
  private readonly players = new Map<string, PlayerIdentity>();

  /**
   * The rank every player has at least (coo-world Settings.effectiveRank): admin when the world
   * says it has no admin code, otherwise the world's rank setting. An unknown admin-code flag
   * counts as present, and a missing rank as visitor.
   */
  worldRank(): number {
    return this.hasAdminCode === false ? Ranks.ADMIN : (this.settingsRank ?? Ranks.VISITOR);
  }

  /** A present player's effective rank (coo-world getEffectiveRank); undefined for an id not in the world. */
  effectiveRank(playerId: string): number | undefined {
    const player = this.players.get(playerId);
    if (!player) return undefined;
    return Math.max(player.rank ?? Ranks.VISITOR, this.worldRank());
  }

  /** The account id the server gave a present player, if it sent one. */
  userIdOf(playerId: string): string | undefined {
    return this.players.get(playerId)?.userId;
  }

  onSnapshot(data: unknown): void {
    if (!isData(data)) return;
    this.players.clear();
    this.hasAdminCode = typeof data.hasAdminCode === 'boolean' ? data.hasAdminCode : undefined;
    this.settingsRank = isData(data.settings) ? rankOf(data.settings.rank) : undefined;
    if (Array.isArray(data.entities)) for (const entity of data.entities) this.onEntityAdded(entity);
  }

  onSettingsModified(data: unknown): void {
    if (isData(data) && data.key === 'rank') this.settingsRank = rankOf(data.value);
  }

  onEntityAdded(data: unknown): void {
    if (!isData(data) || data.type !== 'player' || typeof data.id !== 'string') return;
    this.players.set(data.id, {
      rank: rankOf(data.rank),
      userId: typeof data.userId === 'string' ? data.userId : undefined,
    });
  }

  onEntityModified(data: unknown): void {
    if (!isData(data) || typeof data.id !== 'string' || !own(data, 'rank')) return;
    const player = this.players.get(data.id);
    if (player) player.rank = rankOf(data.rank);
  }

  onEntityRemoved(id: unknown): void {
    if (typeof id === 'string') this.players.delete(id);
  }
}

const identities = new WeakMap<object, WorldIdentity>();

// Network handler -> the WorldIdentity method fed from it
const FEEDS = {
  onSnapshot: 'onSnapshot',
  onSettingsModified: 'onSettingsModified',
  onEntityAdded: 'onEntityAdded',
  onEntityModified: 'onEntityModified',
  onEntityRemoved: 'onEntityRemoved',
} as const;

/**
 * Starts recording the world's identity data from its network packets. Call before world.init(),
 * on a fresh world: each handler is wrapped so the engine's own (or an earlier wrapper) still runs
 * after it, and later wrappers (lib/tip-wallet.ts) can chain onto these the same way.
 */
export function trackWorldIdentity(world: { network: Record<string, unknown> }): WorldIdentity {
  const identity = new WorldIdentity();
  const network = world.network;
  for (const [handler, feed] of Object.entries(FEEDS) as [keyof typeof FEEDS, (typeof FEEDS)[keyof typeof FEEDS]][]) {
    const previous = network[handler] as Handler | undefined;
    network[handler] = function (this: unknown, data: unknown) {
      identity[feed](data);
      return previous?.call(network, data);
    };
  }
  identities.set(world, identity);
  return identity;
}

/** The identity data recorded for a world, or undefined when it is not tracked. */
export function worldIdentity(world: object): WorldIdentity | undefined {
  return identities.get(world);
}
