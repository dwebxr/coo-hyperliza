# Troubleshooting

Start with the agent's log: most of these have a line of their own there.

## Voice Not Playing
- Check if ffmpeg is installed: `which ffmpeg`
- Verify ElevenLabs API key is correct
- Check LiveKit connection logs

## Agent Receives Chat but Does Not Answer ("come here" Still Works)
- The log says `[Bootstrap] Turn handling failed: the model API answered 401 (authentication_error): the API key was not accepted (expired, revoked or wrong): ANTHROPIC_API_KEY`: put a valid Claude API key in `ANTHROPIC_API_KEY` and restart. If the key in `.env` is valid, check whether the shell the agent is started from exports another `ANTHROPIC_API_KEY`.
- Other answers of the API read the same way: `400 (invalid_request_error): no credit left on the account`, `404 (not_found_error)` for a model ID that does not exist, and so on. No free-form text of the API's answer is logged. The line holds the status, the error type when it is one of the API's own, what it means in fixed words, and the request id when it is shaped like one (`[request req_…]`), under which the API's own reason can be looked up in the Anthropic Console.
- "Come here" and "stop" from the player talking to the agent are carried out without a model call, so they go on working while every other message gets no answer.
- Any other `[Bootstrap] Turn handling failed: …` line names what threw while the turn was handled: its name and message, at most 400 characters. Two kinds are said without their message: a `SyntaxError` (its message quotes what could not be read), and an error that cannot be read at all (`an error that could not be read`).

## Voice Input Ignored
- The log says `No TRANSCRIPTION model`: set `ELEVENLABS_XI_API_KEY`, and give the key the `speech_to_text` permission

## Agent Joins as a Guest, Without Its Rank or Avatar
- The log says `[Hyperfy] No session token on this connection`: `WS_URL` is a `ws://` or `http://` URL of a host that is not written as `localhost`, a loopback or a private address (a name that only resolves to one does not count), so the token would travel readable. Use `wss://`, or the host's private IP address on your own network.

## Agent Does Not Start: `[Usage] ... is not a number of 0 or more`
- A usage setting in `.env` has a value that cannot be read; the log also says `[Usage] Not starting`. Leave it empty (for a limit: no limit; for the others: the default), or set a plain number (`0` turns that use off; `AI_MAX_TOKENS_<PURPOSE>` needs a number above 0).

## Agent Not Moving
- Verify `WS_URL` is correct. A value that is not a `ws://`, `wss://`, `http://` or `https://` URL (including one that is only spaces) is reported once at startup (`[Hyperfy] WS_URL ...`) and the agent does not connect to any world until it is fixed and the agent restarted. When `WS_URL` is unset or empty, the agent joins `wss://chill.hyperfy.xyz/ws`.
- Check if Hyperfy world is running
- Check console error logs
- The agent auto-reconnects to the Hyperfy world with exponential backoff (5s up to a maximum of 5 minutes). If the world is full or another session is already using the same auth token (`localstorage.json`), it retries every 5 minutes; a live session of the other user is not disturbed (coo-world lets a newcomer replace only a connection that no longer answers).

## Disconnected as "outdated"
- The log says the world `requires a newer protocol`: the world changed its network protocol. Update `src/plugin-hyperfy/lib/world-protocol.ts` to match the world's `src/core/packets.js` (protocol version and packet table); the agent retries every 5 minutes meanwhile.

## "Cannot join this world" in the Log
- The world's snapshot could not be read (the line says why: a value that contains itself, more than 500,000 values, more than 32 MiB of strings and binary data, nesting deeper than 64 levels, or something neither server writes), or none came within 60 seconds. The agent leaves that connection and tries again with the usual backoff, up to every 5 minutes, and does not count as connected meanwhile. It joins once the world's state is within those limits: an app whose state is that large or holds itself has to be changed in the world.

## Models, Avatars or the Sky Missing; Uploads Refused
- The log says `This world's assets ... will not be loaded` or `Uploads to this world are refused` when the agent joins: the world names its assets or API under another origin than `WS_URL` (for example `WS_URL=ws://127.0.0.1:3000/ws` while the world announces `http://localhost:3000/...`). Use the world's own host name in `WS_URL`. See [What the Agent Downloads](downloads.md).
- `[AgentLoader] Failed to load ... (refused)` for single assets: the URL is not a public `https://` address or the world's own origin.

## Avatar Not Shown
- The world only accepts uploads from builders, or `.vrm` avatars when **custom avatars** is turned on in the world settings. Turn it on, then restart the agent (it does not notice the setting change on its own). Until then it keeps the world's default avatar.
- Custom `.glb` emotes need builder rank to upload; the agent uses the clips the world already serves.

## Database Does Not Start
- With `POSTGRES_URL` set: check that PostgreSQL runs, that the database exists and that pgvector is installed for it. With `POSTGRES_URL` unset or empty the agent uses PGLite in `PGLITE_DATA_DIR` (default `.eliza/.elizadb` under the directory it is started in), which starts with an empty agent record.

## Agent Sees Nothing, Models Do Not Load
- The log says `[PuppeteerManager] Failed to launch browser`: the Chrome build puppeteer is pinned to is not in `~/.cache/puppeteer`. Run `bunx puppeteer browsers install chrome` (see [Chromium](setup.md#chromium)).
- The log says `The render page is down until …`: Chromium was killed three times within 10 minutes for memory or time; it comes back after 10 minutes. See [What Bounds the Render Page](downloads.md#what-bounds-the-render-page).

## The OpenAI Voice Does Not Speak
- `[OpenAI TTS] The reading did not say the text as written (first difference at character N of M; the transcript has K): not played`: the model's transcript of its reading was not what was read exactly, so the reply went to chat as text; the numbers say where they part (neither text is logged). This is the check working; it also happens when the reading was right but written differently (a number in kanji, a final `。` added).
- `[OpenAI TTS] Not read: the text has marks a reading cannot say`: the reply had an emoji that is not decorative (`👍`, `❓`, a flag), a mark such as `✅` or `○`, or a `×`; it went to chat as text, where they can be seen. Decorative emoji (`😊` `✨` `👀` …) followed by whitespace, a clause mark or the end do not stop a reading (the reply is then posted to chat as well); followed by a letter or a closing quote or bracket, or repeated, they do.
- `[OpenAI TTS] The connection failed or was refused before the session started`: check `OPENAI_API_KEY`, and that the machine can reach `api.openai.com` without a proxy.
- `[OpenAI TTS] No complete answer within 30000 ms`, `The answer was not completed (status …)`, `The API reported …` or `The API closed the connection (code N)`: one attempt failed; the reply went to chat as text. From the moment speech was asked for, its characters stay counted against `VOICE_TTS_MAX_CHARS_PER_DAY`. If it happens every time, check the key, this machine's network and the [OpenAI status page](https://status.openai.com).
- `[OpenAI TTS] OPENAI_TTS_MODEL names a model this agent does not read text with`: leave `OPENAI_TTS_MODEL` empty (`gpt-realtime-2.1-mini`). `gpt-live-1.1` is a conversation model and is not used for reading.
- `[OpenAI TTS] OPENAI_TTS_MODEL is not a model id`: the setting holds something other than a model id (upper case, spaces, a line break); fix or empty it.
- `[OpenAI TTS] OPENAI_TTS_MODEL=tts-1 shuts down on 2027-01-06`: the old model still works until then; leave the setting empty to move to `gpt-realtime-2.1-mini`.

## Audio Distorted / Wrong Speed / No Voice
- Set `ELEVENLABS_OUTPUT_FORMAT=mp3_44100_128` (a `pcm_*` format is not played at all; the log says "Not playing audio in a format that is neither MP3 nor WAV")
- Check ffmpeg version
