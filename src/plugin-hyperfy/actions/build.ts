import {
    type Action,
    type HandlerCallback,
    type IAgentRuntime,
    type Memory,
    type State,
    logger,
    composePromptFromState,
    ModelType,
    parseKeyValueXml
  } from '@elizaos/core';
  import { HyperfyService } from '../service';
  import { forPurpose } from '../../usage-budget';
  import { actionFailed, actionSucceeded } from '../lib/action-result';
  import { readString } from '../lib/model-output';
  const MAX_RETRIES = 3;
  const EDIT_ENTITY = 'HYPERFY_EDIT_ENTITY';

  /**
   * What happened to one entry of the model's edit plan: run without throwing, skipped because the
   * plan itself marked it as not possible, or failed (threw, unsupported type, or not an object).
   * "executed" only means the manager call returned; the managers do not report whether it took effect.
   */
  interface OperationOutcome {
    operation?: string;
    target?: string;
    outcome: 'executed' | 'skipped' | 'failed';
    reason?: string;
  }

  const stringOrUndefined = (value: unknown) => (typeof value === 'string' ? value : undefined);

  export enum EditOperationType {
    DUPLICATE = 'duplicate',
    TRANSLATE = 'translate',
    ROTATE = 'rotate',
    SCALE = 'scale',
    DELETE = 'delete',
    IMPORT = 'import'
  }
  
const sceneEditOperationExtractionTemplate = `
  # Task:
  You are a scene editing reasoning module. Based on the user's request and the current Hyperfy world state, generate a scene edit plan as a JSON object with an "operations" array, in the intended execution order.
  
  # Supported Operations:
  - "duplicate": Duplicate an existing entity.
  - "delete": Remove an entity.
  - "translate": Move an entity to a new position → "position": [x, y, z]
  - "rotate": Rotate an entity using a quaternion → "rotation": [x, y, z, w]
  - "scale": Scale an entity → "scale": [x, y, z]
  - "import": Add a new entity into the scene → requires:
    - "position": [x, y, z]
    - "rotation": [x, y, z, w]
    - "target": must be a URL to the asset (e.g. https://assets.hyperfy.io/model.glb)
  
  # Output Format:
  Return a single JSON object with an **"operations"** array inside. Each item must match one of these two formats:
  
  ## Successful Operation
  {
    "success": true,
    "operation": "translate",
    "target": "VLvCb3w5G2",
    "parameters": {
      "position": [4.17, 10.0, -14.33]
    },
    "description": "Moved Seat App 10 meters upward"
  }
  
  ## Failed Operation
  {
    "success": false,
    "operation": "delete",
    "requestedEntityName": "stone throne",
    "reason": "No entity with name 'stone throne' found in world state"
  }
  
  # Final Output Format:
  You must return a JSON object like the example below — no additional explanation or text.
  
  {
    "operations": [
      {
        "success": true,
        "operation": "import",
        "target": "https://assets.hyperfy.io/sculpture.glb",
        "parameters": {
          "position": [0, 1, 0],
          "rotation": [0, 0, 0, 1]
        },
        "description": "Imported a new sculpture facing the plaza"
      },
      {
        "success": true,
        "operation": "duplicate",
        "target": "qr66FaMVIj",
        "parameters": {},
        "description": "Duplicated block"
      },
      {
        "success": true,
        "operation": "translate",
        "target": "w9IsHHksuo",
        "parameters": {
          "position": [0, 2, 0]
        },
        "description": "Moved block upward"
      },
      {
        "success": false,
        "operation": "delete",
        "requestedEntityName": "floating dragon",
        "reason": "No entity with name 'floating dragon' found in world state"
      }
    ]
  }
  
  # World State:
  {{hyperfyStatus}}
  
  # Instructions:
  - Analyze the user’s request and determine the sequence of scene changes needed.
  - Use only valid entity IDs from the world state. Do **not invent** or modify IDs.
  - If a duplicate operation is required, use the original 'target'; the system will assign the new ID.
  - If an entity cannot be found, return a failed operation with "success": false and a clear reason.
  - Format all vector parameters as arrays (e.g., [x, y, z]).
  - Maintain the order of operations as implied by the user.
  - Return only the final JSON object as shown above — no additional text, comments, or wrappers.
`;

const sceneEditSummaryResponseTemplate = (summary: string) => `
<task>
You are {{agentName}}, a visible in-world AI character in Hyperfy — a real-time, multiplayer 3D simulation.

You just performed several scene edits in response to a user’s instruction — like duplicating, deleting, or moving entities in the world. Some of them may have succeeded, some may have failed.

Your task is to briefly explain what happened, using your in-world personality and voice.

Don't list every action like a log — instead, summarize the overall outcome naturally and conversationally. If edits failed, acknowledge it helpfully or lightheartedly. If all went well, give a confident confirmation.
</task>

<providers>

{{bio}}

---

{{system}}

---

{{messageDirections}}

---

{{hyperfyStatus}}

---

## Scene Edit Results Summary:
${summary}

</providers>

<instructions>
- Speak in your character voice — you're a live AI inhabitant of this world.
- Keep it short, expressive, and to the point.
- Show emotion through your words or optionally with one emote.
</instructions>

<output>
<response>
  <thought>Your internal thought about how the scene editing went</thought>
  <text>What you say aloud to the user</text>
  <emote>Optional visible animation (like "shrug", "nod", "wave")</emote>
</response>
</output>
`;

  
  
  export const hyperfyEditEntityAction: Action = {
    name: EDIT_ENTITY,
    similes: ['EDIT_ENTITY_IN_WORLD', 'MODIFY_SCENE', 'BUILD_STRUCTURE'],
    description: `Performs scene edits in Hyperfy, including duplicating, moving, rotating, scaling, deleting, or importing entities. Use when the user asks to modify or add something in the 3D world.`,
    validate: async (runtime: IAgentRuntime): Promise<boolean> => {
      const service = runtime.getService<HyperfyService>(HyperfyService.serviceType);
      return !!service && service.isConnected() && !!service.getWorld()?.controls;
    },
    handler: async (
      runtime: IAgentRuntime,
      message: Memory,
      state: State,
      options: Record<string, any>,
      callback: HandlerCallback,
      responses,
    ) => {
      const service = runtime.getService<HyperfyService>(HyperfyService.serviceType);
      const world = service?.getWorld();
      const buildManager = service?.getBuildManager();
    
      if (!service || !world || !buildManager) {
        logger.error('[EDIT_ENTITY Action] Hyperfy service, world, or buildManager not found.');
        return actionFailed(EDIT_ENTITY, 'Hyperfy service, world, or buildManager not found');
      }
    
      let operationResults: any = null;
      let attempts = 0;
    
      while (attempts < MAX_RETRIES) {
        try {
          const extractionState = await runtime.composeState(message);
          const prompt = composePromptFromState({
            state: extractionState,
            template: sceneEditOperationExtractionTemplate,
          });
    
          operationResults = await runtime.useModel(ModelType.OBJECT_LARGE, forPurpose('build', { prompt }));
    
          if (Array.isArray(operationResults?.operations)) break;
    
          logger.warn(`[EDIT_ENTITY Action] Unexpected structure on attempt ${attempts + 1}:`, operationResults);
        } catch (error) {
          logger.error(`[EDIT_ENTITY Action] Model error on attempt ${attempts + 1}:`, error);
        }
    
        attempts++;
      }

      
      if (!Array.isArray(operationResults?.operations)) {
        logger.error(`[EDIT_ENTITY Action] Scene editing failed — could not understand instructions properly.`);
        return actionFailed(EDIT_ENTITY, 'no edit plan from the model');
      }
    
      const operations: unknown[] = operationResults.operations;
      const outcomes: OperationOutcome[] = [];
      for (const entry of operations) {
        if (!entry || typeof entry !== 'object') {
          logger.warn(`[EDIT_ENTITY Action] Ignoring an edit plan entry that is not an object (${entry === null ? 'null' : typeof entry})`);
          outcomes.push({ outcome: 'failed', reason: 'not an operation object' });
          continue;
        }
        const op = entry as Record<string, any>;
        const outcome: OperationOutcome = {
          operation: stringOrUndefined(op.operation),
          target: stringOrUndefined(op.target),
          outcome: 'executed',
        };
        outcomes.push(outcome);
        if (!op.success) {
          logger.warn(`[EDIT_ENTITY Action] Skipping failed operation:`, op.reason || op);
          outcome.outcome = 'skipped';
          outcome.reason = stringOrUndefined(op.reason);
          continue;
        }
    
        const { operation, target, parameters, description } = op;

        try {
          switch (operation) {
            case EditOperationType.TRANSLATE:
              await buildManager.translate(target, parameters?.position);
              break;

            case EditOperationType.ROTATE:
              await buildManager.rotate(target, parameters?.rotation);
              break;

            case EditOperationType.SCALE:
              await buildManager.scale(target, parameters?.scale);
              break;

            case EditOperationType.DUPLICATE:
              await buildManager.duplicate(target);
              break;

            case EditOperationType.DELETE:
              await buildManager.delete(target);
              break;

            case EditOperationType.IMPORT:
              await buildManager.importEntity(
                target,
                parameters?.position,
                parameters?.rotation
              );
              break;

            default:
              logger.warn(`[EDIT_ENTITY Action] Unsupported operation type: ${operation}`);
              outcome.outcome = 'failed';
              outcome.reason = 'unsupported operation type';
              break;
          }
          if (description) {
            const messageManager = service.getMessageManager();
            messageManager.sendMessage(description);
          }
        } catch (error: any) {
          logger.error(`[EDIT_ENTITY Action] Operation ${operation} on "${target}" failed:`, error);
          outcome.outcome = 'failed';
          outcome.reason = String(error?.message ?? error);
        }
      }

      // Succeeds only when something ran and nothing failed; plan-skipped entries alone are not a failure
      const executed = outcomes.filter((o) => o.outcome === 'executed').length;
      const skipped = outcomes.filter((o) => o.outcome === 'skipped').length;
      const failed = outcomes.filter((o) => o.outcome === 'failed').length;
      const resultData = { executed, skipped, failed, outcomes };
      const result = executed > 0 && failed === 0
        ? actionSucceeded(EDIT_ENTITY, resultData)
        : actionFailed(
            EDIT_ENTITY,
            failed > 0 ? `${failed} of ${outcomes.length} operations failed` : 'no operation was executed',
            resultData
          );

      const summaryText = operations.map((entry) => {
        if (!entry || typeof entry !== 'object') return 'FAILURE: unreadable operation entry';
        const op = entry as Record<string, any>;
        if (op.success) {
          return `SUCCESS: ${op.description}`;
        } else {
          return `FAILURE: Tried to ${op.operation} "${op.requestedEntityName}" → ${op.reason}`;
        }
      }).join('\n');
      
      const stateForResponse = await runtime.composeState(message);
      const agentResponsePrompt = composePromptFromState({
        state: stateForResponse,
        template: sceneEditSummaryResponseTemplate(summaryText),
      });
      
      let finalXml: string;
      try {
        finalXml = await runtime.useModel(ModelType.TEXT_SMALL, forPurpose('build', { prompt: agentResponsePrompt }));
      } catch (err) {
        logger.error('[EDIT_ENTITY Action] Final summarization failed:', err);
        await callback({
          thought: 'Scene edits completed, but final summary generation failed.',
          text: 'Edits are done, but I had trouble summarizing the results clearly.',
        });
        return result;
      }
      
      const response = parseKeyValueXml(finalXml);
      if (!response) {
        logger.error('[EDIT_ENTITY Action] Failed to parse summary XML.');
        await callback({
          thought: 'Could not interpret response XML.',
          text: 'Edits completed, but I couldn’t finish the summary properly.',
        });
        return result;
      }
      
      await callback({
        ...response,
        thought: readString(response, 'thought') || 'Finished with scene edits.',
        text: readString(response, 'text') || 'Scene updates complete!',
        emote: readString(response, 'emote') || '',
      });
      return result;
    },
    examples: [
      [
        { name: '{{name1}}', content: { text: 'Can you put another block on top of the water?' } },
        { name: '{{name2}}', content: { text: 'Duplicating block and placing it on top of water...', actions: ['HYPERFY_EDIT_ENTITY'], source: 'hyperfy' } }
      ],
      [
        { name: '{{name1}}', content: { text: 'Move the tree next to the house.' } },
        { name: '{{name2}}', content: { text: 'Moving tree entity beside the house...', actions: ['HYPERFY_EDIT_ENTITY'], source: 'hyperfy' } }
      ],
      [
        { name: '{{name1}}', content: { text: 'Delete that floating cube.' } },
        { name: '{{name2}}', content: { text: 'Deleting the floating cube entity...', actions: ['HYPERFY_EDIT_ENTITY'], source: 'hyperfy' } }
      ]
    ]
  };
  