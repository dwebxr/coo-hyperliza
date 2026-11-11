#!/usr/bin/env node
/*
 * Puts next to dist/index.js (which tsup writes first) everything else the built agent reads from
 * disk, and nothing more. DIST_MANIFEST below is the whole list:
 *
 *   dist/puppeteer/page.js       the render page, bundled here (see buildRenderPage)
 *   dist/physx-js-webidl.wasm    PhysX, loaded by the engine's glue code that tsup bundles into
 *                                index.js: it looks for the file next to itself
 *   dist/assets, avatars, emotes the bundled environment, avatar and emotes (lib/asset-root.ts)
 *
 *   tsup && node scripts/build-assets.mjs        (what `bun run build` runs)
 *
 * A listed input that is missing stops the build. A file in a bundled directory that the manifest
 * does not name is not copied and is named in a warning. Afterwards dist/ holds exactly tsup's
 * files and the manifest's: anything else in it is removed (tsup is run without its own clean,
 * which deletes files and leaves their directories).
 *
 * The render page is ONE classic script: the page's own code (src/plugin-hyperfy/public/puppeteer
 * and public/scripts) together with three.js and three-vrm. Headless Chromium runs it inline in an
 * about:blank page with no network, where there is nothing an ES module could be imported from.
 *
 * The page uses three.js 0.132.2 and @pixiv/three-vrm 3.3.3, the versions its code is written
 * against, not the newer ones the agent runs on. They are the devDependencies `page-three` and
 * `page-three-vrm` (npm aliases); the build fails if those are any other version, if more than one
 * copy of three.js ends up in the bundle, or if anything else from node_modules does.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

export const PAGE_LIBRARIES = Object.freeze({ 'page-three': '0.132.2', 'page-three-vrm': '3.3.3' });

/** Everything in dist/. Sources are relative to the repository, targets to dist/. */
export const DIST_MANIFEST = Object.freeze({
  /** Written by tsup before this script runs (tsup.config.ts) */
  tsup: ['index.js', 'index.js.map'],
  /** Bundled by buildRenderPage */
  renderPage: 'puppeteer/page.js',
  /** Single files */
  files: [{ from: 'src/plugin-hyperfy/hyperfy/src/core/physx-js-webidl.wasm', to: 'physx-js-webidl.wasm' }],
  /** Directories: every file in `files` must exist; one in `optional` is copied when it exists */
  directories: [
    { from: 'src/plugin-hyperfy/public/assets', to: 'assets', files: ['base-environment.glb', 'day2-2k.jpg', 'day2.hdr'], optional: [] },
    { from: 'src/plugin-hyperfy/public/avatars', to: 'avatars', files: ['avatar.vrm'], optional: [] },
    {
      from: 'src/plugin-hyperfy/public/emotes',
      to: 'emotes',
      files: [
        'emote-crawling.glb',
        'emote-crying.glb',
        'emote-dance-breaking.glb',
        'emote-dance-happy.glb',
        'emote-dance-hiphop.glb',
        'emote-dance-popping.glb',
        'emote-death.glb',
        'emote-fall.glb',
        'emote-firing-gun.glb',
        'emote-flip.glb',
        'emote-float.glb',
        'emote-idle.glb',
        'emote-kiss.glb',
        'emote-looking-around.glb',
        'emote-punch.glb',
        'emote-rude-gesture.glb',
        'emote-run.glb',
        'emote-sorrow.glb',
        'emote-squat.glb',
        'emote-walk.glb',
        'emote-waving-both-hands.glb',
      ],
      // The owner's own talking gesture (managers/emote-manager.ts)
      optional: ['emote-talk.glb'],
    },
  ],
});
export const RENDER_PAGE_ENTRY = path.join(repo, 'src/plugin-hyperfy/public/puppeteer/page.js');

function libraryRoot(name) {
  const manifest = require.resolve(`${name}/package.json`);
  const { version } = JSON.parse(readFileSync(manifest, 'utf8'));
  if (version !== PAGE_LIBRARIES[name]) {
    throw new Error(`${name} is version ${version}, but the render page is built against ${PAGE_LIBRARIES[name]} (see devDependencies in package.json)`);
  }
  return path.dirname(manifest);
}

/**
 * Bundles the render page into `outFile` and returns what went into it. The names the page's code
 * imports (`three`, `three/addons/…`, `@pixiv/three-vrm`) are mapped to files of the two page
 * libraries.
 */
export async function buildRenderPage({ outFile }) {
  const three = libraryRoot('page-three');
  const vrm = libraryRoot('page-three-vrm');
  const result = await build({
    entryPoints: [RENDER_PAGE_ENTRY],
    outfile: outFile,
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'esnext',
    minify: false,
    charset: 'utf8',
    metafile: true,
    logLevel: 'warning',
    banner: { js: `/* Render page: three.js ${PAGE_LIBRARIES['page-three']}, @pixiv/three-vrm ${PAGE_LIBRARIES['page-three-vrm']}. Built by scripts/build-assets.mjs. */` },
    plugins: [
      {
        name: 'render-page-import-map',
        setup(esbuild) {
          esbuild.onResolve({ filter: /^three$/ }, () => ({ path: path.join(three, 'build/three.module.js') }));
          esbuild.onResolve({ filter: /^three\/addons\// }, (args) => ({ path: path.join(three, 'examples/jsm', args.path.slice('three/addons/'.length)) }));
          esbuild.onResolve({ filter: /^@pixiv\/three-vrm$/ }, () => ({ path: path.join(vrm, 'lib/three-vrm.module.js') }));
        },
      },
    ],
  });
  const inputs = Object.keys(result.metafile.inputs);
  const threeBuilds = inputs.filter((file) => /(^|\/)three(\.module|\.cjs|\.min)?\.js$/.test(file) || /node_modules\/three\//.test(file));
  if (threeBuilds.length !== 1 || !threeBuilds[0].endsWith('page-three/build/three.module.js')) {
    throw new Error(`The render page must contain exactly one three.js, the page-three build; found: ${threeBuilds.join(', ') || 'none'}`);
  }
  // The two libraries are single files; anything else from node_modules would be another version
  // of them or of their parts (the agent's own three.js, a hoisted @pixiv/three-vrm-* package)
  const foreign = inputs.filter((file) => file.includes('node_modules/') && !/(^|\/)node_modules\/(page-three|page-three-vrm)\//.test(file));
  if (foreign.length) {
    throw new Error(`The render page may only bundle page-three and page-three-vrm from node_modules; found: ${foreign.join(', ')}`);
  }
  const bytes = Object.values(result.metafile.outputs)[0].bytes;
  return { outFile, bytes, inputs };
}

/**
 * Copies the manifest's files and directories from `root` into `outDir`. Throws, naming every
 * missing input, before anything is copied. Returns the targets written and the files found in
 * the bundled directories that the manifest does not name (not copied).
 */
export function copyBundledFiles({ outDir, root = repo }) {
  const copies = [];
  const missing = [];
  const unlisted = [];
  const add = (from, to) => (existsSync(path.join(root, from)) ? copies.push({ from, to }) : missing.push(from));
  for (const file of DIST_MANIFEST.files) add(file.from, file.to);
  for (const directory of DIST_MANIFEST.directories) {
    for (const name of directory.files) add(`${directory.from}/${name}`, `${directory.to}/${name}`);
    for (const name of directory.optional) if (existsSync(path.join(root, directory.from, name))) add(`${directory.from}/${name}`, `${directory.to}/${name}`);
    const listed = new Set([...directory.files, ...directory.optional]);
    if (existsSync(path.join(root, directory.from))) {
      for (const name of readdirSync(path.join(root, directory.from))) if (!name.startsWith('.') && !listed.has(name)) unlisted.push(`${directory.from}/${name}`);
    }
  }
  if (missing.length) throw new Error(`build-assets: missing input${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`);
  // A directory left from an earlier build may hold files that are no longer listed
  for (const directory of DIST_MANIFEST.directories) rmSync(path.join(outDir, directory.to), { recursive: true, force: true });
  for (const { from, to } of copies) {
    mkdirSync(path.dirname(path.join(outDir, to)), { recursive: true });
    copyFileSync(path.join(root, from), path.join(outDir, to));
  }
  return { written: copies.map((copy) => copy.to), unlisted };
}

/** Removes from `outDir` whatever is not in `keep` (paths relative to it). Returns what it removed. */
export function pruneOutput(outDir, keep) {
  const kept = new Set(keep);
  const removed = [];
  const walk = (relative) => {
    for (const entry of readdirSync(path.join(outDir, relative), { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if ([...kept].some((file) => file.startsWith(`${name}/`))) walk(name);
        else {
          rmSync(path.join(outDir, name), { recursive: true, force: true });
          removed.push(`${name}/`);
        }
      } else if (!kept.has(name)) {
        rmSync(path.join(outDir, name), { force: true });
        removed.push(name);
      }
    }
  };
  walk('');
  return removed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const outDir = path.join(repo, 'dist');
  try {
    const absent = DIST_MANIFEST.tsup.filter((name) => !existsSync(path.join(outDir, name)));
    if (absent.length) throw new Error(`build-assets: ${absent.join(', ')} not found in ${outDir}: run tsup first (bun run build)`);
    const { written, unlisted } = copyBundledFiles({ outDir });
    const { bytes, inputs } = await buildRenderPage({ outFile: path.join(outDir, DIST_MANIFEST.renderPage) });
    const removed = pruneOutput(outDir, [...DIST_MANIFEST.tsup, DIST_MANIFEST.renderPage, ...written]);
    console.log(`render page: ${path.relative(process.cwd(), path.join(outDir, DIST_MANIFEST.renderPage))} (${(bytes / 1024).toFixed(0)} KB from ${inputs.length} files)`);
    console.log(`bundled files: ${written.length} copied to ${path.relative(process.cwd(), outDir) || '.'}`);
    for (const name of unlisted) console.warn(`build-assets: ${name} is not in the manifest (scripts/build-assets.mjs) and was not copied`);
    if (removed.length) console.log(`removed from the output, not in the manifest: ${removed.join(', ')}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
