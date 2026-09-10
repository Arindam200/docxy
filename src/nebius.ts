import type { Config } from './config.js';

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
  // SAFETY: a 2xx from this endpoint is Nebius's own listing shape, and every field read off it is optional.
  const body = (await res.json()) as { data?: Array<{ id?: string }> };
  return (body.data ?? []).map((m) => m.id ?? '').filter(Boolean).sort();
}
