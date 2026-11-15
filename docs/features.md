# What Coo Does

The features in detail, and what changed from the starter this project grew out of. The short version is in the [README](../README.md#features).

## Cost Optimization
See [Cost Controls and Usage Limits](cost-controls.md) for the settings.

- **Scripted Idle Behavior**: Between Claude decisions the agent patrols or wanders around its post, waves at players who arrive and looks around, with no API calls. Claude decides an autonomous action at most every 2 minutes and 20 times an hour by default (both configurable), and never right after a conversation
- **Idle Mode Energy Saving**: When no other players are in the world, autonomous actions are skipped entirely (no API call is made) and the loop only re-checks for players every 60-120 seconds
- **Simple Requests Without Claude**: "Come here" / "follow me" / "stop" (English or Japanese) from the player talking to the agent are carried out directly: it walks to where the speaker is (teleports when they are more than 30 m away), or stops. Only a short message that is nothing but the command counts; "follow me" is one walk to the speaker, not continued following
- **One Call per Look**: The look itself takes one Claude call with the snapshot, on top of the reply call that chose it (how to look is chosen from the player's words). A look at an entity the agent could not walk to is not taken (and not counted) unless the same entity is still there, within 20 m of where the agent stopped, judged by where it is then; a walk that was stopped or replaced takes no look at all, nor does one at an entity that was removed on the way
- **Cheaper Reply Decisions**: Messages that mention the agent's name or an alias (see [`HYPERFY_AGENT_ALIASES`](configuration.md#agent-aliases)) skip the "should I respond?" LLM check, and so do messages from the only other player in the world
- **Output Caps per Purpose**: Each kind of call (reply, decision, extraction, vision) has its own `max_tokens`
- **Separate Budgets**: Claude, vision, speech output and voice input each have their own optional limit. When the Claude budget is used up the agent keeps patrolling and waving, and still posts a product's purchase link when a player talking to it names it
- **Usage Reports**: Calls, tokens and voice usage per purpose and origin are logged every hour

## Voice Features
- **ElevenLabs TTS and speech-to-text**: High-quality voice output, and voice input from players
- **OpenAI TTS Fallback**: Uses OpenAI TTS when ElevenLabs is unavailable (optional)
- **LiveKit Audio Streaming**: Real-time audio delivery to the Hyperfy world

## Avatar Features
- **VRM Avatar Support**: Use a custom VRM avatar (`src/plugin-hyperfy/public/avatars/avatar.vrm`, which the build copies to `dist/avatars/`). The world must allow it: see [Avatar Not Shown](troubleshooting.md#avatar-not-shown)
- **Emote System**: Play animations based on emotions
- **Talking Gesture and Lip Sync**: Plays the TALK animation while speaking. The mouth is moved by the world's own client from the agent's voice (coo-world supports this); nothing is needed on the agent side. A custom clip at `src/plugin-hyperfy/public/emotes/emote-talk.glb` is uploaded in place of the world's talking gesture where the world lets the agent upload clips (builder rank)
- **Walking Animations**: Uses the agent's own walk/run/idle clips when the world has them or lets the agent upload them; otherwise the world's own clips (Hyperfy's `mp-*` set), sped up to match the agent's movement

## Autonomous Actions
- **Walking Around**: Patrol a fixed route (`PATROL_POINTS`) or wander around its post
- **Greeting Players**: Wave at players who arrive, walking over first when they are 4 to 20 m away. In a world that was empty the first greeting can take up to two minutes (the loop only re-checks for players every 60-120 seconds)
- **Approaching Players**: Walk towards nearby players
- **Item Usage**: Interact with objects in the world. Items are made by the world's app scripts, which the agent runs only with `HYPERFY_WORLD_SCRIPTS=sandboxed` (see [World App Scripts](world-scripts.md))
- **Conversation**: Text chat and voice conversations. The world cuts chat messages at 500 characters, so longer replies are posted as up to four messages; text beyond that ends with an ellipsis

## Changes from the Original (eliza-3d-hyperfy-starter)

1. **Cost Optimization**: Scripted idle behavior with a limited Claude budget for autonomous actions, nothing when no players are present, separate limits for Claude, vision and voice, and hourly usage reports
2. **Claude via the Official SDK**: Text, JSON and image description with current Claude models
3. **ElevenLabs Voice**: Speech output and voice input
4. **Audio Format Conversion**: Proper MP3 to PCM conversion (using ffmpeg)
5. **Talking Gesture**: TALK animation playback during voice output
6. **Improved Player Detection**: Accurate player counting via entity iteration
7. **PostgreSQL or PGLite**: Local PostgreSQL database usage; elizaOS's embedded PGLite also boots (see [Database](setup.md#database))
8. **OpenPay Store Shop Clerk**: Product recommendations and purchase links
9. **coo-world Compatibility**: Current network protocol, authenticated uploads, the world's walking clips, chat split to the world's length limit
10. **Lean, Pinned Dependencies**: Unused integrations removed and `bun.lock` committed, which is what pins the versions (`bun audit` to check; see [Dependency Advisories](development.md#dependency-advisories))
11. **Tips**: Coo can receive coo-world tips (JPYC) with its own wallet and thanks the tippers
12. **Authorization**: Scene edits only for players the world lets build, an enforced list of what autonomous steps may do, and only the world server's chat counts as conversation (see [Who Can Ask for What](authorization.md))
13. **One Outbound Policy, Offline Renderer**: Everything a world, a script or an import makes the agent download is limited to public https hosts and the world's own origin, with size caps and deadlines; Chromium has no network and gets none of the agent's keys (see [What the Agent Downloads](downloads.md))
