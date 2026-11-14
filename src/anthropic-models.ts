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
import { AiBudgetExceededError, currentOrigin, getUsageBudget, isAiPurpose, maxTokensFor, purposeEnvKey } from './usage-budget';
import { TurnCancelled, assertTurnLive, currentTurn } from './plugin-hyperfy/lib/turn-context';

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
// covers both attempts, the wait between them and reading the response body.
const GENERATION_DEADLINE_MS = 60_000;

/**
 * One more attempt is made only after an answer saying the API did not take the request now (429
 * rate limited, 529 overloaded), which comes before anything is generated. Never after a timeout,
 * a lost connection or another error: the first attempt may then have been answered and billed,
 * and a second would pay twice for one reply. Each attempt is reserved on its own; the SDK itself
 * retries nothing (maxRetries: 0), so every request sent is one the budget admitted.
 */
const RETRY_STATUSES = new Set([429, 529]);
// The wait before it: the answer's retry-after, else this, and never more than RETRY_MAX_WAIT_MS
const RETRY_WAIT_MS = 1000;
const RETRY_MAX_WAIT_MS = 5000;

// Reserved against AI_MAX_TOKENS_PER_DAY on top of the prompt's bytes: the request's own framing
const FRAMING_TOKEN_RESERVE = 64;
// Reserved per attached image. An estimate, not a bound: the API counts an image by its pixels
// after its own downscaling, and nothing here measures the image
const IMAGE_TOKEN_RESERVE = 5000;

/**
 * The most tokens a request can be billed for, as far as that can be known before it is sent:
 * a token is at least one byte of text, so the prompt costs at most its UTF-8 bytes; the output
 * (thinking included) at most `maxOutput`. Images are counted at IMAGE_TOKEN_RESERVE each.
 */
export function tokenReserve(system: string | undefined, content: string | Anthropic.ContentBlockParam[], maxOutput: number): number {
  let reserve = FRAMING_TOKEN_RESERVE + maxOutput + Buffer.byteLength(system ?? '');
  if (typeof content === 'string') return reserve + Buffer.byteLength(content);
  for (const block of content) {
    if (block.type === 'text') reserve += Buffer.byteLength(block.text);
    else if (block.type === 'image') reserve += IMAGE_TOKEN_RESERVE;
    // Nothing else is sent by this module; anything else is counted by its serialized size
    else reserve += Buffer.byteLength(JSON.stringify(block));
  }
  return reserve;
}

/** Whether the API refused the request itself (a 4xx answer), so nothing was generated or billed. */
function wasRejected(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  // 408 and 409 can follow work the API already did
  return typeof status === 'number' && status >= 400 && status < 500 && status !== 408 && status !== 409;
}

/** How long to wait before the one more attempt `error` allows (RETRY_STATUSES), or null for none. */
function retryWait(error: unknown, deadlineAt: number): number | null {
  const { status, headers } = (error ?? {}) as { status?: unknown; headers?: { get?: (name: string) => string | null } };
  if (typeof status !== 'number' || !RETRY_STATUSES.has(status)) return null;
  const header = (name: string) => {
    const value = Number(headers?.get?.(name) ?? NaN);
    return Number.isFinite(value) && value >= 0 ? value : null;
  };
  const afterMs = header('retry-after-ms') ?? (header('retry-after') !== null ? header('retry-after')! * 1000 : null);
  const wait = Math.min(afterMs ?? RETRY_WAIT_MS, RETRY_MAX_WAIT_MS);
  // Not when the answer could not come within the deadline
  return Date.now() + wait < deadlineAt ? wait : null;
}

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
type Effort = (typeof EFFORTS)[number];
type Size = 'SMALL' | 'LARGE';

export class AnthropicRefusalError extends Error {
  constructor(model: string, category: string | null | undefined) {
    // The category comes from the response: only something shaped like the API's labels is repeated
    super(`[Anthropic] ${model} declined the request (${typeof category === 'string' && /^[a-z][a-z_]{0,39}$/.test(category) ? category : 'no category'})`);
    this.name = 'AnthropicRefusalError';
  }
}

// The API's error types, and what each means to whoever runs the agent (the words are ours)
const API_ERROR_TYPES: Record<string, string> = {
  authentication_error: 'the API key was not accepted (expired, revoked or wrong): ANTHROPIC_API_KEY',
  permission_error: 'the API key may not use what was asked for',
  not_found_error: 'not found, usually a model ID that does not exist: ANTHROPIC_LARGE_MODEL / ANTHROPIC_SMALL_MODEL',
  billing_error: 'a billing problem on the account',
  invalid_request_error: 'the API refused the request as invalid; its reason is kept by the API under the request id',
  request_too_large: 'the request was too large',
  rate_limit_error: 'rate limited',
  timeout_error: 'the API timed out',
  overloaded_error: 'the API is overloaded',
  api_error: 'an error inside the API',
};
// Reasons the API gives in its message that have words of ours: the message itself is not repeated
const API_ERROR_REASONS: [RegExp, string][] = [[/credit balance/i, 'no credit left on the account']];
const API_REQUEST_ID = /^req_[A-Za-z0-9]{1,64}$/;

/**
 * An answer of the model API in which it turned a request down, as one line for a log; null when
 * `error` is not one (the SDK's APIError with an HTTP status).
 *
 * Nothing of the answer is repeated as it came: the response body is whatever the server put in
 * it (ANTHROPIC_BASE_URL can name another server than Anthropic's), and its message can quote the
 * request. The line holds the status, the error type when it is one of the API's own, what that
 * type (or a reason recognized in the message) means in fixed words, and the request id when it
 * is shaped like one: the API's own reason can be looked up under it.
 */
export function apiErrorSummary(error: unknown): string | null {
  if (!(error instanceof Anthropic.APIError) || typeof error.status !== 'number') return null;
  const detail = ((error.error ?? {}) as { error?: unknown }).error as { type?: unknown; message?: unknown } | null | undefined;
  const given = typeof error.type === 'string' ? error.type : detail?.type;
  const type = typeof given === 'string' && Object.hasOwn(API_ERROR_TYPES, given) ? given : null;
  const message = typeof detail?.message === 'string' ? detail.message : '';
  const meaning = API_ERROR_REASONS.find(([pattern]) => pattern.test(message))?.[1] ?? (type ? API_ERROR_TYPES[type] : null);
  const request = typeof error.requestID === 'string' && API_REQUEST_ID.test(error.requestID) ? ` [request ${error.requestID}]` : '';
  return `the model API answered ${error.status} (${type ?? 'no known error type'})${meaning ? `: ${meaning}` : ''}${request}`;
}

// Keyed by API key so a changed secret takes effect and runtimes don't share credentials.
const clients = new Map<string, Anthropic>();

function getClient(runtime: IAgentRuntime): Anthropic {
  const apiKey = getSetting(runtime, 'ANTHROPIC_API_KEY', '');
  let client = clients.get(apiKey);
  if (!client) {
    // Without an explicit key the SDK falls back to ANTHROPIC_API_KEY / other credentials in the environment.
    // The SDK refuses to run where it sees a browser (a global window with a document) unless
    // told otherwise. The agent itself has none; this keeps a host process that does from
    // silencing it.
    client = new Anthropic({ ...(apiKey ? { apiKey } : {}), dangerouslyAllowBrowser: true });
    clients.set(apiKey, client);
  }
  return client;
}

function getSetting(runtime: IAgentRuntime, key: string, fallback: string): string {
  // process.env first: runtime.getSetting reads only the character's settings and secrets, where
  // a stored copy can differ from .env or be null (src/agent-secrets.ts)
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
    purpose,
  }: {
    prompt: string;
    content?: Anthropic.ContentBlockParam[];
    system?: string;
    stopSequences?: string[];
    maxTokens?: number;
    /** Set by this project's callers (see usage-budget.ts); picks the output cap and labels usage. */
    purpose?: unknown;
  }
): Promise<string> {
  const budget = getUsageBudget();
  const model = getSetting(runtime, `ANTHROPIC_${size}_MODEL`, DEFAULT_MODEL);
  const effort = getEffort(runtime);
  // The API rejects empty or whitespace-only stop sequences
  const stops = (stopSequences ?? []).filter((s) => s.trim());
  // A tagged call's own cap wins over the caller's value, which may be a global model setting
  const maxOutput = maxTokensFor(purpose) ?? maxTokens ?? DEFAULT_MAX_TOKENS;
  const label = isAiPurpose(purpose) ? purpose : modelType;
  const client = getClient(runtime);

  const reserve = tokenReserve(system, content ?? prompt, maxOutput);
  const deadlineAt = Date.now() + GENERATION_DEADLINE_MS;
  // Every attempt is aborted by the deadline, and by the cancellation of the turn it is made for
  // (its slot ran out, or its connection ended): a request nobody will use is not left running
  // to its end. What an aborted request counts as is decided below, as for any other.
  const deadline = AbortSignal.timeout(GENERATION_DEADLINE_MS);
  const turnSignal = currentTurn()?.signal;
  const signal = turnSignal ? AbortSignal.any([deadline, turnSignal]) : deadline;
  /** Whether a request has gone out (a cancellation after that is marked: TurnCancelled.afterRequest) */
  let sent = false;
  const marked = (error: unknown): unknown => (sent && error instanceof TurnCancelled && !error.afterRequest ? new TurnCancelled(error.message, true) : error);
  /** One request, under a reservation of its own; settled with what the API billed, or failed. */
  const attempt = async (): Promise<Anthropic.Message> => {
    // A turn that may no longer act (its connection ended, or its slot ran out) asks nothing more
    // of the model: no request is made and nothing is counted (plugin-hyperfy/lib/turn-context.ts)
    assertTurnLive();
    // Admitted and counted before the request, in one step: calls that start together cannot all
    // pass a limit only one of them fits (usage-budget.ts reserveAi)
    const reservation = budget.reserveAi({ purpose: label, origin: currentOrigin() }, reserve);
    if (typeof reservation === 'string') {
      budget.recordSkip('ai-call');
      throw new AiBudgetExceededError(reservation);
    }
    let response: Anthropic.Message;
    sent = true;
    try {
      response = await client.messages.create(
        {
          model,
          max_tokens: maxOutput,
          ...(system ? { system } : {}),
          ...(stops.length ? { stop_sequences: stops } : {}),
          output_config: { effort },
          messages: [{ role: 'user', content: content ?? prompt }],
        },
        { signal, maxRetries: 0 }
      );
    } catch (error) {
      // A request the API refused cost nothing; one that timed out, was aborted or lost its
      // connection may have been billed, so its whole reservation stays counted
      reservation.fail(wasRejected(error) ? 'rejected' : 'unknown');
      // Aborted with its turn: the caller sees why (TurnCancelled), not the SDK's abort error
      assertTurnLive();
      throw error;
    }
    // Billed even when the output turns out unusable
    reservation.settle({
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
    });
    return response;
  };

  let response: Anthropic.Message;
  try {
    response = await attempt();
  } catch (error) {
    const wait = retryWait(error, deadlineAt);
    if (wait === null) throw marked(error);
    logger.warn(`[Anthropic] ${label}: the API answered ${(error as { status: number }).status}; trying once more in ${wait} ms`);
    await new Promise((resolve) => setTimeout(resolve, wait));
    // Reserved again: a second attempt the budget does not admit is not made (AiBudgetExceededError)
    response = await attempt().catch((again: unknown) => {
      throw marked(again);
    });
  }
  if (response.stop_reason === 'max_tokens') {
    logger.warn(
      `[Anthropic] ${label} reply was cut off at max_tokens=${maxOutput}` +
        (isAiPurpose(purpose) ? `; raise ${purposeEnvKey(purpose)} if this keeps happening` : '')
    );
  }
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
  // What the model wrote is not part of the error: whoever catches it may log it, and the text can
  // repeat what a player said or what the prompt held
  throw new Error(`[Anthropic] Model did not return valid JSON (${text.length} characters)`);
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
    purpose: (params as GenerateTextParams & { purpose?: unknown }).purpose,
  });
}

/** Accepts an http(s) URL, a data: URL (what the render page's snapshots are, managers/puppeteer-manager.ts capture), or bare base64. */
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
  const { imageUrl, prompt, purpose } =
    typeof params === 'string' ? { imageUrl: params, prompt: undefined, purpose: undefined } : (params as ImageDescriptionParams & { purpose?: unknown });
  const instruction = prompt || 'Describe this image in detail.';
  const description = await generate(runtime, 'LARGE', ModelType.IMAGE_DESCRIPTION, {
    prompt: instruction,
    content: [
      { type: 'image', source: toImageSource(imageUrl) },
      { type: 'text', text: instruction },
    ],
    maxTokens: IMAGE_DESCRIPTION_MAX_TOKENS,
    purpose,
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
    purpose: (params as ObjectGenerationParams & { purpose?: unknown }).purpose,
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
