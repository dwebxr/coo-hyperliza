# Coo Hyperliza

An ElizaOS + Hyperfy 3D world integration agent. An AI agent that autonomously acts and can have voice conversations within Hyperfy VR worlds, writes with Claude, and can work as a shop clerk for OpenPay Store.

## Features

### Cost Optimization
See "Cost Controls and Usage Limits" for the settings.
- **Scripted Idle Behavior**: Between Claude decisions the agent patrols or wanders around its post, waves at players who arrive and looks around, with no API calls. Claude decides an autonomous action at most every 2 minutes and 20 times an hour by default (both configurable), and never right after a conversation
- **Idle Mode Energy Saving**: When no other players are in the world, autonomous actions are skipped entirely (no API call is made) and the loop only re-checks for players every 60-120 seconds
- **Simple Requests Without Claude**: "Come here" / "follow me" / "stop" (English or Japanese) from the player talking to the agent are carried out directly: it walks to where the speaker is (teleports when they are more than 30 m away), or stops. Only a short message that is nothing but the command counts; "follow me" is one walk to the speaker, not continued following
- **One Call per Look**: The look itself takes one Claude call with the snapshot, on top of the reply call that chose it (how to look is chosen from the player's words). A look at an entity the agent could not walk to is not taken (and not counted) unless the same entity is still there, within 20 m of where the agent stopped, judged by where it is then; a walk that was stopped or replaced takes no look at all, nor does one at an entity that was removed on the way
- **Cheaper Reply Decisions**: Messages that mention the agent's name or an alias (see `HYPERFY_AGENT_ALIASES`) skip the "should I respond?" LLM check, and so do messages from the only other player in the world
- **Output Caps per Purpose**: Each kind of call (reply, decision, extraction, vision) has its own `max_tokens`
- **Separate Budgets**: Claude, vision, speech output and voice input each have their own optional limit. When the Claude budget is used up the agent keeps patrolling and waving, and still posts a product's purchase link when a player talking to it names it
- **Usage Reports**: Calls, tokens and voice usage per purpose and origin are logged every hour

### Voice Features
- **ElevenLabs TTS and speech-to-text**: High-quality voice output, and voice input from players
- **OpenAI TTS Fallback**: Uses OpenAI TTS when ElevenLabs is unavailable (optional)
- **LiveKit Audio Streaming**: Real-time audio delivery to the Hyperfy world

### Avatar Features
- **VRM Avatar Support**: Use a custom VRM avatar (`src/plugin-hyperfy/public/avatars/avatar.vrm`, which the build copies to `dist/avatars/`). The world must allow it: see "Avatar Not Shown" below
- **Emote System**: Play animations based on emotions
- **Talking Gesture and Lip Sync**: Plays the TALK animation while speaking. The mouth is moved by the world's own client from the agent's voice (coo-world supports this); nothing is needed on the agent side. A custom clip at `src/plugin-hyperfy/public/emotes/emote-talk.glb` is uploaded in place of the world's talking gesture where the world lets the agent upload clips (builder rank)
- **Walking Animations**: Uses the agent's own walk/run/idle clips when the world has them or lets the agent upload them; otherwise the world's own clips (Hyperfy's `mp-*` set), sped up to match the agent's movement

### Autonomous Actions
- **Walking Around**: Patrol a fixed route (`PATROL_POINTS`) or wander around its post
- **Greeting Players**: Wave at players who arrive, walking over first when they are 4 to 20 m away. In a world that was empty the first greeting can take up to two minutes (the loop only re-checks for players every 60-120 seconds)
- **Approaching Players**: Walk towards nearby players
- **Item Usage**: Interact with objects in the world. Items are made by the world's app scripts, which the agent runs only with `HYPERFY_WORLD_SCRIPTS=sandboxed` (see "World App Scripts")
- **Conversation**: Text chat and voice conversations. The world cuts chat messages at 500 characters, so longer replies are posted as up to four messages; text beyond that ends with an ellipsis

## Setup

### 1. Clone the Repository

```bash
git clone --recurse-submodules https://github.com/dwebxr/coo-hyperliza.git
cd coo-hyperliza
```

### 2. Configure Environment Variables

```bash
cp .env.example .env
```

Edit the `.env` file and set the required values:

```env
# Hyperfy Connection
WS_URL=wss://your-hyperfy-world.xyz/ws

# Database: PostgreSQL (or leave POSTGRES_URL out for the embedded PGLite, see step 3)
POSTGRES_URL=postgresql://localhost:5432/eliza_hyperfy

# Claude (required; see "Model Selection")
ANTHROPIC_API_KEY=your-anthropic-api-key

# ElevenLabs voice (optional)
ELEVENLABS_XI_API_KEY=your-elevenlabs-api-key
ELEVENLABS_VOICE_ID=your-voice-id
ELEVENLABS_MODEL_ID=eleven_flash_v2_5
ELEVENLABS_OUTPUT_FORMAT=mp3_44100_128

# Server Settings (127.0.0.1 = reachable from this machine only)
SERVER_PORT=3001
SERVER_HOST=127.0.0.1
# Token for the web UI / API (clients send it as X-API-KEY); leave it unset to keep them locked
ELIZA_SERVER_AUTH_TOKEN=a-long-random-string
# The same value: Socket.IO checks this one (needed when the project is not loaded, see below)
SERVER_API_KEY=a-long-random-string
# The key elizaOS encrypts its stored secrets with
SECRET_SALT=another-long-random-string
```

> **Security**: `localstorage.json` holds the agent's Hyperfy auth token. Never commit it, and never paste logs that contain it.
> **The elizaOS web UI / API.** Whoever may use it can read the `.env` file the server finds (`GET /api/system/env/local`: every key, `TIP_WALLET_PRIVATE_KEY` included) and rewrite it (`POST`), read the agent's stored database record including its stored secrets (`GET /api/agents/<id>`), control the agent, and over its Socket.IO connections send the agent messages and stream its logs. elizaOS authenticates the REST API only when `ELIZA_SERVER_AUTH_TOKEN` is set (clients send it as `X-API-KEY`) and Socket.IO only when `SERVER_API_KEY` is set (the web UI sends the one key it stores for both), and listens on every interface (`0.0.0.0`) when `SERVER_HOST` is unset. So when the CLI loads this project (`elizaos start` / `elizaos dev`, which `bun run start` / `bun run dev` run), Coo, at startup:
> - with `SERVER_HOST` unset, makes the server listen on `127.0.0.1` only;
> - with `ELIZA_SERVER_AUTH_TOKEN` unset or empty, locks the REST API and Socket.IO for that run with a random token that is never shown or stored: every request under `/api` gets 401 (except CORS preflight `OPTIONS` requests, which elizaOS answers without the token and which carry nothing) and every Socket.IO connection is refused, unless you set `SERVER_API_KEY` yourself: Socket.IO then accepts that key while the REST API stays locked (the `/healthz` and `/health` status routes and the web UI's own files still answer). A request's body is read and parsed before the token is checked (elizaOS registers its JSON body parser before its authentication; up to `EXPRESS_MAX_PAYLOAD`, 2 MB by default): a malformed JSON body is answered 500 and logged as an API error (and reported, if you set a Sentry DSN), whatever token it carries. To use the web UI or API, set your own `ELIZA_SERVER_AUTH_TOKEN` in `.env` and restart;
> - with `SERVER_API_KEY` unset, uses the REST token for Socket.IO too, so your own token unlocks both.
>
> **These defaults only apply when the CLI loads this project.** `elizaos start --character <file>` and `elizaos dev --character <file>` start the server without loading it, and then none of the above applies. The same holds when the project fails to load (a failed build, a missing dependency): the CLI only logs a warning (`Failed to import project`) and still starts the server, without Coo and without these defaults. On those start paths only `.env` protects the server (the CLI loads `.env` over the environment: a key that is in `.env`, even with an empty value, replaces the same variable from the shell), and it needs all three of these:
> - `SERVER_HOST=127.0.0.1`;
> - `ELIZA_SERVER_AUTH_TOKEN=<your token>` (the REST API);
> - `SERVER_API_KEY=<the same token>` (Socket.IO reads this one, not the REST token).
>
> Without them, such a start serves the REST API and Socket.IO with no authentication on every network interface: anyone who can reach the port can read and rewrite `.env`, read the stored secrets and control the agent. The example file has all three; fill in your own token for both, and keep the three lines in `.env` in any case.
>
> What remains: with your own token, the API is as strong as that token, and anyone who has it can read and rewrite `.env`; with a token and a non-loopback `SERVER_HOST`, anyone on the network who has the token can (Coo logs a warning then). On the locked default, other programs on this machine and web pages in your browser cannot use the REST API or Socket.IO. The token does not cover `/media/uploads/...` and `/media/generated/...`, which serve files from elizaOS's data directory to whoever knows the agent or channel id and the file name (Coo itself puts none there). The random token lives in the agent's process environment; the processes the agent starts (Chromium, ffmpeg) are given a reduced environment without it and without the API keys.
>
> **Error reports.** The elizaOS server sends error reports (which can hold chat text, file paths and settings) to elizaOS's own Sentry project unless `SENTRY_DSN` names another, and an empty `SENTRY_DSN` means that default. When the CLI loads this project, Coo sets `SENTRY_DSN=off` for the run while it is unset or empty, and logs one `[Security]` line: Sentry then logs `Invalid Sentry Dsn: off` once, creates no transport and sends nothing. Your own DSN is left alone. `elizaos start --character <file>` does not load the project, so there only `.env` holds: keep `SENTRY_DSN=off` there (the example file has it), or put your own DSN.
>
> Stored secrets: Coo does not copy `.env` into the agent record. On each start it deletes what earlier versions stored there: the keys that are in `.env` now, in the start's own merge, and, once the agent has started, every other stored secret except the settings elizaOS reads from the record and the variables its CLI copies. That includes secrets added through the web UI, which therefore do not survive a restart. A setting elizaOS reads from the record (such as `OBJECT_SMALL_TEMPERATURE`) stays stored, and in force, after you remove it from `.env`; delete it from the agent record to drop it. If that second step fails, the log says so (`[Secrets] Could not …`) and those keys stay stored. elizaOS itself still stores the variables its CLI copies from the environment, notably `POSTGRES_URL` (or `PGLITE_DATA_DIR`), and the settings it reads from the record (such as per-model tuning like `OBJECT_SMALL_TEMPERATURE`). Stored secrets are encrypted with `SECRET_SALT`; its default, `secretsalt`, is public, so set your own.

### 3. Set Up the Database

elizaOS uses PostgreSQL when `POSTGRES_URL` is set, and its embedded PGLite database otherwise. Both work with this agent: the boot smoke (step 6) starts it once on each.

PostgreSQL (what the examples here use):

```bash
# For macOS
brew install postgresql@14
brew services start postgresql@14

# Create database
createdb eliza_hyperfy
```

elizaOS creates the extensions it uses on first start (`vector`, which is pgvector, `fuzzystrmatch` and `pgcrypto`), so pgvector must be installed for your PostgreSQL and the role in `POSTGRES_URL` must be allowed to create extensions.

PGLite: leave `POSTGRES_URL` unset or empty. The database's files are then kept in `PGLITE_DATA_DIR`, or in `.eliza/.elizadb` under the directory the agent is started in when that is unset too. What was checked is that the agent boots on it and keeps its record there (Bun 1.4.4, elizaOS 1.7.2); it has not been run in a world for any length of time. Switching from one database to the other starts with an empty agent record.

### 4. Install Dependencies

```bash
bun install --frozen-lockfile
```

`bun.lock` is committed so installs get exactly the audited dependency versions (Bun 1.2 or newer reads it). Node.js is needed beside Bun: the build, the install scripts and the smokes run under `node`. The project's own postinstall step (custom CSS for the web UI) runs automatically; rerun it with `bun run postinstall` if needed. Bun runs dependencies' install scripts only for [trusted packages](https://bun.sh/docs/pm/lifecycle).

**Chromium.** The agent draws its snapshots in the Chrome build its puppeteer version is pinned to, found in `~/.cache/puppeteer` (`PUPPETEER_CACHE_DIR` moves it). puppeteer is on Bun's default list of trusted packages, so `bun install` runs puppeteer's own install script, which downloads that build (and `chrome-headless-shell`) from Google's Chrome for Testing storage and unpacks it. `PUPPETEER_SKIP_DOWNLOAD=1` skips the download; without the browser the agent still runs and logs `[PuppeteerManager] Failed to launch browser`, but its render page is missing: models, avatars and the sky are not loaded, and it cannot look at the world. `bunx puppeteer browsers install chrome` fetches it later. The download is the only place the `extract-zip` advisories apply (see "Dependency Advisories").

### 5. Install ffmpeg (Required for Voice Features)

```bash
# For macOS
brew install ffmpeg
```

ffmpeg is found through `PATH`.

### 6. Build and Run

```bash
bun run build
bun run dev
```

`bun run build` is `tsup` followed by `scripts/build-assets.mjs`, which puts everything else the built agent reads next to `dist/index.js`, from one manifest: the bundled render page (`dist/puppeteer/page.js`, the page the agent's headless Chromium draws its snapshots on), PhysX's `.wasm` from the engine submodule (so the clone needs `--recurse-submodules`), and `assets/`, `avatars/`, `emotes/`. A listed file that is missing stops the build; a file in those directories that the manifest does not name is not copied (a warning names it); anything else in `dist/` is removed.

`bun run dev` / `bun run start` (`elizaos dev` / `elizaos start`) delete `dist/` and run the build themselves on every start, so the devDependencies must be installed where the agent runs. A build that fails does not stop the start: the CLI logs `Build failed` and goes on, without Coo if the project cannot be loaded (see the security note in step 2). The elizaOS CLI also asks the npm registry for its latest version on every start. If `SERVER_PORT` (default 3000) is in use, elizaOS takes the next free port; the log says which.

`bun run test` runs the tests (vitest, under Node; they reach nothing but 127.0.0.1) and `bun run typecheck` the type check (`strict`).

#### The two smokes

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

The render-page smoke drives the agent's real page manager and render page in the real Chromium with the bundled avatar, an emote, the base environment, the sky image and the HDR. It checks that every kind of snapshot comes out as a picture with something in it, that loads which fail or are cancelled leave nothing in the page, that the page's caches are bounded, that Chromium has the offline arguments and none of the agent's keys and can reach nothing (this machine's own ports included, also from a second tab), that a lost page is rebuilt, and that a page call that allocates without end gets Chromium killed by the watchdog with no process left behind. Run it (under Node, and under Bun, which is what the agent runs on: `bun --env-file=/dev/null scripts/smoke-chromium.mjs …`, so that Bun does not load `.env`) after changing the render page, the manager that drives it, puppeteer or Chromium. What it does not prove: it starts neither the agent nor the engine, its scene is a small one built for the purpose, not a live world's, and its memory figures are this machine's. Chromium's sockets are sampled every 150 ms.

#### After upgrading Bun, elizaOS, puppeteer or another dependency

1. `bun install --frozen-lockfile` (after a puppeteer upgrade: check that the Chrome build it pins was downloaded, see step 4).
2. `bun run test`, `bun run typecheck`, `bun run build`.
3. Both smokes. The boot smoke's `sandboxed` run matters most after a Bun or elizaOS upgrade: SES lockdown is sensitive to new built-ins (it removes the ones it does not know and logs them), and the self-test only proves that the escapes it knows are closed.
4. `bun audit`, and compare with "Dependency Advisories".
5. After a puppeteer upgrade, also read how the new version starts Chromium: the watchdog kills the browser by its process group, which relies on puppeteer starting Chromium detached (as 24.x and 25.x do on macOS and Linux). The render-page smoke's last check fails if that changed.

Some packages are pinned to an exact version in `package.json` because a guard was written and tested against how that version works inside, so that only a deliberate edit moves them. What to re-run when one is changed, besides the list above:

| Package (pinned at) | What depends on its internals | Re-run |
|---|---|---|
| `msgpackr` (1.12.1) | The bounded packet decoder reads exactly what this version's `unpack` reads (`src/plugin-hyperfy/lib/packet-decode.ts`) | The decoder's differential tests, `src/plugin-hyperfy/lib/packet-decode.test.ts` (a test asserts the installed version) |
| `ses` (1.15.0) | `lockdown()` with the options the sandbox passes, what it removes and refuses, and the compartments behind the script membrane | `src/plugin-hyperfy/lib/script-*.test.ts` (the child tests run real lockdown under Bun and Node) and the boot smoke's `sandboxed` run |
| `puppeteer` (24.43.1) | Chromium started in a process group of its own (the watchdog's kill), request interception, the Chrome build it pins | The render-page smoke under Node and under Bun, and the boot smoke |
| `@elizaos/cli`, `@elizaos/core`, `@elizaos/plugin-sql` (1.7.2, always the same version for all three) | How core runs actions (no `validate()`, how it resolves names, when it delivers a callback), how secrets are stored and merged, the server's token checks, its `.env` endpoint and its Sentry default, the CLI's start path | `bun run test` (the tests in `src/plugin-hyperfy/actions/`, `src/agent-secrets.test.ts` and others drive the real core) and the whole boot smoke, the `off-locked` run in particular |
| `page-three`, `page-three-vrm` (0.132.2, 3.3.3) | The render page is written against them; the build fails on any other version | `bun run build` and the render-page smoke |
| `@anthropic-ai/sdk` (0.133.0) | No retries of its own, and the error classes the budget tells billed from refused calls by | `src/anthropic-models*.test.ts` (one of them runs the real SDK against a local server) |

`three` and `@livekit/rtc-node` are 0.x versions, whose caret range stays within the minor version; `lodash-es` is used for plain helpers only.

## Configuration

### Voice Output Settings

When using ElevenLabs, set the following in `.env`:

| Environment Variable | Description | Default |
|---------------------|-------------|---------|
| `ELEVENLABS_XI_API_KEY` | ElevenLabs API key | - |
| `ELEVENLABS_VOICE_ID` | Voice ID to use | `EXAVITQu4vr4xnSDxMaL` |
| `ELEVENLABS_MODEL_ID` | Model ID (`eleven_flash_v2_5` uses about half the credits and is faster; supports Japanese) | `eleven_multilingual_v2` |
| `ELEVENLABS_OUTPUT_FORMAT` | Output format. In the world Coo plays MP3 (and WAV) only: audio in any other format, a raw `pcm_*` one included, is not played, and the reply is posted as text instead (the audio is still requested and counted against the limit; only the playback is skipped) | `mp3_44100_128` |
| `ELEVENLABS_VOICE_STABILITY` | Voice stability (0-1) | `0.5` |
| `ELEVENLABS_VOICE_SIMILARITY_BOOST` | Similarity boost (0-1) | `0.9` |
| `ELEVENLABS_VOICE_STYLE` | Style (0-1) | `0.66` |
| `ELEVENLABS_VOICE_USE_SPEAKER_BOOST` | Speaker boost (enabled only when set to exactly `true`) | off |
| `ELEVENLABS_STT_MODEL_ID` | Speech-to-text model for voice input | `scribe_v2` |
| `ELEVENLABS_STT_LANGUAGE_CODE` | Speech-to-text language (e.g. `ja`) | auto-detect |
| `OPENAI_API_KEY`, `OPENAI_TTS_MODEL`, `OPENAI_TTS_VOICE` | Optional OpenAI TTS: the fallback when ElevenLabs gave no audio, or the only voice when no ElevenLabs key is set (called directly, as a request of its own under `VOICE_TTS_MAX_CHARS_PER_DAY`). Voice input needs the ElevenLabs key either way | -, `tts-1`, `nova` |

### Model Selection

Coo writes with Claude only. `ANTHROPIC_API_KEY` is required, and `LLM_PROVIDER`, if set, must be `anthropic`; anything else stops startup with a clear error instead of starting an agent that cannot reply.

| Job | Provided by |
|---|---|
| Replies, decisions, JSON extraction, describing what the agent sees | Claude |
| Speech output (TTS) | ElevenLabs (`ELEVENLABS_XI_API_KEY`), with OpenAI TTS as an optional fallback |
| Voice input (speech-to-text) | ElevenLabs (the key needs the `speech_to_text` permission) |
| Embeddings | None. Nothing in this agent searches memories by embedding, so replies work without them |

Claude is called by `src/anthropic-models.ts` with the official SDK, because `@elizaos/plugin-anthropic` sends `temperature` (rejected by current Claude models) and defaults to retired model IDs.

| Variable | Default | Notes |
|---|---|---|
| `ANTHROPIC_SMALL_MODEL` | `claude-haiku-5-5` | "Should I respond?" checks, picking an item to use, the summary of a scene edit |
| `ANTHROPIC_LARGE_MODEL` | `claude-haiku-5-5` | Replies, autonomous actions, looks, navigation, ambient speech and scene-edit planning; `claude-sonnet-5-5` for higher quality at ~20x the cost |
| `ANTHROPIC_EFFORT` | `low` | `low` / `medium` / `high` / `xhigh` / `max`; higher is slower and more expensive. Another value is ignored with a warning (`low`) |

The Anthropic SDK also reads three variables of its own from the environment (and so from `.env`), which redirect or alter every Claude request: `ANTHROPIC_BASE_URL` sends them, with the API key, to another host; `ANTHROPIC_AUTH_TOKEN` sends a bearer token with them; `ANTHROPIC_CUSTOM_HEADERS` adds headers to them. Leave them unset unless you mean that. When `ANTHROPIC_BASE_URL` is set, the agent says where requests go at startup (`[Security] ANTHROPIC_BASE_URL is set: every Claude request, with the API key, goes to … instead of Anthropic's API.`).

### OpenPay Store Shop Clerk

Coo can act as a shop clerk for [OpenPay Store](https://open-pay.jp/ja/store): it knows the configured products, recommends them when they fit the conversation (and now and then on its own), and when a player wants one it posts the product's purchase link to chat. Buyers pay from their own wallet; the shop uses no wallet and no key (the tip wallet below is separate and signs nothing but the world's sign-in message). Links are never read aloud.

| Variable | Default | Notes |
|---|---|---|
| `OPENPAY_STORE_HANDLES` | (off) | Comma-separated seller handles to sell (e.g. `alice,bob`; up to 100 products each), or `*` for products from every seller (up to 100 in total). A leading `@` is dropped; a handle with other characters than letters, digits, `_`, `.`, `-`, or longer than 64, is skipped with a warning |
| `OPENPAY_STORE_LOCALE` | `ja` | Language of the purchase pages (`ja` / `en`; anything else is `ja`, with a warning) |
| `OPENPAY_STORE_API_URL` | `https://open-pay.jp/api/store/listings` | Listings API (purchase links are only accepted on this origin, and only as `https://` links). A value that is not a URL falls back to the default with a warning |

The catalog loads at startup and, once it is more than 5 minutes old, refreshes in the background the next time it is used (with retry backoff after failures); prompts never wait on the API. Prompts show up to 12 products, newest first, and fewer when their lines are long (1,500 characters of product lines in all). A request the API answers with 400 or 404 counts as no products from that seller; any other failure keeps the last list. The reply names the product by id or an unambiguous title, and the `OPENPAY_SHARE_PRODUCT` action posts the purchase URL from the validated catalog record.

What Coo checks of each product the API returns, and drops it otherwise (the log says how many were dropped per request):
- **Seller**: with handles configured, a request is made per handle and only items of that handle are kept, whatever the API answers. With `*`, every seller is kept.
- **Purchase link**: posted to chat exactly as the API sent it, so it must be exactly what it parses to: an `https://` URL on the API's origin, at most 325 characters, without credentials, whitespace, control or invisible characters, already in its normal form (no upper-case host, default port, dot segments or unencoded characters), with the seller's `@handle` (or `%40handle`) as a segment of its path. 325 is what is left of one 500-character chat message next to the longest text before the link (the title is cut to 60 characters in the link message), so the link is always posted whole. That the link leads to *that product* of the seller is not checked.
- **Text**: titles, descriptions, categories and emoji are read only up to eight times their shown length, cut to one short line without `<`, `>`, backticks, control characters, or bidi and zero-width characters (so a title shows as it reads), and NFKC-normalized (full-width letters become plain ones). Then the address forms that `src/openpay-store/addresses.ts` recognises are replaced by `(link removed)` (the whole field, when taking them out completes another one), also one that cutting the text for display would make (`photo.jpg` cut to `photo.jp` is cut back further; this holds for every cut, the shelf's 80-character descriptions included). The recognised forms:
  - schemes: `scheme://…` for any scheme; the web schemes (`http`, `https`, `ws`, `wss`, `ftp`, `file`) followed by `:` with any slashes or backslashes or none (`https:evil.com`); `mailto`, `javascript`, `data`, `tel`, `sms`, `bitcoin`, `ethereum`, `lightning`, `upi`, `magnet`, `geo`, `about`, `blob`, `chrome`, `view-source` and a few more followed by `:` and anything but a space; also right after other text (`送金先https:…`, `pay-https:…`);
  - host names in any script, punycode or percent-encoding, also UTF-8 encoded (`支払.jp`, `%61ttacker%2ecom`, `attacker.%E3%82%B3%E3%83%A0`), with dots written as `.` `．` `․` `‧` `·` `•` `%2e`, as `。` `｡` `・` `･` between Latin labels, or de-fanged (`[.]`, `[dot]`, ` dot ` and the like): when the last label is a country code, a common generic top-level domain or one of a few in other scripts, or any Latin top-level domain followed by a path, port, query or fragment, after `name@` (an e-mail address, removed whole) or after `//`; and `www.…`. A name with further labels after a listed one is removed up to that label (`shop.com.js` loses `shop.com`);
  - IPv4 addresses, bracketed IPv6 addresses (`[::]` included), and wallet addresses (`0x` and exactly 40 hex digits; with another hex digit right after, it is left as text), each wherever it stands, also attached to other text (`送金先0x…`); and, with a path, port, query or fragment after them, the numeric forms a browser also reads as IPv4 that do not occur in ordinary text: a `0x` part (`0xcb007107/pay`), or two or three parts with the last above 255 (`203.0.28935/pay`).
  Not recognised, and left as text: a bare host whose top-level domain is not listed and has nothing after it (`evil.test`, `evil dot test`; it cannot be told from `Node.js` without the list of every domain); an IDN host whose labels are joined by `。` or `・` next to a label in another script (`支払。jp`, `支払。jp/pay`: that is how Japanese sentences end); a top-level domain in another script that is not on the short list (`例え.テスト/pay`); dots with spaces around them (`evil . com`), spaced-out letters, other dot-like symbols (`⋅`, `∙`) and other de-fangs; percent-encoded separators other than `%2e` (`evil%E3%80%82com`), and a scheme whose colon is encoded (`https%3a…`) or that is misspelt or glued to a Latin letter without `//` (`hxxps:`, `xhttps:`; the host after it is still removed when it is recognised); an IPv4 address right after a Latin letter with nothing after it (`pay192.168.0.1`; `v1.2.3.4` is a version); the other numeric IPv4 forms: a single decimal number (`3405803783/pay`: it cannot be told from `1920/1080` or `24/7`), four parts with one of more than three digits or above 255 (`0313.0.0.07/pay`, `256.1.1.1/pay`), and any numeric form with nothing after it; unbracketed IPv6; and other wallet and payment formats (Bitcoin `bc1…`/`1…`/`3…`, Solana and other base58 keys, Tron `T…`, Lightning invoices outside a `lightning:` link, bank accounts, phone numbers without `tel:`, payment-app IDs). Knowingly removed with the recognised forms: names like `Dr.No`, `ASP.NET`, `Tea・Shop`, `Node.js/TypeScript`, `The dot com era`, `About:Me`, four-part version numbers, a decimal number whose digits after the point read as a number above 255, followed by a slash, a port, `?` or `#` (`0.1234/s`, `1.500/kg`, `1.500:1`), a listed scheme name followed by a colon and text (`Tel:03-1234-5678`, `Data:CSV`), and any text followed directly by `.` and a word that is a country code or another listed ending (`おいしいです.It is good`, `Great.It works`, `README.md`), also with ` dot ` in between (`polka dot art`). The same applies to the seller's handle where it is shown; an item whose id reads as an address is dropped. An amount is digits with at most 15 before and 18 after the point.
  So recognised address forms are removed; a seller can still describe an address in a form this does not recognise, in words or in spaced-out characters (`e v i l . c o m`). The link message is the only link the agent's code composes; it is not the only thing a buyer reads, and not the only text the agent posts. Its replies are posted as the model wrote them: the shop prompt tells the model not to write URLs or product ids, but nothing removes one, so a reply can contain a web or wallet address the model wrote (for instance one a visitor asked it to repeat). With `OPENPAY_STORE_HANDLES=*`, every seller on the Store writes text that the agent repeats in the world: if that matters, list only sellers you trust.
- **The link message** (`🛒 title — amount JPYC` and the link, from the share action and from the "on a break" reply alike) is checked as a whole before it is handed on, with the same recogniser: it must hold exactly one address, the product's purchase URL, and fit one chat message. The catalog takes no product whose link message cannot be made (counted with the rejected items in the log), and the shelf and the "on a break" examples offer none; if one is still refused when it is posted, nothing is posted and the log says why: the share action tells the player the link cannot be posted, the "on a break" reply gives its usual notice instead.
- **Naming a product**: a title is only recognised in a reply or a player's message when it is at least 4 characters long ("AI" or a two-character title would match sentences that are not about it). Shorter-titled products are still on the shelf and are shared when the model names their id. The "on a break" notice offers only recognisable titles as examples.

These checks were written against the response shape the code documents, and are tested with a hand-written fixture (`src/openpay-store/fixtures/listings.synthetic.json`), not with a recorded response: no request was made to the Store for it. A recorded real response would additionally prove that real purchase links are already in normal form and carry `@handle` as a path segment (and in which case), that real amounts and ids fit the patterns, and what optional fields look like. If the shelf stays empty with `item(s) were rejected` in the log, that is where to look.

### Tips (投げゼニ)

coo-world lets players tip each other in JPYC from their own wallets. With a wallet of its own, Coo can receive tips too: players whose own wallet is signed in see a Tip button next to Coo in the Players list, and Coo thanks whoever the world announces as having tipped it (without a model call) and remembers the announcement in the conversation.

1. Create Coo's wallet. This writes a new private key into `.env` as `TIP_WALLET_PRIVATE_KEY` (it is never printed) and shows the address. Run again, it only shows the address and changes nothing. It reads `.env` the way dotenv does (which is how elizaOS loads it), so `export TIP_WALLET_PRIVATE_KEY=…`, `TIP_WALLET_PRIVATE_KEY = "…"` and the like count as set; a file that assigns the key more than once is refused until you remove the extra lines. When it writes the key, the file is replaced in one step and ends up readable by its owner only (mode 600).
   ```bash
   npm run tip-wallet
   ```
2. Back the key up, e.g. in a password manager: without it, tokens sent to the address cannot be moved.
3. Restart the agent. About three seconds after each sign-in the log says `[Tips] Receiving tips at 0x…`, or that the world did not turn tips on.

How it works and what it can do:
- The world only offers the Tip button for a player whose wallet signed in on the current connection, so Coo signs in on every connection with its key (Sign-In with Ethereum), then turns "Receive tips" on. The world shares only that yes/no flag; the address goes only to a signed-in player who is sending a tip.
- The key only ever signs the world's own sign-in message. Before signing, Coo checks that it is exactly that: the world's domain (the host of `WS_URL`), its statement, Coo's address, the nonce it was given, no extra content and a short expiry. Anything else is refused and tips stay off for that connection (so `WS_URL` must name the world by the host, port included, that the world itself uses in its message). A sign-in that fails is tried again three times per connection. Nothing in the agent builds or sends a transaction.
- Tips arrive as ERC-20 tokens at Coo's address; Coo never moves them. Move them to your main wallet now and then (for example by importing the key into a wallet app; that needs a little POL for gas) and keep only small amounts at this address. If the key may have leaked, create a new wallet and move what is left.
- The key is kept out of the character secrets elizaOS stores in its database and returns from its API (a copy an earlier version stored there is deleted on the next start). Its name must not start with `COO_`, which elizaOS would copy into those secrets.
- At startup the key is read into memory and removed from the agent's process environment; it stays in `.env`. The elizaOS server re-reads `.env` once while starting, which puts it back for a moment, so the Hyperfy service removes it again when it starts. Code running in that window, or after any later re-read of `.env`, can still see it.
- Coo explains how to tip it when asked, while it is receiving tips, and is told never to ask for tips on its own (its autonomous prompt does not mention tips at all); nothing removes such a sentence if the model writes one.
- Tips work only while Coo is connected. All Coo knows of a tip is the world's announcement of it (coo-world announces a tip once its own check of the chain confirmed it, for which it needs its RPC). Coo thanks for an announcement only once its wallet has been signed in and shown as receiving tips on that connection: a tip announced after "Receive tips" was switched off again on that connection is still thanked, one announced after a reconnect but before the new sign-in is not.
- Coo verifies nothing on chain: a world on which its wallet signed in can announce a tip that did not happen, and Coo thanks for it. What it stores says so: "The world announced that … tipped me …. I did not check it on chain."
- coo-world's public announcement ("Alice tipped Coo 100 JPYC") names the recipient only by display name, and display names are not identities. Coo takes it for its own only while no other player present has its name as the world writes it into announcements (invisible characters become spaces, spaces run together, cut to 32 characters); while someone else does, Coo thanks for no tip notice at all. The "(only you) … tipped you …" notice, which coo-world sends to the recipient alone when it does not announce a tip publicly, is recognised by its text too, and a public announcement can have the same text (a player named "(only you) Mallory" tipping one named "you"); so it counts only while no player present has a name, as the world writes it, that starts with "(only you)" or is "you". What remains: names are not identities and Coo thanks on the world's word; a player who left before the notice was read, or joined after the tip, is not seen; only a recipient id from the world's server, which coo-world does not send, would close this.
- Thanks are limited: the same name at most once in 30 seconds, and over all names three at once, then one every 10 seconds. Announcements beyond that are not thanked and not stored. The tipper's name is used as the world announces it, cut to 32 characters and filtered as a chat sender's name is (see "What the World Can Make the Agent Take In"); an announcement with an amount longer than 30 digits (18 decimals) or a token name longer than 16 characters is not taken for a tip.
- Check the rules that apply to you (taxes, and whether perks in return for tips make you a seller) before relying on tips.

### Agent Aliases

`HYPERFY_AGENT_ALIASES` is a comma-separated list of extra names the agent answers to (e.g. `クー`). A message containing the agent's name or one of these aliases skips the "should I respond?" LLM check (a name in Latin letters must stand as a whole word: "Coo!" yes, "cool" no; other names match anywhere in the message), and addresses "come here" / "stop" to the agent. The check is also skipped when the agent is 1-on-1 with a single player, that is, when exactly one other player is in the world.

### Who Can Ask for What

The agent never does for someone what the world would not let them do themselves, except for the operators you list yourself:

- **Scene edits** (`HYPERFY_EDIT_ENTITY`: move, rotate, scale, duplicate, delete, import objects) are **off by default**. `HYPERFY_SCENE_EDITS=builders` turns them on for players who are present in the world and either have builder rank or higher as the world's server reports it (on coo-world the higher of the player's rank and the world's rank setting), or are listed by player id or userId in `HYPERFY_OPERATOR_IDS` (comma-separated; these are treated as builders whatever their rank in the world). They must ask in chat or by voice; anyone else gets a short refusal. The refusal makes no planning or summary call to Claude; the reply that chose the edit cost the usual chat call (as for any message the agent answers). Autonomous behavior never edits the world. Any other value of `HYPERFY_SCENE_EDITS` is a configuration error (logged) and keeps them off; the log says which applies on every connection.
  **Turn them on only for a world whose server sets each chat message's sender itself.** The owner's coo-world does. Stock Hyperfy does not: it passes on whatever sender id a client puts in its chat message, so there any visitor can pose as a builder or a listed operator who is in the world at the time.
  **Coo's own account needs builder rank in the world**, by the same rule as a requester's (the higher of its rank and the world's rank setting; `HYPERFY_OPERATOR_IDS` gives people rights with Coo, not Coo rights on the server). Without it the edit is refused before it is planned, with "I'm not allowed to build in this world." and one log line, as coo-world's server would drop it; on a world that reports no rank for Coo's player (an upstream Hyperfy server, which sends roles instead) it is refused with "I can't build in this world: it doesn't tell me whether I'm allowed to." Like the requester's, it is checked again before each step, so Coo demoted during an edit stops it.
- **An edit stops** as soon as its authorization no longer holds: when the connection it was asked on ended (a reconnect), when its turn was cancelled (it took longer than 3 minutes, see below), or when the requester's rank (or Coo's own) dropped or the requester left. It is checked again before each planning call to the model (and after the state for it was composed), and right before each thing it does in the world: walking there, each change, the download of an import, each request of an upload, each announcement in chat, and the closing summary, before it is written and again before it is handed over (a requester who lost the right meanwhile gets one neutral line, "I can't go any further with that request.", and nothing about the scene; no summary is written for them). elizaOS holds that closing message and delivers it after the action has finished; it is checked once more at that moment, so a requester demoted in that interval gets the neutral line too. Nothing is sent to a new connection, and nothing is said for a turn that was cancelled. The operations not yet made are reported as not done. An imported app (`.hyp`) or model is checked against what the world's server takes (below) before any file is uploaded, and announced to the world only once all its files are uploaded, its blueprint and the app one right after the other, so an import that fails or is stopped has put nothing in the world that would have to be taken back; the files it had uploaded by then stay on the world's asset server, with nothing referring to them.
- **What Coo says it did is what it did**: a target that is gone (also one removed or replaced while Coo walked over to it), a pinned app that was to be moved, rotated, scaled or deleted (also one pinned while Coo walked over), the world's scene app for any operation, a target Coo did not get to (its walk there was stopped by "stop", replaced by another walk, ran out of time, or had nowhere to go), something that is not an app (players included: the world only moves apps), numbers the world's server would drop (a position beyond ±1,000,000, a rotation that is not close to unit length, a zero scale, anything not finite; for a duplicate, the copied app's own), a duplicate of a unique app whose blueprint names a file the world would refuse in a new blueprint, a duplicate or import whose blueprint or app the world would not take (coo-world's field policies, mirrored in `src/plugin-hyperfy/lib/world-add-policy.ts`: props and image plain objects of plain JSON, at most 16 levels and 8,192 values and keys; the model, script and image an asset or an http(s) URL; the flags true or false; the app's id, transform and blueprint; and the wire limits: over the packet's byte limit, over 8,192 values for a blueprint or 4,096 for an app as the world counts them, nested deeper than 32 levels, or holding a value its scan refuses, such as a date), or a refused or failed import is given to the closing summary as not done (the summary itself is written by the model from those results, at most 30 of them), and is counted as not done in the text Coo falls back to when the summary has none or cannot be written, which is made from the counts alone ("I made 2 of the 3 changes (1 failed)."). After each change that was made, Coo posts the planner's own description of it to chat, in the model's words. "Done" means the change was made locally and sent in a form the world's server accepts (a new blueprint and app as that server stores them: texts cut to its limits, unknown fields left out); the world does not confirm it, and the world-wide budgets it checks next (all blueprints together, the room left in the join snapshot) are not checked by Coo.
  Pinned apps and the scene app are left alone by the rules of the world's own builder (coo-world's build mode moves, rotates, scales and deletes only apps that are neither pinned nor the scene, and duplicates any app but the scene). That is stricter than coo-world's server, which accepts these changes from a builder; Coo has no operation that unpins.
- **What a plan can hold**: the planner's answer is read entry by entry against a fixed shape per operation (`src/plugin-hyperfy/lib/edit-plan.ts`): an entry runs only when it is that operation with its target and its numbers, whatever it says about its own success, and an entry the plan itself marks as not possible is never run. One request runs at most 20 operations; the rest are reported as not run. A plan can name a copy it makes (`"as"`) and move, rotate, scale or delete that copy in a later entry (`"targetRef"`); a reference to a copy that was not made fails, and nothing is done to the original instead; a plan whose labels do not hold together (a reference no earlier entry names, two copies under one label) is not run at all. One request makes up to three planning calls to Claude and one for the summary.
- **Whose request it is, not whose words**: the check is on the sender of the turn. What gets edited on that turn is planned by the model from the request together with the recent chat of everyone and the names of things in the world, so a visitor's earlier words can end up in a plan made when a builder speaks.
- **Autonomous steps** may only run walking, using/releasing items, teleporting to a player, ambient speech, replying and ignoring. Any other action the model names on such a step (including by a partial name or a synonym) is refused when it would run. The list covers this project's actions (the Hyperfy plugin's and the shop's share action); an action from a plugin you add yourself is not covered by it.
- **Conversation** is only what the world's server sent: chat that app scripts in the world post (whatever sender they give it) is shown locally but is never answered, never counts as a tip announcement, and is never sent on to the world.
- Everything else (walking to someone, using items, looking around, replying) stays open to everyone.

Caveats:
- On a coo-world without `ADMIN_CODE`, everyone is an admin, so everyone can ask for scene edits (and Coo may make them).
- Stock Hyperfy worlds pass on whatever sender id a client puts in its chat message (and newer ones also send ranks, so ranks do not tell such a world apart). On them, keep `HYPERFY_SCENE_EDITS=off`: with it on, anyone who sends chat under a builder's or a listed operator's id can ask for edits. coo-world sets the sender id on its server.
- A tip announcement is also a sender-less chat message; it counts only when the world's server sent it live on this connection (not from the chat history, not from an app script), once Coo's tip wallet has been signed in and receiving tips on that connection, and Coo checks nothing on chain (see Tips).
- These checks rely on the world's app scripts not reaching the engine's internals (for example the network handlers that record ranks and chat). By default scripts are not run at all; with `HYPERFY_WORLD_SCRIPTS=sandboxed` they run behind a membrane that keeps those internals out of reach (next section).

### World App Scripts

A Hyperfy world sends *app scripts*: JavaScript written by whoever builds in the world (or runs it), which every client executes. The engine bundled here evaluates them in an SES `Compartment`, but in this agent that was never a boundary: without `lockdown()` one line reaches `process`, and even with it the engine's script API hands out the raw world object (and with it the session token, the socket, and the handlers that chat, ranks and the tip wallet are fed from).

`HYPERFY_WORLD_SCRIPTS` decides what happens to them. There is no mode that runs scripts without the sandbox; any other value is logged as an error and means `off`.

| Value | What the agent does |
|-------|---------------------|
| `off` (default) | Scripts are downloaded with their app and never evaluated. Apps still show their models. What stops working in the agent: interactive items (`HYPERFY_USE_ITEM` finds nothing to use), script-driven sky/environment changes, and anything a script would animate or move. |
| `sandboxed` | At startup the whole process is locked down with SES (`lockdown()`), and a self-test runs the known escapes against the real script runtime; if lockdown fails or one probe gets through, the agent logs why and exits. Each script then runs in its own compartment behind a membrane (`src/plugin-hyperfy/lib/script-membrane.ts`): what the engine returns reaches a script only through a proxy or a wrapper, as an opaque token, or as a copy, and what a script passes reaches the engine only as a copy (its functions as wrappers, its promises followed by promises of the agent's own, which call the script's `then` with nothing but their own two resolving functions, its bytes copied into buffers of the agent's own). Listeners of the process's error events get copies the agent makes instead of a script's values (see the side effects below, also for what that does not cover). The self-test also tries the escapes found in review: a promise's or a buffer's species constructor, a host promise, a forged node reference, a function as `this`, a callback on `this`, a host error's stack, and an unhandled rejection reaching a process listener. |

What a sandboxed script gets: the engine's `world` and `app` API, `props`, `setTimeout`, `console`, `Vector3`/`Quaternion`/`Euler`/`Matrix4`/`LerpVector3`/`LerpQuaternion`/`Curve` and the helper functions. Differences from a Hyperfy client that script authors will notice:

- `fetch()` reaches public `https://` hosts on the default port only, with `GET`, `HEAD` or `POST`, a few request headers (`Accept`, `Accept-Language`, `Authorization`, `Content-Type`, `If-Modified-Since`, `If-None-Match` and `X-…` other than `X-Forwarded-…`, `X-Real-IP`, `X-Client-IP`; any other header is left out without an error), at most 256 KB sent and 1 MB received, 10 seconds and four requests at a time (for all scripts of a connection together). Redirects are followed, at most five, each under the same rules. The world's own origin gets no exception here: a script reaches it only when it is itself a public `https://` host on the default port. A request these local limits refuse (method, body, size, too many at once) throws a `TypeError` that names the limit. One the network policy refuses, or that fails on the way, throws `fetch failed`, whatever the reason (the reason is in the agent's log, except for a request stopped because its app went away): addresses inside the agent's network, plain `http://`, other ports, a response over 1 MB, the deadline. (A Hyperfy client's `fetch()` resolves to nothing when it fails; here it rejects.) No cookie, token or key of the agent's is attached to a request; it carries a fixed `User-Agent` naming a Hyperfy agent and comes from the agent's address. Models and avatars a script loads with `world.load()`, emotes it plays on an avatar or in a player effect, and the images and HDR environment of a sky node it adds are downloaded by the agent under the same policy (see "What the Agent Downloads"); image, video and audio nodes load nothing.
- `Object3D` and `URL.createObjectURL` are not available; `world.get`/`world.set`/`world.open` do nothing.
- Objects a script hands to the engine are copied (later changes to the script's own object are not seen by the engine), and the engine's objects are seen through proxies. On a vector, quaternion, euler, matrix, lerp or curve, adding properties, replacing methods and reading fields that start with `_` do not work; `class X extends Vector3` does not behave like a subclass.
- A property named `_isRef` or `_ref` cannot be handed to the engine or set on its objects (the engine reads those names as node references). The members that take a node (`add`, `remove`, `insert`, a joint's `body0`/`body1`, `world.add`/`remove`/`attach`) take only a node the engine made (`body0`/`body1` also nothing). `geometry`, also in the data of `app.create()`, takes only the `geometry` of one of the engine's nodes, which may stand for none, or nothing: an object shaped like one, from the script or from the world's own data, is refused. `app.create()` takes no `material`. On an object that claims to be a node reference but is not a node the sandbox recognises, these members are refused.
- A callback handed to the engine (a player effect's `onEnd`, a node's `on…` property such as `onLoad` or `onPointerDown`, also in the data of `app.create()`) must be a function or nothing.
- Event names (`app.on`/`off`/`emit`/`send`/`sendTo`, `world.on`/`off`/`emit`) must be strings. A `destroy` listener or a player effect's `onEnd` that throws is logged; it does not stop the app's teardown.
- A world API function cannot be called with a function as its `this` (`api.call(someFunction, ...)` throws).
- An error from the engine reaches a script with its name and message only, without a stack; file paths in the message read `<path>`.
- `app.control()` returns a control of the script's own. The agent does not feed it input, except that it presses `keyX` there when it releases an item (`HYPERFY_UNUSE_ITEM`).
- `world.chat()` only shows in the agent's local chat view; it is never sent to the world and never answered.
- SES refuses sources that contain `import(`, `eval(`, `<!--` or `-->` (so also `while (i --> 0)`), even in comments and strings.
- `console` output goes to the agent's log, prefixed `[script]`, one string per call, cut to 2,000 characters (a line break in a script's own string stays in it). `setTimeout` returns a number. A value handed to the engine may hold at most 100,000 objects, nested 64 deep. Apps with the same script asset share one compartment.

What the sandbox does not do:

> A sandboxed world script still runs inside the agent's process, on its only thread. There is no CPU or memory isolation: `while (true) {}` hangs the agent for good, and a script can allocate until the process dies. A script can use everything the engine's script API offers it: create and move nodes, read every player's position, name, id, account id (userId) and admin flag, teleport, push, freeze and re-skin the agent's own avatar, ask the world's server to do the same to other players (coo-world drops such requests), send app events to the world's server, post to the agent's local chat view, make the agent download models, avatars, emotes, sky images and HDR environments from the world's own origin or from any public https URL it names (of a model or avatar it loads it learns only whether that worked and the names, transforms and material settings of its parts), and with `fetch()` send whatever it can read to any public https host and read the answer. A script can break the engine code it calls into by passing it nonsense, which can stop that app, the world's update loop, or the whole process. A script's own error stack traces name the agent's files and where they are on disk. The sandbox is defence for worlds whose builders you mostly trust. It is not a guarantee against a hostile world: use `off` there.

Side effects of `sandboxed` on the rest of the process: the JavaScript built-ins are frozen for everything, including elizaOS and its plugins (SES logs the few Bun-only built-ins it removes at startup), and, from the moment the Hyperfy service has started, unhandled promise rejections are logged and survived instead of ending the process, because one line of script can cause one (uncaught exceptions are not survived). Every listener of the process's error events (`unhandledRejection`, `rejectionHandled`, `uncaughtException`, `uncaughtExceptionMonitor`, `multipleResolves`), elizaOS's and other plugins' included, and a callback set with `process.setUncaughtExceptionCaptureCallback()`, gets an Error made from the original value's name, message, stack and code instead of that value (a `multipleResolves` value that is not an object is passed as it is), and a promise of the agent's own instead of the script's. That holds for the agent's own errors too: they arrive as a plain `Error` without `cause`, extra fields or their class, and an `unhandledRejection` cannot be matched to its later `rejectionHandled` by its promise. The reason: a script's rejection reason would otherwise reach code that prints it, and with it the runtime's own `inspect` (`src/plugin-hyperfy/lib/error-events.ts`). With `sandboxed` this guard is installed as soon as the agent's `src/index.ts` runs, before elizaOS's server starts. Under Node it sits in `process.emit`, through which Node delivers these events, so it covers every listener however it was registered. Under Bun, which calls the listeners itself, it wraps each one: those already there, and every one registered later through the process's methods; a once listener registered before the guard becomes an ordinary one, because Bun does not tell them apart; and it keeps a listener of its own on `rejectionHandled`, `uncaughtExceptionMonitor` and `multipleResolves`, so the check below also runs for events nothing else listens to. When one of these events comes and something the guard does not cover is there to get it (under Bun a listener registered through a reference to `process.on` or a sibling method taken before the guard was installed; under both an uncaught-exception capture callback the guard did not set), the agent logs that and exits before handing the event on; the self-test fails if one is there when it runs. Not covered: under Bun, such a listener that is called before any listener the guard wrapped has run since it was registered (one that was prepended, for instance) gets that event's values once, before the agent exits; under Bun, such a listener on an event whose listeners were all removed with `removeAllListeners()`, the guard's own included, is not checked any more; under Node, a function that replaces `process.emit` after the guard was installed sees the values first; a capture callback set in place of one set through the guard, through a reference to the setter taken before the guard was installed; and code that calls the listeners itself. After upgrading Bun, elizaOS or a plugin, run the tests (`bun run test`) and the boot smoke (see "Build and Run" above; it runs both modes) before relying on it: lockdown is sensitive to new built-ins, and the self-test only proves that the escapes it knows are closed.

### What the Agent Downloads

A world tells its clients what to download: models, avatars, emotes, scripts, the sky. A builder can ask Coo to import a file from a URL, a sandboxed script can call `fetch()`, and another plugin can hand Coo an audio URL to transcribe. All of these go through one policy (`src/plugin-hyperfy/lib/net-policy.ts`):

- **Public `https://` hosts on the default port.** A host name is judged by the addresses it resolves to, at the moment the connection is made, and the connection goes to the address that was checked. Loopback, private, link-local, carrier-grade NAT, multicast and cloud-metadata addresses are refused, in every spelling (`https://2130706433/`, IPv4-mapped IPv6, NAT64, 6to4 ...), and so is a name with even one such address among several. No user name or password in the URL.
- **The world's own origin**, whatever its address, port and scheme: the origin of `WS_URL` (`wss://` becomes `https://`, `ws://` becomes `http://`). That is what keeps a local or LAN world working. It is that origin only, with one allowance for a world on loopback: when `WS_URL`'s host is `localhost`, `127.x.x.x` or `[::1]`, the same scheme and port on any of those spellings count as the world too (`ws://127.0.0.1:3000/ws` covers `http://localhost:3000`, and the other way round). Nothing wider: another port, another scheme, or another name for the same machine (a LAN name, `me.localhost`, `[::ffff:127.0.0.1]`) is another origin. A world that names its assets under another origin gets them loaded only if that origin is a public `https://` host (a bucket or CDN is fine); otherwise the agent logs which URL it will not use and why when it joins (for an `https://` name that only turns out to resolve to a non-public address, the refusal appears with each failed download instead), and the fix is to write `WS_URL` with the host name the world itself uses.
- Redirects are followed by hand, at most five, and each one is judged from scratch: a redirect off the world's origin loses the exception.
- One deadline per download (60 seconds for a model, avatar or import, 30 for an emote, image, HDR or audio, 15 for a script), and a size cap enforced while the bytes arrive: 50 MB for models and avatars (also for imports, where the world's own upload limit lowers it and can never raise it), 16 MB for emotes, 2 MB for scripts, 32 MB for images, HDR environments and audio (MB here and below is 1024 × 1024 bytes). An answer that is compressed although the agent asked for none (`Content-Encoding`) is refused. Per connection the loader runs at most 8 loads at once and lets 1,024 wait (more are refused); the engine's requests for images, video and audio are not downloaded at all.
- **Uploads** (the avatar, emotes, imported models) carry the agent's session token, so they go to the world's own origin only. The one function that attaches the token checks each request's own URL against that origin (and refuses a user name or password in it) before anything is sent, and an upload reads the world's API URL once: its check and its POST go to the URL that was checked, whatever the world announces meanwhile. A world whose API URL is on any other origin gets no upload: the agent logs that once when it joins, never sends the token there, and keeps the world's default avatar unless the world already serves the avatar file. A redirect from the upload API is not followed.
- **What bounds the render page** (`src/plugin-hyperfy/lib/render-watchdog.ts`). Each Chromium the agent launches runs in its own process group. For as long as it exists, the resident memory of everything it owns (its process tree, its process group, and every process seen in either, for as long as that process stays in the group it had) is sampled again 2 seconds after the previous sample finished, and 250 ms after it while the agent has the page working on something (loading a model, avatar, image or HDR, taking a snapshot), so the time `ps` itself takes (at most 5 seconds) adds to the gap. When that goes over 3 GiB, or a page call takes longer than 60 seconds (building the page, 30), that browser is torn down at once: every call in flight fails, any later call to it fails too (without being blamed for the kill), and its processes are killed by group and by pid; the next use launches a new one. For this machine's bundled assets the tree measured 0.85 to 0.86 GiB idle and at most 1.63 GiB, and the slowest call took under 0.5 s. A model, image or HDR whose page call was the only one in flight when Chromium was killed is not handed to the page again on that connection (said once in the log; at most 256 such URLs are kept per connection, and a reconnect starts with none), and from the first kill on that connection's page loads run one at a time, so that the next kill has one load to blame (a snapshot or a page build in flight at the same moment still means nobody is blamed). Whatever the URLs and whichever world caused them, 3 kills within 10 minutes open a circuit breaker for the whole process: for the next 10 minutes every page call fails at once (`RenderPageUnavailable`), also one that was waiting for a browser launch or a page build when it opened (checked again once that completes, before any page work), logged when it opens and when it closes. When `ps` cannot be read, only the deadlines apply: that is logged once, sampling retries with a growing pause (at most 30 seconds), and the agent logs once when it can read it again. The page itself keeps at most 1,024 textures and 32 avatars, dropping the least recently used. The browser launch is bounded by puppeteer's own launch timeout, not by this. What this cannot do: memory can go over the limit by what the page allocates between two samples; a kill drops everything the page held (textures, avatars, the environment) until the next connection brings it again; resident size is counted per process (shared pages in each); a process that leaves Chromium's group and tree before it is ever sampled is not seen.
- **What is refused before a model reaches the page, or an emote the agent's own parser** (`src/plugin-hyperfy/lib/gltf-budget.ts`), a filter for the amplifiers that are cheap to put in a file, not the limit above. The container is read the way the page's loader reads it (version 2, a declared length equal to the file's, chunks within bounds and multiples of 4 bytes, one JSON chunk first, at most one BIN chunk, nothing else); the JSON may nest at most 64 deep and be at most 16 MiB in UTF-8 without its `data:` URIs (both checked before it is parsed); it must declare `asset.version` 2.x, name only things that exist (the textures its materials name, and the images and samplers of those textures, included), keep buffer views inside their buffers and accessors, sparse parts included, inside their views, and have a node tree that is a tree. Refused on purpose, though valid glTF: Draco, triangle strips and fans, legacy `animation.parameters`, animation data in interleaved views, primitives that the loader would give one geometry but that declare different morph targets (compared by content), and a required extension the page cannot decode (meshopt, BasisU, anything it does not know). Checked against the 23 models bundled with the agent (an avatar exported by UniGLTF with 32 sparse accessors among them) and 25 assets of the owner's worlds (Blender 4.4 exports that require `EXT_texture_webp`, a Blender VRM export), which all pass; how often other exporters write what is refused is not known. The simple allocations are charged (copies of the BIN chunk and of every buffer view, every accessor, decoded `data:` buffers, embedded images per sampler, animation data converted to floats, morph targets and skin matrices as the export writes them): one at most the download cap (50 MB; 16 MB for an emote), all at most eight times the cap; the export they add up to must fit four times the cap (the next item lowers what the page may actually hand back). Counts are capped too (every top-level collection, cameras and lights included; the mesh instances the scenes expand to; the animation tracks generated; extras and extension data times the copies made of them). Not covered by the filter, and left to the watchdog: image decoding (a small image can declare huge dimensions), what the VRM plugin builds from its own extensions, and the re-encoding of textures that stay on an exported avatar.
- **What bounds the agent's own memory for assets** (`src/plugin-hyperfy/lib/asset-memory.ts`). Before the loader or the sky downloads a world asset, it reserves memory in this process from two pools of 1 GiB in all. Downloads, 256 MiB: twice the kind's size cap (the chunks and the one copy they are joined into), cut to twice the `Content-Length` when the answer declares less, and to twice the actual size once the bytes are in. Then the rest of the way, 768 MiB, exchanged for the download once: what is sent to the page costs 6 times its bytes (the bytes and three copies of their base64: the string, the message, the frame), what comes back 7 times (three copies of its base64, the decoded copy, the engine's copies of its BIN chunk and buffer views), a script 3 times. For a model or avatar what comes back is not estimated: the agent reserves for the most the page may return for this load and tells the page that number, which it refuses to go over. An emote does not go to the page: it is parsed in the agent, and reserves its download plus what the filter charged for it. That ceiling is twice the filter's export estimate or the download times 2 (8 for an avatar, which keeps its textures in the export), at least 1 MiB, at most the kind's export budget, and lowered until 6 × download + 7 × ceiling fits the pool: a 50 MB model may get back at most about 67 MB, and a model whose estimated export does not fit is refused. After the exchange a reservation only shrinks; it is given back when the load ends, whether it worked or not. Small files still load side by side (the bundled avatar reserves about 150 MiB, the base environment about 28 MiB), larger ones wait their turn, first come first served, and a load waiting for memory stops when its world goes away. So the copies listed here stay within 1 GiB. Not counted: the three.js objects and scene graph the engine builds from a parsed model; the cache of finished loads, which has its own bound (512 MiB and 256 entries, each model counted at the larger of its download and the copy the page handed back); and what does not go through the loader or the sky at all: a file a builder asks Coo to import (up to the 50 MB cap, with its upload copies), audio handed over by URL (32 MB), a script's `fetch()` answers (1 MB each) and the shop's listings (4 MB).
- Sky images and HDR environments are fetched one sky at a time: a newer sky stops the download of the one before it. Once a world is gone, nothing more is downloaded or handed to the render page for it. A page call already running then (decoding a texture, an avatar or an HDR) cannot be interrupted: the page keeps what the call kept on record until the agent settles it. The agent first does its own work on the result (for a model: parsing and converting it), then makes one last check: when the call or that work failed, or the world went away by then, all of it is taken back; otherwise the record is dropped and the result is the agent's (a sky texture that a newer sky replaced during that last step is then released). A settlement that fails fails the load, and the page holds no record of a call beyond its settlement. A model whose materials carry a `materialId` the page cannot use as one fails to load, and what the load had kept in the page goes with it.
- Log lines and error messages write the URL of a download, an import or an upload as scheme, host and path only: no user name or password, no query values (their names stay; a query part without `=` counts as a name and is written), no fragment, at most 200 characters in all, a note of the full length included (`src/plugin-hyperfy/lib/log-url.ts`). The lines logged on joining about the world's own API and assets URLs name their origin instead, uncut (and an assets URL that is not a URL at all as it came).
- The listings request of the OpenPay Store shop goes through the same policy, so `OPENPAY_STORE_API_URL` must be a public `https://` URL.

What this does not do:

- It trusts the world's own origin completely. Anything that can name a URL (the world, a script, an import request) can make the agent `GET` any path on that origin, without credentials. Do not point `WS_URL` at a host that also serves something private.
- The agent can be made to fetch from any public `https://` host, which shows that host the agent's address. Nothing here limits how often.
- These requests do not go through `HTTP_PROXY`/`HTTPS_PROXY`. Where the only way out is a proxy, they fail (and the uploads with them), while Claude and ElevenLabs, which use the runtime's own `fetch`, keep working.
- The voice connection is covered only up to the URL. The world names a LiveKit server; the agent hands it to LiveKit's native client only when it is `ws://` or `wss://` with no user name or password, and either on the world's own host (any scheme and port; loopback spellings count as one host) or `wss://` on the default port of a host whose every address is public, judged as above. Otherwise voice stays off and the agent logs one line saying why. What is not covered: the native client resolves the host name again itself when it connects, so a name whose answer changes between the check and the connection is connected to at its new address, whatever that is; and the media connections the native client then makes (ICE, TURN, the addresses the LiveKit server hands it) are not checked at all.
- Requests the agent makes to fixed services (Claude, ElevenLabs, OpenAI speech) are not world-supplied URLs and are not part of this.

The headless Chromium the agent uses for its snapshots has no way to make a request or resolve a name (WebRTC/UDP is not blocked by these settings; nothing in the page uses it). Its page is bundled at build time (three.js 0.132.2 and three-vrm 3.3.3, the versions it was written against; nothing is fetched from a CDN any more), the agent downloads every asset itself under the policy above and passes the bytes in, every request the page makes is refused, and the browser is started with a proxy address where nothing listens and no name resolution, so that the browser's own background requests go nowhere either. A model that refers to files outside itself (a `.gltf` with separate buffers or images) is not given them: it fails to load, or is drawn without them. Chromium and ffmpeg are started with a reduced environment: no API keys, no tokens, no database URL.

`HYPERFY_DEBUG_SNAPSHOTS=true` makes the agent write each snapshot it takes to its working directory (`scene_equirectangular.jpeg`, `scene_facing_<direction>.jpeg`, `scene_view_to_target.jpeg`). Without it, nothing is written.

### What the World Can Make the Agent Take In

Chat, voice and packets come from the world and from whoever is in it. Each is bounded before it is kept or costs anything (`src/plugin-hyperfy/lib/chat-intake.ts`, `managers/voice-manager.ts`, `lib/world-protocol.ts`):

- **Chat messages** are read into a fixed shape before they enter the local chat history: an id and sender id of at most 64 characters, a body cut to one line of 500 characters (line breaks and control characters become spaces; format characters such as bidi controls and isolates, zero-width spaces, word joiners, the BOM, soft hyphens and tag characters are removed, and so are variation selectors that select nothing; kept where they do their job: a zero-width joiner inside an emoji sequence, a zero-width joiner or non-joiner between two letters of a script that shapes with them (Arabic and Persian, Syriac, N'Ko, Mongolian, the Indic scripts, Sinhala, Khmer, Myanmar), the tags of a subdivision flag such as England's, and a variation selector right after a character that takes one: emoji presentation after an emoji, an ideographic variation selector after a kanji), a sender name cut to 32 characters and filtered as the body is (control and line-separator characters become spaces; format characters and variation selectors go except where they do their job), with runs of whitespace made one space; the few invisible characters that count as letters or marks, such as Hangul fillers, stay. A message whose id or sender id holds whitespace, control or format characters is dropped; a body is read in its first 1,000 UTF-16 units only. Anything else the world sends as chat is dropped. The history the world sends on connecting is cut to its last 50 messages and never answered.
- **Turns** are taken one at a time in the order the messages arrived, chat messages and what was heard in voice (once transcribed) in one queue; the sender's clock (`createdAt`) decides nothing. A message id is handled once (the last 1,024 ids are remembered, the history the world sends on connecting included: a history message sent again live is not answered). One sender gets 8 messages at once and then one every 4 seconds; sender-less notices share 10 at once and then one a second. Up to 256 senders are tracked; one that is not tracked while the table is full starts with one message, not 8. At most 8 messages of one sender (10 notices) wait: one more drops that sender's own oldest, so one sender cannot push out anyone else's. At most 20 wait in all: beyond that the oldest message of whoever has the most waiting is dropped, and when everyone waiting has one, the newest is turned away. One that waited longer than 2 minutes is dropped instead of answered late. Each kind of drop is logged at most once per 10 seconds, with the count since the last line (a count not yet said comes with the next line). A turn that takes longer than 3 minutes is cancelled and the next message is taken: the walk it was on stops, and from then on it does nothing more in the world (no further action of its plan, no scene edit, no chat post, no speech, no further Claude call or speech request; an utterance it is playing is cut off there and the rest is not posted; a request to Claude that is still running is aborted, and stays counted against the limits as it may have been billed; a request already sent for speech is not taken back, its answer is not used). The same goes for every turn of a connection that has ended. A walk a turn started and left running when it completed (following someone, wandering) goes on until it gets there, another walk or a teleport replaces it, "stop", its own time limit (2 minutes for a walk to a place or a player; wandering ends after 30 seconds), or the end of the connection. Coo says how a walk it was asked for ended: "Arrived at …" only when it got there, otherwise that it stopped, headed somewhere else, could not get there in time, or cannot find where to go; an item is used only after the walk to it arrived.
  On a world that lets clients choose their own sender id (stock Hyperfy), someone who changes ids for every message gets a full burst per new id until the sender table (256) is full and one message per new id after that; a full queue then first drops the oldest messages of senders who have several waiting, and turns the newcomer's message away only once everyone waiting has one.
- **One thing at a time moves the avatar**: walking somewhere, one scene edit (which walks to its target first), and a look (which turns or walks before the picture is taken) each wait for the one before them to end, so an edit is not walked away from and a picture is taken from where Coo was put. A request can therefore wait for a walk an autonomous step is finishing. "Stop" does not wait, neither for that nor for its turn: a "stop" addressed to Coo (by name, or from the only other player present) that the queue admits (not one over its sender's rate limit, a repeated id, or turned away by a full queue), typed or said, ends the walk, follow or wander in progress when it arrives (after one read of the room's mute state when Coo is not named; a muted room ignores it); its turn later only acknowledges it and stops nothing asked for since. Scripted idle steps start no walk meanwhile.
- **Voice input** is buffered per speaker, so people talking at the same time are each transcribed. An utterance ends after 1.5 seconds of silence, or after 30 seconds without a pause; one with less than 100 ms of speech above the loudness threshold (a click, a breath) is dropped without a speech-to-text request; at most 8 people (whether their speech waits or is being transcribed) and 4 full utterances (about 11.5 MB) are held at once, one transcription request per speaker and 3 in all at a time (an utterance waits for a free one); beyond that frames are dropped (logged at most once per 10 seconds). While no speech-to-text is configured, its daily limit is used up, or Coo itself is speaking, audio is dropped as it arrives. A voice is transcribed only while its speaker is a player in the world: when someone leaves, what they said and was not yet sent to speech-to-text is dropped, and a transcript that comes back for someone no longer in the world starts no turn (it was paid for). A transcript is cut like a chat message and waits its turn in the same queue, as a message of its speaker and by the same rules (above): people who speak at the same time are answered one after the other, and a transcript that is dropped there (the speaker's rate limit, a full queue, more than 2 minutes of waiting) was paid for as well.
- **Packets**: a frame larger than 8 MB is dropped before it is decoded (the WebSocket has already received it by then). What a frame decodes into is bounded as well (`src/plugin-hyperfy/lib/packet-decode.ts`): at most 500,000 values (every number, string, list, object and property value, every element of a typed array, every 64-bit word of a big integer, every element of the list an AggregateError makes of its message) and at most 32 MiB of strings and binary data (every string, bin and typed array, and a record's property names once for every record), nested at most 64 levels deep; something the frame refers to more than once is counted in full each time, and counts its own nesting where it is put again. It reads everything the world's server can write for a value an app keeps in its state (msgpackr with `structuredClone`): records, Map, Set, Date, Error, RegExp, typed arrays, ArrayBuffer, DataView, `undefined`, big integers and references, each only in the framing msgpackr's packer gives it. For every frame the servers' packers produce, the decoded value is the one msgpackr 1.12.1 returns with its native acceleration (as the agent read the world before this decoder existed), except an Error named after a member of `Object.prototype` (such as `valueOf`): msgpackr returns what that member returns, the decoder an Error of that name. Against coo-world's own msgpackr 1.11.2 there are two differences, both as they were before this decoder existed: Error subclasses and names (1.11.2 rebuilds only Error, TypeError and ReferenceError and names every other one Error; the agent keeps RangeError, an `AppError` name and so on), and lone surrogates in strings (1.11.2's JavaScript reader keeps one; natively both versions, and the decoder, read each of its three bytes as U+FFFD). A frame over any limit is dropped like one that is too large, before the rest of it is built; so is a frame holding what neither server writes (other extension types or framings, two-byte record ids, bundled strings, a reference id defined twice), a typed array of a kind msgpackr has no code for (such as Float16Array: msgpackr itself cannot read it back either), an Error whose name or message is not a string (msgpackr would turn it into a string, which can be far larger than the frame), or a value that contains itself (an app can keep one; that packet is not read). A snapshot of 14,000 entities (with 300 blueprints and 50 chat messages) decodes into 399,215 values and 2.0 MiB of strings, so the value limit holds a world of about 17,500 such entities. A chat packet is cut to the chat message shape (above) before it waits for the engine. What waits for the engine's next tick is bounded too: when more than 4,096 packets or 32 MiB (a packet counted as its frame's size or 32 bytes per decoded value, whichever is more; a chat message as at most 4 KiB) wait, the agent closes the connection instead of dropping packets, since a dropped packet would leave its copy of the world silently different from the server's (a rank change not applied, an entity missing); the reconnect joins again with a fresh snapshot (logged once). A frame dropped after the snapshot leaves the connection open; only that backlog closes it. The agent is in the world only once the world's snapshot has been read and its player has spawned: until then it counts as not connected (actions and providers outside a turn see no world, and chat is not answered). A frame that cannot be read before that (the world's server sends the snapshot first: it was the snapshot), or no snapshot within 60 seconds, ends the connection with one error line saying why, for example `[Hyperfy] Cannot join this world: its snapshot could not be read (a frame of <size> bytes is refused: cycle)` or `… (a frame of <size> bytes is not decoded: it holds more than 500000 values)`, and the agent connects again with the usual backoff, up to 5 minutes between attempts: a world whose snapshot holds a value that contains itself or is over one of these limits is tried again at that interval, with the line each time, and the agent never joins it as it is. (coo-world puts the agent's player in the world before it sends the snapshot, so other players see its avatar for that short time.) An ArrayBuffer or DataView counts one value per byte, so app state holding a binary blob of more than 500,000 bytes makes its packets unreadable. Unreadable packets are logged at most once per 10 seconds, with the count and, for the latest, its size and the rule that refused it in fixed words (`cut short`, `trailing bytes`, `reserved byte`, `extension`, `record definition`, `reference`, `cycle`, `Error`, `RegExp`, `Set`, `typed array`, `big integer`; never anything of its content), and unknown packet types for the first 32 different ones only (both for the whole process, not per connection).
- **Names in prompts**: entity names, action labels and ids from the world, and stored chat lines, enter prompts as one bounded line each (32 characters for players, 64 for other names, 1,000 for a stored chat line and for the agent's last reply), without control or line-separator characters and with only the format characters and variation selectors that do their job, as in chat bodies (a name also has its runs of whitespace made one space); a stored reply's action names as at most 8 names of 48 characters. Replies that name something from the world ("Arrived at …", "Could not locate entity …") name it as one line of at most 64 characters. Text that is not part of a prompt's template (the model's own thought, a plan's descriptions, such names) is passed as a value, so braces in it are not template syntax. The number of entity lines is not bounded: 40 in detail per type, every player, and every other entity by name and id.
- **The session token** (the agent's saved identity in the world) is put on the socket URL only for `wss://` / `https://`, or for a host written as `localhost`, a loopback address or a private address (`10.x`, `172.16-31.x`, `192.168.x`, `fc00::/7`). This is decided from the URL alone, whether or not a token is saved. For any other `ws://` / `http://` world the agent logs why (once per connection) and connects **without** a token, as a new guest: no saved identity or rank. Uploads are then sent without a token, which coo-world refuses, so the world's default avatar stays unless the world already serves the file. The guest token the world issues there is neither stored nor sent with uploads, so the agent is a new guest on every connection to such a world, and a saved token is kept as it was. A LAN world addressed by name (`ws://my-box:3000/ws`) is such a case: use its IP address, or `wss://`.

### World Compatibility

The agent's Hyperfy engine (the `src/plugin-hyperfy/hyperfy` submodule) is older than coo-world, so `src/plugin-hyperfy/lib/world-protocol.ts` makes it speak coo-world's network protocol (protocol version, packet table, plain msgpack encoding), and `src/plugin-hyperfy/lib/asset-upload.ts` uploads assets with the session token the world requires.

### Cost Controls and Usage Limits

What costs money is Claude (every reply, decision and look), text-to-speech (ElevenLabs, or OpenAI when it is the fallback; per character) and ElevenLabs speech-to-text (per audio second). Each is limited separately in `.env`, so running out of one leaves the others working.

**Autonomous behavior** (only while other players are in the world):

| Variable | Default | Notes |
|---|---|---|
| `AUTONOMY_TICK_MIN_SEC`, `AUTONOMY_TICK_MAX_SEC` | `15`, `30` | Time between autonomous steps. Most steps are scripted (patrol/wander, wave at newcomers, look around) and cost nothing. A value that is not a number above 0 is logged and replaced by the default (it does not stop the start); a maximum below the minimum becomes the minimum |
| `AUTONOMY_AI_MIN_INTERVAL_SEC` | `120` | Least time between steps where Claude decides what to do (talk to someone, mention a product). Also counted from the end of the last chat or voice message the agent handled, whether it answered or not; `0` = no minimum |
| `AUTONOMY_AI_MAX_PER_HOUR` | `20` | Claude-decided steps per hour, counted when a step starts (one that fails or that the Claude limit refuses still counts); `0` = scripted behavior only |
| `PATROL_POINTS` | (wander) | Patrol route as `x,z; x,z; ...` world coordinates. A malformed entry is skipped with a warning. Without it the agent wanders within 6 m of where it stood at its first scripted step after connecting (normally the spawn point) |

For 90 seconds after the last chat or voice message it handled (answered or not), the agent stays where it is instead of walking off. Without other players the loop only re-checks every 60-120 seconds.

**Usage limits** (empty = no limit, `0` = that use is off; rolling windows over the last hour / 24 hours):

| Variable | Limits | When reached |
|---|---|---|
| `AI_MAX_CALLS_PER_HOUR` | Claude calls (everything) | No Claude calls. Patrol, waves, "come here" / "stop" carry on. A player who names a product gets its purchase link; other players who address the agent get a short "on a break" notice (once per 5 minutes each when the limit is already reached as the message arrives; a request that runs out of budget partway is answered with the notice every time) |
| `AI_MAX_TOKENS_PER_DAY` | Claude tokens (input + output + cache) | Same as above; near this limit calls are refused before it is fully used (see below), and each refused request is answered with the notice |
| `VISION_MAX_PER_HOUR` | Looks at the world (one Claude call with an image each, two when the API asked for a retry) | The agent says it can't look right now |
| `VOICE_TTS_MAX_CHARS_PER_DAY` | Characters sent to text-to-speech | Replies are posted to chat without voice (voice-chat replies too) |
| `VOICE_STT_MAX_SECONDS_PER_DAY` | Seconds of voice input transcribed | Voice input is ignored; chat says to type (at most every 10 minutes, also with `0`) |

How the limits hold:
- A use is counted **before** its request is sent, in the same step that checks the limit, so calls that start at the same moment cannot all pass a limit only one of them fits. Counts are kept in memory and start from zero when the agent restarts.
- `AI_MAX_CALLS_PER_HOUR`, `VOICE_TTS_MAX_CHARS_PER_DAY` and `VOICE_STT_MAX_SECONDS_PER_DAY` are never exceeded. `VISION_MAX_PER_HOUR` counts looks and holds for them. Every request is admitted on its own: the Anthropic client retries nothing by itself, and Coo makes one more attempt only after the API answered that it did not take the request now (429 rate limited, 529 overloaded), as a call of its own that the limits must admit; never after a timeout, a lost connection or another error, whose first attempt may have been answered and billed. Two places ask again on their own, each time as a new call the limits must admit: a chat reply that could not be read is asked for once more, and the planning of a scene edit is tried up to three times, also after a timeout or another error. The OpenAI fallback for text-to-speech is likewise a request of its own, not made when the limit has no room for it. Text or audio that does not fit in what is left is not sent at all, so the agent can stop a little below a voice limit (by less than one reply or utterance).
- `AI_MAX_TOKENS_PER_DAY`: a call is admitted only when its worst case still fits: the bytes of its prompt and system prompt (a token is at least one byte), 64 for the request itself, its output cap, and 5,000 tokens per attached image. A higher output cap therefore raises what every call of that kind reserves, and a daily limit below one call's worst case admits no call at all. So the agent stops up to one call's worst case below the limit, and what a call did not use is free again when it returns. It can still go over by what an image costs beyond 5,000 tokens: that figure is an estimate, not a bound (the API counts an image by its pixels, and the agent does not measure them).
- A call that failed still counts as a call. Its whole reservation (the worst case above) stays counted when it may have been billed (timeout, abort, connection or server error, 529) and nothing of it when the API refused the request (a 4xx answer other than 408 and 409). A look that ended before its request (the snapshot failed, the walk did not get there, the prompt could not be composed, the Claude limit refused it) is given back; so is one whose turn was cancelled before its request was sent (one cancelled while its request was out stays counted: it may have been billed). Text-to-speech characters are given back only when the provider refused the request with a 4xx answer other than 408 and 409; otherwise (an error after it was sent, an answer whose audio failed or stalled) they stay counted, also when the fallback is then tried. Audio seconds stay counted whatever became of the request.
- Refused uses are counted per minute for the reports (at most a day of minutes is kept), so a report's window can include up to a minute more than it names. The "on a break" notice is limited per player for the last 256 players; one forgotten beyond that can get it again at once.
- What is spoken of one reply is at most 600 characters (back to a sentence end when there is one in the second half of those); the rest of a longer reply is in chat only (a voice reply cut this way is posted to chat as well).
- **A limit that cannot be read stops the start.** Empty means no limit and `0` means off; anything that is not a plain number of 0 or more (`abc`, `-1`, `1e3`, `1,000`, `100 calls`) makes the agent log which variable it is and exit, instead of running without that limit. A fraction is rounded down (`0.5` is `0`). An unreadable value stops the start for `AI_MAX_TOKENS_<PURPOSE>`, `AUTONOMY_AI_MAX_PER_HOUR`, `AUTONOMY_AI_MIN_INTERVAL_SEC` and `USAGE_REPORT_INTERVAL_MIN` as well (and a `USAGE_REPORT_INTERVAL_MIN` above 1,440, one report a day); for these four, empty means the default, not "no limit". The five limits and the two `AUTONOMY_AI_*` values are read once, at first use. `AI_MAX_TOKENS_<PURPOSE>` sets a size, not a switch: `0` does not turn that use off and also stops the start (use `AI_MAX_CALLS_PER_HOUR=0` to turn Claude off).
- Not metered: speech-to-text asked for by another plugin through the `TRANSCRIPTION` model (only Hyperfy voice input is; text-to-speech through the `TEXT_TO_SPEECH` model is, cut to 1,000 characters and without the OpenAI fallback). Both models exist only when `ELEVENLABS_XI_API_KEY` is set at startup.
- The "on a break" notice and the thanks for a tip are spoken like any reply, so they use text-to-speech characters.

**Output caps per purpose**: every Claude call this agent makes is tagged with what it is for, which sets its `max_tokens` (room for the model's thinking included): `chat` 2048, `autonomous` 1536, `should-respond` 1024, `navigation` 1024, `use-item` 1024, `vision` 2048, `reply` 1536, `ambient` 1024, `build` 2048. Override one with `AI_MAX_TOKENS_<PURPOSE>`, the purpose in upper case with `_` for `-` (e.g. `AI_MAX_TOKENS_CHAT=3000`, `AI_MAX_TOKENS_SHOULD_RESPOND=800`; empty is the default cap, `0` is refused at startup; a name spelt otherwise is not read). A reply cut off at its cap is logged with the variable to raise. A Claude call another plugin makes without a purpose gets the `maxTokens` it asks for, or 16,000 (4,096 for an image description), and counts against the limits like any other.

**Usage reports**: every `USAGE_REPORT_INTERVAL_MIN` minutes (default `60`, `0` = off, at most `1440`: the agent keeps 24 hours of usage, and a larger value stops the start) the log shows the last interval and the last 24 hours, e.g.

```
[Usage 1h] Claude 34 calls (98k in / 6.1k out) | by origin: chat 20, autonomous 10, voice 4 | by purpose: chat 18 (61k in / 3.9k out), autonomous 10 (30k in / 1.2k out), ... | autonomous ticks: 10 AI / 112 scripted | vision 2 | TTS 3.4k chars (chat 2.2k, autonomous 1.2k) | STT 210 s
```

`origin` is where a call started (a chat message, voice input, an autonomous step, or `other` for a call outside any turn), so navigation triggered by an autonomous step counts as autonomous. A line also shows cache reads, what is held for calls in progress or failed, and refused uses (`over limit: …`) when there are any; the 24-hour line ends with the limits in force. Start without limits, read a few days of reports, then set limits from what you see.

## Known Limits

The residual risks that were accepted, in one place. Each is described where its subject is; nothing in this list is enforced by code.

- **Start paths that skip Coo's defaults.** `elizaos start --character <file>` (and `dev --character`), and a start whose project fails to load, serve the web UI/API without Coo: no loopback default, no locked API, no `SENTRY_DSN=off`, no clean-up of stored secrets. Only the three lines in `.env` (`SERVER_HOST=127.0.0.1`, `ELIZA_SERVER_AUTH_TOKEN`, `SERVER_API_KEY`) and `SENTRY_DSN=off` protect such a start. With a token set, the API is as strong as that token: whoever has it can read and rewrite `.env`. Without a token, a request to the API can still have its body (up to 2 MB) parsed, and a malformed one logged as an error and reported to a Sentry DSN you set. ("Configure Environment Variables")
- **The world's own origin is trusted completely.** Anything that can name a URL (the world, a script, an import request) can make the agent `GET` any path on the origin of `WS_URL`. Outbound requests under the policy do not go through a proxy, and nothing limits how often the agent fetches from a public host. ("What the Agent Downloads")
- **Voice (LiveKit) destinations.** Only the URL the world names is checked. LiveKit's native client resolves the name again itself, and the media connections it then makes (ICE, TURN) are not checked at all.
- **Sender ids on stock Hyperfy are forgeable.** Such a world passes on whatever sender id a client writes: keep `HYPERFY_SCENE_EDITS=off` there, and expect the per-sender chat limits to be sidestepped by changing ids. On a coo-world without `ADMIN_CODE` everyone is an admin. Operators listed in `HYPERFY_OPERATOR_IDS` are builders for Coo whatever the world thinks of them. ("Who Can Ask for What")
- **Scene edits are planned by the model** from the request, everyone's recent chat and the names of things in the world; the check is on who asked, not on what the plan says. Coo gets no confirmation from the world: "done" means changed locally and sent in a form the server's field policies take; Coo checks its own rank but not the world-wide budgets the server checks next (all blueprints together, the join snapshot's room).
- **Tips.** Coo verifies nothing on chain and thanks on the world's word. The public announcement names the recipient by display name, and names are not identities. ("Tips")
- **Shop text.** The address recogniser is best-effort, with the list of what it does not recognise in "OpenPay Store Shop Clerk"; a seller can describe an address in a form it does not know. The agent's own replies are posted as the model wrote them and can contain an address.
- **Render page.** Chromium's memory can go over the limit by what the page allocates between two samples; a kill drops everything the page held; the circuit breaker is for the whole process, so kills caused by one world keep the render page down for the next connection too; a process that leaves Chromium's group and tree before it is sampled is not seen; while `ps` cannot be read only the deadlines apply. The offline arguments do not block WebRTC/UDP (nothing in the page uses it). ("What bounds the render page")
- **Usage limits.** Counts are in memory and start from zero on a restart. `AI_MAX_TOKENS_PER_DAY` can be exceeded by what an image costs beyond the 5,000 tokens assumed for it. Speech-to-text another plugin asks for through the `TRANSCRIPTION` model is not metered. Scene-edit planning asks again after an error, as new calls under the limits. ("Cost Controls and Usage Limits")
- **World scripts (`sandboxed`).** No CPU or memory isolation: a script can hang or crash the agent, use everything the engine's script API offers, and send what it can read to any public https host. The error-event guard has the gaps listed in "World App Scripts". Use `off` for a world you do not trust.
- **Intake.** A frame larger than the limit has already been received when it is dropped. The number of entity lines in a prompt is not bounded. A world can keep the agent busy within the limits given in "What the World Can Make the Agent Take In".
- **PGLite** was checked to boot, not run in a world for any length of time.
- **Dependencies.** See the next section.

## Dependency Advisories

`bun audit` reports six advisories in installed packages (2 high, 3 moderate, 1 low). None is in code the running agent executes:

| Package (advisory) | How it is installed | When its code runs | What would remove it |
|---|---|---|---|
| `extract-zip` 2.0.1, 2 high (GHSA-jmr9-qjv8-65gv, GHSA-7pqw-9j4j-h8q3: a crafted zip can write outside the target directory) | `puppeteer` 24 > `@puppeteer/browsers` | Only while a browser archive is unpacked: puppeteer's install script during `bun install` (unless `PUPPETEER_SKIP_DOWNLOAD=1`) or `puppeteer browsers install`. The archive is the Chrome for Testing zip from Google's storage, over https. Never when the agent launches Chromium | puppeteer 25, which unpacks with the system's `unzip` instead (there is no fixed `extract-zip`). Not done here: every 25.x release pins a newer Chrome build than the ones installed on this machine, so the upgrade needs a browser download and a re-run of both smokes; after it, `unzip` must be on `PATH` for the install |
| `esbuild` ≤ 0.24.2, moderate (GHSA-67mh-4wv8-2f99: its development server answers any website) | The 0.18.20 copy under `@elizaos/plugin-sql` > `drizzle-kit` > `@esbuild-kit/*` (the build's own esbuild is 0.28.2, not affected) | Never: nothing starts esbuild's development server, and plugin-sql does not load drizzle-kit at run time | A drizzle-kit without `@esbuild-kit` (upstream) |
| `glob` 13.0.6, moderate (GHSA-3g3m-2fjr-6pw4) and `minimatch` 10.2.6, moderate (GHSA-g3hv-75wg-m249) | `@elizaos/core` and `@elizaos/cli` > `rimraf` > `glob` | Not on `elizaos start`/`dev`: the CLI's bundled copy is used by `elizaos report generate` (a fixed pattern, no cancellation signal) and `elizaos env reset`; core's Node build does not contain glob | glob 14.0.2+ / minimatch 11.0.1+, a major version for elizaOS to take |
| `elliptic` 6.6.1, low (GHSA-848j-6mx2-7j84) | `@elizaos/core` > `crypto-browserify` | Never under Bun or Node: core uses the runtime's own `crypto` there and falls back to its bundled `crypto-browserify` only in a browser | elizaOS dropping `crypto-browserify` (no fixed elliptic exists) |

No override forces a major version of these onto elizaOS. After any dependency change, run `bun audit` again and compare.

## Architecture

```
src/
├── plugin-hyperfy/
│   ├── session/
│   │   ├── connection-session.ts # One connection to a world and everything that exists only for it
│   │   ├── create-agent-world.ts # Builds the engine world: protocol, identity, chat provenance, network policy, the agent's systems
│   │   ├── deliver-reply.ts      # The one way a turn's reply reaches the world (chat, voice, emote)
│   │   └── appearance.ts         # The agent's name and avatar on one connection
│   ├── lib/
│   │   ├── turn-context.ts      # What a chat / voice / autonomous turn acts for
│   │   ├── authorization.ts     # Who may ask for what; the autonomous action list
│   │   ├── world-identity.ts    # Ranks as the world's server reports them
│   │   ├── world-chat.ts        # Chat provenance; the agent's own posts
│   │   ├── chat-intake.ts       # Chat validation, rate limits and the turn queue
│   │   ├── rate-limited-log.ts  # One log line per interval, with the count, for frequent drops
│   │   ├── room-state.ts        # Muted rooms: answered only when a message names the agent
│   │   ├── addressing.ts        # Aliases (HYPERFY_AGENT_ALIASES); whether a message names the agent
│   │   ├── text.ts              # Text helpers: control and format characters, code-point cuts, shown names
│   │   ├── script-sandbox.ts    # HYPERFY_WORLD_SCRIPTS: lockdown, self-test, compartments
│   │   ├── script-membrane.ts   # What crosses between app scripts and the engine
│   │   ├── script-api.ts        # The world/app API and globals a sandboxed script gets
│   │   ├── script-facades.ts    # console, fetch and setTimeout for scripts
│   │   ├── script-network.ts    # What a script's fetch() may reach
│   │   ├── error-events.ts      # Keeps script-made values out of the process's error events
│   │   ├── net-policy.ts        # The one outbound policy: what may be downloaded from where
│   │   ├── world-url.ts         # WS_URL: default, validation, the world's origin, when the session token may be sent
│   │   ├── log-url.ts           # How a URL is written into a log line (no credentials, no query values)
│   │   ├── asset-root.ts        # Where the bundled files are on disk: next to dist/index.js when built, public/ from source
│   │   ├── asset-bytes.ts       # An asset's bytes: bundled file, data: URL or policy download
│   │   ├── asset-memory.ts      # Memory reserved for assets on their way: download and work pools, 1 GiB in all
│   │   ├── asset-upload.ts      # Authenticated avatar/emote uploads
│   │   ├── gltf-budget.ts       # Admission filter for models before they reach the render page
│   │   ├── render-watchdog.ts   # Memory and time limit on the render page's Chromium; kill circuit breaker
│   │   ├── page-work.ts         # Which assets got the render page killed; one page load at a time after a kill
│   │   ├── scoped-lock.ts       # One section at a time, in the order asked (the avatar, the render page)
│   │   ├── child-env.ts         # The reduced environment Chromium and ffmpeg are started with
│   │   ├── world-protocol.ts    # coo-world network protocol for the older engine
│   │   ├── packet-decode.ts     # Decodes a frame from the world under value, byte and depth limits
│   │   ├── world-add-policy.ts  # coo-world's field policies for a new blueprint and app
│   │   ├── world-teardown.ts    # Destroys an engine world step by step, whatever fails on the way
│   │   ├── reconnect.ts         # Reconnect backoff
│   │   ├── tip-wallet.ts        # Coo's wallet sign-in for tips
│   │   ├── tip-notice.ts        # Reads the world's tip announcements; limits the thanks
│   │   ├── idle-behavior.ts     # Scripted patrol / wander / greeting steps
│   │   ├── simple-commands.ts   # "Come here" / "stop" handled without Claude
│   │   ├── offline-reply.ts     # Replies when the Claude budget is used up
│   │   ├── snapshot-choice.ts   # How to look, chosen from the player's words
│   │   ├── edit-plan.ts         # The scene-edit plan a model may ask for, read as data
│   │   ├── move-outcome.ts      # What the agent says of a walk that did not arrive
│   │   ├── action-result.ts     # What an action returns to elizaOS; telling the requester it failed
│   │   ├── model-output.ts      # Typed reads of loosely shaped model output
│   │   ├── chat-chunks.ts       # Splits replies into world-sized chat messages
│   │   ├── error-text.ts        # An error as text for a log line
│   │   └── playback.ts          # How much of an utterance was played (type)
│   ├── managers/
│   │   ├── behavior-manager.ts  # Autonomous behavior loop
│   │   ├── message-manager.ts   # Chat message handling
│   │   ├── voice-manager.ts     # Voice input/output
│   │   ├── emote-manager.ts     # Emote control
│   │   ├── build-manager.ts     # Scene edits
│   │   ├── guards.ts            # Activity lock: no autonomous step while a message is handled
│   │   └── puppeteer-manager.ts # Snapshots: drives the render page in headless Chromium
│   ├── public/puppeteer/, public/scripts/  # The render page's source (bundled by scripts/build-assets.mjs)
│   ├── public/assets/, avatars/, emotes/   # The bundled environment, avatar and emote clips
│   ├── systems/
│   │   ├── liveKit.ts          # LiveKit audio streaming
│   │   ├── avatar.ts           # VRM avatar management
│   │   ├── controls.ts         # Agent movement control
│   │   ├── actions.ts          # Interactable nodes nearby; holding and releasing an item
│   │   ├── environment.ts      # Sky, HDR, sun and fog; the base environment
│   │   └── loader.ts           # Asset loader
│   ├── actions/                # goto, use, unuse, stop, walk_randomly, ambient, perception, build, teleport, reply, ignore
│   ├── handlers/messageReceivedHandler.ts # One chat or voice turn: simple commands, budget fallback, reply, actions
│   ├── providers/
│   │   ├── actions.ts          # Possible response actions
│   │   ├── character.ts        # Character information
│   │   ├── emote.ts            # Emote list with descriptions
│   │   ├── tips.ts             # How to tip Coo (while it receives tips)
│   │   └── world.ts            # World state provider
│   ├── hyperfy/                # The Hyperfy engine (git submodule)
│   ├── test-support/           # Helpers for the tests (not bundled)
│   ├── constants.ts            # Emote clips: talk, locomotion, the emote list with durations
│   ├── events.ts               # Hyperfy event types and their handler
│   ├── templates.ts            # Prompt templates
│   ├── index.ts                # The plugin: service, actions, providers, events
│   ├── service.ts              # Main service
│   └── utils.ts                # Utilities (asset URLs, speech requests, etc.)
├── openpay-store/              # OpenPay Store shop clerk
├── anthropic-models.ts         # Claude through the official SDK
├── usage-budget.ts             # Usage meter, limits and reports
├── agent-secrets.ts            # What goes into elizaOS's stored secrets; safe defaults for the web UI/API and error reports
├── elevenlabs-speech.ts        # ElevenLabs speech-to-text / text-to-speech models
├── llm-provider.ts             # Model plugin selection (Claude only)
└── index.ts                    # Main entry point & character config
scripts/                        # build-assets.mjs, smoke-boot.mjs, smoke-chromium.mjs, tip-wallet.mjs, postinstall.cjs
stubs/unused-elizaos-plugin/    # Stands in for plugins @elizaos/cli lists but never loads
```

## Key Modifications

### Changes from Original (eliza-3d-hyperfy-starter)

1. **Cost Optimization**: Scripted idle behavior with a limited Claude budget for autonomous actions, nothing when no players are present, separate limits for Claude, vision and voice, and hourly usage reports
2. **Claude via the Official SDK**: Text, JSON and image description with current Claude models
3. **ElevenLabs Voice**: Speech output and voice input
4. **Audio Format Conversion**: Proper MP3 to PCM conversion (using ffmpeg)
5. **Talking Gesture**: TALK animation playback during voice output
6. **Improved Player Detection**: Accurate player counting via entity iteration
7. **PostgreSQL or PGLite**: Local PostgreSQL database usage; elizaOS's embedded PGLite also boots (see "Set Up the Database")
8. **OpenPay Store Shop Clerk**: Product recommendations and purchase links
9. **coo-world Compatibility**: Current network protocol, authenticated uploads, the world's walking clips, chat split to the world's length limit
10. **Lean, Pinned Dependencies**: Unused integrations removed and `bun.lock` committed, which is what pins the versions (`bun audit` to check; see "Dependency Advisories")
11. **Tips**: Coo can receive coo-world tips (JPYC) with its own wallet and thanks the tippers
12. **Authorization**: Scene edits only for players the world lets build, an enforced list of what autonomous steps may do, and only the world server's chat counts as conversation (see "Who Can Ask for What")
13. **One Outbound Policy, Offline Renderer**: Everything a world, a script or an import makes the agent download is limited to public https hosts and the world's own origin, with size caps and deadlines; Chromium has no network and gets none of the agent's keys (see "What the Agent Downloads")

## Troubleshooting

### Voice Not Playing
- Check if ffmpeg is installed: `which ffmpeg`
- Verify ElevenLabs API key is correct
- Check LiveKit connection logs

### Voice Input Ignored
- The log says `No TRANSCRIPTION model`: set `ELEVENLABS_XI_API_KEY`, and give the key the `speech_to_text` permission

### Agent Joins as a Guest, Without Its Rank or Avatar
- The log says `[Hyperfy] No session token on this connection`: `WS_URL` is a `ws://` or `http://` URL of a host that is not written as `localhost`, a loopback or a private address (a name that only resolves to one does not count), so the token would travel readable. Use `wss://`, or the host's private IP address on your own network.

### Agent Does Not Start: `[Usage] ... is not a number of 0 or more`
- A usage setting in `.env` has a value that cannot be read; the log also says `[Usage] Not starting`. Leave it empty (for a limit: no limit; for the others: the default), or set a plain number (`0` turns that use off; `AI_MAX_TOKENS_<PURPOSE>` needs a number above 0).

### Agent Not Moving
- Verify `WS_URL` is correct. A value that is not a `ws://`, `wss://`, `http://` or `https://` URL (including one that is only spaces) is reported once at startup (`[Hyperfy] WS_URL ...`) and the agent does not connect to any world until it is fixed and the agent restarted. When `WS_URL` is unset or empty, the agent joins `wss://chill.hyperfy.xyz/ws`.
- Check if Hyperfy world is running
- Check console error logs
- The agent auto-reconnects to the Hyperfy world with exponential backoff (5s up to a maximum of 5 minutes). If the world is full or another session is already using the same auth token (`localstorage.json`), it retries every 5 minutes; a live session of the other user is not disturbed (coo-world lets a newcomer replace only a connection that no longer answers).

### Disconnected as "outdated"
- The log says the world `requires a newer protocol`: the world changed its network protocol. Update `src/plugin-hyperfy/lib/world-protocol.ts` to match the world's `src/core/packets.js` (protocol version and packet table); the agent retries every 5 minutes meanwhile.

### "Cannot join this world" in the Log
- The world's snapshot could not be read (the line says why: a value that contains itself, more than 500,000 values, more than 32 MiB of strings and binary data, nesting deeper than 64 levels, or something neither server writes), or none came within 60 seconds. The agent leaves that connection and tries again with the usual backoff, up to every 5 minutes, and does not count as connected meanwhile. It joins once the world's state is within those limits: an app whose state is that large or holds itself has to be changed in the world.

### Models, Avatars or the Sky Missing; Uploads Refused
- The log says `This world's assets ... will not be loaded` or `Uploads to this world are refused` when the agent joins: the world names its assets or API under another origin than `WS_URL` (for example `WS_URL=ws://127.0.0.1:3000/ws` while the world announces `http://localhost:3000/...`). Use the world's own host name in `WS_URL`. See "What the Agent Downloads".
- `[AgentLoader] Failed to load ... (refused)` for single assets: the URL is not a public `https://` address or the world's own origin.

### Avatar Not Shown
- The world only accepts uploads from builders, or `.vrm` avatars when **custom avatars** is turned on in the world settings. Turn it on, then restart the agent (it does not notice the setting change on its own). Until then it keeps the world's default avatar.
- Custom `.glb` emotes need builder rank to upload; the agent uses the clips the world already serves.

### Database Does Not Start
- With `POSTGRES_URL` set: check that PostgreSQL runs, that the database exists and that pgvector is installed for it. With `POSTGRES_URL` unset or empty the agent uses PGLite in `PGLITE_DATA_DIR` (default `.eliza/.elizadb` under the directory it is started in), which starts with an empty agent record.

### Agent Sees Nothing, Models Do Not Load
- The log says `[PuppeteerManager] Failed to launch browser`: the Chrome build puppeteer is pinned to is not in `~/.cache/puppeteer`. Run `bunx puppeteer browsers install chrome` (see "Install Dependencies").
- The log says `The render page is down until …`: Chromium was killed three times within 10 minutes for memory or time; it comes back after 10 minutes. See "What bounds the render page".

### Audio Distorted / Wrong Speed / No Voice
- Set `ELEVENLABS_OUTPUT_FORMAT=mp3_44100_128` (a `pcm_*` format is not played at all; the log says "Not playing audio in a format that is neither MP3 nor WAV")
- Check ffmpeg version

## License

MIT License

## Credits

- [ElizaOS](https://github.com/elizaOS/eliza) - AI Agent Framework
- [Hyperfy](https://github.com/hyperfy-xyz/hyperfy) - 3D Virtual World Platform
- [Anthropic Claude](https://www.anthropic.com/) - Language Model
- [ElevenLabs](https://elevenlabs.io/) - Voice Synthesis API
- [LiveKit](https://livekit.io/) - Real-time Audio/Video
