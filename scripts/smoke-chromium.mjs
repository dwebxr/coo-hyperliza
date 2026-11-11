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
