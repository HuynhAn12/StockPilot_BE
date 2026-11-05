import { env } from '../../../config/env';
import { AppError } from '../../../common/errors/app-error';

export type LlmFailureReason = 'DISABLED' | 'TIMEOUT' | 'HTTP' | 'QUOTA' | 'INVALID_RESPONSE';

/**
 * The model could not produce a usable answer. Callers catch it and fall back to the rule-based
 * assistant; it only reaches the HTTP layer if a caller forgets to, and then maps to 503.
 */
export class LlmUnavailableError extends AppError {
  constructor(
    public readonly reason: LlmFailureReason,
    message: string,
    public readonly httpStatus?: number
  ) {
    super(message, 503, 'INTERNAL_ERROR', { reason });
  }
}

export interface LlmRequest {
  /** System-level instructions (Responses API `instructions`). */
  instructions: string;
  /** User turn: the question plus the data block the model must ground its answer in. */
  input: string;
  maxOutputTokens?: number;
  /** When set, the model must return JSON matching this schema (strict structured output). */
  jsonSchema?: { name: string; schema: Record<string, unknown> };
}

export interface LlmResult {
  text: string;
  json?: unknown;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

/**
 * `responses`: OpenAI Responses API. `chat`: Chat Completions, which the OpenAI-compatible
 * endpoints of Gemini and NVIDIA implement (neither has the Responses API).
 */
export type LlmApiStyle = 'responses' | 'chat';

export interface OpenAiClientOptions {
  apiStyle?: LlmApiStyle;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  enabled?: boolean;
  fetchImpl?: typeof fetch;
  /** Delay before the single retry on 429/5xx; injectable so tests do not sleep. */
  retryDelayMs?: number;
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

/** Connection settings for the provider chosen by AI_PROVIDER. */
function providerDefaults(): { apiStyle: LlmApiStyle; apiKey?: string; model: string; baseUrl: string } {
  if (env.AI_PROVIDER === 'gemini') {
    return { apiStyle: 'chat', apiKey: env.GEMINI_API_KEY, model: env.GEMINI_MODEL, baseUrl: env.GEMINI_BASE_URL };
  }
  if (env.AI_PROVIDER === 'nvidia') {
    return { apiStyle: 'chat', apiKey: env.NVIDIA_API_KEY, model: env.NVIDIA_MODEL, baseUrl: env.NVIDIA_BASE_URL };
  }
  return { apiStyle: 'responses', apiKey: env.OPENAI_API_KEY, model: env.OPENAI_MODEL, baseUrl: env.OPENAI_BASE_URL };
}

/** True when the chosen provider has a key and AI_ENABLED is not explicitly "false". */
export function isAiConfigured(): boolean {
  return Boolean(providerDefaults().apiKey) && env.AI_ENABLED !== 'false';
}

/**
 * Minimal LLM client on Node's built-in fetch (no SDK dependency): OpenAI Responses API, or
 * Chat Completions for OpenAI-compatible providers such as Gemini.
 * One retry on rate limits and server errors; every attempt is bounded by the timeout.
 * The API key never appears in errors or logs.
 */
export class OpenAiClient {
  private readonly apiStyle: LlmApiStyle;
  private readonly apiKey?: string;
  private readonly enabled: boolean;
  readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly retryDelayMs: number;

  constructor(options: OpenAiClientOptions = {}) {
    const defaults = providerDefaults();
    this.apiStyle = options.apiStyle ?? defaults.apiStyle;
    this.apiKey = options.apiKey ?? defaults.apiKey;
    this.enabled = options.enabled ?? env.AI_ENABLED !== 'false';
    this.model = options.model ?? defaults.model;
    this.baseUrl = (options.baseUrl ?? defaults.baseUrl).replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? env.AI_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.retryDelayMs = options.retryDelayMs ?? 600;
  }

  get available(): boolean {
    return this.enabled && Boolean(this.apiKey);
  }

  async complete(request: LlmRequest): Promise<LlmResult> {
    if (!this.available) {
      throw new LlmUnavailableError('DISABLED', 'AI assistant is not configured');
    }

    const body = this.apiStyle === 'chat' ? chatBody(this.model, request) : responsesBody(this.model, request);
    const path = this.apiStyle === 'chat' ? '/chat/completions' : '/responses';

    const started = Date.now();
    let lastStatus: number | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
      }
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        const name = (error as { name?: string })?.name;
        if (name === 'TimeoutError' || name === 'AbortError') {
          throw new LlmUnavailableError('TIMEOUT', `AI request timed out after ${this.timeoutMs} ms`);
        }
        throw new LlmUnavailableError('HTTP', 'AI provider could not be reached');
      }

      if (!response.ok) {
        lastStatus = response.status;
        // A 429 is either a short rate limit (worth one retry) or an exhausted balance (never worth retrying).
        const providerError = await readProviderError(response);
        if (response.status === 429 && isQuotaError(providerError)) {
          throw new LlmUnavailableError('QUOTA', `AI provider quota exhausted (${providerError.code || providerError.type})`, 429);
        }
        if (RETRYABLE.has(response.status) && attempt === 0) {
          continue;
        }
        throw new LlmUnavailableError('HTTP', `AI provider returned HTTP ${response.status}`, response.status);
      }

      const data = (await response.json().catch(() => null)) as (OpenAiResponse & ChatCompletionResponse) | null;
      const text = data ? (this.apiStyle === 'chat' ? extractChatText(data) : extractText(data)) : '';
      if (!data || !text) {
        throw new LlmUnavailableError('INVALID_RESPONSE', 'AI provider returned an empty response');
      }

      let json: unknown;
      if (request.jsonSchema) {
        try {
          json = JSON.parse(text);
        } catch {
          throw new LlmUnavailableError('INVALID_RESPONSE', 'AI provider returned malformed JSON');
        }
      }

      return {
        text,
        json,
        model: data.model ?? this.model,
        inputTokens: data.usage?.input_tokens ?? data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.output_tokens ?? data.usage?.completion_tokens ?? 0,
        latencyMs: Date.now() - started,
      };
    }

    throw new LlmUnavailableError('HTTP', `AI provider returned HTTP ${lastStatus}`, lastStatus);
  }
}

interface ProviderError {
  code?: string;
  type?: string;
}

/**
 * Reads only the error code and type; provider messages can echo request details, so they are dropped.
 * Gemini's compatible endpoint may wrap the error in a one-element array.
 */
async function readProviderError(response: Response): Promise<ProviderError> {
  const raw = (await response.json().catch(() => null)) as unknown;
  const body = (Array.isArray(raw) ? raw[0] : raw) as { error?: { code?: unknown; type?: unknown } } | null;
  const asText = (value: unknown) => (typeof value === 'string' ? value : undefined);
  return { code: asText(body?.error?.code), type: asText(body?.error?.type) };
}

function responsesBody(model: string, request: LlmRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    instructions: request.instructions,
    input: request.input,
    max_output_tokens: request.maxOutputTokens ?? 700,
    store: false,
  };
  if (request.jsonSchema) {
    body.text = {
      format: { type: 'json_schema', name: request.jsonSchema.name, schema: request.jsonSchema.schema, strict: true },
    };
  }
  return body;
}

/** Thinking models (e.g. Gemini 2.5) spend part of max_tokens on reasoning, so the cap gets headroom. */
const CHAT_REASONING_HEADROOM_TOKENS = 3000;

function chatBody(model: string, request: LlmRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: 'system', content: request.instructions },
      { role: 'user', content: request.input },
    ],
    max_tokens: (request.maxOutputTokens ?? 700) + CHAT_REASONING_HEADROOM_TOKENS,
  };
  if (request.jsonSchema) {
    body.response_format = {
      type: 'json_schema',
      json_schema: { name: request.jsonSchema.name, schema: request.jsonSchema.schema, strict: true },
    };
  }
  return body;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** Some open reasoning models put their chain of thought inline in <think> tags; only the answer is kept. */
function extractChatText(data: ChatCompletionResponse): string {
  const content = data.choices?.[0]?.message?.content;
  return typeof content === 'string' ? content.replace(/<think>[\s\S]*?<\/think>/g, '').trim() : '';
}

function isQuotaError(error: ProviderError): boolean {
  return error.type === 'insufficient_quota' || error.code === 'insufficient_quota' || error.code === 'credit_balance_exhausted';
}

interface OpenAiResponse {
  model?: string;
  status?: string;
  output_text?: string;
  output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
  usage?: { input_tokens?: number; output_tokens?: number; prompt_tokens?: number; completion_tokens?: number };
}

/** Concatenates the assistant's output_text parts (the raw API has no `output_text` shortcut). */
function extractText(data: OpenAiResponse): string {
  if (typeof data.output_text === 'string' && data.output_text.trim()) {
    return data.output_text.trim();
  }
  const parts: string[] = [];
  for (const item of data.output ?? []) {
    if (item.type !== 'message') continue;
    for (const content of item.content ?? []) {
      if (content.type === 'output_text' && typeof content.text === 'string') {
        parts.push(content.text);
      }
    }
  }
  return parts.join('').trim();
}
