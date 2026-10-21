# Coo Hyperliza

An ElizaOS + Hyperfy 3D world integration agent. An AI agent that autonomously acts and can have voice conversations within Hyperfy VR worlds, writes with Claude, and can work as a shop clerk for OpenPay Store.

## Features

### Cost Optimization
- **Idle Mode Energy Saving**: When no other players are in the world, autonomous actions are skipped entirely (no LLM call is made) and the loop only re-checks for players every 60-120 seconds
  - With players present: autonomous actions every 15-30 seconds
  - Without players: skipped, re-check every 60-120 seconds (idle mode)
- **Cheaper Reply Decisions**: Messages that mention the agent's name or an alias (see `HYPERFY_AGENT_ALIASES`) skip the "should I respond?" LLM check

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
- **Walking Around**: Freely move around the world
- **Approaching Players**: Walk towards nearby players
- **Item Usage**: Interact with objects in the world
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
```

> **Security**: `localstorage.json` holds the agent's Hyperfy auth token. Never commit it, and never paste logs that contain it.
> The web UI / API has no authentication unless `ELIZA_SERVER_AUTH_TOKEN` is set (clients send it as `X-API-KEY`). Keep `SERVER_HOST=127.0.0.1` unless remote access is needed; before binding to `0.0.0.0`, set the token and restrict network access.

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

### Agent Aliases

`HYPERFY_AGENT_ALIASES` is a comma-separated list of extra names the agent answers to (e.g. `クー`). A message containing the agent's name or one of these aliases skips the "should I respond?" LLM check. The check is also skipped when the agent is 1-on-1 with a single player.

### World Compatibility

The agent's Hyperfy engine (the `src/plugin-hyperfy/hyperfy` submodule) is older than coo-world, so `src/plugin-hyperfy/lib/world-protocol.ts` makes it speak coo-world's network protocol (protocol version, packet table, plain msgpack encoding), and `src/plugin-hyperfy/lib/asset-upload.ts` uploads assets with the session token the world requires.

### Adjusting Autonomous Behavior

You can adjust action intervals in `src/plugin-hyperfy/managers/behavior-manager.ts`:

```typescript
const TIME_INTERVAL_MIN = 15000;      // Min interval with players (ms)
const TIME_INTERVAL_MAX = 30000;      // Max interval with players (ms)
const TIME_INTERVAL_IDLE_MIN = 60000; // Min interval in idle mode (ms)
const TIME_INTERVAL_IDLE_MAX = 120000;// Max interval in idle mode (ms)
```

## Architecture

```
src/
├── plugin-hyperfy/
│   ├── lib/
│   │   ├── world-protocol.ts    # coo-world network protocol for the older engine
│   │   ├── asset-upload.ts      # Authenticated avatar/emote uploads
│   │   ├── chat-chunks.ts       # Splits replies into world-sized chat messages
│   │   └── reconnect.ts         # Reconnect backoff
│   ├── managers/
│   │   ├── behavior-manager.ts  # Autonomous behavior loop
│   │   ├── message-manager.ts   # Chat message handling
│   │   ├── voice-manager.ts     # Voice input/output
│   │   ├── emote-manager.ts     # Emote control
│   │   └── puppeteer-manager.ts # Screenshots & VRM control
│   ├── systems/
│   │   ├── liveKit.ts          # LiveKit audio streaming
│   │   ├── avatar.ts           # VRM avatar management
│   │   ├── controls.ts         # Agent movement control
│   │   └── loader.ts           # Asset loader
│   ├── providers/
│   │   └── world.ts            # World state provider
│   ├── templates.ts            # Prompt templates
│   ├── service.ts              # Main service
│   └── utils.ts                # Utilities (TTS generation, etc.)
├── openpay-store/              # OpenPay Store shop clerk
├── anthropic-models.ts         # Claude through the official SDK
├── elevenlabs-speech.ts        # ElevenLabs speech-to-text / text-to-speech models
├── llm-provider.ts             # Model plugin selection (Claude only)
└── index.ts                    # Main entry point & character config
stubs/unused-elizaos-plugin/    # Stands in for plugins @elizaos/cli lists but never loads
```

## Key Modifications

### Changes from Original (eliza-3d-hyperfy-starter)

1. **Cost Optimization**: Reduced autonomous action frequency when no players present
2. **Claude via the Official SDK**: Text, JSON and image description with current Claude models
3. **ElevenLabs Voice**: Speech output and voice input
4. **Audio Format Conversion**: Proper MP3 to PCM conversion (using ffmpeg)
5. **Talking Gesture**: TALK animation playback during voice output
6. **Improved Player Detection**: Accurate player counting via entity iteration
7. **PostgreSQL Support**: Local PostgreSQL database usage
8. **OpenPay Store Shop Clerk**: Product recommendations and purchase links
9. **coo-world Compatibility**: Current network protocol, authenticated uploads, the world's walking clips, chat split to the world's length limit
10. **Lean, Pinned Dependencies**: Unused integrations removed and `bun.lock` committed (`bun audit` to check)

## Troubleshooting

### Voice Not Playing
- Check if ffmpeg is installed: `which ffmpeg`
- Verify ElevenLabs API key is correct
- Check LiveKit connection logs

### Voice Input Ignored
- The log says `No TRANSCRIPTION model`: set `ELEVENLABS_XI_API_KEY`, and give the key the `speech_to_text` permission

### Agent Not Moving
- Verify `WS_URL` is correct
- Check if Hyperfy world is running
- Check console error logs
- The agent auto-reconnects to the Hyperfy world with exponential backoff (5s up to a maximum of 5 minutes). If the world is full or another session is already using the same auth token (`localstorage.json`), it retries every 5 minutes; the other session is not disturbed.

### Disconnected as "outdated"
- The log says the world `requires a newer protocol`: the world changed its network protocol. Update `src/plugin-hyperfy/lib/world-protocol.ts` to match the world's `src/core/packets.js` (protocol version and packet table); the agent retries every 5 minutes meanwhile.

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
