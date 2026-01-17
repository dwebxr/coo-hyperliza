# Coo Hyperliza

An ElizaOS + Hyperfy 3D world integration agent. An AI agent that autonomously acts and can have voice conversations within Hyperfy VR worlds, with Discord integration for community engagement.

## Features

### Cost Optimization
- **Idle Mode Energy Saving**: Reduces autonomous action frequency when no other players are in the world to minimize API call costs
  - With players present: 15-30 second intervals
  - Without players: 60-120 second intervals (idle mode)

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

### Discord Integration
- **Auto-Reply**: Automatically responds to mentions and messages
- **Scheduled Posts**: Posts daily updates to a configured channel
- **Community Engagement**: Participates in server conversations

### Twitter/X Integration
- **Daily Posts**: Posts once per day automatically
- **Reply to Mentions**: Responds to mentions and replies
- **Free Plan Optimized**: Conservative API usage for Twitter Free tier

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

# LLM API
OPENAI_API_KEY=your-openai-api-key

# ElevenLabs TTS (optional)
ELEVENLABS_XI_API_KEY=your-elevenlabs-api-key
ELEVENLABS_VOICE_ID=your-voice-id
ELEVENLABS_MODEL_ID=eleven_multilingual_v2
ELEVENLABS_OUTPUT_FORMAT=mp3_44100_128

# Discord (optional)
DISCORD_APPLICATION_ID=your-application-id
DISCORD_API_TOKEN=your-bot-token
DISCORD_POST_CHANNEL_ID=channel-id-for-auto-posts
DISCORD_POST_INTERVAL_HOURS=24
DISCORD_ENABLE_AUTO_POST=true

# Twitter/X (optional - OAuth 1.0a credentials)
TWITTER_API_KEY=your-api-key
TWITTER_API_SECRET_KEY=your-api-secret
TWITTER_ACCESS_TOKEN=your-access-token
TWITTER_ACCESS_TOKEN_SECRET=your-access-token-secret
TWITTER_ENABLE_POST=true
TWITTER_ENABLE_REPLIES=true
TWITTER_POST_INTERVAL=1440

# Server Settings
SERVER_PORT=3001
```

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
| `ELEVENLABS_STABILITY` | Voice stability (0-1) | `0.5` |
| `ELEVENLABS_SIMILARITY_BOOST` | Similarity boost (0-1) | `0.75` |
| `ELEVENLABS_STYLE` | Style (0-1) | `0` |
| `ELEVENLABS_USE_SPEAKER_BOOST` | Speaker boost | `true` |

### Discord Settings

| Environment Variable | Description | Default |
|---------------------|-------------|---------|
| `DISCORD_APPLICATION_ID` | Discord application ID | - |
| `DISCORD_API_TOKEN` | Discord bot token | - |
| `DISCORD_POST_CHANNEL_ID` | Channel ID for auto-posts | - |
| `DISCORD_POST_INTERVAL_HOURS` | Hours between auto-posts | `24` |
| `DISCORD_ENABLE_AUTO_POST` | Enable auto-posting | `true` |

### Twitter/X Settings (Free Plan Optimized)

| Environment Variable | Description | Default |
|---------------------|-------------|---------|
| `TWITTER_API_KEY` | OAuth 1.0a API Key | - |
| `TWITTER_API_SECRET_KEY` | OAuth 1.0a API Secret | - |
| `TWITTER_ACCESS_TOKEN` | OAuth 1.0a Access Token | - |
| `TWITTER_ACCESS_TOKEN_SECRET` | OAuth 1.0a Access Secret | - |
| `TWITTER_ENABLE_POST` | Enable posting | `true` |
| `TWITTER_ENABLE_REPLIES` | Enable reply to mentions | `true` |
| `TWITTER_ENABLE_ACTIONS` | Enable likes/retweets | `false` |
| `TWITTER_POST_INTERVAL` | Minutes between posts | `1440` (24h) |
| `TWITTER_MAX_ENGAGEMENTS_PER_RUN` | Max replies per cycle | `3` |
| `TWITTER_DRY_RUN` | Test without posting | `false` |

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
├── discord/
│   └── discord-auto-post.ts    # Discord scheduled posting
├── plugin-hyperfy/
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
└── index.ts                     # Main entry point & character config
```

## Key Modifications

### Changes from Original (eliza-3d-hyperfy-starter)

1. **Cost Optimization**: Reduced autonomous action frequency when no players present
2. **ElevenLabs TTS Integration**: High-quality voice synthesis support
3. **Audio Format Conversion**: Proper MP3 to PCM conversion (using ffmpeg)
4. **Lip Sync**: TALK emote playback during voice output
5. **Improved Player Detection**: Accurate player counting via entity iteration
6. **PostgreSQL Support**: Local PostgreSQL database usage
7. **Discord Integration**: Auto-reply and scheduled daily posts
8. **Twitter/X Integration**: Daily posts and mention replies (Free Plan optimized)

## Troubleshooting

### Voice Not Playing
- Check if ffmpeg is installed: `which ffmpeg`
- Verify ElevenLabs API key is correct
- Check LiveKit connection logs

### Agent Not Moving
- Verify `WS_URL` is correct
- Check if Hyperfy world is running
- Check console error logs

### Audio Distorted / Wrong Speed
- Set `ELEVENLABS_OUTPUT_FORMAT=mp3_44100_128`
- Check ffmpeg version

### Discord Bot Not Responding
- Verify `DISCORD_API_TOKEN` is correct
- Check bot has proper permissions in the server
- Ensure bot is invited to the server with correct scopes

### Discord Auto-Post Not Working
- Set `DISCORD_ENABLE_AUTO_POST=true`
- Verify `DISCORD_POST_CHANNEL_ID` is set correctly
- Check bot has permission to send messages in the channel

### Twitter 403 Forbidden Error
- Ensure app has "Read and write" permissions (not just Read)
- Regenerate Access Token & Secret after changing permissions
- Verify using OAuth 1.0a credentials (not OAuth 2.0)

### Twitter Not Posting
- Check `TWITTER_ENABLE_POST=true`
- Verify all 4 OAuth credentials are set correctly
- Try `TWITTER_DRY_RUN=true` first to test

## License

MIT License

## Credits

- [ElizaOS](https://github.com/elizaOS/eliza) - AI Agent Framework
- [Hyperfy](https://github.com/hyperfy-xyz/hyperfy) - 3D Virtual World Platform
- [ElevenLabs](https://elevenlabs.io/) - Voice Synthesis API
- [LiveKit](https://livekit.io/) - Real-time Audio/Video
- [Discord.js](https://discord.js.org/) - Discord API Library
