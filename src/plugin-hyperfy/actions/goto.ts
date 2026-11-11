import {
  type Action,
  composePromptFromState,
  ModelType,
  type IAgentRuntime,
  type State,
  logger,
} from '@elizaos/core';
import { actingSession, connectedSession } from '../service';
import { AiBudgetExceededError, forPurpose } from '../../usage-budget';
import { AnthropicRefusalError } from '../../anthropic-models';
import { AgentControls, WORLD_COORDINATE_LIMIT } from '../systems/controls';
import { notArrivedText } from '../lib/move-outcome';
import { actionFailed, actionSucceeded, tellFailure } from '../lib/action-result';
import { errorText } from '../lib/error-text';
import { oneLine, shownName } from '../lib/text';
import { TurnCancelled } from '../lib/turn-context';

const GOTO_ENTITY = 'HYPERFY_GOTO_ENTITY';
// What a reply says of a world name or an id, as the world state shows other entities' names
const ENTITY_NAME_MAX = 64;
// What a failure reply says of an error
const ERROR_TEXT_MAX = 200;

export enum NavigationType {
  ENTITY = 'entity',
  POSITION = 'position',
}

// The agent's thought enters through a state value ({{navigationThought}}), never as template
// text: it is model output, which can quote a player and contain anything, braces included
const MAX_THOUGHT_CODE_POINTS = 500;

const navigationTargetExtractionTemplate = `
# Task:
Decide whether the agent should navigate to a specific **Entity** or a direct **Position** in the Hyperfy world.

# Navigation Types:
- "entity": Navigate to a known entity by its ID.
- "position": Navigate to a specific X,Z coordinate (e.g., from user input like "go to the fountain at 5, 10").

# Constraints:
- Only use **Entity IDs** listed in the current world state.
- Positions must be 2D coordinates in the format { "x": <number>, "z": <number> }.
- Never invent or assume entities that are not in the world state.
- Use "position" only if a direct coordinate is clearly specified or derivable.

# Agent Thought:
{{navigationThought}}

# World State:
{{hyperfyStatus}}

# Instructions:
You are **{{agentName}}**, a virtual agent in a Hyperfy world. Analyze the conversation and determine the most appropriate navigation type and target.

Return your answer as a JSON object in **one** of the following forms:

\`\`\`json
{
  "navigationType": "${NavigationType.ENTITY}",
  "parameter": { "entityId": "<string>" }
}
\`\`\`

or

\`\`\`json
{
  "navigationType": "${NavigationType.POSITION}",
  "parameter": { "position": { "x": 5, "z": 10 } }
}
\`\`\`

Only return the JSON object. Do not include any extra text or comments.
`.trim();



export const hyperfyGotoEntityAction: Action = {
    name: GOTO_ENTITY,
    similes: ['GO_TO_ENTITY_IN_WORLD', 'MOVE_TO_ENTITY', 'NAVIGATE_TO_ENTITY'],
    description: 'Moves your character to a specified player, object, or world position; use when you need to approach something or go somewhere before interacting.',
    validate: async (runtime: IAgentRuntime): Promise<boolean> => {
      return !!connectedSession(runtime)?.world?.controls;
    },
    handler: async (runtime, message, _state, _options, callback, responses) => {
      const thoughtSnippets = oneLine(
        responses
          ?.map((res) => res.content?.thought)
          .filter((thought): thought is string => typeof thought === 'string' && !!thought)
          .join(' ') ?? '',
        MAX_THOUGHT_CODE_POINTS
      );

      // The turn's own connection (never a newer one); throws when the turn may no longer act
      const session = actingSession(runtime);
      const world = session?.world;
      const controls = world?.controls as AgentControls | undefined; // Get controls and cast type

      if (!session || !world || !controls) {
        logger.error('[GOTO Action] Hyperfy service, world, or controls not found.');
        await tellFailure(callback, GOTO_ENTITY, "I can't move right now.");
        return actionFailed(GOTO_ENTITY, 'Hyperfy connection/controls unavailable');
      }
      
      let navigationResult: any = null;

      try {
        const extractionState = await runtime.composeState(message);
        const prompt = composePromptFromState({
          state: { ...extractionState, values: { ...extractionState.values, navigationThought: thoughtSnippets || 'None' } },
          template: navigationTargetExtractionTemplate,
        });

        navigationResult = await runtime.useModel(ModelType.OBJECT_LARGE, forPurpose('navigation', { prompt }));
        logger.info('[GOTO Action] Navigation target extracted:', navigationResult);
      } catch (error) {
        // The turn's caller handles these (scripted or offline fallback, a fixed decline); a
        // cancelled turn does nothing more
        if (error instanceof AiBudgetExceededError || error instanceof AnthropicRefusalError || error instanceof TurnCancelled) throw error;
        logger.error(`[GOTO Action] Error during navigation target extraction: ${errorText(error)}`);
        await tellFailure(callback, GOTO_ENTITY, 'Action failed: Could not determine a navigation target.', {
          thought: 'Failed to extract navigation target.',
          metadata: { error: 'extraction_failed' },
        });
        return actionFailed(GOTO_ENTITY, 'could not determine a navigation target');
      }

      if (
        !navigationResult ||
        !navigationResult.navigationType ||
        !navigationResult.parameter
      ) {
        await tellFailure(callback, GOTO_ENTITY, 'Action failed: Invalid navigation target.', {
          thought: 'Navigation target missing or malformed.',
          metadata: { error: 'invalid_navigation_target' },
        });
        return actionFailed(GOTO_ENTITY, 'invalid navigation target');
      }

      const { navigationType, parameter } = navigationResult;

      try {
        switch (navigationType) {
          case NavigationType.ENTITY: {
            const entityId = parameter?.entityId;
            if (!entityId) throw new Error('Missing entityId in parameter.');

            logger.info(`Navigating to entity ${entityId}`);
            // One walk at a time, started only for a turn that may still act (withBody). It stops
            // when the turn is cancelled, and then nothing is said and nothing recorded as done
            const outcome = await session.withBody((signal) => controls.followEntity(entityId, undefined, { signal }));
            session.assertLive();
            // Said as it ended: a walk that was stopped, replaced, timed out or had nowhere to go did not arrive
            if (outcome !== 'arrived') {
              await tellFailure(callback, GOTO_ENTITY, notArrivedText(outcome), { metadata: { error: 'not_arrived', outcome } });
              return actionFailed(GOTO_ENTITY, `did not arrive (${outcome})`, { navigationType, entityId, outcome });
            }

            const targetEntity = world.entities.items.get(parameter.entityId);
            // World content (and an id the model chose): one short line, nothing invisible
            const entityName =
              shownName(targetEntity?.data?.name, ENTITY_NAME_MAX) ||
              shownName(targetEntity?.blueprint?.name, ENTITY_NAME_MAX) ||
              `entity ${shownName(String(entityId), ENTITY_NAME_MAX)}`;

            await callback?.({
              text: `Arrived at ${entityName}.`,
              actions: [GOTO_ENTITY],
              source: 'hyperfy',
            });
            return actionSucceeded(GOTO_ENTITY, { navigationType, entityId });
          }

          case NavigationType.POSITION: {
            const pos = parameter?.position;
            // The model's numbers: finite, and within what the world takes as a position
            if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.z) || typeof pos.x !== 'number' || typeof pos.z !== 'number') {
              throw new Error('Invalid position coordinates.');
            }
            const x = Math.max(-WORLD_COORDINATE_LIMIT, Math.min(WORLD_COORDINATE_LIMIT, pos.x));
            const z = Math.max(-WORLD_COORDINATE_LIMIT, Math.min(WORLD_COORDINATE_LIMIT, pos.z));

            logger.info(`Navigating to position (${x}, ${z})`);
            const outcome = await session.withBody((signal) => controls.goto(x, z, { signal }));
            session.assertLive();
            if (outcome !== 'arrived') {
              await tellFailure(callback, GOTO_ENTITY, notArrivedText(outcome), { metadata: { error: 'not_arrived', outcome } });
              return actionFailed(GOTO_ENTITY, `did not arrive (${outcome})`, { navigationType, position: { x, z }, outcome });
            }

            await callback?.({
              text: `Reached position (${x}, ${z}).`,
              actions: [GOTO_ENTITY],
              source: 'hyperfy',
            });
            return actionSucceeded(GOTO_ENTITY, { navigationType, position: { x, z } });
          }

          default:
            throw new Error(`Unsupported navigation type: ${shownName(String(navigationType), ENTITY_NAME_MAX)}`);
        }
      } catch (error: any) {
        if (error instanceof TurnCancelled) throw error;
        logger.error(`[GOTO Action] Navigation failed:`, error);
        await tellFailure(callback, GOTO_ENTITY, `Navigation failed: ${oneLine(String(error?.message ?? error), ERROR_TEXT_MAX)}`, {
          metadata: { error: 'navigation_error', detail: error.message },
        });
        return actionFailed(GOTO_ENTITY, `navigation failed: ${error.message}`);
      }
    },
     examples: [
      // Example assumes an entity "Bob" exists with ID "entity123"
      [
        { name: '{{name1}}', content: { text: 'Go to Bob' } },
        { name: '{{name2}}', content: { text: 'Navigating towards Bob...', actions: ['HYPERFY_GOTO_ENTITY'], source: 'hyperfy' } }
      ],
       [
        { name: '{{name1}}', content: { text: 'Find entity abcdef' } }, // Assuming entity abcdef exists
        { name: '{{name2}}', content: { text: 'Navigating towards entity abcdef...', actions: ['HYPERFY_GOTO_ENTITY'], source: 'hyperfy' } }
      ],
      // Example for failure (entity not found)
      [
        { name: '{{name1}}', content: { text: 'Go to the missing chair' } },
        { name: '{{name2}}', content: { text: 'Error: Cannot navigate. Could not find location for entity chair999.' } } // Assuming ID was chair999
      ],
      [
        { name: '{{name1}}', content: { text: 'Go to the fountain at 12, 8' } },
        { name: '{{name2}}', content: { text: 'Navigating to position (12, 8)...', actions: ['HYPERFY_GOTO_ENTITY'], source: 'hyperfy' } }
      ],
      [
        { name: '{{name1}}', content: { text: 'Walk to coordinate x: 5 z: -3' } },
        { name: '{{name2}}', content: { text: 'Navigating to position (5, -3)...', actions: ['HYPERFY_GOTO_ENTITY'], source: 'hyperfy' } }
      ],
      [
        { name: '{{name1}}', content: { text: 'Move to 0, 0 in the world' } },
        { name: '{{name2}}', content: { text: 'Navigating to position (0, 0)...', actions: ['HYPERFY_GOTO_ENTITY'], source: 'hyperfy' } }
      ]
     ]
  }; 