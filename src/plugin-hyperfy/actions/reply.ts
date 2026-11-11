import {
  type Action,
  type Content,
  composePromptFromState,
  type IAgentRuntime,
  ModelType,
} from '@elizaos/core';
import { forPurpose } from '../../usage-budget';
import { actionFailed, actionSucceeded } from '../lib/action-result';
import { plannedContent, readString } from '../lib/model-output';

/** Template for the character's next message. */
const replyTemplate = `# Task: Generate dialog for the character {{agentName}}.
{{providers}}
# Instructions: Write the next message for {{agentName}}.
"thought" should be a short description of what the agent is thinking about and planning.
"message" should be the next message for {{agentName}} which they will send to the conversation.

Response format should be formatted in a valid JSON block like this:
\`\`\`json
{
    "thought": "<string>",
    "message": "<string>"
}
\`\`\`

Your response should include the valid JSON block and nothing else.`;

/**
 * Represents an action that allows the agent to reply to the current conversation with a generated message.
 *
 * This action can be used as an acknowledgement at the beginning of a chain of actions, or as a final response at the end of a chain of actions.
 *
 * @typedef {Object} replyAction
 * @property {string} name - The name of the action ("REPLY").
 * @property {string[]} similes - An array of similes for the action.
 * @property {string} description - A description of the action and its usage.
 * @property {Function} validate - An asynchronous function for validating the action runtime.
 * @property {Function} handler - An asynchronous function for handling the action logic.
 * @property {ActionExample[][]} examples - An array of example scenarios for the action.
 */
export const replyAction: Action = {
  name: 'REPLY',
  similes: ['GREET', 'REPLY_TO_MESSAGE', 'SEND_REPLY', 'RESPOND', 'RESPONSE'],
  description: `Sends a direct message into in-game chat to a player; always use this first when you're speaking in response to someone.`,
  validate: async (_runtime: IAgentRuntime) => {
    return true;
  },
  handler: async (runtime, message, state, _options, callback, responses) => {
    // Its whole effect is what the callback posts: without one, no model call is made for it
    if (!callback) return actionFailed('REPLY', 'no callback to reply through');
    const existingReplies =
      responses
        ?.map((r) => plannedContent(r, 'REPLY'))
        .filter((reply): reply is Content => reply !== null) ?? [];

    if (existingReplies.length > 0) {
      for (const reply of existingReplies) {
        await callback(reply);
      }
      return actionSucceeded('REPLY');
    }

    // Only generate response using LLM if no suitable response was found
    state = await runtime.composeState(message);

    const prompt = composePromptFromState({
      state,
      template: replyTemplate,
    });

    const response = await runtime.useModel(ModelType.OBJECT_LARGE, forPurpose('reply', {
      prompt,
    }));

    const responseContent = {
      thought: readString(response, 'thought'),
      text: readString(response, 'message') || '',
      actions: ['REPLY'],
    };

    await callback(responseContent);
    return actionSucceeded('REPLY');
  },
  examples: [
    [
      {
        name: '{{name1}}',
        content: {
          text: 'Hello there!',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: 'Hi! How can I help you today?',
          actions: ['REPLY'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: "What's your favorite color?",
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: 'I really like deep shades of blue. They remind me of the ocean and the night sky.',
          actions: ['REPLY'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'Can you explain how neural networks work?',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: 'Let me break that down for you in simple terms...',
          actions: ['REPLY'],
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'Could you help me solve this math problem?',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: "Of course! Let's work through it step by step.",
          actions: ['REPLY'],
        },
      },
    ],
  ],
};
