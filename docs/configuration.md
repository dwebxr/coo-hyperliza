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
| `OPENAI_API_KEY`, `OPENAI_TTS_MODEL`, `OPENAI_TTS_VOICE` | Optional OpenAI TTS: the fallback when ElevenLabs gave no audio (or an empty answer), or the only voice when no ElevenLabs key is set (called directly, as a request of its own under `VOICE_TTS_MAX_CHARS_PER_DAY`). Voice input needs the ElevenLabs key either way. See [The OpenAI Voice](#the-openai-voice) | -, `gpt-realtime-2.1-mini`, `marin` |

### The OpenAI Voice

OpenAI shuts `tts-1`, `tts-1-hd` and `gpt-4o-mini-tts` down on 2027-01-06 and names `gpt-realtime-2.1-mini` as their replacement, which it serves only through a Realtime session, not through `/v1/audio/speech`. So `OPENAI_TTS_MODEL` decides how the OpenAI voice is asked for:

| `OPENAI_TTS_MODEL` | What the agent does |
|---|---|
| empty, or `gpt-realtime-2.1-mini` | Opens a Realtime session for each utterance (`wss://api.openai.com/v1/realtime`, the key in the handshake), tells it to read the text aloud word for word, and closes it as soon as the audio is in. Nothing is kept open in between, and nothing connects at startup. The voice is `OPENAI_TTS_VOICE` when it is one of `alloy`, `ash`, `ballad`, `coral`, `echo`, `sage`, `shimmer`, `verse`, `marin`, `cedar`, otherwise `marin` (with one warning) |
| `tts-1`, `tts-1-hd`, `gpt-4o-mini-tts` | `/v1/audio/speech` as before (voice `nova` by default), with one warning about the shutdown. Clear the setting before 2027-01-06 |
| another Realtime, Live or audio model (`gpt-realtime-…`, `gpt-live-…`, `gpt-audio-…`, and the same after `gpt-4o-` or `gpt-4o-mini-`) | Nothing is sent: these are not models the agent reads text with (`gpt-live-1.1` is a conversation model). One warning, and the OpenAI voice is off |
| any other model id | `/v1/audio/speech` with that model, as before |
| not a model id, once leading and trailing spaces are trimmed (more than 64 characters, upper case, a space or line break inside, a first character that is not a lower-case letter or digit) | Nothing is sent. One warning, and the OpenAI voice is off |

What the Realtime reading checks:
- **It says what was written, or it is not played.** The model returns a transcript of what it spoke. The audio is played only when that transcript is exactly what was read (the reply, without the decorative emoji the next point describes), character for character, whitespace inside included; only whitespace at the two ends does not count. Otherwise nothing is played and the reply goes to chat as text, as it does whenever no voice comes. So a correct reading written differently is not played either (`1,980` as `千九百八十`, `５` as `5`, `お勧め` as `おすすめ`, a comma or a final `。` added or left out), after a request that may have been billed. The transcript is the model's own account of its audio, not an independent transcription.
- **Decorative emoji are left out; what a reading cannot say is not read at all.** The agent's replies often end a sentence with a decorative emoji (`おはようございます😊`, `見てみますね👀`). These 19 (with a skin tone or presentation selector) are taken out of what is read: `😀` `😃` `😄` `😁` `😆` `😊` `🙂` `😉` `😍` `🥰` `🤗` `😌` `☺` `✨` `👀` `🙏` `👋` `🎉` and the red heart `❤`, where they end a sentence or a clause, that is, where whitespace, a clause mark (`。` `！` `？` `!` `?` `、` `…`, and `,` `.` when whitespace or the end follows them) or the end of the reply follows (also inside quotes: `「さくら😊 2026」` is read as `「さくら 2026」`); spaces (ordinary and full-width, not line breaks) right before them go too. Whenever something was left out this way, the reply is posted to chat as well, on a voice turn too (as for a reply cut at 600 characters), so what the emoji said can still be seen there. The same decorative emoji followed by a letter or by a closing quote or bracket (`マグ❤️だけ`, `「さくら😊」`), or repeated (`😊😊😊`, `❤❤️`, a rating), keeps the reply from being read, and so does any other emoji (`😅` `😂` `👍` `❓` `❗` `➖` `⭐` `💙` `🌸` a flag, a keycap such as `1️⃣` …), a mark that says yes or no, available or not, chosen or not, or a rating (`✅` `❌` `✕` `○` `◯` `◎` `△` `▲` `☐` `☒` `★` `☆` `✩` `✪` `⛔` …), a `×` (in a dimension, a count or a name alike), or `〇` as a mark (it is read only inside a kanji number with another numeral, `二〇二六年`): such a reply goes to chat as text, where they can be seen, and nothing is sent to OpenAI. (What is spoken of a reply is at most its first 600 characters, and only that part is checked; a reply cut there is posted to chat as well, in up to four chat messages of 500 characters, the last ending with `…` when the reply is longer.)
- The audio and the transcript must belong to the answer that was asked for and to its one audio part, as far as the API's events name them (response, item, output and content index): one that names another ends the attempt; an event that names none of them is not checked. An audio event repeated with the same `event_id` counts once. Anything that arrives after the deadline is not used.
- Only an answer the API marks completed is used, at most 16 MB of audio, within the 30-second deadline that covers connecting too. The answer may use at most 4,096 output tokens.
- A turn that ends (or may no longer act) while the session is being set up sends no text, nor does an attempt past its deadline; one that ends after the request closes the connection at once.
- `OPENAI_TTS_MODEL` must look like a model id once trimmed (lower-case letters, digits, `.`, `_`, `-`, at most 64, starting with a letter or digit); anything else turns the OpenAI voice off, with one warning, and is sent nowhere.
- The audio comes as 24 kHz PCM and is played through the same ffmpeg step as ElevenLabs' MP3.
- Log lines say what happened in fixed words (`[OpenAI TTS] …`): error types, codes and statuses from a fixed list, a close by its number, never the API's own text.

On 2026-11-21 eight Japanese and English sentences were read this way 16 times (voices `marin` and `cedar`): 15 transcripts were the text exactly, a question to the listener and an "ignore the previous instructions" sentence included, and all 8 in `marin`; one in `cedar` added a comma, and would not be played. From opening the connection to the end of the answer took 1.5 to 2.9 seconds (the probe's `report.json`, `totalMs`), against 0.2 to 0.4 seconds for the whole ElevenLabs answer once warm (its first request took 1.6 seconds).

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
