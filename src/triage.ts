/**
 * Whether a pushed commit is worth a documentation run at all.
 *
 * Every push used to buy the whole pipeline before anything asked that
 * question: four sequential calls to a reasoning model, minutes of wall clock,
 * and one of the account's runs for the month. A test-only change, a CI tweak
 * and an internal refactor each paid for the Change Analyst, the Impact Mapper,
 * both drafters and the Coordinator, and ended in a proposal with nothing in it.
 *
 * TypeSafe's Jev answers this kind of question directly. It returns typed
 * answers with probabilities rather than prose, in well under a second, so it
 * sits in front of the agents rather than among them. It is asked two things,
 * and the run is skipped only when both answers agree with confidence.
 *
 * It is a gate, not a judge. Anything short of a confident "nothing to
 * document" runs the pipeline as before, and that includes Jev being slow,
 * down, rate limited or not configured. Only automatic runs are triaged: a run
 * somebody asked for is always run.
 */

import { z } from 'zod';
import { redactSecrets } from './guardrails/secrets.js';
import type { Config } from './config.js';
import type { ChangeSurface, CommitDiff } from './types.js';

/** What triage decided about one commit, kept for the log and the event. */
export interface TriageVerdict {
  /** Jev's probability that a docs or changelog reader needs to hear about this. */
  needsDocs: number;
  surface: string;
  surfaceConfidence: number;
  skip: boolean;
  /** One sentence, in the terms the decision was made in. */
  reason: string;
  /** The versioned model that answered, not the alias that was asked for. */
  model: string;
  latencyMs: number;
}

/**
 * The surfaces the Change Analyst also chooses between, described for Jev.
 *
 * The same enum on purpose. If the two ever disagree on a commit, they disagree
 * about the same question, and the analyst's answer can be compared against it.
 */
const SURFACES = {
  'public-api':
    'Exported functions, types, endpoints, CLI commands or flags, output formats: anything a user or integrator calls or reads.',
  config: 'Configuration keys, environment variables, defaults, or files a user edits to set the project up.',
  internal:
    'Implementation that nothing outside the project calls: refactors, private helpers, performance work with no observable change.',
  'test-only': 'Tests, fixtures, CI workflows, linters and build tooling, and nothing else.',
  'docs-only': 'Documentation, comments or the changelog themselves, and nothing else.',
} satisfies Record<ChangeSurface, string>;

/** Surfaces that can be skipped. A config or public-api change never is. */
const QUIET: ReadonlySet<string> = new Set<ChangeSurface>(['internal', 'test-only', 'docs-only']);

/**
 * How sure both answers have to be before a run is skipped.
 *
 * Asymmetric on purpose. A skipped commit that needed docs is a gap nobody is
 * told about, and a run that turned out empty costs a few minutes. The bar sits
 * where an uncertain commit runs.
 */
const MAX_NEEDS_DOCS = 0.15;
const MIN_SURFACE_CONFIDENCE = 0.7;

/**
 * The most diff text sent, in characters.
 *
 * The question is about what kind of change this is, not what it says line by
 * line. The subject, the file list and the start of each patch carry that. The
 * agents still get the whole diff if the commit is run.
 */
const PATCH_BUDGET = 24_000;
const FILE_LIST_LIMIT = 300;

/** One System One request: the state, and the questions asked about it. */
interface EvaluateRequest {
  model: string;
  state: ReturnType<typeof stateFor>;
  questions: Record<
    string,
    | { type: 'noul'; instructions: string; criteria: { true: string; false: string } }
    | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  >;
}

const answers = z.object({
  model: z.string(),
  answers: z.object({
    needs_docs: z.object({ noul: z.number().min(0).max(1) }),
    surface: z.object({ choice: z.string(), confidence: z.number().min(0).max(1) }),
  }),
});

/**
 * Ask Jev about one commit. Null when triage is off or could not answer.
 *
 * Null is "run it". The caller never has to distinguish not configured from not
 * reachable, because both mean the same thing for the commit.
 */
export async function triageCommit(
  config: Config,
  diff: CommitDiff,
  fetchImpl: typeof fetch = fetch,
): Promise<TriageVerdict | null> {
  const { apiKey, baseUrl, model, enabled, timeoutMs } = config.triage;
  if (!enabled || !apiKey) return null;

  const started = Date.now();
  try {
    const body = await evaluate(
      `${baseUrl.replace(/\/+$/, '')}/v1/systemone`,
      apiKey,
      {
        model,
        state: stateFor(diff, config.guardrails.redactSecrets),
        questions: {
          needs_docs: {
            type: 'noul',
            instructions:
              "Would someone who reads this project's user-facing documentation or changelog need to learn about this commit?",
            criteria: {
              true: 'It changes something a user or integrator can observe: behaviour, a public API, a CLI command or flag, a configuration key, a default, an output format, an error, or a documented workflow.',
              false:
                'Nothing a user can observe changes: tests, CI, build tooling, internal refactors, formatting, comments, or edits to the documentation itself.',
            },
          },
          surface: {
            type: 'choice',
            instructions: 'Which part of the project does this commit change?',
            criteria: SURFACES,
          },
        },
      },
      AbortSignal.timeout(timeoutMs),
      fetchImpl,
    );

    const needsDocs = body.answers.needs_docs.noul;
    const { choice: surface, confidence: surfaceConfidence } = body.answers.surface;
    const skip =
      needsDocs <= MAX_NEEDS_DOCS && QUIET.has(surface) && surfaceConfidence >= MIN_SURFACE_CONFIDENCE;

    return {
      needsDocs,
      surface,
      surfaceConfidence,
      skip,
      reason: skip
        ? `Jev rated this ${surface} commit ${percent(needsDocs)} likely to need documentation (surface confidence ${percent(surfaceConfidence)}), so no run was started. Run it by hand to document it anyway.`
        : `Jev rated this ${surface} commit ${percent(needsDocs)} likely to need documentation; running.`,
      model: body.model,
      latencyMs: Date.now() - started,
    };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    console.warn(`triage: Jev did not answer for ${diff.shortSha}, running it (${message})`);
    return null;
  }
}

/**
 * One evaluation, retried on the two statuses TypeSafe documents as transient.
 *
 * 429 and 529 back off and try again. Anything else is final: a 401 is a bad
 * key and a 422 is a malformed question, and neither improves with retrying.
 */
async function evaluate(
  url: string,
  apiKey: string,
  request: EvaluateRequest,
  signal: AbortSignal,
  fetchImpl: typeof fetch,
): Promise<z.infer<typeof answers>> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(request),
      signal,
    });
    if (res.status === 429 || res.status === 529) {
      await new Promise((resolve) => setTimeout(resolve, 200 * 2 ** attempt));
      continue;
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    return answers.parse(await res.json());
  }
  throw new Error('rate limited or overloaded on every attempt');
}

/**
 * What Jev reads: the message, every file touched, and the start of the patch.
 *
 * Redacted the way the agents' own input is. Triage is a third-party call made
 * outside any agent, so the guardrail processor on the agents never sees it -
 * and a commit that adds a live key would otherwise send that key to another
 * provider before docxy's own models were ever asked about it.
 */
export function stateFor(diff: CommitDiff, redact: boolean) {
  const clean = (text: string): string => (redact ? redactSecrets(text).text : text);
  let budget = PATCH_BUDGET;
  const patches: string[] = [];
  for (const file of diff.files) {
    if (budget <= 0) break;
    const excerpt = file.patch.slice(0, Math.min(budget, 4_000));
    patches.push(`--- ${file.path}\n${excerpt}`);
    budget -= excerpt.length;
  }

  return {
    subject: clean(diff.subject),
    message: clean(diff.body.slice(0, 2_000)),
    files: diff.files
      .slice(0, FILE_LIST_LIMIT)
      .map((file) => `${file.status} ${file.path} (+${file.additions} -${file.deletions})`),
    filesNotListed: Math.max(0, diff.files.length - FILE_LIST_LIMIT),
    patch: clean(patches.join('\n\n')),
  };
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}
