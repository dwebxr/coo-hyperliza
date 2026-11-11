/*
 * Packets shaped like what real world servers send, for tests. coo-world: src/core/systems/ServerNetwork.js
 * (onConnection snapshot, player entity data, onChatAdded, modifyRank / settingsModified). Upstream
 * Hyperfy: the bundled engine's src/core/systems/ServerNetwork.js (roles instead of rank, no
 * hasAdminCode, chat relayed as the client sent it).
 */

export interface PlayerFixture {
  id: string;
  name: string;
  rank?: number;
  roles?: string[];
}

/** coo-world: id and userId are both the user id; rank is the stored user rank. */
export function cooWorldPlayer({ id, name, rank = 0 }: PlayerFixture) {
  return {
    id,
    type: 'player',
    position: [0, 0, 0],
    quaternion: [0, 0, 0, 1],
    owner: id,
    userId: id,
    name,
    health: 100,
    avatar: 'asset://avatar.vrm',
    sessionAvatar: null,
    rank,
    enteredAt: 1_700_000_000_000,
  };
}

/** The snapshot coo-world sends on connection; `hasAdminCode` is `!!process.env.ADMIN_CODE` there. */
export function cooWorldSnapshot({
  selfId = 'coo-agent',
  // The agent's own account: a builder, as it must be to edit the world
  selfRank = 1,
  worldRank = 0,
  hasAdminCode = true,
  players = [],
  chat = [],
}: { selfId?: string; selfRank?: number; worldRank?: number; hasAdminCode?: boolean; players?: PlayerFixture[]; chat?: unknown[] } = {}) {
  return {
    id: selfId,
    serverTime: 1234.5,
    assetsUrl: 'https://world.test/assets',
    apiUrl: 'https://world.test/api',
    maxUploadSize: '12',
    collections: [],
    settings: {
      desc: null,
      title: 'Test World',
      image: null,
      avatar: null,
      customAvatars: false,
      voice: 'spatial',
      rank: worldRank,
      playerLimit: 0,
      ao: true,
    },
    chat,
    ai: null,
    blueprints: [],
    entities: [cooWorldPlayer({ id: selfId, name: 'Coo', rank: selfRank }), ...players.map(cooWorldPlayer)],
    livekit: null,
    authToken: 'session-token',
    hasAdminCode,
  };
}

/** What coo-world broadcasts for a chat message: rebuilt server-side, sender and time from the socket. */
export function cooWorldChat(id: string, fromId: string, from: string, body: string, createdAt = new Date().toISOString()) {
  return { id, from, fromId, body, createdAt };
}

/** A world notice (tips, server messages): no sender. */
export function worldNotice(id: string, body: string, createdAt = new Date().toISOString()) {
  return { id, body, createdAt };
}

/** Upstream Hyperfy: `roles`, no `rank`, no `hasAdminCode`. */
export function upstreamSnapshot({ selfId = 'coo-agent', players = [] }: { selfId?: string; players?: PlayerFixture[] } = {}) {
  const player = ({ id, name, roles = [] }: PlayerFixture) => ({
    id,
    type: 'player',
    position: [0, 0, 0],
    quaternion: [0, 0, 0, 1],
    owner: id,
    userId: id,
    name,
    health: 100,
    avatar: 'asset://avatar.vrm',
    sessionAvatar: null,
    roles,
  });
  return {
    id: selfId,
    serverTime: 1234.5,
    assetsUrl: 'https://world.test/assets',
    apiUrl: 'https://world.test/api',
    maxUploadSize: '12',
    collections: [],
    settings: { desc: null, title: 'Upstream World', image: null, model: null, avatar: null, public: true, playerLimit: 0 },
    chat: [],
    blueprints: [],
    entities: [player({ id: selfId, name: 'Coo' }), ...players.map(player)],
    livekit: null,
    authToken: 'session-token',
  };
}
