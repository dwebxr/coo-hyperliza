import {
    type Provider,
    type IAgentRuntime,
    type Memory,
} from '@elizaos/core'
import { EMOTES_LIST } from '../constants'
  
/** Lists the agent's emotes (constants.ts EMOTES_LIST) with descriptions, whether or not this world serves their clips. */
export const hyperfyEmoteProvider: Provider = {
    name: 'HYPERFY_EMOTE_LIST',
    description: 'Lists all available emotes and their descriptions',
    get: async (_runtime: IAgentRuntime, _message: Memory) => {
      const animationListText = EMOTES_LIST.map(
        (e) => `- **${e.name}**: ${e.description}`
      ).join('\n');
      const animationText = `## Available Animations\n${animationListText}`;
      
      return {
        data: {
          emotes: EMOTES_LIST,
        },
        values: {
          hyperfyAnimations: animationText,
        },
        text: animationText,
      };
    },
};
  