import {
  type Action,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
  logger,
  composePromptFromState,
  ModelType
} from '@elizaos/core';
import { actingSession, connectedSession } from '../service';
import { TurnCancelled } from '../lib/turn-context';
import { AiBudgetExceededError, forPurpose } from '../../usage-budget';
import { AnthropicRefusalError } from '../../anthropic-models';
import { AgentActions, type PerformActionOutcome } from '../systems/actions';
import { AgentControls } from '../systems/controls';
import { actionFailed, actionSucceeded, tellFailure } from '../lib/action-result';
import { shownName } from '../lib/text';
import { notArrivedText } from '../lib/move-outcome';
import type { MoveOutcome } from '../systems/controls';

const USE_ITEM = 'HYPERFY_USE_ITEM';
// An entity id in a reply (chosen by the model or a caller): one short line, nothing invisible
const ENTITY_ID_MAX = 64;

// What the player is told when the agent reached the item but nothing was used
const USE_FAILURE_TEXT: Record<Exclude<PerformActionOutcome, 'started'>, string> = {
  busy: "I'm already using something else.",
  'no-action-nodes': "There's nothing near me I can use.",
  'entity-has-no-action-node': "I can't use that one.",
};

// Template to extract entity to interact with
const useItemTemplate = `
# Task: Decide if the agent should interact with an entity (e.g. pick up or activate) based on recent context.
# DO NOT assume the last message has a command. Look at overall context.
# ONLY return entity IDs that exist in the Hyperfy World State.

{{providers}}

# Instructions:
Decide if the agent should use/interact with a specific entity based on the conversation and world state.

Response format:
\`\`\`json
{
  "entityId": "<string>" // or null if none
}
\`\`\`
`;

export const hyperfyUseItemAction: Action = {
  name: USE_ITEM,
  similes: ['INTERACT_WITH_ITEM', 'USE_NEARBY_OBJECT', 'PICK_UP_ITEM'],
  description: 'Walks to and interacts with a nearby usable item (like picking it up); use when a player asks you to use or grab something.',
  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    const world = connectedSession(runtime)?.world;
    return !!world?.controls && !!world?.actions;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State,
    _options: unknown,
    callback: HandlerCallback
  ) => {
    // The turn's own connection (never a newer one); throws when the turn may no longer act
    const session = actingSession(runtime);
    const world = session?.world;
    const controls = world?.controls as AgentControls | undefined;
    const actions = world?.actions as AgentActions | undefined;

    if (!session || !world || !actions || !controls) {
      logger.error('Hyperfy service, world, or actions not found for HYPERFY_USE_ITEM action.');
      await tellFailure(callback, USE_ITEM, "Error: Cannot use item. Agent action system unavailable.");
      return actionFailed(USE_ITEM, 'agent action system unavailable');
    }

    // Which item: asked of the model (core hands an action nothing that names one)
    let targetEntityId: string | undefined;
    try {
      const useState = await runtime.composeState(message, ['HYPERFY_WORLD_STATE', 'RECENT_MESSAGES'], true);
      const prompt = composePromptFromState({ state: useState, template: useItemTemplate });
      const response = await runtime.useModel(ModelType.OBJECT_SMALL, forPurpose('use-item', { prompt }));

      if (response?.entityId && typeof response.entityId === 'string') {
        targetEntityId = response.entityId;
        logger.info(`[USE ITEM] Extracted entity ID: ${targetEntityId}`);
      } else {
        logger.warn('[USE ITEM] No valid entityId extracted.');
      }
    } catch (err) {
      // The turn's caller handles these (scripted or offline fallback, a fixed decline)
      if (err instanceof AiBudgetExceededError || err instanceof AnthropicRefusalError) throw err;
      logger.error('[USE ITEM] Extraction failed:', err);
    }

    if (!targetEntityId) {
      logger.warn('[USE ITEM] No suitable item found to use based on the context.');
      await tellFailure(callback, USE_ITEM, "I couldn't tell which item you mean.");
      return actionFailed(USE_ITEM, 'no suitable item found');
    }

    
    const entity = world.entities?.items?.get(targetEntityId);
    const targetPosition = entity?.root?.position
    if (!targetPosition) {
      await tellFailure(callback, USE_ITEM, `Could not locate entity ${shownName(String(targetEntityId), ENTITY_ID_MAX)}.`, { metadata: { error: 'entity_not_found' } });
      return actionFailed(USE_ITEM, 'entity not found', { targetEntityId });
    }

    // How the walk ended, and what using the item did (only once the agent is next to it)
    let done: { walked: Exclude<MoveOutcome, 'arrived'> } | { walked: 'arrived'; outcome: PerformActionOutcome };
    try {
      // The walk and the use are one section: nothing else moves the avatar in between
      done = await session.withBody(async (signal) => {
        const walked = await controls.goto(targetPosition.x, targetPosition.z, { signal });
        session.assertLive();
        // A walk that was stopped or replaced, or never got there, uses nothing
        if (walked !== 'arrived') return { walked };
        logger.info(`[USE ITEM] Attempting to use item with entity ID: ${targetEntityId}`);
        return { walked, outcome: actions.performAction(targetEntityId) };
      });
    } catch (error: any) {
      if (error instanceof TurnCancelled) throw error;
      logger.error('[USE ITEM] Walking to or using the item failed:', error);
      await tellFailure(callback, USE_ITEM, "I couldn't get to that item.");
      return actionFailed(USE_ITEM, `could not reach or use the item: ${error?.message ?? error}`, { targetEntityId });
    }
    if (done.walked !== 'arrived') {
      logger.warn(`[USE ITEM] Did not get to ${targetEntityId} (${done.walked}); nothing was used.`);
      await tellFailure(callback, USE_ITEM, notArrivedText(done.walked), { metadata: { error: 'not_arrived', outcome: done.walked } });
      return actionFailed(USE_ITEM, `did not get to the item (${done.walked})`, { targetEntityId, outcome: done.walked });
    }
    const { outcome } = done;
    if (outcome !== 'started') {
      logger.warn(`[USE ITEM] Nothing to use on ${targetEntityId} (${outcome}).`);
      await tellFailure(callback, USE_ITEM, USE_FAILURE_TEXT[outcome]);
      return actionFailed(USE_ITEM, `nothing was used (${outcome})`, { targetEntityId, outcome });
    }

    await callback({
      text: `Using item: ${shownName(String(targetEntityId), ENTITY_ID_MAX)}`,
      actions: [USE_ITEM],
      source: 'hyperfy',
      metadata: { targetEntityId, status: 'triggered' }
    });
    return actionSucceeded(USE_ITEM, { targetEntityId });
  },
  examples: [
    [
      { name: '{{name1}}', content: { text: 'Pick up the book.' } },
      { name: '{{name2}}', content: { text: 'Using item: book123', actions: ['HYPERFY_USE_ITEM'], source: 'hyperfy' } }
    ],
    [
      { name: '{{name1}}', content: { text: 'Interact with the glowing orb.' } },
      { name: '{{name2}}', content: { text: 'Using item: orb888', actions: ['HYPERFY_USE_ITEM'], source: 'hyperfy' } }
    ],
    [
      { name: '{{name1}}', content: { text: 'Do we need to pick something up?' } },
      { name: '{{name2}}', content: { text: 'No suitable item found to use based on the context.' } }
    ]
  ]
};
