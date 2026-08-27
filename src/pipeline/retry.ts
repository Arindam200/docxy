import type { TurnFailureKind } from '../trueforge/run.js';

/**
 * What went wrong with one attempt at a role.
 *
 * `parse-error` is not a `TurnFailureKind` — the harness was perfectly happy,
 * the model just did not emit the JSON it was asked for. It is handled here
 * anyway because from the pipeline's side it is the same decision: try again,
 * and if so, how differently.
 */
export type AttemptFailure = TurnFailureKind | 'parse-error';

export interface RetryPlan {
  retry: boolean;
  /**
   * Start the next attempt on a brand-new session.
   *
   * Sessions are deliberately long-lived — a role's memory of the repository is
   * the point — but that memory is also an input that grows with every commit.
   * When a role runs out of budget, the accumulated session is the first
   * suspect, so the retry drops it rather than asking the same overloaded
   * context the same question again.
   */
  freshSession: boolean;
  /** Appended to the prompt, telling the model what to do differently. */
  nudge?: string;
  delayMs: number;
  /** Shown in the trace, so a retried run explains itself. */
  reason: string;
}

const BREVITY = `
## Retry — your previous attempt ran out of output budget

You spent your entire token budget before emitting an answer. Do not restate the
diff, the classification, or the impact map back to yourself. Do not deliberate
in prose. Decide, then emit the single fenced JSON block and stop. Keep every
string field to the length the schema asks for and no longer.`.trim();

const DIRECTNESS = `
## Retry — your previous attempt never finished

The last attempt stalled without producing a final answer. Answer directly from
what you have been given. Do not call tools, do not spawn subagents, and do not
ask questions — no human is attached. Emit the single fenced JSON block and stop.`.trim();

function repairNudge(raw: string): string {
  const excerpt = raw.length > 1200 ? `${raw.slice(0, 1200)}\n… [truncated]` : raw;
  return `
## Retry — your previous answer was not parseable JSON

Here is exactly what you sent back:

---
${excerpt || '(nothing at all)'}
---

It did not parse. Send the same answer again as **one** fenced \`\`\`json block
containing a single JSON object, with no prose before or after it, no trailing
commas, and no comments.`.trim();
}

/**
 * Decide whether — and how differently — to try a failed role again.
 *
 * `attempt` is 1-based and counts the attempt that just failed.
 *
 * The shape of the policy matters more than the constants: a failure caused by
 * an overfull session is not fixed by repeating it, and a failure caused by a
 * dropped socket is not fixed by throwing away a session that was fine. Every
 * failure used to take the same path — straight out of the pipeline — which is
 * why three roles' worth of correct work went in the bin each time the fourth
 * ran out of tokens.
 */
export function planRetry(
  failure: AttemptFailure,
  attempt: number,
  maxAttempts: number,
  raw = '',
): RetryPlan {
  const none = (reason: string): RetryPlan => ({
    retry: false,
    freshSession: false,
    delayMs: 0,
    reason,
  });

  if (attempt >= maxAttempts) {
    return none(`no attempts left after ${attempt} of ${maxAttempts}`);
  }

  switch (failure) {
    case 'max-tokens':
    case 'context':
      return {
        retry: true,
        // The accumulated session is the likeliest cause of both.
        freshSession: true,
        nudge: BREVITY,
        delayMs: 500,
        reason: 'ran out of budget — retrying on a fresh session with a brevity instruction',
      };

    case 'stalled':
      return {
        retry: true,
        freshSession: true,
        nudge: DIRECTNESS,
        delayMs: 500,
        reason: 'the turn never settled — retrying on a fresh session, tools discouraged',
      };

    case 'parse-error':
      // The first repair stays in-session on purpose: the model has the context
      // that produced the answer, and showing it its own output is usually
      // enough. A second failure means the session itself is confused.
      return {
        retry: true,
        freshSession: attempt >= 2,
        nudge: repairNudge(raw),
        delayMs: 250,
        reason:
          attempt >= 2
            ? 'unparseable twice — retrying on a fresh session'
            : 'unparseable — asking the same session to re-emit it as JSON',
      };

    case 'rate-limit':
      return {
        retry: true,
        freshSession: false,
        // Long enough to be worth waiting for; a rate limit is not a bug.
        delayMs: Math.min(30_000, 4_000 * 2 ** (attempt - 1)),
        reason: 'rate limited — backing off',
      };

    case 'cancelled':
    case 'transient':
      return {
        retry: true,
        freshSession: false,
        delayMs: Math.min(10_000, 1_000 * 2 ** (attempt - 1)),
        reason: 'transient failure — retrying the same session',
      };

    case 'harness':
      return {
        retry: true,
        // Unknown cause: repeat once as-is, then rule the session out.
        freshSession: attempt >= 2,
        delayMs: Math.min(10_000, 2_000 * 2 ** (attempt - 1)),
        reason:
          attempt >= 2
            ? 'the harness errored again — retrying on a fresh session'
            : 'the harness errored — retrying',
      };

    default:
      return none('unrecognised failure');
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
