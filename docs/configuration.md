# Configuration

The agent is configured in `.env`; `.env.example` has the variables with a comment each. This page covers voice, models and names. The other areas have pages of their own:

- the server, its token and stored secrets: [Security](security.md)
- autonomous behavior, usage limits and reports: [Cost Controls and Usage Limits](cost-controls.md)
- scene edits and operators: [Who Can Ask for What](authorization.md)
- world app scripts: [World App Scripts](world-scripts.md)
- the shop: [OpenPay Store Shop Clerk](shop.md)
- the tip wallet: [Tips](tips.md)
- `WS_URL` and what the agent fetches: [What the Agent Downloads](downloads.md)

## Voice Output Settings

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

## Model Selection

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

## Agent Aliases

`HYPERFY_AGENT_ALIASES` is a comma-separated list of extra names the agent answers to (e.g. `クー`). A message containing the agent's name or one of these aliases skips the "should I respond?" LLM check (a name in Latin letters must stand as a whole word: "Coo!" yes, "cool" no; other names match anywhere in the message), and addresses "come here" / "stop" to the agent. The check is also skipped when the agent is 1-on-1 with a single player, that is, when exactly one other player is in the world.
