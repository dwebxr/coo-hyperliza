#!/usr/bin/env node
/*
 * Builds what the agent needs next to dist/index.js that tsup does not produce. So far that is
 * the render page (dist/puppeteer/page.js); the bundled models, emotes and PhysX files are still
 * copied by the `build` script in package.json.
 *
 *   node scripts/build-assets.mjs [--out <file>]
 *
 * The render page is ONE classic script: the page's own code (src/plugin-hyperfy/public/puppeteer
 * and public/scripts) together with three.js and three-vrm. Headless Chromium runs it in an empty
 * page with no network, where an ES module could not be loaded at all (a file:// page may not
 * import modules, and nothing else is reachable).
 *
 * The page uses three.js 0.132.2 and @pixiv/three-vrm 3.3.3, the versions it was written against
 * (it used to load exactly these from a CDN), not the newer ones the agent runs on. They are the
 * devDependencies `page-three` and `page-three-vrm` (npm aliases); the build fails if those are
 * any other version, or if more than one copy of three.js ends up in the bundle.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

export const PAGE_LIBRARIES = Object.freeze({ 'page-three': '0.132.2', 'page-three-vrm': '3.3.3' });
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
 * imports are mapped the way its import map used to map them.
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
  const bytes = Object.values(result.metafile.outputs)[0].bytes;
  return { outFile, bytes, inputs };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const index = process.argv.indexOf('--out');
  const outFile = index === -1 ? path.join(repo, 'dist/puppeteer/page.js') : path.resolve(process.argv[index + 1]);
  const { bytes, inputs } = await buildRenderPage({ outFile });
  console.log(`render page: ${path.relative(process.cwd(), outFile)} (${(bytes / 1024).toFixed(0)} KB from ${inputs.length} files)`);
}
