import 'ses';

import type { Plugin } from '@elizaos/core';
import {
  logger
} from '@elizaos/core';
import { HyperfyService } from './service';
import { hyperfyGotoEntityAction } from './actions/goto';
import { hyperfyUseItemAction } from './actions/use';
import { hyperfyUnuseItemAction } from './actions/unuse';
import { hyperfyStopMovingAction } from './actions/stop';
import { hyperfyWalkRandomlyAction } from './actions/walk_randomly';
import { hyperfyAmbientSpeechAction } from './actions/ambient';
import { hyperfyScenePerceptionAction } from './actions/perception';
import { hyperfyEditEntityAction } from './actions/build';
import { teleportToUserAction } from './actions/teleport';
import { replyAction } from './actions/reply';
import { ignoreAction } from './actions/ignore';
import { hyperfyProvider } from './providers/world';
import { hyperfyEmoteProvider } from './providers/emote';
import { hyperfyActionsProvider } from './providers/actions';
import { characterProvider } from './providers/character';
import { hyperfyTipsProvider } from './providers/tips';
import { hyperfyEvents } from './events';
import { guardActions } from './lib/authorization';

// The world's URL (WS_URL) is read and validated once, when HyperfyService starts (lib/world-url.ts)
export const hyperfyPlugin: Plugin = {
  name: 'hyperfy',
  description: 'Integrates ElizaOS agents with Hyperfy worlds',
  async init() {
    logger.info('*** Initializing Hyperfy Integration plugin ***');
  },
  services: [
    HyperfyService
  ],
  events: hyperfyEvents,
  // Each handler checks the action's real name against what the current turn may run (lib/authorization.ts)
  actions: guardActions([
    hyperfyScenePerceptionAction,
    hyperfyGotoEntityAction,
    hyperfyUseItemAction,
    hyperfyUnuseItemAction,
    hyperfyStopMovingAction,
    hyperfyWalkRandomlyAction,
    hyperfyAmbientSpeechAction,
    hyperfyEditEntityAction,
    teleportToUserAction,
    replyAction,
    ignoreAction
  ]),
  providers: [
    hyperfyProvider,
    hyperfyEmoteProvider,
    hyperfyActionsProvider,
    characterProvider,
    hyperfyTipsProvider
  ],
};

export default hyperfyPlugin;
