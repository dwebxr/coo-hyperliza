import {
  type Action,
  type IAgentRuntime,
  logger,
} from '@elizaos/core';
import { actingSession, connectedSession } from '../service';
import { AgentControls } from '../systems/controls'; // Import AgentControls type
import { actionFailed, actionSucceeded, tellFailure } from '../lib/action-result';

const STOP_MOVING = 'HYPERFY_STOP_MOVING';

export const hyperfyStopMovingAction: Action = {
    name: STOP_MOVING,
    similes: ['STOP', 'HALT', 'STOP_WALKING', 'CANCEL_MOVEMENT', 'STOP_PATROLLING'],
    description: 'Instantly stops your current walking or pathing; use to pause movement before speaking or performing another action.',
    validate: async (runtime: IAgentRuntime): Promise<boolean> => {
      return !!connectedSession(runtime)?.world?.controls;
    },
    handler: async (runtime, _message, _state, _options, callback) => {
      // The turn's own connection (never a newer one); throws when the turn may no longer act.
      // Stopping waits for nobody: it ends whatever walk is in progress, whoever started it.
      const controls = actingSession(runtime)?.world?.controls as AgentControls | undefined;

      if (!controls) {
        // Core runs a handler without calling validate() first, so this can happen
        logger.error('Hyperfy service or controls not found for HYPERFY_STOP_MOVING action.');
        await tellFailure(callback, STOP_MOVING, "Error: Cannot stop movement. Hyperfy connection/controls unavailable.");
        return actionFailed(STOP_MOVING, 'Hyperfy connection/controls unavailable');
      }

      // Check for required method
      if (typeof controls.stopAllActions !== 'function') {
           logger.error('AgentControls missing stopAllActions method.');
           await tellFailure(callback, STOP_MOVING, "Error: Stop functionality not available in controls.");
           return actionFailed(STOP_MOVING, 'stop functionality not available in controls');
      }

      const reason = "stop action called";

      try {
        // Call the stop navigation method
        controls.stopAllActions(reason);

        await callback?.({
           text: ``,
           actions: [STOP_MOVING],
           source: 'hyperfy',
           metadata: { status: 'movement_stopped', reason: reason }
        });
        return actionSucceeded(STOP_MOVING);

      } catch (error: any) {
        logger.error(`Error during HYPERFY_STOP_MOVING:`, error);
        await tellFailure(callback, STOP_MOVING, `Error stopping movement: ${error.message}`);
        return actionFailed(STOP_MOVING, `error stopping movement: ${error.message}`);
      }
    },
     examples: [
      [
        { name: '{{name1}}', content: { text: 'Stop walking.' } }, // Assumes agent is moving via GOTO
        { name: '{{name2}}', content: { text: 'Stopped current movement. Reason: stop action called', actions: ['HYPERFY_STOP_MOVING'], source: 'hyperfy' } }
      ],
       [
        { name: '{{name1}}', content: { text: 'Halt!' } }, // Assumes agent is moving via GOTO
        { name: '{{name2}}', content: { text: 'Stopped current movement. Reason: stop action called', actions: ['HYPERFY_STOP_MOVING'], source: 'hyperfy' } }
      ]
     ]
  }; 