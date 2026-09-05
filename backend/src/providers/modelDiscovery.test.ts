import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { listRemoteModels, DISCOVERY_MAX_MODELS } from './modelDiscovery';

/**
 * modelDiscovery.ts reads the model list an upstream advertises.
 * Tests cover: per-format URL + auth shape, metadata extraction (OpenRouter-style
 * and plain OpenAI), Gemini's prefix/method filtering, dedupe + sort + cap,
 * and the error paths the UI distinguishes (401, 404, non-JSON, timeout).
 */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('listRemoteModels — openai format', () => {
  it('calls {endpoint}/models with a bearer token and returns ids', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }] }));

    const models = await listRemoteModels({
      endpoint: 'https://api.example.com/v1/',
      apiKey: ' sk-test ',
      format: 'openai',
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.example.com/v1/models');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
    expect(models.map((m) => m.name)).toEqual(['gpt-4o', 'gpt-4o-mini']);
  });

  it('extracts context size and capabilities when the gateway provides them', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        data: [
          {
            id: 'anthropic/claude-opus-5',
            name: 'Anthropic: Claude Opus 5',
            context_length: 1000000,
            architecture: { input_modalities: ['text', 'image'] },
            supported_parameters: ['tools', 'temperature'],
          },
        ],
      }),
    );

    const [model] = await listRemoteModels({ endpoint: 'https://x/v1', apiKey: 'k', format: 'openai' });

    expect(model).toEqual({
      name: 'anthropic/claude-opus-5',
      displayName: 'Anthropic: Claude Opus 5',
      contextSize: 1000000,
      supportsVision: true,
      supportsTools: true,
    });
  });

  it('keeps a display_name-style label when the gateway sends one', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ data: [{ id: 'claude-opus-5', display_name: 'Claude Opus 5', type: 'model' }] }),
    );

    const [model] = await listRemoteModels({ endpoint: 'https://x/v1', apiKey: 'k', format: 'openai' });

    expect(model.displayName).toBe('Claude Opus 5');
  });

  it('leaves unknown metadata undefined instead of guessing', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [{ id: 'gpt-4o', object: 'model' }] }));

    const [model] = await listRemoteModels({ endpoint: 'https://x/v1', apiKey: 'k', format: 'openai' });

    expect(model.contextSize).toBeUndefined();
    expect(model.supportsVision).toBeUndefined();
    expect(model.supportsTools).toBeUndefined();
  });

  it('accepts a bare array and a models[] envelope', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([{ id: 'a' }]));
    expect((await listRemoteModels({ endpoint: 'https://x/v1', apiKey: 'k', format: 'openai' }))[0].name).toBe('a');

    fetchMock.mockResolvedValueOnce(jsonResponse({ models: [{ id: 'b' }] }));
    expect((await listRemoteModels({ endpoint: 'https://x/v1', apiKey: 'k', format: 'custom' }))[0].name).toBe('b');
  });

  it('drops entries without an id, dedupes, and sorts', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ data: [{ id: 'zeta' }, { object: 'model' }, { id: 'alpha' }, { id: 'zeta' }] }),
    );

    const models = await listRemoteModels({ endpoint: 'https://x/v1', apiKey: 'k', format: 'openai' });

    expect(models.map((m) => m.name)).toEqual(['alpha', 'zeta']);
  });

  it('caps the list', async () => {
    const data = Array.from({ length: DISCOVERY_MAX_MODELS + 25 }, (_, i) => ({ id: `m${String(i).padStart(5, '0')}` }));
    fetchMock.mockResolvedValue(jsonResponse({ data }));

    const models = await listRemoteModels({ endpoint: 'https://x/v1', apiKey: 'k', format: 'openai' });

    expect(models).toHaveLength(DISCOVERY_MAX_MODELS);
  });
});

describe('listRemoteModels — anthropic format', () => {
  it('sends the anthropic auth headers and keeps display names', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ data: [{ id: 'claude-opus-5', display_name: 'Claude Opus 5', type: 'model' }] }),
    );

    const models = await listRemoteModels({ endpoint: 'https://api.anthropic.com/v1', apiKey: 'k', format: 'anthropic' });

    const [url, init] = fetchMock.mock.calls[0];
    const headers = init.headers as Record<string, string>;
    expect(url).toBe('https://api.anthropic.com/v1/models?limit=1000');
    expect(headers['x-api-key']).toBe('k');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(models[0]).toMatchObject({ name: 'claude-opus-5', displayName: 'Claude Opus 5' });
  });
});

describe('listRemoteModels — gemini format', () => {
  it('passes the key as a query param, strips the models/ prefix and drops non-generateContent models', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        models: [
          {
            name: 'models/gemini-3-pro',
            displayName: 'Gemini 3 Pro',
            inputTokenLimit: 1048576,
            supportedGenerationMethods: ['generateContent', 'countTokens'],
          },
          { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
        ],
      }),
    );

    const models = await listRemoteModels({
      endpoint: 'https://generativelanguage.googleapis.com/v1beta',
      apiKey: 'AIza secret',
      format: 'gemini',
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&key=AIza%20secret');
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({ name: 'gemini-3-pro', displayName: 'Gemini 3 Pro', contextSize: 1048576 });
  });
});

describe('listRemoteModels — failures', () => {
  it('reports a rejected key distinctly', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'nope' }, 401));

    await expect(listRemoteModels({ endpoint: 'https://x/v1', apiKey: 'k', format: 'openai' })).rejects.toThrow(
      /rejected the API key/i,
    );
  });

  it('tells the user to add models manually when there is no list endpoint', async () => {
    fetchMock.mockResolvedValue(new Response('not found', { status: 404 }));

    await expect(listRemoteModels({ endpoint: 'https://x/v1', apiKey: 'k', format: 'openai' })).rejects.toThrow(
      /manually/i,
    );
  });

  it('surfaces the upstream body for other statuses', async () => {
    fetchMock.mockResolvedValue(new Response('gateway exploded', { status: 502 }));

    await expect(listRemoteModels({ endpoint: 'https://x/v1', apiKey: 'k', format: 'openai' })).rejects.toThrow(
      /HTTP 502: gateway exploded/,
    );
  });

  it('rejects non-JSON responses', async () => {
    fetchMock.mockResolvedValue(new Response('<html>login</html>', { status: 200 }));

    await expect(listRemoteModels({ endpoint: 'https://x/v1', apiKey: 'k', format: 'openai' })).rejects.toThrow(
      /not JSON/i,
    );
  });

  it('turns an abort into a timeout message', async () => {
    fetchMock.mockRejectedValue(new DOMException('The operation was aborted.', 'AbortError'));

    await expect(
      listRemoteModels({ endpoint: 'https://x/v1', apiKey: 'k', format: 'openai', timeoutMs: 2000 }),
    ).rejects.toThrow(/did not answer within 2s/);
  });
});
