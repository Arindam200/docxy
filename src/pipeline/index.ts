import { randomUUID } from 'node:crypto';
import type { TrueForge } from '@truefoundry/trueforge-sdk';
import type { Config, RoleName } from '../config.js';
import type {
  ChangelogProposal,
  Classification,
  DocsProposal,
  ImpactMap,
  RoleFailure,
  RoleTrace,
  RunRecord,
} from '../types.js';
import { readCommitDiff, renderDiffForPrompt } from '../git/diff.js';
import { openDocsTree } from '../git/worktree.js';
import { buildDocsOutline, readDocExcerpts, readRepoFile } from '../git/repo.js';
import { resolveSession } from '../trueforge/session.js';
import { runTurn } from '../trueforge/run.js';
import {
  CHANGELOG_AUTHOR,
  CHANGE_ANALYST,
  COORDINATOR,
  DOCS_UPDATER,
  IMPACT_MAPPER,
  type RoleDefinition,
} from '../agents/roles.js';
import { extractJson, normalizeConfidence } from '../agents/parse.js';
import { renderKnowledgeMap } from './state.js';
import { createStores } from './stores.js';
import { applyChangelogEntry, applyDocEdits } from './apply.js';
import type { ProposedFile } from '../types.js';
import { validateProposal } from '../validate/index.js';
import { createApprovalRequest, decideScope } from '../approval/gate.js';

export interface PipelineHooks {
  onRunUpdate?: (run: RunRecord) => void;
  onRoleEvent?: (role: RoleName, event: { at: string; kind: string; text: string }) => void;
}

interface CoordinatorVerdict {
  recommendation: 'approve' | 'reject';
  scope: 'routine' | 'elevated';
  scopeRationale: string;
  summary: string;
  concerns: string[];
}

export interface PipelineResult {
  run: RunRecord;
  /** In-memory proposed file contents, for preview and PR creation. */
  proposedFiles: ProposedFile[];
}

/**
 * Prompts and raw outputs are recorded verbatim, and a diff-heavy prompt can be
 * large. This bounds a single field rather than the record as a whole; the tail
 * is where truncation shows, and the head is what explains a bad answer.
 */
const BODY_LIMIT = 100_000;

function truncate(text: string): string {
  if (text.length <= BODY_LIMIT) return text;
  return `${text.slice(0, BODY_LIMIT)}\n\n… truncated, ${text.length - BODY_LIMIT} more characters`;
}

function abortedBy(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

/**
 * Roll the traces up onto the run, so the run list needs no per-role arithmetic
 * and a run that fails half way still reports what it spent getting there.
 */
function rollUp(run: RunRecord): void {
  const totals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
  for (const trace of run.traces) {
    totals.inputTokens += trace.usage?.inputTokens ?? 0;
    totals.outputTokens += trace.usage?.outputTokens ?? 0;
    totals.cacheReadTokens += trace.usage?.cacheReadTokens ?? 0;
  }
  run.totals = totals;

  const end = run.finishedAt ? new Date(run.finishedAt) : new Date();
  run.durationMs = end.getTime() - new Date(run.startedAt).getTime();
}

export async function runPipeline(
  client: TrueForge,
  config: Config,
  commitRef: string,
  hooks: PipelineHooks = {},
): Promise<PipelineResult> {
  const { runs, sessions, knowledge } = createStores(config);

  const diff = await readCommitDiff(config.repoPath, commitRef);
  const priorMap = await knowledge.load();

  // Docs may live on their own branch. This resolves to a throwaway worktree at
  // that branch's tip, or to the code checkout when they live alongside the code.
  const docsTree = await openDocsTree(config);

  const run: RunRecord = {
    id: randomUUID(),
    repoPath: config.repoPath,
    commit: { sha: diff.sha, shortSha: diff.shortSha, subject: diff.subject },
    startedAt: new Date().toISOString(),
    status: 'running',
    ...(docsTree.branch ? { docsBranch: docsTree.branch } : {}),
    traces: [],
    priorSymbolCount: Object.keys(priorMap.symbols).length,
    newSymbolCount: 0,
  };

  const persist = async (): Promise<void> => {
    rollUp(run);
    await runs.save(run);
    hooks.onRunUpdate?.(run);
  };
  await persist();

  /** Run one role to completion, recording a trace entry either way. */
  const invoke = async <T>(role: RoleDefinition, prompt: string): Promise<T> => {
    const session = await resolveSession(client, config, sessions, role);
    const startedAt = new Date();
    const trace: RoleTrace = {
      role: role.name,
      sessionId: session.id,
      startedAt: startedAt.toISOString(),
      status: 'running',
      events: [],
      reusedSession: session.reused,
      // Captured up front so a role that never returns still shows what it was
      // asked and which model was meant to answer.
      prompt: truncate(prompt),
      model: config.models[role.name],
    };
    run.traces.push(trace);
    trace.events.push({
      at: trace.startedAt,
      kind: 'session',
      text: session.reused
        ? `reusing session ${session.id.slice(0, 8)} from an earlier commit`
        : `created session ${session.id.slice(0, 8)}`,
    });
    await persist();

    /** Stamp the outcome onto the trace. Runs on every path, success or not. */
    const finish = (status: RoleTrace['status'], failure?: RoleFailure): void => {
      const finishedAt = new Date();
      trace.status = status;
      trace.finishedAt = finishedAt.toISOString();
      trace.durationMs = finishedAt.getTime() - startedAt.getTime();
      if (failure) trace.failure = failure;
    };

    try {
      const result = await runTurn(client, session.id, prompt, {
        onEvent: (event) => {
          trace.events.push(event);
          hooks.onRoleEvent?.(role.name, event);
          hooks.onRunUpdate?.(run);
        },
      });

      if (result.turnId) trace.turnId = result.turnId;
      // Recorded before anything can throw. The raw text is the field that
      // explains a failure — a `max_tokens breached` error has as often meant a
      // repetition loop as a budget that was too small — and it is what makes a
      // successful run auditable rather than merely rendered.
      trace.rawOutput = truncate(result.text);
      trace.usage = {
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        cacheReadTokens: result.usage.cacheReadTokens,
        cacheWriteTokens: result.usage.cacheWriteTokens,
        inputBreakdown: result.usage.inputBreakdown,
      };

      if (result.error) {
        finish('failed', 'harness-error');
        await persist();
        throw new Error(
          `[${role.title}] the harness ended the turn in an error state: ${result.error}`,
        );
      }

      let parsed: T;
      try {
        parsed = extractJson<T>(role.title, result.text);
      } catch (cause) {
        finish('failed', 'parse-error');
        trace.error = cause instanceof Error ? cause.message : String(cause);
        await persist();
        throw cause;
      }

      finish('done');
      trace.events.push({
        at: trace.finishedAt as string,
        kind: 'result',
        text:
          `produced ${result.text.length} characters ` +
          `(${result.usage.inputTokens} in / ${result.usage.outputTokens} out tokens)`,
      });
      await persist();
      return parsed;
    } catch (err) {
      // Already stamped by one of the branches above unless the failure came
      // from the harness call itself.
      if (trace.status === 'running') finish('failed', abortedBy(err) ? 'aborted' : 'harness-error');
      trace.error ??= err instanceof Error ? err.message : String(err);
      await persist();
      throw err;
    }
  };

  try {
    const diffText = renderDiffForPrompt(diff);

    // 1. Change Analyst -------------------------------------------------------
    const classification = await invoke<Classification>(
      CHANGE_ANALYST,
      [
        'Classify the following commit.',
        '',
        '## Commit diff',
        '',
        diffText,
      ].join('\n'),
    );
    classification.confidence = normalizeConfidence(classification.confidence);
    classification.changedSymbols = classification.changedSymbols ?? [];
    run.classification = classification;
    await persist();

    // 2. Impact Mapper --------------------------------------------------------
    const { outline } = await buildDocsOutline(docsTree.path, config.docs.roots);
    const impact = await invoke<ImpactMap>(
      IMPACT_MAPPER,
      [
        'Map the impact of the following classified change.',
        '',
        '## Classification',
        '',
        JSON.stringify(classification, null, 2),
        '',
        '## Symbol map carried over from earlier commits',
        '',
        renderKnowledgeMap(priorMap),
        '',
        '## Documentation outline (every path below is real; do not invent others)',
        '',
        outline || '(no documentation files found under the configured roots)',
        '',
        '## Commit diff',
        '',
        diffText,
      ].join('\n'),
    );
    impact.docs = (impact.docs ?? []).map((d) => ({
      ...d,
      confidence: normalizeConfidence(d.confidence),
    }));
    impact.code = impact.code ?? [];
    impact.symbolIndex = impact.symbolIndex ?? {};
    run.impact = impact;
    await persist();

    // 3. Docs Updater and Changelog Author, in parallel ------------------------
    const impactedPaths = [...new Set(impact.docs.map((d) => d.path))];
    const { text: docExcerpts, missing } = await readDocExcerpts(docsTree.path, impactedPaths);
    const existingChangelog =
      (await readRepoFile(docsTree.path, config.docs.changelogPath)) ??
      '(no changelog file yet — propose the first entry)';

    const [docsResult, changelogResult] = await Promise.allSettled([
      impactedPaths.length === 0
        ? Promise.resolve<DocsProposal>({ edits: [], skipped: [] })
        : invoke<DocsProposal>(
            DOCS_UPDATER,
            [
              'Draft the documentation edits for the following change.',
              '',
              '## Classification',
              '',
              JSON.stringify(classification, null, 2),
              '',
              '## Impact map',
              '',
              JSON.stringify(impact.docs, null, 2),
              missing.length > 0
                ? `\nThese impacted paths could not be read and must be skipped: ${missing.join(', ')}`
                : '',
              '',
              '## Current text of the impacted docs',
              '',
              docExcerpts,
              '',
              '## Commit diff',
              '',
              diffText,
            ].join('\n'),
          ),
      invoke<ChangelogProposal>(
        CHANGELOG_AUTHOR,
        [
          'Write the changelog entry for the following change.',
          '',
          '## Classification',
          '',
          JSON.stringify(classification, null, 2),
          '',
          '## Impact map',
          '',
          JSON.stringify({ docs: impact.docs, code: impact.code }, null, 2),
          '',
          `## Existing changelog (${config.docs.changelogPath}) — match its voice`,
          '',
          existingChangelog.slice(0, 6000),
        ].join('\n'),
      ),
    ]);

    // Settled, not `all`. These two roles run in parallel and fail
    // independently, and `Promise.all` rejected on the first failure — throwing
    // away the other role's finished work before it could be recorded. Three of
    // four roles had done correct work in every failed run, and none of it was
    // visible. Record what succeeded, then decide whether the run can continue.
    if (docsResult.status === 'fulfilled') {
      const proposal = docsResult.value;
      proposal.edits = proposal.edits ?? [];
      proposal.skipped = proposal.skipped ?? [];
      run.docs = proposal;
    }
    if (changelogResult.status === 'fulfilled') {
      run.changelog = changelogResult.value;
    }
    await persist();

    if (docsResult.status === 'rejected') throw docsResult.reason;
    if (changelogResult.status === 'rejected') throw changelogResult.reason;

    const docs = docsResult.value;
    const changelog = changelogResult.value;

    // 4. Validation -----------------------------------------------------------
    const applied = await applyDocEdits(docsTree.path, docs);
    const changelogFile = changelog?.entry
      ? await applyChangelogEntry(docsTree.path, config.docs.changelogPath, changelog)
      : null;

    const validation = await validateProposal({
      config,
      applied,
      changelogFile,
      classification,
      changelog,
      docsPath: docsTree.path,
      stageable: docsTree.disposable,
    });
    run.validation = validation;
    await persist();

    // 5. Coordinator ----------------------------------------------------------
    const verdict = await invoke<CoordinatorVerdict>(
      COORDINATOR,
      [
        'Review the pipeline output for the following commit and decide whether a human should see it.',
        '',
        `## Commit\n\n${diff.shortSha} ${diff.subject}`,
        '',
        '## Change Analyst',
        '',
        JSON.stringify(classification, null, 2),
        '',
        '## Impact Mapper',
        '',
        JSON.stringify(impact, null, 2),
        '',
        '## Docs Updater',
        '',
        JSON.stringify(docs, null, 2),
        '',
        '## Changelog Author',
        '',
        JSON.stringify(changelog, null, 2),
        '',
        '## Validation report',
        '',
        JSON.stringify(validation, null, 2),
      ].join('\n'),
    );

    // 6. Knowledge map --------------------------------------------------------
    const { added } = await knowledge.merge(impact.symbolIndex, diff.sha);
    run.newSymbolCount = added;

    // 7. Approval gate --------------------------------------------------------
    const proposedFiles = changelogFile ? [...applied.files, changelogFile] : applied.files;
    // Recorded now so approval and pull request creation replay exactly what was
    // reviewed, rather than re-deriving it against a tree that may have moved.
    run.proposedFiles = proposedFiles;

    if (verdict.recommendation === 'reject' || !validation.ok) {
      run.status = 'failed';
      run.error =
        verdict.recommendation === 'reject'
          ? `Coordinator rejected the proposal: ${(verdict.concerns ?? []).join('; ') || verdict.summary}`
          : `Validation failed: ${validation.checks
              .filter((c) => c.status === 'fail')
              .map((c) => c.name)
              .join(', ')}`;
      run.finishedAt = new Date().toISOString();
      await persist();
      return { run, proposedFiles };
    }

    if (proposedFiles.length === 0) {
      run.status = 'done';
      run.error = undefined;
      run.finishedAt = new Date().toISOString();
      await persist();
      return { run, proposedFiles };
    }

    const { scope, rationale } = decideScope(classification, changelog, verdict.scope);
    run.approval = createApprovalRequest(run.id, scope, rationale, verdict.summary);
    run.status = 'awaiting-approval';
    await persist();

    return { run, proposedFiles };
  } catch (err) {
    run.status = 'failed';
    run.error = err instanceof Error ? err.message : String(err);
    run.finishedAt = new Date().toISOString();
    await persist();
    throw Object.assign(err instanceof Error ? err : new Error(String(err)), { run });
  } finally {
    await docsTree.dispose();
  }
}

/**
 * The proposed file contents for a stored run, for preview or PR creation.
 *
 * Runs record their resolved contents, so this is normally a lookup — which is
 * the point: re-deriving edits at approval time would silently re-anchor them
 * against a docs branch that may have moved since the reviewer looked. Only runs
 * recorded before that field existed fall back to recomputing.
 */
export async function rebuildProposedFiles(
  config: Config,
  run: RunRecord,
): Promise<ProposedFile[]> {
  if (run.proposedFiles) return run.proposedFiles;
  if (!run.docs || !run.changelog) return [];

  const docsTree = await openDocsTree(config);
  try {
    const applied = await applyDocEdits(docsTree.path, run.docs);
    const changelogFile = run.changelog.entry
      ? await applyChangelogEntry(docsTree.path, config.docs.changelogPath, run.changelog)
      : null;
    return changelogFile ? [...applied.files, changelogFile] : applied.files;
  } finally {
    await docsTree.dispose();
  }
}
