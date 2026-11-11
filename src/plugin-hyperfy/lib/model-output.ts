import type { Content, Memory } from '@elizaos/core';

/*
 * Typed reads of loosely shaped model output: core's parseKeyValueXml (lists for actions,
 * providers and evaluators, a boolean for simple, strings for everything else) and the
 * Record<string, unknown> that OBJECT_SMALL/OBJECT_LARGE models return.
 */

/** The value at `key` when it is a string; otherwise undefined. */
export function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' ? value : undefined;
}

/** The value at `key` when it is an array of strings; otherwise undefined. */
export function readStringList(source: Record<string, unknown>, key: string): string[] | undefined {
  const value = source[key];
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : undefined;
}

// Where a planned response carries the words to say
const PLANNED_TEXT_KEYS = ['message', 'text'];

/**
 * The content to send for `actionName` when the response the model already planned names that
 * action and carries non-blank text (in `message`, else `text`), so the action needs no model call
 * of its own. Null otherwise.
 */
export function plannedContent(response: Memory, actionName: string): Content | null {
  if (!response.content.actions?.includes(actionName)) return null;
  const text = PLANNED_TEXT_KEYS.map((key) => readString(response.content, key)).find((value) => !!value?.trim());
  if (!text) return null;
  return { ...response.content, text, actions: [actionName] };
}
