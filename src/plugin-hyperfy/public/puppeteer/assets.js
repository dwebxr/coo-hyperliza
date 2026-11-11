/*
 * How assets get into the render page and how the world's scene is rebuilt in it. The agent
 * downloads every asset itself (under its network policy) and passes the bytes in as base64;
 * nothing here takes a URL to load. A model that refers to a file outside itself (a .gltf with
 * separate buffers or images) gets nothing for it, and fails to load or is drawn without it: the
 * page cannot make requests.
 *
 * Called from managers/puppeteer-manager.ts through window.agentPage.
 */

// What the page keeps between snapshots, least recently used first. Beyond these, the oldest is
// dropped and its GPU memory freed: a material that still names a dropped texture is drawn
// without it, and a player whose avatar was dropped is not drawn, until the page is rebuilt (on
// the next connection).
const LIMITS = { textures: 1024, avatars: 32 };

const texturesMap = (window.texturesMap = new Map()); // `${materialId}:${slot}` -> THREE.Texture
const avatarMap = (window.avatarMap = new Map()); // avatar URL -> VRM factory
window.activeVRMInstances = [];

// How to take back what a recent load kept, by the operation id the agent passed with it: the agent
// calls undo(op) when the world the load was for went away while it ran. Only the latest are kept.
const undoable = new Map();
const UNDO_KEPT = 64;
function keepUndo(op, undoIt) {
  if (op !== undefined) remember(undoable, op, undoIt, UNDO_KEPT, () => {});
}
function undo(op) {
  const undoIt = undoable.get(op);
  undoable.delete(op);
  if (undoIt) undoIt();
}
/** Drops the texture under `key` and frees it, if it is still the one this load put there */
function forgetTexture(key, texture) {
  if (texturesMap.get(key) === texture) texturesMap.delete(key);
  texture.dispose();
}

function remember(map, key, value, limit, drop) {
  map.delete(key);
  map.set(key, value);
  while (map.size > limit) {
    const [oldest, dropped] = map.entries().next().value;
    map.delete(oldest);
    drop(dropped);
  }
}

/** The entry for `key`, marked as just used */
function recall(map, key) {
  const value = map.get(key);
  if (value !== undefined) {
    map.delete(key);
    map.set(key, value);
  }
  return value;
}

// crypto.randomUUID() only exists in a secure context, which a page written into about:blank is not
function uuid() {
  const b = window.crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = Array.from(b, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function bytesOf(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function base64Of(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

// From memory: with no base path, a URI inside the file that points outside it resolves to nothing
const parseGltf = (loader, bytes) => new Promise((resolve, reject) => loader.parse(bytes.buffer, '', resolve, reject));

const exportGlb = (scene) => new Promise((done) => new window.GLTFExporter().parse(scene, done, { binary: true, embedImages: true }));

/** The exported model as base64, refused (before it is encoded) when larger than `maxBytes` */
function exportedBase64(glb, maxBytes) {
  if (!(Number.isSafeInteger(maxBytes) && maxBytes > 0)) throw new Error('no export budget given');
  if (glb.byteLength > maxBytes) throw new Error(`the exported model is ${glb.byteLength} bytes, more than ${maxBytes}`);
  return base64Of(glb);
}

const texturesOf = (material) => Object.values(material).filter((value) => value && value.isTexture);

/** Frees the GPU memory of everything under `root`, except the textures in `keep` */
function disposeTree(root, keep) {
  root.traverse((obj) => {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.skeleton) obj.skeleton.dispose();
    if (obj.isLight && obj.shadow) obj.shadow.dispose();
    const materials = Array.isArray(obj.material) ? obj.material : obj.material ? [obj.material] : [];
    for (const material of materials) {
      for (const texture of texturesOf(material)) if (!keep.has(texture)) texture.dispose();
      material.dispose();
    }
  });
}

/**
 * Parses a GLB, keeps its textures here under an id written into each material, and returns the
 * model without them (base64 GLB): the agent's own copy of the scene carries the ids, and
 * rehydrate() puts the textures back for drawing.
 */
async function loadGlb(base64, stripSlots, maxExportBytes, op) {
  const gltf = await parseGltf(new window.GLTFLoader(), bytesOf(base64));
  const kept = [];

  gltf.scene.traverse(obj => {
    if (!obj.isMesh || !obj.material) return;

    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];

    mats.forEach(mat => {
      if (!mat.userData.materialId) {
        mat.userData.materialId = uuid();
      }
      const id = mat.userData.materialId;

      stripSlots.forEach(slot => {
        const tex = mat[slot];
        if (tex && tex.isTexture) {
          remember(texturesMap, `${id}:${slot}`, tex, LIMITS.textures, (dropped) => dropped.dispose());
          kept.push([`${id}:${slot}`, tex]);
          mat[slot] = null;
        }
      });

      mat.needsUpdate = true;
    });
  });

  const takeBack = () => {
    for (const [key, texture] of kept) forgetTexture(key, texture);
    disposeTree(gltf.scene, new Set());
  };
  try {
    const glb = exportedBase64(await exportGlb(gltf.scene), maxExportBytes);
    keepUndo(op, takeBack);
    return glb;
  } catch (error) {
    // Refused: its textures are not kept either
    takeBack();
    throw error;
  }
}

/** Parses a VRM, keeps a factory for it under `key` (the avatar's URL), and returns it as a GLB (at most `maxExportBytes`). */
async function loadVrm(key, base64, maxExportBytes, op) {
  const gltf = await parseGltf(window.VRMLoader, bytesOf(base64));
  const factory = window.createVRMFactory(gltf, (m) => m);

  window.renderer.render(window.scene, window.camera);

  // Instances share the avatar's geometry, materials and textures; all of it goes when the avatar does
  factory.dispose = () => disposeTree(gltf.scene, new Set());
  remember(avatarMap, key, factory, LIMITS.avatars, (dropped) => dropped.dispose());

  const takeBack = () => {
    if (avatarMap.get(key) === factory) avatarMap.delete(key);
    factory.dispose();
  };
  try {
    const glb = exportedBase64(await exportGlb(gltf.scene), maxExportBytes);
    keepUndo(op, takeBack);
    return glb;
  } catch (error) {
    // Refused: the avatar is not kept either
    takeBack();
    throw error;
  }
}

/**
 * Decodes an image and keeps it as a texture under a new id, which is returned. `sourceUrl` is
 * where the agent got the image: three's TextureLoader picks the texture format from the URL it
 * loads, and the URL it loads here is a blob: one, so the same rule is applied to the real one.
 */
async function registerTexture(base64, contentType, slot, sourceUrl, op) {
  const blobUrl = URL.createObjectURL(new Blob([bytesOf(base64)], { type: contentType }));
  let texture;
  try {
    texture = await new Promise((resolve, reject) => {
      window.TextureLoader.load(
        blobUrl,
        tex => resolve(tex),
        undefined,
        err => reject(err)
      );
    });
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
  const isJPEG = sourceUrl.search(/\.jpe?g($|\?)/i) > 0 || sourceUrl.search(/^data\:image\/jpeg/) === 0;
  texture.format = isJPEG ? window.THREE.RGBFormat : window.THREE.RGBAFormat;
  texture.needsUpdate = true;

  const id = uuid();
  remember(texturesMap, `${id}:${slot}`, texture, LIMITS.textures, (dropped) => dropped.dispose());
  keepUndo(op, () => forgetTexture(`${id}:${slot}`, texture));

  return id;
}

/**
 * An .hdr file as the texture RGBELoader.load() would give for it. That method only takes a URL,
 * so this is what it (and DataTextureLoader.load under it) does with the bytes once they arrive,
 * step for step, in three.js 0.132.2.
 */
function hdrTexture(buffer) {
  const THREE = window.THREE;
  const texData = new window.RGBELoader().parse(buffer);
  const texture = new THREE.DataTexture();

  if (texData.image !== undefined) {
    texture.image = texData.image;
  } else if (texData.data !== undefined) {
    texture.image.width = texData.width;
    texture.image.height = texData.height;
    texture.image.data = texData.data;
  }

  texture.wrapS = texData.wrapS !== undefined ? texData.wrapS : THREE.ClampToEdgeWrapping;
  texture.wrapT = texData.wrapT !== undefined ? texData.wrapT : THREE.ClampToEdgeWrapping;
  texture.magFilter = texData.magFilter !== undefined ? texData.magFilter : THREE.LinearFilter;
  texture.minFilter = texData.minFilter !== undefined ? texData.minFilter : THREE.LinearFilter;
  texture.anisotropy = texData.anisotropy !== undefined ? texData.anisotropy : 1;
  if (texData.encoding !== undefined) texture.encoding = texData.encoding;
  if (texData.flipY !== undefined) texture.flipY = texData.flipY;
  if (texData.format !== undefined) texture.format = texData.format;
  if (texData.type !== undefined) texture.type = texData.type;
  if (texData.mipmaps !== undefined) {
    texture.mipmaps = texData.mipmaps;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
  }
  if (texData.mipmapCount === 1) texture.minFilter = THREE.LinearFilter;
  if (texData.generateMipmaps !== undefined) texture.generateMipmaps = texData.generateMipmaps;
  texture.needsUpdate = true;

  switch (texture.type) {
    case THREE.UnsignedByteType:
      texture.encoding = THREE.RGBEEncoding;
      texture.minFilter = THREE.NearestFilter;
      texture.magFilter = THREE.NearestFilter;
      texture.generateMipmaps = false;
      texture.flipY = true;
      break;
    case THREE.FloatType:
    case THREE.HalfFloatType:
      texture.encoding = THREE.LinearEncoding;
      texture.minFilter = THREE.LinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.generateMipmaps = false;
      texture.flipY = true;
      break;
  }
  return texture;
}

function loadEnvironmentHDR(base64, op) {
  const previous = window.environment;
  const hdr = hdrTexture(bytesOf(base64).buffer);

  window.environment = hdr;
  window.scene.environment = hdr;
  window.scene.background = hdr;

  window.renderer.render(window.scene, window.camera);
  if (previous && previous !== hdr) previous.dispose();
  // Taken back, the page has no environment until the next one is set
  keepUndo(op, () => {
    if (window.environment !== hdr) return;
    window.environment = null;
    window.scene.environment = null;
    window.scene.background = null;
    hdr.dispose();
  });
}

/**
 * Replaces the page's scene with the agent's current one (`sceneJson`, three's JSON format): the
 * textures kept here go back onto the materials that name them, and each player with a known
 * avatar gets an instance of it. The scene it replaces is freed.
 */
function rehydrate(sceneJson, stripSlots, players) {
  const THREE = window.THREE;
  const loader = new window.THREE.ObjectLoader();
  const loadedScene = loader.parse(sceneJson);

  // Rehydrate materials
  loadedScene.traverse(obj => {
    if (!obj.isMesh || !obj.material) return;

    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];

    mats.forEach(mat => {
      const id = mat.userData.materialId;
      if (!id) return;

      stripSlots.forEach(slot => {
        const key = `${id}:${slot}`;
        const tex = recall(texturesMap, key);
        if (tex && tex.isTexture) mat[slot] = tex;
      });

      mat.needsUpdate = true;
    });
  });

  // Rehydrate player avatars
  for (const inst of window.activeVRMInstances) {
    try {
      inst.destroy();
    } catch (e) {
      console.warn('[AgentLoader] Failed to destroy instance:', e);
    }
  }
  window.activeVRMInstances = [];

  // The instances are out of the previous scene now; what is left in it was made for it alone,
  // except the textures kept here and the environment
  const previous = window.scene;
  if (previous && previous !== loadedScene) {
    const kept = new Set(texturesMap.values());
    if (window.environment) kept.add(window.environment);
    disposeTree(previous, kept);
  }

  players.forEach(player => {
    if (!player.avatarUrl) return;
    const factory = recall(avatarMap, player.avatarUrl);
    if (!factory) return;

    const vrmHooks = {
      camera: window.camera,
      scene: loadedScene,
      octree: null,
      setupMaterial: () => {},
      loader: window.VRMLoader,
    }
    const instance = factory.create(new THREE.Matrix4(), vrmHooks, (m) => m);

    const position = new THREE.Vector3(...player.position);
    const rotation = new THREE.Quaternion(...player.quaternion);
    const scale = new THREE.Vector3(...player.scale);

    const matrix = new THREE.Matrix4();
    matrix.compose(position, rotation, scale);
    instance.move(matrix);

    window.activeVRMInstances.push(instance);
  });

  // Rehydrate environment
  if (window.environment) {
    loadedScene.environment = window.environment;
    loadedScene.background = window.environment;
  }

  window.scene = loadedScene;
  window.renderer.render(window.scene, window.camera);
}

window.agentPage = { LIMITS, loadGlb, loadVrm, registerTexture, loadEnvironmentHDR, hdrTexture, rehydrate, undo };
