import { ProviderFormat } from '../types';

/**
 * Reads the model list an upstream endpoint advertises, so a provider can be
 * configured from its Endpoint + API key instead of typing every model by hand.
 *
 * Each format has its own list endpoint and its own metadata:
 *   openai / custom  GET {endpoint}/models          -> data[].id
 *   anthropic        GET {endpoint}/models          -> data[].id + display_name
 *   gemini           GET {endpoint}/models?key=...  -> models[].name ("models/x")
 *
 * Metadata beyond the id is best-effort: OpenRouter-style gateways return
 * context_length / architecture / supported_parameters, plain OpenAI does not.
 * Anything missing is left undefined and the caller falls back to its defaults.
 */

export const DISCOVERY_TIMEOUT_MS = 15000;

/** Upper bound on returned entries — some gateways advertise thousands. */
export const DISCOVERY_MAX_MODELS = 1000;

export interface DiscoveredModel {
  name: string;
  displayName?: string;
  contextSize?: number;
  supportsVision?: boolean;
  supportsTools?: boolean;
}

export interface DiscoverModelsInput {
  endpoint: string;
  apiKey: string;
  format: ProviderFormat;
  timeoutMs?: number;
}

interface OpenAIModelEntry {
  id?: string;
  name?: string;
  display_name?: string;
  context_length?: number;
  context_window?: number;
  max_context_length?: number;
  architecture?: { input_modalities?: string[]; modality?: string };
  supported_parameters?: string[];
  capabilities?: { vision?: boolean; tools?: boolean; function_calling?: boolean };
}

interface AnthropicModelEntry {
  id?: string;
  display_name?: string;
}

interface GeminiModelEntry {
  name?: string;
  displayName?: string;
  inputTokenLimit?: number;
  supportedGenerationMethods?: string[];
}

function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

/** Turn a non-2xx list response into an error the UI can act on. */
async function failFor(response: Response): Promise<never> {
  const body = (await response.text().catch(() => '')).slice(0, 200).replace(/\s+/g, ' ').trim();
  if (response.status === 401 || response.status === 403) {
    throw new Error(`Upstream rejected the API key (HTTP ${response.status})`);
  }
  if (response.status === 404) {
    throw new Error('Upstream has no model list endpoint (HTTP 404) — add models manually');
  }
  throw new Error(`Upstream returned HTTP ${response.status}${body ? `: ${body}` : ''}`);
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function parseOpenAI(payload: unknown): DiscoveredModel[] {
  const list: OpenAIModelEntry[] = Array.isArray(payload)
    ? (payload as OpenAIModelEntry[])
    : ((payload as { data?: OpenAIModelEntry[]; models?: OpenAIModelEntry[] })?.data ??
      (payload as { models?: OpenAIModelEntry[] })?.models ??
      []);

  return list.flatMap((entry) => {
    const name = typeof entry?.id === 'string' ? entry.id : undefined;
    if (!name) return [];

    const modalities = entry.architecture?.input_modalities;
    const modality = entry.architecture?.modality;
    const params = entry.supported_parameters;

    const supportsVision =
      (Array.isArray(modalities) ? modalities.includes('image') : undefined) ??
      (typeof modality === 'string' ? modality.includes('image') : undefined) ??
      entry.capabilities?.vision;

    const supportsTools =
      (Array.isArray(params) ? params.includes('tools') : undefined) ??
      entry.capabilities?.tools ??
      entry.capabilities?.function_calling;

    return [
      {
        name,
        displayName: [entry.name, entry.display_name].find((n): n is string => typeof n === 'string' && n !== name),
        contextSize:
          positiveInt(entry.context_length) ?? positiveInt(entry.context_window) ?? positiveInt(entry.max_context_length),
        supportsVision,
        supportsTools,
      },
    ];
  });
}

function parseAnthropic(payload: unknown): DiscoveredModel[] {
  const list = ((payload as { data?: AnthropicModelEntry[] })?.data ?? []) as AnthropicModelEntry[];
  return list.flatMap((entry) => {
    const name = typeof entry?.id === 'string' ? entry.id : undefined;
    if (!name) return [];
    return [
      {
        name,
        displayName: typeof entry.display_name === 'string' ? entry.display_name : undefined,
        // Anthropic's list endpoint carries no context or capability fields.
        supportsVision: true,
        supportsTools: true,
      },
    ];
  });
}

function parseGemini(payload: unknown): DiscoveredModel[] {
  const list = ((payload as { models?: GeminiModelEntry[] })?.models ?? []) as GeminiModelEntry[];
  return list.flatMap((entry) => {
    const raw = typeof entry?.name === 'string' ? entry.name : undefined;
    if (!raw) return [];
    const methods = entry.supportedGenerationMethods;
    // Embedding and tuning-only models cannot be benchmarked — drop them.
    if (Array.isArray(methods) && !methods.includes('generateContent')) return [];
    return [
      {
        name: raw.replace(/^models\//, ''),
        displayName: typeof entry.displayName === 'string' ? entry.displayName : undefined,
        contextSize: positiveInt(entry.inputTokenLimit),
        supportsVision: true,
        supportsTools: true,
      },
    ];
  });
}

/** Deduplicate by model id, keep the first (richest) entry, sort for a stable list. */
function normalize(models: DiscoveredModel[]): DiscoveredModel[] {
  const byName = new Map<string, DiscoveredModel>();
  for (const model of models) {
    const name = model.name.trim();
    if (!name || byName.has(name)) continue;
    byName.set(name, { ...model, name });
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)).slice(0, DISCOVERY_MAX_MODELS);
}

export async function listRemoteModels(input: DiscoverModelsInput): Promise<DiscoveredModel[]> {
  const endpoint = input.endpoint.trim().replace(/\/+$/, '');
  const apiKey = input.apiKey.trim();
  const timeoutMs = input.timeoutMs ?? DISCOVERY_TIMEOUT_MS;

  let url: string;
  let headers: Record<string, string>;

  switch (input.format) {
    case 'anthropic':
      url = `${endpoint}/models?limit=1000`;
      headers = { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
      break;
    case 'gemini':
      url = `${endpoint}/models?pageSize=1000&key=${encodeURIComponent(apiKey)}`;
      headers = {};
      break;
    case 'openai':
    case 'custom':
      url = `${endpoint}/models`;
      headers = { Authorization: `Bearer ${apiKey}` };
      break;
    default:
      throw new Error(`Unsupported format: ${input.format}`);
  }

  let response: Response;
  try {
    response = await fetchWithTimeout(url, { method: 'GET', headers: { Accept: 'application/json', ...headers } }, timeoutMs);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Anything that is not our own abort keeps its original error object.
    if (!/abort/i.test(message)) throw err;
    // The ES2020 lib has no Error cause option, so it is attached after construction.
    const timeout = new Error(`Upstream did not answer within ${timeoutMs / 1000}s`);
    (timeout as Error & { cause?: unknown }).cause = err;
    throw timeout;
  }

  if (!response.ok) await failFor(response);

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error('Upstream model list is not JSON');
  }

  const parsed =
    input.format === 'anthropic'
      ? parseAnthropic(payload)
      : input.format === 'gemini'
        ? parseGemini(payload)
        : parseOpenAI(payload);

  return normalize(parsed);
}
