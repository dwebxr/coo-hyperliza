import { describe, expect, it } from 'vitest';
import { isBlueprintURL, sanitizeBlueprintAdd, sanitizeEntityAdd } from './world-add-policy';

/*
 * One case per rule mirrored from coo-world (src/core/extras/blueprintPolicy.js,
 * entityModifyPolicy.js, assetURL.js, chatPolicy.js). The same inputs were run through coo-world's
 * own functions, with the same outcome (the fix10 scratch differential).
 */

const base = { id: 'bp1', version: 0 };
const nested = (levels: number): unknown => (levels === 0 ? null : { a: nested(levels - 1) });

describe('sanitizeBlueprintAdd', () => {
  it.each<[string, unknown, string]>([
    ['not a plain object (:49)', [base], 'it is not a plain object'],
    ['an id that is not text of 1 to 64 characters (:67)', { ...base, id: 'x'.repeat(65) }, 'its id is not text of 1 to 64 characters'],
    ['an empty id (:67)', { ...base, id: '' }, 'its id is not text of 1 to 64 characters'],
    ['a version that is not a whole number of 0 or more (:70)', { ...base, version: 1.5 }, 'its version is not a whole number of 0 or more'],
    ['a negative version (:70)', { ...base, version: -1 }, 'its version is not a whole number of 0 or more'],
    ['a flag that is not a boolean (:73)', { ...base, unique: 1 }, 'its unique is not true or false'],
    ['props that are an array (:77)', { ...base, props: [1] }, 'its props is not an object'],
    ['an image that is a string (:77)', { ...base, image: 'asset://a.png' }, 'its image is not an object'],
    ['props nested 16 deep below the props (:23)', { ...base, props: nested(16) }, 'its props nests deeper than 16 levels'],
    ['props of more than 8,192 values and keys (:23, :38)', { ...base, props: { list: new Array(8190).fill(0) } }, 'its props holds more than 8192 values and keys'],
    ['props holding a value that is not JSON (:27)', { ...base, props: { at: new Date(0) } }, 'its props holds a value that is not plain JSON'],
    ['props holding a non-finite number (:25)', { ...base, props: { n: Number.NaN } }, 'its props holds a value that is not plain JSON'],
    ['props with a symbol key (:28)', { ...base, props: { [Symbol('s')]: 1 } }, 'its props holds a symbol key'],
    ["an image url that is a path (:79, assetURL.js:130)", { ...base, image: { url: '/x.png' } }, 'its image names a file that is not an asset or an http(s) URL'],
    ['a text field that is not text (:85)', { ...base, name: 5 }, 'its name is not text'],
    ['a model that is a data: URL (:88)', { ...base, model: 'data:model/gltf-binary;base64,AA==' }, 'its model names a file that is not an asset or an http(s) URL'],
    ['a script that is an asset path (:88, assetURL.js:8)', { ...base, script: 'asset://a/b.js' }, 'its script names a file that is not an asset or an http(s) URL'],
    ['no version (:91)', { id: 'bp1' }, 'it has no id or version'],
    ['a null id (:63, then :91)', { id: null, version: 0 }, 'it has no id or version'],
  ])('refuses %s', (_what, data, problem) => {
    expect(sanitizeBlueprintAdd(data)).toEqual({ ok: false, problem: `the world would refuse the blueprint: ${problem}` });
  });

  it('keeps what the world keeps, as it stores it: unknown fields and undefined values dropped, text cut between grapheme clusters, props copied', () => {
    const data = {
      ...base,
      name: 'n'.repeat(255) + '👩‍💻',
      desc: null,
      model: 'asset://abc.glb',
      script: 'https://cdn.example.com/a.js',
      image: { url: null },
      props: { deep: nested(14), list: [1, undefined, 'x'], gone: undefined },
      preload: true,
      mystery: 'dropped',
      author: undefined,
      scene: false,
    };
    const result = sanitizeBlueprintAdd(data);
    expect(result).toEqual({
      ok: true,
      value: { ...base, name: 'n'.repeat(255), desc: null, model: 'asset://abc.glb', script: 'https://cdn.example.com/a.js', image: { url: null }, props: { deep: nested(14), list: [1, null, 'x'] }, preload: true, scene: false },
    });
    // A copy: what is announced is not the object the agent holds
    expect((result as { value: Record<string, unknown> }).value.props).not.toBe(data.props);
    // At the limits: 15 levels below the props, and 8,192 values and keys in all (the props, the
    // key "list", the list and its 8,189 elements)
    expect(sanitizeBlueprintAdd({ ...base, props: nested(15) }).ok).toBe(true);
    expect(sanitizeBlueprintAdd({ ...base, props: { list: new Array(8189).fill(0) } }).ok).toBe(true);
  });
});

describe('isBlueprintURL (assetURL.js:130)', () => {
  it('takes one file of the asset store or an http(s) URL with the literal lower-case prefix, and nothing else', () => {
    for (const url of ['asset://abc.glb', 'asset://avatar.vrm', 'https://cdn.example.com/a.glb', 'http://world.test:3000/assets/a.glb']) expect(isBlueprintURL(url), url).toBe(true);
    for (const url of ['asset://..', 'asset://a/b.glb', 'asset://', 'HTTPS://cdn.example.com/a.glb', 'https:/x', 'ftp://x/a.glb', '/assets/a.glb', 'data:,x', 5, null]) expect(isBlueprintURL(url), String(url)).toBe(false);
  });
});

describe('sanitizeEntityAdd', () => {
  const app = { id: 'app1', type: 'app', blueprint: 'bp1', position: [0, 1, 2], quaternion: [0, 0, 0, 1], scale: [1, 1, 1], mover: null, uploader: 'coo', pinned: false, state: {} };

  it.each<[string, unknown, string]>([
    ['not a plain object (:295)', null, 'it is not a plain object'],
    ['not an app (:296)', { ...app, type: 'player' }, 'it is not an app'],
    ['an id with other characters (:290, :299)', { ...app, id: 'a b' }, 'its id is not 1 to 64 letters, digits, _ or -'],
    ['an id that is taken (:299)', app, 'its id is taken'],
    ['a blueprint that does not exist (:300)', { ...app, blueprint: 'nope' }, 'its blueprint does not exist'],
    ['a position beyond ±1e6 (:301)', { ...app, position: [0, 2e6, 0] }, 'its position is not three finite numbers within ±1e6'],
    ['a quaternion not of length 1 (:302)', { ...app, quaternion: [0, 0, 0, 2] }, 'its quaternion is not four finite numbers of length 1 (±0.1)'],
    ['a scale a 32-bit float makes zero (:303)', { ...app, scale: [1e-50, 1, 1] }, 'its scale is not three numbers, none of them zero'],
  ])('refuses %s', (_what, data, problem) => {
    const options = { blueprintExists: (id: string) => id === 'bp1', entityExists: (id: string) => _what.includes('taken') && id === 'app1' };
    expect(sanitizeEntityAdd(data, 'coo', options)).toEqual({ ok: false, problem: `the world would refuse the app: ${problem}` });
  });

  it('stores the quaternion normalised, a mover or uploader other than the sender as null, pinned only when true, and a state that is not small JSON as {} (:305-319)', () => {
    expect(sanitizeEntityAdd({ ...app, quaternion: [0, 0, 0, 1.05], mover: 'someone', uploader: 'else', pinned: 'yes', state: { big: 'x'.repeat(9000) }, extra: 1 }, 'coo')).toEqual({
      ok: true,
      value: { ...app, quaternion: [0, 0, 0, 1], mover: null, uploader: null, pinned: false, state: {} },
    });
    expect(sanitizeEntityAdd({ ...app, pinned: true, state: { open: true } }, 'coo')).toEqual({ ok: true, value: { ...app, pinned: true, state: { open: true } } });
  });
});
