# Coo Hyperliza

Coo is an AI agent that lives in a [Hyperfy](https://github.com/hyperfy-xyz/hyperfy) 3D world. It walks around on its own, talks with players by text and by voice, looks at the world when asked, and can work as a shop clerk for [OpenPay Store](https://open-pay.jp/ja/store). It runs on [elizaOS](https://github.com/elizaOS/eliza) 1.7.2 and writes with Claude.

The project grew out of eliza-3d-hyperfy-starter. What it adds is what an agent needs to be left running in a world that strangers can enter: a usage limit you can set for every service that costs money, rules for who may ask for what, bounds on the chat, voice and packets a world sends, and one policy for everything the agent downloads. What was knowingly left open is listed in [Known Limits](docs/known-limits.md).

## Features

- **Conversation by text and voice.** Coo replies with Claude, speaks with ElevenLabs (OpenAI TTS as an optional fallback) over the world's LiveKit voice chat, and hears players through ElevenLabs speech-to-text.
- **A life of its own.** It patrols a route or wanders around its post, waves at players who arrive, and now and then lets Claude decide what to do next. With no other player in the world its autonomous steps are skipped, so they cost nothing.
- **Sight.** Asked to look, it takes a snapshot of the world in its own headless Chromium and describes it with one Claude call.
- **An avatar.** A custom VRM avatar with emotes, a talking gesture and walking animations.
- **Shop clerk.** It knows the products of the OpenPay Store sellers you name, recommends them when they fit, and posts the purchase link when a player wants one.
- **Tips.** On coo-world it can receive JPYC tips at a wallet of its own, and thanks the tippers.
- **Scene edits on request.** Off by default. Turned on, players the world lets build (and the operators you list) can ask Coo to move, rotate, scale, duplicate, delete or import objects. Coo's own account needs builder rank for that, and it is only safe on a world whose server sets the sender of each chat message itself (coo-world does, stock Hyperfy does not): see [Who Can Ask for What](docs/authorization.md).
- **Cost control.** Scripted idle behavior, "come here" and "stop" without a model call, an output cap per kind of call, separate limits for Claude, vision, speech output and voice input, and a usage report every hour.
- **Care with what a world sends.** App scripts are not run unless you turn the sandbox on, chat, voice and packets are bounded before they are kept or cost anything, and the Chromium that draws the snapshots gets none of the agent's keys and no way to make a request or resolve a name (WebRTC/UDP is not blocked; nothing in the page uses it: see [The Offline Render Page](docs/downloads.md#the-offline-render-page)).

Each of these in detail: [What Coo Does](docs/features.md).

## Requirements

| What | Needed for |
|---|---|
| [Bun](https://bun.sh) 1.2 or newer | Running the agent; `bun.lock` pins the dependency versions |
| Node.js | The build, the install scripts, the tests and the smokes |
| An Anthropic API key | Everything Coo writes (required) |
| A Hyperfy world to join | `WS_URL`. The agent speaks [coo-world](docs/architecture.md#world-compatibility)'s network protocol |
| PostgreSQL with pgvector | Optional: without `POSTGRES_URL`, elizaOS uses its embedded PGLite |
| ffmpeg | Voice |
| An ElevenLabs API key | Optional: voice output and voice input |

## Quick Start

### 1. Clone the Repository

The Hyperfy engine is a submodule, so clone with `--recurse-submodules`.

```bash
git clone --recurse-submodules https://github.com/dwebxr/coo-hyperliza.git
cd coo-hyperliza
```

### 2. Configure Environment Variables

```bash
cp .env.example .env
```

Edit `.env` and set at least these:

```env
# Hyperfy Connection
WS_URL=wss://your-hyperfy-world.xyz/ws

# Database: PostgreSQL (or leave POSTGRES_URL out for the embedded PGLite, see step 3)
POSTGRES_URL=postgresql://localhost:5432/eliza_hyperfy

# Claude (required)
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
# The same value: Socket.IO checks this one
SERVER_API_KEY=a-long-random-string
# No error reports to elizaOS's own Sentry project
SENTRY_DSN=off
# The key elizaOS encrypts its stored secrets with
SECRET_SALT=another-long-random-string
```

> [!IMPORTANT]
> - `localstorage.json` holds the agent's Hyperfy auth token. Never commit it, and never paste logs that contain it.
> - Whoever may use the elizaOS web UI / API can read and rewrite `.env` and control the agent. Keep `SERVER_HOST=127.0.0.1`, `ELIZA_SERVER_AUTH_TOKEN`, `SERVER_API_KEY` (the same token) and `SENTRY_DSN=off` in `.env`, and set your own `SECRET_SALT`. Coo sets safe defaults when the elizaOS CLI loads this project, but a start that does not load it (`elizaos start --character <file>`, a failed build) is protected by `.env` alone.
>
> The whole of it is in [Security](docs/security.md).

The usage limits are yours to set: `.env.example` leaves all of them empty, and empty means no limit (`0` turns that use off). Read a few days of the hourly usage reports, then set them: [Cost Controls and Usage Limits](docs/cost-controls.md).

### 3. Set Up the Database

elizaOS uses PostgreSQL when `POSTGRES_URL` is set, and its embedded PGLite database otherwise. For PostgreSQL (what the examples here use):

```bash
# For macOS
brew install postgresql@14
brew services start postgresql@14

# Create database
createdb eliza_hyperfy
```

pgvector must be installed for your PostgreSQL. For PGLite, leave `POSTGRES_URL` unset or empty. More in [Setup Notes](docs/setup.md#database).

### 4. Install Dependencies

```bash
bun install --frozen-lockfile
```

This also downloads the Chrome build the agent draws its snapshots in (see [Chromium](docs/setup.md#chromium) for proxies, containers and skipping the download).

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

`bun run dev` and `bun run start` build again on every start. If `SERVER_PORT` is in use, elizaOS takes the next free port; the log says which. What the build puts where: [Build and Run](docs/setup.md#build-and-run).

### 7. Talk to It

Join the same world and write in chat, or speak:

- Mention Coo by name (or one of its `HYPERFY_AGENT_ALIASES`) and it answers. When you are the only other player, the name is not needed.
- "Come here", "follow me" and "stop" (English or Japanese), addressed to it the same way, are carried out without a model call. "Follow me" is one walk to where you are, not continued following.
- Ask it to look around, and it describes what it sees.

If it stays silent, the log says why: see [Troubleshooting](#troubleshooting).

## Configuration

Everything is set in `.env`; `.env.example` has the variables with a comment each.

| Area | Variables | Details |
|---|---|---|
| World | `WS_URL` | [What the Agent Downloads](docs/downloads.md) |
| Claude | `ANTHROPIC_API_KEY`, `ANTHROPIC_LARGE_MODEL`, `ANTHROPIC_SMALL_MODEL`, `ANTHROPIC_EFFORT` | [Model Selection](docs/configuration.md#model-selection) |
| Voice | `ELEVENLABS_*`, `OPENAI_API_KEY`, `OPENAI_TTS_*` | [Voice Output Settings](docs/configuration.md#voice-output-settings) |
| Names | `HYPERFY_AGENT_ALIASES` | [Agent Aliases](docs/configuration.md#agent-aliases) |
| Database | `POSTGRES_URL`, `PGLITE_DATA_DIR` | [Database](docs/setup.md#database) |
| Server and secrets | `SERVER_PORT`, `SERVER_HOST`, `ELIZA_SERVER_AUTH_TOKEN`, `SERVER_API_KEY`, `SENTRY_DSN`, `SECRET_SALT` | [Security](docs/security.md) |
| Autonomous behavior | `AUTONOMY_*`, `PATROL_POINTS` | [Cost Controls and Usage Limits](docs/cost-controls.md) |
| Usage limits and reports | `AI_MAX_CALLS_PER_HOUR`, `AI_MAX_TOKENS_PER_DAY`, `AI_MAX_TOKENS_<PURPOSE>`, `VISION_MAX_PER_HOUR`, `VOICE_TTS_MAX_CHARS_PER_DAY`, `VOICE_STT_MAX_SECONDS_PER_DAY`, `USAGE_REPORT_INTERVAL_MIN` | [Cost Controls and Usage Limits](docs/cost-controls.md) |
| Scene edits | `HYPERFY_SCENE_EDITS`, `HYPERFY_OPERATOR_IDS` | [Who Can Ask for What](docs/authorization.md) |
| World app scripts | `HYPERFY_WORLD_SCRIPTS` | [World App Scripts](docs/world-scripts.md) |
| Shop | `OPENPAY_STORE_HANDLES`, `OPENPAY_STORE_LOCALE`, `OPENPAY_STORE_API_URL` | [OpenPay Store Shop Clerk](docs/shop.md) |
| Tips | `TIP_WALLET_PRIVATE_KEY` (written by `npm run tip-wallet`) | [Tips](docs/tips.md) |
| Debugging | `HYPERFY_DEBUG_SNAPSHOTS` | [Debug Snapshots](docs/downloads.md#debug-snapshots) |

## Documentation

| Page | What is in it |
|---|---|
| [What Coo Does](docs/features.md) | The features in detail, and the changes from the original starter |
| [Setup Notes](docs/setup.md) | The database, dependencies, Chromium, ffmpeg, and what the build does |
| [Configuration](docs/configuration.md) | Voice, models and aliases |
| [Cost Controls and Usage Limits](docs/cost-controls.md) | Autonomous behavior, the limits and how they hold, output caps, usage reports |
| [Security](docs/security.md) | The session token, the elizaOS web UI / API, error reports, stored secrets |
| [Who Can Ask for What](docs/authorization.md) | Scene edits, operators, what autonomous steps may do, what counts as conversation |
| [World App Scripts](docs/world-scripts.md) | `off` and `sandboxed`, what a sandboxed script gets, and what the sandbox does not do |
| [What the Agent Downloads](docs/downloads.md) | The network policy, uploads, the render page's limits, the model filter, asset memory |
| [What the World Can Make the Agent Take In](docs/intake.md) | Bounds on chat, turns, voice input, packets and names in prompts |
| [OpenPay Store Shop Clerk](docs/shop.md) | The catalog, and what is checked of every product and link |
| [Tips](docs/tips.md) | Coo's wallet, the sign-in, and what a tip announcement proves |
| [Known Limits](docs/known-limits.md) | The residual risks that were accepted, in one place |
| [Troubleshooting](docs/troubleshooting.md) | Symptoms, the log line to look for, and the fix |
| [Development](docs/development.md) | Tests, the two smokes, what to do after an upgrade, dependency advisories |
| [Architecture](docs/architecture.md) | World compatibility and the source layout |

## Development

```bash
bun run test         # vitest, under Node; reaches nothing but 127.0.0.1
bun run typecheck    # tsc, strict
bun run build

# The two smokes, each from a directory outside the repository
node scripts/smoke-boot.mjs --dir /tmp/coo-smoke
node scripts/smoke-chromium.mjs --dir /tmp/coo-chromium-smoke
```

The boot smoke starts the built agent five times with a dummy key and an unreachable world; the render-page smoke drives the real render page in the real Chromium. Neither uses a real key or sends anything off the machine. What each proves and what it needs, and what to run again after upgrading a dependency: [Development](docs/development.md).

## Troubleshooting

| Symptom | Look for in the log | Usual fix |
|---|---|---|
| Coo receives chat but does not answer ("come here" still works) | `[Bootstrap] Turn handling failed: …` | The line names the cause, for example an `ANTHROPIC_API_KEY` that was not accepted |
| Voice input is ignored | `No TRANSCRIPTION model` | Set `ELEVENLABS_XI_API_KEY`, with the `speech_to_text` permission |
| Coo sees nothing, models do not load | `[PuppeteerManager] Failed to launch browser` | `bunx puppeteer browsers install chrome` |
| Coo joins as a guest, without its rank or avatar | `[Hyperfy] No session token on this connection` | Use `wss://`, or the host's private IP address |
| The agent does not start | `[Usage] ... is not a number of 0 or more` | Leave that setting empty or give it a plain number |

All of them, with the rest: [Troubleshooting](docs/troubleshooting.md).

## License

MIT License

## Credits

- [ElizaOS](https://github.com/elizaOS/eliza) - AI Agent Framework
- [Hyperfy](https://github.com/hyperfy-xyz/hyperfy) - 3D Virtual World Platform
- [Anthropic Claude](https://www.anthropic.com/) - Language Model
- [ElevenLabs](https://elevenlabs.io/) - Voice Synthesis API
- [LiveKit](https://livekit.io/) - Real-time Audio/Video
