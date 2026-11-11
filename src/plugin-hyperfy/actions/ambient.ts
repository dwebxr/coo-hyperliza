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

const AMBIENT_SPEECH = 'HYPERFY_AMBIENT_SPEECH';

const ambientTemplate = `# Task: Generate ambient speech for the character {{agentName}}.
{{providers}}

# Instructions:
"thought" should describe what the agent is internally noticing, thinking about, or reacting to.
"message" should be a short, self-directed or environment-facing comment. It should NOT be addressed to any user.

Only output a valid JSON block:

\`\`\`json
{
  "thought": "<string>",
  "message": "<string>"
}
\`\`\``;

export const hyperfyAmbientSpeechAction: Action = {
  name: AMBIENT_SPEECH,
  similes: ['MONOLOGUE', 'OBSERVE', 'SELF_TALK', 'ENVIRONMENTAL_REMARK'],
  description: 'Says something aloud without addressing anyone; use for idle thoughts, atmosphere, or commentary when not in conversation.',
  validate: async (_runtime: IAgentRuntime) => true,
  handler: async (runtime, message, state, _options, callback, responses) => {
    // Its whole effect is what the callback posts: without one, no model call is made for it
    if (!callback) return actionFailed(AMBIENT_SPEECH, 'no callback to say it through');
    const existing =
      responses
        ?.map((r) => plannedContent(r, AMBIENT_SPEECH))
        .filter((c): c is Content => c !== null) ?? [];

    if (existing.length > 0) {
      for (const c of existing) await callback(c);
      return actionSucceeded(AMBIENT_SPEECH);
    }

    state = await runtime.composeState(message, [
      ...(message.content.providers ?? []),
      'RECENT_MESSAGES',
    ]);

    const prompt = composePromptFromState({
      state,
      template: ambientTemplate,
    });

    const response = await runtime.useModel(ModelType.OBJECT_LARGE, forPurpose('ambient', { prompt }));

    await callback({
      thought: readString(response, 'thought'),
      text: readString(response, 'message') || '',
      actions: [AMBIENT_SPEECH],
    });
    return actionSucceeded(AMBIENT_SPEECH);
  },
  examples: [
    [
      {
        name: '{{agentName}}',
        content: {},
      },
      {
        name: '{{agentName}}',
        content: {
          text: "That floating crystal looks ancient... wonder what it's guarding.",
          actions: ['HYPERFY_AMBIENT_SPEECH'],
        },
      },
    ],
    [
      {
        name: '{{agentName}}',
        content: {},
      },
      {
        name: '{{agentName}}',
        content: {
          text: "It's peaceful here... almost too peaceful.",
          actions: ['HYPERFY_AMBIENT_SPEECH'],
        },
      },
    ],
  ],
};
