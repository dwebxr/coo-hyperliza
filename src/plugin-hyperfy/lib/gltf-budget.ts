/**
 * An admission filter for models (GLB or glTF JSON) before they reach the render page: strict
 * checks of the container and the structure, simple charges for the allocations that are cheap to
 * cause and easy to tell from the file, and plain ceilings on counts. Where the page's loader or
 * exporter (node_modules/page-three/examples/jsm/{loaders/GLTFLoader,exporters/GLTFExporter}.js,
 * three 0.132.2) does something intricate, the feature is refused or its count capped instead of
 * modelled. This is not the limit on what the page may use: that is the run-time watchdog on the
 * page (lib/render-watchdog.ts), which kills Chromium when it uses too much memory or time. This
 * filter keeps the known cheap amplifiers from getting that far.
 *
 * Checked against: the 23 bundled models (an avatar exported by UniGLTF with 32 sparse
 * accessors, the base environment and the emotes; tested in gltf-budget.test.ts), and the owner's
 * world assets (25 inspected: Blender 4.4 exports with required EXT_texture_webp, and a Blender VRM
 * export), all of which pass. Refused on purpose, though valid glTF: triangle strips and fans,
 * animation data in interleaved views, primitives that share attributes but declare different
 * morph targets, legacy animation.parameters, and compression the page has no decoder for (Draco;
 * meshopt and BasisU when required). How often other exporters write these is not known here.
 *
 * Checked before parsing: a GLB is read the way the page's loader reads it (magic "glTF", version
 * 2, a declared length equal to the file's, chunks within bounds and multiples of 4 bytes, one JSON
 * chunk first, at most one BIN chunk after it, nothing else); the JSON's nesting depth and its size
 * in UTF-8 bytes without data: URIs (MODEL_LIMITS.jsonDepth, .jsonBytes) by one linear scan.
 *
 * Checked after parsing: asset.version 2.x; the references between buffers, buffer views,
 * accessors (sparse indices and values included), images, samplers, textures (also those a
 * material names where glTF or a supported extension defines one: MATERIAL_TEXTURES), materials,
 * meshes, nodes, skins, cameras, lights, scenes and animations name something that exists (extras
 * and other extensions are not read as references); buffer views lie within their buffers, and
 * accessors and their sparse parts within their views (byteStride included); the node graph is a
 * forest; primitives the loader would share one geometry for (same indices, attributes and mode)
 * declare the same morph targets (compared by content, not by the order of their members).
 *
 * Charged, each named allocation at most the download cap (`singleBytes`), all of them together at
 * most `totalBytes`:
 *   - the BIN chunk, copied once; a data: URI buffer at each of its decoding steps (its text, the
 *     URI-decoded text, for base64 the decoded text, the bytes);
 *   - every buffer view by its byteLength, overlapping ones each in full (each is copied);
 *   - every accessor, count × components × component size, plus its sparse indices and values;
 *   - each embedded image's bytes once per image and sampler a texture uses it with;
 *   - per animation channel, an input or output that is not float, as Float32, once per track;
 *   - per mesh, its primitives' morph POSITION and NORMAL twice (the exporter clones, then writes);
 *   - per skinned mesh instance, joints × 64 bytes three times (bone matrices, the exporter's
 *     inverse matrices, their written copy);
 *   - every accessor a primitive uses, once more (the exporter's written copy).
 * The export itself (written accessors, morphs and skins, plus the JSON) is estimated too and must
 * fit `exportBytes`: buffers of that whole size exist while the page assembles it, so the
 * single-allocation ceiling applies to source arrays, not to the assembled file.
 *
 * Capped (MODEL_LIMITS): every collection's length; mesh instances the scenes expand to; animation
 * tracks generated; the work of walking the node tree, binding skins and fanning out "weights"
 * tracks; and the size of extras and unknown-extension payloads times the copies made of them.
 *
 * Not charged: image decoding (a small image can declare huge dimensions), what the VRM plugin
 * builds from its own extensions, the re-encoding of textures that stay on an exported avatar, and
 * three.js objects per node or mesh beyond the caps above. The watchdog is what bounds those.
 */
import { MAX_EMOTE_BYTES, MAX_MODEL_BYTES } from './net-policy';

/**
 * Where a material names a texture (a textureInfo with an index): the core material, its
 * pbrMetallicRoughness, and the material extensions the page's loaders read (three's GLTFLoader:
 * KHR_materials_*; three-vrm: VRMC_materials_mtoon). KHR_texture_transform sits inside a
 * textureInfo and names no texture itself.
 */
const MATERIAL_TEXTURES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['', ['normalTexture', 'occlusionTexture', 'emissiveTexture']],
  ['pbrMetallicRoughness', ['baseColorTexture', 'metallicRoughnessTexture']],
  ['KHR_materials_clearcoat', ['clearcoatTexture', 'clearcoatRoughnessTexture', 'clearcoatNormalTexture']],
  ['KHR_materials_transmission', ['transmissionTexture']],
  ['KHR_materials_volume', ['thicknessTexture']],
  ['KHR_materials_specular', ['specularTexture', 'specularColorTexture']],
  ['KHR_materials_pbrSpecularGlossiness', ['diffuseTexture', 'specularGlossinessTexture']],
  ['VRMC_materials_mtoon', ['shadeMultiplyTexture', 'shadingShiftTexture', 'matcapTexture', 'rimMultiplyTexture', 'outlineWidthMultiplyTexture', 'uvAnimationMaskTexture']],
];

export type ModelKind = 'model' | 'avatar' | 'emote';

export interface ModelBudget {
  /** One charged allocation */
  singleBytes: number;
  /** All charged allocations together */
  totalBytes: number;
  /** What the render page hands back (assets.js refuses to return more), and the export estimate */
  exportBytes: number;
}

export function modelBudget(kind: ModelKind): ModelBudget {
  const cap = kind === 'emote' ? MAX_EMOTE_BYTES : MAX_MODEL_BYTES;
  return { singleBytes: cap, totalBytes: 8 * cap, exportBytes: 4 * cap };
}

const MiB = 1024 * 1024;

/** How many of each a model may have, and how much its structure may expand to. */
export const MODEL_LIMITS = Object.freeze({
  /** The JSON without its data: URIs (the bundled files have at most 62 KB) */
  jsonBytes: 16 * MiB,
  /** Nesting of arrays and objects in the JSON (the bundled files have at most 8) */
  jsonDepth: 64,
  buffers: 1024,
  bufferViews: 65_536,
  accessors: 65_536,
  meshes: 16_384,
  primitives: 65_536,
  morphTargets: 65_536,
  nodes: 65_536,
  scenes: 64,
  skins: 4096,
  joints: 262_144,
  animations: 4096,
  channels: 262_144,
  images: 4096,
  textures: 16_384,
  materials: 16_384,
  samplers: 16_384,
  cameras: 4096,
  lights: 4096,
  /** Mesh instances (a primitive under a node, once per scene that shows it) */
  instances: 100_000,
  /** Animation tracks the channels generate (a "weights" channel makes one per primitive it reaches) */
  tracks: 100_000,
  /** Node visits over all scenes, plus joints × skinned primitives, plus nodes reached by "weights" channels */
  work: 4_000_000,
  /** extras and unknown-extension payloads, by their JSON size times the copies made of them */
  metadataBytes: 32 * MiB,
});

/** What the filter found a model asks for (for reports and tests). */
export interface ModelCharge {
  bytes: number;
  largest: number;
  exportBytes: number;
  instances: number;
  tracks: number;
  work: number;
  metadataBytes: number;
}

const COMPONENTS: Readonly<Record<string, number>> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
const COMPONENT_BYTES: Readonly<Record<string, number>> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const INDEX_BYTES: Readonly<Record<string, number>> = { 5121: 1, 5123: 2, 5125: 4 };
const FLOAT = 5126;
const own = <T>(table: Readonly<Record<string, T>>, key: unknown): T | undefined =>
  (typeof key === 'string' || typeof key === 'number') && Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;

// What the page's two loaders handle when required (GLTFLoader's own extensions and plugins, and
// the VRM plugin on the avatar loader; elsewhere the VRM ones are ignored, which does no harm)
const HANDLED_REQUIRED = new Set([
  'KHR_materials_unlit', 'KHR_materials_pbrSpecularGlossiness', 'KHR_texture_transform', 'KHR_mesh_quantization',
  'KHR_materials_clearcoat', 'KHR_materials_transmission', 'KHR_materials_volume', 'KHR_materials_ior',
  'KHR_materials_specular', 'KHR_lights_punctual', 'EXT_texture_webp',
  'VRM', 'VRMC_vrm', 'VRMC_springBone', 'VRMC_springBone_extended_collider', 'VRMC_materials_mtoon', 'VRMC_node_constraint', 'VRMC_materials_hdr_emissiveMultiplier',
]);
// Extensions the base loader handles itself: not copied into userData
const KNOWN_TO_LOADER = new Set([...HANDLED_REQUIRED].filter((name) => !name.startsWith('VRM')));
const NO_DECODER: Readonly<Record<string, string>> = {
  KHR_draco_mesh_compression: 'Draco-compressed meshes cannot be decoded in the render page (it has no Draco decoder)',
  EXT_meshopt_compression: 'meshopt-compressed buffers cannot be decoded in the render page (it has no meshopt decoder)',
  KHR_meshopt_compression: 'meshopt-compressed buffers cannot be decoded in the render page (it has no meshopt decoder)',
  KHR_texture_basisu: 'BasisU textures cannot be decoded in the render page (it has no KTX2 decoder)',
};

const GLB_MAGIC = 0x46546c67; // "glTF"
const JSON_CHUNK = 0x4e4f534a; // "JSON"
const BIN_CHUNK = 0x004e4942; // "BIN\0"

class Refused extends Error {}
const refuse = (reason: string): never => {
  throw new Refused(reason);
};

const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const isObject = (value: unknown): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value);
const isIndex = (value: unknown, length: number): value is number => isCount(value) && value < length;

/** The JSON text and the BIN chunk length of a GLB, read as the page's loader reads it; or the text of a .gltf. */
function container(bytes: Uint8Array): { text: string; bin: number | null } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decode = (part: Uint8Array) => {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(part);
    } catch {
      return refuse('the glTF JSON is not valid UTF-8');
    }
  };
  if (bytes.byteLength < 4 || view.getUint32(0, true) !== GLB_MAGIC) return { text: decode(bytes), bin: null };
  if (bytes.byteLength < 12) refuse('the GLB is truncated');
  if (view.getUint32(4, true) !== 2) refuse(`the GLB is version ${view.getUint32(4, true)}, not 2`);
  const length = view.getUint32(8, true);
  if (length !== bytes.byteLength) refuse(`the GLB declares ${length} bytes but is ${bytes.byteLength}`);
  let json: { start: number; length: number } | null = null;
  let bin: number | null = null;
  // Judged as they come: the first must be JSON, a second BIN, and there is no third
  for (let offset = 12, index = 0; offset < length; index++) {
    if (index === 2) refuse('the GLB has more than a JSON and a BIN chunk');
    if (offset + 8 > length) refuse('a GLB chunk header runs past the end of the file');
    const chunkLength = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    if (chunkLength % 4 !== 0) refuse('a GLB chunk is not a multiple of 4 bytes');
    if (offset + 8 + chunkLength > length) refuse('a GLB chunk runs past the end of the file');
    if (index === 0 && type !== JSON_CHUNK) refuse('the GLB does not start with its JSON chunk');
    if (index === 1 && type !== BIN_CHUNK) refuse('the GLB has a second chunk that is not BIN');
    if (index === 0) json = { start: offset + 8, length: chunkLength };
    else bin = chunkLength;
    offset += 8 + chunkLength;
  }
  if (!json) refuse('the GLB does not start with its JSON chunk');
  const { start, length: jsonLength } = json as { start: number; length: number };
  return { text: decode(bytes.subarray(start, start + jsonLength)), bin };
}

/** The UTF-8 length of the UTF-16 code unit at `i` of `text` (a surrogate pair counts 4 on its first half) */
function utf8Bytes(code: number): number {
  if (code < 0x80) return 1;
  if (code < 0x800) return 2;
  if (code >= 0xd800 && code <= 0xdbff) return 4;
  if (code >= 0xdc00 && code <= 0xdfff) return 0;
  return 3;
}

/**
 * One pass over the JSON text before it is parsed: its nesting depth, and its size in UTF-8 bytes
 * without the contents of string literals that start with "data: (embedded buffers and images).
 */
function scanJson(text: string): number {
  let depth = 0;
  let outsideData = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i);
    if (char === 0x22) {
      // A string literal: find its end, skipping escapes
      const start = i;
      const data = text.startsWith('"data:', start);
      let bytes = 2;
      for (i++; i < text.length && text.charCodeAt(i) !== 0x22; i++) {
        if (!data) bytes += utf8Bytes(text.charCodeAt(i));
        if (text.charCodeAt(i) === 0x5c) {
          i++;
          if (!data && i < text.length) bytes += utf8Bytes(text.charCodeAt(i));
        }
      }
      if (!data) outsideData += bytes;
      continue;
    }
    outsideData += utf8Bytes(char);
    if (char === 0x5b || char === 0x7b) {
      if (++depth > MODEL_LIMITS.jsonDepth) refuse(`the glTF JSON nests deeper than ${MODEL_LIMITS.jsonDepth}`);
    } else if (char === 0x5d || char === 0x7d) depth--;
  }
  if (outsideData > MODEL_LIMITS.jsonBytes) refuse(`the glTF JSON is larger than ${MODEL_LIMITS.jsonBytes} bytes (without its data: URIs)`);
  return outsideData;
}

function list(json: Record<string, any>, key: string, limit: number): any[] {
  const value = json[key];
  if (value === undefined) return [];
  if (!Array.isArray(value)) refuse(`the glTF ${key} are not a list`);
  if (value.length > limit) refuse(`the model has ${value.length} ${key}, more than ${limit}`);
  for (const [index, entry] of value.entries()) if (!isObject(entry)) refuse(`${key} ${index} is not an object`);
  return value;
}

/** The decoded length of a data: URI the way the page's FileLoader decodes it, or an upper bound of it. */
function dataUri(uri: string): { payload: number; decoded: number; base64: boolean } {
  const comma = uri.indexOf(',');
  if (comma === -1) return refuse('a data: URI has no comma');
  const base64 = /;base64$/i.test(uri.slice(0, comma));
  const payload = uri.length - comma - 1;
  let percents = 0;
  for (let i = comma + 1; i < uri.length; i++) if (uri.charCodeAt(i) === 0x25) percents++;
  // decodeURIComponent turns each %XX into at most one character
  const unescaped = payload - 2 * percents;
  if (!base64) return { payload, decoded: unescaped, base64 };
  let letters = 0;
  for (let i = comma + 1; i < uri.length; i++) {
    const c = uri.charCodeAt(i);
    if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39) || c === 0x2b || c === 0x2f || c === 0x25) letters++;
  }
  return { payload, decoded: Math.floor((letters * 3) / 4), base64 };
}

/** What the page would be asked to do for the model in `bytes`, or throws Refused. */
function charge(bytes: Uint8Array, budget: ModelBudget): ModelCharge {
  const { text, bin } = container(bytes);
  const jsonBytes = scanJson(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    refuse('the glTF JSON does not parse');
  }
  if (!isObject(parsed)) refuse('the glTF JSON is not an object');
  const gltf = parsed as Record<string, any>;
  if (!isObject(gltf.asset) || typeof gltf.asset.version !== 'string' || !/^2\.\d+$/.test(gltf.asset.version)) refuse('the glTF asset.version is not 2.x');

  // ---- extensions ----
  for (const key of ['extensionsUsed', 'extensionsRequired']) {
    const names = gltf[key] ?? [];
    if (!Array.isArray(names) || names.some((name) => typeof name !== 'string')) refuse(`the glTF ${key} are not a list of names`);
  }
  if ((gltf.extensionsUsed ?? []).includes('KHR_draco_mesh_compression')) refuse(NO_DECODER.KHR_draco_mesh_compression);
  for (const name of gltf.extensionsRequired ?? []) {
    const missing = own(NO_DECODER, name);
    if (missing) refuse(missing);
    if (!HANDLED_REQUIRED.has(name)) refuse(`the model requires the extension ${name}, which the render page does not know`);
  }

  let total = 0;
  let largest = 0;
  // `single`: one allocation, judged on its own too; otherwise a sum of allocations judged one by one already
  const add = (bytesOf: number, what: string, single = true) => {
    if (!Number.isFinite(bytesOf)) refuse(`${what} needs more bytes than can be counted`);
    if (single && bytesOf > budget.singleBytes) refuse(`${what} needs ${bytesOf} bytes, more than ${budget.singleBytes}`);
    if (single) largest = Math.max(largest, bytesOf);
    total += bytesOf;
    if (total > budget.totalBytes) refuse(`the model needs more than ${budget.totalBytes} bytes to load`);
  };
  let exported = 0;
  let work = 0;
  const spend = (units: number) => {
    work += units;
    if (work > MODEL_LIMITS.work) refuse(`the model's node tree, skins or morph tracks need more than ${MODEL_LIMITS.work} steps`);
  };

  // ---- buffers and buffer views ----
  const buffers = list(gltf, 'buffers', MODEL_LIMITS.buffers);
  const bufferLengths = buffers.map((buffer, index) => {
    if (!isCount(buffer.byteLength)) refuse(`buffer ${index} has no usable byteLength`);
    if (buffer.uri === undefined) {
      if (index !== 0 || bin === null) refuse(`buffer ${index} has no data`);
      if (buffer.byteLength > (bin as number)) refuse('buffer 0 is longer than the BIN chunk');
      return buffer.byteLength as number;
    }
    if (typeof buffer.uri !== 'string') refuse(`buffer ${index} has a URI that is not a string`);
    // Only data: URIs load (the page has no network)
    if (!buffer.uri.startsWith('data:')) return 0;
    const uri = dataUri(buffer.uri);
    if (buffer.byteLength > uri.decoded) refuse(`buffer ${index} is longer than its data: URI holds`);
    // FileLoader: the payload matched out of the URI, decodeURIComponent of it, atob for base64, then the bytes
    add(uri.payload, `buffer ${index}'s data: URI text`);
    add(uri.payload, `buffer ${index}'s URI-decoded text`);
    if (uri.base64) add(uri.decoded, `buffer ${index}'s base64-decoded text`);
    add(uri.decoded, `buffer ${index}'s bytes`);
    return buffer.byteLength as number;
  });
  if (bin !== null) add(bin, 'the BIN chunk');

  const views = list(gltf, 'bufferViews', MODEL_LIMITS.bufferViews);
  for (const [index, view] of views.entries()) {
    const offset = view.byteOffset ?? 0;
    if (!isIndex(view.buffer, buffers.length)) refuse(`buffer view ${index} names no buffer`);
    if (!isCount(offset) || !isCount(view.byteLength)) refuse(`buffer view ${index} has no usable byteOffset or byteLength`);
    if (offset + view.byteLength > bufferLengths[view.buffer]) refuse(`buffer view ${index} runs past the end of its buffer`);
    if (view.byteStride !== undefined && !(isCount(view.byteStride) && view.byteStride >= 4 && view.byteStride <= 252 && view.byteStride % 4 === 0)) refuse(`buffer view ${index} has a byteStride that is not a multiple of 4 from 4 to 252`);
    add(view.byteLength, `buffer view ${index}`);
  }

  // ---- accessors ----
  const accessors = list(gltf, 'accessors', MODEL_LIMITS.accessors);
  /** Whether an accessor's data is interleaved with others (a stride other than its own element size) */
  const interleaved: boolean[] = [];
  const accessorBytes = accessors.map((accessor, index) => {
    const components = own(COMPONENTS, accessor.type);
    const size = own(COMPONENT_BYTES, accessor.componentType);
    if (!isCount(accessor.count) || !components || !size) refuse(`accessor ${index} has no usable count, type or component type`);
    const itemBytes = (components as number) * (size as number);
    const offset = accessor.byteOffset ?? 0;
    if (!isCount(offset)) refuse(`accessor ${index} has no usable byteOffset`);
    interleaved[index] = false;
    if (accessor.bufferView !== undefined) {
      if (!isIndex(accessor.bufferView, views.length)) refuse(`accessor ${index} names no buffer view`);
      const view = views[accessor.bufferView];
      const stride = view.byteStride as number | undefined;
      interleaved[index] = stride !== undefined && stride !== itemBytes;
      if (interleaved[index] && (stride as number) < itemBytes) refuse(`accessor ${index} has elements larger than its view's byteStride`);
      // The loader reads count elements (stride apart when interleaved) from the view
      const span = accessor.count === 0 ? 0 : interleaved[index] ? (accessor.count - 1) * (stride as number) + itemBytes : accessor.count * itemBytes;
      if (offset + span > view.byteLength) refuse(`accessor ${index} runs past the end of its buffer view`);
    }
    let bytesOf = accessor.count * itemBytes;
    const { sparse } = accessor;
    if (sparse !== undefined) {
      const indexSize = own(INDEX_BYTES, sparse?.indices?.componentType);
      if (!isObject(sparse) || !isCount(sparse.count) || !indexSize) refuse(`accessor ${index} has a sparse part with no usable count or index type`);
      for (const [part, entryBytes] of [[sparse.indices, indexSize as number], [sparse.values, itemBytes]] as const) {
        if (!isObject(part) || !isIndex(part.bufferView, views.length)) refuse(`accessor ${index} has a sparse part that names no buffer view`);
        const partOffset = part.byteOffset ?? 0;
        if (!isCount(partOffset) || partOffset + sparse.count * entryBytes > views[part.bufferView].byteLength) refuse(`accessor ${index} has a sparse part that runs past the end of its buffer view`);
      }
      bytesOf += sparse.count * ((indexSize as number) + itemBytes);
    }
    add(bytesOf, `accessor ${index}`);
    return bytesOf;
  });
  const accessorAt = (value: unknown, what: string) => {
    if (!isIndex(value, accessors.length)) refuse(`${what} names no accessor`);
    return accessors[value as number];
  };
  const floatBytes = (accessor: Record<string, any>) => accessor.count * (COMPONENTS[accessor.type] ?? 1) * 4;

  // ---- images, samplers, textures, materials, cameras, lights ----
  const images = list(gltf, 'images', MODEL_LIMITS.images);
  const imageBytes = images.map((image, index) => {
    if (image.bufferView !== undefined) {
      if (!isIndex(image.bufferView, views.length)) refuse(`image ${index} names no buffer view`);
      return views[image.bufferView].byteLength as number;
    }
    if (typeof image.uri !== 'string') refuse(`image ${index} has neither a buffer view nor a URI`);
    return image.uri.startsWith('data:') ? image.uri.length : 0;
  });
  const samplers = list(gltf, 'samplers', MODEL_LIMITS.samplers);
  const textures = list(gltf, 'textures', MODEL_LIMITS.textures);
  const decoded = new Set<string>();
  for (const [index, texture] of textures.entries()) {
    if (texture.sampler !== undefined && !isIndex(texture.sampler, samplers.length)) refuse(`texture ${index} names no sampler`);
    const sources = [texture.source, texture.extensions?.EXT_texture_webp?.source, texture.extensions?.KHR_texture_basisu?.source].filter((source) => source !== undefined);
    if (sources.length === 0) refuse(`texture ${index} has no image`);
    for (const source of sources) {
      if (!isIndex(source, images.length)) refuse(`texture ${index} names no image`);
      const key = `${source}:${texture.sampler}`;
      if (decoded.has(key)) continue;
      decoded.add(key);
      add(imageBytes[source], `image ${source}`);
    }
  }
  const materials = list(gltf, 'materials', MODEL_LIMITS.materials);
  // Every texture a material names where glTF or an extension the page reads defines one
  // (MATERIAL_TEXTURES); extras and other extensions are not read as texture references
  for (const [index, material] of materials.entries()) {
    if (!isObject(material)) continue;
    for (const [carrier, names] of MATERIAL_TEXTURES) {
      const holder = carrier === '' ? material : carrier === 'pbrMetallicRoughness' ? material.pbrMetallicRoughness : material.extensions?.[carrier];
      if (!isObject(holder)) continue;
      for (const name of names) {
        const info = holder[name];
        if (info !== undefined && !(isObject(info) && isIndex(info.index, textures.length))) refuse(`material ${index} names no texture (${name})`);
      }
    }
  }
  const cameras = list(gltf, 'cameras', MODEL_LIMITS.cameras);
  const lights = gltf.extensions?.KHR_lights_punctual?.lights;
  if (lights !== undefined && !Array.isArray(lights)) refuse("the model's lights are not a list");
  if (Array.isArray(lights) && lights.length > MODEL_LIMITS.lights) refuse(`the model has ${lights.length} lights, more than ${MODEL_LIMITS.lights}`);
  const lightCount = Array.isArray(lights) ? lights.length : 0;

  // ---- meshes ----
  const meshes = list(gltf, 'meshes', MODEL_LIMITS.meshes);
  let primitiveCount = 0;
  let targetCount = 0;
  const morphBytes: number[] = [];
  const exportedAccessors = new Set<number>();
  // The loader's geometry cache key (createPrimitiveKey): primitives with the same key get one geometry
  const geometryTargets = new Map<string, string>();
  for (const [meshIndex, mesh] of meshes.entries()) {
    if (!Array.isArray(mesh.primitives)) refuse(`mesh ${meshIndex} has no list of primitives`);
    primitiveCount += mesh.primitives.length;
    if (primitiveCount > MODEL_LIMITS.primitives) refuse(`the model has more than ${MODEL_LIMITS.primitives} primitives`);
    let morph = 0;
    for (const [primitiveIndex, primitive] of mesh.primitives.entries()) {
      const what = `mesh ${meshIndex} primitive ${primitiveIndex}`;
      if (!isObject(primitive) || !isObject(primitive.attributes)) refuse(`${what} has no attributes`);
      const mode = primitive.mode ?? 4;
      if (!isCount(mode) || mode > 6) refuse(`${what} has no usable mode`);
      // The loader turns them into triangles with arrays of its own; nothing the agent loads uses them
      if (mode === 5 || mode === 6) refuse(`${what} is a triangle strip or fan, which the render page does not load`);
      for (const [name, value] of Object.entries(primitive.attributes)) {
        accessorAt(value, `${what} ${name}`);
        exportedAccessors.add(value as number);
      }
      if (primitive.indices !== undefined) {
        accessorAt(primitive.indices, `${what} indices`);
        exportedAccessors.add(primitive.indices);
      }
      if (primitive.material !== undefined && !isIndex(primitive.material, materials.length)) refuse(`${what} names no material`);
      const targets = primitive.targets ?? [];
      if (!Array.isArray(targets)) refuse(`${what} has targets that are not a list`);
      targetCount += targets.length;
      if (targetCount > MODEL_LIMITS.morphTargets) refuse(`the model has more than ${MODEL_LIMITS.morphTargets} morph targets`);
      for (const [targetIndex, target] of targets.entries()) if (!isObject(target)) refuse(`${what} target ${targetIndex} is not an object`);
      const key = `${primitive.indices}:${Object.keys(primitive.attributes).sort().map((name) => `${name}:${primitive.attributes[name]};`).join('')}:${primitive.mode}`;
      // By content: the order of a target's members does not matter, the order of the targets does
      const declared = JSON.stringify(targets.map((target: Record<string, unknown>) => Object.keys(target).sort().map((name) => [name, target[name]])));
      if (geometryTargets.has(key) && geometryTargets.get(key) !== declared) refuse(`${what} shares its geometry with another primitive but declares other morph targets`);
      geometryTargets.set(key, declared);
      for (const [targetIndex, target] of targets.entries()) {
        for (const value of Object.values(target)) accessorAt(value, `${what} target ${targetIndex}`);
        for (const name of ['POSITION', 'NORMAL']) {
          if (target[name] === undefined) continue;
          const copy = floatBytes(accessors[target[name]]);
          if (copy > budget.singleBytes) refuse(`${what} target ${targetIndex} ${name} needs ${copy} bytes, more than ${budget.singleBytes}`);
          morph += copy;
        }
      }
    }
    morphBytes.push(morph);
    // The exporter clones each morph attribute and then writes it: once per mesh, however many nodes show it
    if (morph > 0) add(2 * morph, `the morph targets of mesh ${meshIndex}`, false);
    exported += morph;
  }
  for (const index of exportedAccessors) {
    add(accessorBytes[index], `the export of accessor ${index}`);
    exported += accessorBytes[index];
  }

  // ---- nodes, skins, scenes ----
  const nodes = list(gltf, 'nodes', MODEL_LIMITS.nodes);
  const skins = list(gltf, 'skins', MODEL_LIMITS.skins);
  let joints = 0;
  for (const [index, skin] of skins.entries()) {
    if (!Array.isArray(skin.joints) || skin.joints.some((joint: unknown) => !isIndex(joint, nodes.length))) refuse(`skin ${index} has joints that name no node`);
    if (skin.skeleton !== undefined && !isIndex(skin.skeleton, nodes.length)) refuse(`skin ${index} names no skeleton node`);
    joints += skin.joints.length;
    if (joints > MODEL_LIMITS.joints) refuse(`the model has more than ${MODEL_LIMITS.joints} joints`);
    if (skin.inverseBindMatrices !== undefined) accessorAt(skin.inverseBindMatrices, `skin ${index} inverseBindMatrices`);
  }
  const parent = new Array<number>(nodes.length).fill(-1);
  for (const [index, node] of nodes.entries()) {
    if (node.mesh !== undefined && !isIndex(node.mesh, meshes.length)) refuse(`node ${index} names no mesh`);
    if (node.skin !== undefined && !isIndex(node.skin, skins.length)) refuse(`node ${index} names no skin`);
    if (node.camera !== undefined && !isIndex(node.camera, cameras.length)) refuse(`node ${index} names no camera`);
    const light = node.extensions?.KHR_lights_punctual?.light;
    if (light !== undefined && !isIndex(light, lightCount)) refuse(`node ${index} names no light`);
    const children = node.children ?? [];
    if (!Array.isArray(children)) refuse(`node ${index} has children that are not a list`);
    for (const child of children) {
      if (!isIndex(child, nodes.length)) refuse(`node ${index} has a child that names no node`);
      // The loader builds the tree by following every child reference: shared children multiply that work, and a cycle never ends
      if (parent[child] !== -1 || child === index) refuse(`node ${child} has more than one parent`);
      parent[child] = index;
    }
  }
  // Primitives under each node, and whether a node is its own ancestor
  const primitivesUnder = new Array<number>(nodes.length).fill(-1);
  const meshPrimitives = (index: number) => (nodes[index].mesh === undefined ? 0 : meshes[nodes[index].mesh].primitives.length);
  const under = (start: number) => {
    const stack: [number, number][] = [[start, 0]];
    const inProgress = new Set<number>([start]);
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const [index, next] = frame;
      const children: number[] = nodes[index].children ?? [];
      if (next < children.length) {
        frame[1]++;
        const child = children[next];
        if (inProgress.has(child)) refuse(`node ${child} is its own ancestor`);
        if (primitivesUnder[child] === -1) {
          inProgress.add(child);
          stack.push([child, 0]);
        }
        continue;
      }
      primitivesUnder[index] = meshPrimitives(index) + children.reduce((sum, child) => sum + primitivesUnder[child], 0);
      inProgress.delete(index);
      stack.pop();
    }
  };
  for (let index = 0; index < nodes.length; index++) if (primitivesUnder[index] === -1) under(index);

  const scenes = list(gltf, 'scenes', MODEL_LIMITS.scenes);
  if (gltf.scene !== undefined && !isIndex(gltf.scene, scenes.length)) refuse('the glTF scene names no scene');
  const meshUses = new Array<number>(meshes.length).fill(0);
  let instances = 0;
  for (const [sceneIndex, scene] of scenes.entries()) {
    const roots = scene.nodes ?? [];
    if (!Array.isArray(roots)) refuse(`scene ${sceneIndex} has nodes that are not a list`);
    for (const root of roots) {
      if (!isIndex(root, nodes.length)) refuse(`scene ${sceneIndex} names no node`);
      const stack = [root];
      while (stack.length) {
        const index = stack.pop() as number;
        spend(1);
        const node = nodes[index];
        if (node.mesh !== undefined) {
          meshUses[node.mesh]++;
          instances += meshPrimitives(index);
          if (instances > MODEL_LIMITS.instances) refuse(`the model's scenes show more than ${MODEL_LIMITS.instances} mesh instances`);
        }
        if (node.skin !== undefined) {
          const skinned = Math.max(1, primitivesUnder[index]);
          const jointCount = skins[node.skin].joints.length;
          spend(jointCount * skinned);
          // Per skinned mesh: bone matrices, the exporter's inverse matrices, and their written copy
          for (const stage of ['bone matrices', 'inverse bind matrices for the export', 'the written inverse bind matrices']) {
            add(jointCount * 64, `skin ${node.skin} ${stage}`);
            if (skinned > 1) add((skinned - 1) * jointCount * 64, `skin ${node.skin} ${stage} for each mesh`, false);
          }
          exported += skinned * jointCount * 64;
        }
        for (const child of node.children ?? []) stack.push(child);
      }
    }
  }

  // ---- animations ----
  const animations = list(gltf, 'animations', MODEL_LIMITS.animations);
  let channels = 0;
  let tracks = 0;
  const sizeOf = (start: number) => {
    let count = 0;
    const stack = [start];
    while (stack.length) {
      count++;
      for (const child of nodes[stack.pop() as number].children ?? []) stack.push(child);
    }
    return count;
  };
  for (const [animationIndex, animation] of animations.entries()) {
    // Legacy glTF 1.0 indirection the loader still honours: the accessors it names are not the ones judged here
    if (animation.parameters !== undefined) refuse(`animation ${animationIndex} uses the legacy "parameters"`);
    if (!Array.isArray(animation.channels) || !Array.isArray(animation.samplers)) refuse(`animation ${animationIndex} has no channels or samplers`);
    channels += animation.channels.length;
    if (channels > MODEL_LIMITS.channels) refuse(`the model has more than ${MODEL_LIMITS.channels} animation channels`);
    for (const [channelIndex, channel] of animation.channels.entries()) {
      const what = `animation ${animationIndex} channel ${channelIndex}`;
      if (!isObject(channel) || !isIndex(channel.sampler, animation.samplers.length)) refuse(`${what} names no sampler`);
      const sampler = animation.samplers[channel.sampler];
      if (!isObject(sampler) || !isObject(channel.target) || !isIndex(channel.target.node, nodes.length)) refuse(`${what} names no sampler or target node`);
      let generated = 1;
      if (channel.target.path === 'weights') {
        generated = Math.max(1, primitivesUnder[channel.target.node]);
        spend(sizeOf(channel.target.node));
      }
      tracks += generated;
      if (tracks > MODEL_LIMITS.tracks) refuse(`the model's animations make more than ${MODEL_LIMITS.tracks} tracks`);
      for (const [part, value] of [['input', sampler.input], ['output', sampler.output]] as const) {
        const accessor = accessorAt(value, `${what} ${part}`);
        // The loader converts the whole interleaved array, not the accessor's own elements
        if (interleaved[value]) refuse(`${what} ${part} is in an interleaved buffer view`);
        if (accessor.componentType === FLOAT) continue;
        // One conversion per track
        add(floatBytes(accessor), `${what} ${part} as floats`);
        if (generated > 1) add((generated - 1) * floatBytes(accessor), `${what} ${part} for each mesh`, false);
      }
    }
  }

  // ---- metadata: extras and unknown extensions, copied into userData (and again by every clone and the export) ----
  let metadataBytes = 0;
  const payload = (definition: Record<string, any>, copies: number, what: string) => {
    const unknown = isObject(definition.extensions) ? Object.keys(definition.extensions).filter((name) => !KNOWN_TO_LOADER.has(name)) : [];
    if (definition.extras === undefined && unknown.length === 0) return;
    const size = JSON.stringify([definition.extras ?? null, unknown.map((name) => definition.extensions[name])]).length;
    metadataBytes += size * copies;
    if (metadataBytes > MODEL_LIMITS.metadataBytes) refuse(`the model's extras and extension data, with the copies made of them, come to more than ${MODEL_LIMITS.metadataBytes} bytes (${what})`);
  };
  payload(gltf, 1, 'the file');
  for (const [index, mesh] of meshes.entries()) {
    // On every primitive's object, in every instance, and in the export
    const copies = 2 * mesh.primitives.length * Math.max(1, meshUses[index]);
    payload(mesh, copies, `mesh ${index}`);
    for (const primitive of mesh.primitives) payload(primitive, copies, `mesh ${index}`);
  }
  for (const [key, entries] of [['nodes', nodes], ['scenes', scenes], ['materials', materials], ['cameras', cameras]] as const) {
    for (const [index, definition] of entries.entries()) payload(definition, 2, `${key} ${index}`);
  }
  // The exported JSON: about the size of this one without its data: URIs
  exported += jsonBytes;

  if (exported > budget.exportBytes) refuse(`the model's export would be about ${exported} bytes, more than ${budget.exportBytes}`);
  return { bytes: total, largest, exportBytes: exported, instances, tracks, work, metadataBytes };
}

/** What the filter finds the model in `bytes` asks for, or why it must not be loaded. */
export function gltfCharge(bytes: Uint8Array, budget: ModelBudget): { charge: ModelCharge } | { problem: string } {
  try {
    return { charge: charge(bytes, budget) };
  } catch (error) {
    if (error instanceof Refused) return { problem: error.message };
    throw error;
  }
}

/** Why the model in `bytes` must not be loaded under `budget`, or null. */
export function gltfStorageProblem(bytes: Uint8Array, budget: ModelBudget): string | null {
  const result = gltfCharge(bytes, budget);
  return 'problem' in result ? result.problem : null;
}
