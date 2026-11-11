import { type EventPayload, type MessagePayload, type PluginEvents, type UUID, logger } from "@elizaos/core";
import { messageReceivedHandler } from "./handlers/messageReceivedHandler";

export enum hyperfyEventType {
  MESSAGE_RECEIVED = 'HYPERFY_MESSAGE_RECEIVED',
  VOICE_MESSAGE_RECEIVED = 'HYPERFY_VOICE_MESSAGE_RECEIVED',
  /** The world's socket closed. Emitted without waiting for handlers, right before the service tears the connection down. */
  DISCONNECTED = 'HYPERFY_DISCONNECTED',
}

export interface HyperfyDisconnectedPayload extends EventPayload {
  /** The service's id for the world that was left. */
  worldId: UUID | null;
  /** The socket's close code, or the engine's reason when there is no code. */
  reason: unknown;
}

type MessageEventHandlers = Record<
  hyperfyEventType.MESSAGE_RECEIVED | hyperfyEventType.VOICE_MESSAGE_RECEIVED,
  Array<(payload: MessagePayload) => Promise<void>>
>;

/** A chat or voice turn of the Hyperfy managers: what the model says goes out through its callback. */
async function onMessage(payload: MessagePayload): Promise<void> {
  if (!payload.callback) {
    logger.warn('[Hyperfy] A message event came without a callback: there is nothing to answer it through, so it is not handled');
    return;
  }
  await messageReceivedHandler({
    runtime: payload.runtime,
    message: payload.message,
    callback: payload.callback,
    onComplete: payload.onComplete,
  });
}

// Core's PluginEvents type only names core events, but registerPlugin registers every key
export const hyperfyEvents: PluginEvents & MessageEventHandlers = {
  [hyperfyEventType.MESSAGE_RECEIVED]: [onMessage],
  [hyperfyEventType.VOICE_MESSAGE_RECEIVED]: [onMessage],
};
