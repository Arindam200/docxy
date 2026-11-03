import type { Config } from './config.js';
import type { RoleUsage } from './types.js';

/**
 * What a run cost, in dollars.
 *
 * The rates are not hardcoded. Nebius publishes per-model prices on its own
 * models endpoint (`GET /v1/models?verbose=true` → `pricing.prompt` and
 * `pricing.completion`, both USD per token), so the numbers here are the
 * account's real rates rather than a table that silently goes stale. When the
 * endpoint cannot be reached, every function degrades to "no price known" and
 * the UI shows tokens without a dollar figure - a wrong cost is worse than none.
 */

export interface ModelPrice {
  /** USD per input token. */
  prompt: number;
  /** USD per output token. */
  completion: number;
}

/** Keyed by the upstream model id, lowercased. */
export type PriceTable = Map<string, ModelPrice>;

interface VerboseModel {
  id?: string;
  pricing?: { prompt?: string | number; completion?: string | number };
}

const CACHE_TTL_MS = 60 * 60 * 1000;

/**
 * How long a failed price fetch is remembered.
 *
 * Without it the failure was never cached, so while the models endpoint was
 * down every run sat out the full ten-second timeout to learn what the last one
 * already knew. Short, because a cost figure is worth having back soon after
 * the endpoint is - five minutes of tokens-without-dollars is the whole price.
 */
const FAILURE_TTL_MS = 5 * 60 * 1000;

let cache: { at: number; table: PriceTable } | null = null;
/** When the last fetch failed, or null when it did not. */
let failedAt: number | null = null;

/** Nebius sends rates as decimal strings; anything unparseable is not a price. */
function toNumber(value: string | number | undefined): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * The account's price list, cached for an hour.
 *
 * Prices move rarely and a run is not the place to discover that the models
 * endpoint is slow, so failure is silent and empty rather than fatal - and
 * remembered for `FAILURE_TTL_MS`, so the runs behind a failed one fall back
 * at once instead of each waiting out the timeout again.
 */
export async function loadPrices(config: Config, now = Date.now()): Promise<PriceTable> {
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.table;
  if (failedAt !== null && now - failedAt < FAILURE_TTL_MS) return new Map();
  if (!config.nebius.apiKey) return new Map();

  const table: PriceTable = new Map();
  try {
    const res = await fetch(`${config.nebius.baseUrl.replace(/\/$/, '')}/models?verbose=true`, {
      headers: { Authorization: `Bearer ${config.nebius.apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      failedAt = now;
      return new Map();
    }

    // SAFETY: the shape is not trusted - every field below is read through
    // optional access and coerced, and a response that looks nothing like this
    // yields an empty table rather than a wrong price.
    const body = (await res.json()) as { data?: VerboseModel[] };
    for (const model of body.data ?? []) {
      if (!model.id || !model.pricing) continue;
      const prompt = toNumber(model.pricing.prompt);
      const completion = toNumber(model.pricing.completion);
      // A model listed at zero is free or unpriced; either way there is nothing
      // to compute, and storing it would claim a $0.00 run that was not free.
      if (prompt === 0 && completion === 0) continue;
      table.set(model.id.toLowerCase(), { prompt, completion });
    }
  } catch {
    failedAt = now;
    return new Map();
  }

  cache = { at: now, table };
  failedAt = null;
  return table;
}

/** Only for tests and long-lived servers that want to force a refresh. */
export function clearPriceCache(): void {
  cache = null;
  failedAt = null;
}

/**
 * Resolve a role's model to a price.
 *
 * A trace records the model as the harness knows it - `nebius/deepseek-v4-pro`,
 * a short alias - while Nebius prices `deepseek-ai/DeepSeek-V4-Pro`.
 * `registeredModels` is the mapping between the two, and it is the reason this
 * cannot simply look the trace's string up in the table.
 */
export function priceFor(
  model: string | undefined,
  config: Pick<Config, 'registeredModels'>,
  prices: PriceTable,
): ModelPrice | undefined {
  if (!model || prices.size === 0) return undefined;

  // Everything after the provider: a short alias
  // (`nebius/deepseek-v4-pro` -> `deepseek-v4-pro`) or, under Mastra, the
  // upstream id itself (`nebius/deepseek-ai/DeepSeek-V4-Pro` ->
  // `deepseek-ai/DeepSeek-V4-Pro`), since the router takes ids directly.
  const afterProvider = model.includes('/') ? model.slice(model.indexOf('/') + 1) : model;
  const registered = config.registeredModels.find((entry) => entry.name === afterProvider);

  // Tried in order of specificity. The price table is keyed by upstream id, so
  // a registered name resolves through the table above and the two runtimes'
  // different spellings of one model both land on one rate - without which a
  // Mastra run priced at zero and reported itself as free.
  for (const candidate of [registered?.modelId, afterProvider, model]) {
    if (!candidate) continue;
    const price = prices.get(candidate.toLowerCase());
    if (price) return price;
  }
  return undefined;
}

/**
 * What one role's turn cost.
 *
 * Cached reads are billed at the prompt rate here. The harness reports them
 * inside `inputTokens` and Nebius publishes no separate cache rate, so this
 * matches the invoice's shape; treat it as an estimate, not a receipt.
 */
export function costOf(usage: RoleUsage | undefined, price: ModelPrice | undefined): number | undefined {
  if (!usage || !price) return undefined;
  const cost = usage.inputTokens * price.prompt + usage.outputTokens * price.completion;
  return Number.isFinite(cost) ? round(cost) : undefined;
}

/** Six decimals: a cheap role can cost less than a tenth of a cent. */
export function round(cost: number): number {
  return Math.round(cost * 1e6) / 1e6;
}
