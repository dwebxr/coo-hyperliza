import {
  type Action,
  type HandlerCallback,
  type IAgentRuntime,
  type State,
  logger,
  composePromptFromState,
  ModelType,
  parseKeyValueXml,
} from '@elizaos/core';
  import { actingSession, connectedSession } from '../service';
  import { AiBudgetExceededError, forPurpose } from '../../usage-budget';
  import { AnthropicRefusalError } from '../../anthropic-models';
  import { actionFailed, actionSucceeded, tellFailure } from '../lib/action-result';
  import { errorText } from '../lib/error-text';
  import { AGENT_NOT_BUILDER, AGENT_RANK_UNKNOWN, EDIT_ENTITY_ACTION, SceneEditStopped, readSceneEditsMode, reportsPrivilegedAction, sceneEditRefusal, sceneEditStillAllowed } from '../lib/authorization';
  import type { EditGuard, EditResult } from '../managers/build-manager';
  import { MAX_OPERATIONS_PER_REQUEST, planLabelProblem, readPlanEntry } from '../lib/edit-plan';
  import { readString } from '../lib/model-output';
  import { isJapanese } from '../lib/simple-commands';
  import { TurnCancelled, currentTurn } from '../lib/turn-context';
  import { describeUrl } from '../lib/log-url';
  import { oneLine } from '../lib/text';
  const MAX_RETRIES = 3;
  // What the summary prompt is told about the edit: this many results, each cut to this length
  const MAX_SUMMARY_LINES = 30;
  const MAX_SUMMARY_LINE_CODE_POINTS = 200;
  const EDIT_ENTITY = EDIT_ENTITY_ACTION;
  // Said without a model call to someone who may not have the world edited
  const REFUSAL_EN = 'Sorry, I can only change things in this world when a builder asks me to.';
  const REFUSAL_JA = 'ごめんなさい、ワールドの編集はビルダー権限のある方に頼まれたときだけできます。';
  // ...when the agent's own account may not build there, or the world does not say whether it may
  const AGENT_REFUSAL: Record<string, { en: string; ja: string }> = {
    [AGENT_NOT_BUILDER]: { en: "I'm not allowed to build in this world.", ja: 'このワールドでは、私には編集の権限がありません。' },
    [AGENT_RANK_UNKNOWN]: { en: "I can't build in this world: it doesn't tell me whether I'm allowed to.", ja: 'このワールドでは、私に編集の権限があるか分からないので、編集できません。' },
  };
  // ...and when scene edits are off (HYPERFY_SCENE_EDITS)
  const OFF_EN = "Sorry, I can't change things in this world.";
  const OFF_JA = 'ごめんなさい、このワールドでは編集のお手伝いはできません。';
  const STOPPED_EN = 'I had to stop before finishing those edits.';
  const STOPPED_JA = '編集の途中で止めました。';
  // All a requester who may no longer have the world edited is told at the end: nothing about the scene
  const NO_LONGER_EN = "I can't go any further with that request.";
  const NO_LONGER_JA = 'そのご依頼はこれ以上お手伝いできません。';

  interface OutcomeCounts {
    executed: number;
    skipped: number;
    failed: number;
  }

  /** What was done, from the counts alone (no model call): the summary when none can be written. */
  function outcomeText({ executed, skipped, failed }: OutcomeCounts, japanese: boolean): string {
    const total = executed + skipped + failed;
    if (total === 0) return japanese ? '変更することはありませんでした。' : 'There was nothing to change.';
    if (executed === 0) return japanese ? 'その変更はできませんでした。' : "I couldn't make any of those changes.";
    if (executed === total) {
      if (japanese) return total === 1 ? '変更しました。' : `${total}件の変更をすべてしました。`;
      return total === 1 ? 'I made the change.' : `I made all ${total} changes.`;
    }
    const rest = japanese
      ? [skipped ? `スキップ${skipped}件` : '', failed ? `失敗${failed}件` : ''].filter(Boolean).join('、')
      : [skipped ? `${skipped} skipped` : '', failed ? `${failed} failed` : ''].filter(Boolean).join(', ');
    return japanese ? `${total}件中${executed}件の変更をしました（${rest}）。` : `I made ${executed} of the ${total} changes (${rest}).`;
  }

  /**
   * What happened to one entry of the model's edit plan, from what the build manager reported:
   * executed (the change was made), skipped (the plan itself said it cannot be done, or there was
   * nothing to do: the target was gone, pinned, the world's scene, not an app, or the walk to it did
   * not get there),
   * or failed (refused or failed import, an entry that is no operation (lib/edit-plan.ts), invalid
   * parameters, a copy it refers to that was not made, threw, or not run: the edit stopped, or the
   * request already ran MAX_OPERATIONS_PER_REQUEST operations). `newId`: the entity a duplicate made.
   */
  interface OperationOutcome {
    operation?: string;
    target?: string;
    outcome: 'executed' | 'skipped' | 'failed';
    reason?: string;
    newId?: string;
  }

  const stringOrUndefined = (value: unknown) => (typeof value === 'string' ? value : undefined);

  // What an entity id or name looks like: letters, digits and a little punctuation, nothing a
  // URL needs (no colon, slash, backslash, query, fragment, user part or whitespace at the ends)
  const ENTITY_REFERENCE = /^[\p{L}\p{N}_.$-][\p{L}\p{N} _.$-]{0,99}$/u;
  // The operations whose target names an entity that is already in the world
  const ENTITY_OPERATIONS: readonly unknown[] = ['duplicate', 'translate', 'rotate', 'scale', 'delete'];

  /**
   * A target as logs, the summary prompt and the action result show it, decided by what the
   * operation takes, not by what the text looks like. An import names a URL: it is always written
   * the way every logged URL is (lib/log-url.ts), trimmed first, so no spelling of one (leading
   * whitespace, backslashes, no scheme) keeps its query or credentials. So is the target of an
   * operation this action does not know. The other operations name an entity: its id is shown as
   * it is when it looks like one (ENTITY_REFERENCE), and like a URL otherwise.
   */
  function shownTarget(operation: unknown, target: unknown): string {
    if (typeof target !== 'string') return oneLine(String(target), 100);
    const text = target.trim();
    if (ENTITY_OPERATIONS.includes(operation) && ENTITY_REFERENCE.test(text)) return text;
    return oneLine(describeUrl(text), 300);
  }

  /** The operation and target of a plan entry, for its outcome. */
  function describe(entry: unknown): Pick<OperationOutcome, 'operation' | 'target'> {
    if (!entry || typeof entry !== 'object') return {};
    const op = entry as Record<string, unknown>;
    const operation = stringOrUndefined(op.operation);
    return {
      // One short line: it goes into logs and the stored result as the model wrote it
      operation: operation === undefined ? undefined : oneLine(operation, 40),
      target: typeof op.target === 'string' ? shownTarget(op.operation, op.target) : undefined,
    };
  }

const sceneEditOperationExtractionTemplate = `
  # Task:
  You are a scene editing reasoning module. Based on the user's request and the current Hyperfy world state, generate a scene edit plan as a JSON object with an "operations" array, in the intended execution order.
  
  # Supported Operations:
  - "duplicate": Duplicate an existing entity. The copy appears where the original is. To act on the copy later in the same plan, name it with "as": "<label>" (for example "copy1").
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
        "as": "copy1",
        "description": "Duplicated block"
      },
      {
        "success": true,
        "operation": "translate",
        "targetRef": "copy1",
        "parameters": {
          "position": [0, 2, 0]
        },
        "description": "Moved the copy upward"
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
  - To move, rotate, scale or delete a copy made earlier in the same plan, use "targetRef": "<the label given in that duplicate's 'as'>" instead of "target". Never guess the copy's ID.
  - A plan runs at most ${MAX_OPERATIONS_PER_REQUEST} operations.
  - If an entity cannot be found, return a failed operation with "success": false and a clear reason.
  - Format all vector parameters as arrays (e.g., [x, y, z]).
  - Maintain the order of operations as implied by the user.
  - Return only the final JSON object as shown above — no additional text, comments, or wrappers.
`;

// The results enter through a state value ({{sceneEditResults}}), never as template text: they
// hold the model's own descriptions and reasons, which may contain anything, braces included
const sceneEditSummaryResponseTemplate = `
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
{{sceneEditResults}}

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
      return !!connectedSession(runtime)?.world?.controls;
    },
    handler: async (runtime, message, state, _options, callback, responses) => {
      // Checked first, so a refused request costs no model call: only a builder who asked in chat or voice
      const turn = currentTurn();
      const refusal = sceneEditRefusal(turn);
      const japanese = isJapanese(message.content?.text ?? '');
      if (refusal || !turn) {
        logger.warn(`[EDIT_ENTITY Action] Refused: ${refusal}`);
        if (turn?.requesterId) {
          const off = readSceneEditsMode().mode === 'off';
          const agent = refusal ? AGENT_REFUSAL[refusal] : undefined;
          await callback?.({
            thought: `I may not edit the world for this request (${refusal}).`,
            text: off ? (japanese ? OFF_JA : OFF_EN) : agent ? (japanese ? agent.ja : agent.en) : japanese ? REFUSAL_JA : REFUSAL_EN,
            actions: [EDIT_ENTITY],
            source: 'hyperfy',
          });
        }
        return actionFailed(EDIT_ENTITY, refusal ?? 'no turn');
      }

      // The session the turn started on, never whatever connection is current now
      const session = actingSession(runtime);
      const buildManager = session?.build;

      if (!session || session.world !== turn.world || !buildManager) {
        logger.error('[EDIT_ENTITY Action] Hyperfy service, world, or buildManager not found.');
        await tellFailure(callback, EDIT_ENTITY, japanese ? '今はワールドを編集できません。' : "I can't edit the world right now.");
        return actionFailed(EDIT_ENTITY, 'Hyperfy service, world, or buildManager not found');
      }

      // The edit acts only on the world it was authorized for, and stops as soon as that no longer
      // holds: the turn was cancelled (its slot ran out) or its connection ended, or the requester
      // may no longer build there
      const stillAllowed = () => sceneEditStillAllowed(turn);
      const connectionLive = () => !session.ended;
      const guard: EditGuard = {
        world: turn.world,
        check() {
          const reason = stillAllowed();
          if (reason) throw new SceneEditStopped(reason);
        },
        signal: turn.signal,
      };
      // Posted while the turn runs (core holds callback content until the handler returns), and only
      // while the edit is still allowed: never by a turn that was cancelled, to another connection,
      // or for a requester who may no longer build. (The post itself refuses a cancelled turn too.)
      const postNow = (text: string) => {
        if (!stillAllowed()) session.messages.sendMessage(text);
      };
      // All a requester who may no longer have the world edited is told: nothing about the scene
      const neutral = (): Parameters<HandlerCallback>[0] => ({ thought: 'The edit request ended.', text: japanese ? NO_LONGER_JA : NO_LONGER_EN, actions: [EDIT_ENTITY], source: 'hyperfy' });
      const sayNoLonger = async (reason: string) => {
        logger.warn(`[EDIT_ENTITY Action] Not reporting the outcome: ${reason}`);
        await callback?.(neutral());
      };
      // Every closing message that says what was done goes through here, checked as the edits were.
      // Core holds it until this handler has returned, so it is registered to be checked once more
      // when it is delivered (session/deliver-reply.ts): a requester who lost the right in between
      // gets the neutral line then.
      const finish = async (content: Parameters<HandlerCallback>[0]) => {
        const reason = stillAllowed();
        await (reason ? sayNoLonger(reason) : callback?.(reportsPrivilegedAction(content, { refusal: stillAllowed, instead: neutral() })));
      };
    
      let operationResults: any = null;
      let attempts = 0;
      // Why the requester may no longer have the world edited, once that is so: checked before
      // every planning step and after every await in it, so no further model call is made for them
      let noLongerPlanning: string | null = null;
    
      while (attempts < MAX_RETRIES) {
        if ((noLongerPlanning = stillAllowed())) break;
        try {
          const extractionState = await runtime.composeState(message);
          if ((noLongerPlanning = stillAllowed())) break;
          const prompt = composePromptFromState({
            state: extractionState,
            template: sceneEditOperationExtractionTemplate,
          });
    
          operationResults = await runtime.useModel(ModelType.OBJECT_LARGE, forPurpose('build', { prompt }));
    
          if (Array.isArray(operationResults?.operations)) break;
    
          // Not the plan itself: it can hold the URLs an import names
          logger.warn(`[EDIT_ENTITY Action] Unexpected structure on attempt ${attempts + 1}: ${operationResults === null ? 'null' : typeof operationResults}`);
        } catch (error) {
          // Before anything else: a requester who lost the right while the call ran gets the
          // neutral line, whatever the error was
          if ((noLongerPlanning = stillAllowed())) break;
          // Retrying cannot help: the budget is used up (the turn's caller falls back to scripted or
          // offline behavior), the model declined this request, or the turn was cancelled
          if (error instanceof AiBudgetExceededError || error instanceof AnthropicRefusalError || error instanceof TurnCancelled) throw error;
          logger.error(`[EDIT_ENTITY Action] Model error on attempt ${attempts + 1}: ${errorText(error)}`);
        }
    
        attempts++;
      }

      
      // Also after the last planning call: its answer is not used for a requester who lost the right
      noLongerPlanning ??= stillAllowed();
      if (noLongerPlanning) {
        logger.warn(`[EDIT_ENTITY Action] Stopped planning: ${noLongerPlanning}`);
        await sayNoLonger(noLongerPlanning);
        return actionFailed(EDIT_ENTITY, `stopped: ${noLongerPlanning}`);
      }

      if (!Array.isArray(operationResults?.operations)) {
        logger.error(`[EDIT_ENTITY Action] Scene editing failed — could not understand instructions properly.`);
        // Checked like every closing message (nothing is awaited between the check above and here)
        await tellFailure(callback, EDIT_ENTITY, japanese ? 'ごめんなさい、どう編集すればいいか分かりませんでした。' : "Sorry, I couldn't work out how to make that change.");
        return actionFailed(EDIT_ENTITY, 'no edit plan from the model');
      }
    
      const operations: unknown[] = operationResults.operations;
      // The plan's copy labels, before anything of it is run (lib/edit-plan.ts)
      const labelProblem = planLabelProblem(operations);
      if (labelProblem) {
        logger.warn(`[EDIT_ENTITY Action] Not running an edit plan whose copy labels do not hold together: ${labelProblem}`);
        // Says nothing was done (nothing is awaited between the check above and here)
        await tellFailure(callback, EDIT_ENTITY, japanese ? 'ごめんなさい、編集の手順に食い違いがあったので、何も変えませんでした。' : `Sorry, that edit didn't hold together (${labelProblem}), so I changed nothing.`);
        return actionFailed(EDIT_ENTITY, `invalid edit plan: ${labelProblem}`);
      }
      const outcomes: OperationOutcome[] = [];
      // For the summary prompt: what each executed operation was meant to do
      const descriptions: (string | undefined)[] = [];
      // Why the remaining operations were not run, once the edit had to stop
      let stopped: string | null = null;
      // Operations this request has run or tried to run: at most MAX_OPERATIONS_PER_REQUEST
      let attempted = 0;
      // The copies this plan made, by the label the plan gave each (`as`), for its later entries
      // (`targetRef`); null for a label whose copy was not made
      const copies = new Map<string, string | null>();
      const record = (outcome: OperationOutcome, description?: string) => {
        outcomes.push(outcome);
        descriptions.push(description);
        return outcome;
      };
      for (const entry of operations) {
        // Set by the first operation that had to stop (every effect checks the guard first)
        if (stopped) {
          record({ ...describe(entry), outcome: 'failed', reason: `not run: ${stopped}` });
          continue;
        }
        // What the entry is, by its shape alone (lib/edit-plan.ts)
        const read = readPlanEntry(entry);
        if (read.kind === 'invalid') {
          logger.warn(`[EDIT_ENTITY Action] Ignoring an edit plan entry: ${read.problem}`);
          record({ ...describe(entry), outcome: 'failed', reason: read.problem });
          continue;
        }
        if (read.kind === 'declined') {
          logger.warn(`[EDIT_ENTITY Action] Skipping an entry the plan itself says cannot be done`);
          record({ ...describe(entry), outcome: 'skipped', reason: read.reason });
          continue;
        }
        const op = read.op;
        const { operation } = op;
        // Its label stands for no copy until this duplicate has made one (also when it is not run)
        if (op.operation === 'duplicate' && op.as !== undefined) copies.set(op.as, null);
        if (++attempted > MAX_OPERATIONS_PER_REQUEST) {
          record({ ...describe(entry), outcome: 'failed', reason: `not run: one request runs at most ${MAX_OPERATIONS_PER_REQUEST} operations` });
          continue;
        }
        // The entity it acts on: one in the world, or a copy an earlier entry of this plan made
        let target: string;
        if (op.operation !== 'import' && op.targetRef !== undefined) {
          const copy = copies.get(op.targetRef);
          if (copy === undefined || copy === null) {
            record({ operation, target: op.targetRef, outcome: 'failed', reason: copy === null ? 'the copy this refers to was not made' : `no copy named "${op.targetRef}" was made earlier in this request` });
            continue;
          }
          target = copy;
        } else {
          target = op.target as string;
        }
        const description = op.description;
        const outcome = record({ operation, target: shownTarget(operation, target), outcome: 'executed' }, description);

        let done: EditResult;
        try {
          // One operation at a time has the avatar and the scene (ConnectionSession.withBody): it
          // walks to its target, checks again, then edits
          done = await session.withBody(async (): Promise<EditResult> => {
            switch (op.operation) {
              case 'translate':
                return buildManager.translate(guard, target, op.parameters.position);

              case 'rotate':
                return buildManager.rotate(guard, target, op.parameters.rotation);

              case 'scale':
                return buildManager.scale(guard, target, op.parameters.scale);

              case 'duplicate':
                return buildManager.duplicate(guard, target);

              case 'delete':
                return buildManager.delete(guard, target);

              case 'import':
                return buildManager.importEntity(guard, target, op.parameters?.position ?? undefined, op.parameters?.rotation ?? undefined);
            }
          });
        } catch (error: any) {
          // TurnCancelled: the turn was cancelled while this operation waited for its section
          if (error instanceof SceneEditStopped || error instanceof TurnCancelled) {
            logger.warn(`[EDIT_ENTITY Action] Stopped before ${operation} on "${shownTarget(operation, target)}": ${error.message}`);
            stopped = error.message;
            outcome.outcome = 'failed';
            outcome.reason = `not run: ${error.message}`;
            continue;
          }
          logger.error(`[EDIT_ENTITY Action] Operation ${operation} on "${shownTarget(operation, target)}" failed:`, error);
          done = { outcome: 'failed', reason: String(error?.message ?? error) };
        }
        if (done.outcome === 'applied') {
          if (op.operation === 'duplicate' && done.newId) {
            outcome.newId = done.newId;
            if (op.as !== undefined) copies.set(op.as, done.newId);
          }
          if (description) postNow(description);
        } else {
          logger.warn(`[EDIT_ENTITY Action] ${operation} on "${shownTarget(operation, target)}" ${done.outcome}: ${done.reason}`);
          outcome.outcome = done.outcome;
          outcome.reason = done.reason;
        }
      }

      // Succeeds only when something ran and nothing failed; plan-skipped entries alone are not a failure
      const executed = outcomes.filter((o) => o.outcome === 'executed').length;
      const skipped = outcomes.filter((o) => o.outcome === 'skipped').length;
      const failed = outcomes.filter((o) => o.outcome === 'failed').length;
      const counts: OutcomeCounts = { executed, skipped, failed };
      const resultData = { executed, skipped, failed, outcomes };
      const result = executed > 0 && failed === 0
        ? actionSucceeded(EDIT_ENTITY, resultData)
        : actionFailed(
            EDIT_ENTITY,
            stopped ? `stopped: ${stopped}` : failed > 0 ? `${failed} of ${outcomes.length} operations failed` : 'no operation was executed',
            resultData
          );

      if (stopped) {
        // No summary call: say what happened as it is (to a requester who may still build)
        await finish({
          thought: `Stopped editing: ${stopped}.`,
          text: `${japanese ? STOPPED_JA : STOPPED_EN} ${outcomeText(counts, japanese)}`,
          actions: [EDIT_ENTITY],
          source: 'hyperfy',
        });
        return result;
      }
      // No summary call for a requester who may no longer have the world edited
      const noLonger = stillAllowed();
      if (noLonger) {
        await sayNoLonger(noLonger);
        return result;
      }

      // From what was actually done, not from the model's plan. Each entry is one bounded line:
      // operations, descriptions and reasons are the planning model's words about world content
      const summaryText = outcomes.slice(0, MAX_SUMMARY_LINES).map((o, i) => {
        const what = `${oneLine(o.operation ?? 'an operation', 40)}${o.target ? ` on "${o.target}"` : ''}`;
        return o.outcome === 'executed'
          ? `DONE: ${oneLine(descriptions[i] ?? what, MAX_SUMMARY_LINE_CODE_POINTS)}${o.newId ? ` (the copy is entity ${oneLine(o.newId, 64)})` : ''}`
          : `NOT DONE (${o.outcome}): ${what} → ${oneLine(o.reason ?? 'no reason given', MAX_SUMMARY_LINE_CODE_POINTS)}`;
      }).concat(outcomes.length > MAX_SUMMARY_LINES ? [`(and ${outcomes.length - MAX_SUMMARY_LINES} more)`] : []).join('\n');
      
      const stateForResponse = await runtime.composeState(message);
      // Checked again after that await: no summary call for a requester who lost the right meanwhile
      const noLongerAfterState = stillAllowed();
      if (noLongerAfterState) {
        await sayNoLonger(noLongerAfterState);
        return result;
      }
      const agentResponsePrompt = composePromptFromState({
        state: { ...stateForResponse, values: { ...stateForResponse.values, sceneEditResults: summaryText } },
        template: sceneEditSummaryResponseTemplate,
      });
      
      let finalXml: string;
      try {
        finalXml = await runtime.useModel(ModelType.TEXT_SMALL, forPurpose('build', { prompt: agentResponsePrompt }));
      } catch (err) {
        // A cancelled turn says nothing more (its edits stand; what it would say is dropped anyway)
        if (err instanceof TurnCancelled) throw err;
        if (err instanceof AiBudgetExceededError || err instanceof AnthropicRefusalError) {
          // A requester who lost the right meanwhile (on this connection) gets the neutral closing
          // line, as everywhere else, and the turn ends here
          const reason = stillAllowed();
          if (reason && connectionLive()) {
            await sayNoLonger(reason);
            return result;
          }
          // The edits stand: say what was done now (callback content would be lost with the
          // error), then let the turn's caller handle the used-up budget or the refusal
          postNow(outcomeText(counts, japanese));
          throw err;
        }
        logger.error(`[EDIT_ENTITY Action] Final summarization failed: ${errorText(err)}`);
        await finish({
          thought: 'Scene edits finished, but the summary could not be written.',
          text: outcomeText(counts, japanese),
        });
        return result;
      }
      
      const response = parseKeyValueXml(finalXml);
      if (!response) {
        logger.error('[EDIT_ENTITY Action] Failed to parse summary XML.');
        await finish({
          thought: 'Could not interpret response XML.',
          text: outcomeText(counts, japanese),
        });
        return result;
      }
      
      await finish({
        ...response,
        thought: readString(response, 'thought') || 'Finished with scene edits.',
        // A summary with no text says what the counts say, never more
        text: readString(response, 'text') || outcomeText(counts, japanese),
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
  