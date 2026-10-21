import Anthropic from '@anthropic-ai/sdk';
import { jsonrepair } from 'jsonrepair';
import {
  type GenerateTextParams,
  type IAgentRuntime,
  type ImageDescriptionParams,
  type ModelTypeName,
  type ObjectGenerationParams,
  type Plugin,
  EventType,
  ModelType,
  logger,
} from '@elizaos/core';

/**
 * Text/JSON generation with current Claude models.
 *
 * Replaces @elizaos/plugin-anthropic for TEXT_* and OBJECT_*: that plugin always sends
 * `temperature`, which current models reject, and its default model IDs are retired.
 * Supports what this project's callers use: non-streaming text, JSON objects requested in the
 * prompt (`schema` / `output` / `enumValues` are not enforced), and image description.
 * Streaming requests get the full text in one piece.
 */

const DEFAULT_MODEL = 'claude-haiku-5-5';
const DEFAULT_EFFORT: Effort = 'low';
const DEFAULT_MAX_TOKENS = 16000;
const IMAGE_DESCRIPTION_MAX_TOKENS = 4096;
// The agent talks in real time and holds an activity lock while generating; this deadline
// covers SDK retries, Retry-After waits and reading the response body.
const GENERATION_DEADLINE_MS = 60_000;

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
type Effort = (typeof EFFORTS)[number];
type Size = 'SMALL' | 'LARGE';

export class AnthropicRefusalError extends Error {
  constructor(model: string, category: string | null | undefined) {
    super(`[Anthropic] ${model} declined the request (${category ?? 'no category'})`);
    this.name = 'AnthropicRefusalError';
  }
}

// Keyed by API key so a changed secret takes effect and runtimes don't share credentials.
const clients = new Map<string, Anthropic>();

function getClient(runtime: IAgentRuntime): Anthropic {
  const apiKey = getSetting(runtime, 'ANTHROPIC_API_KEY', '');
  let client = clients.get(apiKey);
  if (!client) {
    // Without an explicit key the SDK falls back to ANTHROPIC_API_KEY / other credentials in the environment.
    // This always runs in Node, but the Hyperfy loader (systems/loader.ts) installs a fake global
    // window/document at import time, which the SDK's browser check would otherwise refuse.
    client = new Anthropic({ ...(apiKey ? { apiKey } : {}), dangerouslyAllowBrowser: true });
    clients.set(apiKey, client);
  }
  return client;
}

function getSetting(runtime: IAgentRuntime, key: string, fallback: string): string {
  // .env wins: elizaOS stores a copy of the environment in the agent's database record and
  // runtime.getSetting prefers that copy, so a key changed in .env would otherwise be ignored
  // (an old, revoked Anthropic key kept failing with 401 invalid x-api-key).
  const value = process.env[key]?.trim() || runtime.getSetting(key);
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

// An invalid value would make every request fail with a 400, silencing the agent
function getEffort(runtime: IAgentRuntime): Effort {
  const raw = getSetting(runtime, 'ANTHROPIC_EFFORT', DEFAULT_EFFORT).toLowerCase();
  if ((EFFORTS as readonly string[]).includes(raw)) return raw as Effort;
  logger.warn(`[Anthropic] Ignoring invalid ANTHROPIC_EFFORT "${raw}"; using "${DEFAULT_EFFORT}"`);
  return DEFAULT_EFFORT;
}

async function generate(
  runtime: IAgentRuntime,
  size: Size,
  modelType: ModelTypeName,
  {
    prompt,
    content,
    system,
    stopSequences,
    maxTokens,
  }: { prompt: string; content?: Anthropic.ContentBlockParam[]; system?: string; stopSequences?: string[]; maxTokens?: number }
): Promise<string> {
  const model = getSetting(runtime, `ANTHROPIC_${size}_MODEL`, DEFAULT_MODEL);
  const effort = getEffort(runtime);
  // The API rejects empty or whitespace-only stop sequences
  const stops = (stopSequences ?? []).filter((s) => s.trim());

  const response = await getClient(runtime).messages.create(
    {
      model,
      max_tokens: maxTokens ?? DEFAULT_MAX_TOKENS,
      ...(system ? { system } : {}),
      ...(stops.length ? { stop_sequences: stops } : {}),
      output_config: { effort },
      messages: [{ role: 'user', content: content ?? prompt }],
    },
    { signal: AbortSignal.timeout(GENERATION_DEADLINE_MS), maxRetries: 1 }
  );

  // Billed even when the output turns out unusable
  runtime
    .emitEvent(EventType.MODEL_USED, {
      provider: 'anthropic',
      type: modelType,
      prompt,
      tokens: {
        prompt: response.usage.input_tokens,
        completion: response.usage.output_tokens,
        total: response.usage.input_tokens + response.usage.output_tokens,
      },
    } as any)
    .catch((error) => logger.warn('[Anthropic] MODEL_USED handler failed:', error));

  if (response.stop_reason === 'refusal') {
    // Thrown rather than returned so callers' retry loops don't resend the same request
    throw new AnthropicRefusalError(model, response.stop_details?.category);
  }
  return response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

/** The complete {...} or [...] starting at `start`, respecting strings; null if it never closes. */
function balancedFrom(text: string, start: number): string | null {
  const stack: string[] = [];
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === '{' || ch === '[') {
      stack.push(ch === '{' ? '}' : ']');
    } else if (ch === '}' || ch === ']') {
      if (stack.pop() !== ch) return null;
      if (stack.length === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Places JSON could be, most complete first: a fenced block, the whole reply, then top-level bracketed spans. */
function jsonCandidates(text: string): string[] {
  const candidates: string[] = [];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  if (fenced) candidates.push(fenced);
  const whole = text.trim();
  if (/^[[{]/.test(whole)) candidates.push(whole);
  // Only top-level spans: a valid nested object must not win over its (repairable) parent
  for (let i = 0; i < text.length && candidates.length < 20; i++) {
    if (text[i] === '{' || text[i] === '[') {
      const span = balancedFrom(text, i);
      if (span) {
        candidates.push(span);
        i += span.length - 1;
      }
    }
  }
  return [...new Set(candidates)];
}

/** Whether a bracketed span starts like JSON rather than prose such as "[result]". */
function looksLikeJson(candidate: string): boolean {
  const body = candidate.slice(1).trimStart();
  return candidate.startsWith('{')
    ? /^["'}A-Za-z_$]/.test(body)
    : /^(["'\[{\]\d-]|true\b|false\b|null\b)/.test(body);
}

const isObjectOrArray = (value: unknown): boolean => value !== null && typeof value === 'object';

/**
 * Parses a JSON object or array from a reply. Tolerates a markdown fence, prose around the JSON,
 * and the small mistakes models copy from prompt examples (comments, trailing commas).
 */
export function parseJsonResponse(text: string): any {
  for (const candidate of jsonCandidates(text)) {
    try {
      const parsed = JSON.parse(candidate);
      if (isObjectOrArray(parsed)) return parsed;
      continue;
    } catch {
      // try repairing this candidate before moving on
    }
    // jsonrepair turns almost any text into *some* JSON, so only repair JSON-looking spans
    if (!looksLikeJson(candidate)) continue;
    try {
      const repaired = JSON.parse(jsonrepair(candidate));
      if (isObjectOrArray(repaired)) return repaired;
    } catch {
      // try the next candidate
    }
  }
  throw new Error(`[Anthropic] Model did not return valid JSON: ${text.slice(0, 200)}`);
}

async function generateText(runtime: IAgentRuntime, size: Size, params: GenerateTextParams): Promise<string> {
  if (params.stream) {
    // Core falls back to the returned value when there is no textStream
    logger.debug('[Anthropic] Streaming requested; returning the full text instead');
  }
  return generate(runtime, size, size === 'SMALL' ? ModelType.TEXT_SMALL : ModelType.TEXT_LARGE, {
    prompt: params.prompt,
    system: runtime.character.system ?? undefined,
    stopSequences: params.stopSequences,
    maxTokens: params.maxTokens,
  });
}

/** Accepts an http(s) URL, a data: URL, or bare base64 (what the Puppeteer snapshots return). */
export function toImageSource(image: string): Anthropic.ImageBlockParam['source'] {
  if (/^https?:\/\//.test(image)) return { type: 'url', url: image };
  const dataUrl = image.match(/^data:(image\/[a-z+]+);base64,(.*)$/s);
  if (dataUrl) {
    return { type: 'base64', media_type: dataUrl[1] as Anthropic.Base64ImageSource['media_type'], data: dataUrl[2] };
  }
  const media_type = image.startsWith('iVBOR') ? 'image/png' : image.startsWith('R0lGOD') ? 'image/gif' : image.startsWith('UklGR') ? 'image/webp' : 'image/jpeg';
  return { type: 'base64', media_type, data: image };
}

async function describeImage(
  runtime: IAgentRuntime,
  params: ImageDescriptionParams | string
): Promise<{ title: string; description: string }> {
  const { imageUrl, prompt } = typeof params === 'string' ? { imageUrl: params, prompt: undefined } : params;
  const instruction = prompt || 'Describe this image in detail.';
  const description = await generate(runtime, 'LARGE', ModelType.IMAGE_DESCRIPTION, {
    prompt: instruction,
    content: [
      { type: 'image', source: toImageSource(imageUrl) },
      { type: 'text', text: instruction },
    ],
    maxTokens: IMAGE_DESCRIPTION_MAX_TOKENS,
  });
  return { title: 'Image description', description };
}

async function generateObject(runtime: IAgentRuntime, size: Size, params: ObjectGenerationParams): Promise<any> {
  let prompt = params.prompt;
  if (!prompt.includes('```json') && !prompt.includes('respond with valid JSON')) {
    prompt += '\nPlease respond with valid JSON only, without any explanations, markdown formatting, or additional text.';
  }
  const system = `${runtime.character.system ? `${runtime.character.system}\n` : ''}You must respond with valid JSON only. No markdown, no code blocks, no explanation text.`;
  const text = await generate(runtime, size, size === 'SMALL' ? ModelType.OBJECT_SMALL : ModelType.OBJECT_LARGE, {
    prompt,
    system,
    stopSequences: params.stopSequences,
    // Not in ObjectGenerationParams, but core injects it from model settings
    maxTokens: (params as ObjectGenerationParams & { maxTokens?: number }).maxTokens,
  });
  return parseJsonResponse(text);
}

export const anthropicModelsPlugin: Plugin = {
  name: 'anthropic-models',
  description: 'Claude text and JSON generation through the official Anthropic SDK',
  // Outranks any other plugin that registers the same model types (elizaOS otherwise picks by init order).
  priority: 100,
  models: {
    [ModelType.TEXT_SMALL]: (runtime: IAgentRuntime, params: GenerateTextParams) => generateText(runtime, 'SMALL', params),
    [ModelType.TEXT_LARGE]: (runtime: IAgentRuntime, params: GenerateTextParams) => generateText(runtime, 'LARGE', params),
    [ModelType.OBJECT_SMALL]: (runtime: IAgentRuntime, params: ObjectGenerationParams) => generateObject(runtime, 'SMALL', params),
    [ModelType.OBJECT_LARGE]: (runtime: IAgentRuntime, params: ObjectGenerationParams) => generateObject(runtime, 'LARGE', params),
    [ModelType.IMAGE_DESCRIPTION]: (runtime: IAgentRuntime, params: ImageDescriptionParams | string) => describeImage(runtime, params),
  },
};
