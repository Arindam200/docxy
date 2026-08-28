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

export interface SandboxSetupResult {
  action: 'registered' | 'skipped' | 'rejected';
  /** Why it was skipped or rejected, when it was. */
  reason?: string;
}

/**
 * Register Daytona as the harness's sandbox provider.
 *
 * The harness holds exactly one sandbox provider per tenant, so this is an
 * upsert rather than a create. Without a key this is a no-op that says so:
 * validation then falls back to local execution and reports that it did, which
 * is a working pipeline with a named limitation rather than a broken one.
 */
export async function registerSandboxProvider(
  client: TrueForge,
  config: Config,
): Promise<SandboxSetupResult> {
  // Two independent reasons a provider might be needed, and skipping on the
  // first alone ignored a supplied key in a supported configuration: with
  // DOCXY_SANDBOX off and git-backed skills on, every drafting role still asks
  // for a sandbox, and session creation fails later for want of a provider
  // nobody registered.
  if (!config.sandbox.enabled && !config.useHarnessSkills) {
    return {
      action: 'skipped',
      reason: 'DOCXY_SANDBOX is off and no git-backed skills are in use',
    };
  }
  if (!config.sandbox.daytonaApiKey) {
    return {
      action: 'skipped',
      reason:
        'DAYTONA_API_KEY is not set, so the docs build will run on this machine. ' +
        'Get a key at https://app.daytona.io to run it in an isolated sandbox instead',
    };
  }

  const res = await client.fetch('/api/v1/settings/sandbox-providers', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    // The HTTP API is strictly snake_case and rejects unknown keys.
    body: JSON.stringify({
      manifest: {
        type: 'daytona',
        auth: { api_key: config.sandbox.daytonaApiKey },
        auto_stop_interval_in_minutes: config.sandbox.autoStopMinutes,
        auto_archive_interval_in_minutes: config.sandbox.autoStopMinutes,
        auto_delete_interval_in_minutes: config.sandbox.autoDeleteMinutes,
        exec_timeout_ms: config.sandbox.execTimeoutMs,
      },
    }),
  });

  if (!res.ok) {
    // Never fatal. A harness running standalone carries its own sandbox, so a
    // rejected remote provider costs nothing that stops a run — and throwing
    // here failed `docxy setup` outright, taking the model registration that had
    // already succeeded down with it.
    const detail = await readJson(res);
    return {
      action: 'rejected',
      reason:
        `the harness refused the Daytona provider (HTTP ${res.status}): ${JSON.stringify(detail)}. ` +
        'Registration builds a snapshot on Daytona, which needs more than read access — ' +
        'a key that can list sandboxes can still be refused here',
    };
  }
  return { action: 'registered' };
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
