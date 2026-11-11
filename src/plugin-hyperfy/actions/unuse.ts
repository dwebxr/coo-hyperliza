import {
  type Action,
  type IAgentRuntime,
  logger,
} from '@elizaos/core';
  import { actingSession, connectedSession } from '../service';
  import { AgentActions } from '../systems/actions';
  import { actionFailed, actionSucceeded, tellFailure } from '../lib/action-result';

  const UNUSE_ITEM = 'HYPERFY_UNUSE_ITEM';
  
  export const hyperfyUnuseItemAction: Action = {
    name: UNUSE_ITEM,
    similes: ['RELEASE_ITEM', 'DROP_ITEM', 'CANCEL_INTERACTION'],
    description: `Drops or stops interacting with the currently held item; use when a player tells you to release it or you're done using it.`,
    validate: async (runtime: IAgentRuntime): Promise<boolean> => {
      return !!connectedSession(runtime)?.world?.actions;
    },
    handler: async (runtime, _message, _state, _options, callback) => {
      // The turn's own connection (never a newer one); throws when the turn may no longer act
      const session = actingSession(runtime);
      const world = session?.world;
      const actions = world?.actions as AgentActions | undefined;
  
      if (!session || !world || !actions) {
        logger.error('[UNUSE ITEM] Hyperfy service, world, or actions system not found.');
        await tellFailure(callback, UNUSE_ITEM, "Error: Cannot unuse item. Required systems are unavailable.");
        return actionFailed(UNUSE_ITEM, 'required systems are unavailable');
      }
  
      logger.info('[UNUSE ITEM] Attempting to release current action.');
      let released: boolean;
      try {
        released = actions.releaseAction();
      } catch (error: any) {
        logger.error('[UNUSE ITEM] Releasing failed:', error);
        await tellFailure(callback, UNUSE_ITEM, "I couldn't let go of it.");
        return actionFailed(UNUSE_ITEM, `releasing failed: ${error?.message ?? error}`);
      }
      if (!released) {
        logger.warn('[UNUSE ITEM] Not holding or using anything; nothing released.');
        await tellFailure(callback, UNUSE_ITEM, "I'm not holding or using anything.");
        return actionFailed(UNUSE_ITEM, 'not holding or using anything');
      }

      await callback?.({
        text: 'Item released.',
        actions: [UNUSE_ITEM],
        source: 'hyperfy',
        metadata: { status: 'released' }
      });
      return actionSucceeded(UNUSE_ITEM);
    },
    examples: [
      [
        { name: '{{name1}}', content: { text: 'Drop it now.' } },
        { name: '{{name2}}', content: { text: 'Item released.', actions: ['HYPERFY_UNUSE_ITEM'], source: 'hyperfy' } }
      ],
      [
        { name: '{{name1}}', content: { text: 'Stop using that.' } },
        { name: '{{name2}}', content: { text: 'Item released.', actions: ['HYPERFY_UNUSE_ITEM'], source: 'hyperfy' } }
      ]
    ]
  };
  