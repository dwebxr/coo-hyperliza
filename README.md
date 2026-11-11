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
- The key is kept out of the character secrets elizaOS stores in its database and returns from its API. Its name must not start with `COO_`, which elizaOS would copy into those secrets.
- Coo explains how to tip it when asked, while it is receiving tips, and never asks for tips on its own.
- Tips work only while Coo is connected, and the world announces a tip only once it is confirmed on chain (the world needs its RPC for that).
- Check the rules that apply to you (taxes, and whether perks in return for tips make you a seller) before relying on tips.

### Agent Aliases

`HYPERFY_AGENT_ALIASES` is a comma-separated list of extra names the agent answers to (e.g. `クー`). A message containing the agent's name or one of these aliases skips the "should I respond?" LLM check. The check is also skipped when the agent is 1-on-1 with a single player.

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
│   │   └── puppeteer-manager.ts # Screenshots & VRM control
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
