/**
 * Where the files that ship with the agent are on disk: the base environment, the avatar, the
 * emotes, and the built render page. There are two layouts.
 *
 *   built    dist/index.js holds this module, and scripts/build-assets.mjs puts the files next to
 *            it: dist/assets, dist/avatars, dist/emotes, dist/puppeteer/page.js
 *   source   this file is src/plugin-hyperfy/lib/asset-root.ts (vitest, scripts that load the
 *            sources) and the files are in src/plugin-hyperfy/public. The render page is a build
 *            product: it is where `bun run build` writes it, the repository's
 *            dist/puppeteer/page.js, and missing until then.
 *
 * The layout is told from this module's own file name, not by looking at the disk.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The directories of bundled files, relative to the asset root (scripts/build-assets.mjs copies exactly these) */
export const BUNDLED_DIRECTORIES: readonly string[] = ['assets', 'avatars', 'emotes'];
/** The built render page, relative to the asset root */
export const RENDER_PAGE_FILE = 'puppeteer/page.js';

export interface AssetLayout {
  /** The directory the bundled directories are in */
  root: string;
  /** The built render page (scripts/build-assets.mjs) */
  renderPageBundle: string;
}

/** The layout for the module file this code runs from (`moduleFile`: its absolute path). */
export function assetLayoutOf(moduleFile: string): AssetLayout {
  const directory = path.dirname(moduleFile);
  const inSource = /^asset-root\.[cm]?[jt]s$/.test(path.basename(moduleFile)) && path.basename(directory) === 'lib';
  if (inSource) {
    return {
      root: path.join(directory, '..', 'public'),
      renderPageBundle: path.join(directory, '..', '..', '..', 'dist', ...RENDER_PAGE_FILE.split('/')),
    };
  }
  return { root: directory, renderPageBundle: path.join(directory, ...RENDER_PAGE_FILE.split('/')) };
}

export const ASSET_LAYOUT: AssetLayout = assetLayoutOf(fileURLToPath(import.meta.url));

/**
 * The absolute path of the bundled file `relative` names (`emotes/emote-idle.glb`), or null when
 * that is not a path inside one of the bundled directories: absolute, leaving the root through
 * `..`, or in any other directory of the root (dist/index.js, the render page's sources).
 * Whether the file exists is not checked.
 */
export function bundledFile(relative: string, layout: AssetLayout = ASSET_LAYOUT): string | null {
  if (path.isAbsolute(relative)) return null;
  const root = path.resolve(layout.root);
  const full = path.resolve(root, relative);
  const inside = path.relative(root, full).split(path.sep);
  if (inside.length < 2 || !BUNDLED_DIRECTORIES.includes(inside[0])) return null;
  return full;
}
