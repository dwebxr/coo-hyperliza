# Architecture

## World Compatibility

The agent's Hyperfy engine (the `src/plugin-hyperfy/hyperfy` submodule) is older than coo-world, so `src/plugin-hyperfy/lib/world-protocol.ts` makes it speak coo-world's network protocol (protocol version, packet table, plain msgpack encoding), and `src/plugin-hyperfy/lib/asset-upload.ts` uploads assets with the session token the world requires.

## Source Layout

```
src/
├── plugin-hyperfy/
│   ├── session/
│   │   ├── connection-session.ts # One connection to a world and everything that exists only for it
│   │   ├── create-agent-world.ts # Builds the engine world: protocol, identity, chat provenance, network policy, the agent's systems
│   │   ├── deliver-reply.ts      # The one way a turn's reply reaches the world (chat, voice, emote)
│   │   └── appearance.ts         # The agent's name and avatar on one connection
│   ├── lib/
│   │   ├── turn-context.ts      # What a chat / voice / autonomous turn acts for
│   │   ├── authorization.ts     # Who may ask for what; the autonomous action list
│   │   ├── world-identity.ts    # Ranks as the world's server reports them
│   │   ├── world-chat.ts        # Chat provenance; the agent's own posts
│   │   ├── chat-intake.ts       # Chat validation, rate limits and the turn queue
│   │   ├── rate-limited-log.ts  # One log line per interval, with the count, for frequent drops
│   │   ├── room-state.ts        # Muted rooms: answered only when a message names the agent
│   │   ├── addressing.ts        # Aliases (HYPERFY_AGENT_ALIASES); whether a message names the agent
│   │   ├── text.ts              # Text helpers: control and format characters, code-point cuts, shown names
│   │   ├── script-sandbox.ts    # HYPERFY_WORLD_SCRIPTS: lockdown, self-test, compartments
│   │   ├── script-membrane.ts   # What crosses between app scripts and the engine
│   │   ├── script-api.ts        # The world/app API and globals a sandboxed script gets
│   │   ├── script-facades.ts    # console, fetch and setTimeout for scripts
│   │   ├── script-network.ts    # What a script's fetch() may reach
│   │   ├── error-events.ts      # Keeps script-made values out of the process's error events
│   │   ├── net-policy.ts        # The one outbound policy: what may be downloaded from where
│   │   ├── world-url.ts         # WS_URL: default, validation, the world's origin, when the session token may be sent
│   │   ├── log-url.ts           # How a URL is written into a log line (no credentials, no query values)
│   │   ├── asset-root.ts        # Where the bundled files are on disk: next to dist/index.js when built, public/ from source
│   │   ├── asset-bytes.ts       # An asset's bytes: bundled file, data: URL or policy download
│   │   ├── asset-memory.ts      # Memory reserved for assets on their way: download and work pools, 1 GiB in all
│   │   ├── asset-upload.ts      # Authenticated avatar/emote uploads
│   │   ├── gltf-budget.ts       # Admission filter for models before they reach the render page
│   │   ├── render-watchdog.ts   # Memory and time limit on the render page's Chromium; kill circuit breaker
│   │   ├── page-work.ts         # Which assets got the render page killed; one page load at a time after a kill
│   │   ├── scoped-lock.ts       # One section at a time, in the order asked (the avatar, the render page)
│   │   ├── child-env.ts         # The reduced environment Chromium and ffmpeg are started with
│   │   ├── world-protocol.ts    # coo-world network protocol for the older engine
│   │   ├── packet-decode.ts     # Decodes a frame from the world under value, byte and depth limits
│   │   ├── world-add-policy.ts  # coo-world's field policies for a new blueprint and app
│   │   ├── world-teardown.ts    # Destroys an engine world step by step, whatever fails on the way
│   │   ├── reconnect.ts         # Reconnect backoff
│   │   ├── tip-wallet.ts        # Coo's wallet sign-in for tips
│   │   ├── tip-notice.ts        # Reads the world's tip announcements; limits the thanks
│   │   ├── idle-behavior.ts     # Scripted patrol / wander / greeting steps
│   │   ├── simple-commands.ts   # "Come here" / "stop" handled without Claude
│   │   ├── offline-reply.ts     # Replies when the Claude budget is used up
│   │   ├── snapshot-choice.ts   # How to look, chosen from the player's words
│   │   ├── edit-plan.ts         # The scene-edit plan a model may ask for, read as data
│   │   ├── move-outcome.ts      # What the agent says of a walk that did not arrive
│   │   ├── action-result.ts     # What an action returns to elizaOS; telling the requester it failed
│   │   ├── model-output.ts      # Typed reads of loosely shaped model output
│   │   ├── chat-chunks.ts       # Splits replies into world-sized chat messages
│   │   ├── error-text.ts        # An error as text for a log line
│   │   └── playback.ts          # How much of an utterance was played (type)
│   ├── managers/
│   │   ├── behavior-manager.ts  # Autonomous behavior loop
│   │   ├── message-manager.ts   # Chat message handling
│   │   ├── voice-manager.ts     # Voice input/output
│   │   ├── emote-manager.ts     # Emote control
│   │   ├── build-manager.ts     # Scene edits
│   │   ├── guards.ts            # Activity lock: no autonomous step while a message is handled
│   │   └── puppeteer-manager.ts # Snapshots: drives the render page in headless Chromium
│   ├── public/puppeteer/, public/scripts/  # The render page's source (bundled by scripts/build-assets.mjs)
│   ├── public/assets/, avatars/, emotes/   # The bundled environment, avatar and emote clips
│   ├── systems/
│   │   ├── liveKit.ts          # LiveKit audio streaming
│   │   ├── avatar.ts           # VRM avatar management
│   │   ├── controls.ts         # Agent movement control
│   │   ├── actions.ts          # Interactable nodes nearby; holding and releasing an item
│   │   ├── environment.ts      # Sky, HDR, sun and fog; the base environment
│   │   └── loader.ts           # Asset loader
│   ├── actions/                # goto, use, unuse, stop, walk_randomly, ambient, perception, build, teleport, reply, ignore
│   ├── handlers/messageReceivedHandler.ts # One chat or voice turn: simple commands, budget fallback, reply, actions
│   ├── providers/
│   │   ├── actions.ts          # Possible response actions
│   │   ├── character.ts        # Character information
│   │   ├── emote.ts            # Emote list with descriptions
│   │   ├── tips.ts             # How to tip Coo (while it receives tips)
│   │   └── world.ts            # World state provider
│   ├── hyperfy/                # The Hyperfy engine (git submodule)
│   ├── test-support/           # Helpers for the tests (not bundled)
│   ├── constants.ts            # Emote clips: talk, locomotion, the emote list with durations
│   ├── events.ts               # Hyperfy event types and their handler
│   ├── templates.ts            # Prompt templates
│   ├── index.ts                # The plugin: service, actions, providers, events
│   ├── service.ts              # Main service
│   └── utils.ts                # Utilities (asset URLs, speech requests, etc.)
├── openpay-store/              # OpenPay Store shop clerk
├── anthropic-models.ts         # Claude through the official SDK
├── usage-budget.ts             # Usage meter, limits and reports
├── agent-secrets.ts            # What goes into elizaOS's stored secrets; safe defaults for the web UI/API and error reports
├── elevenlabs-speech.ts        # ElevenLabs speech-to-text / text-to-speech models
├── llm-provider.ts             # Model plugin selection (Claude only)
└── index.ts                    # Main entry point & character config
scripts/                        # build-assets.mjs, smoke-boot.mjs, smoke-chromium.mjs, tip-wallet.mjs, postinstall.cjs
stubs/unused-elizaos-plugin/    # Stands in for plugins @elizaos/cli lists but never loads
```
