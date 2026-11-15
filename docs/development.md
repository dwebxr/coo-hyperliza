# Development

## Tests and Type Check

`bun run test` runs the tests (vitest, under Node; they reach nothing but 127.0.0.1) and `bun run typecheck` the type check (`strict`).

## The Two Smokes

Neither is part of `bun run test`. Both run from a directory outside the repository, start nothing in the repository's own directory (where the CLI would load `.env`), use no real key and send nothing off this machine.

```bash
bun run build
node scripts/smoke-boot.mjs --dir /tmp/coo-smoke    # a directory outside the repository with no .env in it or above it
```

The boot smoke copies `dist/` into a run directory and starts `elizaos start` there under Bun with a dummy key and an unreachable world (`ws://127.0.0.1:9`), five times:

- `off` and `sandboxed` (the two `HYPERFY_WORLD_SCRIPTS` modes), on a throwaway PostgreSQL cluster: the agent is listed by the API, the API and Socket.IO refuse a request without the token, the engine starts from the built files (PhysX included), the agent tries to connect and schedules a retry, passes the sandbox self-test, returns no key from its API, brings its render page up in Chromium without handing Chromium any key, hands Sentry no usable DSN, contacts nothing but 127.0.0.1 (Chromium included), and exits on SIGTERM;
- `off-locked`: without `SERVER_HOST` and a token the API listens on loopback only and stays locked;
- `off-bad-limit`: with a usage limit that is not a number (`AI_MAX_CALLS_PER_HOUR=not-a-number`) and a per-purpose cap of 0 (`AI_MAX_TOKENS_CHAT=0`) the agent names both variables and exits by itself without connecting to a world;
- `off-pglite`: with no `POSTGRES_URL` and a `PGLITE_DATA_DIR` it boots the same way on PGLite and keeps its database there.

It needs `initdb`/`pg_ctl` from PostgreSQL 17 with pgvector (`SMOKE_PG_BIN` overrides the Homebrew path) and the Chromium that puppeteer installed (`SMOKE_PUPPETEER_CACHE_DIR` overrides `~/.cache/puppeteer`). What it does not prove: anything that needs a world. The agent never gets into one there, so no chat, no turn, no model call, no snapshot, no world script beyond the self-test's own, no voice and no tip sign-in is exercised. "Nothing left the machine" is checked by pointing proxy-aware clients at a recorder and by sampling sockets every 200 ms: a shorter connection, and DNS lookups, would not be seen.

```bash
node scripts/smoke-chromium.mjs --dir /tmp/coo-chromium-smoke    # an empty directory outside the repository
```

The render-page smoke drives the agent's real page manager and render page in the real Chromium with the bundled avatar, an emote, the base environment, the sky image and the HDR. It checks that every kind of snapshot comes out as a picture with something in it, that the picture all around has every side drawn with a pane of glass in the scene, that no shader failed to compile while the workload's snapshots were drawn (the avatar's toon material among them, also with a normal map and tangents), that loads which fail or are cancelled leave nothing in the page, that the page's caches are bounded, that Chromium has the offline arguments and none of the agent's keys and can reach nothing (this machine's own ports included, also from a second tab), that a lost page is rebuilt, and that a page call that allocates without end gets Chromium killed by the watchdog with no process left behind. Run it (under Node, and under Bun, which is what the agent runs on: `bun --env-file=/dev/null scripts/smoke-chromium.mjs …`, so that Bun does not load `.env`) after changing the render page, the manager that drives it, puppeteer or Chromium. What it does not prove: it starts neither the agent nor the engine, its scene is a small one built for the purpose, not a live world's, and its memory figures are this machine's. Chromium's sockets are sampled every 150 ms.

## After Upgrading Bun, elizaOS, puppeteer or Another Dependency

1. `bun install --frozen-lockfile` (after a puppeteer upgrade: check that the Chrome build it pins was downloaded, see [Chromium](setup.md#chromium)).
2. `bun run test`, `bun run typecheck`, `bun run build`.
3. Both smokes. The boot smoke's `sandboxed` run matters most after a Bun or elizaOS upgrade: SES lockdown is sensitive to new built-ins (it removes the ones it does not know and logs them), and the self-test only proves that the escapes it knows are closed.
4. `bun audit`, and compare with [Dependency Advisories](#dependency-advisories).
5. After a puppeteer upgrade, also read how the new version starts Chromium: the watchdog kills the browser by its process group, which relies on puppeteer starting Chromium detached (as 25.16.0 does on macOS and Linux: `@puppeteer/browsers`' `launch.js`). The render-page smoke's last check fails if that changed.

Some packages are pinned to an exact version in `package.json` because a guard was written and tested against how that version works inside, so that only a deliberate edit moves them. What to re-run when one is changed, besides the list above:

| Package (pinned at) | What depends on its internals | Re-run |
|---|---|---|
| `msgpackr` (1.12.1) | The bounded packet decoder reads exactly what this version's `unpack` reads (`src/plugin-hyperfy/lib/packet-decode.ts`) | The decoder's differential tests, `src/plugin-hyperfy/lib/packet-decode.test.ts` (a test asserts the installed version) |
| `ses` (1.15.0) | `lockdown()` with the options the sandbox passes, what it removes and refuses, and the compartments behind the script membrane | `src/plugin-hyperfy/lib/script-*.test.ts` (the child tests run real lockdown under Bun and Node) and the boot smoke's `sandboxed` run |
| `puppeteer` (25.16.0) | Chromium started in a process group of its own (the watchdog's kill), request interception, the Chrome build it pins | The render-page smoke under Node and under Bun, and the boot smoke |
| `@elizaos/cli`, `@elizaos/core`, `@elizaos/plugin-sql` (1.7.2, always the same version for all three) | How core runs actions (no `validate()`, how it resolves names, when it delivers a callback), how secrets are stored and merged, the server's token checks, its `.env` endpoint and its Sentry default, the CLI's start path | `bun run test` (the tests in `src/plugin-hyperfy/actions/`, `src/agent-secrets.test.ts` and others drive the real core) and the whole boot smoke, the `off-locked` run in particular |
| `page-three`, `page-three-vrm` (0.132.2, 3.3.3) | The render page is written against them; the build fails on any other version | `bun run build` and the render-page smoke |
| `@anthropic-ai/sdk` (0.133.0) | No retries of its own, and the error classes the budget tells billed from refused calls by | `src/anthropic-models*.test.ts` (one of them runs the real SDK against a local server) |

`three` and `@livekit/rtc-node` are 0.x versions, whose caret range stays within the minor version; `lodash-es` is used for plain helpers only.

## Dependency Advisories

`bun audit` reports four advisories in installed packages (3 moderate, 1 low). None is in code the running agent executes:

| Package (advisory) | How it is installed | When its code runs | What would remove it |
|---|---|---|---|
| `esbuild` ≤ 0.24.2, moderate (GHSA-67mh-4wv8-2f99: its development server answers any website) | The 0.18.20 copy under `@elizaos/plugin-sql` > `drizzle-kit` > `@esbuild-kit/*` (the build's own esbuild is 0.28.2, not affected) | Never: nothing starts esbuild's development server, and plugin-sql does not load drizzle-kit at run time | A drizzle-kit without `@esbuild-kit` (upstream) |
| `glob` 13.0.6, moderate (GHSA-3g3m-2fjr-6pw4) and `minimatch` 10.2.6, moderate (GHSA-g3hv-75wg-m249) | `@elizaos/core` and `@elizaos/cli` > `rimraf` > `glob` | Not on `elizaos start`/`dev`: the CLI's bundled copy is used by `elizaos report generate` (a fixed pattern, no cancellation signal) and `elizaos env reset`; core's Node build does not contain glob | glob 14.0.2+ / minimatch 11.0.1+, a major version for elizaOS to take |
| `elliptic` 6.6.1, low (GHSA-848j-6mx2-7j84) | `@elizaos/core` > `crypto-browserify` | Never under Bun or Node: core uses the runtime's own `crypto` there and falls back to its bundled `crypto-browserify` only in a browser | elizaOS dropping `crypto-browserify` (no fixed elliptic exists) |

No override forces a major version of these onto elizaOS. After any dependency change, run `bun audit` again and compare.
