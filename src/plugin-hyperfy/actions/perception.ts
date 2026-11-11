import {
  type Action,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
  logger,
  parseKeyValueXml,
  composePromptFromState,
  ModelType
} from '@elizaos/core';

import { HyperfyService } from '../service';
import { AiBudgetExceededError, forPurpose, getUsageBudget } from '../../usage-budget';
import { chooseSnapshot, type NamedEntity } from '../lib/snapshot-choice';
import { isJapanese } from '../lib/simple-commands';
import { actionFailed, actionSucceeded } from '../lib/action-result';
import { readString } from '../lib/model-output';

const SCENE_PERCEPTION = 'HYPERFY_SCENE_PERCEPTION';

export enum SnapshotType {
  LOOK_AROUND     = 'LOOK_AROUND',
  LOOK_DIRECTION  = 'LOOK_DIRECTION',
  LOOK_AT_ENTITY  = 'LOOK_AT_ENTITY'
}

const responseGenerationTemplate = (viewHeader: string) => `
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
${viewHeader}


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
    const service = runtime.getService<HyperfyService>(HyperfyService.serviceType);
    return !!service && service.isConnected() && !!service.getWorld();
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
    _options: {},
    callback: HandlerCallback
  ) => {
    const service = runtime.getService<HyperfyService>(HyperfyService.serviceType);
    const world = service?.getWorld();
    const puppeteerManager = service?.getPuppeteerManager();

    if (!service || !world || !puppeteerManager) {
      logger.error('Hyperfy service/world unavailable.');
      await callback({ text: 'Unable to observe environment. Hyperfy world not available.' });
      return actionFailed(SCENE_PERCEPTION, 'Hyperfy world not available');
    }

    const text = message.content?.text ?? '';
    const japanese = isJapanese(text);
    const budget = getUsageBudget();
    if (!budget.visionAvailable() || !budget.aiAvailable()) {
      budget.recordSkip('vision');
      await callback({
        thought: 'The vision budget is used up for now.',
        text: japanese
          ? 'ごめんなさい、今はちょっと目を休めています。また少ししてから声をかけてくださいね。'
          : "Sorry, I'm resting my eyes for a bit. Ask me again a little later!",
        metadata: { error: 'vision_budget' },
      });
      return actionFailed(SCENE_PERCEPTION, 'vision budget used up');
    }

    world.controls?.stopAllActions();

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
      switch (choice.type) {
        case 'LOOK_AROUND':
          imgBase64 = await puppeteerManager.snapshotEquirectangular();
          break;
        case 'LOOK_DIRECTION':
          imgBase64 = await puppeteerManager.snapshotFacingDirection(choice.direction);
          break;
        case 'LOOK_AT_ENTITY': {
          const ent = world.entities.items.get(choice.entityId);
          const pos = ent?.base?.position || ent?.root?.position;
          if (!pos) throw new Error('No position');
          await world.controls.followEntity(choice.entityId);
          imgBase64 = await puppeteerManager.snapshotViewToTarget([pos.x, pos.y, pos.z]);
          break;
        }
      }
    } catch (err) {
      logger.error('Snapshot failed:', err);
      await callback({ thought: 'Snapshot failed.', metadata: { error: 'snapshot_failure', snapshotType } });
      return actionFailed(SCENE_PERCEPTION, 'snapshot failed', { snapshotType });
    }

    let viewHeader: string;
    switch (choice.type) {
      case 'LOOK_AROUND':
        viewHeader = `It is a 360° (equirectangular) view all around {{agentName}}'s current position.`;
        break;
      case 'LOOK_DIRECTION':
        viewHeader = `It shows the view toward {{agentName}}'s **${choice.direction}** side.`;
        break;
      case 'LOOK_AT_ENTITY': {
        const name = entities.find((e) => e.id === choice.entityId)?.name ?? choice.entityId;
        viewHeader = `It is focused on “${name}” (entity ${choice.entityId}).`;
        break;
      }
    }

    /* One multimodal call: look at the snapshot and answer in character */
    state = await runtime.composeState(message);
    const responsePrompt = composePromptFromState({ state, template: responseGenerationTemplate(viewHeader) });
    budget.recordVision();
    let xmlRaw: string;
    try {
      const res = await runtime.useModel(ModelType.IMAGE_DESCRIPTION, forPurpose('vision', { imageUrl: imgBase64, prompt: responsePrompt }));
      xmlRaw = typeof res === 'string' ? res : res.description;
    } catch (err) {
      if (err instanceof AiBudgetExceededError) {
        await callback({
          thought: 'The Claude budget is used up for now.',
          text: japanese ? 'ごめんなさい、今はよく見られないみたいです。' : "Sorry, I can't take a proper look right now.",
          metadata: { error: 'ai_budget' },
        });
        return actionFailed(SCENE_PERCEPTION, 'AI budget used up', { snapshotType });
      }
      logger.error('Vision response failed:', err);
      await callback({ thought: 'Cannot understand the scene.', metadata: { error: 'vision_failure' } });
      return actionFailed(SCENE_PERCEPTION, 'vision model failed', { snapshotType });
    }

    const parsed = parseKeyValueXml(xmlRaw);

    if (!parsed) {
      await callback({ thought: 'Malformed XML.', metadata: { error: 'xml_parse_failure', xmlRaw } });
      return actionFailed(SCENE_PERCEPTION, 'could not parse the vision reply', { snapshotType });
    }

    await callback({
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
