/**
 * What coo-world's server does with a blueprint and an app a builder adds, before it stores and
 * relays them: its field policies, src/core/extras/blueprintPolicy.js (sanitizeBlueprintAdd) and
 * src/core/extras/entityModifyPolicy.js (sanitizeEntityAdd). Each rule names the line it mirrors.
 * The server refuses an add these turn down (and takes the app back from the sender), and stores
 * what they return: the agent adds and announces that same normalised value, or nothing.
 *
 * Not mirrored: the world-wide budgets the server checks after the field policy (all blueprints
 * together within WORLD_BLUEPRINT_BYTES, and the join snapshot's room: Blueprints.js
 * budgetRefusal, joinBudget.js), which depend on what the server holds; the wire limits are
 * lib/world-protocol.ts outgoingPacketProblem.
 */

/** The result of a policy: the value the server would store, or why it refuses */
export type Sanitized<T> = { ok: true; value: T } | { ok: false; problem: string };

type Json = null | string | number | boolean | Json[] | { [key: string]: Json };

const has = (obj: object, key: string) => Object.prototype.hasOwnProperty.call(obj, key);

/** entityModifyPolicy.js:25 isPlainObject */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// assetURL.js:8 ASSET_NAME, :11 assetName
const ASSET_NAME = /^[A-Za-z0-9._-]{1,128}$/;
function assetName(url: unknown): string | null {
  if (typeof url !== 'string' || !url.startsWith('asset://')) return null;
  const name = url.slice('asset://'.length);
  return ASSET_NAME.test(name) && name !== '.' && name !== '..' ? name : null;
}

/** assetURL.js:119 isHttpURL */
function isHttpURL(value: unknown): boolean {
  if (typeof value !== 'string' || !/^https?:\/\//.test(value)) return false;
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/** assetURL.js:130 isBlueprintURL: what a blueprint's model, script or image may name */
export function isBlueprintURL(value: unknown): boolean {
  return assetName(value) !== null || isHttpURL(value);
}

// chatPolicy.js:7, :13 cutText: at most `max` UTF-16 units, cut between grapheme clusters
const segmenter = typeof Intl?.Segmenter === 'function' ? new Intl.Segmenter() : null;
function cutText(text: string, max: number): string {
  if (text.length <= max) return text;
  if (segmenter) {
    let end = 0;
    for (const { index, segment } of segmenter.segment(text.slice(0, max + 2))) {
      if (index + segment.length > max) break;
      end = index + segment.length;
    }
    if (end > 0) return text.slice(0, end);
  }
  const code = text.charCodeAt(max - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
}

// blueprintPolicy.js:7-12
const TEXT_LIMITS: Record<string, number> = { name: 256, desc: 4096, author: 256, url: 2048, model: 2048, script: 2048 };
const FLAGS = new Set(['preload', 'public', 'locked', 'frozen', 'unique', 'scene', 'disabled']);
const FIELDS = new Set(['id', 'version', ...Object.keys(TEXT_LIMITS), ...FLAGS, 'image', 'props']);
const NULLABLE = new Set([...Object.keys(TEXT_LIMITS), 'image', 'props']);
const REFERENCES = new Set(['model', 'script']);
// blueprintPolicy.js:23 (the limits of walk)
const JSON_MAX_ITEMS = 8192;
const JSON_MAX_DEPTH = 16;

class Refused extends Error {}

/**
 * blueprintPolicy.js:22 walk: a copy of plain JSON values, every value and every object key one
 * item (at most 8,192 in all for a blueprint), nested at most 16 deep (`image` or `props` itself at
 * 1); undefined dropped from objects, null in arrays.
 */
function walk(value: unknown, depth: number, state: { items: number }): Json {
  if (++state.items > JSON_MAX_ITEMS) throw new Refused(`holds more than ${JSON_MAX_ITEMS} values and keys`);
  if (depth > JSON_MAX_DEPTH) throw new Refused(`nests deeper than ${JSON_MAX_DEPTH} levels`);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const array = Array.isArray(value);
  if (!array && !isPlainObject(value)) throw new Refused('holds a value that is not plain JSON');
  if (Object.getOwnPropertySymbols(value).length) throw new Refused('holds a symbol key');
  const result: any = array ? [] : {};
  const keys: Iterable<number | string> = array ? Array.prototype.keys.call(value) : Object.keys(value as object);
  for (const key of keys) {
    let item = (value as any)[key];
    if (item === undefined) {
      if (!array) continue;
      item = null;
    }
    if (!array && ++state.items > JSON_MAX_ITEMS) throw new Refused(`holds more than ${JSON_MAX_ITEMS} values and keys`);
    const copy = walk(item, depth + 1, state);
    if (array) result.push(copy);
    else Object.defineProperty(result, key, { value: copy, enumerable: true, writable: true, configurable: true });
  }
  return result;
}

/**
 * blueprintPolicy.js:46 sanitize (an add, :98 sanitizeBlueprintAdd): the blueprint the server
 * stores, or why it refuses the add. Unknown fields and undefined values go (:56, :63); `id` is a
 * string of 1 to 64 characters (:67), `version` a whole number of 0 or more (:70), the flags
 * booleans (:73); `image` and `props` null or a plain object of plain JSON within walk's limits
 * (:76), an image's `url` an asset or http(s) URL (:79); the text fields null or text, cut to their
 * limits (:84), `model` and `script` an asset or http(s) URL (:88); `id` and `version` present (:91).
 */
export function sanitizeBlueprintAdd(data: unknown): Sanitized<Record<string, unknown>> {
  const refuse = (problem: string): Sanitized<Record<string, unknown>> => ({ ok: false, problem: `the world would refuse the blueprint: ${problem}` });
  if (!isPlainObject(data)) return refuse('it is not a plain object');
  const value: Record<string, unknown> = {};
  const state = { items: 0 };
  for (const key of Object.keys(data)) {
    if (!FIELDS.has(key)) continue;
    const item = data[key];
    if (item === undefined || (item === null && !NULLABLE.has(key))) continue;
    if (key === 'id') {
      if (typeof item !== 'string' || !item.length || item.length > 64) return refuse('its id is not text of 1 to 64 characters');
      value[key] = item;
    } else if (key === 'version') {
      if (!Number.isSafeInteger(item) || (item as number) < 0) return refuse('its version is not a whole number of 0 or more');
      value[key] = item;
    } else if (FLAGS.has(key)) {
      if (typeof item !== 'boolean') return refuse(`its ${key} is not true or false`);
      value[key] = item;
    } else if (key === 'image' || key === 'props') {
      if (item !== null && !isPlainObject(item)) return refuse(`its ${key} is not an object`);
      try {
        value[key] = walk(item, 1, state);
      } catch (error) {
        if (!(error instanceof Refused)) throw error;
        return refuse(`its ${key} ${error.message}`);
      }
      const image = value.image as Record<string, unknown> | null | undefined;
      if (key === 'image' && image && has(image, 'url') && image.url !== null && !isBlueprintURL(image.url)) {
        return refuse('its image names a file that is not an asset or an http(s) URL');
      }
    } else {
      if (item !== null && typeof item !== 'string') return refuse(`its ${key} is not text`);
      value[key] = item === null ? null : cutText(item as string, TEXT_LIMITS[key]);
      if (REFERENCES.has(key) && value[key] !== null && !isBlueprintURL(value[key])) {
        return refuse(`its ${key} names a file that is not an asset or an http(s) URL`);
      }
    }
  }
  if (!has(value, 'id') || !has(value, 'version')) return refuse('it has no id or version');
  return { ok: true, value };
}

// entityModifyPolicy.js:6-10, :290
const TRANSFORM_LIMIT = 1e6;
const QUATERNION_NORM_TOLERANCE = 0.1;
const STATE_MAX_BYTES = 8 * 1024;
const STATE_MAX_DEPTH = 16;
const STATE_MAX_ITEMS = 1024;
const ENTITY_ID = /^[A-Za-z0-9_-]{1,64}$/;
const encoder = new TextEncoder();

/** entityModifyPolicy.js:31 boundedArray */
function boundedArray(value: unknown, length: number, limit: number): number[] | null {
  if (!Array.isArray(value) || value.length !== length) return null;
  const result: number[] = [];
  for (let i = 0; i < length; i++) {
    const v = value[i];
    if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > limit) return null;
    result.push(v);
  }
  return result;
}

/** entityModifyPolicy.js:42 unitQuaternion */
function unitQuaternion(value: unknown): number[] | null {
  const q = boundedArray(value, 4, Infinity);
  if (!q) return null;
  const n = Math.hypot(...q);
  if (!Number.isFinite(n) || Math.abs(n - 1) > QUATERNION_NORM_TOLERANCE) return null;
  return q.map((v) => v / n);
}

/** entityModifyPolicy.js:50 appScale */
function appScale(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const result: number[] = [];
  for (let i = 0; i < 3; i++) {
    const v = value[i];
    if (typeof v !== 'number') return null;
    const f = Math.fround(v);
    if (!Number.isFinite(f) || f === 0) return null;
    result.push(v);
  }
  return result;
}

/** entityModifyPolicy.js:112 isJsonTree */
function isJsonTree(value: unknown, depth: number, state: { items: number; chars: number }): boolean {
  if (value === null) return true;
  switch (typeof value) {
    case 'string':
      state.chars += value.length;
      return state.chars <= STATE_MAX_BYTES;
    case 'number':
      return Number.isFinite(value);
    case 'boolean':
      return true;
    case 'object':
      break;
    default:
      return false;
  }
  if (depth >= STATE_MAX_DEPTH) return false;
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) return false;
    for (let i = 0; i < value.length; i++) {
      if (++state.items > STATE_MAX_ITEMS) return false;
      if (!isJsonTree(value[i], depth + 1, state)) return false;
    }
    return true;
  }
  if (!isPlainObject(value) || Object.getOwnPropertySymbols(value).length) return false;
  for (const key of Object.keys(value)) {
    if (++state.items > STATE_MAX_ITEMS) return false;
    state.chars += key.length;
    if (state.chars > STATE_MAX_BYTES) return false;
    if (!isJsonTree(value[key], depth + 1, state)) return false;
  }
  return true;
}

/** entityModifyPolicy.js:149 isBoundedJsonObject */
function isBoundedJsonObject(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  if (!isJsonTree(value, 0, { items: 0, chars: 0 })) return false;
  try {
    return encoder.encode(JSON.stringify(value)).length <= STATE_MAX_BYTES;
  } catch {
    return false;
  }
}

/**
 * entityModifyPolicy.js:294 sanitizeEntityAdd: the app the server stores, or why it refuses the
 * add. An app (:296) with a fresh id of 1 to 64 letters, digits, `_` or `-` (:299), an existing
 * blueprint (:300), a position within ±1e6, a quaternion of length 1 (±0.1, normalised) and a scale
 * no 32-bit float makes zero or infinite (:301-304); a mover or uploader that is not the sender
 * becomes null, `pinned` true only when it is true, and a state that is not a small JSON object
 * becomes {} (:305-319).
 */
export function sanitizeEntityAdd(
  data: unknown,
  senderId: unknown,
  { blueprintExists, entityExists }: { blueprintExists?: (id: string) => boolean; entityExists?: (id: string) => boolean } = {}
): Sanitized<Record<string, unknown>> {
  const refuse = (problem: string): Sanitized<Record<string, unknown>> => ({ ok: false, problem: `the world would refuse the app: ${problem}` });
  if (!isPlainObject(data)) return refuse('it is not a plain object');
  if (data.type !== 'app') return refuse('it is not an app');
  const { id, blueprint } = data;
  if (typeof id !== 'string' || !ENTITY_ID.test(id)) return refuse('its id is not 1 to 64 letters, digits, _ or -');
  if (entityExists?.(id)) return refuse('its id is taken');
  if (typeof blueprint !== 'string' || (blueprintExists && !blueprintExists(blueprint))) return refuse('its blueprint does not exist');
  const position = boundedArray(data.position, 3, TRANSFORM_LIMIT);
  const quaternion = unitQuaternion(data.quaternion);
  const scale = appScale(data.scale);
  if (!position) return refuse('its position is not three finite numbers within ±1e6');
  if (!quaternion) return refuse('its quaternion is not four finite numbers of length 1 (±0.1)');
  if (!scale) return refuse('its scale is not three numbers, none of them zero');
  const ownOrNull = (value: unknown) => (value === null || value === senderId ? value : null);
  return {
    ok: true,
    value: {
      id,
      type: 'app',
      blueprint,
      position,
      quaternion,
      scale,
      mover: ownOrNull(data.mover),
      uploader: ownOrNull(data.uploader),
      pinned: data.pinned === true,
      state: isBoundedJsonObject(data.state) ? data.state : {},
    },
  };
}
