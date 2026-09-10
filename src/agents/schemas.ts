import { z } from 'zod';
import type {
  ChangelogProposal,
  Classification,
  DocsProposal,
  ImpactMap,
} from '../types.js';

/**
 * Each role's output contract, as a schema the model provider enforces.
 *
 * Stated to the provider rather than to the model: Nebius honours native
 * `response_format`, so a run cannot come back with unparseable JSON, a missing
 * field, or `kind: "refactoring"` when the enum lists four values. Each role's contract used to be written out in English
 * and asked for politely; the provider enforces it now.
 *
 * `.describe()` is not decoration. It is carried into the JSON Schema the
 * provider sees, so it is where the nuance of the old prose contracts lives on
 * - and the reason dropping them cost nothing.
 */

export const classificationSchema = z.object({
  kind: z.enum(['breaking', 'feature', 'fix', 'chore']),
  surface: z.enum(['public-api', 'internal', 'config', 'test-only', 'docs-only']),
  summary: z.string().describe('What changed and why, 1-3 sentences, no diff jargon.'),
  changedSymbols: z
    .array(z.string())
    .describe(
      'Public symbols, routes, flags, or config keys whose shape moved. Empty when none.',
    ),
  breakingRationale: z
    .string()
    .describe(
      'One or two sentences framed around what happens to a consumer who upgrades ' +
        'without changing code.',
    ),
  confidence: z.number().min(0).max(1),
});

export const impactMapSchema = z.object({
  docs: z
    .array(
      z.object({
        path: z.string().describe('Must appear verbatim in the documentation outline given.'),
        section: z.string().describe('Literal heading text, with no leading #.'),
        reason: z.string(),
        confidence: z.number().min(0).max(1),
      }),
    )
    .describe('Only what the change actually touches. Do not propose edits here.'),
  code: z
    .array(z.object({ path: z.string(), reason: z.string() }))
    .describe('Downstream files needing updates; exclude the changed files themselves.'),
  symbolIndex: z
    .record(z.string(), z.array(z.string()))
    .describe('Each changed symbol mapped to an array of "path#Heading Text" strings.'),
  notes: z
    .string()
    .describe('What you reused from the prior map, and anything you could not confirm.'),
});

export const docsProposalSchema = z.object({
  edits: z.array(
    z.object({
      path: z.string(),
      section: z.string(),
      find: z
        .string()
        .describe(
          'Text that appears verbatim and exactly once in the file given, copied ' +
            'character for character including indentation. Empty string when mode is "append".',
        ),
      replace: z.string().describe('For mode "append", this is appended to the end of the file.'),
      mode: z.enum(['replace', 'append']),
      rationale: z.string(),
    }),
  ),
  skipped: z
    .array(z.object({ path: z.string(), reason: z.string() }))
    .describe('Impacted docs that turned out not to need a change. An honest no-op is correct.'),
});

export const changelogProposalSchema = z.object({
  entry: z.string().describe('One line, capitalized, no trailing period.'),
  section: z.enum(['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security']),
  semverBump: z
    .enum(['major', 'minor', 'patch', 'none'])
    .describe('If the classification says breaking, the bump is major, without exception.'),
  bumpRationale: z.string().describe('One sentence referencing the classification.'),
});

/**
 * The Coordinator's verdict.
 *
 * Declared here rather than in `types.ts` because it is the one role output the
 * pipeline consumes and never persists as its own record - it becomes the
 * approval request and the publication intent.
 */
export const coordinatorVerdictSchema = z.object({
  recommendation: z.enum(['approve', 'reject']),
  scope: z
    .enum(['routine', 'elevated'])
    .describe(
      'elevated when the change touches documented public API, is classified breaking, ' +
        'or proposes a major bump. routine otherwise.',
    ),
  scopeRationale: z.string().describe('One sentence on why this scope.'),
  summary: z.string().describe('Markdown, at most 200 words, for the human reviewer.'),
  concerns: z.array(z.string()).describe('Specific problems found; empty when none.'),
});

export type CoordinatorVerdict = z.infer<typeof coordinatorVerdictSchema>;

/**
 * The schemas and the hand-written types must not drift.
 *
 * `types.ts` is what the database, the dashboard, and the pull request body are
 * written against; these schemas are what the model is held to. If someone
 * widens an enum in one place and not the other, this fails at compile time
 * rather than at the point where a run has already spent its tokens.
 */
/**
 * What the Docs Updater answers with when it is drafting through Code Mode.
 *
 * Every field defaults, because in this mode the closing message is optional.
 * The work is the tool calls, and a model that has finished a program and made
 * its `proposeEdit` calls frequently stops without a summary - a finished turn,
 * not a failed one. The defaults are what let the runtime say so.
 *
 * Deliberately not `docsProposalSchema`. In Code Mode the edits arrive through
 * `proposeEdit` tool calls, checked against the real file as they land - asking
 * for them a second time in the final message would reintroduce the exact
 * failure the mode exists to remove: a model retyping text it has already
 * handed over correctly.
 *
 * So this asks only for an account of the work, which is what a trace needs and
 * a reviewer reads.
 */
export const codeModeSummarySchema = z.object({
  summary: z
    .string()
    .default('')
    .describe('One or two sentences on what you changed and what you deliberately left alone.'),
  filesConsidered: z
    .array(z.string())
    .default([])
    .describe('Every impacted path you looked at, whether or not you proposed an edit to it.'),
});

export type CodeModeSummary = z.infer<typeof codeModeSummarySchema>;

type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const _classificationMatches: Exact<z.infer<typeof classificationSchema>, Classification> = true;
const _impactMatches: Exact<z.infer<typeof impactMapSchema>, ImpactMap> = true;
const _docsMatch: Exact<z.infer<typeof docsProposalSchema>, DocsProposal> = true;
const _changelogMatches: Exact<z.infer<typeof changelogProposalSchema>, ChangelogProposal> = true;
void _classificationMatches;
void _impactMatches;
void _docsMatch;
void _changelogMatches;
