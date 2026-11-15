# Setup Notes

The commands are in the README's [Quick Start](../README.md#quick-start). This page holds what lies behind each step.

## Database

elizaOS uses PostgreSQL when `POSTGRES_URL` is set, and its embedded PGLite database otherwise. Both work with this agent: the [boot smoke](development.md#the-two-smokes) starts it once on each.

elizaOS creates the extensions it uses on first start (`vector`, which is pgvector, `fuzzystrmatch` and `pgcrypto`), so pgvector must be installed for your PostgreSQL and the role in `POSTGRES_URL` must be allowed to create extensions.

PGLite: leave `POSTGRES_URL` unset or empty. The database's files are then kept in `PGLITE_DATA_DIR`, or in `.eliza/.elizadb` under the directory the agent is started in when that is unset too. What was checked is that the agent boots on it and keeps its record there (Bun 1.4.4, elizaOS 1.7.2); it has not been run in a world for any length of time. Switching from one database to the other starts with an empty agent record.

## Dependencies

`bun.lock` is committed so installs get exactly the audited dependency versions (Bun 1.2 or newer reads it). Node.js is needed beside Bun: the build, the install scripts and the smokes run under `node`. The project's own postinstall step (custom CSS for the web UI) runs automatically; rerun it with `bun run postinstall` if needed. Bun runs dependencies' install scripts only for [trusted packages](https://bun.sh/docs/pm/lifecycle).

## Chromium

The agent draws its snapshots in the Chrome build its puppeteer version is pinned to, found in `~/.cache/puppeteer` (`PUPPETEER_CACHE_DIR` moves it). puppeteer is on Bun's default list of trusted packages, so `bun install` runs puppeteer's own install script, which downloads that build (and `chrome-headless-shell`) from Google's Chrome for Testing storage and unpacks it. `PUPPETEER_SKIP_DOWNLOAD=1` skips the download; without the browser the agent still runs and logs `[PuppeteerManager] Failed to launch browser`, but its render page is missing: models, avatars and the sky are not loaded, and it cannot look at the world. `bunx puppeteer browsers install chrome` fetches it later. puppeteer unpacks the archive with the system's `unzip`, which must be on `PATH` for the install (macOS and most Linux systems have it; a stripped-down container image may not). Behind an HTTP(S) proxy the download does not go through it by itself: since puppeteer 25 that needs the optional `proxy-agent` package (8.0.1 or later), which this project does not install, to keep its dependency tree (a PAC script evaluator included) out of every installation. Where a proxy is required, add `proxy-agent` for the install, or copy `~/.cache/puppeteer` from a machine that has the build.

## ffmpeg

Voice output and input need ffmpeg. ffmpeg is found through `PATH`.

## Build and Run

`bun run build` is `tsup` followed by `scripts/build-assets.mjs`, which puts everything else the built agent reads next to `dist/index.js`, from one manifest: the bundled render page (`dist/puppeteer/page.js`, the page the agent's headless Chromium draws its snapshots on), PhysX's `.wasm` from the engine submodule (so the clone needs `--recurse-submodules`), and `assets/`, `avatars/`, `emotes/`. A listed file that is missing stops the build; a file in those directories that the manifest does not name is not copied (a warning names it); anything else in `dist/` is removed.

`bun run dev` / `bun run start` (`elizaos dev` / `elizaos start`) delete `dist/` and run the build themselves on every start, so the devDependencies must be installed where the agent runs. A build that fails does not stop the start: the CLI logs `Build failed` and goes on, without Coo if the project cannot be loaded (see [Security](security.md#start-paths-that-skip-coos-defaults)). The elizaOS CLI also asks the npm registry for its latest version on every start. If `SERVER_PORT` (default 3000) is in use, elizaOS takes the next free port; the log says which.
