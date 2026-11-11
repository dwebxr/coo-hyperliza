/**
 * What a model (GLB or glTF JSON) makes the render page allocate, judged from the file before any
 * of it is parsed. A file within the download cap can still make the page's loader
 * (node_modules/page-three/examples/jsm/loaders/GLTFLoader.js, three 0.132.2) and exporter
 * (.../exporters/GLTFExporter.js) allocate far more than its own size, and work for far longer.
 *
 * The container is checked the way that loader reads it, so the JSON judged here is the JSON the
 * page parses: magic "glTF", version 2, a declared length equal to the file's, chunks that tile
 * the file, each within bounds and a multiple of 4 bytes, exactly one JSON chunk and it is first,
 * at most one BIN chunk after it, and nothing else. Anything else is refused.
 *
 * Bytes charged, each at the allocation site named (this is an estimate of the loader's and the
 * exporter's main allocations, not a limit on the memory of the Chromium process):
 *   - the BIN chunk, copied once (GLTFBinaryExtension: data.slice);
 *   - a data: URI buffer, twice its length (FileLoader decodes it into a string, then a buffer);
 *   - every buffer view, by its byteLength, overlapping ones each in full (loadBufferView:
 *     buffer.slice);
 *   - every accessor, count × components × component size, plus its sparse indices and values
 *     (loadAccessor: a zero-filled array when it has no buffer view, a copy when it is sparse);
 *   - each texture's image, its encoded bytes once per image and sampler (loadTextureImage: a
 *     Blob of the buffer view, or the data: URI);
 *   - per animation channel, an output that is not float as Float32 (the normalised conversion
 *     in loadAnimation, or KeyframeTrack's conversion), and the same for an input, once per mesh
 *     a "weights" channel drives;
 *   - per node that uses a mesh, per primitive, per morph target, its POSITION and NORMAL twice
 *     (GLTFExporter: attribute.clone() and its serialisation, not cached per geometry);
 *   - every accessor a primitive uses, once more (GLTFExporter: the serialised copy);
 *   - a triangle strip or fan, 48 bytes per vertex (toTrianglesDrawMode builds JS arrays).
 * One allocation (an accessor, a buffer view, a converted animation output, a morph copy) may be
 * at most the download cap; all of them together at most 8 times the download cap.
 *
 * Not charged: image decoding (a small image can declare huge dimensions), what the VRM plugin
 * builds from its own extensions, the exporter's re-encoding of textures that stay on the model,
 * and three.js objects per node or mesh. Their number is bounded by the counts in MODEL_LIMITS,
 * and the walk of the node tree, skin binding and morph "weights" tracks by MODEL_LIMITS.work.
 *
 * Required extensions the page's loader cannot decode are refused (Draco, meshopt, BasisU, and
 * any it does not know); Draco is refused when merely used, as the loader throws without a
 * decoder.
 */
import { MAX_EMOTE_BYTES, MAX_MODEL_BYTES } from './net-policy';

export type ModelKind = 'model' | 'avatar' | 'emote';

export interface ModelBudget {
  /** One charged allocation */
  singleBytes: number;
  /** All charged allocations together */
  totalBytes: number;
  /** What the render page hands back (assets.js refuses to return more) */
  exportBytes: number;
}

export function modelBudget(kind: ModelKind): ModelBudget {
  const cap = kind === 'emote' ? MAX_EMOTE_BYTES : MAX_MODEL_BYTES;
  return { singleBytes: cap, totalBytes: 8 * cap, exportBytes: 4 * cap };
}

/** How many of each a model may have, and how much node-tree work it may cause. */
export const MODEL_LIMITS = Object.freeze({
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
  /** Node visits over all scenes, plus joints × skinned primitives, plus meshes reached by "weights" tracks */
  work: 4_000_000,
});

/** Model charges and counts, for a report on what a file asks for. */
export interface ModelCharge {
  bytes: number;
  largest: number;
  work: number;
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

/** The JSON text and the BIN chunk length of a GLB, checked as the page's loader reads it; or the text of a .gltf. */
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
  const chunks: { type: number; start: number; length: number }[] = [];
  for (let offset = 12; offset < length; ) {
    if (offset + 8 > length) refuse('a GLB chunk header runs past the end of the file');
    const chunkLength = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    if (chunkLength % 4 !== 0) refuse('a GLB chunk is not a multiple of 4 bytes');
    if (offset + 8 + chunkLength > length) refuse('a GLB chunk runs past the end of the file');
    chunks.push({ type, start: offset + 8, length: chunkLength });
    offset += 8 + chunkLength;
  }
  if (chunks[0]?.type !== JSON_CHUNK) refuse('the GLB does not start with its JSON chunk');
  if (chunks.length > 2) refuse('the GLB has more than a JSON and a BIN chunk');
  if (chunks.length === 2 && chunks[1].type !== BIN_CHUNK) refuse('the GLB has a second chunk that is not BIN');
  return { text: decode(bytes.subarray(chunks[0].start, chunks[0].start + chunks[0].length)), bin: chunks[1]?.length ?? null };
}

function list(json: Record<string, any>, key: string, limit: number): any[] {
  const value = json[key];
  if (value === undefined) return [];
  if (!Array.isArray(value)) refuse(`the glTF ${key} are not a list`);
  if (value.length > limit) refuse(`the model has ${value.length} ${key}, more than ${limit}`);
  for (const [index, entry] of value.entries()) if (!isObject(entry)) refuse(`${key} ${index} is not an object`);
  return value;
}

/** What the page would allocate for the model in `bytes`, or throws Refused. */
function charge(bytes: Uint8Array, budget: ModelBudget): ModelCharge {
  const { text, bin } = container(bytes);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    refuse('the glTF JSON does not parse');
  }
  if (!isObject(json)) refuse('the glTF JSON is not an object');
  const gltf = json as Record<string, any>;

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
  // `single`: one allocation (judged on its own too); otherwise a sum of allocations judged one by one already
  const add = (bytesOf: number, what: string, single = true) => {
    if (!Number.isFinite(bytesOf)) refuse(`${what} needs more bytes than can be counted`);
    if (single && bytesOf > budget.singleBytes) refuse(`${what} needs ${bytesOf} bytes, more than ${budget.singleBytes}`);
    if (single) largest = Math.max(largest, bytesOf);
    total += bytesOf;
    if (total > budget.totalBytes) refuse(`the model needs more than ${budget.totalBytes} bytes to load`);
  };
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
    // Only data: URIs load (the page has no network); a decoded one is at most 3/4 of its length
    if (!buffer.uri.startsWith('data:')) return 0;
    if (buffer.byteLength > Math.ceil((buffer.uri.length * 3) / 4)) refuse(`buffer ${index} is longer than its data: URI`);
    add(2 * buffer.uri.length, `buffer ${index}`);
    return buffer.byteLength as number;
  });
  if (bin !== null) add(bin, 'the BIN chunk');

  const views = list(gltf, 'bufferViews', MODEL_LIMITS.bufferViews);
  for (const [index, view] of views.entries()) {
    const offset = view.byteOffset ?? 0;
    if (!isCount(view.buffer) || view.buffer >= buffers.length) refuse(`buffer view ${index} names no buffer`);
    if (!isCount(offset) || !isCount(view.byteLength)) refuse(`buffer view ${index} has no usable byteOffset or byteLength`);
    if (offset + view.byteLength > bufferLengths[view.buffer]) refuse(`buffer view ${index} runs past the end of its buffer`);
    add(view.byteLength, `buffer view ${index}`);
  }

  // ---- accessors ----
  const accessors = list(gltf, 'accessors', MODEL_LIMITS.accessors);
  const accessorBytes = accessors.map((accessor, index) => {
    const components = own(COMPONENTS, accessor.type);
    const size = own(COMPONENT_BYTES, accessor.componentType);
    if (!isCount(accessor.count) || !components || !size) refuse(`accessor ${index} has no usable count, type or component type`);
    if (accessor.bufferView !== undefined && (!isCount(accessor.bufferView) || accessor.bufferView >= views.length)) refuse(`accessor ${index} names no buffer view`);
    if (accessor.byteOffset !== undefined && !isCount(accessor.byteOffset)) refuse(`accessor ${index} has no usable byteOffset`);
    let bytesOf = accessor.count * (components as number) * (size as number);
    const { sparse } = accessor;
    if (sparse !== undefined) {
      const indexSize = own(INDEX_BYTES, sparse?.indices?.componentType);
      if (!isObject(sparse) || !isCount(sparse.count) || !indexSize) refuse(`accessor ${index} has a sparse part with no usable count or index type`);
      for (const part of [sparse.indices, sparse.values]) {
        if (!isObject(part) || !isCount(part.bufferView) || part.bufferView >= views.length) refuse(`accessor ${index} has a sparse part that names no buffer view`);
      }
      bytesOf += sparse.count * ((indexSize as number) + (components as number) * (size as number));
    }
    add(bytesOf, `accessor ${index}`);
    return bytesOf;
  });
  const accessorAt = (value: unknown, what: string) => {
    if (!isCount(value) || value >= accessors.length) refuse(`${what} names no accessor`);
    return accessors[value as number];
  };
  const floatBytes = (accessor: Record<string, any>) => accessor.count * (COMPONENTS[accessor.type] ?? 1) * 4;

  // ---- images and textures ----
  const images = list(gltf, 'images', MODEL_LIMITS.images);
  const imageBytes = images.map((image, index) => {
    if (image.bufferView !== undefined) {
      if (!isCount(image.bufferView) || image.bufferView >= views.length) refuse(`image ${index} names no buffer view`);
      return views[image.bufferView].byteLength as number;
    }
    if (typeof image.uri !== 'string') refuse(`image ${index} has neither a buffer view nor a URI`);
    return image.uri.startsWith('data:') ? image.uri.length : 0;
  });
  list(gltf, 'samplers', MODEL_LIMITS.samplers);
  const textures = list(gltf, 'textures', MODEL_LIMITS.textures);
  const decoded = new Set<string>();
  for (const [index, texture] of textures.entries()) {
    const sources = [texture.source, texture.extensions?.EXT_texture_webp?.source, texture.extensions?.KHR_texture_basisu?.source].filter((source) => source !== undefined);
    if (sources.length === 0) refuse(`texture ${index} has no image`);
    for (const source of sources) {
      if (!isCount(source) || source >= images.length) refuse(`texture ${index} names no image`);
      const key = `${source}:${texture.sampler}`;
      if (decoded.has(key)) continue;
      decoded.add(key);
      add(imageBytes[source], `image ${source}`);
    }
  }
  list(gltf, 'materials', MODEL_LIMITS.materials);

  // ---- meshes ----
  const meshes = list(gltf, 'meshes', MODEL_LIMITS.meshes);
  let primitiveCount = 0;
  let targetCount = 0;
  const morphBytes: number[] = [];
  const exported = new Set<number>();
  for (const [meshIndex, mesh] of meshes.entries()) {
    if (!Array.isArray(mesh.primitives)) refuse(`mesh ${meshIndex} has no list of primitives`);
    primitiveCount += mesh.primitives.length;
    if (primitiveCount > MODEL_LIMITS.primitives) refuse(`the model has more than ${MODEL_LIMITS.primitives} primitives`);
    let morph = 0;
    for (const [primitiveIndex, primitive] of mesh.primitives.entries()) {
      const what = `mesh ${meshIndex} primitive ${primitiveIndex}`;
      if (!isObject(primitive) || !isObject(primitive.attributes)) refuse(`${what} has no attributes`);
      for (const [name, value] of Object.entries(primitive.attributes)) {
        accessorAt(value, `${what} ${name}`);
        exported.add(value as number);
      }
      if (primitive.indices !== undefined) {
        accessorAt(primitive.indices, `${what} indices`);
        exported.add(primitive.indices);
      }
      const mode = primitive.mode ?? 4;
      if (mode === 5 || mode === 6) {
        const position = primitive.attributes.POSITION;
        if (position !== undefined) add(48 * accessors[position].count, `${what} as triangles`);
      }
      if (primitive.targets !== undefined) {
        if (!Array.isArray(primitive.targets)) refuse(`${what} has targets that are not a list`);
        targetCount += primitive.targets.length;
        if (targetCount > MODEL_LIMITS.morphTargets) refuse(`the model has more than ${MODEL_LIMITS.morphTargets} morph targets`);
        for (const [targetIndex, target] of primitive.targets.entries()) {
          if (!isObject(target)) refuse(`${what} target ${targetIndex} is not an object`);
          for (const name of ['POSITION', 'NORMAL']) {
            if (target[name] === undefined) continue;
            const copy = floatBytes(accessorAt(target[name], `${what} target ${targetIndex} ${name}`));
            if (copy > budget.singleBytes) refuse(`${what} target ${targetIndex} ${name} needs ${copy} bytes, more than ${budget.singleBytes}`);
            morph += 2 * copy;
          }
          for (const value of Object.values(target)) accessorAt(value, `${what} target ${targetIndex}`);
        }
      }
    }
    morphBytes.push(morph);
  }
  // The exporter's serialised copy of what primitives use
  for (const index of exported) add(accessorBytes[index], `the export of accessor ${index}`);

  // ---- nodes, skins, scenes ----
  const nodes = list(gltf, 'nodes', MODEL_LIMITS.nodes);
  const skins = list(gltf, 'skins', MODEL_LIMITS.skins);
  let joints = 0;
  for (const [index, skin] of skins.entries()) {
    if (!Array.isArray(skin.joints) || skin.joints.some((joint: unknown) => !isCount(joint) || (joint as number) >= nodes.length)) refuse(`skin ${index} has joints that name no node`);
    joints += skin.joints.length;
    if (joints > MODEL_LIMITS.joints) refuse(`the model has more than ${MODEL_LIMITS.joints} joints`);
    if (skin.inverseBindMatrices !== undefined) accessorAt(skin.inverseBindMatrices, `skin ${index} inverseBindMatrices`);
  }
  const parent = new Array<number>(nodes.length).fill(-1);
  for (const [index, node] of nodes.entries()) {
    if (node.mesh !== undefined && (!isCount(node.mesh) || node.mesh >= meshes.length)) refuse(`node ${index} names no mesh`);
    if (node.skin !== undefined && (!isCount(node.skin) || node.skin >= skins.length)) refuse(`node ${index} names no skin`);
    const children = node.children ?? [];
    if (!Array.isArray(children)) refuse(`node ${index} has children that are not a list`);
    for (const child of children) {
      if (!isCount(child) || child >= nodes.length) refuse(`node ${index} has a child that names no node`);
      // The loader builds the tree by following every child reference: shared children multiply that work, and a cycle never ends
      if (parent[child] !== -1 || child === index) refuse(`node ${child} has more than one parent`);
      parent[child] = index;
    }
  }
  // Primitives under each node (for skin binding), and whether a node is its own ancestor
  const primitivesUnder = new Array<number>(nodes.length).fill(-1);
  const meshPrimitives = (index: number) => (nodes[index].mesh === undefined ? 0 : meshes[nodes[index].mesh].primitives.length);
  const under = (start: number): number => {
    // Iterative post-order; a node met again while in progress is a cycle
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
    return primitivesUnder[start];
  };
  for (let index = 0; index < nodes.length; index++) if (primitivesUnder[index] === -1) under(index);

  const scenes = list(gltf, 'scenes', MODEL_LIMITS.scenes);
  const sizeOf = (start: number): number => {
    let count = 0;
    const stack = [start];
    while (stack.length) {
      const index = stack.pop() as number;
      count++;
      for (const child of nodes[index].children ?? []) stack.push(child);
    }
    return count;
  };
  const meshUses = new Array<number>(meshes.length).fill(0);
  for (const [sceneIndex, scene] of scenes.entries()) {
    const roots = scene.nodes ?? [];
    if (!Array.isArray(roots)) refuse(`scene ${sceneIndex} has nodes that are not a list`);
    for (const root of roots) {
      if (!isCount(root) || root >= nodes.length) refuse(`scene ${sceneIndex} names no node`);
      const stack = [root];
      while (stack.length) {
        const index = stack.pop() as number;
        spend(1);
        const node = nodes[index];
        if (node.mesh !== undefined) meshUses[node.mesh]++;
        if (node.skin !== undefined) spend(skins[node.skin].joints.length * Math.max(1, primitivesUnder[index]));
        for (const child of node.children ?? []) stack.push(child);
      }
    }
  }
  // Each copy was judged on its own above
  for (const [index, uses] of meshUses.entries()) if (morphBytes[index] > 0) add(uses * morphBytes[index], `the morph targets of mesh ${index}`, false);

  // ---- animations ----
  const animations = list(gltf, 'animations', MODEL_LIMITS.animations);
  let channels = 0;
  for (const [animationIndex, animation] of animations.entries()) {
    if (!Array.isArray(animation.channels) || !Array.isArray(animation.samplers)) refuse(`animation ${animationIndex} has no channels or samplers`);
    channels += animation.channels.length;
    if (channels > MODEL_LIMITS.channels) refuse(`the model has more than ${MODEL_LIMITS.channels} animation channels`);
    for (const [channelIndex, channel] of animation.channels.entries()) {
      const what = `animation ${animationIndex} channel ${channelIndex}`;
      if (!isObject(channel) || !isCount(channel.sampler) || channel.sampler >= animation.samplers.length) refuse(`${what} names no sampler`);
      const sampler = animation.samplers[channel.sampler];
      if (!isObject(sampler) || !isObject(channel.target) || !isCount(channel.target.node) || channel.target.node >= nodes.length) refuse(`${what} names no sampler or target node`);
      const input = accessorAt(sampler.input, `${what} input`);
      const output = accessorAt(sampler.output, `${what} output`);
      let tracks = 1;
      if (channel.target.path === 'weights') {
        tracks = Math.max(1, primitivesUnder[channel.target.node]);
        spend(sizeOf(channel.target.node));
      }
      // One conversion per track (a "weights" channel makes one per mesh it drives)
      for (const [part, accessor] of [['output', output], ['input', input]] as const) {
        if (accessor.componentType === FLOAT) continue;
        add(floatBytes(accessor), `${what} ${part} as floats`);
        if (tracks > 1) add((tracks - 1) * floatBytes(accessor), `${what} ${part} for each mesh`, false);
      }
    }
  }
  return { bytes: total, largest, work };
}

/** What the model in `bytes` asks the page to allocate, or why it must not be loaded. */
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
