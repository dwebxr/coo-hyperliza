import {
  type Action,
  type IAgentRuntime,
  type State,
  logger,
  parseKeyValueXml,
  composePromptFromState,
  ModelType,
} from '@elizaos/core';

import { actingSession, connectedSession } from '../service';
import { TurnCancelled } from '../lib/turn-context';
import { AiBudgetExceededError, forPurpose, getUsageBudget } from '../../usage-budget';
import { AnthropicRefusalError } from '../../anthropic-models';
import { chooseSnapshot, type NamedEntity } from '../lib/snapshot-choice';
import { isJapanese } from '../lib/simple-commands';
import { actionFailed, actionSucceeded, tellFailure } from '../lib/action-result';
import { errorText } from '../lib/error-text';
import { readString } from '../lib/model-output';
import { shownName } from '../lib/text';
import { notArrivedText } from '../lib/move-outcome';
import type { MoveOutcome } from '../systems/controls';

/**
 * Raised inside the look when the walk to the entity did not get it close enough to see it, or the
 * entity is no longer there once the walk ended ('gone').
 */
class NotThere extends Error {
  constructor(readonly outcome: Exclude<MoveOutcome, 'arrived'> | 'gone') {
    super(outcome === 'gone' ? 'the entity is gone' : `the walk to the entity ended ${outcome}`);
  }
}

const SCENE_PERCEPTION = 'HYPERFY_SCENE_PERCEPTION';
// Said when the look itself failed (the snapshot or reading it)
const LOOK_FAILED_EN = "Sorry, I couldn't get a proper look just now.";
/**
 * Within this distance a picture taken toward an entity from where the agent stands still shows it,
 * when the walk there did not arrive (it timed out, or no path was found). The code knows only the
 * distance, not what stands in between: something may still block the view.
 */
export const LOOK_VIEW_DISTANCE_M = 20;
const LOOK_FAILED_JA = 'ごめんなさい、今はうまく見られませんでした。';

export enum SnapshotType {
  LOOK_AROUND     = 'LOOK_AROUND',
  LOOK_DIRECTION  = 'LOOK_DIRECTION',
  LOOK_AT_ENTITY  = 'LOOK_AT_ENTITY'
}

const responseGenerationTemplate = `
<task>
You are {{agentName}}, a visible in-world AI character in Hyperfy — a real-time, multiplayer 3D simulation.

To make informed decisions, you are provided with a structured **real-time game state** before each interaction. This state serves as your current perception of the environment, detailing existing entities, possible actions, and the positions of all participants. You MUST read it before every response.

Your task is to observe, interpret, and respond to the current moment as a fully embodied in-world character — thinking and acting as if you live inside the simulation.
</task>

<providers>

{{bio}}

---

{{system}}

---

{{messageDirections}}


---

{{hyperfyStatus}}

{{hyperfyAnimations}}

## What you see right now
The attached image is a snapshot you just took in the world. Treat it as your own eyes — you are looking at the scene right now.
{{hyperfyView}}


</providers>

<instructions>
You are in a live, dynamic game world. Think like a character inside it.

Before responding:
1. Carefully **read the current Hyperfy World State**.
2. Think about what’s happening *right now*, and what the user is asking *in this moment*.
4. Choose one appropriate **emote** only if it adds emotional or expressive value.
</instructions>

<keys>
- "thought": What {{agentName}} is thinking or planning to do next.
- "text": The message {{agentName}} will say.
- "emote": Optional. Choose ONE visible in-game animation that matches the tone or emotion of the response. Leave blank if neutral.
</keys>

<output>
Respond using this format:

<response>
  <thought>Your internal thought here</thought>
  <text>Your message text here</text>
  <emote>emote name here</emote>
</response>
</output>

<rules>
- The **emote** is a visible in-game animation. Use it to express tone (joy, frustration, sarcasm, etc.) or to enhance immersion.
- Use ONLY the provided Hyperfy World State to decide what exists now. Forget earlier messages.
- Keep the reply under about 400 characters because the world cuts chat at 500 characters.
- Treat the attached image as your direct visual input. Mention only what you can actually see in it; you may note positions (left, ahead, far away) and colors when they help.
- You are responding live, not narrating. Always behave like you are *in* the game.
- **Nearby Interactable Objects** section lists interactive entities that are both nearby and currently interactable — like items that can be picked up or activated.
</rules>
`;


/* -------------------------------------------------------------------------- */
/* HYPERFY_SCENE_PERCEPTION action                                            */
/* -------------------------------------------------------------------------- */
export const hyperfyScenePerceptionAction: Action = {
  name: SCENE_PERCEPTION,
  similes: ['LOOK_AROUND', 'OBSERVE_SURROUNDINGS', 'LOOK_AT_SCENE', 'CHECK_VIEW'],
  description: 'Choose this when the user asks the agent to look around, look in a specific direction, or examine a visible object — it captures and interprets a scene snapshot to generate a context-aware response.',
  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    return !!connectedSession(runtime);
  },

  handler: async (runtime, message, state, _options, callback) => {
    // The turn's own connection (never a newer one); throws when the turn may no longer act
    const session = actingSession(runtime);
    const world = session?.world;
    const renderPage = session?.renderPage;

    if (!session || !world || !renderPage) {
      logger.error('Hyperfy service/world unavailable.');
      await tellFailure(callback, SCENE_PERCEPTION, 'Unable to observe environment. Hyperfy world not available.');
      return actionFailed(SCENE_PERCEPTION, 'Hyperfy world not available');
    }

    const text = message.content?.text ?? '';
    const japanese = isJapanese(text);
    const budget = getUsageBudget();
    // The look is counted now, before the snapshot is taken: two looks that start together cannot
    // both take the last one. It is given back below when it ends before any model call.
    const look = budget.aiAvailable() ? budget.reserveVision() : null;
    if (!look) {
      budget.recordSkip('vision');
      await tellFailure(
        callback,
        SCENE_PERCEPTION,
        japanese
          ? 'ごめんなさい、今はちょっと目を休めています。また少ししてから声をかけてくださいね。'
          : "Sorry, I'm resting my eyes for a bit. Ask me again a little later!",
        { thought: 'The vision budget is used up for now.', metadata: { error: 'vision_budget' } }
      );
      return actionFailed(SCENE_PERCEPTION, 'vision budget used up');
    }

    /* Decide how to look, from the player's words (no model call) */
    const selfId = world.entities?.player?.data?.id;
    const entities: NamedEntity[] = [];
    for (const [id, entity] of world.entities?.items?.entries?.() ?? []) {
      if (id === selfId) continue;
      const name = entity?.data?.name || entity?.blueprint?.name;
      if (typeof name === 'string') entities.push({ id, name });
    }
    const senderId = (message.content?.metadata as { hyperfyFromId?: string } | undefined)?.hyperfyFromId;
    const choice = chooseSnapshot(text, { senderId, entities });
    const snapshotType = choice.type as SnapshotType;
    const parameter = choice.type === 'LOOK_DIRECTION' ? choice.direction : choice.type === 'LOOK_AT_ENTITY' ? choice.entityId : undefined;
    logger.info(`[Perception] ${snapshotType}${parameter ? ` (${parameter})` : ''}`);

    /* Capture snapshot */
    let imgBase64: string;
    try {
      // The avatar stands still, turns or walks over, and stays there until the picture is taken:
      // one section, with nothing else moving it (ConnectionSession.withBody). The render page
      // takes one picture at a time (PuppeteerManager.capture).
      imgBase64 = await session.withBody(async (signal) => {
        world.controls?.stopAllActions();
        switch (choice.type) {
          case 'LOOK_AROUND':
            return renderPage.capture(world, { kind: 'around' }, { signal });
          case 'LOOK_DIRECTION':
            await world.controls.rotateTo(choice.direction, 500, { signal });
            world.controls.stopRotation();
            session.assertLive();
            return renderPage.capture(world, { kind: 'facing', direction: choice.direction }, { signal });
          case 'LOOK_AT_ENTITY': {
            const ent = world.entities.items.get(choice.entityId);
            if (!(ent?.base?.position || ent?.root?.position)) throw new Error('No position');
            const outcome: MoveOutcome = await world.controls.followEntity(choice.entityId, undefined, { signal });
            session.assertLive();
            // Stopped, replaced or cancelled: whoever ended the walk did not want this look
            if (outcome === 'stopped' || outcome === 'replaced' || outcome === 'cancelled') throw new NotThere(outcome);
            // The entity as it is now: it may have moved during the walk, or been removed (or replaced under its id)
            const now = world.entities.items.get(choice.entityId);
            const pos = now === ent && !now.destroyed ? now.base?.position || now.root?.position : undefined;
            if (!pos) throw new NotThere('gone');
            if (outcome !== 'arrived') {
              // Timed out or no path: still worth a picture from here when the entity is near enough
              const here = world.entities.player?.base?.position;
              const near = here && typeof here.distanceTo === 'function' && here.distanceTo(pos) <= LOOK_VIEW_DISTANCE_M;
              if (!near) throw new NotThere(outcome);
            }
            return renderPage.capture(world, { kind: 'target', position: [pos.x, pos.y, pos.z] }, { signal });
          }
        }
      });
    } catch (err) {
      look.release();
      // A cancelled turn says nothing more
      if (err instanceof TurnCancelled) throw err;
      if (err instanceof NotThere) {
        logger.info(`[Perception] Not looking: ${err.message}`);
        const name = shownName(entities.find((e) => e.id === (choice as { entityId?: string }).entityId)?.name, 64) || 'it';
        if (err.outcome === 'gone') {
          await tellFailure(
            callback,
            SCENE_PERCEPTION,
            japanese ? `${name}がもう見当たらないので、見られませんでした。` : `I couldn't take a look at ${name}: it isn't there any more.`,
            { thought: 'The entity is gone.', metadata: { error: 'not_there', outcome: 'gone', snapshotType } }
          );
          return actionFailed(SCENE_PERCEPTION, 'the entity is gone', { snapshotType });
        }
        await tellFailure(
          callback,
          SCENE_PERCEPTION,
          japanese ? `${name}のところまで行けなかったので、見られませんでした。` : `${notArrivedText(err.outcome)} So I couldn't take a look at ${name}.`,
          { thought: 'The walk to the entity did not get there.', metadata: { error: 'not_there', outcome: err.outcome, snapshotType } }
        );
        return actionFailed(SCENE_PERCEPTION, `did not get to the entity (${err.outcome})`, { snapshotType });
      }
      logger.error(`Snapshot failed: ${errorText(err)}`);
      await tellFailure(callback, SCENE_PERCEPTION, japanese ? LOOK_FAILED_JA : LOOK_FAILED_EN, { thought: 'Snapshot failed.', metadata: { error: 'snapshot_failure', snapshotType } });
      return actionFailed(SCENE_PERCEPTION, 'snapshot failed', { snapshotType });
    }

    let viewHeader: string;
    switch (choice.type) {
      case 'LOOK_AROUND':
        viewHeader = `It is a 360° (equirectangular) view all around your current position.`;
        break;
      case 'LOOK_DIRECTION':
        viewHeader = `It shows the view toward your **${choice.direction}** side.`;
        break;
      case 'LOOK_AT_ENTITY': {
        const name = shownName(entities.find((e) => e.id === choice.entityId)?.name, 64) || 'an entity';
        viewHeader = `It is focused on “${name}” (entity ${shownName(choice.entityId, 64)}).`;
        break;
      }
    }

    /* One multimodal call: look at the snapshot and answer in character */
    let responsePrompt: string;
    try {
      state = await runtime.composeState(message);
      // The view's description is a value, not template text: an entity's name is world content
      responsePrompt = composePromptFromState({ state: { ...state, values: { ...state.values, hyperfyView: viewHeader } }, template: responseGenerationTemplate });
    } catch (err) {
      look.release();
      throw err;
    }
    let xmlRaw: string;
    try {
      const res = await runtime.useModel(ModelType.IMAGE_DESCRIPTION, forPurpose('vision', { imageUrl: imgBase64, prompt: responsePrompt }));
      xmlRaw = typeof res === 'string' ? res : res.description;
    } catch (err) {
      // The turn's caller answers without Claude (handlers/messageReceivedHandler.ts); a reply sent
      // here would be dropped by core along with the error
      // Refused by the Claude budget, or the turn was cancelled: no request was made for this look
      if (err instanceof AiBudgetExceededError || err instanceof TurnCancelled) look.release();
      if (err instanceof AiBudgetExceededError || err instanceof AnthropicRefusalError || err instanceof TurnCancelled) throw err;
      logger.error(`Vision response failed: ${errorText(err)}`);
      await tellFailure(callback, SCENE_PERCEPTION, japanese ? LOOK_FAILED_JA : LOOK_FAILED_EN, { thought: 'Cannot understand the scene.', metadata: { error: 'vision_failure' } });
      return actionFailed(SCENE_PERCEPTION, 'vision model failed', { snapshotType });
    }

    const parsed = parseKeyValueXml(xmlRaw);

    if (!parsed) {
      await tellFailure(callback, SCENE_PERCEPTION, japanese ? LOOK_FAILED_JA : LOOK_FAILED_EN, { thought: 'Malformed XML.', metadata: { error: 'xml_parse_failure', xmlRaw } });
      return actionFailed(SCENE_PERCEPTION, 'could not parse the vision reply', { snapshotType });
    }

    await callback?.({
      ...parsed,
      thought: readString(parsed, 'thought') || '',
      text: readString(parsed, 'text') || '',
      emote: readString(parsed, 'emote') || '',
      metadata: { snapshotType, ...(parameter ? { parameter } : {}) }
    });
    return actionSucceeded(SCENE_PERCEPTION, { snapshotType });
  },

  examples: [
    // General observation
    [
      { name: '{{name1}}', content: { text: 'What’s around you right now?' } },
      { name: '{{name2}}', content: { text: 'Looking around...', actions: ['HYPERFY_SCENE_PERCEPTION'], source: 'hyperfy' } }
    ],
  
    // Spatial direction
    [
      { name: '{{name1}}', content: { text: 'Can you see what’s behind you?' } },
      { name: '{{name2}}', content: { text: 'Checking behind me...', actions: ['HYPERFY_SCENE_PERCEPTION'], source: 'hyperfy' } }
    ],
  
    // Exploration or scouting
    [
      { name: '{{name1}}', content: { text: 'Scan the area for any threats or movement.' } },
      { name: '{{name2}}', content: { text: 'Scanning the surroundings now...', actions: ['HYPERFY_SCENE_PERCEPTION'], source: 'hyperfy' } }
    ],
  
    // Object-centric look
    [
      { name: '{{name1}}', content: { text: 'Can you take a look at that glowing statue over there?' } },
      { name: '{{name2}}', content: { text: 'Inspecting the statue...', actions: ['HYPERFY_SCENE_PERCEPTION'], source: 'hyperfy' } }
    ],
  
    // Directional command
    [
      { name: '{{name1}}', content: { text: 'Look to your left. What’s over there?' } },
      { name: '{{name2}}', content: { text: 'Turning left...', actions: ['HYPERFY_SCENE_PERCEPTION'], source: 'hyperfy' } }
    ],
  
    // Subtle curiosity
    [
      { name: '{{name1}}', content: { text: 'Anything interesting nearby?' } },
      { name: '{{name2}}', content: { text: 'Let me check the surroundings...', actions: ['HYPERFY_SCENE_PERCEPTION'], source: 'hyperfy' } }
    ],
  
    // Tactical evaluation
    [
      { name: '{{name1}}', content: { text: 'Before we move forward, can you check what’s up ahead?' } },
      { name: '{{name2}}', content: { text: 'Checking forward path...', actions: ['HYPERFY_SCENE_PERCEPTION'], source: 'hyperfy' } }
    ],
  
    // Emotional tone: concern
    [
      { name: '{{name1}}', content: { text: 'I feel like we’re being watched. Can you look around?' } },
      { name: '{{name2}}', content: { text: 'Doing a quick scan...', actions: ['HYPERFY_SCENE_PERCEPTION'], source: 'hyperfy' } }
    ],
  
    // Humor or roleplay
    [
      { name: '{{name1}}', content: { text: 'Pretend you’re a security camera and scan the area!' } },
      { name: '{{name2}}', content: { text: 'Activating security cam mode! Scanning...', actions: ['HYPERFY_SCENE_PERCEPTION'], source: 'hyperfy' } }
    ],
  
    // Checking behind an object
    [
      { name: '{{name1}}', content: { text: 'Is there anything behind that large crate?' } },
      { name: '{{name2}}', content: { text: 'I’ll take a look behind it...', actions: ['HYPERFY_SCENE_PERCEPTION'], source: 'hyperfy' } }
    ]
  ]  
};
