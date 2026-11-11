import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
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
const small: ModelBudget = { singleBytes: 1000, totalBytes: 5000, exportBytes: 5000 };
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
    expect(problem(glb({ buffers: [{ byteLength: 400, uri: 'data:application/octet-stream;base64,AAAA' }] }))).toBe('buffer 0 is longer than its data: URI');
    // A buffer outside the file cannot be loaded by the page: nothing may view it
    expect(problem(glb({ buffers: [{ byteLength: 4, uri: 'thing.bin' }], bufferViews: [{ buffer: 0, byteLength: 4 }] }))).toBe('buffer view 0 runs past the end of its buffer');
    expect(problem(glb({ bufferViews: [{ buffer: 3, byteLength: 4 }] }))).toBe('buffer view 0 names no buffer');
  });

  it('charges a data: URI buffer twice its length', () => {
    const uri = `data:application/octet-stream;base64,${'A'.repeat(2400)}`;
    expect(gltfCharge(glb({ buffers: [{ byteLength: 1800, uri }] }), { ...small, singleBytes: 10_000 })).toEqual({ charge: { bytes: 2 * uri.length, largest: 2 * uri.length, work: 0 } });
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

  it('charges morph targets per node that uses the mesh, twice each (the exporter clones and serialises them)', () => {
    const json = (uses: number) => ({
      accessors: [accessor(10), accessor(10)],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, targets: [{ POSITION: 1 }] }] }],
      nodes: Array.from({ length: uses }, () => ({ mesh: 0 })),
      scenes: [{ nodes: Array.from({ length: uses }, (_, i) => i) }],
    });
    // accessors 120 + 120, the exported POSITION 120, then 240 per use
    expect(gltfCharge(glb(json(1)), small)).toMatchObject({ charge: { bytes: 360 + 240 } });
    expect(gltfCharge(glb(json(10)), small)).toMatchObject({ charge: { bytes: 360 + 2400 } });
    expect(problem(glb(json(20)))).toBe('the model needs more than 5000 bytes to load');
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

  it('passes extensions the page handles, and meshopt or BasisU used without being required (the page uses the fallback)', () => {
    expect(problem(glb({ extensionsUsed: ['KHR_materials_unlit', 'KHR_texture_transform', 'VRM'], extensionsRequired: ['KHR_materials_unlit', 'KHR_mesh_quantization'] }))).toBeNull();
    expect(problem(glb({ extensionsUsed: ['EXT_meshopt_compression', 'KHR_texture_basisu'] }))).toBeNull();
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
