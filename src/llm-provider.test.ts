import { describe, expect, it } from 'vitest';
import { planModelPlugins } from './llm-provider';

const SQL = '@elizaos/plugin-sql';

describe('planModelPlugins', () => {
  it('this deployment: Claude writes text and only the SQL plugin is loaded by name', () => {
    expect(planModelPlugins({ LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'k', ELEVENLABS_XI_API_KEY: 'e' })).toEqual({
      packages: [SQL],
      textProvider: 'anthropic',
    });
  });

  it('defaults to Claude without LLM_PROVIDER, and ignores keys of providers it no longer loads', () => {
    expect(planModelPlugins({ ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'o', GROQ_API_KEY: 'g', OLLAMA_API_ENDPOINT: 'http://x' })).toEqual({
      packages: [SQL],
      textProvider: 'anthropic',
    });
  });

  it('is case and whitespace insensitive', () => {
    expect(planModelPlugins({ LLM_PROVIDER: ' Anthropic ', ANTHROPIC_API_KEY: 'k' }).textProvider).toBe('anthropic');
  });

  it('rejects providers that are no longer supported', () => {
    for (const provider of ['openai', 'ollama', 'groq', 'gemini']) {
      expect(() => planModelPlugins({ LLM_PROVIDER: provider, ANTHROPIC_API_KEY: 'k' })).toThrow('Unsupported LLM_PROVIDER');
    }
  });

  it('refuses to start without a Claude key, instead of an agent that cannot reply', () => {
    expect(() => planModelPlugins({})).toThrow('ANTHROPIC_API_KEY is required');
    expect(() => planModelPlugins({ LLM_PROVIDER: 'anthropic' })).toThrow('ANTHROPIC_API_KEY is required');
    expect(() => planModelPlugins({ LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: '  ' })).toThrow('ANTHROPIC_API_KEY is required');
  });
});

describe('elizaOS honors plugin priority over init order', () => {
  it('serves TEXT_LARGE from the priority plugin even when another plugin finishes init first', async () => {
    const { AgentRuntime, ModelType } = await import('@elizaos/core');
    const fast = { name: 'fast', description: '', init: async () => {}, models: { [ModelType.TEXT_LARGE]: async () => 'fast' } };
    const preferred = {
      name: 'preferred',
      description: '',
      priority: 100,
      init: () => new Promise<void>((resolve) => setTimeout(resolve, 50)),
      models: { [ModelType.TEXT_LARGE]: async () => 'preferred' },
    };
    const runtime = new AgentRuntime({ character: { name: 'probe', bio: [], plugins: [] } as any, plugins: [fast, preferred] as any });
    // initialize registers every plugin, then stops for lack of a database adapter
    await runtime.initialize().catch(() => {});
    expect((runtime as any).models.get(ModelType.TEXT_LARGE).map((m: any) => m.provider)).toEqual(['preferred', 'fast']);
  });
});
