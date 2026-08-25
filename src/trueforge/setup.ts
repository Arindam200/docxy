import type { TrueForge } from '@truefoundry/trueforge-sdk';
import type { Config } from '../config.js';

/**
 * The harness stores provider configuration server-side; the SDK exposes models
 * read-only. Registration therefore goes through the settings endpoint using the
 * SDK's authenticated passthrough. The HTTP API is snake_case.
 */
interface CustomProviderManifest {
  type: 'custom';
  name: string;
  base_url: string;
  auth: { api_key: string };
  models: Array<{
    name: string;
    model_id: string;
    // The HTTP API is strictly snake_case and rejects unknown keys.
    properties: { context_length?: number };
  }>;
}

interface ModelProviderList {
  data?: Array<{ name?: string }>;
}

interface NebiusModelList {
  data?: Array<{ id?: string }>;
}

async function readJson<T>(res: Response): Promise<T | string | null> {
  const text = await res.text();
  if (!text) return null;
  try {
    const parsed: T = JSON.parse(text);
    return parsed;
  } catch {
    return text;
  }
}

export interface SetupResult {
  action: 'created' | 'updated';
  providerName: string;
  models: string[];
}

/** Register (or rotate) Nebius Token Factory as a custom OpenAI-compatible provider. */
export async function registerNebiusProvider(
  client: TrueForge,
  config: Config,
): Promise<SetupResult> {
  if (!config.nebius.apiKey) {
    throw new Error(
      'NEBIUS_API_KEY is not set. Get a key at https://tokenfactory.nebius.com and put it in .env',
    );
  }

  const manifest: CustomProviderManifest = {
    type: 'custom',
    name: config.nebius.providerName,
    base_url: config.nebius.baseUrl,
    auth: { api_key: config.nebius.apiKey },
    models: config.registeredModels.map((m) => ({
      name: m.name,
      model_id: m.modelId,
      properties: { context_length: m.contextLength },
    })),
  };

  const existing = await client.fetch('/api/v1/settings/model-providers');
  const listed = await readJson<ModelProviderList>(existing);
  const alreadyThere =
    isPresent(listed) && Array.isArray(listed.data) &&
    listed.data.some((p) => p?.name === config.nebius.providerName);

  const method = alreadyThere ? 'PUT' : 'POST';
  const res = await client.fetch('/api/v1/settings/model-providers', {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ manifest }),
  });

  if (!res.ok) {
    const detail = await readJson(res);
    throw new Error(
      `Registering the Nebius provider failed (HTTP ${res.status} on ${method}): ${JSON.stringify(detail)}`,
    );
  }

  return {
    action: alreadyThere ? 'updated' : 'created',
    providerName: config.nebius.providerName,
    models: config.registeredModels.map((m) => `${config.nebius.providerName}/${m.name}`),
  };
}

/** Model FQNs the harness will actually accept, after registration. */
export async function listAvailableModels(client: TrueForge): Promise<string[]> {
  const { data } = await client.models.list();
  return data.map((model) => model.name);
}

/** The provider list endpoint answers with JSON or a plain-text error body. */
function isPresent<T>(value: T | string | null): value is T {
  return typeof value === 'string' ? false : value !== null;
}

/**
 * Ask Nebius directly which model ids the account can serve. Used by
 * `docxy models` so the defaults can be checked against reality.
 */
export async function listNebiusModels(config: Config): Promise<string[]> {
  if (!config.nebius.apiKey) throw new Error('NEBIUS_API_KEY is not set.');
  const base = config.nebius.baseUrl.replace(/\/$/, '');
  const res = await fetch(`${base}/models`, {
    headers: { authorization: `Bearer ${config.nebius.apiKey}` },
  });
  if (!res.ok) {
    throw new Error(`Nebius /models returned HTTP ${res.status}: ${await res.text()}`);
  }
  const body: NebiusModelList = JSON.parse(await res.text());
  return (body.data ?? []).map((m) => m.id ?? '').filter(Boolean).sort();
}
