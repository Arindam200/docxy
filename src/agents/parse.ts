/**
 * Models wrap JSON in prose, fences, or both. This pulls the payload out without
 * being precious about which. Throws with the raw text attached so a bad run is
 * debuggable rather than mysterious.
 */
export class AgentOutputError extends Error {
  constructor(
    public readonly role: string,
    message: string,
    public readonly raw: string,
  ) {
    super(`[${role}] ${message}`);
    this.name = 'AgentOutputError';
  }
}

/** Scan for the first balanced {...} or [...] run, ignoring braces inside strings. */
function findBalanced(text: string): string | null {
  const openers = ['{', '['];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (!openers.includes(ch)) continue;

    const close = ch === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let j = i; j < text.length; j += 1) {
      const c = text[j]!;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (c === '\\') {
        escaped = true;
        continue;
      }
      if (c === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (c === ch) depth += 1;
      else if (c === close) {
        depth -= 1;
        if (depth === 0) return text.slice(i, j + 1);
      }
    }
  }
  return null;
}

export function extractJson<T>(role: string, raw: string): T {
  if (!raw || !raw.trim()) {
    throw new AgentOutputError(role, 'returned an empty response', raw);
  }

  const candidates: string[] = [];

  // Prefer an explicitly fenced block — that is what the prompts ask for.
  const fence = /```(?:json)?\s*\n([\s\S]*?)```/gi;
  for (const match of raw.matchAll(fence)) {
    if (match[1]) candidates.push(match[1].trim());
  }

  const balanced = findBalanced(raw);
  if (balanced) candidates.push(balanced);
  candidates.push(raw.trim());

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      // try the next candidate
    }
  }

  throw new AgentOutputError(
    role,
    'response did not contain parseable JSON',
    raw.length > 2000 ? `${raw.slice(0, 2000)}\n... [truncated]` : raw,
  );
}

/** Clamp a model-supplied confidence into 0..1 without throwing on junk. */
export function normalizeConfidence(value: unknown, fallback = 0.5): number {
  const n = typeof value === 'number' ? value : Number.parseFloat(String(value));
  if (!Number.isFinite(n)) return fallback;
  // A model asked for 0-1 sometimes answers on a 0-100 scale. Only read values
  // that are plausibly percentages that way; 1 < n < 10 is far more likely a
  // slip than a claim of 2% confidence, so it clamps instead.
  if (n >= 10 && n <= 100) return n / 100;
  return Math.min(1, Math.max(0, n));
}
