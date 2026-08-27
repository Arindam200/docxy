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
  RoleUsage,
  RunRecord,
} from '../types.js';
import { readCommitDiff, renderDiffForPrompt } from '../git/diff.js';
import { openDocsTree } from '../git/worktree.js';
import { buildDocsOutline, readDocExcerpts, readRepoFile } from '../git/repo.js';
import { resolveSession } from '../trueforge/session.js';
import { runTurn, type TurnUsage } from '../trueforge/run.js';
import { planRetry, sleep, type AttemptFailure } from './retry.js';
import { costOf, loadPrices, priceFor, round, type PriceTable } from '../trueforge/pricing.js';
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
import { autoApprove, createApprovalRequest, decideScope } from '../approval/gate.js';
import { openPullRequest } from '../github/pr.js';
import { AgentOutputError } from '../agents/parse.js';

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
  /**
   * Set when the commit had already been documented and no work was done.
   *
   * `run` is the earlier run in that case, not a new one — there is nothing new
   * to record, and recording a run that did nothing would be the second lie.
   */
  skipped?: { reason: string; previousRunId: string; pullRequestUrl?: string };
}

export interface PipelineOptions extends PipelineHooks {
  /**
   * Run even if this commit has already been documented.
   *
   * The guard exists because nothing else was watching. A webhook redelivered
   * after its run finished, a re-trigger from the dashboard, or a restart
   * replaying a delivery each opened another identical pull request against
   * another identical branch — six of them, in this repository's own demo,
   * before anyone noticed they were all the same commit.
   */
  force?: boolean;
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

/**
 * Fold one turn's input-side breakdown into a role's running totals.
 *
 * The categories are the harness's own — `harness`, `instructions`, `messages`,
 * `skills`, `toolDefinitions` — and it owns the list, so this stays a map keyed
 * by whatever it reports rather than a shape this side would have to keep in
 * step with it.
 */
function mergeBreakdown(into: RoleUsage['inputBreakdown'], from: TurnUsage['inputBreakdown']) {
  const out = { ...(into ?? {}) };
  for (const [key, value] of Object.entries(from)) out[key] = (out[key] ?? 0) + value;
  return out;
}

/** A settled promise's rejection reason, which the standard library types as `any`. */
function errorOf(reason: Error | string): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}

function abortedBy(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

/**
 * The two vocabularies line up almost one to one; the exceptions are the ones
 * worth naming. `transient` is reported as `harness-error` because from a
 * reader's side a dropped connection and a harness fault are the same event,
 * and `context` keeps its own name because the fix for it is different.
 */
function asRoleFailure(kind: AttemptFailure): RoleFailure {
  switch (kind) {
    case 'parse-error':
      return 'parse-error';
    case 'max-tokens':
      return 'max-tokens';
    case 'context':
      return 'context';
    case 'rate-limit':
      return 'rate-limit';
    case 'cancelled':
      return 'cancelled';
    case 'stalled':
      return 'stalled';
    default:
      return 'harness-error';
  }
}

/**
 * Roll the traces up onto the run, so the run list needs no per-role arithmetic
 * and a run that fails half way still reports what it spent getting there.
 */
function rollUp(run: RunRecord, config: Config, prices: PriceTable): void {
  const totals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
  let costUsd = 0;
  let priced = false;

  for (const trace of run.traces) {
    totals.inputTokens += trace.usage?.inputTokens ?? 0;
    totals.outputTokens += trace.usage?.outputTokens ?? 0;
    totals.cacheReadTokens += trace.usage?.cacheReadTokens ?? 0;

    // Roles can run on different models, so each is priced against its own.
    const cost = costOf(trace.usage, priceFor(trace.model, config, prices));
    if (cost !== undefined && trace.usage) {
      trace.usage.costUsd = cost;
      costUsd += cost;
      priced = true;
    }
  }

  // Left absent rather than zero when no rate was known: a run that cost
  // nothing and a run nobody could price are different facts.
  run.totals = priced ? { ...totals, costUsd: round(costUsd) } : totals;

  const end = run.finishedAt ? new Date(run.finishedAt) : new Date();
  run.durationMs = end.getTime() - new Date(run.startedAt).getTime();
}

export async function runPipeline(
  client: TrueForge,
  config: Config,
  commitRef: string,
  options: PipelineOptions = {},
): Promise<PipelineResult> {
  const hooks: PipelineHooks = options;
  const { runs, sessions, knowledge } = createStores(config);

  /**
   * The whole run's budget, started at the door.
   *
   * It used to be created four awaits in — after the diff, the symbol map, the
   * docs worktree, and the price table — so everything before that point was
   * outside the budget it is named for. A repository slow to read could spend
   * minutes there and still hand the agents a full clock, and the lane behind
   * it waited for all of it.
   */
  const runDeadline = AbortSignal.timeout(config.agent.runTimeoutMs);

  const diff = await readCommitDiff(config.repoPath, commitRef);
  const priorMap = await knowledge.load();

  // Before a single token is spent. The symbol map has recorded every commit it
  // folded in since the beginning and nothing ever read it back, so the cheapest
  // possible check was sitting there unused.
  if (!options.force && priorMap.processedCommits.includes(diff.sha)) {
    const previous = (await runs.list(200, [config.repoPath])).find(
      (candidate) => candidate.commit.sha === diff.sha && candidate.status !== 'failed',
    );
    if (previous) {
      const skipped: NonNullable<PipelineResult['skipped']> = {
        reason:
          `Commit ${diff.shortSha} has already been documented by run ` +
          `${previous.id.slice(0, 8)}. Pass force to run it again.`,
        previousRunId: previous.id,
      };
      if (previous.pullRequestUrl) skipped.pullRequestUrl = previous.pullRequestUrl;
      return { run: previous, proposedFiles: previous.proposedFiles ?? [], skipped };
    }
  }

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

  /**
   * Free-form standing instructions, as saved from the dashboard.
   *
   * `PUT /api/instructions` has written this file since the endpoint existed
   * and nothing ever read it, so every instruction anyone typed into the
   * dashboard was persisted, rendered back to them, and silently ignored. The
   * two drafting roles are the ones the endpoint's own description promises
   * read it, and they are the two where a house style actually applies.
   */
  const standingInstructions = await readRepoFile(config.stateDir, 'instructions.md');
  const houseStyle = standingInstructions?.trim()
    ? [
        '',
        '## Standing instructions for this repository',
        '',
        'These come from the team, not from the commit. They outrank your default',
        'style where the two disagree, and they never license inventing a fact the',
        'diff does not support.',
        '',
        standingInstructions.trim(),
      ].join('\n')
    : '';

  // Once per run, cached for an hour, and empty if the endpoint is unreachable.
  const prices = await loadPrices(config);

  /**
   * Serialized, coalescing, and never fatal.
   *
   * Three properties, each earning its place:
   *
   * *Serialized*, because the Docs Updater and Changelog Author run
   * concurrently and both write the same `RunRecord`. Against Postgres a save
   * rewrites the run's roles and events in one transaction, and two of those in
   * flight at once either deadlock or lose a role's trace.
   *
   * *Coalescing*, because the record is saved nineteen times in a run and
   * seventeen of those are progress updates on a record that is about to change
   * again. Callers that arrive while a write is in flight collapse into a
   * single follow-up write of the record as it stands when that write starts —
   * so a burst of role events costs one save, not one each. `flush` forces the
   * write for the points that must be durable.
   *
   * *Never fatal*, because losing the audit trail for a moment is bad and
   * killing a run that is otherwise going fine is worse.
   */
  let writing: Promise<void> | null = null;
  let pendingWrite: Promise<void> | null = null;

  const writeNow = async (): Promise<void> => {
    rollUp(run, config, prices);
    try {
      await runs.save(run);
    } catch (err) {
      console.error(
        `could not persist run ${run.id.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    hooks.onRunUpdate?.(run);
  };

  const persist = (): Promise<void> => {
    if (!writing) {
      writing = writeNow().finally(() => {
        writing = null;
      });
      return writing;
    }
    // A write is already going. Ride the one already queued behind it rather
    // than adding another: they would both save the same final state.
    pendingWrite ??= writing
      .then(() => {
        pendingWrite = null;
        return persist();
      })
      .catch(() => {});
    return pendingWrite;
  };

  /**
   * Wait for the record on disk to reflect everything written so far.
   *
   * Bounded rather than looping until quiet: at every point this is called the
   * run is between roles and nothing else is writing, so two passes is already
   * one more than needed — but a `while` here would be a spin waiting on a
   * writer that never stops, and a durability barrier must not be able to hang
   * the run it is protecting.
   */
  const flush = async (): Promise<void> => {
    for (let pass = 0; pass < 3; pass += 1) {
      await persist();
      const inFlight = writing ?? pendingWrite;
      if (!inFlight) return;
      await inFlight;
    }
  };

  await flush();

  /**
   * Run one role to completion, retrying on its own terms, and record one trace
   * either way.
   *
   * Every failure used to be terminal, which is how a single `max_tokens`
   * breach in the Changelog Author threw away three other roles' finished work.
   * Each attempt is classified and answered differently — see `planRetry` — and
   * the trace keeps every attempt's events so a run that needed three tries
   * says so instead of looking like a clean pass.
   */
  const invoke = async <T>(role: RoleDefinition, basePrompt: string): Promise<T> => {
    const startedAt = new Date();
    const trace: RoleTrace = {
      role: role.name,
      sessionId: '',
      startedAt: startedAt.toISOString(),
      status: 'running',
      events: [],
      reusedSession: false,
      // Captured up front so a role that never returns still shows what it was
      // asked and which model was meant to answer.
      prompt: truncate(basePrompt),
      model: config.models[role.name],
      attempts: 0,
    };
    run.traces.push(trace);
    await persist();

    const note = (kind: string, text: string): void => {
      const event = { at: new Date().toISOString(), kind, text };
      trace.events.push(event);
      hooks.onRoleEvent?.(role.name, event);
    };

    /** Stamp the outcome onto the trace. Runs on every path, success or not. */
    const finish = (status: RoleTrace['status'], failure?: RoleFailure): void => {
      const finishedAt = new Date();
      trace.status = status;
      trace.finishedAt = finishedAt.toISOString();
      trace.durationMs = finishedAt.getTime() - startedAt.getTime();
      if (failure) trace.failure = failure;
    };

    const maxAttempts = config.agent.maxAttempts;
    let fresh = false;
    let nudge = '';
    let lastError: Error = new Error(`[${role.title}] never ran`);

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      trace.attempts = attempt;
      const prompt = nudge ? `${basePrompt}\n\n${nudge}` : basePrompt;

      let session;
      try {
        session = await resolveSession(client, config, sessions, role, { fresh });
      } catch (err) {
        // Cannot even get a session: the harness is down or rejecting the spec.
        // Retrying a fresh session cannot help if creation is what failed.
        lastError = err instanceof Error ? err : new Error(String(err));
        note('error', `could not open a session: ${lastError.message}`);
        finish('failed', 'harness-error');
        trace.error = lastError.message;
        await persist();
        throw lastError;
      }

      trace.sessionId = session.id;
      // Only the first attempt speaks to reuse honestly; a rotated session is a
      // new one no matter what was stored before it.
      if (attempt === 1) trace.reusedSession = session.reused;
      note(
        'session',
        session.reused
          ? `reusing session ${session.id.slice(0, 8)} (${session.priorTurns} turn(s) of history)`
          : session.rotatedBecause === 'turn-limit'
            ? `retired the previous session after ${config.agent.sessionMaxTurns} turns; created ${session.id.slice(0, 8)}`
            : session.rotatedBecause === 'requested'
              ? `started over on a fresh session ${session.id.slice(0, 8)}`
              : `created session ${session.id.slice(0, 8)}`,
      );
      if (attempt > 1) note('retry', `attempt ${attempt} of ${maxAttempts}`);
      await persist();

      // A hung turn used to hang the whole run: `runTurn` accepted a signal and
      // nothing ever passed one. Two deadlines apply — this attempt's, and
      // whatever is left of the run's — and the earlier one wins.
      const timeout = AbortSignal.timeout(config.agent.attemptTimeoutMs);
      const deadline = AbortSignal.any([timeout, runDeadline]);
      let failure: AttemptFailure | undefined;
      let raw = '';

      try {
        const result = await runTurn(client, session.id, prompt, {
          signal: deadline,
          onEvent: (event) => {
            trace.events.push(event);
            hooks.onRoleEvent?.(role.name, event);
            hooks.onRunUpdate?.(run);
          },
        });

        if (result.turnId) trace.turnId = result.turnId;
        raw = result.text;

        // Counted here, not after a successful parse.
        //
        // The count exists to retire a session before its transcript overflows,
        // and the transcript grows the moment a turn is *submitted* — whether
        // or not the answer came back usable. Counting only successes meant a
        // session that kept failing never reached the limit, so it never
        // rotated, so it kept growing: precisely the spiral rotation was built
        // to stop. A `max_tokens` failure is the worst case of all, because the
        // model generated its whole budget into the transcript before failing.
        await sessions.recordTurn(role.name).catch(() => {});
        // Recorded before anything can throw. The raw text is the field that
        // explains a failure — a `max_tokens breached` error has as often meant
        // a repetition loop as a budget that was too small — and it is what
        // makes a successful run auditable rather than merely rendered.
        trace.rawOutput = truncate(result.text);
        // Accumulated across attempts: a role that burned two budgets before
        // succeeding cost all three, and the run's totals should say so.
        trace.usage = {
          inputTokens: (trace.usage?.inputTokens ?? 0) + result.usage.inputTokens,
          outputTokens: (trace.usage?.outputTokens ?? 0) + result.usage.outputTokens,
          cacheReadTokens: (trace.usage?.cacheReadTokens ?? 0) + result.usage.cacheReadTokens,
          cacheWriteTokens: (trace.usage?.cacheWriteTokens ?? 0) + result.usage.cacheWriteTokens,
          inputBreakdown: mergeBreakdown(trace.usage?.inputBreakdown, result.usage.inputBreakdown),
        };

        if (result.error) {
          failure = result.errorKind ?? 'harness';
          lastError = new Error(
            `[${role.title}] the harness ended the turn in an error state: ${result.error}`,
          );
        } else {
          try {
            const parsed = extractJson<T>(role.title, result.text);
            finish('done');
            note(
              'result',
              `produced ${result.text.length} characters ` +
                `(${result.usage.inputTokens} in / ${result.usage.outputTokens} out tokens)` +
                (attempt > 1 ? ` on attempt ${attempt}` : ''),
            );
            await persist();
            return parsed;
          } catch (cause) {
            failure = 'parse-error';
            lastError = cause instanceof Error ? cause : new Error(String(cause));
          }
        }
      } catch (err) {
        if (abortedBy(err)) {
          // Three ways to get here, and they are not the same event. The run's
          // own deadline is terminal — retrying cannot fit inside a budget that
          // is already spent. This attempt's deadline is worth another try. A
          // caller-side abort is a decision, not a fault.
          if (runDeadline.aborted) {
            lastError = new Error(
              `[${role.title}] the run exceeded its ${Math.round(config.agent.runTimeoutMs / 1000)}s budget`,
            );
            finish('failed', 'timeout');
            trace.error = lastError.message;
            await persist();
            throw lastError;
          }
          if (!timeout.aborted) {
            lastError = new Error(`[${role.title}] the run was cancelled`);
            finish('failed', 'aborted');
            trace.error = lastError.message;
            await persist();
            throw lastError;
          }
          lastError = new Error(
            `[${role.title}] no answer within ${Math.round(config.agent.attemptTimeoutMs / 1000)}s`,
          );
          // Abandoned here, but the harness still has it and the transcript
          // still grew, so it counts against the session like any other turn.
          await sessions.recordTurn(role.name).catch(() => {});
          failure = 'transient';
          note('error', lastError.message);
        } else {
          lastError = err instanceof Error ? err : new Error(String(err));
          failure = 'harness';
        }
      }

      trace.error = lastError.message;
      const plan = planRetry(failure, attempt, maxAttempts, raw);
      note(plan.retry ? 'retry' : 'error', `${failure}: ${plan.reason}`);
      await persist();

      if (!plan.retry) {
        finish('failed', asRoleFailure(failure));
        await persist();
        throw lastError;
      }

      fresh = plan.freshSession;
      nudge = plan.nudge ?? '';
      if (plan.delayMs > 0) {
        // Backing off spends the run's budget like everything else does. A
        // rate-limited role that sleeps past the deadline has spent it
        // sleeping, and waking to try again would only spend more — so this
        // ends the same way an exhausted budget ends anywhere else.
        try {
          await sleep(plan.delayMs, runDeadline);
        } catch {
          lastError = new Error(
            `[${role.title}] the run exceeded its ` +
              `${Math.round(config.agent.runTimeoutMs / 1000)}s budget while backing off`,
          );
          finish('failed', 'timeout');
          trace.error = lastError.message;
          await persist();
          throw lastError;
        }
      }
    }

    finish('failed', 'harness-error');
    await persist();
    throw lastError;
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
              houseStyle,
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
          houseStyle,
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

    /**
     * One of these two failing is a thinner proposal, not a dead run.
     *
     * Both roles read the same classification and impact map and neither
     * depends on the other's output, so the run can carry on with whichever
     * survived — a docs-only pull request, or a changelog-only one. It fails
     * only when there is nothing left to propose. This is the difference
     * between four of five roles' work reaching a reviewer and none of it
     * reaching anyone.
     */
    const degrade = (role: RoleName, reason: Error): void => {
      run.degraded = [...(run.degraded ?? []), { role, reason: reason.message }];
    };

    // `invoke` rejects only with an `Error`; `Promise.allSettled` erases that,
    // so it is re-established here rather than assumed downstream.
    if (docsResult.status === 'rejected') {
      degrade('docs-updater', errorOf(docsResult.reason));
    }
    if (changelogResult.status === 'rejected') {
      degrade('changelog-author', errorOf(changelogResult.reason));
    }

    if (docsResult.status === 'rejected' && changelogResult.status === 'rejected') {
      // Nothing to write. The Docs Updater's failure is the more informative of
      // the two, so it is the one that names the run's error.
      throw docsResult.reason;
    }

    const docs: DocsProposal =
      docsResult.status === 'fulfilled' ? docsResult.value : { edits: [], skipped: [] };
    const changelog =
      changelogResult.status === 'fulfilled' ? changelogResult.value : undefined;
    await persist();

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
    const unfinished = (run.degraded ?? []).map((d) => `${d.role}: ${d.reason}`);
    const verdict = await invoke<CoordinatorVerdict>(
      COORDINATOR,
      [
        'Review the pipeline output for the following commit and decide whether a human should see it.',
        '',
        `## Commit\n\n${diff.shortSha} ${diff.subject}`,
        // Told explicitly, because otherwise a missing section reads as a role
        // that had nothing to say rather than one that failed — and the
        // Coordinator rejects the proposal for the wrong reason.
        ...(unfinished.length > 0
          ? [
              '',
              '## Roles that did not finish',
              '',
              'These specialists failed and their sections below are empty as a result.',
              'Judge the proposal on what is present. Do not reject it for the absence',
              'of work these roles would have done; note it in `concerns` instead.',
              '',
              unfinished.map((line) => `- ${line}`).join('\n'),
            ]
          : []),
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
        docsResult.status === 'fulfilled' ? JSON.stringify(docs, null, 2) : '(the role failed)',
        '',
        '## Changelog Author',
        '',
        changelog ? JSON.stringify(changelog, null, 2) : '(the role failed)',
        '',
        '## Validation report',
        '',
        JSON.stringify(validation, null, 2),
      ].join('\n'),
    );

    // 6. Knowledge map --------------------------------------------------------
    const { added } = await knowledge.merge(impact.symbolIndex, diff.sha);
    run.newSymbolCount = added;

    // 7. Gate and publish -----------------------------------------------------
    const proposedFiles = changelogFile ? [...applied.files, changelogFile] : applied.files;
    // Recorded now so approval and pull request creation replay exactly what was
    // reviewed, rather than re-deriving it against a tree that may have moved.
    run.proposedFiles = proposedFiles;

    if (proposedFiles.length === 0) {
      run.status = 'done';
      run.error = undefined;
      run.finishedAt = new Date().toISOString();
      await flush();
      return { run, proposedFiles };
    }

    const rejected = verdict.recommendation === 'reject';
    const concerns = [
      ...(rejected ? [`Coordinator rejected the proposal: ${(verdict.concerns ?? []).join('; ') || verdict.summary}`] : []),
      ...(validation.ok
        ? []
        : [
            `Validation failed: ${validation.checks
              .filter((check) => check.status === 'fail')
              .map((check) => check.name)
              .join(', ')}`,
          ]),
    ];

    const { scope, rationale } = decideScope(classification, changelog, verdict.scope);
    run.approval = createApprovalRequest(run.id, scope, rationale, verdict.summary);

    // Decided here, where the verdict and the validation report are still in
    // hand, and recorded on the run so whoever publishes it later replays this
    // judgement rather than re-deriving it — or, as it was, losing it.
    run.publication = { draft: concerns.length > 0, concerns };

    if (config.approval.required) {
      // The gate exists and somebody asked for it. Stop here; the server and the
      // CLI both know how to carry an approved run the rest of the way.
      run.status = 'awaiting-approval';
      if (concerns.length > 0) run.error = concerns.join(' | ');
      await flush();
      return { run, proposedFiles };
    }

    // Unattended, which is the default. The gate is satisfied rather than
    // skipped, so the run record still says who approved it and when, and the
    // pull request itself becomes the review surface. A proposal the Coordinator
    // rejected or validation failed still opens — as a draft, with the reasons
    // at the top of the body, because a stalled pipeline tells nobody anything
    // and an unmergeable draft tells them exactly what went wrong.
    autoApprove(run.approval);
    run.status = 'approved';
    if (concerns.length > 0) run.error = concerns.join(' | ');
    // Durable before the branch is pushed: if publishing dies here, the record
    // must already name the files that were approved, or the proposal is lost.
    await flush();

    try {
      const pr = await openPullRequest(config, run, proposedFiles, run.publication);
      run.pullRequestUrl = pr.url;
      run.status = 'done';
      run.error = concerns.length > 0 ? concerns.join(' | ') : undefined;
    } catch (err) {
      // The proposal is sound; publishing it is what failed. Say so precisely,
      // and leave the run `approved` so the same files can be pushed again
      // without re-running five agents.
      run.status = 'approved';
      run.error = `The proposal is ready but the pull request could not be opened: ${
        err instanceof Error ? err.message : String(err)
      }`;
    }

    run.finishedAt = new Date().toISOString();
    await flush();

    return { run, proposedFiles };
  } catch (err) {
    run.status = 'failed';
    run.error = err instanceof Error ? err.message : String(err);
    run.finishedAt = new Date().toISOString();
    await flush();
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
