import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { EMOTES_LIST, LOCOMOTION_EMOTES, TALK_EMOTE } from '../constants';
import { ASSET_LAYOUT, BUNDLED_DIRECTORIES, RENDER_PAGE_FILE, assetLayoutOf, bundledFile } from './asset-root';

interface DirectoryEntry {
  from: string;
  to: string;
  files: string[];
  optional: string[];
}
interface BuildAssets {
  DIST_MANIFEST: { tsup: string[]; renderPage: string; files: { from: string; to: string }[]; directories: DirectoryEntry[] };
  copyBundledFiles(options: { outDir: string; root?: string }): { written: string[]; unlisted: string[] };
  pruneOutput(outDir: string, keep: string[]): string[];
}
const { DIST_MANIFEST, copyBundledFiles, pruneOutput } = (await import(/* @vite-ignore */ new URL('../../../scripts/build-assets.mjs', import.meta.url).href)) as BuildAssets;

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const scratch: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'coo-asset-root-'));
  scratch.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Every bundled file the agent's code names, relative to the asset root */
const namedByTheCode = ['assets/base-environment.glb', 'assets/day2-2k.jpg', 'assets/day2.hdr', 'avatars/avatar.vrm', ...[...LOCOMOTION_EMOTES, ...EMOTES_LIST].map((emote) => emote.path)];

describe('the source layout (vitest, scripts that load the sources)', () => {
  it('finds every bundled file the code names under src/plugin-hyperfy/public', () => {
    expect(ASSET_LAYOUT.root).toBe(path.join(repo, 'src/plugin-hyperfy/public'));
    for (const name of namedByTheCode) {
      const file = bundledFile(name);
      expect(file, name).toBe(path.join(repo, 'src/plugin-hyperfy/public', name));
      expect(existsSync(file!), name).toBe(true);
    }
  });

  it("names the repository's dist/puppeteer/page.js as the render page, not the page's source file", () => {
    expect(ASSET_LAYOUT.renderPageBundle).toBe(path.join(repo, 'dist/puppeteer/page.js'));
  });
});

describe('the built layout (dist/index.js with the files scripts/build-assets.mjs puts next to it)', () => {
  it('finds every bundled file the code names, and the render page, where the build puts them', () => {
    const dist = tempDir();
    const { written } = copyBundledFiles({ outDir: dist });
    const layout = assetLayoutOf(path.join(dist, 'index.js'));

    expect(layout).toEqual({ root: dist, renderPageBundle: path.join(dist, DIST_MANIFEST.renderPage) });
    for (const name of namedByTheCode) {
      const file = bundledFile(name, layout);
      expect(file, name).toBe(path.join(dist, name));
      expect(existsSync(file!), name).toBe(true);
      expect(written, name).toContain(name);
    }
    // PhysX's .wasm goes next to index.js, where the engine's glue code looks for it
    expect(existsSync(path.join(dist, 'physx-js-webidl.wasm'))).toBe(true);
  });

  it('copies exactly the directories the resolver serves, and the render page to the path the resolver names', () => {
    expect(DIST_MANIFEST.directories.map((directory) => directory.to)).toEqual([...BUNDLED_DIRECTORIES]);
    expect(DIST_MANIFEST.renderPage).toBe(RENDER_PAGE_FILE);
    // The emote the owner may add is in the manifest too, as optional
    const emotes = DIST_MANIFEST.directories.find((directory) => directory.to === 'emotes')!;
    expect(emotes.optional.map((name) => `emotes/${name}`)).toEqual([TALK_EMOTE.path]);
    expect([...emotes.files].sort()).toEqual([...LOCOMOTION_EMOTES, ...EMOTES_LIST].map((emote) => path.basename(emote.path)).sort());
  });
});

describe('bundledFile', () => {
  const layout = assetLayoutOf('/opt/agent/dist/index.js');

  it.each([
    ['an absolute path', '/etc/hosts'],
    ['a path that leaves the root', '../secrets.json'],
    ['a path that leaves through a bundled directory', 'assets/../../secrets.json'],
    ['a path that comes back to another directory of the root', 'assets/../index.js'],
    ['a file of the root itself', 'index.js'],
    ['the render page', 'puppeteer/page.js'],
    ['a bundled directory itself', 'emotes'],
    ['a directory that only starts like a bundled one', 'assets-private/key.pem'],
    ['the empty path', ''],
  ])('gives no path for %s', (_name, relative) => {
    expect(bundledFile(relative, layout)).toBeNull();
  });

  it('gives the path of a file in a bundled directory, also in a directory below it', () => {
    expect(bundledFile('emotes/emote-idle.glb', layout)).toBe('/opt/agent/dist/emotes/emote-idle.glb');
    expect(bundledFile('assets/./sky/../day2.hdr', layout)).toBe('/opt/agent/dist/assets/day2.hdr');
    expect(bundledFile('avatars/mine/avatar.vrm', layout)).toBe('/opt/agent/dist/avatars/mine/avatar.vrm');
  });
});

describe('scripts/build-assets.mjs', () => {
  /** A root with every input of the manifest as a one-byte file */
  const fakeRoot = () => {
    const root = tempDir();
    const put = (relative: string) => {
      mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
      writeFileSync(path.join(root, relative), 'x');
    };
    for (const file of DIST_MANIFEST.files) put(file.from);
    for (const directory of DIST_MANIFEST.directories) for (const name of directory.files) put(`${directory.from}/${name}`);
    return { root, put };
  };

  it('stops, naming every missing input, before it writes anything', () => {
    const { root } = fakeRoot();
    rmSync(path.join(root, 'src/plugin-hyperfy/public/avatars/avatar.vrm'));
    rmSync(path.join(root, DIST_MANIFEST.files[0].from));
    const out = tempDir();

    expect(() => copyBundledFiles({ outDir: out, root })).toThrow(`build-assets: missing inputs: ${DIST_MANIFEST.files[0].from}, src/plugin-hyperfy/public/avatars/avatar.vrm`);
    expect(readdirSync(out)).toEqual([]);
  });

  it('copies an optional file when it is there, and reports a file the manifest does not name without copying it', () => {
    const { root, put } = fakeRoot();
    const out = tempDir();
    expect(copyBundledFiles({ outDir: out, root }).written).not.toContain('emotes/emote-talk.glb');

    put('src/plugin-hyperfy/public/emotes/emote-talk.glb');
    put('src/plugin-hyperfy/public/emotes/emote-unlisted.glb');
    put('src/plugin-hyperfy/public/emotes/.DS_Store');
    const { written, unlisted } = copyBundledFiles({ outDir: out, root });

    expect(written).toContain('emotes/emote-talk.glb');
    expect(unlisted).toEqual(['src/plugin-hyperfy/public/emotes/emote-unlisted.glb']);
    expect(readdirSync(path.join(out, 'emotes')).sort()).toEqual([...DIST_MANIFEST.directories[2].files, 'emote-talk.glb'].sort());
  });

  it('leaves in the output only what the build wrote: stale files and empty directories of earlier builds go', () => {
    const { root } = fakeRoot();
    const out = tempDir();
    for (const stale of ['scripts', 'emotes']) mkdirSync(path.join(out, stale), { recursive: true });
    for (const stale of ['index.js', 'index.js.map', 'physx-js-webidl.js', 'emotes/emote-removed.glb', 'old/deep/file.txt']) {
      mkdirSync(path.dirname(path.join(out, stale)), { recursive: true });
      writeFileSync(path.join(out, stale), 'x');
    }

    const { written } = copyBundledFiles({ outDir: out, root });
    const removed = pruneOutput(out, [...DIST_MANIFEST.tsup, ...written]);

    expect(removed.sort()).toEqual(['old/', 'physx-js-webidl.js', 'scripts/']);
    expect(readdirSync(out).sort()).toEqual(['assets', 'avatars', 'emotes', 'index.js', 'index.js.map', 'physx-js-webidl.wasm']);
    expect(existsSync(path.join(out, 'emotes/emote-removed.glb'))).toBe(false);
  });
});
