import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelType } from '@elizaos/core';
import { elevenLabsSpeechPlugin } from './elevenlabs-speech';
import { UsageBudget, resetUsageBudget } from './usage-budget';

/*
 * The registered TEXT_TO_SPEECH model (what other plugins call) through its real request code,
 * with only the provider's answer replaced: what a request counts as against
 * VOICE_TTS_MAX_CHARS_PER_DAY is the rule Hyperfy voice follows (utils.ts generateSpeech).
 */

const models = elevenLabsSpeechPlugin.models as Record<string, (rt: unknown, input: unknown) => Promise<unknown>>;
const budgetWith = (ttsCharsPerDay: number) =>
  new UsageBudget({ aiCallsPerHour: null, aiTokensPerDay: null, visionPerHour: null, ttsCharsPerDay, sttSecondsPerDay: null, autonomyAiPerHour: null, autonomyAiMinIntervalMs: 0 });

function provider(answer: () => Response | Promise<Response>) {
  vi.stubEnv('ELEVENLABS_XI_API_KEY', 'test-key');
  for (const method of ['log', 'error'] as const) vi.spyOn(console, method).mockImplementation(() => {});
  const fetch = vi.fn(async (_url: string) => answer());
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetUsageBudget();
});

describe('registered TEXT_TO_SPEECH and the daily character limit', () => {
  it.each([400, 401, 403, 422, 429])('gives back the characters of a request ElevenLabs refused with %i', async (status) => {
    const budget = budgetWith(10);
    resetUsageBudget(budget);
    const fetch = provider(() => new Response('{"detail":"no"}', { status }));
    await expect(models[ModelType.TEXT_TO_SPEECH]({}, '1234567890')).rejects.toThrow('synthesis failed');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(budget.snapshot(60_000).ttsChars).toBe(0);
    // ...so the same text still fits the limit afterwards
    fetch.mockImplementation(async () => new Response(Buffer.from('mp3'), { status: 200 }));
    await expect(models[ModelType.TEXT_TO_SPEECH]({}, '1234567890')).resolves.toBeDefined();
    expect(budget.snapshot(60_000).ttsChars).toBe(10);
  });

  it.each([
    ['a 500 answer', () => new Response('oops', { status: 500 })],
    ['a 408 answer', () => new Response('late', { status: 408 })],
    ['a connection error', () => Promise.reject(new TypeError('fetch failed'))],
  ])('keeps the characters of a request that ended in %s counted: it may have been billed', async (_what, answer) => {
    const budget = budgetWith(10);
    resetUsageBudget(budget);
    const fetch = provider(answer);
    await expect(models[ModelType.TEXT_TO_SPEECH]({}, '1234567890')).rejects.toThrow('synthesis failed');
    expect(budget.snapshot(60_000).ttsChars).toBe(10);
    // The limit has no room for the same text again: no second request is made
    await expect(models[ModelType.TEXT_TO_SPEECH]({}, '1234567890')).rejects.toThrow('limit reached');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
