# Coo Hyperliza

An ElizaOS + Hyperfy 3D world integration agent. An AI agent that autonomously acts and can have voice conversations within Hyperfy VR worlds.

## Features

### Cost Optimization
- **Idle Mode Energy Saving**: When no other players are in the world, autonomous actions are skipped entirely (no LLM call is made) and the loop only re-checks for players every 60-120 seconds
  - With players present: autonomous actions every 15-30 seconds
  - Without players: skipped, re-check every 60-120 seconds (idle mode)
- **Cheaper Reply Decisions**: Messages that mention the agent's name or an alias (see `HYPERFY_AGENT_ALIASES`) skip the "should I respond?" LLM check

### Voice Features
- **ElevenLabs TTS**: High-quality voice synthesis for agent speech
- **OpenAI TTS Fallback**: Uses OpenAI TTS when ElevenLabs is unavailable
- **LiveKit Audio Streaming**: Real-time audio delivery to Hyperfy world

### Avatar Features
- **VRM Avatar Support**: Use custom VRM avatars
- **Emote System**: Play animations based on emotions
- **Lip Sync**: Plays TALK emote during voice output

### Autonomous Actions
- **Walking Around**: Freely move around the world
- **Approaching Players**: Walk towards nearby players
- **Item Usage**: Interact with objects in the world
- **Conversation**: Text chat and voice conversations

## Setup

### 1. Clone the Repository

```bash
git clone --recurse-submodules https://github.com/your-repo/coo-hyperliza.git
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

# Database (PostgreSQL recommended)
POSTGRES_URL=postgresql://localhost:5432/eliza_hyperfy

# LLM API (Claude by default; see "Model Selection")
ANTHROPIC_API_KEY=your-anthropic-api-key

# ElevenLabs TTS (optional)
ELEVENLABS_XI_API_KEY=your-elevenlabs-api-key
ELEVENLABS_VOICE_ID=your-voice-id
ELEVENLABS_MODEL_ID=eleven_multilingual_v2
ELEVENLABS_OUTPUT_FORMAT=mp3_44100_128

# Server Settings
SERVER_PORT=3001
```

> **Security**: `localstorage.json` holds the agent's Hyperfy auth token. Never commit it.

### 3. Setup PostgreSQL (Optional)

To use PostgreSQL locally:

```bash
# For macOS
brew install postgresql@14
brew services start postgresql@14

# Create database
createdb eliza_hyperfy
```

### 4. Install Dependencies

```bash
bun install
bun install  # Run twice to ensure postinstall scripts execute correctly
```

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
| `ELEVENLABS_MODEL_ID` | Model ID | `eleven_multilingual_v2` |
| `ELEVENLABS_OUTPUT_FORMAT` | Output format | `mp3_44100_128` |
| `ELEVENLABS_VOICE_STABILITY` | Voice stability (0-1) | `0.5` |
| `ELEVENLABS_VOICE_SIMILARITY_BOOST` | Similarity boost (0-1) | `0.9` |
| `ELEVENLABS_VOICE_STYLE` | Style (0-1) | `0.66` |
| `ELEVENLABS_VOICE_USE_SPEAKER_BOOST` | Speaker boost (enabled only when set to exactly `true`) | off |

### Model Selection

`LLM_PROVIDER` picks which plugin generates text: `anthropic`, `openai`, `ollama` or `groq` (an unknown value stops startup with an error). Left empty, Claude is used when `ANTHROPIC_API_KEY` is set. Other model plugins stay loaded for what they provide, but never take over text generation from the chosen one.

| Job | Provided by |
|---|---|
| Replies, decisions, JSON extraction, describing what the agent sees | The `LLM_PROVIDER` (Claude by default) |
| Speech output (TTS) | ElevenLabs (`ELEVENLABS_XI_API_KEY`), with OpenAI as an optional fallback |
| Voice input (speech-to-text) | ElevenLabs, called directly (the key needs the `speech_to_text` permission; model `ELEVENLABS_STT_MODEL_ID`, default `scribe_v2`, optional `ELEVENLABS_STT_LANGUAGE_CODE`), else the registered TRANSCRIPTION model |
| Embeddings | Optional (OpenAI or Ollama). Nothing in this agent searches memories by embedding, so replies work without them |

**Anthropic (default when `ANTHROPIC_API_KEY` is set and `LLM_PROVIDER` is unset)** - handled by `src/anthropic-models.ts` with the official SDK, because `@elizaos/plugin-anthropic` sends `temperature` (rejected by current Claude models) and defaults to retired model IDs.

| Variable | Default | Notes |
|---|---|---|
| `ANTHROPIC_SMALL_MODEL` | `claude-haiku-5-5` | "Should I respond?" checks, small JSON extractions |
| `ANTHROPIC_LARGE_MODEL` | `claude-haiku-5-5` | Replies and autonomous actions; `claude-sonnet-5-5` for higher quality at ~20x the cost |
| `ANTHROPIC_EFFORT` | `low` | `low` / `medium` / `high`; higher is slower and more expensive |

**Ollama** - set `LLM_PROVIDER=ollama`; models come from `OLLAMA_API_ENDPOINT`, `OLLAMA_SMALL_MODEL` and `OLLAMA_LARGE_MODEL` (`OLLAMA_MODEL` is not read by the plugin). Requires a running Ollama server.

### Agent Aliases

`HYPERFY_AGENT_ALIASES` is a comma-separated list of extra names the agent answers to (e.g. `クー`). A message containing the agent's name or one of these aliases skips the "should I respond?" LLM check. The check is also skipped when the agent is 1-on-1 with a single player.

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
src/plugin-hyperfy/
├── managers/
│   ├── behavior-manager.ts  # Autonomous behavior loop
│   ├── message-manager.ts   # Chat message handling
│   ├── voice-manager.ts     # Voice input/output
│   ├── emote-manager.ts     # Emote control
│   └── puppeteer-manager.ts # Screenshots & VRM control
├── systems/
│   ├── liveKit.ts          # LiveKit audio streaming
│   ├── avatar.ts           # VRM avatar management
│   ├── controls.ts         # Agent movement control
│   └── loader.ts           # Asset loader
├── providers/
│   └── world.ts            # World state provider
├── templates.ts            # Prompt templates
├── service.ts              # Main service
└── utils.ts                # Utilities (TTS generation, etc.)
```

## Key Modifications

### Changes from Original (eliza-3d-hyperfy-starter)

1. **Cost Optimization**: Reduced autonomous action frequency when no players present
2. **ElevenLabs TTS Integration**: High-quality voice synthesis support
3. **Audio Format Conversion**: Proper MP3 to PCM conversion (using ffmpeg)
4. **Lip Sync**: TALK emote playback during voice output
5. **Improved Player Detection**: Accurate player counting via entity iteration
6. **PostgreSQL Support**: Local PostgreSQL database usage

## Troubleshooting

### Voice Not Playing
- Check if ffmpeg is installed: `which ffmpeg`
- Verify ElevenLabs API key is correct
- Check LiveKit connection logs

### Agent Not Moving
- Verify `WS_URL` is correct
- Check if Hyperfy world is running
- Check console error logs
- The agent auto-reconnects to the Hyperfy world with exponential backoff (5s up to a maximum of 5 minutes). If the world is full or another session is already using the same auth token (`localstorage.json`), it retries every 5 minutes; the other session is not disturbed.

### Audio Distorted / Wrong Speed
- Set `ELEVENLABS_OUTPUT_FORMAT=mp3_44100_128`
- Check ffmpeg version

## License

MIT License

## Credits

- [ElizaOS](https://github.com/elizaOS/eliza) - AI Agent Framework
- [Hyperfy](https://github.com/hyperfy-xyz/hyperfy) - 3D Virtual World Platform
- [ElevenLabs](https://elevenlabs.io/) - Voice Synthesis API
- [LiveKit](https://livekit.io/) - Real-time Audio/Video
