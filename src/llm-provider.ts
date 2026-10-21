type Env = Record<string, string | undefined>;

/** Text generation is Claude only, served by src/anthropic-models.ts. */
export const TEXT_PROVIDERS = ['anthropic'] as const;
export type TextProvider = (typeof TEXT_PROVIDERS)[number];

export interface ModelPluginPlan {
  /** Plugin packages to load by name (character.plugins). */
  packages: string[];
  /** Provider whose text/object handlers must win; loaded as an object with raised priority. */
  textProvider: TextProvider;
}

/**
 * Decides which model plugins to load. Without a text model elizaOS would start an agent that fails
 * on every reply, so a missing or unsupported choice stops the start with a clear reason instead.
 */
export function planModelPlugins(env: Env): ModelPluginPlan {
  const requested = env.LLM_PROVIDER?.trim().toLowerCase() || undefined;
  if (requested && !(TEXT_PROVIDERS as readonly string[]).includes(requested)) {
    throw new Error(`Unsupported LLM_PROVIDER "${env.LLM_PROVIDER}". Use one of: ${TEXT_PROVIDERS.join(', ')}.`);
  }
  if (!env.ANTHROPIC_API_KEY?.trim()) {
    throw new Error('ANTHROPIC_API_KEY is required: Coo writes with Claude.');
  }
  // Speech goes to ElevenLabs directly (src/elevenlabs-speech.ts); no embedding model is loaded, which
  // elizaOS and the Hyperfy message handler tolerate.
  return { packages: ['@elizaos/plugin-sql'], textProvider: 'anthropic' };
}
