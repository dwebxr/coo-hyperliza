/**
 * Entry of a child process (bundled and spawned by systems/loader.globals.child.test.ts, under Bun
 * and Node): loads the whole plugin as the agent does, builds an agent world (never connected),
 * and parses the agent's own bundled models with its loader. Reports what it parsed and whether
 * anything put a browser's `window` or `document` on globalThis. Last, it starts an in-memory
 * PGLite database in the same process: PGLite refuses to start where it finds a `window` (argv:
 * asset directory, the PhysX loader module, the PGLite module, report file).
 *
 * Bundled with the engine's storage module and Chromium replaced, as the sandbox children are: the
 * render page hands a model back as a GLB of its own; here the bytes come back as they are, so
 * the avatar keeps its embedded textures, the hardest case for parsing without a DOM.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { hyperfyPlugin } from '../index';
import { createAgentWorld } from '../session/create-agent-world';

const [assets, physxModule, pgliteModule, reportFile] = process.argv.slice(2);
const browserGlobals = () => ({ window: 'window' in globalThis, document: 'document' in globalThis });
const report: Record<string, unknown> = { runtime: 'Bun' in globalThis ? 'bun' : 'node', plugin: hyperfyPlugin.name, afterImport: browserGlobals() };

try {
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) console[level] = () => {};
  const { world } = createAgentWorld({ wsUrl: 'ws://127.0.0.1:9/ws', sandboxedScripts: false });
  // What world.init does before anything is loaded: the physics engine (a WebAssembly module),
  // which the model's colliders are built with. Imported from where it lives: it reads its .wasm
  // file from next to itself.
  const { loadPhysX } = await import(pathToFileURL(physxModule).href);
  const physx = await loadPhysX();
  report.physx = typeof physx.version;
  report.afterWorld = browserGlobals();
  const parsed: Record<string, unknown> = {};
  for (const [type, file] of [
    ['model', 'assets/base-environment.glb'],
    ['avatar', 'avatars/avatar.vrm'],
    ['emote', 'emotes/emote-idle.glb'],
  ] as const) {
    const bytes = new Uint8Array(readFileSync(path.join(assets, file)));
    const url = `https://world.invalid/assets/${path.basename(file)}`;
    const result = await world.loader.parseGLB(type, `${type}/${url}`, { bytes, url, contentType: '' });
    let meshes = 0;
    result.gltf.scene.traverse((node: { isMesh?: boolean }) => void (node.isMesh && meshes++));
    parsed[type] = {
      meshes,
      animations: result.gltf.animations.length,
      images: result.gltf.parser.json.images?.length ?? 0,
      nodes: typeof result.toNodes === 'function' ? result.toNodes().constructor.name.length > 0 : null,
      clip: typeof result.toClip === 'function',
    };
  }
  report.parsed = parsed;
  report.afterParse = browserGlobals();

  const { PGlite } = await import(pathToFileURL(pgliteModule).href);
  const db = new PGlite();
  const answer = await db.query('select 1 + 1 as two');
  await db.close();
  report.pglite = answer.rows[0];
} catch (error) {
  report.fatal = error instanceof Error ? (error.stack ?? error.message) : String(error);
}
writeFileSync(reportFile, JSON.stringify(report));
process.exit(0);
