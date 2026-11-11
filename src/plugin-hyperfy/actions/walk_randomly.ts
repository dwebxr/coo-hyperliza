import {
    logger,
    type Action,
    type HandlerCallback,
    type IAgentRuntime,
    type Memory,
    type State
} from '@elizaos/core';
// No longer need THREE here
import { AgentControls } from '../systems/controls'; // Still need type for casting
import { actingSession, connectedSession } from '../service';
import { actionFailed, actionSucceeded, tellFailure } from '../lib/action-result';

const WALK_RANDOMLY = 'HYPERFY_WALK_RANDOMLY';

const RANDOM_WALK_INTERVAL_MS = 4000;
const RANDOM_WALK_MAX_DISTANCE = 30; // meters

export const hyperfyWalkRandomlyAction: Action = {
    name: WALK_RANDOMLY,
    similes: ['WANDER', 'PACE_AROUND', 'WALK_AROUND', 'MOVE_RANDOMLY'], // Reverted similes/desc
    description: 'Makes your character wander to random points nearby; use for idle behavior or ambient movement.',
    validate: async (runtime: IAgentRuntime): Promise<boolean> => {
      return !!connectedSession(runtime)?.world?.controls;
    },
    handler: async (
      runtime: IAgentRuntime,
      _message: Memory,
      _state: State,
      // elizaOS core passes its own bookkeeping here (actionContext, actionPlan), nothing of this action's
      _options: unknown,
      callback: HandlerCallback,
    ) => {
      // The turn's own connection (never a newer one); throws when the turn may no longer act
      const session = actingSession(runtime);
      const world = session?.world;
      const controls = world?.controls as AgentControls | undefined;

      if (!session || !world || !controls) {
        logger.error('Hyperfy service, world, or controls not found for HYPERFY_WALK_RANDOMLY action.');
        await tellFailure(callback, WALK_RANDOMLY, "Error: Cannot wander. Hyperfy connection/controls unavailable.");
        return actionFailed(WALK_RANDOMLY, 'Hyperfy connection/controls unavailable');
      }

      if (typeof controls.startRandomWalk !== 'function') {
        logger.error('AgentControls missing startRandomWalk.');
        await tellFailure(callback, WALK_RANDOMLY, "Error: Wander functionality not available in controls.");
        return actionFailed(WALK_RANDOMLY, 'wander functionality not available in controls');
      }

      // Started in its turn among the sections that move the avatar, then left running: it
      // goes on after this turn completes, and stops when the turn is cancelled, when another
      // walk starts, on a stop (HYPERFY_STOP_MOVING), or with the connection
      await session.withBody(async (signal) => {
        controls.startRandomWalk(RANDOM_WALK_INTERVAL_MS, RANDOM_WALK_MAX_DISTANCE, undefined, { signal });
      });

      await callback({
        text: ``,
        actions: [WALK_RANDOMLY],
        source: 'hyperfy',
        metadata: { status: 'started', intervalMs: RANDOM_WALK_INTERVAL_MS, maxDistance: RANDOM_WALK_MAX_DISTANCE }
      });
      return actionSucceeded(WALK_RANDOMLY, { status: 'started' });
    },
     examples: [
        [
          { name: '{{name1}}', content: { text: 'Wander around for a bit.' } },
          { name: '{{name2}}', content: { text: 'Starting to wander randomly... (New target every ~5.0s)', actions: ['HYPERFY_WALK_RANDOMLY'], source: 'hyperfy' } }
        ],
         [
          { name: '{{name1}}', content: { text: 'Just pace around here.' } },
          { name: '{{name2}}', content: { text: 'Starting to wander randomly... (New target every ~5.0s)', actions: ['HYPERFY_WALK_RANDOMLY'], source: 'hyperfy' } }
        ]
       ]
}; 