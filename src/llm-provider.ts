export const TEXT_PROVIDERS = ['anthropic', 'openai', 'ollama', 'groq'] as const;
export type TextProvider = (typeof TEXT_PROVIDERS)[number];

/** Packages loaded by name; anthropic is served by src/anthropic-models.ts instead. */
export const PROVIDER_PACKAGES: Record<Exclude<TextProvider, 'anthropic'>, string> = {
  openai: '@elizaos/plugin-openai',
  ollama: '@elizaos/plugin-ollama',
  groq: '@elizaos/plugin-groq',
};

export interface ModelPluginPlan {
  /** Plugin packages to load by name (character.plugins). */
  packages: string[];
  /** Provider whose text/object handlers must win; loaded as an object with raised priority. */
  textProvider: TextProvider | null;
  /** Whether any loaded plugin can create embeddings (Claude, Groq and ElevenLabs cannot). */
  hasEmbeddingProvider: boolean;
}

type Env = Record<string, string | undefined>;

/**
 * Decides which model plugins to load. Several can be loaded at once (OpenAI for embeddings and
 * transcription, ElevenLabs for speech), and elizaOS otherwise hands text generation to whichever
 * plugin finishes init first, so the chosen text provider is returned separately to be given priority.
 */
export function planModelPlugins(env: Env): ModelPluginPlan {
  const requested = env.LLM_PROVIDER?.trim().toLowerCase() || undefined;
  if (requested && !(TEXT_PROVIDERS as readonly string[]).includes(requested)) {
    throw new Error(`Unsupported LLM_PROVIDER "${env.LLM_PROVIDER}". Use one of: ${TEXT_PROVIDERS.join(', ')}.`);
  }
  const anthropicKey = env.ANTHROPIC_API_KEY?.trim();
  if (requested === 'anthropic' && !anthropicKey) {
    throw new Error('LLM_PROVIDER=anthropic requires ANTHROPIC_API_KEY.');
  }
  // Without an explicit choice, prefer Claude when its key is present (as before, when plugin-anthropic was loaded).
  const textProvider = (requested as TextProvider | undefined) ?? (anthropicKey ? 'anthropic' : null);

  const loaded = new Set<string>();
  if (env.GROQ_API_KEY) loaded.add(PROVIDER_PACKAGES.groq);
  if (env.OPENAI_API_KEY) loaded.add(PROVIDER_PACKAGES.openai);
  // Ollama also provides embeddings, so it stays loaded when configured even if another provider writes text.
  if (env.OLLAMA_SERVER_URL || env.OLLAMA_MODEL || env.OLLAMA_API_ENDPOINT) loaded.add(PROVIDER_PACKAGES.ollama);
  // @elizaos/plugin-elevenlabs is not loaded: its TRANSCRIPTION handler calls .../v1/v1/speech-to-text (404)
  // and would outrank OpenAI. Speech goes to ElevenLabs directly (src/plugin-hyperfy/utils.ts).
  // The preferred package is loaded as an object instead (see src/index.ts)
  if (textProvider && textProvider !== 'anthropic') loaded.delete(PROVIDER_PACKAGES[textProvider]);

  const hasEmbeddingProvider =
    loaded.has(PROVIDER_PACKAGES.openai) || loaded.has(PROVIDER_PACKAGES.ollama) ||
    textProvider === 'openai' || textProvider === 'ollama';

  return { packages: ['@elizaos/plugin-sql', ...loaded], textProvider, hasEmbeddingProvider };
}
