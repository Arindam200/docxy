import { Mastra } from '@mastra/core';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { RequestContext } from '@mastra/core/request-context';
import { z } from 'zod';
import type { Config, RoleName } from '../config.js';
import type {
  ChangelogProposal,
  Classification,
  CommitDiff,
  DocsProposal,
  ImpactMap,
  ProposedFile,
  ValidationReport,
} from '../types.js';
import type { RoleDefinition } from '../agents/roles.js';
import {
  CHANGELOG_AUTHOR,
  CHANGE_ANALYST,
  COORDINATOR,
  DOCS_UPDATER,
  IMPACT_MAPPER,
} from '../agents/roles.js';
import {
  changelogProposalSchema,
  classificationSchema,
  coordinatorVerdictSchema,
  docsProposalSchema,
  type CoordinatorVerdict,
} from '../agents/schemas.js';
import { normalizeConfidence } from '../agents/parse.js';
import { buildDocsOutline, readDocExcerpts, readRepoFile } from '../git/repo.js';
import { renderKnowledgeMap, type KnowledgeMap } from './state.js';
import { renderProjectMemory, type ProjectMemory } from './project-memory.js';
import { draftWithCodeMode } from './code-mode.js';
import { applyChangelogEntry, applyDocEdits } from './apply.js';
import { repairAnchors } from './repair.js';
import { validateProposal } from '../validate/index.js';
import type { RunContext } from './context.js';

/**
 * The five roles as a durable workflow.
 *
 * The reason this is a workflow and not the plain sequence it used to be is
 * cost. A run that dies after four roles - a redeploy, an OOM, a dropped
 * connection - used to start again from nothing and pay for all four a second
 * time. Mastra snapshots each step as it completes, so `restart()` resumes at
 * the first one that did not.
 *
 * The step bodies are the previous sequence, moved verbatim. Every property the
 * pipeline was careful about lives in `RunContext` and is untouched by this
 * file: retry classified by failure kind, the coalescing writes, turns counted
 * on submission, the two deadlines. A workflow supplies durability; it does not
 * supply any of that, and rewriting the steps to look more like Mastra examples
 * would have quietly dropped it.
 */

/**
 * Everything a step needs that cannot be written to a snapshot.
 *
 * A git worktree, an open database handle, callbacks into a live event stream.
 * These travel in the request context, which is an in-memory map for the
 * duration of one execution - and are rebuilt from scratch when a run resumes
 * in a new process, which is why `runWorkflow` takes them rather than holding
 * them in module state.
 */
export interface PipelineResources {
  config: Config;
  ctx: RunContext;
  diff: CommitDiff;
  diffText: string;
  docsPath: string;
  stageable: boolean;
  priorMap: KnowledgeMap;
  /**
   * What earlier runs learned about this repository.
   *
   * Distinct from `priorMap`, which records *what* a symbol documents. This
   * records *how well drafting has gone* against each file, which is the half
   * the pipeline was measuring in `docxy eval` and never reading back.
   */
  projectMemory: ProjectMemory;
  houseStyle: string;
}

/** A settled promise's rejection reason, which the standard library types as `any`. */
function errorOf(reason: Error | string): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}

const RESOURCES_KEY = 'docxy.resources';

function resourcesOf(requestContext: RequestContext): PipelineResources {
  const found = requestContext.getRaw(RESOURCES_KEY);
  if (!found) {
    throw new Error(
      'the pipeline resources are missing from the request context - a workflow run ' +
        'was started or resumed without them',
    );
  }
  // SAFETY: written by `runWorkflow` under this key and by nothing else; the
  // check above is what distinguishes "absent" from "the wrong shape".
  return found as PipelineResources;
}

/**
 * What crosses step boundaries, and therefore what a snapshot has to hold.
 *
 * Deliberately the role outputs and nothing else. The same values are also
 * written onto the `RunRecord` as each step finishes, which is what the
 * dashboard and the audit trail read; the copy here exists so a resumed run can
 * hand step four what step three produced without asking a model for it again.
 */
const outputs = z.object({
  classification: classificationSchema,
  impact: z.custom<ImpactMap>(),
  docs: docsProposalSchema,
  changelog: changelogProposalSchema.optional(),
  validation: z.custom<ValidationReport>(),
  verdict: coordinatorVerdictSchema,
  applied: z.custom<ProposedFile[]>(),
  changelogFile: z.custom<ProposedFile | null>(),
});

export type WorkflowOutputs = z.infer<typeof outputs>;


const changeAnalysis = createStep({
  id: 'change-analysis',
  inputSchema: z.object({}),
  outputSchema: z.object({ classification: classificationSchema }),
  execute: async ({ requestContext }) => {
      // The moved stage below is verbatim, so everything it closed over in
      // `runPipeline` is re-established here by name rather than rewritten.
      const r = resourcesOf(requestContext);
      const { diffText, ctx } = r;
      const { run } = ctx;
      const invoke = <T>(role: RoleDefinition<T>, prompt: string) => ctx.invoke(role, prompt);
      const persist = () => ctx.persist();

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

    return { classification };
  },
});

const impactMapping = createStep({
  id: 'impact-mapping',
  inputSchema: z.object({ classification: classificationSchema }),
  outputSchema: z.object({
    classification: classificationSchema,
    impact: z.custom<ImpactMap>(),
  }),
  execute: async ({ requestContext, inputData }) => {
      // The moved stage below is verbatim, so everything it closed over in
      // `runPipeline` is re-established here by name rather than rewritten.
      const r = resourcesOf(requestContext);
      const { config, diffText, priorMap, projectMemory, ctx } = r;
      const { run } = ctx;
      const docsTree = { path: r.docsPath, disposable: r.stageable };
      const invoke = <T>(role: RoleDefinition<T>, prompt: string) => ctx.invoke(role, prompt);
      const persist = () => ctx.persist();

    const { classification } = inputData;

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
          '## What earlier runs learned about this repository',
          '',
          renderProjectMemory(projectMemory, 'impact-mapper'),
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

    return { classification, impact };
  },
});

/**
 * Both drafting roles, in one step rather than two parallel ones.
 *
 * They run concurrently and settle independently: one failing is a thinner
 * proposal, not a dead run, and `Promise.allSettled` is what keeps the other
 * role's finished work. Expressed as two Mastra steps they would resume
 * independently after a crash, which is better - but only if the parallel
 * primitive settles rather than rejecting on the first failure, and the
 * degradation here was earned by three of four roles' work being binned every
 * time the fourth ran out of budget. Keeping it is worth re-running both on the
 * rarer case of a mid-drafting restart.
 */
const drafting = createStep({
  id: 'drafting',
  inputSchema: z.object({ classification: classificationSchema, impact: z.custom<ImpactMap>() }),
  outputSchema: z.object({
    classification: classificationSchema,
    impact: z.custom<ImpactMap>(),
    docs: docsProposalSchema,
    changelog: changelogProposalSchema.optional(),
  }),
  execute: async ({ requestContext, inputData }) => {
      // The moved stage below is verbatim, so everything it closed over in
      // `runPipeline` is re-established here by name rather than rewritten.
      const r = resourcesOf(requestContext);
      const { config, diffText, houseStyle, projectMemory, ctx } = r;
      const { run } = ctx;
      const docsTree = { path: r.docsPath, disposable: r.stageable };
      const invoke = <T>(role: RoleDefinition<T>, prompt: string) => ctx.invoke(role, prompt);
      const persist = () => ctx.persist();

    const { classification, impact } = inputData;

      // 3. Docs Updater and Changelog Author, in parallel ------------------------
      const impactedPaths = [...new Set(impact.docs.map((d) => d.path))];
      const excerpts = await readDocExcerpts(docsTree.path, impactedPaths);
      /**
       * Paths the Docs Updater must not propose edits against.
       *
       * The impact map in the same prompt names sections in every impacted file,
       * so a file listed there but not shown is one the model will quote from
       * memory. Unreadable and left-out are different causes with the same
       * instruction, so they are stated together and the reason is given.
       */
      const uneditable = [
        ...excerpts.missing.map((path) => `${path} (could not be read)`),
        ...excerpts.omitted.map((path) => `${path} (too large to include in this prompt)`),
      ];
      const existingChangelog =
        (await readRepoFile(docsTree.path, config.docs.changelogPath)) ??
        '(no changelog file yet - propose the first entry)';

      /**
       * Drafting by writing a program, when the flag is on.
       *
       * A different shape of turn, not a different role: same slot, same model
       * config, same place in the timeline. The prompt is deliberately thinner
       * than the prose variant's - no excerpts, no "files you were not given",
       * no truncation warnings - because the program fetches the text itself,
       * and every one of those sections exists to manage the risk of quoting
       * text that is only *described* in a prompt. See `code-mode.ts`.
       */
      const draftDocs = (): Promise<DocsProposal> =>
        config.agent.codeMode
          ? draftWithCodeMode(ctx, {
              docsPath: docsTree.path,
              impactedPaths,
              prompt: [
                'Draft the documentation edits for the following change.',
                '',
                '## Classification',
                '',
                JSON.stringify(classification, null, 2),
                '',
                '## Impact map - these are the only paths you may read or edit',
                '',
                JSON.stringify(impact.docs, null, 2),
                '',
                '## What earlier runs learned about this repository',
                '',
                renderProjectMemory(projectMemory, 'docs-updater'),
                '',
                '## Commit diff',
                '',
                diffText,
                houseStyle,
              ].join('\n'),
            }).then((result) => result.proposal)
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
                /**
                 * This role carries no thread, and still gets what the
                 * repository taught.
                 *
                 * That is the point of keeping project memory out of the
                 * agent's own memory: `carriesMemory` is false here because a
                 * thread hands this role older copies of the very files it must
                 * quote exactly. Counters about how often its anchors matched
                 * carry none of that text, so they can be given to it safely -
                 * and this is the role they were always about.
                 */
                '',
                '## What earlier runs learned about this repository',
                '',
                renderProjectMemory(projectMemory, 'docs-updater'),
                uneditable.length > 0
                  ? [
                      '',
                      '## Files you were NOT given',
                      '',
                      'These are named in the impact map above, but their text is not below.',
                      'You cannot see them, so you cannot quote them. List every one under',
                      '`skipped` with the reason given here. Do not propose an edit to any of',
                      'them - an anchor you did not copy from text in this prompt will not',
                      'match, and the whole proposal is rejected when it does not.',
                      '',
                      ...uneditable.map((line) => `- ${line}`),
                    ].join('\n')
                  : '',
                excerpts.truncated.length > 0
                  ? [
                      '',
                      '## Files you were given only part of',
                      '',
                      `${excerpts.truncated.join(', ')} - each is marked below with how much`,
                      'you can see. Anchor only inside the text you were given.',
                    ].join('\n')
                  : '',
                '',
                '## Current text of the impacted docs',
                '',
                excerpts.text,
                '',
                '## Commit diff',
                '',
                diffText,
                houseStyle,
              ].join('\n'),
            );

      const [docsResult, changelogResult] = await Promise.allSettled([
        impactedPaths.length === 0
          ? Promise.resolve<DocsProposal>({ edits: [], skipped: [] })
          : draftDocs(),
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
            `## Existing changelog (${config.docs.changelogPath}) - match its voice`,
            '',
            existingChangelog.slice(0, 6000),
            houseStyle,
          ].join('\n'),
        ),
      ]);

      // Settled, not `all`. These two roles run in parallel and fail
      // independently, and `Promise.all` rejected on the first failure - throwing
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
       * survived - a docs-only pull request, or a changelog-only one. It fails
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

    return { classification, impact, docs, changelog };
  },
});

const validation = createStep({
  id: 'validation',
  inputSchema: z.object({
    classification: classificationSchema,
    impact: z.custom<ImpactMap>(),
    docs: docsProposalSchema,
    changelog: changelogProposalSchema.optional(),
  }),
  outputSchema: z.object({
    classification: classificationSchema,
    impact: z.custom<ImpactMap>(),
    docs: docsProposalSchema,
    changelog: changelogProposalSchema.optional(),
    validation: z.custom<ValidationReport>(),
    applied: z.custom<ProposedFile[]>(),
    changelogFile: z.custom<ProposedFile | null>(),
  }),
  execute: async ({ requestContext, inputData }) => {
      // The moved stage below is verbatim, so everything it closed over in
      // `runPipeline` is re-established here by name rather than rewritten.
      const r = resourcesOf(requestContext);
      const { config, ctx } = r;
      const { run, hooks } = ctx;
      const runDeadline = ctx.deadline;
      const docsTree = { path: r.docsPath, disposable: r.stageable };
      const persist = () => ctx.persist();

    const { classification, impact, docs, changelog } = inputData;

      // 4. Validation -----------------------------------------------------------
      const firstPass = await applyDocEdits(docsTree.path, docs);

      /**
       * One targeted second look at the edits that did not anchor.
       *
       * A mis-quoted `find` costs the whole proposal, and what is left after
       * three upstream fixes is the model paraphrasing - which cannot be
       * repaired in code, because none of it is whitespace drift. Bounded to
       * one call, over only the failing files, and kept only if it anchors more
       * than the first pass did.
       */
      const repair = config.agent.repairAnchors
        ? await repairAnchors(ctx, docsTree.path, docs, firstPass)
        : { docs, applied: firstPass };
      if (repair.attempted) {
        hooks.onRoleEvent?.('docs-updater', {
          at: new Date().toISOString(),
          kind: 'repair',
          text:
            repair.attempted.fixed > 0
              ? `re-anchored ${repair.attempted.fixed} of ${repair.attempted.broken} failed edit(s)`
              : `could not re-anchor ${repair.attempted.broken} failed edit(s); kept the first proposal`,
        });
      }
      const applied = repair.applied;
      docs.edits = repair.docs.edits;
      docs.skipped = repair.docs.skipped;
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
        // Validation is the one stage that executes anything, and on a slow docs
        // build it is the longest silence in the run. Routing its events to the
        // Coordinator's lane keeps the timeline moving and makes the sandbox
        // visible while it works rather than only in the finished report.
        onEvent: (event) => {
          hooks.onRoleEvent?.('coordinator', event);
          hooks.onRunUpdate?.(run);
        },
        signal: runDeadline,
      });
      run.validation = validation;
      await persist();

    return {
      classification,
      impact,
      docs,
      changelog,
      validation,
      applied: applied.files,
      changelogFile,
    };
  },
});

const coordination = createStep({
  id: 'coordination',
  inputSchema: validation.outputSchema,
  outputSchema: outputs,
  execute: async ({ requestContext, inputData }) => {
      // The moved stage below is verbatim, so everything it closed over in
      // `runPipeline` is re-established here by name rather than rewritten.
      const r = resourcesOf(requestContext);
      const { diff, ctx } = r;
      const { run } = ctx;
      const invoke = <T>(role: RoleDefinition<T>, prompt: string) => ctx.invoke(role, prompt);

    const { classification, impact, docs, changelog, validation: report, applied, changelogFile } =
      inputData;
    // The moved stage reads these under their original names.
    void report;

      // 5. Coordinator ----------------------------------------------------------
      const unfinished = (run.degraded ?? []).map((d) => `${d.role}: ${d.reason}`);
      const verdict = await invoke<CoordinatorVerdict>(
        COORDINATOR,
        [
          'Review the pipeline output for the following commit and decide whether a human should see it.',
          '',
          `## Commit\n\n${diff.shortSha} ${diff.subject}`,
          // Told explicitly, because otherwise a missing section reads as a role
          // that had nothing to say rather than one that failed - and the
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
          (run.degraded ?? []).some((d) => d.role === 'docs-updater')
          ? '(the role failed)'
          : JSON.stringify(docs, null, 2),
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

    return {
      classification,
      impact,
      docs,
      changelog,
      validation: report,
      verdict,
      applied,
      changelogFile,
    };
  },
});

export const docsPipelineWorkflow = createWorkflow({
  id: 'docxy-docs-pipeline',
  inputSchema: z.object({}),
  outputSchema: outputs,
})
  .then(changeAnalysis)
  .then(impactMapping)
  .then(drafting)
  .then(validation)
  .then(coordination)
  .commit();

/**
 * Run the five roles, resuming a previous attempt at this run if there is one.
 *
 * `runId` is the docxy run id, reused as the workflow run id so the two records
 * of one run share a name. That is what makes resumption possible at all: a
 * process that died leaves a snapshot under this id, and `restart()` picks up at
 * the first step that did not finish rather than at the beginning.
 *
 * Resources are handed in on every call, including the resuming one. They are a
 * worktree, a database handle and callbacks into a live event stream - none of
 * which can be written to a snapshot, all of which the new process has just
 * rebuilt.
 */
export async function runRoles(
  mastra: Mastra,
  runId: string,
  resources: PipelineResources,
): Promise<WorkflowOutputs> {
  const workflow = mastra.getWorkflow('docsPipeline');

  // Asked before `createRun`, which registers a record of its own - checking
  // afterwards found that record and tried to restart a run that had never
  // started, which fails with "this workflow run was not active".
  //
  // `restart` is right for every snapshot that exists, and the three cases were
  // measured rather than assumed. A `running` snapshot resumes at the first
  // step that did not finish. A `success` snapshot replays its stored result
  // and executes nothing - which matters more than it sounds, because a process
  // that died between the last role and the pull request would otherwise pay
  // for all five again to reach a proposal it had already produced.
  //
  // `isFromInMemory` marks a record the store never actually persisted, whose
  // step data is empty; restarting from one would replay everything anyway
  // while claiming to resume.
  const previous = await workflow.getWorkflowRunById(runId).catch(() => null);
  const resumable = Boolean(previous) && previous?.isFromInMemory !== true;

  // The third case. `restart` returns the stored failure without re-running a
  // thing, so resuming one would look like an instant, silent failure. A failed
  // run is retried by starting a new one, and saying so is the whole fix.
  if (previous?.status === 'failed') {
    throw new Error(
      `Workflow run ${runId.slice(0, 8)} failed, and a failed run replays its failure ` +
        'rather than retrying. Start a fresh run instead: `docxy run <ref> --force`.',
    );
  }

  const run = await workflow.createRun({ runId });
  const requestContext = new RequestContext();
  requestContext.setRaw(RESOURCES_KEY, resources);

  // Said out loud because the difference is money: a restart replays the steps
  // that already finished instead of paying for them again, and a resume that
  // quietly started from scratch would look identical from the outside.
  resources.ctx.hooks.onRoleEvent?.('coordinator', {
    at: new Date().toISOString(),
    kind: 'workflow',
    text: resumable
      ? `resuming workflow run ${runId.slice(0, 8)} from its snapshot (${previous?.status})`
      : 'starting a new workflow run',
  });

  const result = resumable
    ? await run.restart({ requestContext })
    : await run.start({ inputData: {}, requestContext });

  if (result.status !== 'success') {
    // A step threw. `RunContext` has already recorded why on the run record and
    // on the role's trace, so this only has to stop the pipeline - the reason a
    // reader needs is already durable.
    const failed = result.status === 'failed' ? result.error : new Error(result.status);
    throw failed instanceof Error ? failed : new Error(String(failed));
  }
  return result.result;
}

/** The workflow, registered under the name `runRoles` looks it up by. */
export function pipelineWorkflows() {
  return { docsPipeline: docsPipelineWorkflow };
}
