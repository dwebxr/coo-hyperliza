import type { ActionResult, Content, HandlerCallback } from '@elizaos/core';
import { currentTurn } from './turn-context';

/*
 * What an action handler returns to core's processActions (elizaOS core 1.7.2), which stores it in
 * the action's memory (content.actionStatus "completed" or "failed", and content.actionResult).
 * Core treats a return value as an ActionResult only when it has `values`, `data` or `text`:
 * a handler that returns nothing or a boolean is stored as "failed" whatever happened, and an
 * object with only `success: false` is stored as "completed". So both helpers always set `data`.
 * Neither sets `text`: core would store it as the memory's text, which the Hyperfy world
 * provider puts in the chat history it shows the model, as a line the agent said.
 */

/** The action did what it was asked to. */
export function actionSucceeded(actionName: string, data: Record<string, unknown> = {}): ActionResult {
  return { success: true, data: { ...data, actionName } };
}

/** The action could not do what it was asked to; `error` says why. */
export function actionFailed(actionName: string, error: string, data: Record<string, unknown> = {}): ActionResult {
  return { success: false, error, data: { ...data, actionName } };
}

/**
 * Tells whoever asked for the action that it could not be done. An autonomous turn says nothing:
 * nobody asked, and its callback would post the text to world chat.
 */
export async function tellFailure(
  callback: HandlerCallback | undefined,
  actionName: string,
  text: string,
  extra: Partial<Content> = {}
): Promise<void> {
  if (currentTurn()?.origin === 'autonomy') return;
  await callback?.({ ...extra, text, actions: [actionName], source: 'hyperfy' });
}
