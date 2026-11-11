import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { MODEL_LIMITS, type ModelBudget, gltfCharge, gltfStorageProblem, modelBudget } from './gltf-budget';
import { MAX_EMOTE_BYTES, MAX_MODEL_BYTES } from './net-policy';

/*
 * Inputs are built in memory. `chunks` are [type, bytes] pairs; the header is written to match
 * unless a test overrides it.
 */
const JSON_TYPE = 0x4e4f534a;
const BIN_TYPE = 0x004e4942;
const pad = (bytes: Uint8Array, fill: number) => {
  const out = new Uint8Array(Math.ceil(bytes.length / 4) * 4).fill(fill);
  out.set(bytes);
  return out;
};
const jsonBytes = (json: unknown) => pad(new TextEncoder().encode(typeof json === 'string' ? json : JSON.stringify(json)), 0x20);
function glbOf(chunks: [number, Uint8Array][], { version = 2, length }: { version?: number; length?: number } = {}): Uint8Array {
  const size = 12 + chunks.reduce((sum, [, bytes]) => sum + 8 + bytes.length, 0);
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, version, true);
  view.setUint32(8, length ?? size, true);
  let offset = 12;
  for (const [type, bytes] of chunks) {
    view.setUint32(offset, bytes.length, true);
    view.setUint32(offset + 4, type, true);
    out.set(bytes, offset + 8);
    offset += 8 + bytes.length;
  }
  return out;
}
const glb = (json: Record<string, unknown>, bin?: Uint8Array) => glbOf([[JSON_TYPE, jsonBytes({ asset: { version: '2.0' }, ...json })], ...(bin ? ([[BIN_TYPE, pad(bin, 0)]] as [number, Uint8Array][]) : [])]);
const small: ModelBudget = { singleBytes: 1000, totalBytes: 5000, exportBytes: 100_000 };
const accessor = (count: number, type = 'VEC3', componentType = 5126, extra: Record<string, unknown> = {}) => ({ count, type, componentType, ...extra });
const problem = (bytes: Uint8Array, budget = small) => gltfStorageProblem(bytes, budget);

describe('gltfStorageProblem: the GLB container, as the render page reads it', () => {
  it('passes JSON alone and JSON followed by BIN, and glTF JSON text', () => {
    expect(problem(glb({}))).toBeNull();
    expect(problem(glb({ buffers: [{ byteLength: 4 }] }, new Uint8Array(4)))).toBeNull();
    expect(problem(new TextEncoder().encode(JSON.stringify({ asset: { version: '2.0' } })))).toBeNull();
  });

  it('refuses a second JSON chunk, whose JSON the page would parse instead of the first', () => {
    const harmless = jsonBytes({ asset: { version: '2.0' } });
    const bomb = jsonBytes({ asset: { version: '2.0' }, accessors: [accessor(1e9)] });
    expect(problem(glbOf([[JSON_TYPE, harmless], [JSON_TYPE, bomb]]))).toBe('the GLB has a second chunk that is not BIN');
    expect(problem(glbOf([[JSON_TYPE, harmless], [BIN_TYPE, new Uint8Array(4)], [JSON_TYPE, bomb]]))).toBe('the GLB has more than a JSON and a BIN chunk');
  });

  it.each([
    ['version 1', glbOf([[JSON_TYPE, jsonBytes({ asset: {} })]], { version: 1 }), 'the GLB is version 1, not 2'],
    ['a declared length shorter than the file', glbOf([[JSON_TYPE, jsonBytes({ asset: {} })]], { length: 20 }), 'declares 20 bytes but is'],
    ['a declared length longer than the file', glbOf([[JSON_TYPE, jsonBytes({ asset: {} })]], { length: 4000 }), 'declares 4000 bytes but is'],
    ['a chunk that is not a multiple of 4 bytes', glbOf([[JSON_TYPE, new TextEncoder().encode('{"a":1}')]]), 'not a multiple of 4 bytes'],
    ['a BIN chunk first', glbOf([[BIN_TYPE, new Uint8Array(4)], [JSON_TYPE, jsonBytes({})]]), 'does not start with its JSON chunk'],
    ['an unknown second chunk', glbOf([[JSON_TYPE, jsonBytes({})], [0x12345678, new Uint8Array(4)]]), 'second chunk that is not BIN'],
    ['two BIN chunks', glbOf([[JSON_TYPE, jsonBytes({})], [BIN_TYPE, new Uint8Array(4)], [BIN_TYPE, new Uint8Array(4)]]), 'more than a JSON and a BIN chunk'],
    ['no chunk at all', glbOf([]), 'does not start with its JSON chunk'],
  ])('refuses %s', (_name, bytes, why) => {
    expect(problem(bytes)).toContain(why);
  });

  it('refuses a chunk or chunk header that runs past the end', () => {
    const whole = glbOf([[JSON_TYPE, jsonBytes({ asset: {} })]]);
    const longer = whole.slice();
    new DataView(longer.buffer).setUint32(12, 4000, true);
    expect(problem(longer)).toBe('a GLB chunk runs past the end of the file');
    const tail = new Uint8Array(whole.length + 4);
    tail.set(whole);
    new DataView(tail.buffer).setUint32(8, tail.length, true);
    expect(problem(tail)).toBe('a GLB chunk header runs past the end of the file');
    expect(problem(whole.subarray(0, 8))).toBe('the GLB is truncated');
  });

  it.each([
    ['not glTF at all', new Uint8Array([0xff, 0xfe, 0x00, 0x01]), 'not valid UTF-8'],
    ['JSON that does not parse', glbOf([[JSON_TYPE, jsonBytes('{"asset":')]]), 'does not parse'],
    ['JSON that is not an object', glbOf([[JSON_TYPE, jsonBytes('[1,2]')]]), 'not an object'],
  ])('refuses %s', (_name, bytes, why) => {
    expect(problem(bytes)).toContain(why);
  });
});

describe('gltfStorageProblem: what the page would allocate', () => {
  it('charges every buffer view in full, overlapping ones included (loadBufferView copies each)', () => {
    const bin = new Uint8Array(900);
    const views = (n: number) => Array.from({ length: n }, () => ({ buffer: 0, byteLength: 900 }));
    // BIN 900 + 4 views of 900 = 4500: under 5000; one more is over
    expect(problem(glb({ buffers: [{ byteLength: 900 }], bufferViews: views(4) }, bin))).toBeNull();
    expect(problem(glb({ buffers: [{ byteLength: 900 }], bufferViews: views(5) }, bin))).toBe('the model needs more than 5000 bytes to load');
  });

  it('refuses buffers and views that do not fit what holds them', () => {
    expect(problem(glb({ buffers: [{ byteLength: 8 }] }, new Uint8Array(4)))).toBe('buffer 0 is longer than the BIN chunk');
    expect(problem(glb({ buffers: [{ byteLength: 4 }], bufferViews: [{ buffer: 0, byteOffset: 2, byteLength: 4 }] }, new Uint8Array(4)))).toBe('buffer view 0 runs past the end of its buffer');
    expect(problem(glb({ buffers: [{ byteLength: 4 }, { byteLength: 4 }] }, new Uint8Array(4)))).toBe('buffer 1 has no data');
    expect(problem(glb({ buffers: [{ byteLength: 4 }] }))).toBe('buffer 0 has no data');
    expect(problem(glb({ buffers: [{ byteLength: 400, uri: 'data:application/octet-stream;base64,AAAA' }] }))).toBe('buffer 0 is longer than its data: URI holds');
    // A buffer outside the file cannot be loaded by the page: nothing may view it
    expect(problem(glb({ buffers: [{ byteLength: 4, uri: 'thing.bin' }], bufferViews: [{ buffer: 0, byteLength: 4 }] }))).toBe('buffer view 0 runs past the end of its buffer');
    expect(problem(glb({ bufferViews: [{ buffer: 3, byteLength: 4 }] }))).toBe('buffer view 0 names no buffer');
  });

  it('charges a data: URI buffer at each step the page decodes it in, base64 and percent-encoded alike', () => {
    const budget = { ...small, singleBytes: 10_000, totalBytes: 100_000 };
    // 2400 base64 letters hold 1800 bytes: the text and its URI-decoded copy, the decoded text, the bytes
    const base64 = `data:application/octet-stream;base64,${'A'.repeat(2400)}`;
    expect(gltfCharge(glb({ buffers: [{ byteLength: 1800, uri: base64 }] }), budget)).toMatchObject({ charge: { bytes: 2400 + 2400 + 1800 + 1800, largest: 2400 } });
    // Not base64: each %XX decodes to one character, everything else to itself
    const percent = `data:,${'a'.repeat(190)}%00%01%02%03%04%05%06%07%08%09`;
    expect(gltfCharge(glb({ buffers: [{ byteLength: 200, uri: percent }] }), budget)).toMatchObject({ charge: { bytes: 220 + 220 + 200 } });
    expect(problem(glb({ buffers: [{ byteLength: 201, uri: percent }] }), budget)).toBe('buffer 0 is longer than its data: URI holds');
    expect(problem(glb({ buffers: [{ byteLength: 4, uri: 'data:application/octet-stream;base64' }] }), budget)).toBe('a data: URI has no comma');
  });

  it('passes a model with its buffer embedded as 20 MiB of base64, as its BIN twin passes', () => {
    const bytes = 20 * 1024 * 1024;
    const json = (buffer: Record<string, unknown>) => ({ buffers: [buffer], bufferViews: [{ buffer: 0, byteLength: bytes }], accessors: [accessor(bytes / 4, 'SCALAR', 5126, { bufferView: 0 })] });
    const uri = `data:application/octet-stream;base64,${Buffer.alloc(bytes).toString('base64')}`;
    const text = new TextEncoder().encode(JSON.stringify({ asset: { version: '2.0' }, ...json({ byteLength: bytes, uri }) }));
    const budget = modelBudget('model');
    expect(gltfStorageProblem(text, budget)).toBeNull();
    expect(gltfStorageProblem(glb(json({ byteLength: bytes }), new Uint8Array(bytes)), budget)).toBeNull();
  });

  it.each([
    // 84 × 3 × 4 = 1008
    ['one accessor over the single-allocation budget', [accessor(84)], 'accessor 0 needs 1008 bytes, more than 1000'],
    ['a matrix accessor (16 components)', [accessor(16, 'MAT4')], 'accessor 0 needs 1024 bytes'],
    ['accessors that add up', [accessor(80), accessor(80), accessor(80), accessor(80), accessor(80), accessor(80)], 'the model needs more than 5000 bytes'],
    ['a sparse part', [accessor(1, 'SCALAR', 5126, { sparse: { count: 200, indices: { bufferView: 0, componentType: 5121 }, values: { bufferView: 0 } } })], 'accessor 0 needs 1004 bytes'],
  ])('refuses %s', (_name, accessors, why) => {
    expect(problem(glb({ buffers: [{ byteLength: 4 }], bufferViews: [{ buffer: 0, byteLength: 4 }], accessors }, new Uint8Array(4)))).toContain(why);
  });

  it.each([
    ['an inherited name as the type', accessor(1, 'toString'), 'no usable count, type or component type'],
    ['an inherited name as the component type', accessor(1, 'VEC3', 'constructor' as unknown as number), 'no usable count, type or component type'],
    ['an unknown type', accessor(1, 'VEC5'), 'no usable count, type'],
    ['an unknown component type', accessor(1, 'VEC3', 5130), 'component type'],
    ['a fractional count', accessor(1.5), 'no usable count'],
    ['no count', { type: 'VEC3', componentType: 5126 }, 'no usable count'],
    ['a buffer view that does not exist', accessor(1, 'VEC3', 5126, { bufferView: 7 }), 'names no buffer view'],
    ['a sparse part with an inherited index type', accessor(1, 'VEC3', 5126, { sparse: { count: 1, indices: { bufferView: 0, componentType: 'valueOf' }, values: { bufferView: 0 } } }), 'sparse part'],
  ])('refuses an accessor with %s', (_name, entry, why) => {
    expect(problem(glb({ accessors: [entry] }))).toContain(why);
  });

  it('refuses accessors that run past their buffer view, stride included, and strides the spec does not allow', () => {
    const bin = new Uint8Array(120);
    const withView = (view: Record<string, unknown>, entry: Record<string, unknown>) => glb({ buffers: [{ byteLength: 120 }], bufferViews: [{ buffer: 0, byteLength: 120, ...view }], accessors: [entry] }, bin);
    // 10 VEC3 floats fill the view exactly; interleaved at a stride of 16 they need 9 × 16 + 12
    expect(problem(withView({}, accessor(10, 'VEC3', 5126, { bufferView: 0 })))).toBeNull();
    expect(problem(withView({}, accessor(10, 'VEC3', 5126, { bufferView: 0, byteOffset: 4 })))).toBe('accessor 0 runs past the end of its buffer view');
    expect(problem(withView({ byteStride: 16 }, accessor(7, 'VEC3', 5126, { bufferView: 0 })))).toBeNull();
    expect(problem(withView({ byteStride: 16 }, accessor(8, 'VEC3', 5126, { bufferView: 0 })))).toBe('accessor 0 runs past the end of its buffer view');
    expect(problem(withView({ byteStride: 8 }, accessor(1, 'VEC3', 5126, { bufferView: 0 })))).toBe("accessor 0 has elements larger than its view's byteStride");
    for (const byteStride of [2, 6, 256, 4.5]) expect(problem(withView({ byteStride }, accessor(1, 'SCALAR', 5126, { bufferView: 0 }))), String(byteStride)).toContain('byteStride that is not a multiple of 4');
  });

  it('charges a normalised animation output once per channel that uses it', () => {
    // 50 VEC4 bytes, normalised: 800 bytes as floats, per channel
    const json = (channels: number) => ({
      nodes: [{}],
      accessors: [accessor(50, 'SCALAR'), accessor(50, 'VEC4', 5121, { normalized: true })],
      animations: [{ samplers: [{ input: 0, output: 1 }], channels: Array.from({ length: channels }, () => ({ sampler: 0, target: { node: 0, path: 'rotation' } })) }],
    });
    const base = 200 + 200;
    expect(gltfCharge(glb(json(1)), small)).toMatchObject({ charge: { bytes: base + 800 } });
    expect(gltfCharge(glb(json(5)), small)).toMatchObject({ charge: { bytes: base + 4000 } });
    expect(problem(glb(json(6)))).toBe('the model needs more than 5000 bytes to load');
  });

  it('charges morph targets twice per mesh (the exporter clones and writes them), however many nodes show the mesh', () => {
    const json = (uses: number, targets = 1) => ({
      accessors: [accessor(10), ...Array.from({ length: targets }, () => accessor(10))],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, targets: Array.from({ length: targets }, (_, i) => ({ POSITION: i + 1 })) }] }],
      nodes: Array.from({ length: uses }, () => ({ mesh: 0 })),
      scenes: [{ nodes: Array.from({ length: uses }, (_, i) => i) }],
    });
    // accessors 120 each, the exported POSITION 120, the morph 2 × 120
    expect(gltfCharge(glb(json(1)), small)).toMatchObject({ charge: { bytes: 240 + 120 + 240 } });
    expect(gltfCharge(glb(json(40)), small)).toMatchObject({ charge: { bytes: 240 + 120 + 240, instances: 40 } });
    // 13 targets: 120 + 13 × 120 + 120 + 2 × 13 × 120 = 4920; 14 is over
    expect(problem(glb(json(1, 13)))).toBeNull();
    expect(problem(glb(json(1, 14)))).toBe('the model needs more than 5000 bytes to load');
  });

  it('refuses primitives the loader would give one geometry to (same indices, attributes and mode) that declare different morph targets', () => {
    const json = (second: Record<string, unknown>) => ({
      accessors: [accessor(1), accessor(1)],
      materials: [{}, {}],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, targets: [{ POSITION: 1 }], material: 0 }, { attributes: { POSITION: 0 }, material: 1, ...second }] }],
    });
    expect(problem(glb(json({})))).toBe('mesh 0 primitive 1 shares its geometry with another primitive but declares other morph targets');
    expect(problem(glb(json({ targets: [{ POSITION: 1 }] })))).toBeNull();
    // Another mode is another geometry
    expect(problem(glb(json({ mode: 1 })))).toBeNull();
  });

  it('charges an embedded image once per image and sampler, from each texture that uses it', () => {
    const bin = new Uint8Array(1000);
    const json = (samplers: number) => ({
      buffers: [{ byteLength: 1000 }],
      bufferViews: [{ buffer: 0, byteLength: 1000 }],
      images: [{ bufferView: 0, mimeType: 'image/png' }],
      samplers: Array.from({ length: samplers }, () => ({})),
      textures: [...Array.from({ length: samplers }, (_, sampler) => ({ source: 0, sampler })), { source: 0, sampler: 0 }],
    });
    // BIN 1000 + view 1000 + 1000 per sampler (the second texture on sampler 0 decodes nothing new)
    expect(gltfCharge(glb(json(1), bin), small)).toMatchObject({ charge: { bytes: 3000 } });
    expect(gltfCharge(glb(json(3), bin), small)).toMatchObject({ charge: { bytes: 5000 } });
    expect(problem(glb(json(4), bin))).toBe('the model needs more than 5000 bytes to load');
  });

  it('refuses a node that is a child twice, its own child, or its own ancestor (the page would build it without end)', () => {
    expect(problem(glb({ nodes: [{ children: [1, 1] }, {}] }))).toBe('node 1 has more than one parent');
    expect(problem(glb({ nodes: [{ children: [2] }, { children: [2] }, {}] }))).toBe('node 2 has more than one parent');
    expect(problem(glb({ nodes: [{ children: [0] }] }))).toBe('node 0 has more than one parent');
    expect(problem(glb({ nodes: [{ children: [1] }, { children: [2] }, { children: [0] }] }))).toContain('is its own ancestor');
    expect(problem(glb({ nodes: [{ children: [5] }] }))).toBe('node 0 has a child that names no node');
  });

  it('charges the bone and inverse matrices of each skinned mesh, three times (bones, the export, its written copy)', () => {
    const json = (joints: number, skinned: number) => ({
      accessors: [accessor(1)],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      skins: [{ joints: Array.from({ length: joints }, (_, i) => skinned + i) }],
      nodes: [...Array.from({ length: skinned }, () => ({ mesh: 0, skin: 0 })), ...Array.from({ length: joints }, () => ({}))],
      scenes: [{ nodes: Array.from({ length: skinned }, (_, i) => i) }],
    });
    // 12 + 12 for the accessor and its export, then 3 × 64 bytes per joint per skinned mesh
    expect(gltfCharge(glb(json(10, 1)), small)).toMatchObject({ charge: { bytes: 24 + 3 * 640 } });
    expect(gltfCharge(glb(json(10, 2)), small)).toMatchObject({ charge: { bytes: 24 + 6 * 640 } });
    expect(problem(glb(json(10, 3)))).toBe('the model needs more than 5000 bytes to load');
    // One skin of 16 joints is one 1024-byte allocation: over the single ceiling of 1000
    expect(problem(glb(json(16, 1)))).toBe('skin 0 bone matrices needs 1024 bytes, more than 1000');
  });

  it('bounds the work of binding skins (joints × skinned primitives)', () => {
    const joints = 2000;
    const primitives = Math.ceil(MODEL_LIMITS.work / joints) + 1;
    const json = {
      accessors: [accessor(1)],
      meshes: [{ primitives: Array.from({ length: primitives }, () => ({ attributes: { POSITION: 0 } })) }],
      skins: [{ joints: Array.from({ length: joints }, (_, i) => i + 1) }],
      nodes: [{ mesh: 0, skin: 0 }, ...Array.from({ length: joints }, () => ({}))],
      scenes: [{ nodes: [0] }],
    };
    expect(problem(glb(json), modelBudget('model'))).toContain(`need more than ${MODEL_LIMITS.work} steps`);
    expect(problem(glb({ ...json, meshes: [{ primitives: json.meshes[0].primitives.slice(0, 10) }] }), modelBudget('model'))).toBeNull();
  });

  it.each([
    ['nodes', { nodes: Array.from({ length: MODEL_LIMITS.nodes + 1 }, () => ({})) }],
    ['accessors', { accessors: Array.from({ length: MODEL_LIMITS.accessors + 1 }, () => accessor(0)) }],
    ['animations', { animations: Array.from({ length: MODEL_LIMITS.animations + 1 }, () => ({ channels: [], samplers: [] })) }],
    ['images', { images: Array.from({ length: MODEL_LIMITS.images + 1 }, () => ({ uri: 'x.png' })) }],
    ['cameras', { cameras: Array.from({ length: MODEL_LIMITS.cameras + 1 }, () => ({ type: 'perspective', perspective: { yfov: 1, znear: 0.1 } })) }],
    ['lights', { extensions: { KHR_lights_punctual: { lights: Array.from({ length: MODEL_LIMITS.lights + 1 }, () => ({ type: 'point' })) } } }],
  ])('refuses more %s than MODEL_LIMITS allows, however small they are', (key, json) => {
    expect(problem(glb(json), modelBudget('model'))).toContain(`more than ${(MODEL_LIMITS as Record<string, number>)[key]}`);
  });

  it.each([
    ['Draco, even when only used', { extensionsUsed: ['KHR_draco_mesh_compression'] }, 'no Draco decoder'],
    ['meshopt, required', { extensionsUsed: ['EXT_meshopt_compression'], extensionsRequired: ['EXT_meshopt_compression'] }, 'no meshopt decoder'],
    ['BasisU, required', { extensionsUsed: ['KHR_texture_basisu'], extensionsRequired: ['KHR_texture_basisu'] }, 'no KTX2 decoder'],
    ['an unknown extension, required', { extensionsUsed: ['EXT_made_up'], extensionsRequired: ['EXT_made_up'] }, 'requires the extension EXT_made_up, which the render page does not know'],
    ['an inherited name, required', { extensionsRequired: ['toString'] }, 'requires the extension toString'],
    ['extensions that are not names', { extensionsRequired: [1] }, 'not a list of names'],
  ])('refuses %s', (_name, json, why) => {
    expect(problem(glb(json))).toContain(why);
  });

  it('does not refuse extensions the page handles, nor meshopt or BasisU named as used but not required', () => {
    expect(problem(glb({ extensionsUsed: ['KHR_materials_unlit', 'KHR_texture_transform', 'VRM'], extensionsRequired: ['KHR_materials_unlit', 'KHR_mesh_quantization'] }))).toBeNull();
    expect(problem(glb({ extensionsUsed: ['EXT_meshopt_compression', 'KHR_texture_basisu'] }))).toBeNull();
  });

  it.each([
    ['no asset', {}],
    ['version 1.0', { asset: { version: '1.0' } }],
    ['version 3.0', { asset: { version: '3.0' } }],
    ['a version that is not a string', { asset: { version: 2 } }],
  ])('refuses a glTF with %s (the page refuses it too, after parsing)', (_name, json) => {
    expect(problem(glbOf([[JSON_TYPE, jsonBytes(json)]]))).toBe('the glTF asset.version is not 2.x');
  });

  it('refuses JSON nested deeper than MODEL_LIMITS.jsonDepth, before parsing it, and passes the depth just under it', () => {
    const nested = (depth: number) => `{"asset":{"version":"2.0"},"extras":${'['.repeat(depth - 1)}${']'.repeat(depth - 1)}}`;
    const parse = vi.spyOn(JSON, 'parse');
    expect(problem(glbOf([[JSON_TYPE, jsonBytes(nested(MODEL_LIMITS.jsonDepth + 1))]]))).toBe(`the glTF JSON nests deeper than ${MODEL_LIMITS.jsonDepth}`);
    expect(parse).not.toHaveBeenCalled();
    parse.mockRestore();
    expect(problem(glbOf([[JSON_TYPE, jsonBytes(nested(MODEL_LIMITS.jsonDepth))]]))).toBeNull();
    // Brackets inside strings are text
    expect(problem(glb({ extras: '['.repeat(1000) }))).toBeNull();
  });

  it('refuses JSON larger than MODEL_LIMITS.jsonBytes without its data: URIs, before parsing it', () => {
    const parse = vi.spyOn(JSON, 'parse');
    expect(problem(glb({ extras: 'x'.repeat(MODEL_LIMITS.jsonBytes) }))).toBe(`the glTF JSON is larger than ${MODEL_LIMITS.jsonBytes} bytes (without its data: URIs)`);
    expect(parse).not.toHaveBeenCalled();
    parse.mockRestore();
  });

  it('refuses extras and unknown-extension payloads that, with the copies made of them, come to more than MODEL_LIMITS.metadataBytes', () => {
    // One mesh with 100,000 zeros of extras, shown by n nodes: copied per primitive, per instance, and by the export
    const json = (uses: number) => ({
      accessors: [accessor(1)],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }], extras: new Array(100_000).fill(0) }],
      nodes: Array.from({ length: uses }, () => ({ mesh: 0 })),
      scenes: [{ nodes: Array.from({ length: uses }, (_, i) => i) }],
    });
    const budget = modelBudget('model');
    expect(problem(glb(json(10)), budget)).toBeNull();
    expect(problem(glb(json(2000)), budget)).toContain(`come to more than ${MODEL_LIMITS.metadataBytes} bytes (mesh 0)`);
    // An unknown extension's data counts the same way
    const extension = { ...json(2000), meshes: [{ primitives: [{ attributes: { POSITION: 0 } }], extensions: { EXT_unknown: { blob: 'x'.repeat(100_000) } } }] };
    expect(problem(glb(extension), budget)).toContain('(mesh 0)');
    // ...and one the loader handles itself is not copied into userData
    expect(problem(glb({ ...extension, meshes: [{ primitives: [{ attributes: { POSITION: 0 } }], extensions: { KHR_materials_unlit: { blob: 'x'.repeat(100_000) } } }] }), budget)).toBeNull();
  });

  it('caps the mesh instances the scenes expand to, and the tracks animations generate, however small the data', () => {
    const budget = modelBudget('model');
    // One mesh of 1,000 primitives shown by 101 nodes: 101,000 instances
    const instances = (nodes: number) => ({
      accessors: [accessor(1)],
      meshes: [{ primitives: Array.from({ length: 1000 }, (_, i) => ({ attributes: { POSITION: 0 }, mode: i % 2 })) }],
      nodes: Array.from({ length: nodes }, () => ({ mesh: 0 })),
      scenes: [{ nodes: Array.from({ length: nodes }, (_, i) => i) }],
    });
    expect(problem(glb(instances(100)), budget)).toBeNull();
    expect(problem(glb(instances(101)), budget)).toBe(`the model's scenes show more than ${MODEL_LIMITS.instances} mesh instances`);
    // "weights" channels make one track per primitive under their node
    const tracks = (channels: number) => ({
      accessors: [accessor(1, 'SCALAR'), accessor(1, 'SCALAR')],
      meshes: [{ primitives: Array.from({ length: 1000 }, (_, i) => ({ attributes: { POSITION: 0 }, mode: i % 2 })) }],
      nodes: [{ mesh: 0 }],
      animations: [{ samplers: [{ input: 0, output: 1 }], channels: Array.from({ length: channels }, () => ({ sampler: 0, target: { node: 0, path: 'weights' } })) }],
    });
    expect(problem(glb(tracks(100)), budget)).toBeNull();
    expect(problem(glb(tracks(101)), budget)).toBe(`the model's animations make more than ${MODEL_LIMITS.tracks} tracks`);
  });

  it('estimates the export (written accessors, morphs and skins, and the JSON) and refuses one larger than exportBytes', () => {
    const bin = new Uint8Array(600);
    // Ten attributes over one shared view: each is written to the export on its own
    const json = (attributes: number) => ({
      buffers: [{ byteLength: 600 }],
      bufferViews: [{ buffer: 0, byteLength: 600 }],
      accessors: Array.from({ length: attributes }, () => accessor(50, 'VEC3', 5126, { bufferView: 0 })),
      meshes: [{ primitives: [{ attributes: Object.fromEntries(Array.from({ length: attributes }, (_, i) => [`_A${i}`, i])) }] }],
    });
    const budget = { singleBytes: 1000, totalBytes: 1_000_000, exportBytes: 7000 };
    expect(gltfCharge(glb(json(10), bin), budget)).toMatchObject({ charge: { exportBytes: expect.any(Number) } });
    expect(problem(glb(json(10), bin), budget)).toBeNull();
    expect(problem(glb(json(12), bin), budget)).toMatch(/^the model's export would be about \d+ bytes, more than 7000$/);
  });

  it.each([
    ['a camera that does not exist', { nodes: [{ camera: 0 }] }, 'node 0 names no camera'],
    ['a light that does not exist', { nodes: [{ extensions: { KHR_lights_punctual: { light: 3 } } }] }, 'node 0 names no light'],
    ['a material that does not exist', { accessors: [accessor(1)], meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 2 }] }] }, 'names no material'],
    ['a sampler that does not exist', { images: [{ uri: 'x.png' }], textures: [{ source: 0, sampler: 4 }] }, 'texture 0 names no sampler'],
    ['a default scene that does not exist', { scene: 1, scenes: [{}] }, 'the glTF scene names no scene'],
    ['a skeleton that does not exist', { skins: [{ joints: [], skeleton: 9 }] }, 'skin 0 names no skeleton node'],
  ])('refuses %s', (_name, json, why) => {
    expect(problem(glb(json))).toContain(why);
  });

  it.each([
    ['a triangle strip', 5],
    ['a triangle fan', 6],
  ])('refuses %s (the loader converts it with arrays of its own; nothing the agent loads uses one)', (_name, mode) => {
    expect(problem(glb({ accessors: [accessor(3)], meshes: [{ primitives: [{ attributes: { POSITION: 0 }, mode }] }] }))).toContain('is a triangle strip or fan');
  });

  it('refuses legacy animation.parameters and animation data in an interleaved view', () => {
    const base = { nodes: [{}], accessors: [accessor(1, 'SCALAR'), accessor(1, 'SCALAR')] };
    expect(problem(glb({ ...base, animations: [{ parameters: { a: 1 }, samplers: [{ input: 0, output: 1 }], channels: [{ sampler: 0, target: { node: 0, path: 'translation' } }] }] }))).toBe('animation 0 uses the legacy "parameters"');
    const interleaved = glb(
      {
        nodes: [{}],
        buffers: [{ byteLength: 16 }],
        bufferViews: [{ buffer: 0, byteLength: 16, byteStride: 8 }],
        accessors: [accessor(1, 'SCALAR'), accessor(2, 'SCALAR', 5121, { bufferView: 0, normalized: true })],
        animations: [{ samplers: [{ input: 0, output: 1 }], channels: [{ sampler: 0, target: { node: 0, path: 'translation' } }] }],
      },
      new Uint8Array(16)
    );
    expect(problem(interleaved)).toBe('animation 0 channel 0 output is in an interleaved buffer view');
  });

  it('rejects a third chunk where it starts, without reading the rest of the file', () => {
    const chunks: [number, Uint8Array][] = [[JSON_TYPE, jsonBytes({ asset: { version: '2.0' } })], [BIN_TYPE, new Uint8Array(4)], ...Array.from({ length: 1000 }, (): [number, Uint8Array] => [0x12345678, new Uint8Array(0)])];
    expect(problem(glbOf(chunks))).toBe('the GLB has more than a JSON and a BIN chunk');
  });

  it('passes ordinary shapes: several root nodes, shared materials, a joint in two skins, a .gltf text file', () => {
    const shapes = {
      accessors: [accessor(3)],
      materials: [{ name: 'shared' }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }, { primitives: [{ attributes: { POSITION: 0 }, indices: undefined, material: 0, mode: 1 }] }],
      skins: [{ joints: [3, 4] }, { joints: [4, 5] }],
      nodes: [{ mesh: 0, skin: 0 }, { mesh: 1, skin: 1 }, { mesh: 0 }, {}, { children: [5] }, {}],
      scenes: [{ nodes: [0, 1, 2, 3, 4] }],
      scene: 0,
    };
    expect(problem(glb(shapes))).toBeNull();
    expect(problem(new TextEncoder().encode(JSON.stringify({ asset: { version: '2.1' }, ...shapes })))).toBeNull();
  });

  it('budgets each kind relative to its download cap', () => {
    expect(modelBudget('model')).toEqual({ singleBytes: MAX_MODEL_BYTES, totalBytes: 8 * MAX_MODEL_BYTES, exportBytes: 4 * MAX_MODEL_BYTES });
    expect(modelBudget('avatar')).toEqual(modelBudget('model'));
    expect(modelBudget('emote')).toEqual({ singleBytes: MAX_EMOTE_BYTES, totalBytes: 8 * MAX_EMOTE_BYTES, exportBytes: 4 * MAX_EMOTE_BYTES });
  });
});

describe('the bundled models load under their budgets', () => {
  const root = path.join(__dirname, '../public');
  const bundled: [string, 'model' | 'avatar' | 'emote'][] = [
    ['avatars/avatar.vrm', 'avatar'],
    ['assets/base-environment.glb', 'model'],
    ...readdirSync(path.join(root, 'emotes'))
      .filter((name) => name.endsWith('.glb'))
      .map((name): [string, 'emote'] => [`emotes/${name}`, 'emote']),
  ];

  it.each(bundled)('%s (as %s) is charged well under its limits', (file, kind) => {
    const budget = modelBudget(kind);
    const result = gltfCharge(new Uint8Array(readFileSync(path.join(root, file))), budget);
    expect(result).toHaveProperty('charge');
    if (!('charge' in result)) return;
    expect(result.charge.bytes).toBeLessThan(budget.totalBytes / 10);
    expect(result.charge.largest).toBeLessThan(budget.singleBytes / 10);
    expect(result.charge.work).toBeLessThan(MODEL_LIMITS.work / 1000);
  });
});
