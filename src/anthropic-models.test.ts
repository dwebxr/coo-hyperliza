import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventType, ModelType } from '@elizaos/core';

const create = vi.fn();
const constructed: any[] = [];
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create };
    constructor(options: any) {
      constructed.push(options);
    }
  },
}));

import { AnthropicRefusalError, anthropicModelsPlugin, parseJsonResponse, toImageSource } from './anthropic-models';

function runtime(settings: Record<string, string> = {}): any {
  return {
    getSetting: (key: string) => settings[key],
    character: { system: 'You are Coo.' },
    emitEvent: vi.fn().mockResolvedValue(undefined),
  };
}
const usage = { input_tokens: 12, output_tokens: 3 };
const reply = (content: any[], stop_reason = 'end_turn') => ({ content, stop_reason, usage });
const models = anthropicModelsPlugin.models as Record<string, (rt: any, params: any) => Promise<any>>;

describe('anthropicModelsPlugin', () => {
  beforeEach(() => {
    create.mockReset();
    create.mockResolvedValue(reply([{ type: 'text', text: 'ok' }]));
  });

  it('never sends sampling parameters, which current models reject', async () => {
    await models[ModelType.TEXT_LARGE](runtime(), { prompt: 'hello', temperature: 0.7, frequencyPenalty: 0.7, presencePenalty: 0.7 });
    const body = create.mock.calls[0][0];
    for (const key of ['temperature', 'top_p', 'top_k', 'frequency_penalty', 'presence_penalty']) {
      expect(body).not.toHaveProperty(key);
    }
  });

  it('uses Haiku 5.5 at low effort by default, and the configured models otherwise', async () => {
    await models[ModelType.TEXT_SMALL](runtime(), { prompt: 'a' });
    expect(create.mock.calls[0][0]).toMatchObject({ model: 'claude-haiku-5-5', output_config: { effort: 'low' }, system: 'You are Coo.' });

    await models[ModelType.TEXT_LARGE](runtime({ ANTHROPIC_LARGE_MODEL: 'claude-sonnet-5-5', ANTHROPIC_EFFORT: 'medium' }), { prompt: 'b' });
    expect(create.mock.calls[1][0]).toMatchObject({ model: 'claude-sonnet-5-5', output_config: { effort: 'medium' } });
  });

  it('bounds each generation with one overall deadline and a single retry', async () => {
    await models[ModelType.TEXT_SMALL](runtime(), { prompt: 'a' });
    const options = create.mock.calls[0][1];
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.maxRetries).toBe(1);
  });

  it('returns only text blocks (thinking blocks are skipped)', async () => {
    create.mockResolvedValue(reply([{ type: 'thinking', thinking: '' }, { type: 'text', text: 'Hello' }, { type: 'text', text: '!' }]));
    await expect(models[ModelType.TEXT_SMALL](runtime(), { prompt: 'x' })).resolves.toBe('Hello!');
  });

  it('forwards maxTokens and non-empty stop sequences', async () => {
    await models[ModelType.TEXT_SMALL](runtime(), { prompt: 'x', maxTokens: 256, stopSequences: ['', '  ', '</response>'] });
    expect(create.mock.calls[0][0]).toMatchObject({ max_tokens: 256, stop_sequences: ['</response>'] });

    await models[ModelType.TEXT_SMALL](runtime(), { prompt: 'x', stopSequences: [] });
    expect(create.mock.calls[1][0]).not.toHaveProperty('stop_sequences');
  });

  it('answers streaming requests with the full text', async () => {
    await expect(models[ModelType.TEXT_SMALL](runtime(), { prompt: 'x', stream: true })).resolves.toBe('ok');
  });

  it('falls back to low effort for an invalid ANTHROPIC_EFFORT instead of failing every request', async () => {
    await models[ModelType.TEXT_SMALL](runtime({ ANTHROPIC_EFFORT: 'lowest' }), { prompt: 'x' });
    await models[ModelType.TEXT_SMALL](runtime({ ANTHROPIC_EFFORT: 'High' }), { prompt: 'x' });
    expect(create.mock.calls.map((c) => c[0].output_config.effort)).toEqual(['low', 'high']);
  });

  it('emits MODEL_USED with token counts, like plugin-anthropic did', async () => {
    const rt = runtime();
    await models[ModelType.TEXT_LARGE](rt, { prompt: 'hello' });
    expect(rt.emitEvent).toHaveBeenCalledWith(EventType.MODEL_USED, {
      provider: 'anthropic',
      type: ModelType.TEXT_LARGE,
      prompt: 'hello',
      tokens: { prompt: 12, completion: 3, total: 15 },
    });
  });

  it('throws a refusal error (after reporting usage) so retry loops stop', async () => {
    create.mockResolvedValue({ ...reply([], 'refusal'), stop_details: { category: 'cyber' } });
    const rt = runtime();
    await expect(models[ModelType.TEXT_LARGE](rt, { prompt: 'x' })).rejects.toBeInstanceOf(AnthropicRefusalError);
    await expect(models[ModelType.OBJECT_LARGE](rt, { prompt: 'x' })).rejects.toBeInstanceOf(AnthropicRefusalError);
    expect(rt.emitEvent).toHaveBeenCalledTimes(2);
  });

  it('reuses a client per API key and picks up a changed key', async () => {
    constructed.length = 0;
    await models[ModelType.TEXT_SMALL](runtime({ ANTHROPIC_API_KEY: 'key-a' }), { prompt: 'x' });
    await models[ModelType.TEXT_SMALL](runtime({ ANTHROPIC_API_KEY: 'key-a' }), { prompt: 'x' });
    await models[ModelType.TEXT_SMALL](runtime({ ANTHROPIC_API_KEY: 'key-b' }), { prompt: 'x' });
    expect(constructed.map((o) => o.apiKey)).toEqual(['key-a', 'key-b']);
  });

  it('works next to the fake window/document the Hyperfy loader installs', async () => {
    constructed.length = 0;
    await models[ModelType.TEXT_SMALL](runtime({ ANTHROPIC_API_KEY: 'key-c' }), { prompt: 'x' });
    expect(constructed[0].dangerouslyAllowBrowser).toBe(true);
  });

  it('OBJECT_* forwards the maxTokens core injects from model settings', async () => {
    create.mockResolvedValue(reply([{ type: 'text', text: '{"a":1}' }]));
    await models[ModelType.OBJECT_SMALL](runtime(), { prompt: 'x', maxTokens: 256 });
    expect(create.mock.calls[0][0].max_tokens).toBe(256);
  });

  it('OBJECT_* asks for JSON and parses fenced output', async () => {
    create.mockResolvedValue(reply([{ type: 'text', text: '```json\n{"entity": "abc"}\n```' }]));
    await expect(models[ModelType.OBJECT_LARGE](runtime(), { prompt: 'Where?' })).resolves.toEqual({ entity: 'abc' });
    const body = create.mock.calls[0][0];
    expect(body.system).toContain('valid JSON only');
    expect(body.messages[0].content).toContain('respond with valid JSON only');
  });

  it('IMAGE_DESCRIPTION sends the snapshot to Claude and returns a description', async () => {
    create.mockResolvedValue(reply([{ type: 'text', text: 'A fountain in a plaza.' }]));
    const result = await models[ModelType.IMAGE_DESCRIPTION](runtime(), { imageUrl: '/9j/4AAQSkZJRg==', prompt: 'What do you see?' });
    expect(result).toEqual({ title: 'Image description', description: 'A fountain in a plaza.' });
    const content = create.mock.calls[0][0].messages[0].content;
    expect(content[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: '/9j/4AAQSkZJRg==' } });
    expect(content[1]).toEqual({ type: 'text', text: 'What do you see?' });
  });

  it('IMAGE_DESCRIPTION also accepts a bare image string', async () => {
    create.mockResolvedValue(reply([{ type: 'text', text: 'A tree.' }]));
    const result = await models[ModelType.IMAGE_DESCRIPTION](runtime(), 'https://x.test/a.png');
    expect(result.description).toBe('A tree.');
    expect(create.mock.calls[0][0].messages[0].content[0].source).toEqual({ type: 'url', url: 'https://x.test/a.png' });
  });
});

describe('toImageSource', () => {
  it('handles URLs, data URLs and bare base64', () => {
    expect(toImageSource('https://x.test/a.png')).toEqual({ type: 'url', url: 'https://x.test/a.png' });
    expect(toImageSource('data:image/png;base64,iVBORw0KGgo=')).toEqual({ type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' });
    expect(toImageSource('iVBORw0KGgo=')).toMatchObject({ media_type: 'image/png' });
    expect(toImageSource('/9j/4AAQ')).toMatchObject({ media_type: 'image/jpeg' });
  });
});

describe('parseJsonResponse', () => {
  it('parses plain, fenced, and prose-wrapped JSON', () => {
    expect(parseJsonResponse('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonResponse('```\n[1,2]\n```')).toEqual([1, 2]);
    expect(parseJsonResponse('Sure! {"a": {"b": "}"}} Hope that helps')).toEqual({ a: { b: '}' } });
    expect(parseJsonResponse('[result] {"entityId": "abc"}')).toEqual({ entityId: 'abc' });
  });

  it('repairs comments and trailing commas copied from prompt examples', () => {
    // actions/use.ts shows `"entityId": "<string>" // or null if none`
    expect(parseJsonResponse('{\n  "entityId": null // or null if none\n}')).toEqual({ entityId: null });
    expect(parseJsonResponse('{"a": 1, "b": [1, 2,],}')).toEqual({ a: 1, b: [1, 2] });
  });

  it('repairs the complete value instead of returning a valid nested fragment', () => {
    // goto.ts needs navigationType + parameter, not just the inner object
    expect(parseJsonResponse('{"navigationType":"entity","parameter":{"entityId":"abc"},}')).toEqual({
      navigationType: 'entity',
      parameter: { entityId: 'abc' },
    });
    expect(parseJsonResponse('[result] {"entityId":"abc",}')).toEqual({ entityId: 'abc' });
  });

  it('throws when there is no JSON object or array, even if a primitive parses or repair could make one', () => {
    expect(() => parseJsonResponse('no json here')).toThrow('did not return valid JSON');
    expect(() => parseJsonResponse('```\nhello\n```')).toThrow('did not return valid JSON');
    expect(() => parseJsonResponse('```json\nnull\n```')).toThrow('did not return valid JSON');
    expect(() => parseJsonResponse('```json\n"some text"\n```')).toThrow('did not return valid JSON');
    expect(() => parseJsonResponse('[result]')).toThrow('did not return valid JSON');
  });
});
