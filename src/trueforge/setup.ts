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

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
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
  // SAFETY: every field below is optional and read through `?.`, so a file with any other shape reads as absent rather than throwing.
  const listed = (await readJson(existing)) as { data?: Array<{ name?: string }> } | null;
  const alreadyThere =
    Array.isArray(listed?.data) &&
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
  // SAFETY: a 2xx from this endpoint is the harness's own listing shape, and every field read off it is optional.
  const body = (await res.json()) as { data?: Array<{ id?: string }> };
  return (body.data ?? []).map((m) => m.id ?? '').filter(Boolean).sort();
}
