#!/usr/bin/env node
/*
 * Render-page smoke: the agent's real PuppeteerManager and the real render page in a real headless
 * Chromium, fed the bundled avatar, an emote, the base environment, the sky image and the HDR from
 * memory. It checks that every kind of snapshot comes out as a picture with something in it, and
 * that Chromium has no way to the network: not the page, not the browser itself, not even to this
 * machine's own ports.
 *
 *   node scripts/smoke-chromium.mjs --dir <empty scratch directory outside the repository> [--keep]
 *
 * Run it by hand after touching the render page, the manager, puppeteer or Chromium; it is not
 * part of `bun run test`. It needs the Chromium that puppeteer installed (~/.cache/puppeteer).
 * It sends nothing off this machine and starts neither the agent nor the engine: the manager is
 * bundled into the scratch directory on its own, and the "world" is a small three.js scene built
 * here (the base environment and a sky sphere), not what a live world's Stage produces.
 *
 * Chromium's sockets are sampled with lsof every 150 ms: a connection shorter than that would not
 * be seen. The other checks do not depend on timing (a local server that must never be reached).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import * as THREE from 'three';
import { buildRenderPage } from './build-assets.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assets = path.join(repo, 'src/plugin-hyperfy/public');
const args = process.argv.slice(2);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The player whose avatar the snapshots must show; the key is what the loader would register it under */
export const VISITOR_AVATAR_URL = 'https://world.invalid/assets/avatar.vrm';

/**
 * The agent's own copy of a model: parsed in Node by the engine's GLTF loader from the GLB the
 * render page hands back (textures removed, material ids kept), as systems/loader.ts does.
 */
export async function parseStrippedGlb(bytes) {
  globalThis.self ??= globalThis;
  const { GLTFLoader } = await import(pathToFileURL(path.join(repo, 'src/plugin-hyperfy/hyperfy/src/core/libs/gltfloader/GLTFLoader.js')).href);
  const buffer = Uint8Array.from(bytes).buffer;
  return new Promise((resolve, reject) => new GLTFLoader().parse(buffer, '', resolve, reject));
}

/** A world as the manager reads it: a scene, the agent's player, and one visitor with an avatar. */
export function fakeWorld({ environment, skyTextureId }) {
  const scene = new THREE.Scene();
  scene.add(environment.scene);
  // As systems/environment.ts builds the sky: its texture lives in the page, named by this id
  const sky = new THREE.Mesh(new THREE.SphereGeometry(1000, 60, 40), new THREE.MeshBasicMaterial({ side: THREE.BackSide }));
  sky.material.fog = false;
  sky.material.toneMapped = false;
  sky.material.userData.materialId = skyTextureId;
  scene.add(sky);
  const sun = new THREE.DirectionalLight(0xffffff, 1);
  sun.position.set(10, 20, 20);
  sun.castShadow = true;
  scene.add(sun);

  const entity = (id, position, avatarUrl) => ({
    data: { id },
    avatarUrl,
    base: { position: new THREE.Vector3(...position), quaternion: new THREE.Quaternion(), scale: new THREE.Vector3(1, 1, 1) },
  });
  const agent = entity('agent', [0, 0, 4]);
  const visitor = entity('visitor', [0, 0, 0], VISITOR_AVATAR_URL);
  return {
    assetsUrl: null,
    stage: { scene },
    controls: { rotateTo: async () => {}, stopRotation: () => {} },
    entities: { player: agent, players: new Map([['agent', agent], ['visitor', visitor]]) },
  };
}

/** Bundles managers/puppeteer-manager.ts alone (no service, no engine) into `outFile`. */
export async function bundleManager(outFile) {
  await build({
    entryPoints: [path.join(repo, 'src/plugin-hyperfy/managers/puppeteer-manager.ts')],
    outfile: outFile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'esnext',
    logLevel: 'warning',
    plugins: [
      {
        name: 'packages-from-the-repository',
        setup(esbuild) {
          // The bundle lives outside the repository: name each package by where it is installed
          esbuild.onResolve({ filter: /^[^./]/ }, (found) => {
            if (found.path.startsWith('node:') || found.kind === 'entry-point') return null;
            try {
              return { path: import.meta.resolve(found.path), external: true };
            } catch {
              return null;
            }
          });
        },
      },
    ],
  });
  return import(pathToFileURL(outFile).href);
}

/** PIDs of `root` and everything it started */
function processTree(root) {
  const rows = spawnSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' }).stdout.split('\n').map((line) => line.trim().split(/\s+/).map(Number));
  const tree = new Set([root]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [pid, parent] of rows) {
      if (tree.has(parent) && !tree.has(pid)) {
        tree.add(pid);
        grew = true;
      }
    }
  }
  return [...tree];
}

/** Resident memory of a process tree right now, in bytes (what lib/render-watchdog.ts measures) */
function treeMemory(root) {
  const rows = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,rss='], { encoding: 'utf8' }).stdout.split('\n').map((line) => line.trim().split(/\s+/).map(Number)).filter((row) => row.length === 3 && row.every(Number.isFinite));
  const tree = new Set([root]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [pid, parent] of rows) {
      if (tree.has(parent) && !tree.has(pid)) {
        tree.add(pid);
        grew = true;
      }
    }
  }
  return rows.filter(([pid]) => tree.has(pid)).reduce((sum, [, , rss]) => sum + rss * 1024, 0);
}
const GiB = 1024 * 1024 * 1024;
const inGiB = (bytes) => `${(bytes / GiB).toFixed(2)} GiB`;

/** Every process now: pid, parent and process group */
function processTable() {
  return spawnSync('ps', ['-A', '-o', 'pid=,ppid=,pgid='], { encoding: 'utf8' }).stdout.split('\n').map((line) => line.trim().split(/\s+/).map(Number)).filter((row) => row.length === 3 && row.every(Number.isFinite));
}

/**
 * A GLB of one mesh with two primitives: the first material has a texture (a 1x1 PNG), the second
 * brings `extras` as given. Built here, in memory.
 */
function twoMaterialGlb(secondExtras) {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const positions = Buffer.from(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer);
  const imageBytes = Math.ceil(png.length / 4) * 4;
  const bin = Buffer.alloc(imageBytes + positions.length);
  png.copy(bin, 0);
  positions.copy(bin, imageBytes);
  const json = {
    asset: { version: '2.0' },
    buffers: [{ byteLength: bin.length }],
    bufferViews: [{ buffer: 0, byteLength: png.length }, { buffer: 0, byteOffset: imageBytes, byteLength: positions.length }],
    accessors: [{ bufferView: 1, count: 3, type: 'VEC3', componentType: 5126, min: [0, 0, 0], max: [1, 1, 0] }],
    images: [{ bufferView: 0, mimeType: 'image/png' }],
    textures: [{ source: 0 }],
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }, { extras: secondExtras }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }, { attributes: { POSITION: 0 }, material: 1 }] }],
    nodes: [{ mesh: 0 }],
    scenes: [{ nodes: [0] }],
    scene: 0,
  };
  const text = Buffer.from(JSON.stringify(json));
  const jsonChunk = Buffer.alloc(Math.ceil(text.length / 4) * 4, 0x20);
  text.copy(jsonChunk);
  const glb = Buffer.alloc(12 + 8 + jsonChunk.length + 8 + bin.length);
  glb.writeUInt32LE(0x46546c67, 0);
  glb.writeUInt32LE(2, 4);
  glb.writeUInt32LE(glb.length, 8);
  glb.writeUInt32LE(jsonChunk.length, 12);
  glb.writeUInt32LE(0x4e4f534a, 16);
  jsonChunk.copy(glb, 20);
  glb.writeUInt32LE(bin.length, 20 + jsonChunk.length);
  glb.writeUInt32LE(0x004e4942, 24 + jsonChunk.length);
  bin.copy(glb, 28 + jsonChunk.length);
  return new Uint8Array(glb);
}

/** Remote ends of the TCP/UDP sockets a process tree holds right now */
export function remoteEnds(rootPid) {
  const out = spawnSync('lsof', ['-nP', '-a', '-p', processTree(rootPid).join(','), '-iTCP', '-iUDP', '-Fn'], { encoding: 'utf8' }).stdout;
  return out.split('\n').filter((line) => line.startsWith('n') && line.includes('->')).map((line) => line.slice(line.indexOf('->') + 2));
}
const isLoopback = (end) => /^(127\.\d+\.\d+\.\d+|\[::1\]|\[::ffff:127\.\d+\.\d+\.\d+\]):\d+$/.test(end);

/** What a JPEG shows, measured in the page (Node cannot decode one): size, spread of brightness, number of colours */
function describeJpeg(page, dataUrl) {
  return page.evaluate(async (dataUrl) => {
    const binary = atob(dataUrl.split(',')[1]);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d');
    context.drawImage(bitmap, 0, 0);
    const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
    const colours = new Set();
    let sum = 0;
    let squares = 0;
    let count = 0;
    for (let i = 0; i < data.length; i += 4 * 7) {
      const luma = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      sum += luma;
      squares += luma * luma;
      count++;
      colours.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
    }
    const mean = sum / count;
    return { width: bitmap.width, height: bitmap.height, bytes: bytes.length, mean: Math.round(mean), deviation: Math.round(Math.sqrt(squares / count - mean * mean)), colours: colours.size };
  }, dataUrl);
}

async function main() {
  const dir = option('--dir') ? path.resolve(option('--dir')) : undefined;
  if (!dir) {
    console.error('Usage: node scripts/smoke-chromium.mjs --dir <empty scratch directory outside the repository> [--keep]');
    process.exit(2);
  }
  if (dir === repo || dir.startsWith(repo + path.sep)) {
    console.error('The scratch directory must be outside the repository.');
    process.exit(2);
  }
  mkdirSync(dir, { recursive: true });
  if (readdirSync(dir).length) {
    console.error(`${dir} is not empty; use an empty directory.`);
    process.exit(2);
  }

  const checks = [];
  const check = (name, ok, detail = '') => {
    checks.push({ name, ok: !!ok });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  };
  const file = (relative) => new Uint8Array(readFileSync(path.join(assets, relative)));

  // Something inside "the network" that Chromium must not be able to reach: a port on this machine
  const local = http.createServer((_request, response) => response.setHeader('access-control-allow-origin', '*').end('reached'));
  let localConnections = 0;
  local.on('connection', () => localConnections++);
  await new Promise((resolve) => local.listen(0, '127.0.0.1', resolve));
  const localUrl = `http://127.0.0.1:${local.address().port}/x`;

  // Variables like the agent's, which must not show up in Chromium's environment
  const canary = `smoke-canary-${Date.now()}`;
  Object.assign(process.env, { ANTHROPIC_API_KEY: canary, ELIZA_SERVER_AUTH_TOKEN: canary, TIP_WALLET_PRIVATE_KEY: canary, HTTPS_PROXY: 'http://127.0.0.1:9' });
  delete process.env.HYPERFY_DEBUG_SNAPSHOTS;
  // Diagnostic snapshots would be written to the working directory
  process.chdir(dir);

  let manager;
  try {
    const { bytes: pageBytes } = await buildRenderPage({ outFile: path.join(dir, 'page.js') });
    console.log(`Render page built: ${(pageBytes / 1024).toFixed(0)} KB`);
    const { PuppeteerManager, OFFLINE_CHROMIUM_ARGS } = await bundleManager(path.join(dir, 'puppeteer-manager.mjs'));

    let world = null;
    manager = new PuppeteerManager({ getService: () => ({ getWorld: () => world }) }, { pageBundlePath: path.join(dir, 'page.js') });
    const page = await manager.init();
    const chromium = manager.browser.process();
    await sleep(1000);
    const idleMemory = treeMemory(chromium.pid);
    console.log(`  info  Chromium's process tree, idle with the render page: ${inGiB(idleMemory)}`);
    const sockets = new Set();
    const sampler = setInterval(() => remoteEnds(chromium.pid).forEach((end) => sockets.add(end)), 150);
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(String(error?.message ?? error)));

    console.log(`\n== Chromium (${path.basename(chromium.spawnfile)}, pid ${chromium.pid})`);
    check('Chromium is started with the offline arguments', OFFLINE_CHROMIUM_ARGS.every((arg) => chromium.spawnargs.includes(arg)), OFFLINE_CHROMIUM_ARGS.join(' '));
    // The command line and environment of the browser process as the OS reports them (macOS ps, Linux /proc)
    const procEnv = existsSync(`/proc/${chromium.pid}/environ`)
      ? readFileSync(`/proc/${chromium.pid}/environ`, 'utf8')
      : spawnSync('ps', ['eww', '-o', 'command=', '-p', String(chromium.pid)], { encoding: 'utf8' }).stdout;
    check("the agent's secrets are not in Chromium's environment", procEnv.length > 0 && !procEnv.includes(canary) && !/ANTHROPIC_API_KEY|ELIZA_SERVER_AUTH_TOKEN|TIP_WALLET_PRIVATE_KEY|HTTPS_PROXY=/.test(procEnv), `${procEnv.length} characters of command line and environment read`);
    check('the page was written, not loaded: it is about:blank with the bundle inline', (await page.evaluate(() => [location.href, typeof window.agentPage, window.THREE.REVISION].join(' '))) === 'about:blank object 132');

    console.log('\n== assets from memory');
    const vrm = await manager.loadVRMBytes(file('avatars/avatar.vrm'), VISITOR_AVATAR_URL);
    check('avatar.vrm: parsed from bytes, kept in the page, returned as a GLB', Buffer.from(vrm.subarray(0, 4)).toString() === 'glTF' && vrm.byteLength > 100_000, `${vrm.byteLength} bytes back`);
    const emote = await manager.loadGlbBytes(file('emotes/emote-idle.glb'));
    const emoteGltf = await parseStrippedGlb(emote);
    check('emote-idle.glb: parsed from bytes and handed back as a GLB the agent can read', Buffer.from(emote.subarray(0, 4)).toString() === 'glTF' && !!emoteGltf.scene, `${emote.byteLength} bytes back`);
    // As before this page existed in its present form: the export is of the scene only
    console.log(`  info  the GLB handed back for the emote holds ${emoteGltf.animations.length} animation(s)`);
    const environmentSource = file('assets/base-environment.glb');
    const stripped = await manager.loadGlbBytes(environmentSource);
    const environment = await parseStrippedGlb(stripped);
    // The page refuses to hand back more than the export budget (lib/gltf-budget.ts), before encoding it
    const texturesBefore = await page.evaluate(() => window.texturesMap.size);
    const overBudget = await manager.loadGlbBytes(environmentSource, { maxExportBytes: 1000 }).then(() => 'returned', (error) => String(error?.message ?? error));
    const vrmOverBudget = await manager.loadVRMBytes(file('avatars/avatar.vrm'), 'https://world.invalid/assets/too-big.vrm', { maxExportBytes: 1000 }).then(() => 'returned', (error) => String(error?.message ?? error));
    const leftover = await page.evaluate(() => ({ avatar: window.avatarMap.has('https://world.invalid/assets/too-big.vrm'), textures: window.texturesMap.size }));
    check(
      'a model or avatar whose export is over the budget is refused by the page, and neither it nor its textures are kept',
      /the exported model is \d+ bytes, more than 1000/.test(overBudget) && /the exported model is \d+ bytes, more than 1000/.test(vrmOverBudget) && !leftover.avatar && leftover.textures === texturesBefore,
      `${overBudget.slice(0, 100)} | ${vrmOverBudget.slice(0, 100)} | avatar kept: ${leftover.avatar}, textures ${texturesBefore} -> ${leftover.textures}`
    );
    // A page call whose world went away while it ran: the manager takes back what it kept (assets.js undo)
    const keptBefore = await page.evaluate(() => ({ textures: window.texturesMap.size, environment: window.environment ?? null }));
    const cancelled = [];
    for (const call of [
      (signal) => manager.loadGlbBytes(environmentSource, { signal }),
      (signal) => manager.loadVRMBytes(file('avatars/avatar.vrm'), 'https://world.invalid/assets/cancelled.vrm', { signal }),
      (signal) => manager.registerTexture({ bytes: file('assets/day2-2k.jpg'), contentType: 'image/jpeg', url: 'https://world.invalid/assets/cancelled.jpg' }, 'map', { signal }),
    ]) {
      const stop = new AbortController();
      // Fired right after the page was asked, while it works on it
      const evaluate = page.evaluate;
      page.evaluate = function (...args) {
        page.evaluate = evaluate;
        const result = evaluate.apply(this, args);
        stop.abort();
        return result;
      };
      cancelled.push(await call(stop.signal).then(() => 'returned', (error) => error?.name));
      page.evaluate = evaluate;
    }
    const keptAfter = await page.evaluate(() => ({ textures: window.texturesMap.size, avatar: window.avatarMap.has('https://world.invalid/assets/cancelled.vrm') }));
    check(
      'a page call whose signal fired while it ran fails, and what it kept in the page is taken back',
      cancelled.every((outcome) => outcome === 'AbortError') && keptAfter.textures === keptBefore.textures && !keptAfter.avatar,
      `${cancelled.join(', ')}; textures ${keptBefore.textures} -> ${keptAfter.textures}, avatar kept: ${keptAfter.avatar}`
    );
    // A material id from the file that cannot be used as one fails the load, and what the load had kept by then goes too
    const keysBefore = await page.evaluate(() => window.texturesMap.size);
    const texturesBeforeMaterialCheck = await page.evaluate(() => [...window.texturesMap.keys()]);
    const goodGlb = await manager.loadGlbBytes(twoMaterialGlb({ note: 'fine' }), { signal: new AbortController().signal }).then(() => 'loaded', (error) => String(error?.message ?? error));
    const keysWithGood = await page.evaluate(() => window.texturesMap.size);
    const badGlb = await manager.loadGlbBytes(twoMaterialGlb({ materialId: { toString: null } }), { signal: new AbortController().signal }).then(() => 'loaded', (error) => String(error?.message ?? error));
    const keysAfterBad = await page.evaluate(() => window.texturesMap.size);
    check(
      "a model whose second material brings extras.materialId { toString: null } fails to load, and the first material's texture is not kept",
      goodGlb === 'loaded' && keysWithGood === keysBefore + 1 && /materialId the page cannot use/.test(badGlb) && keysAfterBad === keysWithGood,
      `good: ${goodGlb} (textures ${keysBefore} -> ${keysWithGood}); bad: ${badGlb.slice(0, 120)} (textures ${keysWithGood} -> ${keysAfterBad})`
    );
    // The good one's texture would change which one the texture-limit check below finds least recently used
    await page.evaluate((before) => {
      for (const key of [...window.texturesMap.keys()]) if (!before.includes(key)) window.texturesMap.delete(key);
    }, texturesBeforeMaterialCheck);
    // Successful loads are committed at once: the page keeps no record (and so no scene) for any of them
    const texturesBeforeLoads = await page.evaluate(() => [...window.texturesMap.keys()]);
    for (let i = 0; i < 5; i++) await manager.loadGlbBytes(environmentSource, { signal: new AbortController().signal });
    const pendingAfterLoads = await page.evaluate(() => window.agentPage.pendingSettlements());
    check('after five successful model loads with a signal, the page holds no load waiting to be settled', pendingAfterLoads === 0, `${pendingAfterLoads} pending`);
    // A commit keeps the record: a world that goes away while the commit is acknowledged still gets the load taken back
    const commitThenRollback = await page.evaluate(async () => {
      const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
      const id = await window.agentPage.registerTexture(pixel, 'image/png', 'smoke', 'https://world.invalid/c.png', 'op-smoke-commit');
      window.agentPage.settle('op-smoke-commit', 'commit');
      const afterCommit = { pending: window.agentPage.pendingSettlements(), kept: window.texturesMap.has(`${id}:smoke`) };
      window.agentPage.settle('op-smoke-commit', 'rollback');
      return { afterCommit, gone: !window.texturesMap.has(`${id}:smoke`), pending: window.agentPage.pendingSettlements() };
    });
    check(
      'a committed load stays on record until it is forgotten: taken back after its commit, its texture goes',
      commitThenRollback.afterCommit.pending === 1 && commitThenRollback.afterCommit.kept && commitThenRollback.gone && commitThenRollback.pending === 0,
      JSON.stringify(commitThenRollback)
    );
    // Their textures would change which one the texture-limit check below finds least recently used
    await page.evaluate((before) => {
      for (const key of [...window.texturesMap.keys()]) if (!before.includes(key)) window.texturesMap.delete(key);
    }, texturesBeforeLoads);
    const materialIds = new Set();
    environment.scene.traverse((node) => node.material?.userData?.materialId && materialIds.add(node.material.userData.materialId));
    const kept = await page.evaluate(() => window.texturesMap.size);
    check('base-environment.glb: textures stay in the page, the GLB handed back carries their ids', materialIds.size > 0 && kept > 0 && stripped.byteLength < environmentSource.byteLength, `${materialIds.size} material ids, ${kept} textures kept, ${environmentSource.byteLength} -> ${stripped.byteLength} bytes`);
    const skyBytes = file('assets/day2-2k.jpg');
    const skyTextureId = await manager.registerTexture({ bytes: skyBytes, contentType: 'image/jpeg', url: 'data:image/jpeg;base64,' }, 'map');
    check('day2-2k.jpg: registered as a texture from bytes', /^[0-9a-f-]{36}$/.test(skyTextureId) && (await page.evaluate((id) => window.texturesMap.get(`${id}:map`)?.image?.width, skyTextureId)) === 2048);
    const hdrBytes = file('assets/day2.hdr');
    await manager.loadEnvironmentHDR(hdrBytes);
    check('day2.hdr: parsed from bytes and set as environment and background', await page.evaluate(() => window.environment?.isDataTexture === true && window.scene.environment === window.environment && window.environment.image.width > 0));
    // An HDR load that fails after it was parsed (here: drawing throws) leaves the environment the page had
    await page.evaluate(() => {
      window.__smokeEnvironment = window.environment;
      window.__smokeRender = window.renderer.render;
      window.renderer.render = () => {
        throw new Error('drawing failed (smoke)');
      };
    });
    const failedHdr = await manager.loadEnvironmentHDR(hdrBytes, { signal: new AbortController().signal }).then(() => 'loaded', (error) => String(error?.message ?? error));
    const afterFailedHdr = await page.evaluate(() => {
      window.renderer.render = window.__smokeRender;
      const kept = window.environment === window.__smokeEnvironment && window.scene.environment === window.environment && window.scene.background === window.environment;
      delete window.__smokeRender;
      delete window.__smokeEnvironment;
      return { kept, pending: window.agentPage.pendingSettlements() };
    });
    check('an HDR load that fails in the page leaves the environment it had, and no record', /drawing failed/.test(failedHdr) && afterFailedHdr.kept && afterFailedHdr.pending === 0, `${failedHdr.slice(0, 80)}; ${JSON.stringify(afterFailedHdr)}`);

    console.log("\n== loading from memory gives what three's own URL loaders give (through blob: URLs, which need no network)");
    const toBase64 = (bytes) => Buffer.from(bytes).toString('base64');
    const same = await page.evaluate(
      async (hdr, jpeg, glb) => {
        const THREE = window.THREE;
        const bytesOf = (base64) => Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
        const blobUrl = (base64, type) => URL.createObjectURL(new Blob([bytesOf(base64)], { type }));
        const out = {};
        // HDR: RGBELoader.load(url) against agentPage.hdrTexture(bytes)
        const viaUrl = await new Promise((resolve, reject) => new window.RGBELoader().load(blobUrl(hdr, 'image/vnd.radiance'), resolve, undefined, reject));
        const viaBytes = window.agentPage.hdrTexture(bytesOf(hdr).buffer);
        const settings = (t) => [t.type, t.format, t.encoding, t.minFilter, t.magFilter, t.wrapS, t.wrapT, t.flipY, t.generateMipmaps, t.anisotropy, t.image.width, t.image.height, t.image.data.constructor.name, t.image.data.length].join(',');
        out.hdrSettings = settings(viaUrl) === settings(viaBytes) ? 'same' : `${settings(viaUrl)} != ${settings(viaBytes)}`;
        out.hdrPixels = viaUrl.image.data.every((value, i) => value === viaBytes.image.data[i]);
        // Image: TextureLoader.load of the JPEG as a data: URL (what the page was given before) against registerTexture(bytes)
        const jpegViaUrl = await new Promise((resolve, reject) => window.TextureLoader.load(`data:image/jpeg;base64,${jpeg}`, resolve, undefined, reject));
        const id = await window.agentPage.registerTexture(jpeg, 'image/jpeg', 'smoke', 'data:image/jpeg;base64');
        const jpegViaBytes = window.texturesMap.get(`${id}:smoke`);
        window.texturesMap.delete(`${id}:smoke`);
        out.jpegSame = jpegViaUrl.format === jpegViaBytes.format && jpegViaBytes.format === THREE.RGBFormat && jpegViaUrl.image.width === jpegViaBytes.image.width;
        const otherId = await window.agentPage.registerTexture(jpeg, 'image/jpeg', 'smoke', 'https://world.invalid/assets/sky.png');
        out.otherIsRgba = window.texturesMap.get(`${otherId}:smoke`).format === THREE.RGBAFormat;
        window.texturesMap.delete(`${otherId}:smoke`);
        // GLB: GLTFLoader.loadAsync(url) against GLTFLoader.parse(bytes), as the GLB each exports
        const exported = async (gltf) => new Uint8Array(await new Promise((done) => new window.GLTFExporter().parse(gltf.scene, done, { binary: true, embedImages: true })));
        const a = await exported(await new window.GLTFLoader().loadAsync(blobUrl(glb, 'model/gltf-binary')));
        const b = await exported(await new Promise((resolve, reject) => new window.GLTFLoader().parse(bytesOf(glb).buffer, '', resolve, reject)));
        out.glb = a.length === b.length && a.every((value, i) => value === b[i]) ? `same ${a.length} bytes` : `differ (${a.length} and ${b.length} bytes)`;
        return out;
      },
      toBase64(hdrBytes),
      toBase64(skyBytes),
      toBase64(environmentSource)
    );
    check('HDR: same texture settings and the same pixels as RGBELoader.load()', same.hdrSettings === 'same' && same.hdrPixels === true, same.hdrSettings);
    check('image: the texture format TextureLoader.load() picked from the URL (RGB for a JPEG, RGBA otherwise)', same.jpegSame === true && same.otherIsRgba === true);
    check('GLB: GLTFLoader.parse(bytes) exports byte for byte what GLTFLoader.loadAsync(url) exports', same.glb.startsWith('same'), same.glb);

    console.log('\n== snapshots');
    world = fakeWorld({ environment, skyTextureId });
    const shots = {
      equirectangular: await manager.snapshotEquirectangular(),
      'facing front': await manager.snapshotFacingDirection('front'),
      'view to target': await manager.snapshotViewToTarget([0, 0, 0]),
    };
    const viewport = await page.evaluate(() => [window.renderer.domElement.width, window.renderer.domElement.height]);
    for (const [name, dataUrl] of Object.entries(shots)) {
      const jpeg = Buffer.from(dataUrl.split(',')[1] ?? '', 'base64');
      const seen = await describeJpeg(page, dataUrl);
      const size = name === 'equirectangular' ? [2048, 1024] : viewport;
      check(
        `${name}: a JPEG of the expected size with a picture in it`,
        dataUrl.startsWith('data:image/jpeg;base64,') && jpeg[0] === 0xff && jpeg[1] === 0xd8 && seen.width === size[0] && seen.height === size[1] && seen.deviation >= 8 && seen.colours >= 200,
        `${seen.width}x${seen.height}, ${seen.bytes} bytes, brightness ${seen.mean} +/- ${seen.deviation}, ${seen.colours} colours sampled`
      );
    }
    const drawn = await page.evaluate(() => ({
      avatars: window.activeVRMInstances.length,
      skyHasTexture: (() => {
        let found = false;
        window.scene.traverse((node) => {
          if (node.isMesh && node.geometry.type === 'SphereGeometry' && node.material.map?.image) found = true;
        });
        return found;
      })(),
      textured: (() => {
        let count = 0;
        window.scene.traverse((node) => node.isMesh && node.material.map && count++);
        return count;
      })(),
    }));
    check("the visitor's avatar is in the scene, and the sky and the environment have their textures back", drawn.avatars === 1 && drawn.skyHasTexture && drawn.textured >= 2, JSON.stringify(drawn));
    const loadedMemory = treeMemory(chromium.pid);
    console.log(`  info  Chromium's process tree with the bundled avatar, environment, HDR and snapshots taken: ${inGiB(loadedMemory)}; the largest the watchdog sampled during page calls so far: ${inGiB(manager.watchdog.peakSampleBytes)} (watchdog limit ${inGiB(manager.watchdog.limitBytes)})`);
    check('the bundled workload stays below three quarters of the watchdog limit', manager.watchdog.peakSampleBytes < 0.75 * manager.watchdog.limitBytes, `peak ${inGiB(manager.watchdog.peakSampleBytes)} of ${inGiB(manager.watchdog.limitBytes)}`);
    check('no diagnostic JPEG is written without HYPERFY_DEBUG_SNAPSHOTS=true', readdirSync(dir).filter((name) => name.endsWith('.jpeg')).length === 0);
    process.env.HYPERFY_DEBUG_SNAPSHOTS = 'true';
    await manager.snapshotFacingDirection('front');
    delete process.env.HYPERFY_DEBUG_SNAPSHOTS;
    check('with HYPERFY_DEBUG_SNAPSHOTS=true it is written to the working directory', existsSync(path.join(dir, 'scene_facing_front.jpeg')));

    console.log('\n== nothing piles up');
    const memory = () => page.evaluate(() => ({ ...window.renderer.info.memory, targets: window.renderer.info.memory.textures }));
    for (let i = 0; i < 2; i++) await manager.snapshotEquirectangular();
    const before = await memory();
    for (let i = 0; i < 6; i++) await manager.snapshotEquirectangular();
    const after = await memory();
    check('six more snapshots leave the GPU with the same number of geometries and textures', before.geometries === after.geometries && before.textures === after.textures, `geometries ${before.geometries} -> ${after.geometries}, textures ${before.textures} -> ${after.textures}`);
    // 1x1 PNG
    const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const register = (count) => page.evaluate(async (pixel, count) => {
      let last;
      for (let i = 0; i < count; i++) last = await window.agentPage.registerTexture(pixel, 'image/png', 'smoke', 'https://world.invalid/x.png');
      return last;
    }, pixel, count);
    const idle = await register(1);
    // Drawing the scene uses its textures again, which makes the one just added the least recently used
    await manager.snapshotFacingDirection('front');
    const { limit, size } = await page.evaluate(() => ({ limit: window.agentPage.LIMITS.textures, size: window.texturesMap.size }));
    await register(limit - size + 1);
    const bounded = await page.evaluate((idle, skyId) => ({ size: window.texturesMap.size, idleGone: !window.texturesMap.has(`${idle}:smoke`), skyKept: window.texturesMap.has(`${skyId}:map`) }), idle, skyTextureId);
    check('the page keeps at most LIMITS.textures textures, dropping the least recently used (not one the scene still draws)', bounded.size === limit && bounded.idleGone && bounded.skyKept, JSON.stringify({ limit, ...bounded }));
    await register(limit);
    check('and never more, however many arrive', (await page.evaluate(() => window.texturesMap.size)) === limit);
    // Avatars, with the limit lowered to two for the check: the visitor's (drawn in every snapshot) and one more
    const avatarLimit = await page.evaluate(() => {
      const before = window.agentPage.LIMITS.avatars;
      window.agentPage.LIMITS.avatars = 2;
      return before;
    });
    const avatarBytes = file('avatars/avatar.vrm');
    await manager.loadVRMBytes(avatarBytes, 'smoke://idle.vrm');
    await manager.snapshotFacingDirection('front');
    await manager.loadVRMBytes(avatarBytes, 'smoke://newer.vrm');
    const avatars = await page.evaluate((limit) => {
      window.agentPage.LIMITS.avatars = limit;
      return { kept: [...window.avatarMap.keys()], drawn: window.activeVRMInstances.length };
    }, avatarLimit);
    await manager.snapshotFacingDirection('front');
    check(
      'the page keeps at most LIMITS.avatars avatars, dropping the least recently used (not one a player in the scene wears)',
      avatarLimit === 32 && JSON.stringify(avatars.kept) === JSON.stringify([VISITOR_AVATAR_URL, 'smoke://newer.vrm']) && (await page.evaluate(() => window.activeVRMInstances.length)) === 1,
      `limit ${avatarLimit}, lowered to 2 for this check; kept: ${avatars.kept.join(', ')}`
    );

    console.log('\n== no way out');
    const reach = await page.evaluate(async (localUrl) => {
      const attempt = (promise) => promise.then((value) => `REACHED ${value}`, (error) => `failed: ${error?.message ?? error}`);
      const image = (src) => new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve('REACHED (loaded)');
        img.onerror = () => resolve('failed: error event');
        img.src = src;
      });
      return {
        'fetch https://example.com': await attempt(fetch('https://example.com').then((r) => r.status)),
        'fetch file:///etc/hosts': await attempt(fetch('file:///etc/hosts').then((r) => r.status)),
        '<img src="http://127.0.0.1:1/x">': await image('http://127.0.0.1:1/x'),
        'fetch of a port that is open on this machine': await attempt(fetch(localUrl).then((r) => r.text())),
        '<img> of a port that is open on this machine': await image(localUrl),
        'XMLHttpRequest to a port that is open on this machine': await new Promise((resolve) => {
          const xhr = new XMLHttpRequest();
          xhr.onload = () => resolve('REACHED');
          xhr.onerror = () => resolve('failed: error event');
          xhr.open('GET', localUrl);
          xhr.send();
        }),
        'WebSocket to this machine': await new Promise((resolve) => {
          const ws = new WebSocket(localUrl.replace('http', 'ws'));
          ws.onopen = () => resolve('REACHED');
          ws.onerror = () => resolve('failed: error event');
        }),
      };
    }, localUrl);
    for (const [what, outcome] of Object.entries(reach)) check(`${what} fails in the page`, outcome.startsWith('failed'), outcome);
    // A second tab has no request interception: only the browser-level arguments stand in its way
    const second = await manager.browser.newPage();
    const secondTab = await second.evaluate((localUrl) => fetch(localUrl).then((r) => `REACHED ${r.status}`, (error) => `failed: ${error.message}`), localUrl);
    const navigation = await second.goto(localUrl, { timeout: 5000 }).then((response) => `REACHED ${response?.status()}`, (error) => `failed: ${String(error.message).split('\n')[0]}`);
    await second.close();
    check('a tab without request interception cannot fetch a port on this machine either', secondTab.startsWith('failed'), secondTab);
    check('nor navigate to it', navigation.startsWith('failed'), navigation);
    check('the local server Chromium was pointed at never saw a connection', localConnections === 0, `${localConnections} connections`);

    await sleep(1500);
    clearInterval(sampler);
    remoteEnds(chromium.pid).forEach((end) => sockets.add(end));
    const outside = [...sockets].filter((end) => !isLoopback(end));
    check('every socket of the Chromium process tree, sampled throughout, was to 127.0.0.1 (the DevTools connection)', sockets.size > 0 && outside.length === 0, `seen: ${[...sockets].join(', ') || 'none'}`);
    check('the page raised no script error', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

    console.log('\n== a lost page is rebuilt');
    await page.close();
    const rebuilt = await manager.init();
    check('after the page closed, the next use gets a new one with the render page in it', rebuilt !== page && (await rebuilt.evaluate(() => typeof window.agentPage)) === 'object');

    console.log(`  info  the largest the watchdog sampled during the whole workload: ${inGiB(manager.watchdog.peakSampleBytes)}; the longest page call: ${manager.watchdog.longestCallMs} ms (deadline ${manager.watchdog.deadlineMs} ms)`);
    check('the slowest page call of the workload meets the deadline ten times over', manager.watchdog.longestCallMs * 10 <= manager.watchdog.deadlineMs, `${manager.watchdog.longestCallMs} ms`);
    console.log('\n== the watchdog');
    // A page call that allocates and touches memory without end. Its own hard stop (3.5 GiB or 20 s)
    // ends it if the watchdog does not, so that a missing watchdog fails this check instead of
    // exhausting the machine
    const HARD_STOP_BYTES = 3.5 * GiB;
    const HARD_STOP_MS = 20_000;
    const killedPid = manager.browser.process().pid;
    const killedGeneration = manager.currentBrowser().generation;
    const started = Date.now();
    const runaway = await manager.evaluateWatched(async (hardStopBytes, hardStopMs) => {
      const kept = [];
      let total = 0;
      const start = Date.now();
      while (total < hardStopBytes && Date.now() - start < hardStopMs) {
        const chunk = new Uint8Array(32 * 1024 * 1024);
        for (let i = 0; i < chunk.length; i += 4096) chunk[i] = 1;
        kept.push(chunk);
        total += chunk.length;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return { total, ms: Date.now() - start };
    }, HARD_STOP_BYTES, HARD_STOP_MS).then((value) => ({ value }), (error) => ({ error }));
    const killedAfter = Date.now() - started;
    const measured = runaway.error?.measuredBytes ?? 0;
    check(
      'a page call that allocates without end gets Chromium killed by the watchdog (RenderPageKilled, memory) at most 1 GiB above the limit',
      runaway.error?.name === 'RenderPageKilled' && runaway.error.reason === 'memory' && measured > manager.watchdog.limitBytes && measured <= manager.watchdog.limitBytes + GiB,
      runaway.error ? `${runaway.error.message}; measured ${inGiB(measured)} after ${killedAfter} ms` : `not killed: the page call returned ${JSON.stringify(runaway.value)}`
    );
    const afterKill = await manager.snapshotEquirectangular().then((shot) => shot, (error) => `failed: ${error?.message ?? error}`);
    const freshPid = manager.browser?.process()?.pid;
    check('the next snapshot works, on a new browser and page', afterKill.startsWith('data:image/jpeg;base64,') && freshPid && freshPid !== killedPid, `${afterKill.slice(0, 40)}; browser pid ${killedPid} -> ${freshPid}`);
    // Nothing of the killed generation is left: not the processes it was seen to own, not its process group
    const { pids: ownedPids, group } = manager.watchdog.ownership(killedGeneration);
    await sleep(1000);
    const left = processTable().filter(([pid, , pgid]) => ownedPids.includes(pid) || (group !== null && pgid === group));
    check(
      'after the kill no process of the killed browser is left, by the pids it was seen to own and by its process group',
      ownedPids.length > 1 && group === killedPid && left.length === 0,
      `${ownedPids.length} processes owned, group ${group}; left: ${JSON.stringify(left)}`
    );
  } catch (error) {
    check('the smoke ran to the end', false, error instanceof Error ? (error.stack ?? error.message) : String(error));
  } finally {
    await manager?.close().catch(() => {});
    local.close();
    process.chdir(repo);
    if (!args.includes('--keep')) rmSync(dir, { recursive: true, force: true });
  }

  const failed = checks.filter((entry) => !entry.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed${failed.length ? `; FAILED: ${failed.map((entry) => entry.name).join('; ')}` : ''}`);
  process.exit(failed.length ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
