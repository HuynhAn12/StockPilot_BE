import { LlmUnavailableError, OpenAiClient } from '../../src/modules/assistant/llm/openai-client';

type FetchMock = jest.Mock<Promise<Response>, [string | URL | Request, RequestInit?]>;

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const okBody = (text: string) => ({
  model: 'gpt-4.1-mini-2025-04-14',
  status: 'completed',
  output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
  usage: { input_tokens: 120, output_tokens: 40 },
});

const client = (fetchImpl: FetchMock, overrides: Record<string, unknown> = {}) =>
  new OpenAiClient({ apiKey: 'sk-test', model: 'gpt-4.1-mini', timeoutMs: 1000, retryDelayMs: 0, fetchImpl, enabled: true, ...overrides });

describe('OpenAiClient', () => {
  it('posts to the Responses API and returns text with token usage', async () => {
    const fetchImpl: FetchMock = jest.fn().mockResolvedValue(jsonResponse(200, okBody('Xin chào')));
    const result = await client(fetchImpl).complete({ instructions: 'Be brief', input: 'hi', maxOutputTokens: 50 });

    expect(result).toMatchObject({ text: 'Xin chào', model: 'gpt-4.1-mini-2025-04-14', inputTokens: 120, outputTokens: 40 });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
    const body = JSON.parse(init!.body as string);
    expect(body).toMatchObject({ model: 'gpt-4.1-mini', instructions: 'Be brief', input: 'hi', max_output_tokens: 50, store: false });
    expect(body.text).toBeUndefined();
  });

  it('requests strict structured output and parses the JSON', async () => {
    const fetchImpl: FetchMock = jest.fn().mockResolvedValue(jsonResponse(200, okBody('{"items":[]}')));
    const schema = { type: 'object', properties: { items: { type: 'array' } }, required: ['items'], additionalProperties: false };

    const result = await client(fetchImpl).complete({ instructions: 'x', input: 'y', jsonSchema: { name: 'suggestions', schema } });

    expect(result.json).toEqual({ items: [] });
    const body = JSON.parse(fetchImpl.mock.calls[0][1]!.body as string);
    expect(body.text.format).toEqual({ type: 'json_schema', name: 'suggestions', schema, strict: true });
  });

  it('retries once on a retryable status, then succeeds', async () => {
    const fetchImpl: FetchMock = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, { error: { message: 'rate limited' } }))
      .mockResolvedValueOnce(jsonResponse(200, okBody('ok')));

    await expect(client(fetchImpl).complete({ instructions: 'x', input: 'y' })).resolves.toMatchObject({ text: 'ok' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not retry client errors and never leaks the key', async () => {
    const fetchImpl: FetchMock = jest.fn().mockResolvedValue(jsonResponse(401, { error: { message: 'bad key' } }));

    const error = await client(fetchImpl).complete({ instructions: 'x', input: 'y' }).catch((e) => e);
    expect(error).toBeInstanceOf(LlmUnavailableError);
    expect(error).toMatchObject({ reason: 'HTTP', httpStatus: 401 });
    expect(String(error.message)).not.toContain('sk-test');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not retry when the account has no credits left', async () => {
    const fetchImpl: FetchMock = jest
      .fn()
      .mockResolvedValue(jsonResponse(429, { error: { code: 'credit_balance_exhausted', type: 'insufficient_quota', message: 'no credits' } }));

    await expect(client(fetchImpl).complete({ instructions: 'x', input: 'y' })).rejects.toMatchObject({ reason: 'QUOTA', httpStatus: 429 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('gives up after the retry when the server keeps failing', async () => {
    const fetchImpl: FetchMock = jest.fn().mockResolvedValue(jsonResponse(503, {}));
    await expect(client(fetchImpl).complete({ instructions: 'x', input: 'y' })).rejects.toMatchObject({ reason: 'HTTP', httpStatus: 503 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('maps an aborted request to TIMEOUT', async () => {
    const fetchImpl: FetchMock = jest.fn().mockRejectedValue(Object.assign(new Error('aborted'), { name: 'TimeoutError' }));
    await expect(client(fetchImpl).complete({ instructions: 'x', input: 'y' })).rejects.toMatchObject({ reason: 'TIMEOUT' });
  });

  it('rejects empty and malformed responses', async () => {
    const empty: FetchMock = jest.fn().mockResolvedValue(jsonResponse(200, { output: [] }));
    await expect(client(empty).complete({ instructions: 'x', input: 'y' })).rejects.toMatchObject({ reason: 'INVALID_RESPONSE' });

    const badJson: FetchMock = jest.fn().mockResolvedValue(jsonResponse(200, okBody('not json')));
    await expect(
      client(badJson).complete({ instructions: 'x', input: 'y', jsonSchema: { name: 's', schema: { type: 'object' } } })
    ).rejects.toMatchObject({ reason: 'INVALID_RESPONSE' });
  });

  it('is unavailable without a key or when disabled, and never calls fetch', async () => {
    const fetchImpl: FetchMock = jest.fn();
    await expect(client(fetchImpl, { apiKey: '' }).complete({ instructions: 'x', input: 'y' })).rejects.toMatchObject({ reason: 'DISABLED' });
    await expect(client(fetchImpl, { enabled: false }).complete({ instructions: 'x', input: 'y' })).rejects.toMatchObject({ reason: 'DISABLED' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
