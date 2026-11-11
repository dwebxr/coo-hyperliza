import { Content, EventType, HandlerCallback, IAgentRuntime, Memory, ModelType, asUUID, composePromptFromState, createUniqueUuid, logger, parseKeyValueXml, truncateToCompleteSentence } from "@elizaos/core";
import { hyperfyShouldRespondTemplate, hyperfyMessageHandlerTemplate } from "../templates";
import { AiBudgetExceededError, forPurpose, getUsageBudget } from "../../usage-budget";
import { AnthropicRefusalError } from "../../anthropic-models";
import { currentTurn, turnDelivered } from "../lib/turn-context";
import { getShopProducts } from "../../openpay-store";
import { parseAliases } from "../lib/addressing";
import { isJapanese, matchSimpleCommand, simpleCommandReply } from "../lib/simple-commands";
import { NoticeThrottle, composeOfflineReply } from "../lib/offline-reply";
import { readActionNames, readString, readStringList } from "../lib/model-output";

/** What the Hyperfy chat and voice events hand the handler (see ../events.ts). */
export interface MessageReceivedHandlerParams {
  runtime: IAgentRuntime;
  message: Memory;
  callback: HandlerCallback;
  onComplete?: () => void;
}

const latestResponseIds = new Map<string, Map<string, string>>();

// Beyond this the agent teleports to a player who asks it to come, instead of walking
const COME_TELEPORT_BEYOND_M = 30;
// One full reply attempt plus one retry when the reply could not be parsed at all
const MAX_REPLY_ATTEMPTS = 2;

const offlineNotices = new NoticeThrottle();

/**
 * "Come here" / "stop" from the player talking to the agent, done without Claude.
 * Returns false when the message is not such a command or it cannot be carried out here.
 */
async function handleSimpleCommand(runtime: IAgentRuntime, message: Memory, callback: HandlerCallback): Promise<boolean> {
  const names = [runtime.character.name, ...parseAliases(process.env.HYPERFY_AGENT_ALIASES)];
  const command = matchSimpleCommand(message.content.text, names);
  if (!command) return false;

  const world = (runtime.getService?.('hyperfy') as { getWorld?: () => any } | null)?.getWorld?.();
  const controls = world?.controls;
  if (!controls) return false;

  if (command === 'come') {
    const senderId = (message.content.metadata as { hyperfyFromId?: string } | undefined)?.hyperfyFromId;
    const theirs = senderId ? world.entities?.items?.get(senderId)?.base?.position : null;
    const mine = world.entities?.player?.base?.position;
    if (!theirs || !mine) return false;
    if (theirs.distanceTo(mine) > COME_TELEPORT_BEYOND_M) {
      controls.teleportToEntity(senderId);
    } else {
      // Not awaited: the reply goes out while walking
      controls.followEntity(senderId).catch((error: unknown) => logger.debug(`[Bootstrap] Walking to the speaker failed: ${error}`));
    }
  } else {
    controls.stopAllActions('asked to stop');
  }

  logger.info(`[Bootstrap] Simple command "${command}" handled without a model call`);
  await callback({
    thought: `Simple request (${command}), handled directly.`,
    text: simpleCommandReply(command, isJapanese(message.content.text)),
    actions: [command === 'come' ? 'HYPERFY_GOTO_ENTITY' : 'HYPERFY_STOP_MOVING'],
    source: 'hyperfy',
    ...(message.id ? { inReplyTo: createUniqueUuid(runtime, message.id) } : {}),
  });
  return true;
}

/**
 * Answers a player who talks to the agent while the Claude budget is used up. The "on a break"
 * notice is throttled per player when it is sent up front (`throttle`), but not when it is the
 * only answer to a request that ran out of budget partway (see the catch in the handler).
 */
async function replyWithoutAi(
  runtime: IAgentRuntime,
  message: Memory,
  callback: HandlerCallback,
  { throttle = true }: { throttle?: boolean } = {}
): Promise<void> {
  const text = message.content.text ?? '';
  const reply = composeOfflineReply({ text, products: getShopProducts(runtime), japanese: isJapanese(text) });
  const key = `${message.roomId}:${message.entityId}`;
  if (reply.kind === 'notice' && throttle && !offlineNotices.allow(key)) return;
  getUsageBudget().recordSkip('offline-reply');
  logger.info(`[Bootstrap] Claude budget reached; answering with a ${reply.kind} instead`);
  await callback({
    ...reply.content,
    ...(message.id ? { inReplyTo: createUniqueUuid(runtime, message.id) } : {}),
  });
}

/** Said without a model call when Claude declined the request. */
async function replyDeclined(runtime: IAgentRuntime, message: Memory, callback: HandlerCallback): Promise<void> {
  logger.info('[Bootstrap] The model declined the request; answering with a fixed reply');
  await callback({
    thought: 'The model declined this request.',
    text: isJapanese(message.content.text) ? 'ごめんなさい、それはお手伝いできません。' : "Sorry, I can't help with that.",
    actions: ['REPLY'],
    source: 'hyperfy',
    ...(message.id ? { inReplyTo: createUniqueUuid(runtime, message.id) } : {}),
  });
}

/**
 * Handles incoming messages and generates responses based on the provided runtime and message information.
 *
 * @param {MessageReceivedHandlerParams} params - The parameters needed for message handling, including runtime, message, and callback.
 * @returns {Promise<void>} - A promise that resolves once the message handling and response generation is complete.
 */
export const messageReceivedHandler = async ({
  runtime,
  message,
  callback: platformCallback,
  onComplete,
}: MessageReceivedHandlerParams): Promise<void> => {
  // Whether the player got anything during this turn: recorded where output actually happens (each
  // chat chunk posted, an utterance played; see noteDelivered), not when a callback is entered,
  // because a callback can drop or fail to deliver what it gets. An emote alone does not count: it
  // answers nothing in words, so a fixed reply after it is not a duplicate. Core hands action
  // replies to the callback only after the action returns, so an action that throws delivers nothing.
  const turn = currentTurn();
  const callback = platformCallback;
  const delivered = () => turnDelivered(turn);
  // Set up timeout monitoring
  const timeoutDuration = 60 * 60 * 1000; // 1 hour
  let timeoutId: NodeJS.Timeout | undefined = undefined;
  try {
    logger.info(`[Bootstrap] Message received from ${message.entityId} in room ${message.roomId}`);
    // Generate a new response ID
    const responseId = crypto.randomUUID();
    // Get or create the agent-specific map
    if (!latestResponseIds.has(runtime.agentId)) {
      latestResponseIds.set(runtime.agentId, new Map<string, string>());
    }
    const agentResponses = latestResponseIds.get(runtime.agentId);
    if (!agentResponses) {
      throw new Error('Agent responses map not found');
    }

    // Set this as the latest response ID for this agent+room
    agentResponses.set(message.roomId, responseId);

    // Generate a unique run ID for tracking this message handler execution
    const runId = asUUID(crypto.randomUUID());
    const startTime = Date.now();

    // Emit run started event
    await runtime.emitEvent(EventType.RUN_STARTED, {
      runtime,
      runId,
      messageId: message.id,
      roomId: message.roomId,
      entityId: message.entityId,
      startTime,
      status: 'started',
      source: 'messageHandler',
    });

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(async () => {
        await runtime.emitEvent(EventType.RUN_TIMEOUT, {
          runtime,
          runId,
          messageId: message.id,
          roomId: message.roomId,
          entityId: message.entityId,
          startTime,
          status: 'timeout',
          endTime: Date.now(),
          duration: Date.now() - startTime,
          error: 'Run exceeded 60 minute timeout',
          source: 'messageHandler',
        });
        reject(new Error('Run exceeded 60 minute timeout'));
      }, timeoutDuration);
    });

    const processingPromise = (async () => {
      let runError: string | undefined;
      // Set by the Hyperfy message/voice managers
      const metadata = (message.content?.metadata ?? {}) as { directlyAddressed?: boolean; soloPlayer?: boolean };
      const addressed = !!(metadata.directlyAddressed || metadata.soloPlayer);
      try {
        if (message.entityId === runtime.agentId) {
          logger.debug(`[Bootstrap] Skipping message from self (${runtime.agentId})`);
          throw new Error('Message is from the agent itself');
        }

        logger.debug(
          `[Bootstrap] Processing message: ${truncateToCompleteSentence(message.content.text || '', 50)}...`
        );

        // First, save the incoming message. Nothing in this agent searches memories by embedding,
        // so a missing or failing embedding provider must not stop the reply.
        logger.debug('[Bootstrap] Saving message to memory and embeddings');
        const embedding = runtime.getModel(ModelType.TEXT_EMBEDDING)
          ? runtime.addEmbeddingToMemory(message).catch((error) => {
              logger.warn(`[Bootstrap] Embedding failed, continuing without it: ${error?.message || error}`);
            })
          : undefined;
        await Promise.all([embedding, runtime.createMemory(message, 'messages')]);

        const agentUserState = await runtime.getParticipantUserState(
          message.roomId,
          runtime.agentId
        );

        if (
          agentUserState === 'MUTED' &&
          !message.content.text?.toLowerCase().includes(runtime.character.name.toLowerCase())
        ) {
          logger.debug(`[Bootstrap] Ignoring muted room ${message.roomId}`);
          return;
        }

        // Simple requests from the player talking to the agent need no model call
        if (addressed && (await handleSimpleCommand(runtime, message, callback))) {
          return;
        }

        if (!getUsageBudget().aiAvailable()) {
          if (addressed) await replyWithoutAi(runtime, message, callback);
          return;
        }

        // Composed once and reused for the response prompt; recomposing re-runs every provider.
        let state = await runtime.composeState(
          message,
        );

        let shouldRespond = false;

        if (addressed) {
          logger.debug(
            `[Bootstrap] Skipping shouldRespond check for ${runtime.character.name} (directlyAddressed=${!!metadata.directlyAddressed}, soloPlayer=${!!metadata.soloPlayer})`
          );
          shouldRespond = true;
        } else {
          const shouldRespondPrompt = composePromptFromState({
            state,
            template: hyperfyShouldRespondTemplate,
          });

          logger.debug(
            `[Bootstrap] Evaluating response for ${runtime.character.name}\nPrompt: ${shouldRespondPrompt}`
          );

          const response = await runtime.useModel(ModelType.TEXT_SMALL, forPurpose('should-respond', {
            prompt: shouldRespondPrompt,
          }));

          logger.debug(
            `[Bootstrap] Response evaluation for ${runtime.character.name}:\n${response}`
          );

          const responseObject = parseKeyValueXml(response);
          logger.debug(`[Bootstrap] Parsed response: ${JSON.stringify(responseObject)}`);

          shouldRespond = responseObject?.action === 'RESPOND';
        }

        let responseMessages: Memory[] = [];

        if (shouldRespond) {
          const prompt = composePromptFromState({
            state,
            template: hyperfyMessageHandlerTemplate,
          });

          let responseContent: Content | null = null;

          // Retried only when the reply could not be parsed; an empty thought is fine
          let attempts = 0;

          while (attempts < MAX_REPLY_ATTEMPTS && !responseContent) {
            let response = await runtime.useModel(ModelType.TEXT_LARGE, forPurpose('chat', {
              prompt,
            }));

            logger.debug('[Bootstrap] *** Raw LLM Response ***\n', response);

            // Attempt to parse the XML response
            const parsedXml = parseKeyValueXml(response);
            logger.debug({ parsedXml }, '[Bootstrap] *** Parsed XML Content ***');

            // Map parsed XML to Content type, handling potential missing fields
            if (parsedXml) {
              let actions = readActionNames(parsedXml) || ['IGNORE'];

              // Reorder actions so 'REPLY' always comes first if present
              const replyIndex = actions.findIndex(a => a.toUpperCase() === 'REPLY');
              if (replyIndex !== -1) {
                actions = ['REPLY', ...actions.filter((a, i) => i !== replyIndex)];
              }

              // Deduplicate actions
              actions = Array.from(new Set(actions.map(a => a.toUpperCase())));

              responseContent = {
                ...parsedXml,
                thought: readString(parsedXml, 'thought') || '',
                actions,
                providers: readStringList(parsedXml, 'providers') || [],
                text: readString(parsedXml, 'text') || '',
                simple: parsedXml.simple === true,
              };
            } else {
              responseContent = null;
            }

            attempts++;
            if (!responseContent && attempts < MAX_REPLY_ATTEMPTS) {
              logger.warn('[Bootstrap] *** Could not parse the reply, retrying once... ***');
            }
          }

          // Check if this is still the latest response ID for this agent+room
          const currentResponseId = agentResponses.get(message.roomId);
          if (currentResponseId !== responseId) {
            logger.info(
              `Response discarded - newer message being processed for agent: ${runtime.agentId}, room: ${message.roomId}`
            );
            return;
          }

          if (responseContent && message.id) {
            responseContent.inReplyTo = createUniqueUuid(runtime, message.id);

            const responseMesssage = {
              id: asUUID(crypto.randomUUID()),
              entityId: runtime.agentId,
              agentId: runtime.agentId,
              content: responseContent,
              roomId: message.roomId,
              createdAt: Date.now(),
            };

            responseMessages = [responseMesssage];
          }

          // Clean up the response ID
          agentResponses.delete(message.roomId);
          if (agentResponses.size === 0) {
            latestResponseIds.delete(runtime.agentId);
          }

          if (responseContent?.providers?.length && responseContent?.providers?.length > 0) {
            state = await runtime.composeState(message, responseContent?.providers || []);
          }

          // An action that runs out of budget or is declined stops the rest of the plan (the error
          // propagates); the catch below answers only if nothing reached the player before that
          await runtime.processActions(message, responseMessages, state, callback);
          
          await runtime.evaluate(message, state, shouldRespond, callback, responseMessages);
        } else {
          // Handle the case where the agent decided not to respond
          logger.debug('[Bootstrap] Agent decided not to respond (shouldRespond is false).');

          // Check if we still have the latest response ID
          const currentResponseId = agentResponses.get(message.roomId);
          if (currentResponseId !== responseId) {
            logger.info(
              `Ignore response discarded - newer message being processed for agent: ${runtime.agentId}, room: ${message.roomId}`
            );
            return; // Stop processing if a newer message took over
          }

          if (!message.id) {
            logger.error('[Bootstrap] Message ID is missing, cannot create ignore response.');
            return;
          }

          // Construct a minimal content object indicating ignore, include a generic thought
          const ignoreContent: Content = {
            thought: 'Agent decided not to respond to this message.',
            actions: ['IGNORE'],
            simple: true, // Treat it as simple for callback purposes
            inReplyTo: createUniqueUuid(runtime, message.id), // Reference original message
          };

          // The callback persists the ignore content to memory
          await callback(ignoreContent);

          // Clean up the response ID since we handled it
          agentResponses.delete(message.roomId);
          if (agentResponses.size === 0) {
            latestResponseIds.delete(runtime.agentId);
          }

          // Optionally, evaluate the decision to ignore (if relevant evaluators exist)
          // await runtime.evaluate(message, state, shouldRespond, callback, []);
        }

      } catch (error: any) {
        runError = error?.message || String(error);
        // The budget ran out, or the model declined, before the player got anything: answer anyway,
        // without a model call. Nothing is added when a reply (e.g. REPLY before the failing
        // action) already reached them.
        if (addressed && !delivered()) {
          const fallback =
            error instanceof AiBudgetExceededError
              ? () => replyWithoutAi(runtime, message, callback, { throttle: false })
              : error instanceof AnthropicRefusalError
                ? () => replyDeclined(runtime, message, callback)
                : null;
          await fallback?.().catch((e) => logger.warn('[Bootstrap] Fallback reply failed:', e));
        }
      } finally {
        // Emitted on every path, including early returns (muted room, superseded response)
        await runtime.emitEvent(EventType.RUN_ENDED, {
          runtime,
          runId,
          messageId: message.id,
          roomId: message.roomId,
          entityId: message.entityId,
          startTime,
          status: runError ? 'error' : 'completed',
          endTime: Date.now(),
          duration: Date.now() - startTime,
          ...(runError ? { error: runError } : {}),
          source: 'messageHandler',
        } as any).catch((error) => logger.warn('[Bootstrap] RUN_ENDED handler failed:', error));
      }
    })();

    await Promise.race([processingPromise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutId);
    onComplete?.();
  }
};