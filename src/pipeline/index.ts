import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Config } from '../config.js';
import type {
  RunRecord,
} from '../types.js';
import { readCommitDiff, renderDiffForPrompt } from '../git/diff.js';
import { openDocsTree } from '../git/worktree.js';
import { readRepoFile } from '../git/repo.js';
import { databaseConfigured } from '../db/index.js';
import { projectForCheckoutPath } from '../db/project-store.js';
import { createRuntime, type AgentRuntime } from '../runtime/index.js';
import { loadPrices } from '../pricing.js';
import { createStores } from './stores.js';
import { RunContext, type PipelineHooks } from './context.js';
import { observeRun } from './project-memory.js';
import { runRoles } from './workflow.js';
export type { PipelineHooks } from './context.js';

/**
 * The standing instructions that apply to the repository being run.
 *
 * Saved per organization by `PUT /api/instructions`, because a house style is a
 * team's own statement about its writing and one shared file let every
 * organization on a deployment read and overwrite every other's. A run knows
 * only where it is working on disk, so the project row is what turns that path
 * back into an owner.
 *
 * Falls back to the pre-organization file whenever that lookup cannot produce
 * an owner: no database, no project row for this checkout, or a project created
 * before organizations existed. Those are the single-repository installs, where
 * one file and one team are the same thing - and the fallback is what keeps
 * instructions written before this change from silently going unread.
 */
async function standingInstructionsFor(config: Config): Promise<string | null> {
  const organizationId = await ownerOf(config.repoPath);
  if (organizationId) {
    const owned = await readRepoFile(join(config.stateDir, 'instructions'), `${organizationId}.md`);
    if (owned !== null) return owned;
  }
  return readRepoFile(config.stateDir, 'instructions.md');
}

/** The organization a checkout belongs to, or null when nothing says. */
async function ownerOf(repoPath: string): Promise<string | null> {
  if (!databaseConfigured()) return null;
  try {
    return (await projectForCheckoutPath(repoPath))?.organizationId ?? null;
  } catch {
    // A lookup failure must not stop a run: it costs the house style, not the
    // documentation. The fallback file is read either way.
    return null;
  }
}
import { applyChangelogEntry, applyDocEdits } from './apply.js';
import type { ProposedFile } from '../types.js';
import { autoApprove, createApprovalRequest, decideScope } from '../approval/gate.js';
import { openPullRequest } from '../github/pr.js';

/**
 * The Coordinator's verdict, as the pipeline consumes it.
 *
 * Declared by `coordinatorVerdictSchema` now, so the Mastra runtime can have
 * the provider enforce it rather than asking for it in prose.
 */
export type { CoordinatorVerdict } from '../agents/schemas.js';

export interface PipelineResult {
  run: RunRecord;
  /** In-memory proposed file contents, for preview and PR creation. */
  proposedFiles: ProposedFile[];
  /**
   * Set when the commit had already been documented and no work was done.
   *
   * `run` is the earlier run in that case, not a new one - there is nothing new
   * to record, and recording a run that did nothing would be the second lie.
   */
  skipped?: { reason: string; previousRunId: string; pullRequestUrl?: string };
}

export interface PipelineOptions extends PipelineHooks {
  /**
   * Resume an interrupted run rather than starting a new one.
   *
   * The run id, which is also the workflow run id. Roles that finished on the
   * earlier attempt are replayed from the snapshot instead of being asked
   * again, so a run that died after four of five costs one role to complete
   * rather than five.
   */
  resume?: string;
  /**
   * Run the roles on a runtime the caller already built.
   *
   * The replay harness passes both runtimes the same commit to compare them;
   * ordinary callers leave this alone and get the one `DOCXY_RUNTIME` names.
   */
  runtime?: AgentRuntime;
  /**
   * Run even if this commit has already been documented.
   *
   * The guard exists because nothing else was watching. A webhook redelivered
   * after its run finished, a re-trigger from the dashboard, or a restart
   * replaying a delivery each opened another identical pull request against
   * another identical branch - six of them, in this repository's own demo,
   * before anyone noticed they were all the same commit.
   */
  force?: boolean;
}







export async function runPipeline(
  config: Config,
  commitRef: string,
  options: PipelineOptions = {},
): Promise<PipelineResult> {
  const hooks: PipelineHooks = options;
  const { runs, sessions, knowledge } = createStores(config);
  // The five roles run here; the docs build runs in a Daytona workspace.
  const runtime = options.runtime ?? createRuntime(config, sessions);

  /**
   * The whole run's budget, started at the door.
   *
   * It used to be created four awaits in - after the diff, the symbol map, the
   * docs worktree, and the price table - so everything before that point was
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
  // A resume is asking for one specific run to be finished, so the
  // already-documented guard has nothing to say about it.
  if (!options.force && !options.resume && priorMap.processedCommits.includes(diff.sha)) {
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

  /**
   * A resumed run keeps its own record, and therefore its own id.
   *
   * The id is what ties the record to the workflow snapshot, so reusing it is
   * the whole mechanism: the steps that already finished are replayed from the
   * snapshot rather than re-asked, and their traces and token counts are still
   * on the record where the first attempt left them.
   */
  const resumed = options.resume ? await runs.load(options.resume) : null;
  if (options.resume && !resumed) {
    throw new Error(`No run ${options.resume} to resume.`);
  }

  const started: RunRecord = {
    id: randomUUID(),
    repoPath: config.repoPath,
    commit: { sha: diff.sha, shortSha: diff.shortSha, subject: diff.subject },
    startedAt: new Date().toISOString(),
    status: 'running',
    traces: [],
    priorSymbolCount: Object.keys(priorMap.symbols).length,
    newSymbolCount: 0,
  };
  // Only when it differs, so a run whose docs sit with the code carries no
  // field claiming otherwise.
  if (docsTree.root !== config.repoPath) started.docsRepoPath = docsTree.root;

  const run: RunRecord = resumed ?? started;
  if (resumed) {
    run.status = 'running';
    run.error = undefined;
    run.finishedAt = undefined;

    /**
     * Close out the roles the dead process left mid-flight.
     *
     * A trace still marked `running` belongs to an attempt whose process is
     * gone; nothing will ever finish it. Left as it was, the run showed two
     * traces for the same role - one perpetually running, one done - and the
     * timeline rendered the abandoned one, so a resumed run appeared to have
     * lost the very roles it had just completed.
     *
     * The attempt is recorded rather than deleted. What it spent was really
     * spent, and a run that was interrupted should look like one.
     */
    for (const trace of run.traces) {
      if (trace.status !== 'running') continue;
      trace.status = 'failed';
      trace.failure = 'aborted';
      trace.error = 'the process ended before this role finished; the run was resumed';
      trace.finishedAt = new Date().toISOString();
    }
  }
  // Only a run that is documenting a separate docs branch carries the name of
  // one; the rest have no such field rather than one holding `undefined`.
  if (docsTree.branch) run.docsBranch = docsTree.branch;

  /**
   * What earlier runs learned about this repository, read once at the door.
   *
   * Resource-scoped Mastra working memory, keyed to the repository rather than
   * to a thread - so it survives session rotation, spans all five roles, and is
   * available to the two that carry no thread at all.
   */
  const projectMemory = await runtime.loadProjectMemory();

  /**
   * Free-form standing instructions, as saved from the dashboard.
   *
   * `PUT /api/instructions` wrote this file for a long time and nothing ever
   * read it, so every instruction anyone typed into the dashboard was
   * persisted, rendered back to them, and silently ignored. The two drafting
   * roles are the ones the endpoint's own description promises read it, and
   * they are the two where a house style actually applies.
   */
  const standingInstructions = await standingInstructionsFor(config);
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
   * The run's state and the machinery that drives a role, in one object.
   *
   * Lifted out of this function so a workflow step can hold it: the retry
   * policy, the coalescing writes and the trace bookkeeping have to be
   * reachable from a step that may execute in another process after a restart.
   */
  const ctx = new RunContext(config, runtime, { runs, sessions, knowledge }, run, prices, runDeadline, hooks);
  const flush = (): Promise<void> => ctx.flush();

  await flush();

  try {
    /**
     * The five roles, as a durable workflow.
     *
     * Snapshotted step by step under this run's own id, so a process that dies
     * part-way through resumes at the first role that did not finish instead of
     * paying for the ones that did. Everything the steps need that cannot be
     * written to a snapshot - the worktree, the run context, the live event
     * stream - is handed in here, and handed in again by whoever resumes.
     */
    const outputs = await runRoles(await runtime.mastra(), run.id, {
      config,
      ctx,
      diff,
      diffText: renderDiffForPrompt(diff),
      docsPath: docsTree.path,
      stageable: docsTree.disposable,
      priorMap,
      projectMemory,
      houseStyle,
    });

    const { classification, impact, changelog, validation, verdict, changelogFile } = outputs;

    // 6. Knowledge map --------------------------------------------------------
    const { added } = await knowledge.merge(impact.symbolIndex, diff.sha);
    run.newSymbolCount = added;

    // 7. Gate and publish -----------------------------------------------------
    const proposedFiles = changelogFile ? [...outputs.applied, changelogFile] : outputs.applied;
    // Recorded now so approval and pull request creation replay exactly what was
    // reviewed, rather than re-deriving it against a tree that may have moved.
    run.proposedFiles = proposedFiles;

    /**
     * What this run taught, folded into the repository's memory.
     *
     * Here rather than after the gate, and before the empty-proposal return
     * below, because a run whose anchors all missed proposed nothing - and that
     * is precisely the observation worth keeping. Waiting for a pull request
     * would record only the runs that already worked.
     *
     * `run` is fully hydrated at this point: `docs`, `impact` and the
     * `proposedFiles` just assigned are all on it, which is what `observeRun`
     * requires and what a record from `RunStorage.list` would not have.
     */
    await runtime.saveProjectMemory(observeRun(projectMemory, run)).catch(() => {
      // Swallowed here and nowhere else. Every role has been paid for and the
      // proposal is in hand; failing the run to report that a counter did not
      // persist would throw away the thing the run exists to produce. The next
      // run rebuilds what this one failed to record.
    });

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

    // Decided here, where the verdict and the validation report are still in
    // hand, and recorded on the run so whoever publishes it later replays this
    // judgement rather than re-deriving it - or, as it was, losing it.
    run.publication = { draft: concerns.length > 0, concerns };

    /**
     * The pull request is the review surface.
     *
     * There used to be a second gate in front of it that held a finished
     * proposal until somebody signed off in docxy's own UI. It is gone: nothing
     * merges without a human approving it on GitHub either way, so the gate
     * bought a place for proposals to be forgotten rather than a decision
     * anybody was actually making.
     *
     * The record it produced is kept - scope, rationale and an automatic
     * sign-off naming the pipeline - because a run should still say what
     * scrutiny it was judged to need and who let it through. A proposal the
     * Coordinator rejected or validation failed still opens, as a draft with
     * the reasons at the top of the body: a stalled pipeline tells nobody
     * anything, and an unmergeable draft tells them exactly what went wrong.
     */
    run.approval = createApprovalRequest(run.id, scope, rationale, verdict.summary, run.approval);
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
 * Runs record their resolved contents, so this is normally a lookup - which is
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
