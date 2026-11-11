# Coo Hyperliza

An ElizaOS + Hyperfy 3D world integration agent. An AI agent that autonomously acts and can have voice conversations within Hyperfy VR worlds, writes with Claude, and can work as a shop clerk for OpenPay Store.

## Features

### Cost Optimization
See "Cost Controls and Usage Limits" for the settings.
- **Scripted Idle Behavior**: Between Claude decisions the agent patrols or wanders around its post, waves at players who arrive and looks around, with no API calls. Claude decides an autonomous action at most every 2 minutes and 20 times an hour by default (both configurable), and never right after a conversation
- **Idle Mode Energy Saving**: When no other players are in the world, autonomous actions are skipped entirely (no API call is made) and the loop only re-checks for players every 60-120 seconds
- **Simple Requests Without Claude**: "Come here" / "follow me" / "stop" (English or Japanese) from the player talking to the agent are carried out directly, using the speaker's position
- **One Call per Look**: Asking the agent to look at something takes one Claude call with the snapshot (how to look is chosen from the player's words)
- **Cheaper Reply Decisions**: Messages that mention the agent's name or an alias (see `HYPERFY_AGENT_ALIASES`) skip the "should I respond?" LLM check
- **Output Caps per Purpose**: Each kind of call (reply, decision, extraction, vision) has its own `max_tokens`
- **Separate Budgets**: Claude, vision, speech output and voice input each have their own optional limit. When the Claude budget is used up the agent keeps patrolling and waving, and still posts a product's purchase link when a player names it
- **Usage Reports**: Calls, tokens and voice usage per purpose and origin are logged every hour

### Voice Features
- **ElevenLabs TTS and speech-to-text**: High-quality voice output, and voice input from players
- **OpenAI TTS Fallback**: Uses OpenAI TTS when ElevenLabs is unavailable (optional)
- **LiveKit Audio Streaming**: Real-time audio delivery to the Hyperfy world

### Avatar Features
- **VRM Avatar Support**: Use a custom VRM avatar (`src/plugin-hyperfy/public/avatars/avatar.vrm`). The world must allow it: see "Avatar Not Shown" below
- **Emote System**: Play animations based on emotions
- **Talking Gesture and Lip Sync**: Plays the TALK animation while speaking. The mouth is moved by the world's own client from the agent's voice (coo-world supports this); nothing is needed on the agent side. A custom clip at `src/plugin-hyperfy/public/emotes/emote-talk.glb` replaces the world's talking gesture
- **Walking Animations**: Uses the agent's own walk/run/idle clips when the world has them or lets the agent upload them; otherwise the world's own clips (Hyperfy's `mp-*` set), sped up to match the agent's movement

### Autonomous Actions
- **Walking Around**: Patrol a fixed route (`PATROL_POINTS`) or wander around its post
- **Greeting Players**: Walk over to and wave at players who arrive
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

# Database (PostgreSQL, required)
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
# The key elizaOS encrypts its stored secrets with
SECRET_SALT=another-long-random-string
```

> **Security**: `localstorage.json` holds the agent's Hyperfy auth token. Never commit it, and never paste logs that contain it.
> **The elizaOS web UI / API.** Whoever may use it can read the `.env` file the server finds (`GET /api/system/env/local`: every key, `TIP_WALLET_PRIVATE_KEY` included) and rewrite it (`POST`), read the agent's stored database record including its stored secrets (`GET /api/agents/<id>`), control the agent, and over its Socket.IO connections send the agent messages and stream its logs. elizaOS authenticates the REST API only when `ELIZA_SERVER_AUTH_TOKEN` is set (clients send it as `X-API-KEY`) and Socket.IO only when `SERVER_API_KEY` is set (the web UI sends the one key it stores for both), and listens on every interface (`0.0.0.0`) when `SERVER_HOST` is unset. So when the CLI loads this project (`elizaos start` / `elizaos dev`, which `bun run start` / `bun run dev` run), Coo, at startup:
> - with `SERVER_HOST` unset, makes the server listen on `127.0.0.1` only;
> - with `ELIZA_SERVER_AUTH_TOKEN` unset, locks the REST API and Socket.IO for that run with a random token that is never shown or stored: every request under `/api` gets 401 and every Socket.IO connection is refused (the `/healthz` and `/health` status routes and the web UI's own files still answer). To use the web UI or API, set your own `ELIZA_SERVER_AUTH_TOKEN` in `.env` and restart;
> - with `SERVER_API_KEY` unset, uses the REST token for Socket.IO too, so your own token unlocks both.
>
> **These defaults only apply when the CLI loads this project.** `elizaos start --character <file>` and `elizaos dev --character <file>` start the server without it, and then none of the above applies: unless `.env` (or the environment) says otherwise, the server listens on `0.0.0.0` with no authentication. The values in `.env` are the only protection that holds on every start path, so keep `SERVER_HOST=127.0.0.1` there (the example file has it) and fill in your own `ELIZA_SERVER_AUTH_TOKEN`.
>
> What remains: with your own token, the API is as strong as that token, and anyone who has it can read and rewrite `.env`; with a token and a non-loopback `SERVER_HOST`, anyone on the network who has the token can (Coo logs a warning then). On the locked default, other programs on this machine and web pages in your browser cannot use the REST API or Socket.IO. The token does not cover `/media/uploads/...` and `/media/generated/...`, which serve files from elizaOS's data directory to whoever knows the agent or channel id and the file name (Coo itself puts none there). The random token lives in the agent's process environment; the processes the agent starts (Chromium, ffmpeg) are given a reduced environment without it and without the API keys.
>
> Stored secrets: Coo does not copy `.env` into the agent record. On each start it deletes what earlier versions stored there: the keys that are in `.env` now, in the start's own merge, and, once the agent has started, stored keys that have since been removed from `.env`. If the database refuses that second step, the log says so as an error and those keys stay stored. elizaOS itself still stores the variables its CLI copies from the environment, notably `POSTGRES_URL`, and the settings it reads from the record (such as per-model tuning like `OBJECT_SMALL_TEMPERATURE`). Stored secrets are encrypted with `SECRET_SALT`; its default, `secretsalt`, is public, so set your own.

### 3. Set Up PostgreSQL (Required)

The embedded PGLite database does not start alongside the Hyperfy engine (the engine's browser-like globals make PGLite think it runs in a browser), so use PostgreSQL:

```bash
# For macOS
brew install postgresql@14
brew services start postgresql@14

# Create database
createdb eliza_hyperfy
```

### 4. Install Dependencies

```bash
bun install --frozen-lockfile
```

`bun.lock` is committed so installs get exactly the audited dependency versions (Bun 1.2 or newer reads it). The project's own postinstall step (custom CSS for the web UI) runs automatically; rerun it with `bun run postinstall` if needed. Bun runs dependencies' install scripts only for [trusted packages](https://bun.sh/docs/pm/lifecycle).

### 5. Install ffmpeg (Required for Voice Features)

```bash
# For macOS
brew install ffmpeg
```

### 6. Build and Run

```bash
bun run build
bun run dev
```

To check that a build boots without touching the live world, the real database or any key, use the scratch smoke instead of starting the agent in this directory (where the CLI loads `.env`):

```bash
bun run build
node scripts/smoke-boot.mjs --dir /tmp/coo-smoke    # any empty directory outside the repository
```

It copies `dist/` next to a throwaway PostgreSQL cluster, starts `elizaos start` there with a dummy key and an unreachable world in both `HYPERFY_WORLD_SCRIPTS` modes, and checks that the agent is listed, tries to connect and schedules a retry, passes the sandbox self-test, returns no key from its API, brings its render page up in Chromium without handing Chromium any key, contacts nothing but 127.0.0.1 (Chromium included), and exits on SIGTERM. It needs `initdb`/`pg_ctl` from PostgreSQL 17 with pgvector (`SMOKE_PG_BIN` overrides the Homebrew path) and the Chromium that puppeteer installed (`SMOKE_PUPPETEER_CACHE_DIR` overrides `~/.cache/puppeteer`).

`bun run build` also bundles the page the agent's headless Chromium draws its snapshots on (`scripts/build-assets.mjs` writes `dist/puppeteer/page.js`). After changing that page, the manager that drives it, puppeteer or Chromium, run the render-page smoke by hand:

```bash
node scripts/smoke-chromium.mjs --dir /tmp/coo-chromium-smoke    # any empty directory outside the repository
```

It drives the real manager and page in the real Chromium with the bundled avatar, an emote, the base environment, the sky image and the HDR, takes each kind of snapshot, and checks that Chromium can reach nothing, this machine's own ports included. It starts neither the agent nor the engine, and its scene is a small one built for the purpose, not a live world's.

## Configuration

### Voice Output Settings

When using ElevenLabs, set the following in `.env`:

| Environment Variable | Description | Default |
|---------------------|-------------|---------|
| `ELEVENLABS_XI_API_KEY` | ElevenLabs API key | - |
| `ELEVENLABS_VOICE_ID` | Voice ID to use | `EXAVITQu4vr4xnSDxMaL` |
| `ELEVENLABS_MODEL_ID` | Model ID (`eleven_flash_v2_5` uses about half the credits and is faster; supports Japanese) | `eleven_multilingual_v2` |
| `ELEVENLABS_OUTPUT_FORMAT` | Output format | `mp3_44100_128` |
| `ELEVENLABS_VOICE_STABILITY` | Voice stability (0-1) | `0.5` |
| `ELEVENLABS_VOICE_SIMILARITY_BOOST` | Similarity boost (0-1) | `0.9` |
| `ELEVENLABS_VOICE_STYLE` | Style (0-1) | `0.66` |
| `ELEVENLABS_VOICE_USE_SPEAKER_BOOST` | Speaker boost (enabled only when set to exactly `true`) | off |
| `ELEVENLABS_STT_MODEL_ID` | Speech-to-text model for voice input | `scribe_v2` |
| `ELEVENLABS_STT_LANGUAGE_CODE` | Speech-to-text language (e.g. `ja`) | auto-detect |
| `OPENAI_API_KEY`, `OPENAI_TTS_MODEL`, `OPENAI_TTS_VOICE` | Optional OpenAI TTS fallback (called directly) | -, `tts-1`, `nova` |

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
| `ANTHROPIC_SMALL_MODEL` | `claude-haiku-5-5` | "Should I respond?" checks, small JSON extractions |
| `ANTHROPIC_LARGE_MODEL` | `claude-haiku-5-5` | Replies and autonomous actions; `claude-sonnet-5-5` for higher quality at ~20x the cost |
| `ANTHROPIC_EFFORT` | `low` | `low` / `medium` / `high` / `xhigh` / `max`; higher is slower and more expensive |

### OpenPay Store Shop Clerk

Coo can act as a shop clerk for [OpenPay Store](https://open-pay.jp/ja/store): it knows the configured products, recommends them when they fit the conversation (and now and then on its own), and when a player wants one it posts the product's purchase link to chat. Buyers pay from their own wallet; Coo holds no wallet or keys. Links are never read aloud.

| Variable | Default | Notes |
|---|---|---|
| `OPENPAY_STORE_HANDLES` | (off) | Comma-separated seller handles to sell (e.g. `alice,bob`; up to 100 products each), or `*` for products from every seller (up to 100 in total) |
| `OPENPAY_STORE_LOCALE` | `ja` | Language of the purchase pages (`ja` / `en`) |
| `OPENPAY_STORE_API_URL` | `https://open-pay.jp/api/store/listings` | Listings API (purchase links are only accepted on this origin) |

The catalog loads at startup and, once it is more than 5 minutes old, refreshes in the background the next time it is used (with retry backoff after failures); prompts never wait on the API. Prompts show up to 12 products. The reply names the product by id or an unambiguous title, and the `OPENPAY_SHARE_PRODUCT` action posts the purchase URL from the validated catalog record (only URLs on the API's origin are accepted).

### Tips (投げゼニ)

coo-world lets players tip each other in JPYC from their own wallets. With a wallet of its own, Coo can receive tips too: other players see a Tip button next to Coo in the Players list, and Coo thanks whoever tips it (without a model call) and remembers it in the conversation.

1. Create Coo's wallet. This writes a new private key into `.env` as `TIP_WALLET_PRIVATE_KEY` (it is never printed) and shows the address. Run again, it only shows the address.
   ```bash
   npm run tip-wallet
   ```
2. Back the key up, e.g. in a password manager: without it, tokens sent to the address cannot be moved.
3. Restart the agent. The log says `[Tips] Receiving tips at 0x…` once the world shows Coo as receiving tips.

How it works and what it can do:
- The world only offers the Tip button for a player whose wallet signed in on the current connection, so Coo signs in on every connection with its key (Sign-In with Ethereum), then turns "Receive tips" on. The world shares only that yes/no flag; the address goes only to a signed-in player who is sending a tip.
- The key only ever signs the world's own sign-in message. Before signing, Coo checks that it is exactly that: the world's domain (the host of `WS_URL`), its statement, Coo's address, the nonce it was given, no extra content and a short expiry. Anything else is refused and tips stay off for that connection. Nothing in the agent builds or sends a transaction.
- Tips arrive as ERC-20 tokens at Coo's address; Coo never moves them. Move them to your main wallet now and then (for example by importing the key into a wallet app; that needs a little POL for gas) and keep only small amounts at this address. If the key may have leaked, create a new wallet and move what is left.
- The key is kept out of the character secrets elizaOS stores in its database and returns from its API (a copy an earlier version stored there is deleted on the next start). Its name must not start with `COO_`, which elizaOS would copy into those secrets.
- At startup the key is read into memory and removed from the agent's process environment; it stays in `.env`. The elizaOS server re-reads `.env` once while starting, which puts it back for a moment, so the Hyperfy service removes it again when it starts. Code running in that window, or after any later re-read of `.env`, can still see it.
- Coo explains how to tip it when asked, while it is receiving tips, and never asks for tips on its own.
- Tips work only while Coo is connected, and the world announces a tip only once it is confirmed on chain (the world needs its RPC for that). Coo thanks for a tip announcement only once its wallet has been signed in and shown as receiving tips on that connection: a tip confirmed after "Receive tips" was switched off again on that connection is still thanked, one announced after a reconnect but before the new sign-in is not.
- Coo verifies nothing on chain: a world on which its wallet signed in can announce a tip that did not happen, and Coo thanks for it.
- Check the rules that apply to you (taxes, and whether perks in return for tips make you a seller) before relying on tips.

### Agent Aliases

`HYPERFY_AGENT_ALIASES` is a comma-separated list of extra names the agent answers to (e.g. `クー`). A message containing the agent's name or one of these aliases skips the "should I respond?" LLM check. The check is also skipped when the agent is 1-on-1 with a single player.

### Who Can Ask for What

The agent never does for someone what the world would not let them do themselves:

- **Scene edits** (`HYPERFY_EDIT_ENTITY`: move, rotate, scale, duplicate, delete, import objects) are **off by default**. `HYPERFY_SCENE_EDITS=builders` turns them on for players who may build in the world: present in it, with builder rank or higher as the world's server reports it (on coo-world the higher of the player's rank and the world's rank setting), or with their player id or userId in `HYPERFY_OPERATOR_IDS` (comma-separated). They must ask in chat or by voice; anyone else gets a short refusal, and no Claude call is made for it. Autonomous behavior never edits the world. Any other value of `HYPERFY_SCENE_EDITS` is a configuration error (logged) and keeps them off; the log says which applies on every connection.
  **Turn them on only for a world whose server sets each chat message's sender itself.** The owner's coo-world does. Stock Hyperfy does not: it passes on whatever sender id a client puts in its chat message, so there any visitor can pose as a builder or as a listed operator.
- **An edit stops** as soon as its authorization no longer holds: when the connection to the world changed (a reconnect), or when the requester's rank dropped or they left. It is checked again right before each thing it does in the world: walking there, each change, the download of an import, each request of an upload, and each announcement in chat. Nothing is sent to a new connection. The operations not yet made are reported as not done; an imported app that was already added when its upload failed or the edit stopped is taken back again (on the same connection only; its blueprint stays, as the world has no way to remove one).
- **What Coo says it did is what it did**: a target that is gone, a pinned app, something that is not an app, invalid numbers, or a refused or failed import is reported as not done, in its own summary and in the fixed "I made N of the M changes" it falls back to.
- **Autonomous steps** may only run walking, using/releasing items, teleporting to a player, ambient speech, replying and ignoring. Any other action the model names on such a step (including by a partial name or a synonym) is refused when it would run.
- **Conversation** is only what the world's server sent: chat that app scripts in the world post (whatever sender they give it) is shown locally but is never answered, never counts as a tip announcement, and is never sent on to the world.
- Everything else (walking to someone, using items, looking around, replying) stays open to everyone.

Caveats:
- On a coo-world without `ADMIN_CODE`, everyone is an admin, so everyone can ask for scene edits.
- Stock Hyperfy worlds pass on whatever sender id a client puts in its chat message (and newer ones also send ranks, so ranks do not tell such a world apart). On them, keep `HYPERFY_SCENE_EDITS=off`: with it on, anyone who sends chat under a builder's or a listed operator's id can ask for edits. coo-world sets the sender id on its server.
- A tip announcement is also a sender-less chat message; it counts only once Coo's tip wallet has been signed in and receiving tips on that connection, and Coo checks nothing on chain (see Tips).
- These checks rely on the world's app scripts not reaching the engine's internals (for example the network handlers that record ranks and chat). By default scripts are not run at all; with `HYPERFY_WORLD_SCRIPTS=sandboxed` they run behind a membrane that keeps those internals out of reach (next section).

### World App Scripts

A Hyperfy world sends *app scripts*: JavaScript written by whoever builds in the world (or runs it), which every client executes. The engine bundled here evaluates them in an SES `Compartment`, but in this agent that was never a boundary: without `lockdown()` one line reaches `process`, and even with it the engine's script API hands out the raw world object (and with it the session token, the socket, and the handlers that chat, ranks and the tip wallet are fed from).

`HYPERFY_WORLD_SCRIPTS` decides what happens to them. There is no mode that runs scripts without the sandbox; any other value is logged as an error and means `off`.

| Value | What the agent does |
|-------|---------------------|
| `off` (default) | Scripts are downloaded with their app and never evaluated. Apps still show their models. What stops working in the agent: interactive items (`HYPERFY_USE_ITEM` finds nothing to use), script-driven sky/environment changes, and anything a script would animate or move. |
| `sandboxed` | At startup the whole process is locked down with SES (`lockdown()`), and a self-test runs the known escapes against the real script runtime; if lockdown fails or one probe gets through, the agent logs why and exits. Each script then runs in its own compartment behind a membrane (`src/plugin-hyperfy/lib/script-membrane.ts`): what the engine returns reaches a script only through a proxy or a wrapper, as an opaque token, or as a copy, and what a script passes reaches the engine only as a copy (its functions as wrappers, its promises followed by promises of the agent's own, its bytes copied into buffers of the agent's own). The self-test also tries the escapes found in review: a promise's or a buffer's species constructor, a forged node reference, a function as `this`, and a host error's stack. |

What a sandboxed script gets: the engine's `world` and `app` API, `props`, `setTimeout`, `console`, `Vector3`/`Quaternion`/`Euler`/`Matrix4`/`LerpVector3`/`LerpQuaternion`/`Curve` and the helper functions. Differences from a Hyperfy client that script authors will notice:

- `fetch()` reaches public `https://` hosts on the default port only, with `GET`, `HEAD` or `POST`, a few request headers (`Accept`, `Accept-Language`, `Authorization`, `Content-Type`, the conditional ones and `X-…`), at most 256 KB sent and 1 MB received, 10 seconds and four requests at a time. Anything else fails with `fetch failed`, whatever the reason (the reason is in the agent's log): addresses inside the agent's network, the world's own origin, plain `http://`, other ports. Nothing of the agent's is attached to a request. Models and avatars a script loads with `world.load()` go through the agent's loader (see "What the Agent Downloads"); images, video and audio are not loaded at all.
- `Object3D` and `URL.createObjectURL` are not available; `world.get`/`world.set`/`world.open` do nothing.
- Objects a script hands to the engine are copied (later changes to the script's own object are not seen by the engine), and the engine's objects are seen through proxies. On a vector, quaternion, euler, matrix, lerp or curve, adding properties, replacing methods and reading fields that start with `_` do not work; `class X extends Vector3` does not behave like a subclass.
- A property named `_isRef` or `_ref` cannot be handed to the engine or set on its objects (the engine reads those names as node references), and the members that take a node (`add`, `remove`, `insert`, a joint's `body0`/`body1`, `world.add`/`remove`/`attach`) or a geometry (`geometry`) take only one the engine made.
- A world API function cannot be called with a function as its `this` (`api.call(someFunction, ...)` throws).
- An error from the engine reaches a script with its name and message only, without a stack; file paths in the message read `<path>`.
- `app.control()` returns a control of the script's own. The agent does not feed it input, except that it presses `keyX` there when it releases an item (`HYPERFY_UNUSE_ITEM`).
- `world.chat()` only shows in the agent's local chat view; it is never sent to the world and never answered.
- SES refuses sources that contain `import(`, `eval(` or `<!--`, even in comments and strings.

What the sandbox does not do:

> A sandboxed world script still runs inside the agent's process, on its only thread. There is no CPU or memory isolation: `while (true) {}` hangs the agent for good, and a script can allocate until the process dies. A script can use everything the engine's script API offers it: create and move nodes, read every player's position, name and id, teleport, push, freeze and re-skin the agent's own avatar, send app events to the world's server, post to the agent's local chat view, make the agent download models and avatars from the world's own origin or from any public https URL it names (of a download it learns only whether it worked and, for a model, the names and positions of its parts), and with `fetch()` send whatever it can read to any public https host and read the answer. A script can break the engine code it calls into by passing it nonsense, which can stop that app, the world's update loop, or the whole process. A script's own error stack traces name the agent's files and where they are on disk. The sandbox is defence for worlds whose builders you mostly trust. It is not a guarantee against a hostile world: use `off` there.

Side effects of `sandboxed` on the rest of the process: the JavaScript built-ins are frozen for everything, including elizaOS and its plugins (SES logs the few Bun-only built-ins it removes at startup), and unhandled promise rejections are logged and survived instead of ending the process, because one line of script can cause one. After upgrading Bun, elizaOS or a plugin, run the tests and the boot smoke below with `sandboxed` before relying on it: lockdown is sensitive to new built-ins, and the self-test only proves that the escapes it knows are closed.

### What the Agent Downloads

A world tells its clients what to download: models, avatars, emotes, scripts, the sky. A builder can ask Coo to import a file from a URL, a sandboxed script can call `fetch()`, and another plugin can hand Coo an audio URL to transcribe. All of these go through one policy (`src/plugin-hyperfy/lib/net-policy.ts`):

- **Public `https://` hosts on the default port.** A host name is judged by the addresses it resolves to, at the moment the connection is made, and the connection goes to the address that was checked. Loopback, private, link-local, carrier-grade NAT, multicast and cloud-metadata addresses are refused, in every spelling (`https://2130706433/`, IPv4-mapped IPv6, NAT64, 6to4 ...), and so is a name with even one such address among several. No user name or password in the URL.
- **The world's own origin**, whatever its address, port and scheme: the origin of `WS_URL` (`wss://` becomes `https://`, `ws://` becomes `http://`). That is what keeps a local or LAN world working. It is exactly that origin: `ws://127.0.0.1:3000/ws` does not cover `http://localhost:3000`. A world that names its assets under another origin gets them loaded only if that origin is a public `https://` host (a bucket or CDN is fine); otherwise the agent logs which URL it will not use and why when it joins, and the fix is to write `WS_URL` with the host name the world itself uses.
- Redirects are followed by hand, at most five, and each one is judged from scratch: a redirect off the world's origin loses the exception.
- One deadline per download, and a size cap enforced while the bytes arrive: 50 MB for models and avatars (also for imports, where the world's own upload limit lowers it and can never raise it), 16 MB for emotes, 2 MB for scripts, 32 MB for images, HDR environments and audio.
- **Uploads** (the avatar, emotes, imported models) carry the agent's session token, so they go to the world's own origin only. A world whose API URL is on any other origin gets no upload: the agent logs that once when it joins, keeps the world's default avatar, and never sends the token there. A redirect from the upload API is not followed.
- The listings request of the OpenPay Store shop goes through the same policy, so `OPENPAY_STORE_API_URL` must be a public `https://` URL.

What this does not do:

- It trusts the world's own origin completely. Anything that can name a URL (the world, a script, an import request) can make the agent `GET` any path on that origin, without credentials. Do not point `WS_URL` at a host that also serves something private.
- The agent can be made to fetch from any public `https://` host, which shows that host the agent's address. Nothing here limits how often.
- These requests do not go through `HTTP_PROXY`/`HTTPS_PROXY`. Where the only way out is a proxy, they fail (and the uploads with them), while Claude and ElevenLabs, which use the runtime's own `fetch`, keep working.
- The voice connection is not covered: the world names a LiveKit server and the agent connects to it with LiveKit's own client.
- Requests the agent makes to fixed services (Claude, ElevenLabs, OpenAI speech) are not world-supplied URLs and are not part of this.

The headless Chromium the agent uses for its snapshots has no network at all. Its page is bundled at build time (three.js 0.132.2 and three-vrm 3.3.3, the versions it was written against; nothing is fetched from a CDN any more), the agent downloads every asset itself under the policy above and passes the bytes in, every request the page makes is refused, and the browser is started with a proxy address where nothing listens and no name resolution, so that the browser's own background requests go nowhere either. A model that refers to files outside itself (a `.gltf` with separate buffers or images) is not given them: it fails to load, or is drawn without them. Chromium and ffmpeg are started with a reduced environment: no API keys, no tokens, no database URL.

`HYPERFY_DEBUG_SNAPSHOTS=true` makes the agent write each snapshot it takes to its working directory (`scene_equirectangular.jpeg`, `scene_facing_<direction>.jpeg`, `scene_view_to_target.jpeg`). Without it, nothing is written.

### World Compatibility

The agent's Hyperfy engine (the `src/plugin-hyperfy/hyperfy` submodule) is older than coo-world, so `src/plugin-hyperfy/lib/world-protocol.ts` makes it speak coo-world's network protocol (protocol version, packet table, plain msgpack encoding), and `src/plugin-hyperfy/lib/asset-upload.ts` uploads assets with the session token the world requires.

### Cost Controls and Usage Limits

What costs money is Claude (every reply, decision and look), ElevenLabs text-to-speech (per character) and speech-to-text (per audio second). Each is limited separately in `.env`, so running out of one leaves the others working.

**Autonomous behavior** (only while other players are in the world):

| Variable | Default | Notes |
|---|---|---|
| `AUTONOMY_TICK_MIN_SEC`, `AUTONOMY_TICK_MAX_SEC` | `15`, `30` | Time between autonomous steps. Most steps are scripted (patrol/wander, wave at newcomers, look around) and cost nothing |
| `AUTONOMY_AI_MIN_INTERVAL_SEC` | `120` | Least time between steps where Claude decides what to do (talk to someone, mention a product). Also counted from the end of the last conversation |
| `AUTONOMY_AI_MAX_PER_HOUR` | `20` | Claude-decided steps per hour; `0` = scripted behavior only |
| `PATROL_POINTS` | (wander) | Patrol route as `x,z; x,z; ...` world coordinates. Without it the agent wanders within 6 m of where it spawned |

After a conversation the agent stays where it is for 90 seconds instead of walking off. Without other players the loop only re-checks every 60-120 seconds.

**Usage limits** (empty = no limit, `0` = that use is off; rolling windows over the last hour / 24 hours):

| Variable | Limits | When reached |
|---|---|---|
| `AI_MAX_CALLS_PER_HOUR` | Claude calls (everything) | No Claude calls. Patrol, waves, "come here" / "stop" carry on. A player who names a product gets its purchase link; other players who talk to the agent get a short "on a break" notice (once per 5 minutes each) |
| `AI_MAX_TOKENS_PER_DAY` | Claude tokens (input + output + cache) | Same as above |
| `VISION_MAX_PER_HOUR` | Looks at the world (one Claude call with an image each) | The agent says it can't look right now |
| `VOICE_TTS_MAX_CHARS_PER_DAY` | Characters sent to text-to-speech | Replies are posted to chat without voice (voice-chat replies too) |
| `VOICE_STT_MAX_SECONDS_PER_DAY` | Seconds of voice input transcribed | Voice input is ignored; chat says to type (at most every 10 minutes) |

Each limit may go over by one call or utterance. Counts are kept in memory and start from zero when the agent restarts.

**Output caps per purpose**: every Claude call this agent makes is tagged with what it is for, which sets its `max_tokens` (room for the model's thinking included): `chat` 2048, `autonomous` 1536, `should-respond` 1024, `navigation` 1024, `use-item` 1024, `vision` 2048, `reply` 1536, `ambient` 1024, `build` 2048. Override one with `AI_MAX_TOKENS_<PURPOSE>` (e.g. `AI_MAX_TOKENS_CHAT=3000`, `AI_MAX_TOKENS_SHOULD_RESPOND=800`). A reply cut off at its cap is logged with the variable to raise.

**Usage reports**: every `USAGE_REPORT_INTERVAL_MIN` minutes (default `60`, `0` = off) the log shows the last interval and the last 24 hours, e.g.

```
[Usage 1h] Claude 34 calls (98k in / 6.1k out) | by origin: chat 20, autonomous 10, voice 4 | by purpose: chat 18 (61k in / 3.9k out), autonomous 10 (30k in / 1.2k out), ... | autonomous ticks: 10 AI / 112 scripted | vision 2 | TTS 3.4k chars (chat 2.2k, autonomous 1.2k) | STT 210 s
```

`origin` is where a call started (a chat message, voice input, or an autonomous step), so navigation triggered by an autonomous step counts as autonomous. Start without limits, read a few days of reports, then set limits from what you see.

## Architecture

```
src/
├── plugin-hyperfy/
│   ├── lib/
│   │   ├── turn-context.ts      # What a chat / voice / autonomous turn acts for
│   │   ├── authorization.ts     # Who may ask for what; the autonomous action list
│   │   ├── world-identity.ts    # Ranks as the world's server reports them
│   │   ├── world-chat.ts        # Chat provenance; the agent's own posts
│   │   ├── script-sandbox.ts    # HYPERFY_WORLD_SCRIPTS: lockdown, self-test, compartments
│   │   ├── script-membrane.ts   # What crosses between app scripts and the engine
│   │   ├── script-api.ts        # The world/app API and globals a sandboxed script gets
│   │   ├── script-facades.ts    # console, fetch and setTimeout for scripts
│   │   ├── script-network.ts    # What a script's fetch() may reach
│   │   ├── net-policy.ts        # The one outbound policy: what may be downloaded from where
│   │   ├── asset-bytes.ts       # An asset's bytes: bundled file, data: URL or policy download
│   │   ├── child-env.ts         # The reduced environment Chromium and ffmpeg are started with
│   │   ├── tip-wallet.ts        # Coo's wallet sign-in for tips
│   │   ├── tip-notice.ts        # Reads the world's tip announcements
│   │   ├── idle-behavior.ts     # Scripted patrol / wander / greeting steps
│   │   ├── simple-commands.ts   # "Come here" / "stop" handled without Claude
│   │   ├── offline-reply.ts     # Replies when the Claude budget is used up
│   │   ├── snapshot-choice.ts   # How to look, chosen from the player's words
│   │   ├── world-protocol.ts    # coo-world network protocol for the older engine
│   │   ├── asset-upload.ts      # Authenticated avatar/emote uploads
│   │   ├── chat-chunks.ts       # Splits replies into world-sized chat messages
│   │   └── reconnect.ts         # Reconnect backoff
│   ├── managers/
│   │   ├── behavior-manager.ts  # Autonomous behavior loop
│   │   ├── message-manager.ts   # Chat message handling
│   │   ├── voice-manager.ts     # Voice input/output
│   │   ├── emote-manager.ts     # Emote control
│   │   └── puppeteer-manager.ts # Snapshots: drives the render page in headless Chromium
│   ├── public/puppeteer/        # The render page's source (bundled by scripts/build-assets.mjs)
│   ├── systems/
│   │   ├── liveKit.ts          # LiveKit audio streaming
│   │   ├── avatar.ts           # VRM avatar management
│   │   ├── controls.ts         # Agent movement control
│   │   └── loader.ts           # Asset loader
│   ├── providers/
│   │   ├── tips.ts             # How to tip Coo (while it receives tips)
│   │   └── world.ts            # World state provider
│   ├── templates.ts            # Prompt templates
│   ├── service.ts              # Main service
│   └── utils.ts                # Utilities (TTS generation, etc.)
├── openpay-store/              # OpenPay Store shop clerk
├── anthropic-models.ts         # Claude through the official SDK
├── usage-budget.ts             # Usage meter, limits and reports
├── agent-secrets.ts            # What goes into elizaOS's stored secrets; API exposure warning
├── elevenlabs-speech.ts        # ElevenLabs speech-to-text / text-to-speech models
├── llm-provider.ts             # Model plugin selection (Claude only)
└── index.ts                    # Main entry point & character config
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
7. **PostgreSQL Support**: Local PostgreSQL database usage
8. **OpenPay Store Shop Clerk**: Product recommendations and purchase links
9. **coo-world Compatibility**: Current network protocol, authenticated uploads, the world's walking clips, chat split to the world's length limit
10. **Lean, Pinned Dependencies**: Unused integrations removed and `bun.lock` committed (`bun audit` to check)
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

### Agent Not Moving
- Verify `WS_URL` is correct. A value that is not a `ws://`, `wss://`, `http://` or `https://` URL (including one that is only spaces) is reported once at startup (`[Hyperfy] WS_URL ...`) and the agent does not connect to any world until it is fixed and the agent restarted. When `WS_URL` is unset or empty, the agent joins `wss://chill.hyperfy.xyz/ws`.
- Check if Hyperfy world is running
- Check console error logs
- The agent auto-reconnects to the Hyperfy world with exponential backoff (5s up to a maximum of 5 minutes). If the world is full or another session is already using the same auth token (`localstorage.json`), it retries every 5 minutes; the other session is not disturbed.

### Disconnected as "outdated"
- The log says the world `requires a newer protocol`: the world changed its network protocol. Update `src/plugin-hyperfy/lib/world-protocol.ts` to match the world's `src/core/packets.js` (protocol version and packet table); the agent retries every 5 minutes meanwhile.

### Models, Avatars or the Sky Missing; Uploads Refused
- The log says `This world's assets ... will not be loaded` or `Uploads to this world are refused` when the agent joins: the world names its assets or API under another origin than `WS_URL` (for example `WS_URL=ws://127.0.0.1:3000/ws` while the world announces `http://localhost:3000/...`). Use the world's own host name in `WS_URL`. See "What the Agent Downloads".
- `[AgentLoader] Failed to load ... (refused)` for single assets: the URL is not a public `https://` address or the world's own origin.

### Avatar Not Shown
- The world only accepts uploads from builders, or `.vrm` avatars when **custom avatars** is turned on in the world settings. Turn it on, then restart the agent (it does not notice the setting change on its own). Until then it keeps the world's default avatar.
- Custom `.glb` emotes need builder rank to upload; the agent uses the clips the world already serves.

### Database Does Not Start
- Use PostgreSQL (`POSTGRES_URL`); PGLite does not start alongside the Hyperfy engine.

### Audio Distorted / Wrong Speed
- Set `ELEVENLABS_OUTPUT_FORMAT=mp3_44100_128`
- Check ffmpeg version

## License

MIT License

## Credits

- [ElizaOS](https://github.com/elizaOS/eliza) - AI Agent Framework
- [Hyperfy](https://github.com/hyperfy-xyz/hyperfy) - 3D Virtual World Platform
- [Anthropic Claude](https://www.anthropic.com/) - Language Model
- [ElevenLabs](https://elevenlabs.io/) - Voice Synthesis API
- [LiveKit](https://livekit.io/) - Real-time Audio/Video
