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
# The same value: Socket.IO checks this one (needed when the project is not loaded, see below)
SERVER_API_KEY=a-long-random-string
# The key elizaOS encrypts its stored secrets with
SECRET_SALT=another-long-random-string
```

> **Security**: `localstorage.json` holds the agent's Hyperfy auth token. Never commit it, and never paste logs that contain it.
> **The elizaOS web UI / API.** Whoever may use it can read the `.env` file the server finds (`GET /api/system/env/local`: every key, `TIP_WALLET_PRIVATE_KEY` included) and rewrite it (`POST`), read the agent's stored database record including its stored secrets (`GET /api/agents/<id>`), control the agent, and over its Socket.IO connections send the agent messages and stream its logs. elizaOS authenticates the REST API only when `ELIZA_SERVER_AUTH_TOKEN` is set (clients send it as `X-API-KEY`) and Socket.IO only when `SERVER_API_KEY` is set (the web UI sends the one key it stores for both), and listens on every interface (`0.0.0.0`) when `SERVER_HOST` is unset. So when the CLI loads this project (`elizaos start` / `elizaos dev`, which `bun run start` / `bun run dev` run), Coo, at startup:
> - with `SERVER_HOST` unset, makes the server listen on `127.0.0.1` only;
> - with `ELIZA_SERVER_AUTH_TOKEN` unset, locks the REST API and Socket.IO for that run with a random token that is never shown or stored: every request under `/api` gets 401 (except CORS preflight `OPTIONS` requests, which elizaOS answers without the token and which carry nothing) and every Socket.IO connection is refused, unless you set `SERVER_API_KEY` yourself: Socket.IO then accepts that key while the REST API stays locked (the `/healthz` and `/health` status routes and the web UI's own files still answer). To use the web UI or API, set your own `ELIZA_SERVER_AUTH_TOKEN` in `.env` and restart;
> - with `SERVER_API_KEY` unset, uses the REST token for Socket.IO too, so your own token unlocks both.
>
> **These defaults only apply when the CLI loads this project.** `elizaos start --character <file>` and `elizaos dev --character <file>` start the server without loading it, and then none of the above applies. On those start paths only `.env` (or the environment) protects the server, and it needs all three of these:
> - `SERVER_HOST=127.0.0.1`;
> - `ELIZA_SERVER_AUTH_TOKEN=<your token>` (the REST API);
> - `SERVER_API_KEY=<the same token>` (Socket.IO reads this one, not the REST token).
>
> Without them, such a start serves the REST API and Socket.IO with no authentication on every network interface: anyone who can reach the port can read and rewrite `.env`, read the stored secrets and control the agent. The example file has all three; fill in your own token for both.
>
> What remains: with your own token, the API is as strong as that token, and anyone who has it can read and rewrite `.env`; with a token and a non-loopback `SERVER_HOST`, anyone on the network who has the token can (Coo logs a warning then). On the locked default, other programs on this machine and web pages in your browser cannot use the REST API or Socket.IO. The token does not cover `/media/uploads/...` and `/media/generated/...`, which serve files from elizaOS's data directory to whoever knows the agent or channel id and the file name (Coo itself puts none there). The random token lives in the agent's process environment; the processes the agent starts (Chromium, ffmpeg) are given a reduced environment without it and without the API keys.
>
> **Error reports.** The elizaOS server sends error reports (which can hold chat text, file paths and settings) to elizaOS's own Sentry project unless `SENTRY_DSN` names another, and an empty `SENTRY_DSN` means that default. When the CLI loads this project, Coo sets `SENTRY_DSN=off` for the run while it is unset or empty, and logs one `[Security]` line: Sentry then logs `Invalid Sentry Dsn: off` once, creates no transport and sends nothing. Your own DSN is left alone. `elizaos start --character <file>` does not load the project, so there only `.env` holds: keep `SENTRY_DSN=off` there (the example file has it), or put your own DSN.
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

It copies `dist/` next to a throwaway PostgreSQL cluster, starts `elizaos start` there with a dummy key and an unreachable world in both `HYPERFY_WORLD_SCRIPTS` modes, and checks that the agent is listed, tries to connect and schedules a retry, passes the sandbox self-test, returns no key from its API, brings its render page up in Chromium without handing Chromium any key, contacts nothing but 127.0.0.1 (Chromium included), and exits on SIGTERM. Two more runs check that without `SERVER_HOST` and a token the API stays locked on loopback, and that with a usage limit that is not a number (`AI_MAX_CALLS_PER_HOUR=not-a-number`) and a per-purpose cap of 0 (`AI_MAX_TOKENS_CHAT=0`) the agent names both variables and exits by itself without connecting to a world. It needs `initdb`/`pg_ctl` from PostgreSQL 17 with pgvector (`SMOKE_PG_BIN` overrides the Homebrew path) and the Chromium that puppeteer installed (`SMOKE_PUPPETEER_CACHE_DIR` overrides `~/.cache/puppeteer`).

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
| `OPENAI_API_KEY`, `OPENAI_TTS_MODEL`, `OPENAI_TTS_VOICE` | Optional OpenAI TTS fallback (called directly, as a request of its own under `VOICE_TTS_MAX_CHARS_PER_DAY`) | -, `tts-1`, `nova` |

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
| `OPENPAY_STORE_API_URL` | `https://open-pay.jp/api/store/listings` | Listings API (purchase links are only accepted on this origin, and only as `https://` links) |

The catalog loads at startup and, once it is more than 5 minutes old, refreshes in the background the next time it is used (with retry backoff after failures); prompts never wait on the API. Prompts show up to 12 products. The reply names the product by id or an unambiguous title, and the `OPENPAY_SHARE_PRODUCT` action posts the purchase URL from the validated catalog record.

What Coo checks of each product the API returns, and drops it otherwise (the log says how many were dropped per request):
- **Seller**: with handles configured, a request is made per handle and only items of that handle are kept, whatever the API answers. With `*`, every seller is kept.
- **Purchase link**: posted to chat exactly as the API sent it, so it must be exactly what it parses to: an `https://` URL on the API's origin, at most 325 characters, without credentials, whitespace, control or invisible characters, already in its normal form (no upper-case host, default port, dot segments or unencoded characters), with the seller's `@handle` (or `%40handle`) as a segment of its path. 325 is what is left of one 500-character chat message next to the longest text before the link (the title is cut to 60 characters in the link message), so the link is always posted whole. That the link leads to *that product* of the seller is not checked.
- **Text**: titles, descriptions, categories and emoji are cut to one short line without `<`, `>`, backticks, control characters, or bidi and zero-width characters (so a title shows as it reads), NFKC-normalized (full-width letters become plain ones), and with every web address replaced by `(link removed)`: anything with a scheme (`https://`, `hxxps://`, `javascript:` ...), `//host`, `www.…`, a host name followed by a path, port or query (`evil.test/pay`), a bare host name whose top-level domain is a country code or a common generic one (`evil.shop`, `pay.evil.co.jp`), and an IPv4 address. A bare host name with another top-level domain and nothing after it (`evil.test`) is left as text: it cannot be told from a name such as `Node.js` without the list of every domain. The same goes for the seller's handle where it is shown; an item whose id reads as an address is dropped. An amount is digits with at most 15 before and 18 after the point.
- **The link message** (`🛒 title — amount JPYC` and the link, from the share action and from the "on a break" reply alike) is checked as a whole before it is handed on: it must hold exactly one address, the product's purchase URL, and fit one chat message. Otherwise nothing is posted, the player is told the link cannot be posted, and the log says why.
- **Naming a product**: a title is only recognised in a reply or a player's message when it is at least 4 characters long ("AI" or a two-character title would match sentences that are not about it). Shorter-titled products are still on the shelf and are shared when the model names their id. The "on a break" notice offers only recognisable titles as examples.

These checks were written against the response shape the code documents, and are tested with a hand-written fixture (`src/openpay-store/fixtures/listings.synthetic.json`), not with a recorded response: no request was made to the Store for it. A recorded real response would additionally prove that real purchase links are already in normal form and carry `@handle` as a path segment (and in which case), that real amounts and ids fit the patterns, and what optional fields look like. If the shelf stays empty with `item(s) were rejected` in the log, that is where to look.

### Tips (投げゼニ)

coo-world lets players tip each other in JPYC from their own wallets. With a wallet of its own, Coo can receive tips too: other players see a Tip button next to Coo in the Players list, and Coo thanks whoever the world announces as having tipped it (without a model call) and remembers the announcement in the conversation.

1. Create Coo's wallet. This writes a new private key into `.env` as `TIP_WALLET_PRIVATE_KEY` (it is never printed) and shows the address. Run again, it only shows the address and changes nothing. It reads `.env` the way the agent does, so `export TIP_WALLET_PRIVATE_KEY=…`, `TIP_WALLET_PRIVATE_KEY = "…"` and the like count as set; a file that assigns the key more than once is refused until you remove the extra lines. The file is replaced in one step and ends up readable by its owner only (mode 600).
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
- Tips work only while Coo is connected. All Coo knows of a tip is the world's announcement of it (coo-world announces a tip once its own check of the chain confirmed it, for which it needs its RPC). Coo thanks for an announcement only once its wallet has been signed in and shown as receiving tips on that connection: a tip announced after "Receive tips" was switched off again on that connection is still thanked, one announced after a reconnect but before the new sign-in is not.
- Coo verifies nothing on chain: a world on which its wallet signed in can announce a tip that did not happen, and Coo thanks for it. What it stores says so: "The world announced that … tipped me …. I did not check it on chain."
- coo-world's public announcement ("Alice tipped Coo 100 JPYC") names the recipient only by display name, and display names are not identities. Coo takes it for its own only while no other player present has its name as the world writes it into announcements (invisible characters become spaces, spaces run together, cut to 32 characters); while someone else does, Coo thanks for no public announcement to that name. The "(only you) … tipped you …" notice, which coo-world sends to the recipient alone when it does not announce a tip publicly, is thanked for regardless. What remains: Coo thanks on the world's word, and a namesake who left before the announcement arrived is not seen.
- Thanks are limited: the same name at most once in 30 seconds, and over all names three at once, then one every 10 seconds. Announcements beyond that are not thanked and not stored. The tipper's name is used as the world announces it, cut to 32 characters without control or invisible characters; an announcement with an amount longer than 30 digits (18 decimals) or a token name longer than 16 characters is not taken for a tip.
- Check the rules that apply to you (taxes, and whether perks in return for tips make you a seller) before relying on tips.

### Agent Aliases

`HYPERFY_AGENT_ALIASES` is a comma-separated list of extra names the agent answers to (e.g. `クー`). A message containing the agent's name or one of these aliases skips the "should I respond?" LLM check. The check is also skipped when the agent is 1-on-1 with a single player.

### Who Can Ask for What

The agent never does for someone what the world would not let them do themselves:

- **Scene edits** (`HYPERFY_EDIT_ENTITY`: move, rotate, scale, duplicate, delete, import objects) are **off by default**. `HYPERFY_SCENE_EDITS=builders` turns them on for players who may build in the world: present in it, with builder rank or higher as the world's server reports it (on coo-world the higher of the player's rank and the world's rank setting), or with their player id or userId in `HYPERFY_OPERATOR_IDS` (comma-separated). They must ask in chat or by voice; anyone else gets a short refusal, and no Claude call is made for it. Autonomous behavior never edits the world. Any other value of `HYPERFY_SCENE_EDITS` is a configuration error (logged) and keeps them off; the log says which applies on every connection.
  **Turn them on only for a world whose server sets each chat message's sender itself.** The owner's coo-world does. Stock Hyperfy does not: it passes on whatever sender id a client puts in its chat message, so there any visitor can pose as a builder or as a listed operator.
- **An edit stops** as soon as its authorization no longer holds: when the connection to the world changed (a reconnect), or when the requester's rank dropped or they left. It is checked again before each planning call to the model (and after the state for it was composed), and right before each thing it does in the world: walking there, each change, the download of an import, each request of an upload, each announcement in chat, and the closing summary, before it is written and again before it is handed over (a requester who lost the right meanwhile gets one neutral line, "I can't go any further with that request.", and nothing about the scene; no summary is written for them). elizaOS holds that closing message and delivers it after the action has finished; it is not checked again at that moment, so a demotion in that short interval still gets the summary. Nothing is sent to a new connection. The operations not yet made are reported as not done; an imported app that was already added when its upload failed or the edit stopped is taken back again (on the same connection only; its blueprint stays, as the world has no way to remove one).
- **What Coo says it did is what it did**: a target that is gone (also one removed or replaced while Coo walked over to it), a pinned app for a delete (moving, rotating, scaling or duplicating a pinned app is done: the world's server allows it), something that is not an app (players included: the world only moves apps), numbers the world's server would drop (a position beyond ±1,000,000, a rotation that is not close to unit length, a zero scale, anything not finite; for a duplicate, the copied app's own), a duplicate of a unique app whose blueprint names a file the world would refuse in a new blueprint, or a refused or failed import is reported as not done, in its own summary and in the text it falls back to when the summary has none or cannot be written, which is made from the counts alone ("I made 2 of the 3 changes (1 failed)."). "Done" means the change was made locally and sent in a form the world's server accepts; the world does not confirm it.
- **Autonomous steps** may only run walking, using/releasing items, teleporting to a player, ambient speech, replying and ignoring. Any other action the model names on such a step (including by a partial name or a synonym) is refused when it would run.
- **Conversation** is only what the world's server sent: chat that app scripts in the world post (whatever sender they give it) is shown locally but is never answered, never counts as a tip announcement, and is never sent on to the world.
- Everything else (walking to someone, using items, looking around, replying) stays open to everyone.

Caveats:
- On a coo-world without `ADMIN_CODE`, everyone is an admin, so everyone can ask for scene edits.
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

- `fetch()` reaches public `https://` hosts on the default port only, with `GET`, `HEAD` or `POST`, a few request headers (`Accept`, `Accept-Language`, `Authorization`, `Content-Type`, the conditional ones and `X-…`), at most 256 KB sent and 1 MB received, 10 seconds and four requests at a time. The world's own origin gets no exception here: a script reaches it only when it is itself a public `https://` host on the default port. A request these local limits refuse (method, body, size, too many at once) throws a `TypeError` that names the limit. One the network policy refuses, or that fails on the way, throws `fetch failed`, whatever the reason (the reason is in the agent's log): addresses inside the agent's network, plain `http://`, other ports, a response over 1 MB, the deadline. Nothing of the agent's is attached to a request. Models and avatars a script loads with `world.load()`, emotes it plays on an avatar or in a player effect, and the images and HDR environment of a sky node it adds are downloaded by the agent under the same policy (see "What the Agent Downloads"); image, video and audio nodes load nothing.
- `Object3D` and `URL.createObjectURL` are not available; `world.get`/`world.set`/`world.open` do nothing.
- Objects a script hands to the engine are copied (later changes to the script's own object are not seen by the engine), and the engine's objects are seen through proxies. On a vector, quaternion, euler, matrix, lerp or curve, adding properties, replacing methods and reading fields that start with `_` do not work; `class X extends Vector3` does not behave like a subclass.
- A property named `_isRef` or `_ref` cannot be handed to the engine or set on its objects (the engine reads those names as node references). The members that take a node (`add`, `remove`, `insert`, a joint's `body0`/`body1`, `world.add`/`remove`/`attach`) take only a node the engine made (`body0`/`body1` also nothing). `geometry`, also in the data of `app.create()`, takes only the `geometry` of one of the engine's nodes, which may stand for none, or nothing: an object shaped like one, from the script or from the world's own data, is refused. `app.create()` takes no `material`. On an object that claims to be a node reference but is not a node the sandbox recognises, these members are refused.
- A callback handed to the engine (a player effect's `onEnd`, a node's `on…` property such as `onLoad` or `onPointerDown`, also in the data of `app.create()`) must be a function or nothing.
- Event names (`app.on`/`off`/`emit`/`send`/`sendTo`, `world.on`/`off`/`emit`) must be strings. A `destroy` listener or a player effect's `onEnd` that throws is logged; it does not stop the app's teardown.
- A world API function cannot be called with a function as its `this` (`api.call(someFunction, ...)` throws).
- An error from the engine reaches a script with its name and message only, without a stack; file paths in the message read `<path>`.
- `app.control()` returns a control of the script's own. The agent does not feed it input, except that it presses `keyX` there when it releases an item (`HYPERFY_UNUSE_ITEM`).
- `world.chat()` only shows in the agent's local chat view; it is never sent to the world and never answered.
- SES refuses sources that contain `import(`, `eval(` or `<!--`, even in comments and strings.

What the sandbox does not do:

> A sandboxed world script still runs inside the agent's process, on its only thread. There is no CPU or memory isolation: `while (true) {}` hangs the agent for good, and a script can allocate until the process dies. A script can use everything the engine's script API offers it: create and move nodes, read every player's position, name and id, teleport, push, freeze and re-skin the agent's own avatar, send app events to the world's server, post to the agent's local chat view, make the agent download models, avatars, emotes, sky images and HDR environments from the world's own origin or from any public https URL it names (of a model or avatar it loads it learns only whether that worked and the names and positions of its parts), and with `fetch()` send whatever it can read to any public https host and read the answer. A script can break the engine code it calls into by passing it nonsense, which can stop that app, the world's update loop, or the whole process. A script's own error stack traces name the agent's files and where they are on disk. The sandbox is defence for worlds whose builders you mostly trust. It is not a guarantee against a hostile world: use `off` there.

Side effects of `sandboxed` on the rest of the process: the JavaScript built-ins are frozen for everything, including elizaOS and its plugins (SES logs the few Bun-only built-ins it removes at startup), and unhandled promise rejections are logged and survived instead of ending the process, because one line of script can cause one. Every listener of the process's error events (`unhandledRejection`, `rejectionHandled`, `uncaughtException`, `uncaughtExceptionMonitor`, `multipleResolves`), elizaOS's and other plugins' included, and a callback set with `process.setUncaughtExceptionCaptureCallback()`, gets an Error made from the original value's name, message, stack and code instead of that value (a `multipleResolves` value that is not an object is passed as it is), and a promise of the agent's own instead of the script's: a script's rejection reason would otherwise reach code that prints it, and with it the runtime's own `inspect` (`src/plugin-hyperfy/lib/error-events.ts`). With `sandboxed` this guard is installed as soon as the agent's `src/index.ts` runs, before elizaOS's server starts. Under Node it sits in `process.emit`, through which Node delivers these events, so it covers every listener however it was registered. Under Bun, which calls the listeners itself, it wraps each one: those already there, and every one registered later through the process's methods; a once listener registered before the guard becomes an ordinary one, because Bun does not tell them apart; and it keeps a listener of its own on `rejectionHandled`, `uncaughtExceptionMonitor` and `multipleResolves`, so the check below also runs for events nothing else listens to. When one of these events comes and something the guard does not cover is there to get it (under Bun a listener registered through a reference to `process.on` or a sibling method taken before the guard was installed; under both an uncaught-exception capture callback the guard did not set), the agent logs that and exits before handing the event on; the self-test fails if one is there when it runs. Not covered: under Bun, such a listener that is called before any listener the guard wrapped has run since it was registered (one that was prepended, for instance) gets that event's values once, before the agent exits; under Bun, such a listener on an event whose listeners were all removed with `removeAllListeners()`, the guard's own included, is not checked any more; under Node, a function that replaces `process.emit` after the guard was installed sees the values first; a capture callback set in place of one set through the guard, through a reference to the setter taken before the guard was installed (`node:domain` takes one when it loads); and code that calls the listeners itself. After upgrading Bun, elizaOS or a plugin, run the tests and the boot smoke below with `sandboxed` before relying on it: lockdown is sensitive to new built-ins, and the self-test only proves that the escapes it knows are closed.

### What the Agent Downloads

A world tells its clients what to download: models, avatars, emotes, scripts, the sky. A builder can ask Coo to import a file from a URL, a sandboxed script can call `fetch()`, and another plugin can hand Coo an audio URL to transcribe. All of these go through one policy (`src/plugin-hyperfy/lib/net-policy.ts`):

- **Public `https://` hosts on the default port.** A host name is judged by the addresses it resolves to, at the moment the connection is made, and the connection goes to the address that was checked. Loopback, private, link-local, carrier-grade NAT, multicast and cloud-metadata addresses are refused, in every spelling (`https://2130706433/`, IPv4-mapped IPv6, NAT64, 6to4 ...), and so is a name with even one such address among several. No user name or password in the URL.
- **The world's own origin**, whatever its address, port and scheme: the origin of `WS_URL` (`wss://` becomes `https://`, `ws://` becomes `http://`). That is what keeps a local or LAN world working. It is that origin only, with one allowance for a world on loopback: when `WS_URL`'s host is `localhost`, `127.x.x.x` or `[::1]`, the same scheme and port on any of those spellings count as the world too (`ws://127.0.0.1:3000/ws` covers `http://localhost:3000`, and the other way round). Nothing wider: another port, another scheme, or another name for the same machine (a LAN name, `me.localhost`, `[::ffff:127.0.0.1]`) is another origin. A world that names its assets under another origin gets them loaded only if that origin is a public `https://` host (a bucket or CDN is fine); otherwise the agent logs which URL it will not use and why when it joins, and the fix is to write `WS_URL` with the host name the world itself uses.
- Redirects are followed by hand, at most five, and each one is judged from scratch: a redirect off the world's origin loses the exception.
- One deadline per download, and a size cap enforced while the bytes arrive: 50 MB for models and avatars (also for imports, where the world's own upload limit lowers it and can never raise it), 16 MB for emotes, 2 MB for scripts, 32 MB for images, HDR environments and audio.
- **Uploads** (the avatar, emotes, imported models) carry the agent's session token, so they go to the world's own origin only. The one function that attaches the token checks each request's own URL against that origin (and refuses a user name or password in it) before anything is sent, and an upload reads the world's API URL once: its check and its POST go to the URL that was checked, whatever the world announces meanwhile. A world whose API URL is on any other origin gets no upload: the agent logs that once when it joins, keeps the world's default avatar, and never sends the token there. A redirect from the upload API is not followed.
- **What bounds the render page** (`src/plugin-hyperfy/lib/render-watchdog.ts`). Each Chromium the agent launches runs in its own process group. For as long as it exists, the resident memory of everything it owns (its process tree, its process group, and every process seen in either, for as long as that process stays in the group it had) is sampled every 2 seconds, and four times a second while the agent has the page working on something (loading a model, avatar, image or HDR, taking a snapshot). When that goes over 3 GiB, or a page call takes longer than 60 seconds (building the page, 30), that browser is torn down at once: every call in flight fails, any later call to it fails too, and its processes are killed by group and by pid; the next use launches a new one. For this machine's bundled assets the tree measured 0.86 GiB idle and at most 1.7 GiB, and the slowest call took under 0.5 s. A model, image or HDR whose page call was the only one in flight when Chromium was killed is not handed to the page again for that world (said once in the log; at most 256 such URLs are kept per world), and from the first kill on that world's page work runs one call at a time, so that the next kill has one call to blame. Whatever the URLs, 3 kills within 10 minutes open a circuit breaker: for the next 10 minutes every page call fails at once (`RenderPageUnavailable`), logged when it opens and when it closes. When `ps` cannot be read, only the deadlines apply: that is logged once, sampling retries with a growing pause (at most 30 seconds), and the agent logs once when it can read it again. What this cannot do: memory can go over the limit by what the page allocates between two samples; a kill drops everything the page held (textures, avatars, the environment) until the next connection brings it again; resident size is counted per process (shared pages in each); a process that leaves Chromium's group and tree before it is ever sampled is not seen.
- **What is refused before a model reaches the page** (`src/plugin-hyperfy/lib/gltf-budget.ts`), a filter for the amplifiers that are cheap to put in a file, not the limit above. The container is read the way the page's loader reads it (version 2, a declared length equal to the file's, chunks within bounds and multiples of 4 bytes, one JSON chunk first, at most one BIN chunk, nothing else); the JSON may nest at most 64 deep and be at most 16 MiB in UTF-8 without its `data:` URIs (both checked before it is parsed); it must declare `asset.version` 2.x, name only things that exist (the textures its materials name, and the images and samplers of those textures, included), keep buffer views inside their buffers and accessors, sparse parts included, inside their views, and have a node tree that is a tree. Refused on purpose, though valid glTF: Draco, triangle strips and fans, legacy `animation.parameters`, animation data in interleaved views, primitives that the loader would give one geometry but that declare different morph targets (compared by content), and a required extension the page cannot decode (meshopt, BasisU, anything it does not know). Checked against the 23 models bundled with the agent (an avatar exported by UniGLTF with 32 sparse accessors among them) and 25 assets of the owner's worlds (Blender 4.4 exports that require `EXT_texture_webp`, a Blender VRM export), which all pass; how often other exporters write what is refused is not known. The simple allocations are charged (copies of the BIN chunk and of every buffer view, every accessor, decoded `data:` buffers, embedded images per sampler, animation data converted to floats, morph targets and skin matrices as the export writes them): one at most the download cap (50 MB; 16 MB for an emote), all at most eight times the cap; the export they add up to must fit four times the cap, which is also what the page hands back at most. Counts are capped too (every collection, cameras and lights included; the mesh instances the scenes expand to; the animation tracks generated; extras and extension data times the copies made of them). Not covered by the filter, and left to the watchdog: image decoding (a small image can declare huge dimensions), what the VRM plugin builds from its own extensions, and the re-encoding of textures that stay on an exported avatar.
- **What bounds the agent's own memory for assets** (`src/plugin-hyperfy/lib/asset-memory.ts`). Before a download starts, it reserves memory in this process from two pools of 1 GiB in all. Downloads, 256 MiB: twice the kind's size cap (the chunks and the one copy they are joined into), cut to twice the `Content-Length` when the answer declares less, and to twice the actual size once the bytes are in. Then the rest of the way, 768 MiB: for a model 4 times its bytes (the bytes, their base64 and the message carrying it) plus 4 times the export the filter above estimates (the base64 the page returns, its decoded copy, the engine's copies of its BIN chunk and buffer views); for a script 3 times, for an image or HDR 4 times its bytes. The reservation is given back when the load ends, whether it worked or not. One larger than its pool is cut to the pool, so that load runs alone; small files still load side by side, and a load waiting for memory stops when its world goes away. Not counted: the three.js objects and scene graph the engine builds from a parsed model, and the cache of finished loads, which has its own bound (512 MiB, each model counted at the larger of its download and the copy the page handed back).
- Sky images and HDR environments are fetched one sky at a time: a newer sky stops the download of the one before it. Once a world is gone, nothing more is downloaded or handed to the render page for it. A page call already running then (decoding a texture, an avatar or an HDR) cannot be interrupted: the agent settles every such call when it returns: taken back when it failed or the world went away by then; otherwise committed, and taken back still if the world went away during the commit. A settlement that fails fails the load, and the page holds no record of a call beyond its settlement. A model whose materials carry a `materialId` the page cannot use as one fails to load, and what the load had kept in the page goes with it.
- Log lines and error messages write a URL as scheme, host and path only: no user name or password, no query values (their names stay), no fragment, at most 200 characters in all, a note of the full length included (`src/plugin-hyperfy/lib/log-url.ts`).
- The listings request of the OpenPay Store shop goes through the same policy, so `OPENPAY_STORE_API_URL` must be a public `https://` URL.

What this does not do:

- It trusts the world's own origin completely. Anything that can name a URL (the world, a script, an import request) can make the agent `GET` any path on that origin, without credentials. Do not point `WS_URL` at a host that also serves something private.
- The agent can be made to fetch from any public `https://` host, which shows that host the agent's address. Nothing here limits how often.
- These requests do not go through `HTTP_PROXY`/`HTTPS_PROXY`. Where the only way out is a proxy, they fail (and the uploads with them), while Claude and ElevenLabs, which use the runtime's own `fetch`, keep working.
- The voice connection is covered only up to the URL. The world names a LiveKit server; the agent hands it to LiveKit's native client only when it is `ws://` or `wss://` with no user name or password, and either on the world's own host (any scheme and port; loopback spellings count as one host) or `wss://` on the default port of a host whose every address is public, judged as above. Otherwise voice stays off and the agent logs one line saying why. What is not covered: the native client resolves the host name again itself when it connects, so a name whose answer changes between the check and the connection is connected to at its new address, whatever that is; and the media connections the native client then makes (ICE, TURN, the addresses the LiveKit server hands it) are not checked at all.
- Requests the agent makes to fixed services (Claude, ElevenLabs, OpenAI speech) are not world-supplied URLs and are not part of this.

The headless Chromium the agent uses for its snapshots has no network at all. Its page is bundled at build time (three.js 0.132.2 and three-vrm 3.3.3, the versions it was written against; nothing is fetched from a CDN any more), the agent downloads every asset itself under the policy above and passes the bytes in, every request the page makes is refused, and the browser is started with a proxy address where nothing listens and no name resolution, so that the browser's own background requests go nowhere either. A model that refers to files outside itself (a `.gltf` with separate buffers or images) is not given them: it fails to load, or is drawn without them. Chromium and ffmpeg are started with a reduced environment: no API keys, no tokens, no database URL.

`HYPERFY_DEBUG_SNAPSHOTS=true` makes the agent write each snapshot it takes to its working directory (`scene_equirectangular.jpeg`, `scene_facing_<direction>.jpeg`, `scene_view_to_target.jpeg`). Without it, nothing is written.

### What the World Can Make the Agent Take In

Chat, voice and packets come from the world and from whoever is in it. Each is bounded before it is kept or costs anything (`src/plugin-hyperfy/lib/chat-intake.ts`, `managers/voice-manager.ts`, `lib/world-protocol.ts`):

- **Chat messages** are read into a fixed shape before they enter the local chat history: an id and sender id of at most 64 characters, a body cut to one line of 500 characters (line breaks and control characters become spaces), a sender name cut to 32 characters without control or invisible characters. Anything else the world sends as chat is dropped. The history the world sends on connecting is cut to its last 50 messages and never answered.
- **Turns** are taken one at a time in the order the messages arrived; the sender's clock (`createdAt`) decides nothing. A message id is handled once (the last 1,024 ids are remembered, the history the world sends on connecting included: a history message sent again live is not answered). One sender gets 8 messages at once and then one every 4 seconds; sender-less notices share 10 at once and then one a second. Up to 256 senders are tracked; one that is not tracked while the table is full starts with one message, not 8. At most 8 messages of one sender (10 notices) wait: one more drops that sender's own oldest, so one sender cannot push out anyone else's. At most 20 wait in all: beyond that the oldest message of whoever has the most waiting is dropped, and when everyone waiting has one, the newest is turned away. One that waited longer than 2 minutes is dropped instead of answered late. Each kind of drop is logged at most once per 10 seconds, with the count since the last line (a count not yet said comes with the next line). A turn that takes longer than 3 minutes stops holding up the next (it keeps running; what it says later is dropped).
  On a world that lets clients choose their own sender id (stock Hyperfy), someone who changes ids for every message gets one message per new id once the sender table is full, and their messages are the ones a full queue turns away first.
- **Voice input** is buffered per speaker, so people talking at the same time are each transcribed. An utterance ends after 1.5 seconds of silence, or after 30 seconds without a pause; at most 8 people (whether their speech waits or is being transcribed) and 4 full utterances (about 11.5 MB) are held at once, one transcription request per speaker and 3 in all at a time (an utterance waits for a free one); beyond that frames are dropped (logged at most once per 10 seconds). While no speech-to-text is configured, its daily limit is used up, or Coo itself is speaking, audio is dropped as it arrives. A voice is transcribed only while its speaker is a player in the world: when someone leaves, what they said and was not yet sent to speech-to-text is dropped, and a transcript that comes back for someone no longer in the world starts no turn (it was paid for). A transcript is cut like a chat message.
- **Packets**: a frame larger than 8 MB is dropped before it is decoded. This bounds the decoding work, not the memory: the WebSocket has already received the frame, and a decoded packet can be many times its size. A chat packet is cut to the chat message shape (above) before it waits for the engine. What waits for the engine's next tick is bounded too: when more than 4,096 packets or 32 MiB of frames (a chat message counted at 4 KiB) wait, the agent closes the connection instead of dropping packets, since a dropped packet would leave its copy of the world silently different from the server's (a rank change not applied, an entity missing); the reconnect joins again with a fresh snapshot (logged once). Unreadable packets are logged at most once per 10 seconds, with the count, and unknown packet types for the first 32 different ones only.
- **Names in prompts**: entity names, action labels and ids from the world, and stored chat lines, enter prompts as one bounded line each (32 characters for players, 64 for other names, 1,000 for a stored chat line and for the agent's last reply), without control or invisible characters; a stored reply's action names as at most 8 names of 48 characters. Replies that name something from the world ("Arrived at …", "Could not locate entity …") name it as one line of at most 64 characters. Text that is not part of a prompt's template (the model's own thought, a plan's descriptions, such names) is passed as a value, so braces in it are not template syntax.
- **The session token** (the agent's saved identity in the world) is put on the socket URL only for `wss://` / `https://`, or for a host written as `localhost`, a loopback address or a private address (`10.x`, `172.16-31.x`, `192.168.x`, `fc00::/7`). This is decided from the URL alone, whether or not a token is saved. For any other `ws://` / `http://` world the agent logs why (once per connection) and connects **without** a token, as a new guest: no saved identity or rank, and no avatar upload. The guest token the world issues there is neither stored nor sent with uploads, so the agent is a new guest on every connection to such a world, and a saved token is kept as it was. A LAN world addressed by name (`ws://my-box:3000/ws`) is such a case: use its IP address, or `wss://`.

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

How the limits hold:
- A use is counted **before** its request is sent, in the same step that checks the limit, so calls that start at the same moment cannot all pass a limit only one of them fits. Counts are kept in memory and start from zero when the agent restarts.
- `AI_MAX_CALLS_PER_HOUR`, `VISION_MAX_PER_HOUR`, `VOICE_TTS_MAX_CHARS_PER_DAY` and `VOICE_STT_MAX_SECONDS_PER_DAY` are never exceeded. Every request is admitted on its own: the Anthropic client retries nothing by itself, and Coo makes one more attempt only after the API answered that it did not take the request now (429 rate limited, 529 overloaded), as a call of its own that the limits must admit; never after a timeout, a lost connection or another error, whose first attempt may have been answered and billed. The OpenAI fallback for text-to-speech is likewise a request of its own, not made when the limit has no room for it. Text or audio that does not fit in what is left is not sent at all, so the agent can stop a little below a voice limit (by less than one reply or utterance).
- `AI_MAX_TOKENS_PER_DAY`: a call is admitted only when its worst case still fits: the bytes of its prompt (a token is at least one byte), its output cap, and 5,000 tokens per attached image. So the agent stops up to one call's worst case below the limit, and what a call did not use is free again when it returns. It can still go over by what an image costs beyond 5,000 tokens: that figure is an estimate, not a bound (the API counts an image by its pixels, and the agent does not measure them).
- A call that failed still counts as a call. Its tokens count in full when it may have been billed (timeout, abort, connection or server error, 529) and not at all when the API refused the request (a 4xx answer other than 408 and 409). A look whose snapshot failed, or that the Claude limit refused, is given back. Text-to-speech characters are given back only when the provider refused the request with a 4xx answer; otherwise (an error after it was sent, an answer whose audio failed or stalled) they stay counted, also when the fallback is then tried. Audio seconds stay counted whatever became of the request.
- Refused uses are counted per minute for the reports (at most a day of minutes is kept), so a report's window can include up to a minute more than it names. The "on a break" notice is limited per player for the last 256 players; one forgotten beyond that can get it again at once.
- What is spoken of one reply is at most 600 characters (to a sentence end where there is one); the rest of a longer reply is in chat only (a voice reply cut this way is posted to chat as well).
- **A limit that cannot be read stops the start.** Empty means no limit and `0` means off; anything that is not a plain number of 0 or more (`abc`, `-1`, `1e3`, `1,000`, `100 calls`) makes the agent log which variable it is and exit, instead of running without that limit. The same goes for `AI_MAX_TOKENS_<PURPOSE>`, `AUTONOMY_AI_MAX_PER_HOUR`, `AUTONOMY_AI_MIN_INTERVAL_SEC` and `USAGE_REPORT_INTERVAL_MIN`. `AI_MAX_TOKENS_<PURPOSE>` sets a size, not a switch: `0` does not turn that use off and also stops the start (use `AI_MAX_CALLS_PER_HOUR=0` to turn Claude off).
- Not metered: speech-to-text asked for by another plugin through the `TRANSCRIPTION` model (only Hyperfy voice input is; text-to-speech through the `TEXT_TO_SPEECH` model is).

**Output caps per purpose**: every Claude call this agent makes is tagged with what it is for, which sets its `max_tokens` (room for the model's thinking included): `chat` 2048, `autonomous` 1536, `should-respond` 1024, `navigation` 1024, `use-item` 1024, `vision` 2048, `reply` 1536, `ambient` 1024, `build` 2048. Override one with `AI_MAX_TOKENS_<PURPOSE>` (e.g. `AI_MAX_TOKENS_CHAT=3000`, `AI_MAX_TOKENS_SHOULD_RESPOND=800`; empty is the default cap, `0` is refused at startup). A reply cut off at its cap is logged with the variable to raise.

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
│   │   ├── chat-intake.ts       # Chat validation, rate limits and the turn queue
│   │   ├── rate-limited-log.ts  # One log line per interval, with the count, for frequent drops
│   │   ├── script-sandbox.ts    # HYPERFY_WORLD_SCRIPTS: lockdown, self-test, compartments
│   │   ├── script-membrane.ts   # What crosses between app scripts and the engine
│   │   ├── script-api.ts        # The world/app API and globals a sandboxed script gets
│   │   ├── script-facades.ts    # console, fetch and setTimeout for scripts
│   │   ├── script-network.ts    # What a script's fetch() may reach
│   │   ├── net-policy.ts        # The one outbound policy: what may be downloaded from where
│   │   ├── asset-bytes.ts       # An asset's bytes: bundled file, data: URL or policy download
│   │   ├── child-env.ts         # The reduced environment Chromium and ffmpeg are started with
│   │   ├── tip-wallet.ts        # Coo's wallet sign-in for tips
│   │   ├── tip-notice.ts        # Reads the world's tip announcements; limits the thanks
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

### Agent Joins as a Guest, Without Its Rank or Avatar
- The log says `[Hyperfy] Not sending the saved session token`: `WS_URL` is a `ws://` or `http://` URL of a host that is not `localhost`, a loopback or a private address, so the token would travel readable. Use `wss://`, or the host's private IP address on your own network.

### Agent Does Not Start: `[Usage] ... is not a number of 0 or more`
- A usage limit in `.env` has a value that cannot be read. Leave it empty for no limit, set `0` to turn that use off, or a plain number.

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
