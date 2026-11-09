import { isDirectlyAddressed } from './addressing';

/**
 * Picks how to take a look from the player's words, without a model call:
 * "look around" → a 360° view, "look at me" → the speaker, a named player or object → that
 * entity, "look left/behind" → that direction, anything else → a 360° view.
 */

export type Direction = 'front' | 'back' | 'left' | 'right';

export type SnapshotChoice =
  | { type: 'LOOK_AROUND' }
  | { type: 'LOOK_DIRECTION'; direction: Direction }
  | { type: 'LOOK_AT_ENTITY'; entityId: string };

export interface NamedEntity {
  id: string;
  name: string;
}

const AROUND = /\b(around|surroundings|nearby|everywhere|scan)\b|周り|まわり|周囲|辺り|あたり|近く|見回/i;
const SELF = /\b(me|my|myself)\b|私|わたし|わたくし|僕|ぼく|俺|おれ|あたし/i;
const DIRECTIONS: [Direction, RegExp][] = [
  ['back', /\bbehind\b|\blook back\b|\bturn around\b|後ろ|うしろ|背後|後方/i],
  ['left', /\bleft\b|左/i],
  ['right', /\b(to|on) (your|the) right\b|\blook right\b|\bright side\b|\bturn right\b|右/i],
  ['front', /\bahead\b|\bin front\b|\bforward\b|前方|正面|目の前/i],
];
const GENERIC_NAMES = new Set(['unnamed', 'anonymous', 'app', 'model']);

export function chooseSnapshot(
  text: string | undefined | null,
  { senderId, entities }: { senderId?: string | null; entities: NamedEntity[] }
): SnapshotChoice {
  const message = text ?? '';
  if (AROUND.test(message)) return { type: 'LOOK_AROUND' };

  // The longest name that appears in the message, so "Blue Fountain" wins over "Fountain"
  const named = entities
    .filter((e) => e.id !== senderId && e.name && e.name.trim().length >= 2 && !GENERIC_NAMES.has(e.name.trim().toLowerCase()))
    .filter((e) => isDirectlyAddressed(message, [e.name]))
    .sort((a, b) => b.name.length - a.name.length)[0];
  if (named) return { type: 'LOOK_AT_ENTITY', entityId: named.id };

  if (senderId && SELF.test(message)) return { type: 'LOOK_AT_ENTITY', entityId: senderId };

  for (const [direction, pattern] of DIRECTIONS) {
    if (pattern.test(message)) return { type: 'LOOK_DIRECTION', direction };
  }
  return { type: 'LOOK_AROUND' };
}
