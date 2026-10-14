import { describe, expect, it } from 'vitest';
import { isTwitterDiscoveryEnabled, planModelPlugins } from './llm-provider';

const SQL = '@elizaos/plugin-sql';
const OPENAI = '@elizaos/plugin-openai';
const OLLAMA = '@elizaos/plugin-ollama';
const GROQ = '@elizaos/plugin-groq';
const ELEVEN = '@elizaos/plugin-elevenlabs';

describe('planModelPlugins', () => {
  it('this deployment: Claude writes text, no OpenAI/Ollama, and never the broken ElevenLabs plugin', () => {
    expect(planModelPlugins({ LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'k', ELEVENLABS_XI_API_KEY: 'e' })).toEqual({
      packages: [SQL],
      textProvider: 'anthropic',
      hasEmbeddingProvider: false,
    });
    expect(planModelPlugins({ ELEVENLABS_XI_API_KEY: 'e', OPENAI_API_KEY: 'o' }).packages).not.toContain(ELEVEN);
  });

  it('defaults to Claude when its key is present', () => {
    expect(planModelPlugins({ ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'o' })).toEqual({
      packages: [SQL, OPENAI],
      textProvider: 'anthropic',
      hasEmbeddingProvider: true,
    });
  });

  it('keeps a configured Ollama loaded (for embeddings) when another provider writes text', () => {
    const plan = planModelPlugins({ LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'k', OLLAMA_API_ENDPOINT: 'http://x' });
    expect(plan.packages).toContain(OLLAMA);
    expect(plan.textProvider).toBe('anthropic');
  });

  it.each([
    ['ollama', { OLLAMA_API_ENDPOINT: 'http://x', OPENAI_API_KEY: 'o' }, OLLAMA],
    ['openai', { OPENAI_API_KEY: 'o', ANTHROPIC_API_KEY: 'k' }, OPENAI],
    ['groq', { GROQ_API_KEY: 'g', OPENAI_API_KEY: 'o' }, GROQ],
  ])('LLM_PROVIDER=%s is loaded separately (to get priority) and not by name', (provider, env, pkg) => {
    const plan = planModelPlugins({ LLM_PROVIDER: provider, ...env });
    expect(plan.textProvider).toBe(provider);
    expect(plan.packages).not.toContain(pkg);
  });

  it('knows whether anything can create embeddings (X discovery needs them)', () => {
    expect(planModelPlugins({ ANTHROPIC_API_KEY: 'k', GROQ_API_KEY: 'g' }).hasEmbeddingProvider).toBe(false);
    expect(planModelPlugins({ ANTHROPIC_API_KEY: 'k', OLLAMA_API_ENDPOINT: 'http://x' }).hasEmbeddingProvider).toBe(true);
    expect(planModelPlugins({ LLM_PROVIDER: 'ollama' }).hasEmbeddingProvider).toBe(true);
  });

  it('is case and whitespace insensitive', () => {
    expect(planModelPlugins({ LLM_PROVIDER: ' Ollama ' }).textProvider).toBe('ollama');
  });

  it('leaves the choice to elizaOS when nothing selects a provider', () => {
    expect(planModelPlugins({ OPENAI_API_KEY: 'o' })).toEqual({ packages: [SQL, OPENAI], textProvider: null, hasEmbeddingProvider: true });
  });

  it('rejects unknown providers and Claude without a key', () => {
    expect(() => planModelPlugins({ LLM_PROVIDER: 'gemini' })).toThrow('Unsupported LLM_PROVIDER');
    expect(() => planModelPlugins({ LLM_PROVIDER: 'anthropic' })).toThrow('requires ANTHROPIC_API_KEY');
    expect(() => planModelPlugins({ LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: '  ' })).toThrow('requires ANTHROPIC_API_KEY');
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

describe('isTwitterDiscoveryEnabled', () => {
  it('matches plugin-twitter: explicit true, or actions on and not explicitly false', () => {
    const key = { TWITTER_API_KEY: 'k' };
    expect(isTwitterDiscoveryEnabled({ ...key, TWITTER_ENABLE_DISCOVERY: 'true' })).toBe(true);
    expect(isTwitterDiscoveryEnabled({ ...key })).toBe(false);
    expect(isTwitterDiscoveryEnabled({ ...key, TWITTER_ENABLE_ACTIONS: 'true' })).toBe(true);
    expect(isTwitterDiscoveryEnabled({ ...key, TWITTER_ENABLE_ACTIONS: 'true', TWITTER_ENABLE_DISCOVERY: 'false' })).toBe(false);
    expect(isTwitterDiscoveryEnabled({ TWITTER_ENABLE_DISCOVERY: 'true' })).toBe(false);
  });
});
