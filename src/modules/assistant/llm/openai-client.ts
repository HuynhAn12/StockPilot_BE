import { env } from '../../../config/env';
import { AppError } from '../../../common/errors/app-error';

export type LlmFailureReason = 'DISABLED' | 'TIMEOUT' | 'HTTP' | 'INVALID_RESPONSE';

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

export interface OpenAiClientOptions {
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

/** True when a key is configured and AI_ENABLED is not explicitly "false". */
export function isAiConfigured(): boolean {
  return Boolean(env.OPENAI_API_KEY) && env.AI_ENABLED !== 'false';
}

/**
 * Minimal OpenAI Responses API client on Node's built-in fetch (no SDK dependency).
 * One retry on rate limits and server errors; every attempt is bounded by the timeout.
 * The API key never appears in errors or logs.
 */
export class OpenAiClient {
  private readonly apiKey?: string;
  private readonly enabled: boolean;
  readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly retryDelayMs: number;

  constructor(options: OpenAiClientOptions = {}) {
    this.apiKey = options.apiKey ?? env.OPENAI_API_KEY;
    this.enabled = options.enabled ?? env.AI_ENABLED !== 'false';
    this.model = options.model ?? env.OPENAI_MODEL;
    this.baseUrl = (options.baseUrl ?? env.OPENAI_BASE_URL).replace(/\/+$/, '');
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

    const body: Record<string, unknown> = {
      model: this.model,
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

    const started = Date.now();
    let lastStatus: number | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
      }
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}/responses`, {
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
        if (RETRYABLE.has(response.status) && attempt === 0) {
          continue;
        }
        throw new LlmUnavailableError('HTTP', `AI provider returned HTTP ${response.status}`, response.status);
      }

      const data = (await response.json().catch(() => null)) as OpenAiResponse | null;
      const text = data ? extractText(data) : '';
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
        inputTokens: data.usage?.input_tokens ?? 0,
        outputTokens: data.usage?.output_tokens ?? 0,
        latencyMs: Date.now() - started,
      };
    }

    throw new LlmUnavailableError('HTTP', `AI provider returned HTTP ${lastStatus}`, lastStatus);
  }
}

interface OpenAiResponse {
  model?: string;
  status?: string;
  output_text?: string;
  output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
  usage?: { input_tokens?: number; output_tokens?: number };
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
