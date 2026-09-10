import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractJson, normalizeConfidence } from '../src/agents/parse.js';
import { applyDocEdits, applyChangelogEntry } from '../src/pipeline/apply.js';
import { checkLinks } from '../src/validate/links.js';
import { autoApprove, decideScope, createApprovalRequest } from '../src/approval/gate.js';
import { RunContext } from '../src/pipeline/context.js';
import type { AgentRuntime, TurnResult } from '../src/runtime/index.js';
import type { RoleDefinition } from '../src/agents/roles.js';
import { openDocsTree, resolveBaseRef } from '../src/git/worktree.js';
import { listDocs, readDocExcerpts, readRepoFile } from '../src/git/repo.js';
import { docsRoot, loadConfig, prBaseBranch } from '../src/config.js';
import type { Config } from '../src/config.js';
import { RunStore } from '../src/pipeline/store.js';
import { costOf, priceFor } from '../src/pricing.js';
import { classifyTurnError } from '../src/runtime/types.js';
import { renderDiffForPrompt } from '../src/git/diff.js';
import { nextPage } from '../src/github/checkout.js';
import { normalizePem, readAppCredentials, appStatus } from '../src/github/app.js';
import { redactSecrets } from '../src/guardrails/secrets.js';
import { scoreRuns } from '../src/evals/index.js';
import { repairAnchors } from '../src/pipeline/repair.js';
import { LocalSandbox } from '@mastra/core/workspace';
import {
  buildProgram,
  checkProposedEdit,
  createCodeModeSession,
  createDraftingSandbox,
  readProgramOutput,
  type ProposedEditInput,
} from '../src/pipeline/code-mode.js';
import {
  emptyProjectMemory,
  observeRun,
  parseProjectMemory,
  renderProjectMemory,
  serializeProjectMemory,
} from '../src/pipeline/project-memory.js';
import type { DocsProposal } from '../src/types.js';
import type { CommitDiff, DiffFile } from '../src/types.js';
import { planRetry } from '../src/pipeline/retry.js';
import type { RoleName } from '../src/config.js';
import type { DocEdit, RoleTrace, RunRecord } from '../src/types.js';
import { buildReport } from '../src/server/observability.js';
import { rollUp } from '../web/src/lib/projects.js';
import { eventVisible, isCommitSha, isLoopbackHost, tokenMatches } from '../src/server/index.js';
import { deliveryAllowed } from '../src/server/allowlist.js';
import { CHANGE_ANALYST, COORDINATOR, DOCS_UPDATER } from '../src/agents/roles.js';
import {
  changelogProposalSchema,
  classificationSchema,
  docsProposalSchema,
  impactMapSchema,
} from '../src/agents/schemas.js';
import { MastraRuntime, readUsage } from '../src/runtime/mastra.js';
import { mastraModelFor } from '../src/config.js';
import type { SessionStorage } from '../src/pipeline/stores.js';
import { validateProposal } from '../src/validate/index.js';
import {
  networkHint,
  runCommandInWorkspace,
  workspaceConfigured,
} from '../src/validate/workspace.js';
import {
  entitlementsFor,
  formatUsd,
  monthlyPriceMinor,
  normalizeSeats,
  parsePlanKey,
  plans,
  seatAddOnQuantity,
} from '../src/billing/catalog.js';
import { addMonthsUtc, freePeriodBounds } from '../src/billing/periods.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const sh = async (cwd: string, args: string[]) => exec('git', args, { cwd });

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
}

// --- parse ---------------------------------------------------------------
check('fenced json', extractJson<any>('t', 'blah\n```json\n{"a":1}\n```\ntrailing').a === 1);
check('bare json', extractJson<any>('t', 'here: {"a":2} done').a === 2);
check('json with nested braces in string',
  extractJson<any>('t', '{"a":"has } brace","b":3}').b === 3);
check('array payload', Array.isArray(extractJson<any>('t', '[1,2,3]')));
try { extractJson('t', 'no json at all'); check('throws on garbage', false); }
catch { check('throws on garbage', true); }
check('confidence percent', normalizeConfidence(85) === 0.85);
check('confidence clamp', normalizeConfidence(2) === 1);
check('confidence junk', normalizeConfidence('abc', 0.4) === 0.4);

// --- diff budget ---------------------------------------------------------
{
  const file = (path: string, size: number): DiffFile => ({
    path,
    status: 'modified',
    additions: 1,
    deletions: 0,
    patch: 'x'.repeat(size),
    truncated: false,
  });
  const commitOf = (files: DiffFile[]): CommitDiff => ({
    sha: 'abc123', shortSha: 'abc123', subject: 's', body: '', author: 'a', date: 'd',
    files, totalAdditions: files.length, totalDeletions: 0,
  });

  const small = renderDiffForPrompt(commitOf([file('a.ts', 100), file('b.ts', 200)]));
  check('a small diff is rendered whole', small.includes('a.ts') && small.includes('b.ts'));
  check('a small diff drops nothing', !small.includes('too large to include'));

  // Fifty files at the per-file cap: each one is legal, the sum is not.
  const huge = commitOf(Array.from({ length: 50 }, (_, i) => file(`gen/f${i}.ts`, 12_000)));
  const rendered = renderDiffForPrompt(huge);
  check('a huge diff is bounded', rendered.length < 260_000, `got ${rendered.length}`);
  check('dropped files are named, not silently missing',
    rendered.includes('too large to include'));

  // The one hand-written file among a hundred generated ones is the one that
  // has documentation consequences, so it is the one that must survive.
  const mixed = commitOf([
    ...Array.from({ length: 40 }, (_, i) => file(`gen/f${i}.ts`, 12_000)),
    file('src/api.ts', 300),
  ]);
  const keptSmall = renderDiffForPrompt(mixed);
  check('the smallest file survives a crowded diff',
    keptSmall.includes('x'.repeat(300)) && keptSmall.includes('src/api.ts'));

  // The notice about dropped files is itself a rendering, and a commit that
  // drops twenty thousand files would otherwise pay a line for every one -
  // overflowing the context window on the explanation for why the diff was
  // trimmed to protect it.
  const deep = `gen/${'nested/'.repeat(15)}`;
  const many = commitOf(
    Array.from({ length: 20_000 }, (_, i) => file(`${deep}component-${i}.tsx`, 200)),
  );
  const manyRendered = renderDiffForPrompt(many);
  check('a diff that drops thousands of files is still bounded',
    manyRendered.length < 200_000, `got ${manyRendered.length}`);
  check('the files past the manifest budget are counted, not listed',
    manyRendered.includes('too many to list by name'));
  check('the manifest still names the files it can',
    manyRendered.includes('component-'));

  // A release commit can paste a whole changelog into its message body.
  const chatty = commitOf([file('src/api.ts', 100)]);
  const rendered2 = renderDiffForPrompt({ ...chatty, body: 'y'.repeat(50_000) });
  check('an enormous commit message body is truncated',
    rendered2.length < 20_000 && rendered2.includes('message truncated'),
    `got ${rendered2.length}`);
}

// --- turn failure classification -----------------------------------------
check('max_tokens is named', classifyTurnError('max_tokens breached') === 'max-tokens');
check('finish reason length is a budget failure',
  classifyTurnError('the model stopped at its output budget (finish reason: length)') === 'max-tokens');
check('context overflow is its own kind',
  classifyTurnError('This model\'s maximum context length is 262144 tokens') === 'context');
check('rate limits are named', classifyTurnError('HTTP 429 Too Many Requests') === 'rate-limit');
check('dropped sockets are transient', classifyTurnError('socket hang up') === 'transient');
check('server timeouts are transient',
  classifyTurnError('the harness cancelled the turn (server-execution-timeout)') === 'transient');
check('anything else stays generic', classifyTurnError('the provider said no') === 'harness');

// --- retry policy --------------------------------------------------------
{
  const budget = planRetry('max-tokens', 1, 3);
  check('a budget failure retries', budget.retry);
  check('a budget failure drops the session', budget.freshSession);
  check('a budget failure asks for brevity', (budget.nudge ?? '').includes('output budget'));

  const parse = planRetry('parse-error', 1, 3, '{ not json');
  check('the first parse repair stays in-session', parse.retry && !parse.freshSession);
  check('the parse repair shows the model its own output',
    (parse.nudge ?? '').includes('{ not json'));
  check('the second parse repair rotates the session',
    planRetry('parse-error', 2, 3, '').freshSession);

  const transient = planRetry('transient', 1, 3);
  check('a transient failure keeps the session', transient.retry && !transient.freshSession);
  check('backoff grows with the attempt',
    planRetry('transient', 2, 4).delayMs > transient.delayMs);
  check('rate limits back off further than a dropped socket',
    planRetry('rate-limit', 1, 3).delayMs > transient.delayMs);

  check('the last attempt does not retry', !planRetry('max-tokens', 3, 3).retry);
  check('a single-attempt budget never retries', !planRetry('transient', 1, 1).retry);
}

// --- apply ---------------------------------------------------------------
const repo = await mkdtemp(join(tmpdir(), 'chron-test-'));
await mkdir(join(repo, 'docs'), { recursive: true });
await writeFile(join(repo, 'docs/api.md'),
  '# API\n\n## Configuration\n\nPass `--output json` to get machine output.\n\nSee [guide](./guide.md).\n');
await writeFile(join(repo, 'docs/guide.md'), '# Guide\n\n## Setup\n\nRun it.\n');

const good = await applyDocEdits(repo, {
  edits: [{ path: 'docs/api.md', section: 'Configuration', mode: 'replace',
    find: 'Pass `--output json` to get machine output.',
    replace: 'Pass `--format json` to get machine output.', rationale: 'renamed flag' }],
  skipped: [],
});
check('clean edit applies', good.files.length === 1 && good.problems.length === 0);
check('edit content correct', !!good.files[0]?.after.includes('--format json'));

const bad = await applyDocEdits(repo, {
  edits: [{ path: 'docs/api.md', section: 'x', mode: 'replace',
    find: 'Pass --output json to get machine output.', replace: 'y', rationale: 'paraphrased' }],
  skipped: [],
});
check('hallucinated anchor caught', bad.problems.some((p) => p.kind === 'anchor-not-found'));

const missing = await applyDocEdits(repo, {
  edits: [{ path: 'docs/nope.md', section: 'x', mode: 'replace', find: 'a', replace: 'b', rationale: '' }],
  skipped: [],
});
check('missing file caught', missing.problems.some((p) => p.kind === 'missing-file'));

await writeFile(join(repo, 'docs/dup.md'), 'same line\nsame line\n');
const dup = await applyDocEdits(repo, {
  edits: [{ path: 'docs/dup.md', section: 'x', mode: 'replace', find: 'same line', replace: 'z', rationale: '' }],
  skipped: [],
});
check('ambiguous anchor caught', dup.problems.some((p) => p.kind === 'anchor-ambiguous'));

// --- links ---------------------------------------------------------------
const brokenLink = checkLinks(repo, [{ path: 'docs/api.md', before: '', appliedEdits: 1,
  after: '# API\n\nSee [gone](./gone.md) and [ok](./guide.md).\n' }]);
// A heading with punctuation between two spaces must keep both spaces when
// punctuation is stripped, producing the same double hyphen as GitHub.
{
  const doc = [{
    path: 'g.md', before: '', appliedEdits: 0,
    after: '# Guide\n\n[go](#stage-1--the-pipeline)\n[bad](#stage-1-the-pipeline)\n\n## Stage 1 : the pipeline\n\nx\n',
  }];
  const anchors = checkLinks(repo, doc);
  check('a punctuation-separated heading keeps both hyphens',
    !anchors.some((b) => b.target === '#stage-1--the-pipeline'), JSON.stringify(anchors));
  check('a collapsed anchor is still reported broken',
    anchors.some((b) => b.target === '#stage-1-the-pipeline'));
}

check('broken relative link caught', brokenLink.length === 1 && brokenLink[0]!.target === './gone.md');

const anchorLink = checkLinks(repo, [{ path: 'docs/api.md', before: '', appliedEdits: 1,
  after: '# API\n\n## Configuration\n\n[here](#configuration) [bad](#nowhere)\n' }]);
check('bad in-page anchor caught', anchorLink.length === 1 && anchorLink[0]!.target === '#nowhere');

// --- changelog -----------------------------------------------------------
await writeFile(join(repo, 'CHANGELOG.md'),
  '# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n- Something old\n\n## [1.0.0]\n\n- First\n');
const cl = await applyChangelogEntry(repo, 'CHANGELOG.md',
  { entry: 'Renamed --output to --format', section: 'Changed', semverBump: 'major', bumpRationale: '' });
check('changelog adds new section', cl.after.includes('### Changed') && cl.after.includes('Renamed --output'));
check('changelog keeps existing', cl.after.includes('Something old') && cl.after.includes('## [1.0.0]'));

const cl2 = await applyChangelogEntry(repo, 'CHANGELOG.md',
  { entry: 'Fixed a crash', section: 'Fixed', semverBump: 'patch', bumpRationale: '' });
const fixedIdx = cl2.after.indexOf('### Fixed');
check('changelog appends to existing section',
  cl2.after.indexOf('Fixed a crash') > fixedIdx && cl2.after.indexOf('Something old') > fixedIdx);

await writeFile(join(repo, 'NEW.md'), '# Changelog\n');
const cl3 = await applyChangelogEntry(repo, 'NEW.md',
  { entry: 'First entry', section: 'Added', semverBump: 'minor', bumpRationale: '' });
check('changelog creates Unreleased block', cl3.after.includes('## [Unreleased]') && cl3.after.includes('First entry'));

// --- approval gate -------------------------------------------------------
// SAFETY: the gate reads only the fields set here; the rest of a change spec does not affect the decision.
const breaking = { kind: 'breaking', surface: 'public-api', summary: '', changedSymbols: [],
  breakingRationale: '', confidence: 0.9 } as any;
// SAFETY: the gate reads only the fields set here; the rest of a change spec does not affect the decision.
const chore = { kind: 'chore', surface: 'internal', summary: '', changedSymbols: [],
  breakingRationale: '', confidence: 0.9 } as any;
// SAFETY: `decideScope` reads only `semverBump` off the impact report.
check('breaking is elevated', decideScope(breaking, { semverBump: 'major' } as any, 'routine').scope === 'elevated');
// SAFETY: `decideScope` reads only `semverBump` off the impact report.
check('chore is routine', decideScope(chore, { semverBump: 'none' } as any, 'routine').scope === 'routine');
// SAFETY: `decideScope` reads only `semverBump` off the impact report.
check('coordinator can escalate', decideScope(chore, { semverBump: 'none' } as any, 'elevated').scope === 'elevated');

const req = createApprovalRequest('run1', 'elevated', 'because', 'summary');
check('elevated needs two', req.requiredSignoffs === 2);
// The scope survives the gate that used to act on it: a reviewer opening a
// docs change is served by knowing the pipeline thought it touched public API.
// The scope survives the gate that used to act on it: a reviewer opening a
// docs change is served by knowing the pipeline thought it touched public API.
check('and carries its rationale onto the run', req.scopeRationale === 'because');

// --- docs branch worktree -------------------------------------------------
// The cloud case: docs live on their own branch, code on main. The pipeline must
// read docs from the docs branch, never from the code checkout.
const codeRepo = await mkdtemp(join(tmpdir(), 'docxy-code-'));
await sh(codeRepo, ['init', '-b', 'main']);
await sh(codeRepo, ['config', 'user.email', 't@example.com']);
await sh(codeRepo, ['config', 'user.name', 'Test']);
await writeFile(join(codeRepo, 'index.ts'), 'export const x = 1;\n');
await writeFile(join(codeRepo, 'README.md'), '# code branch readme\n');
await sh(codeRepo, ['add', '-A']);
await sh(codeRepo, ['commit', '-m', 'code']);

// An orphan docs branch with entirely different content.
await sh(codeRepo, ['switch', '--orphan', 'docs']);
await mkdir(join(codeRepo, 'docs'), { recursive: true });
await writeFile(join(codeRepo, 'docs/api.md'), '# API\n\n## Configuration\n\nOld text.\n');
await writeFile(join(codeRepo, 'CHANGELOG.md'), '# Changelog\n');
await sh(codeRepo, ['add', '-A']);
await sh(codeRepo, ['commit', '-m', 'docs']);
await sh(codeRepo, ['switch', 'main']);

const baseCfg: any = {
  repoPath: codeRepo,
  docs: { branch: 'docs', roots: ['docs', 'README.md'], changelogPath: 'CHANGELOG.md' },
  github: { baseBranch: 'main' },
};

const tree = await openDocsTree(baseCfg);
check('docs tree is a separate path', tree.path !== codeRepo && tree.disposable);
check('docs tree reports its branch', tree.branch === 'docs');

const docPaths = await listDocs(tree.path, baseCfg.docs.roots);
check('reads docs from the docs branch', docPaths.includes('docs/api.md'));
check('does not see code-branch files', !docPaths.includes('README.md'));

const apiText = await readRepoFile(tree.path, 'docs/api.md');
check('docs content comes from the docs branch', (apiText ?? '').includes('Old text.'));

// Edits anchor against the docs branch, not the code checkout.
const branchEdit = await applyDocEdits(tree.path, {
  edits: [{ path: 'docs/api.md', section: 'Configuration', mode: 'replace',
    find: 'Old text.', replace: 'New text.', rationale: 'update' }],
  skipped: [],
});
check('edit applies against the docs branch',
  branchEdit.problems.length === 0 && (branchEdit.files[0]?.after ?? '').includes('New text.'));

await tree.dispose();
const { stdout: wtList } = await exec('git', ['worktree', 'list'], { cwd: codeRepo });
check('docs worktree is cleaned up', !wtList.includes(tree.path));

check('pr base follows the docs branch', prBaseBranch(baseCfg) === 'docs');
check('pr base falls back to base branch',
  prBaseBranch({ ...baseCfg, docs: { ...baseCfg.docs, branch: '' } }) === 'main');
check('base ref resolves locally', (await resolveBaseRef(codeRepo, 'docs')).includes('docs'));

/*
 * Documentation in a repository of its own.
 *
 * The three base-branch cases in priority order, because getting them wrong is
 * silent: a pull request opened against a branch that exists in the *code*
 * repository but not the docs one fails late, and one opened against a branch
 * that exists in both targets the wrong tree without complaining at all.
 */
const separateCfg: Config = {
  ...baseCfg,
  docs: { ...baseCfg.docs, branch: '', repo: 'acme/handbook', baseBranch: 'trunk' },
};
check('a separate docs repo contributes its own base branch',
  prBaseBranch(separateCfg) === 'trunk');
check('a docs branch still outranks the docs repo default',
  prBaseBranch({ ...separateCfg, docs: { ...separateCfg.docs, branch: 'docs' } }) === 'docs');
check('neither set falls back to the code base branch',
  prBaseBranch({ ...baseCfg, docs: { ...baseCfg.docs, branch: '', baseBranch: '' } }) === 'main');

// `docsRoot` decides which repository every read and the publish happen in.
check('docs root is the code checkout by default', docsRoot(baseCfg) === codeRepo);
check('docs root follows a separate docs checkout',
  docsRoot({ ...baseCfg, docs: { ...baseCfg.docs, repoPath: '/tmp/handbook' } }) === '/tmp/handbook');

// The tree reports the repository it belongs to, which is what publishing
// branches from - the code checkout when docs live beside the code, and the
// docs checkout when they do not.
const beside = await openDocsTree({ ...baseCfg, docs: { ...baseCfg.docs, branch: '' } });
check('a tree beside the code roots at the code checkout', beside.root === codeRepo);
await beside.dispose();

const worktree = await openDocsTree(baseCfg);
check('a docs-branch worktree still roots at its repository', worktree.root === codeRepo);
check('and the worktree is not the checkout itself', worktree.path !== codeRepo);
await worktree.dispose();

// Single-tree mode still works: docs tree is the checkout, nothing disposable.
const sameTree = await openDocsTree({ ...baseCfg, docs: { ...baseCfg.docs, branch: '' } });
check('single-tree mode uses the checkout',
  sameTree.path === codeRepo && !sameTree.disposable && sameTree.branch === null);
await sameTree.dispose();

// A missing docs branch must fail loudly, not silently fall back to the checkout.
try {
  await openDocsTree({ ...baseCfg, docs: { ...baseCfg.docs, branch: 'no-such-branch' } });
  check('missing docs branch throws', false);
} catch (e) {
  check('missing docs branch throws', e instanceof Error && e.message.includes('does not exist'));
}

await rm(codeRepo, { recursive: true, force: true });


// --- pricing -------------------------------------------------------------
const priceCfg = {
  registeredModels: [
    { name: 'deepseek-v4-pro', modelId: 'deepseek-ai/DeepSeek-V4-Pro', contextLength: 1 },
  ],
};
const priceTable = new Map([
  ['deepseek-ai/deepseek-v4-pro', { prompt: 0.0000004, completion: 0.0000012 }],
]);

// A trace records the harness's name for the model; the table is keyed by the
// upstream id, so resolution has to go through registeredModels.
check('price resolves through the registered name',
  priceFor('nebius/deepseek-v4-pro', priceCfg, priceTable)?.completion === 0.0000012);
check('price falls back to a raw upstream id',
  priceFor('deepseek-ai/DeepSeek-V4-Pro', priceCfg, priceTable)?.prompt === 0.0000004);
check('unknown model has no price',
  priceFor('nebius/not-a-model', priceCfg, priceTable) === undefined);
check('no table means no price', priceFor('nebius/deepseek-v4-pro', priceCfg, new Map()) === undefined);

const priced = costOf({ inputTokens: 1_000_000, outputTokens: 100_000 },
  priceFor('nebius/deepseek-v4-pro', priceCfg, priceTable));
check('cost is input + output at their own rates', priced === 0.52, String(priced));
check('unpriced usage yields no cost',
  costOf({ inputTokens: 100, outputTokens: 10 }, undefined) === undefined);

// --- observability report ------------------------------------------------
const trace = (role: RoleName, over: Partial<RoleTrace> = {}): RoleTrace => ({
  role, sessionId: 's', startedAt: '2026-08-01T00:00:00.000Z', status: 'done',
  events: [], reusedSession: true, durationMs: 1000,
  usage: { inputTokens: 100, outputTokens: 10, costUsd: 0.01 }, ...over,
});

const edit = (path: string): DocEdit =>
  ({ path, section: 'Usage', find: 'a', replace: 'b', mode: 'replace', rationale: '' });

const fixture = (over: Partial<RunRecord> & Pick<RunRecord, 'id' | 'startedAt' | 'status'>): RunRecord => ({
  repoPath: '/x', commit: { sha: 'a', shortSha: 'aaa', subject: 'one' },
  traces: [], priorSymbolCount: 0, newSymbolCount: 0, ...over,
});

const report = buildReport([
  fixture({
    id: 'r1', startedAt: '2026-08-01T00:00:00.000Z', status: 'done', durationMs: 4000,
    traces: [trace('change-analyst'), trace('docs-updater', { durationMs: 3000 })],
    classification: { kind: 'fix', surface: 'internal', summary: '', changedSymbols: [], breakingRationale: '', confidence: 0.9 },
    docs: { edits: [edit('docs/api.md'), edit('docs/api.md'), edit('docs/cli.md')], skipped: [] },
    totals: { inputTokens: 200, outputTokens: 20, costUsd: 0.02 },
  }),
  fixture({
    id: 'r2', commit: { sha: 'b', shortSha: 'bbb', subject: 'two' },
    startedAt: '2026-08-02T00:00:00.000Z', status: 'failed', durationMs: 2000,
    traces: [
      trace('change-analyst', { reusedSession: false }),
      trace('docs-updater', { status: 'failed', failure: 'parse-error', usage: undefined }),
    ],
    docs: { edits: [edit('docs/api.md')], skipped: [] },
    totals: { inputTokens: 100, outputTokens: 10, costUsd: 0.01 },
  }),
]);

check('window counts every run', report.window.runs === 2);
check('window runs oldest to newest', report.window.from === '2026-08-01T00:00:00.000Z');
check('outcomes are tallied by status', report.outcomes.done === 1 && report.outcomes.failed === 1);
check('success rate counts settled runs only', report.successRate === 0.5);
check('spend rolls up across runs', report.totals.costUsd === 0.03);
check('cost per run divides by the window', report.totals.costPerRunUsd === 0.015);
check('roles come back in pipeline order',
  report.roles[0]?.role === 'change-analyst' && report.roles[1]?.role === 'docs-updater');
check('role failures are counted by kind',
  report.roles[1]?.failed === 1 && report.roles[1]?.failures['parse-error'] === 1);
check('session reuse is a rate, not a count', report.roles[0]?.reuseRate === 0.5);
check('a doc edited twice in one run counts as one stale run',
  report.staleDocs[0]?.path === 'docs/api.md' && report.staleDocs[0]?.runs === 2 &&
  report.staleDocs[0]?.edits === 3);
check('series carries confidence for trends', report.series[0]?.confidence === 0.9);
check('documentation counts every draft edit but deduplicates documents',
  report.documentation.edits === 4 && report.documentation.documents === 2);

const draftReport = buildReport([
  fixture({
    id: 'draft-a', startedAt: '2026-08-01T00:00:00.000Z', status: 'done', repoPath: '/a',
    docs: { edits: [edit('README.md'), edit('README.md')], skipped: [] },
    changelog: { entry: 'Added webhooks.', section: 'Added', semverBump: 'minor', bumpRationale: '' },
  }),
  fixture({
    id: 'draft-b', startedAt: '2026-08-02T00:00:00.000Z', status: 'failed', repoPath: '/b',
    docs: { edits: [edit('README.md')], skipped: [] },
    changelog: { entry: '  ', section: 'Changed', semverBump: 'none', bumpRationale: '' },
  }),
]);
check('same document path in different repositories counts separately', draftReport.documentation.documents === 2);
check('release note drafts exclude blank entries', draftReport.documentation.releaseNotes === 1);
check('draft counts include saved proposals even if later steps failed', draftReport.documentation.edits === 3);

// An empty history must not divide by zero or invent a rate.
const empty = buildReport([]);
check('empty history has zero documentation drafts',
  empty.documentation.edits === 0 && empty.documentation.documents === 0 && empty.documentation.releaseNotes === 0);
check('empty history has no rates',
  empty.window.runs === 0 && empty.successRate === undefined &&
  empty.totals.costUsd === undefined && empty.roles.length === 0);

// --- run scoping ---------------------------------------------------------
// A run id is printed in every dashboard URL, so naming one in a query must
// narrow the listing rather than reach past the repository filter.
{
  const dir = await mkdtemp(join(tmpdir(), 'docxy-runs-'));
  // SAFETY: `RunStore` reads only `stateDir` off the config.
  const store = new RunStore({ stateDir: dir } as Config);

  const runIn = (id: string, repoPath: string, startedAt = '2026-08-01T00:00:00.000Z'): RunRecord => ({
    id,
    repoPath,
    commit: { sha: `${id}0000`, shortSha: id.slice(0, 7), subject: 's' },
    startedAt,
    status: 'done',
    traces: [
      {
        role: 'change-analyst',
        sessionId: 's1',
        startedAt: '2026-08-01T00:00:00.000Z',
        status: 'done',
        reusedSession: false,
        events: [{ at: '2026-08-01T00:00:01.000Z', kind: 'note', text: 'hello' }],
      },
    ],
    priorSymbolCount: 0,
    newSymbolCount: 0,
  });

  const mine = runIn('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '/repos/mine');
  const theirs = runIn('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '/repos/theirs');
  await store.save(mine);
  await store.save(theirs);

  const scope = ['/repos/mine'];
  const own = await store.logs({ limit: 50, runId: mine.id, repoPaths: scope });
  check('a named run inside the scope is readable', own.entries.length === 1);
  const other = await store.logs({ limit: 50, runId: theirs.id, repoPaths: scope });
  check('a named run outside the scope returns nothing', other.entries.length === 0);
  const listed = await store.logs({ limit: 50, repoPaths: scope });
  check('an unnamed listing stays inside the scope',
    listed.entries.every((entry) => entry.runId === mine.id));

  // The dashboard narrows to one project inside an organization that may own
  // several, so the same filter has to separate two repositories the caller is
  // entitled to see - not just entitled from unentitled.
  const both = await store.list(50, ['/repos/mine', '/repos/theirs']);
  check('an organization-wide listing spans its projects', both.length === 2);
  const narrowed = await store.list(50, ['/repos/mine']);
  check('narrowing to one project excludes the other',
    narrowed.length === 1 && narrowed[0].id === mine.id);

  // Why this narrows in the query rather than in the dashboard. The listing is
  // capped, so a busy project fills the window and a quiet one falls out of it
  // entirely - filtering the organization-wide result afterwards would show an
  // untouched project as having no runs at all.
  // Newer than either run above, so they take the whole window on recency
  // rather than on whatever order equal timestamps happen to produce.
  for (let i = 0; i < 5; i += 1) {
    await store.save(
      runIn(`cccccccc-cccc-cccc-cccc-cccccccccc0${i}`, '/repos/theirs', `2026-08-0${i + 2}T00:00:00.000Z`),
    );
  }
  const capped = await store.list(3, ['/repos/mine', '/repos/theirs']);
  check('a busy project can crowd a quiet one out of a capped window',
    capped.every((run) => run.repoPath === '/repos/theirs'));
  const stillThere = await store.list(3, ['/repos/mine']);
  check('narrowing first keeps the quiet project visible',
    stillThere.length === 1 && stillThere[0].id === mine.id);

  await rm(dir, { recursive: true, force: true });
}


// --- installation pagination ---------------------------------------------
// An installation past a hundred repositories is not an error, and the ones on
// page two were silently absent from every listing that matters.
{
  const link =
    '<https://api.github.com/installation/repositories?per_page=100&page=2>; rel="next", ' +
    '<https://api.github.com/installation/repositories?per_page=100&page=5>; rel="last"';
  check('the next page is followed',
    nextPage(link) === 'https://api.github.com/installation/repositories?per_page=100&page=2');
  check('the last page ends the walk',
    nextPage('<https://api.github.com/x?page=1>; rel="prev"') === null);
  check('no link header ends the walk', nextPage(null) === null);
}

// --- the API's own front door --------------------------------------------
// Better Auth guards the dashboard proxy, but the Hono API listens separately
// and answers approve, deny, run and instructions. Anything that could route to
// the port used to skip the sign-in entirely.
{
  const secret = 'a'.repeat(64);
  check('the right token is accepted', tokenMatches(secret, `Bearer ${secret}`));
  check('the scheme is optional', tokenMatches(secret, secret));
  check('the scheme is case-insensitive', tokenMatches(secret, `bearer ${secret}`));
  check('a wrong token of equal length is refused',
    tokenMatches(secret, `Bearer ${'b'.repeat(64)}`) === false);
  check('a truncated token is refused', tokenMatches(secret, `Bearer ${'a'.repeat(63)}`) === false);
  // A prefix of the secret must not pass: the length check is what makes the
  // comparison safe to run at all, not a shortcut around it.
  check('a prefix of the token is refused', tokenMatches(secret, 'Bearer a') === false);
  check('no header at all is refused', tokenMatches(secret, undefined) === false);
  check('an empty header is refused', tokenMatches(secret, '') === false);
  check('surrounding whitespace is tolerated', tokenMatches(secret, `Bearer  ${secret} `));

  // `timingSafeEqual` throws when the buffers differ in length, and a string's
  // length is not its byte length: 32 non-ASCII characters weigh more than 32
  // bytes. Comparing the strings first turned a wrong credential into a 500.
  const wideButSameCharCount = 'é'.repeat(64);
  let threw = false;
  try {
    check('a non-ASCII token of equal character count is refused',
      tokenMatches(secret, `Bearer ${wideButSameCharCount}`) === false);
  } catch {
    threw = true;
  }
  check('comparing a non-ASCII token does not throw', threw === false);
}

// --- who hears a live update ----------------------------------------------
// The event stream was the last deployment-wide endpoint carrying work
// product: it pushed every run, role transition and delivery to every browser
// holding it open, so the dashboard could not consume it without handing one
// customer another's commit subjects.
{
  const mine = { paths: ['/checkouts/team__docs', '/checkouts/team__api'], organizationId: 'org_a' };

  check('a run in my checkout reaches me',
    eventVisible({ repoPath: '/checkouts/team__api' }, mine));
  check('a run in another organization\'s checkout does not',
    eventVisible({ repoPath: '/checkouts/other__api' }, mine) === false);
  // The empty list is the answer for an organization that has connected
  // nothing, and it has to read as "no runs" rather than as "no filter" - an
  // absent filter is exactly how this leaked before.
  check('an organization with no projects hears nothing',
    eventVisible({ repoPath: '/checkouts/team__api' }, { paths: [], organizationId: 'org_a' }) === false);
  // Paths are compared whole. A checkout inside another one is a different
  // project, and a prefix match would hand it over.
  check('a nested path is not the same project',
    eventVisible({ repoPath: '/checkouts/team__api/vendor' }, mine) === false);

  check('my own instructions reach me', eventVisible({ organizationId: 'org_a' }, mine));
  check('another organization\'s instructions do not',
    eventVisible({ organizationId: 'org_b' }, mine) === false);
  // A deployment with no database has one tenant and no organization ids, and
  // an organization-scoped event must not be delivered there by default.
  check('an unnamed subscriber is not every organization',
    eventVisible({ organizationId: 'org_a' }, { paths: ['/repo'] }) === false);
  check('an unscoped event is for the deployment',
    eventVisible({}, mine));
  // Both dimensions, both checked: matching one does not excuse the other.
  check('matching the organization does not grant another checkout',
    eventVisible({ repoPath: '/checkouts/other__api', organizationId: 'org_a' }, mine) === false);
}

// --- where the CLI is allowed to listen -----------------------------------
// `docxy serve` may run without a token because it stays on this machine. The
// host override has to fail closed the same way the deployed path does.
{
  check('loopback v4 is local', isLoopbackHost('127.0.0.1'));
  check('any 127.x is local', isLoopbackHost('127.99.1.2'));
  check('localhost is local', isLoopbackHost('localhost'));
  check('loopback v6 is local', isLoopbackHost('::1'));
  check('bracketed loopback v6 is local', isLoopbackHost('[::1]'));
  check('case and padding do not matter', isLoopbackHost('  LocalHost '));
  check('all interfaces is not local', isLoopbackHost('0.0.0.0') === false);
  check('a LAN address is not local', isLoopbackHost('192.168.1.10') === false);
  check('a hostname is not local', isLoopbackHost('docxy.internal') === false);
  // 127 has to be an octet, not a prefix of one.
  check('a lookalike address is not local', isLoopbackHost('1270.0.0.1') === false);
}

// --- which repositories a webhook may start a run for ---------------------
// The webhook secret belongs to the App, not to a repository, so every
// installation of it produces deliveries that pass the signature check.
{
  // Case-folded, because GitHub is case-insensitive about these names and this
  // side is not.
  const installed = ['arindam200/docxy', 'arindam200/other'];

  // The one that matters: an "All repositories" install grants access to
  // everything an account owns, and only the repositories somebody connected as
  // a project are documented.
  const connected = ['arindam200/docxy'];
  check(
    'a connected repository is accepted',
    deliveryAllowed({ installed, connected, fromEnv: [] }, 'Arindam200/docxy').ok,
  );
  const unconnected = deliveryAllowed({ installed, connected, fromEnv: [] }, 'arindam200/other');
  check(
    'an installed but unconnected repository is refused',
    unconnected.ok === false,
  );
  check(
    'and the reason says nothing is watching it',
    unconnected.ok === false && unconnected.reason.includes('not connected to a project'),
  );
  // Empty is an answer here, unlike the installation listing below: the
  // database said nobody has connected anything.
  check(
    'no projects means no repository runs',
    deliveryAllowed({ installed, connected: [], fromEnv: [] }, 'arindam200/docxy').ok === false,
  );
  // Null is the deployment that stores state in .docxy/ and has no projects at
  // all - the single-repository install, where the installation is the answer.
  check(
    'a deployment without projects falls back to the installation',
    deliveryAllowed({ installed, connected: null, fromEnv: [] }, 'Arindam200/docxy').ok,
  );

  check(
    'a repository the App is not installed on is refused',
    deliveryAllowed({ installed, connected: null, fromEnv: [] }, 'someone/else').ok === false,
  );
  const foreign = deliveryAllowed({ installed, connected: null, fromEnv: [] }, 'someone/else');
  check(
    'and the reason says the App is not installed there',
    foreign.ok === false && foreign.reason.includes('not installed on someone/else'),
  );

  // An outage must not stop a working pipeline: the installation-scoped token
  // still bounds what can be cloned.
  check(
    'an unreachable installation stays permissive',
    deliveryAllowed({ installed: null, connected: null, fromEnv: [] }, 'anyone/anything').ok,
  );
  check(
    'and so does an empty listing',
    deliveryAllowed({ installed: [], connected: null, fromEnv: [] }, 'anyone/anything').ok,
  );

  // The variable survives as a narrowing, never as a widening.
  check(
    'the environment narrows the installation',
    deliveryAllowed(
      { installed, connected: null, fromEnv: ['arindam200/docxy'] },
      'arindam200/other',
    ).ok === false,
  );
  check(
    'and cannot widen it',
    deliveryAllowed({ installed, connected, fromEnv: ['someone/else'] }, 'someone/else').ok === false,
  );
  const narrowed = deliveryAllowed(
    { installed, connected: null, fromEnv: ['arindam200/docxy'] },
    'arindam200/other',
  );
  check(
    'a narrowed repository names the variable, not GitHub',
    narrowed.ok === false && narrowed.reason.includes('DOCXY_ALLOWED_REPOS'),
  );
  // The narrowing is checked before the project gate, so its message wins.
  const bothWrong = deliveryAllowed(
    { installed, connected: [], fromEnv: ['arindam200/docxy'] },
    'arindam200/other',
  );
  check(
    'the operator narrowing is reported ahead of a missing project',
    bothWrong.ok === false && bothWrong.reason.includes('DOCXY_ALLOWED_REPOS'),
  );

  const sha = '0'.repeat(40);
  check('a full object name is a commit', isCommitSha(sha));
  check('a short sha is not', isCommitSha('0123abc') === false);
  check('a branch name is not', isCommitSha('HEAD') === false);
  check('an argument-looking value is not', isCommitSha('--upload-pack=touch /tmp/x') === false);
}


// --- the API token and repository allowlist read from the environment -----
{
  const before = { ...process.env };

  // Empty, not deleted. `loadConfig` layers the repository's own `.env` over
  // whatever is absent, so deleting these hands the next read straight back to
  // the operator's real token - green in CI, red on the machine that followed
  // the deploy guide. An empty value is already "unset" to the parser below.
  process.env.DOCXY_API_TOKEN = '';
  process.env.DOCXY_ALLOWED_REPOS = '';
  check('no token configured leaves the API open to the proxy',
    loadConfig().server.apiToken === undefined);
  check('no allowlist configured means every repository', loadConfig().server.allowedRepos.length === 0);

  process.env.DOCXY_API_TOKEN = 'shhh';
  check('a configured token is read', loadConfig().server.apiToken === 'shhh');

  // Both dashboard callers trim before sending. If this side kept the padding,
  // the token would be "set" here and a different string there - every request
  // a 401 with nothing to point at.
  process.env.DOCXY_API_TOKEN = '  shhh  ';
  check('a padded token is trimmed to match the dashboard',
    loadConfig().server.apiToken === 'shhh');
  process.env.DOCXY_API_TOKEN = '   ';
  check('an all-whitespace token counts as unset',
    loadConfig().server.apiToken === undefined);

  process.env.DOCXY_ALLOWED_REPOS = ' Arindam200/Docxy , arindam200/other ,, ';
  const repos = loadConfig().server.allowedRepos;
  check('the allowlist is split, trimmed and lowercased',
    repos.length === 2 && repos[0] === 'arindam200/docxy' && repos[1] === 'arindam200/other');

  process.env = before;
}

// --- sandbox execution ----------------------------------------------------
// The docs build is the one check that runs a command over text a model wrote.
// It belongs in the sandbox, and the two reasons to have a sandbox - executing
// validation, and serving git-backed skills - used to share one flag, so a
// deployment could not have either without the other.
{
  const before = process.env;
  process.env = { ...process.env };

  const reload = () => loadConfig();

  delete process.env.DOCXY_SANDBOX;
  check('the sandbox is on by default', reload().sandbox.enabled === true);

  process.env.DOCXY_SANDBOX = 'false';
  check('the sandbox can be turned off', reload().sandbox.enabled === false);

  // The fallback is the security-relevant default: host execution has to be
  // asked for, never inherited.
  delete process.env.DOCXY_SANDBOX;
  delete process.env.DOCXY_SANDBOX_FALLBACK;
  check('an unreachable sandbox does not fall back to the host by default',
    reload().sandbox.fallback === 'skip');
  process.env.DOCXY_SANDBOX_FALLBACK = 'local';
  check('host execution can be asked for explicitly', reload().sandbox.fallback === 'local');
  process.env.DOCXY_SANDBOX_FALLBACK = 'nonsense';
  check('an unrecognised fallback stays safe', reload().sandbox.fallback === 'skip');
  delete process.env.DOCXY_SANDBOX_FALLBACK;

  delete process.env.DOCXY_SANDBOX;
  process.env.DAYTONA_API_KEY = 'dt-test-key';
  check('the Daytona key is read', reload().sandbox.daytonaApiKey === 'dt-test-key');

  process.env = before;
}

// --- validation reports where it ran --------------------------------------
// A report that does not say where a command executed cannot be audited: the
// same "docs-build passed" means two different things on a machine with a
// sandbox and one without.
{
  const before = process.env;
  process.env = { ...process.env };
  // Emptied, not deleted: `loadDotEnv` refills anything undefined from .env,
  // and this repository's own .env configures a docs build. A delete here read
  // as "a command is configured" and, now that the workspace path no longer
  // needs a harness client to be entered, went and provisioned a real sandbox.
  process.env.DOCXY_DOCS_BUILD_COMMAND = '';
  process.env.DOCXY_TEST_COMMAND = 'true';

  const config = loadConfig();
  const report = await validateProposal({
    config,
    applied: { files: [], problems: [] },
    changelogFile: null,
    classification: {
      kind: 'fix',
      surface: 'docs-only',
      summary: 's',
      changedSymbols: [],
      breakingRationale: '',
      confidence: 1,
    },
    changelog: undefined,
    docsPath: config.repoPath,
    stageable: false,
    // No client: nothing can reach a sandbox, so every command runs locally.
  });

  const tests = report.checks.find((c) => c.name === 'tests');
  check('a locally executed check says so', tests?.where === 'local');
  check('a check that executes nothing claims no location',
    report.checks.find((c) => c.name === 'link-check')?.where === undefined);

  const build = report.checks.find((c) => c.name === 'docs-build');
  check('no docs build command is skipped, not failed', build?.status === 'skipped');

  process.env = before;
}

// --- an unvalidated build never reads as validated ------------------------
// `ValidationReport.ok` rejects only `fail`, so anything that reports itself
// `skipped` sails through. A configured docs build that could not run is not a
// skipped one - it is a proposal nobody checked, and it used to publish clean.
{
  const before = process.env;
  process.env = { ...process.env };
  process.env.DOCXY_DOCS_BUILD_COMMAND = 'echo hi';
  delete process.env.DOCXY_TEST_COMMAND;
  delete process.env.DOCXY_SANDBOX_FALLBACK;
  // Emptied rather than deleted - `loadDotEnv` refills anything undefined -
  // so there is no workspace and the fallback policy is what decides.
  process.env.DAYTONA_API_KEY = '';

  const config = loadConfig();
  const report = await validateProposal({
    config,
    applied: { files: [], problems: [] },
    changelogFile: null,
    classification: {
      kind: 'fix', surface: 'docs-only', summary: 's',
      changedSymbols: [], breakingRationale: '', confidence: 1,
    },
    changelog: undefined,
    docsPath: config.repoPath,
    stageable: false,
  });

  const build = report.checks.find((c) => c.name === 'docs-build');
  check('an unreachable sandbox fails the build rather than skipping it',
    build?.status === 'fail');
  check('and the run is not ok', report.ok === false);
  check('and it says host execution was declined, not attempted',
    (build?.detail ?? '').includes('DOCXY_SANDBOX_FALLBACK'));

  process.env = before;
}

// --- github app credentials ----------------------------------------------
{
  const PEM = '-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAK\n-----END RSA PRIVATE KEY-----';

  check('a verbatim pem is left alone', normalizePem(PEM) === PEM);
  check('escaped newlines are repaired',
    normalizePem(PEM.replace(/\n/g, '\\n')) === PEM);
  check('base64 is decoded',
    normalizePem(Buffer.from(PEM, 'utf8').toString('base64')) === PEM);
  check('a pem that merely looks base64ish is not decoded',
    normalizePem(PEM).includes('-----BEGIN'));

  // The environment is process-wide, so each case restores what it changed.
  const saved = {
    id: process.env.GITHUB_APP_ID,
    key: process.env.GITHUB_APP_PRIVATE_KEY,
    path: process.env.GITHUB_APP_PRIVATE_KEY_PATH,
    install: process.env.GITHUB_APP_INSTALLATION_ID,
  };
  delete process.env.GITHUB_APP_PRIVATE_KEY_PATH;
  process.env.GITHUB_APP_ID = '123';
  process.env.GITHUB_APP_INSTALLATION_ID = '456';
  process.env.GITHUB_APP_PRIVATE_KEY = PEM.replace(/\n/g, '\\n');

  const fromEnv = readAppCredentials();
  check('the key can come from the environment alone', fromEnv?.privateKey === PEM);
  check('and that counts as configured', appStatus().configured === true);

  delete process.env.GITHUB_APP_PRIVATE_KEY;
  const neither = appStatus();
  check('with neither source the checklist names both',
    neither.configured === false &&
    neither.missing.some((m) => m.includes('GITHUB_APP_PRIVATE_KEY or')));
  check('and no credentials are returned', readAppCredentials() === null);

  for (const [name, value] of [
    ['GITHUB_APP_ID', saved.id],
    ['GITHUB_APP_PRIVATE_KEY', saved.key],
    ['GITHUB_APP_PRIVATE_KEY_PATH', saved.path],
    ['GITHUB_APP_INSTALLATION_ID', saved.install],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}


// --- what the model is actually asked ------------------------------------
{
  const base = loadConfig();

  // Persona and task are the role. They are asserted here because the schema
  // is enforced elsewhere now, and a prompt that lost its persona would still
  // produce valid objects - just worse ones.
  const analystInstructions = CHANGE_ANALYST.instructions(base);
  check('a role carries its persona', analystInstructions.includes('You are the Change Analyst'));
  check('and its task', analystInstructions.includes('You are given a commit diff. Classify it'));
  // The provider enforces the shape, so asking for it in prose is at best
  // wasted tokens and at worst a conflicting instruction.
  check('and does not restate the schema in prose',
    !analystInstructions.includes('fenced JSON block') &&
    !analystInstructions.includes('`kind`: one of'));

  // A commit that edits a doc puts the doc's *old* lines in the diff, and they
  // look exactly like quotable anchors. One real run anchored on a line the
  // same commit had deleted, so the Docs Updater is told about it explicitly.
  const updaterInstructions = DOCS_UPDATER.instructions(base);
  check('the docs updater is warned off the diff as an anchor source',
    updaterInstructions.includes('never a source of anchors') &&
    updaterInstructions.includes('leading `-`'));
  check('and told to copy rather than reconstruct',
    updaterInstructions.includes('Do not retype it'));
  check('and told to skip a file it was not given',
    updaterInstructions.includes('cannot edit'));

  // A smoke test caught the Docs Updater anchoring on a README paragraph that
  // had been deleted twenty minutes earlier. It was in no prompt it was given;
  // it came from the thread. The one role whose job is quoting text back byte
  // for byte is the one role a memory of older copies actively harms.
  check('the docs updater carries no memory across commits',
    DOCS_UPDATER.carriesMemory === false);
  check('and every other role does',
    [CHANGE_ANALYST, COORDINATOR].every((r) => r.carriesMemory));

  // DOCXY_MODEL_* may name a short alias; the router wants the upstream id.
  const translated = mastraModelFor(base, 'change-analyst');
  check('a registered name resolves to its upstream id',
    translated === 'nebius/deepseek-ai/DeepSeek-V4-Pro', translated);

  // An id the deployment never registered is still a model the router knows.
  const unregistered: Config = {
    ...base,
    models: { ...base.models, coordinator: 'nebius/meta-llama/Llama-3.3-70B-Instruct' },
  };
  check('an unregistered id passes through untranslated',
    mastraModelFor(unregistered, 'coordinator') === 'nebius/meta-llama/Llama-3.3-70B-Instruct');

  // A bare name with no provider still resolves against the configured one.
  const bare: Config = { ...base, models: { ...base.models, coordinator: 'deepseek-v4-flash' } };
  check('a bare registered name picks up the provider',
    mastraModelFor(bare, 'coordinator') === 'nebius/deepseek-ai/DeepSeek-V4-Flash',
    mastraModelFor(bare, 'coordinator'));
}

// --- the schema is the contract ------------------------------------------
//
// What the prose asked for politely, the provider now enforces. These assert
// the schema actually rejects the answers the prose could only discourage -
// including the one a real run produced during the phase 0 spike.
{
  const good = {
    kind: 'breaking', surface: 'public-api', summary: 'Renamed a field.',
    changedSymbols: ['ClientOptions.timeout'], breakingRationale: 'Callers break.',
    confidence: 0.9,
  };
  check('a valid classification parses', classificationSchema.safeParse(good).success);

  // An actual observed failure: asked for four values, a model answered with a
  // fifth. Before the provider enforced the schema that reached the pipeline
  // as a perfectly valid parse.
  check('an invented enum value is rejected',
    !classificationSchema.safeParse({ ...good, kind: 'refactoring' }).success);
  check('a missing field is rejected',
    !classificationSchema.safeParse({ ...good, summary: undefined }).success);
  check('an out-of-range confidence is rejected',
    !classificationSchema.safeParse({ ...good, confidence: 1.5 }).success);

  check('a changelog bump outside semver is rejected',
    !changelogProposalSchema.safeParse({
      entry: 'Did a thing', section: 'Changed', semverBump: 'huge', bumpRationale: 'x',
    }).success);
  check('a doc edit with an unknown mode is rejected',
    !docsProposalSchema.safeParse({
      edits: [{ path: 'a.md', section: 'H', find: 'x', replace: 'y', mode: 'insert', rationale: 'r' }],
      skipped: [],
    }).success);
  check('an empty impact map is valid - nothing touched is an answer',
    impactMapSchema.safeParse({ docs: [], code: [], symbolIndex: {}, notes: 'none' }).success);
}

// --- usage survives a payload it did not expect ---------------------------
//
// Token counts cross an SDK boundary whose shape has already moved once. A run
// must not fail because its accounting arrived differently than last release.
{
  const real = readUsage({
    inputTokens: 1200, outputTokens: 340, cachedInputTokens: 900,
    raw: { inputTokens: { noCache: 300, cacheRead: 900 } },
  });
  check('mastra usage folds into the shared shape',
    real.inputTokens === 1200 && real.outputTokens === 340 && real.cacheReadTokens === 900);
  check('and keeps its own breakdown categories',
    real.inputBreakdown.noCache === 300 && real.inputBreakdown.cacheRead === 900);
  // Never guessed. A rate applied to an invented number prices runs wrongly.
  check('no cache-write count is invented', real.cacheWriteTokens === 0);

  // SAFETY: deliberately malformed - the point of the check is that a payload
  // outside the declared type is survived rather than trusted.
  const junk = readUsage({ inputTokens: Number.NaN, raw: 'not an object' } as never);
  check('a junk payload reads as zero rather than throwing',
    junk.inputTokens === 0 && junk.outputTokens === 0);
  // SAFETY: as above - an empty object is a shape the SDK should never send.
  check('an absent payload reads as zero', readUsage({} as never).inputTokens === 0);
}

// --- session rotation is runtime-independent ------------------------------
//
// Rotation is what keeps a thread from growing until it breaches its budget,
// and it lives in the store rather than in the runtime. These drive it against
// a fake store and assert the decisions, not the ids.
{
  const rotationConfig: Config = {
    ...loadConfig(),
    repoPath: '/tmp/rotation-probe',
    agent: { ...loadConfig().agent, sessionMaxTurns: 3 },
  };

  class FakeSessions implements SessionStorage {
    entries = new Map<RoleName, { sessionId: string; specHash: string; turns: number }>();
    async get(role: RoleName, specHash: string) {
      const found = this.entries.get(role);
      if (!found || found.specHash !== specHash) return undefined;
      return { sessionId: found.sessionId, turns: found.turns };
    }
    async set(role: RoleName, sessionId: string, specHash: string) {
      this.entries.set(role, { sessionId, specHash, turns: 0 });
    }
    async recordTurn(role: RoleName) {
      const found = this.entries.get(role);
      if (found) found.turns += 1;
    }
    async clear() { this.entries.clear(); }
    async all() { return {}; }
  }

  const store = new FakeSessions();
  const runtime = new MastraRuntime(rotationConfig, store);

  const first = await runtime.resolveSession(CHANGE_ANALYST);
  check('a first session is new, not reused', !first.reused && first.priorTurns === 0);

  const second = await runtime.resolveSession(CHANGE_ANALYST);
  check('the same spec reuses the same thread',
    second.reused && second.id === first.id);

  // The thread id must be legible in a trace, which abbreviates to eight
  // characters. Leading with the repository key printed one id for all five
  // roles; leading with the per-role spec hash distinguishes them on sight.
  const otherRole = await runtime.resolveSession(COORDINATOR);
  check('two roles do not share a thread prefix',
    otherRole.id.slice(0, 8) !== first.id.slice(0, 8), `${otherRole.id} vs ${first.id}`);

  await store.recordTurn('change-analyst');
  await store.recordTurn('change-analyst');
  const stillUnder = await runtime.resolveSession(CHANGE_ANALYST);
  check('under the turn limit it keeps the thread', stillUnder.reused);

  await store.recordTurn('change-analyst');
  const rotated = await runtime.resolveSession(CHANGE_ANALYST);
  check('at the turn limit it retires the thread',
    !rotated.reused && rotated.rotatedBecause === 'turn-limit');
  check('and the retired thread is not the new one', rotated.id !== first.id);

  const forced = await runtime.resolveSession(CHANGE_ANALYST, { fresh: true });
  check('a requested rotation says it was requested',
    !forced.reused && forced.rotatedBecause === 'requested');

  // Changing the spec must invalidate the thread. The hash is in the id, so a
  // changed prompt or model cannot go on talking to an agent built from the
  // configuration it replaced.
  const moved = new MastraRuntime(
    { ...rotationConfig, models: { ...rotationConfig.models, 'change-analyst': 'nebius/kimi-k3' } },
    store,
  );
  const afterModelChange = await moved.resolveSession(CHANGE_ANALYST);
  check('changing the model starts a new thread', !afterModelChange.reused);
}


// --- one model, two spellings, one price ---------------------------------
//
// A role may be configured by alias and answered by upstream id, and pricing
// keys off the name recorded on the trace. Without this a run priced at zero
// and reported itself free.
{
  const priceConfig = { registeredModels: loadConfig().registeredModels };
  const table = new Map([['deepseek-ai/deepseek-v4-pro', { prompt: 0.0000018, completion: 0.0000054 }]]);

  const viaAlias = priceFor('nebius/deepseek-v4-pro', priceConfig, table);
  const viaRouterId = priceFor('nebius/deepseek-ai/DeepSeek-V4-Pro', priceConfig, table);
  check('a short alias finds its rate', viaAlias !== undefined);
  check('the upstream id finds the same rate',
    viaRouterId !== undefined && viaRouterId.prompt === viaAlias?.prompt);
  check('a model with no published rate stays unpriced',
    priceFor('nebius/some-model-nobody-priced', priceConfig, table) === undefined);
}


// --- the workspace is preferred, and its absence is not a failure ---------
//
// Two sandboxes can serve the docs build and they are not equally trustworthy:
// the workspace runs the command directly, the harness puts a model in the
// middle and reports the exit code as a claim. So the workspace goes first -
// but neither being available is a configuration problem, never a verdict on
// the documentation.
{
  const before = process.env;
  process.env = { ...process.env };
  // Emptied, not deleted: `loadDotEnv` refills anything undefined from .env,
  // so a delete here would silently read the developer's own key.
  process.env.DAYTONA_API_KEY = '';
  check('no daytona key means no workspace to try',
    workspaceConfigured(loadConfig()) === false);

  process.env.DAYTONA_API_KEY = 'dt-not-a-real-key';
  check('a daytona key makes the workspace available', workspaceConfigured(loadConfig()) === true);

  // Reached without touching the network: the key check happens first.
  process.env.DAYTONA_API_KEY = '';
  const outcome = await runCommandInWorkspace({
    config: loadConfig(), name: 'docs-build', command: 'true', files: [],
  });
  check('an unconfigured workspace is unavailable, not a failed check',
    'unavailable' in outcome && outcome.unavailable.includes('DAYTONA_API_KEY'));

  process.env = before;
}

// --- a failure explains itself without boilerplate ------------------------
//
// The egress note was appended to every failure, so a build that failed for a
// real documentation reason carried a paragraph about package registries - and
// a note attached to every failure is one nobody reads by the third run.
{
  const before = process.env;
  process.env = { ...process.env };
  delete process.env.DOCXY_SANDBOX_ALLOW_NETWORK;
  const blocked = loadConfig();

  check('a documentation failure gets no network lecture',
    networkHint(blocked, "unbalanced fences: ['docs/guide.md']") === '');
  check('a failure that reached for the network does',
    networkHint(blocked, 'npm ERR! getaddrinfo ENOTFOUND registry.npmjs.org').length > 0);

  process.env.DOCXY_SANDBOX_ALLOW_NETWORK = 'true';
  check('and none of it applies when egress was allowed',
    networkHint(loadConfig(), 'getaddrinfo ENOTFOUND registry.npmjs.org') === '');

  process.env = before;
}

// --- no workspace is a reported reason, not silence -----------------------
//
// A configured build that could not run in isolation is a proposal nobody
// checked. `ValidationReport.ok` waves through anything `skipped`, so this has
// to fail - and it has to name the missing key, or the operator cannot tell a
// misconfiguration from a build that genuinely passed.
{
  const before = process.env;
  process.env = { ...process.env };
  process.env.DOCXY_DOCS_BUILD_COMMAND = 'echo hi';
  process.env.DAYTONA_API_KEY = '';
  delete process.env.DOCXY_TEST_COMMAND;
  delete process.env.DOCXY_SANDBOX_FALLBACK;

  const config = loadConfig();
  const report = await validateProposal({
    config,
    applied: { files: [], problems: [] },
    changelogFile: null,
    classification: {
      kind: 'fix', surface: 'docs-only', summary: 's',
      changedSymbols: [], breakingRationale: '', confidence: 1,
    },
    changelog: undefined,
    docsPath: config.repoPath,
    stageable: false,
  });

  const build = report.checks.find((c) => c.name === 'docs-build');
  check('no workspace fails the build', build?.status === 'fail');
  check('and the report is not ok', report.ok === false);
  check('and it names the missing key rather than shrugging',
    (build?.detail ?? '').includes('DAYTONA_API_KEY'));

  process.env = before;
}


// --- every impacted doc is accounted for ----------------------------------
//
// The budget was 20,000 characters across *all* impacted files, spent
// first-come-first-served, and whatever did not fit was dropped without a word.
// On a real run with three impacted docs totalling 58,000 characters the Docs
// Updater was given 56% of the first and nothing of the other two - while the
// impact map in the same prompt named sections in all three. Every
// `anchor-not-found` failure in this repository traces to that: a model asked
// to quote text it was never shown will invent it.
{
  const dir = await mkdtemp(join(tmpdir(), 'docxy-excerpt-'));
  const write = async (name: string, size: number) => {
    await writeFile(join(dir, name), 'x'.repeat(size), 'utf8');
  };

  // Comfortably inside the budget: everything arrives whole.
  await write('small-a.md', 3_000);
  await write('small-b.md', 4_000);
  const whole = await readDocExcerpts(dir, ['small-a.md', 'small-b.md']);
  check('files inside the budget arrive complete',
    whole.truncated.length === 0 && whole.omitted.length === 0);
  check('and are marked complete so the model knows it saw everything',
    (whole.text.match(/\(complete\)/g) ?? []).length === 2);

  // A file the impact map named but that does not exist.
  const gone = await readDocExcerpts(dir, ['small-a.md', 'not-here.md']);
  check('an unreadable path is reported missing', gone.missing.includes('not-here.md'));
  check('and does not silently vanish', !gone.text.includes('not-here.md'));

  // The real shape of the bug: one big file listed first, smaller ones after.
  // Under the old allocator the big one ate everything and the rest were gone.
  const tight = await mkdtemp(join(tmpdir(), 'docxy-excerpt-tight-'));
  await writeFile(join(tight, 'huge.md'), 'h'.repeat(400_000), 'utf8');
  await writeFile(join(tight, 'mid.md'), 'm'.repeat(20_000), 'utf8');
  await writeFile(join(tight, 'tiny.md'), 't'.repeat(1_500), 'utf8');

  const shared = await readDocExcerpts(tight, ['huge.md', 'mid.md', 'tiny.md']);
  // Being listed first is the Impact Mapper's ordering and carries no claim
  // about importance, so it must not decide who gets seen at all.
  check('a huge first file no longer starves the rest',
    shared.text.includes('mid.md') && shared.text.includes('tiny.md'));
  check('the small files arrive whole',
    !shared.truncated.includes('tiny.md') && !shared.truncated.includes('mid.md'));
  check('the oversized one is reported truncated', shared.truncated.includes('huge.md'));
  check('and says so in its own header, with the numbers',
    /huge\.md \(FIRST \d+ OF 400000 CHARACTERS\)/.test(shared.text));
  check('and tells the model not to anchor past the cut',
    shared.text.includes('Do not propose an edit anchored anywhere past this point'));

  // Nothing may be dropped in silence: every path handed in comes back in
  // exactly one of the four buckets.
  const accounted = new Set([
    ...shared.truncated,
    ...shared.omitted,
    ...shared.missing,
    ...['huge.md', 'mid.md', 'tiny.md'].filter((p) => shared.text.includes(`FILE: ${p} (complete)`)),
  ]);
  check('every requested path is accounted for somewhere',
    accounted.size === 3, [...accounted].join(','));

  await rm(dir, { recursive: true, force: true });
  await rm(tight, { recursive: true, force: true });
}

// --- a useless sliver is worse than an honest omission --------------------
//
// A few hundred characters of a long document is too little to anchor against
// but enough to look like the file was provided, which is the exact condition
// that produces a confident wrong anchor.
{
  const dir = await mkdtemp(join(tmpdir(), 'docxy-excerpt-sliver-'));
  const many = 40;
  const names: string[] = [];
  for (let i = 0; i < many; i += 1) {
    const name = `doc-${i}.md`;
    names.push(name);
    await writeFile(join(dir, name), 'z'.repeat(50_000), 'utf8');
  }

  const before_ = process.env.DOCXY_DOC_EXCERPT_BUDGET;
  process.env.DOCXY_DOC_EXCERPT_BUDGET = '';
  const spread = await readDocExcerpts(dir, names);
  if (before_ === undefined) delete process.env.DOCXY_DOC_EXCERPT_BUDGET;
  else process.env.DOCXY_DOC_EXCERPT_BUDGET = before_;

  // 200,000 across 40 files of 50,000 is 5,000 each - above the floor, so each
  // is truncated rather than omitted, and each says so.
  check('a wide spread truncates rather than omitting', spread.truncated.length === many);
  check('and nothing is dropped without a word', spread.omitted.length === 0);
  check('and every file still carries its own cut marker',
    (spread.text.match(/characters were cut here/g) ?? []).length === many);

  await rm(dir, { recursive: true, force: true });
}


// --- a resumed run keeps one trace per role -------------------------------
//
// A run that died mid-role already carries a trace for it. Pushing a second
// gave the run two traces for one role - the abandoned one first - and every
// view that reads "the trace for this role" showed the dead attempt, so a
// resumed run rendered as having lost the roles it had just finished.
{
  const config = loadConfig();

  class FakeRuntime implements AgentRuntime {
    readonly name = 'mastra' as const;
    calls = 0;
    async assertReady() {}
    async mastra(): Promise<never> {
      throw new Error('the trace test never reaches the workflow');
    }
    modelFor() { return 'nebius/test-model'; }
    async resolveSession() {
      return { id: 'thread-1', reused: false, priorTurns: 0 };
    }
    async runTurn<T>(_role: RoleDefinition<T>): Promise<TurnResult<T>> {
      this.calls += 1;
      return {
        text: '', events: [], subthreads: [], status: 'stop', truncated: false,
        // SAFETY: this fake never reaches a provider, and the test asserts on
        // the trace rather than on the answer - the shape only has to satisfy
        // the signature.
        object: { kind: 'chore' } as T,
        usage: {
          inputTokens: 100, outputTokens: 10, cacheReadTokens: 0,
          cacheWriteTokens: 0, inputBreakdown: {},
        },
      };
    }
    async loadProjectMemory() { return emptyProjectMemory(); }
    async saveProjectMemory() {}
    async close() {}
  }

  const run: RunRecord = {
    id: 'run-1', repoPath: config.repoPath,
    commit: { sha: 'a'.repeat(40), shortSha: 'aaaaaaa', subject: 's' },
    startedAt: new Date().toISOString(), status: 'running', traces: [],
    priorSymbolCount: 0, newSymbolCount: 0,
  };

  const noop = {
    runs: { async save() {}, async load() { return null; }, async list() { return []; },
            async pending() { return []; },
            async logs() { return { entries: [], total: 0, kinds: [] }; } },
    sessions: { async get() { return undefined; }, async set() {}, async recordTurn() {},
                async clear() {}, async all() { return {}; } },
    knowledge: { async load() { return { symbols: {}, processedCommits: [] }; },
                 async merge() { return { map: { symbols: {}, processedCommits: [] }, added: 0 }; },
                 async reset() {} },
  };

  const runtime = new FakeRuntime();
  // SAFETY: every store method the invoke path touches is present above; the
  // assertion is what lets the fake omit the ones it provably never calls.
  const ctx = new RunContext(
    config, runtime, noop as never, run, new Map(), new AbortController().signal, {},
  );

  await ctx.invoke(CHANGE_ANALYST, 'first attempt');
  check('a role invoked once has one trace', run.traces.length === 1);

  // What a resume does to whatever the dead process left behind.
  run.traces[0]!.status = 'running';
  run.traces[0]!.error = 'the process ended before this role finished';

  await ctx.invoke(CHANGE_ANALYST, 'after the resume');
  check('a second invocation continues that trace, not a new one',
    run.traces.length === 1, `${run.traces.length} traces`);
  check('and the trace reads as done, not as the abandoned attempt',
    run.traces[0]!.status === 'done' && run.traces[0]!.error === undefined);
  check('and the spend from both attempts is kept',
    run.traces[0]!.usage?.inputTokens === 200, String(run.traces[0]!.usage?.inputTokens));
}

// --- a run holds one approval, across a resume ----------------------------
//
// The database says so with a unique index on run_id, so minting a second id
// for the same run is not a new request - it is a constraint violation that
// takes the whole save down with it, silently. The gate that collected human
// sign-offs is gone, but the record still names the scope a run was judged to
// need and the automatic sign-off that let it through, and a resume must not
// duplicate it.
{
  const first = createApprovalRequest('run-9', 'elevated', 'because', 'summary one');
  check('a fresh request starts with no sign-offs',
    first.signoffs.length === 0 && first.status === 'pending');

  autoApprove(first);
  check('the pipeline signs off in its own name',
    first.status === 'approved' && first.signoffs[0]?.by.includes('docxy'));

  const second = createApprovalRequest('run-9', 'elevated', 'because', 'summary two', first);
  check('a resumed run keeps the same approval id', second.id === first.id);
  check('and the sign-off already recorded', second.signoffs.length === 1);
  check('and refreshes the summary the verdict produced', second.summary === 'summary two');
  check('and keeps the creation time of the first attempt',
    second.createdAt === first.createdAt);
}

// --- credentials do not leave the machine ---------------------------------
//
// The untrusted text this pipeline reads is a commit diff: the one document
// whose purpose is to show lines someone just added, including the line where
// they added a key by mistake. Mastra's own `secrets` preset is three patterns
// and let a Stripe key and a GitHub token through in a live probe, so these
// rules exist and these are the shapes they have to catch.
{
  // Each case names the secret itself, so the assertion is that this exact
  // string is gone - not that something somewhere changed. The line it sits in
  // is built around it, because some of these rules key off the assignment
  // rather than the value alone.
  //
  // Every value is spliced from two fragments instead of written out whole.
  // They are synthetic - the AWS one is that vendor's own published example
  // key - but they are shaped exactly like the real thing, which is both the
  // point of the test and the reason a push scanner rejects the file holding
  // them. Splicing after each distinctive prefix leaves the runtime string
  // byte-identical, so `redactSecrets` is still handed a whole credential;
  // only the source stops reading as one. Anything added here should be
  // spliced the same way.
  const leaks: Array<[string, string, (secret: string) => string]> = [
    ['aws', `AKIA${'IOSFODNN7EXAMPLE'}`, (s) => `const id = "${s}";`],
    ['google', `AIza${'SyD-1234567890abcdefghijklmnopqrstu'}`, (s) => `key: "${s}"`],
    ['github pat', `ghp_${'16C7e42F292c6912E7710c838347Ae178B4a'}`, (s) => `token = "${s}"`],
    [
      'github fine-grained',
      `github_pat_${'11ABCDEFG0abcdefghijkl_mnopqrstuvwxyz1234567890ABCD'}`,
      (s) => `GITHUB_TOKEN=${s}`,
    ],
    ['gitlab', `glpat${'-ABCDEFGHIJKLMNOPQRST'}`, (s) => `CI_TOKEN=${s}`],
    ['stripe live', `sk_${'live'}_51H8xQ2eZvKYlo2CabcdefghijklmnopqrstuvWX`, (s) => `const STRIPE = "${s}";`],
    ['openai', `sk-${'proj'}-abcdefghijklmnopqrstuvwxyz1234567890`, (s) => `OPENAI_API_KEY=${s}`],
    ['anthropic', `sk-${'ant'}-api03-abcdefghijklmnopqrstuvwxyz123456`, (s) => `key: "${s}"`],
    ['huggingface', `hf_${'abcdefghijklmnopqrstuvwxyz1234567890'}`, (s) => `HF_TOKEN=${s}`],
    ['slack', `xoxb${'-123456789012-1234567890123-abcdefghijklmnop'}`, (s) => `SLACK=${s}`],
    [
      'slack webhook',
      `T00000000/${'B00000000'}/XXXXXXXXXXXXXXXX`,
      (s) => `https://hooks.slack.com/services/${s}`,
    ],
    ['npm', `npm_${'abcdefghijklmnopqrstuvwxyz1234567890'}`, (s) => `NPM_TOKEN=${s}`],
    ['assigned password', 'correct-horse-battery-staple-9182', (s) => `password = "${s}"`],
  ];

  for (const [name, secret, line] of leaks) {
    const { text: cleaned, redacted } = redactSecrets(line(secret));
    check(`a ${name} credential never reaches the model`,
      redacted.length > 0 && !cleaned.includes(secret), cleaned);
  }

  // The rule that fires decides what the audit line says, and `sk-ant-…`
  // matches the OpenAI pattern too. Both redact; only one is the truth.
  check('an anthropic key is named as anthropic, not openai',
    redactSecrets('sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456').redacted[0] === 'anthropic-key');

  // A private key goes as a whole block, not just its first line.
  const pem = [
    'const KEY = `-----BEGIN RSA PRIVATE KEY-----',
    'MIIEowIBAAKCAQEAx7Wm3fL0kx8Yq2vN5tRsQpZ1cD9eF6gH8jK0lM2nO4pQ',
    'aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789abcdefghijklmnopqrstuvwx',
    '-----END RSA PRIVATE KEY-----`;',
  ].join('\n');
  const { text: noPem } = redactSecrets(pem);
  check('a private key block is redacted whole',
    !noPem.includes('MIIEowIBAAKCAQEA') && !noPem.includes('aBcDeFgHiJkLmNoP'), noPem);

  // The password in a connection string, and only the password: the host and
  // database name are frequently what a documentation change is about.
  const dsn = 'DATABASE_URL=postgres://docxy:hunter2SuperSecret@db.example.com:5432/app';
  const { text: noDsn } = redactSecrets(dsn);
  check('a connection string loses its password', !noDsn.includes('hunter2SuperSecret'), noDsn);
  check('and keeps the host and database, which the docs may be about',
    noDsn.includes('db.example.com:5432/app'), noDsn);

  // The direction of error that matters. A rule firing on anything long and
  // random would mangle ordinary diffs, and a guard that breaks normal work is
  // one an operator turns off.
  const ordinary = [
    'export function createClient(options: ClientOptions, signal?: AbortSignal) {',
    'const commit = "7a39f30c8d1e4b2a9f0c3d5e6b8a1c2d4e5f6a7b";',
    'import { readFileSync } from "node:fs";',
    'const url = "https://github.com/Arindam200/docxy";',
    'token = process.env.GITHUB_TOKEN;',
    'password: hunter2',
    '- timeout?: number;\n+ timeoutMs: number;',
  ].join('\n');
  const { text: untouched, redacted: falsePositives } = redactSecrets(ordinary);
  check('ordinary code is left alone', untouched === ordinary,
    falsePositives.join(',') || untouched.slice(0, 120));
}


// --- the scorecard measures the pipeline, not the storage -----------------
//
// These replace the confidence gate rather than postponing it. A number the
// model grades itself on measures how the model feels; these read what a run
// actually recorded, so they are reproducible and free.
{
  const base = (over: Partial<RunRecord>): RunRecord => ({
    id: `r-${Math.random().toString(36).slice(2, 8)}`,
    repoPath: '/repo',
    commit: { sha: 'a'.repeat(40), shortSha: 'aaaaaaa', subject: 'a change' },
    startedAt: new Date().toISOString(),
    status: 'done',
    traces: [],
    priorSymbolCount: 0,
    newSymbolCount: 0,
    classification: {
      kind: 'fix', surface: 'internal', summary: 's',
      changedSymbols: [], breakingRationale: '', confidence: 1,
    },
    ...over,
  });

  const edit = (path: string) => ({
    path, section: 'H', find: 'x', replace: 'y', mode: 'replace' as const, rationale: 'r',
  });
  const file = (path: string, appliedEdits: number) => ({
    path, before: 'b', after: 'a', appliedEdits,
  });

  // Both anchors resolved.
  const clean = await scoreRuns([base({
    docs: { edits: [edit('a.md'), edit('b.md')], skipped: [] },
    impact: { docs: [{ path: 'a.md', section: 'H', reason: 'r', confidence: 1 },
                     { path: 'b.md', section: 'H', reason: 'r', confidence: 1 }],
              code: [], symbolIndex: {}, notes: '' },
    proposedFiles: [file('a.md', 1), file('b.md', 1)],
  })]);
  const scoreOf = (card: Awaited<ReturnType<typeof scoreRuns>>, id: string) =>
    card.runs[0]?.scores.find((s) => s.scorer === id)?.score;
  check('every anchor resolving scores 1', scoreOf(clean, 'anchor-resolution') === 1);
  check('and an edit inside the map scores 1', scoreOf(clean, 'stayed-in-scope') === 1);

  // One of two anchors failed to apply.
  const half = await scoreRuns([base({
    docs: { edits: [edit('a.md'), edit('b.md')], skipped: [] },
    proposedFiles: [file('a.md', 1)],
  })]);
  check('one anchor of two resolving scores 0.5', scoreOf(half, 'anchor-resolution') === 0.5);

  // The changelog is spliced in, not anchored, and must not be counted as a
  // Docs Updater edit that succeeded.
  const changelogOnly = await scoreRuns([base({
    docs: { edits: [edit('a.md')], skipped: [] },
    proposedFiles: [file('CHANGELOG.md', 1)],
  })]);
  check('a changelog splice does not stand in for a failed anchor',
    scoreOf(changelogOnly, 'anchor-resolution') === 0);

  // An honest no-op: nothing proposed is nothing wrong.
  const noop = await scoreRuns([base({
    docs: { edits: [], skipped: [{ path: 'a.md', reason: 'already current' }] },
    proposedFiles: [file('CHANGELOG.md', 1)],
  })]);
  check('proposing no edits is not an anchor failure',
    scoreOf(noop, 'anchor-resolution') === 1);
  check('but a run that proposed nothing at all is caught',
    scoreOf(await scoreRuns([base({ proposedFiles: [] })]), 'produced-a-proposal') === 0);

  // Editing a file the impact map never flagged - the coordinator's first
  // listed reason to reject, and the shape a successful injection would take.
  const strayed = await scoreRuns([base({
    docs: { edits: [edit('a.md'), edit('surprise.md')], skipped: [] },
    impact: { docs: [{ path: 'a.md', section: 'H', reason: 'r', confidence: 1 }],
              code: [], symbolIndex: {}, notes: '' },
    proposedFiles: [file('a.md', 1), file('surprise.md', 1)],
  })]);
  check('an edit outside the impact map is scored against the run',
    scoreOf(strayed, 'stayed-in-scope') === 0.5);

  // The inconsistency that reaches users as a broken upgrade.
  const badBump = await scoreRuns([base({
    classification: { kind: 'breaking', surface: 'public-api', summary: 's',
                      changedSymbols: [], breakingRationale: '', confidence: 1 },
    changelog: { entry: 'e', section: 'Changed', semverBump: 'patch', bumpRationale: 'r' },
  })]);
  check('breaking under a patch bump scores 0', scoreOf(badBump, 'semver-agreement') === 0);
  const goodBump = await scoreRuns([base({
    classification: { kind: 'breaking', surface: 'public-api', summary: 's',
                      changedSymbols: [], breakingRationale: '', confidence: 1 },
    changelog: { entry: 'e', section: 'Changed', semverBump: 'major', bumpRationale: 'r' },
  })]);
  check('and under a major bump scores 1', scoreOf(goodBump, 'semver-agreement') === 1);
  check('a run with no changelog is not penalised for one',
    scoreOf(await scoreRuns([base({})]), 'semver-agreement') === 1);

  // A skipped check is neither a pass nor a failure; an unconfigured docs
  // build must not make every deployment look broken.
  const mixed = await scoreRuns([base({
    validation: { ok: false, checks: [
      { name: 'edits-apply', status: 'pass', detail: '' },
      { name: 'link-check', status: 'fail', detail: '' },
      { name: 'docs-build', status: 'skipped', detail: 'no command configured' },
    ] },
  })]);
  check('skipped checks are left out of the validation score',
    scoreOf(mixed, 'validation-clean') === 0.5);

  // A run that died before producing anything is not documentation being
  // wrong, and averaging it in would hide both facts.
  const failed = await scoreRuns([{ ...base({}), classification: undefined, status: 'failed' }]);
  check('a run with no output is skipped rather than scored zero', failed.runs.length === 0);

  // A trend through four points is a decoration.
  check('too few runs report no trend', clean.trend === undefined);
}


// --- a mis-quoted anchor gets one more chance -----------------------------
//
// An anchor that does not match byte for byte is thrown away and the whole
// proposal is rejected with it. Three causes were fixed upstream; what is left
// is the model paraphrasing, and measuring this repository's runs showed none
// of it is whitespace drift - a normalising re-anchor in code would fix
// nothing. So it has to be asked again, and the pass is bounded to be worth it.
{
  const dir = await mkdtemp(join(tmpdir(), 'docxy-repair-'));
  await writeFile(join(dir, 'guide.md'), '# Guide\n\nRun `docxy run HEAD~1` to start.\n', 'utf8');

  const good = { path: 'guide.md', section: 'Guide', find: 'docxy run HEAD~1',
                 replace: 'docxy run HEAD', mode: 'replace' as const, rationale: 'r' };
  // What a model actually did: substituted a plausible SHA for the literal text.
  const wrong = { ...good, find: 'docxy run 7ee9a8e' };

  class Repairer implements AgentRuntime {
    readonly name = 'mastra' as const;
    calls = 0;
    lastPrompt = '';
    constructor(private readonly answer: DocsProposal) {}
    async assertReady() {}
    async mastra(): Promise<never> { throw new Error('unused'); }
    modelFor() { return 'nebius/test'; }
    async resolveSession() { return { id: 't', reused: false, priorTurns: 0 }; }
    async runTurn<T>(_r: RoleDefinition<T>, _s: string, prompt: string): Promise<TurnResult<T>> {
      this.calls += 1;
      this.lastPrompt = prompt;
      return {
        text: '', events: [], subthreads: [], status: 'stop', truncated: false,
        // SAFETY: the fake stands in for a provider that validated this against
        // the Docs Updater schema; the test asserts on anchoring, not shape.
        object: this.answer as T,
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0,
                 cacheWriteTokens: 0, inputBreakdown: {} },
      };
    }
    async loadProjectMemory() { return emptyProjectMemory(); }
    async saveProjectMemory() {}
    async close() {}
  }

  const ctxFor = (runtime: AgentRuntime) => {
    const run: RunRecord = {
      id: 'r', repoPath: dir,
      commit: { sha: 'a'.repeat(40), shortSha: 'aaaaaaa', subject: 's' },
      startedAt: new Date().toISOString(), status: 'running', traces: [],
      priorSymbolCount: 0, newSymbolCount: 0,
    };
    const noop = {
      runs: { async save() {}, async load() { return null; }, async list() { return []; },
              async pending() { return []; },
              async logs() { return { entries: [], total: 0, kinds: [] }; } },
      sessions: { async get() { return undefined; }, async set() {}, async recordTurn() {},
                  async clear() {}, async all() { return {}; } },
      knowledge: { async load() { return { symbols: {}, processedCommits: [] }; },
                   async merge() { return { map: { symbols: {}, processedCommits: [] }, added: 0 }; },
                   async reset() {} },
    };
    // SAFETY: as in the trace test - the fake carries every store method the
    // invoke path touches, and omits only ones it provably never calls.
    return new RunContext(loadConfig(), runtime, noop as never, run, new Map(),
      new AbortController().signal, {});
  };

  const brokenProposal: DocsProposal = { edits: [wrong], skipped: [] };
  const firstPass = await applyDocEdits(dir, brokenProposal);
  check('a paraphrased anchor does not apply', firstPass.files.length === 0);

  // The repair returns the anchor copied from the file.
  const fixer = new Repairer({ edits: [good], skipped: [] });
  const repaired = await repairAnchors(ctxFor(fixer), dir, brokenProposal, firstPass);
  check('one repair call is made', fixer.calls === 1);
  check('and it names the failure it is fixing',
    fixer.lastPrompt.includes('did not apply') && fixer.lastPrompt.includes('7ee9a8e'));
  check('and hands over the whole current file',
    fixer.lastPrompt.includes('Run `docxy run HEAD~1` to start.'));
  check('the repaired edit applies', repaired.applied.files.length === 1);
  check('and it is reported as fixed', repaired.attempted?.fixed === 1);

  // A repair that anchors no more than the first pass is discarded: a second
  // opinion that is worse must not replace one that worked.
  const useless = new Repairer({ edits: [{ ...good, find: 'still not in the file' }], skipped: [] });
  const kept = await repairAnchors(ctxFor(useless), dir, brokenProposal, firstPass);
  check('a repair that is no better is thrown away', kept.docs === brokenProposal);
  check('and says it fixed nothing', kept.attempted?.fixed === 0);

  // Nothing to repair means nothing is spent.
  const clean = await applyDocEdits(dir, { edits: [good], skipped: [] });
  const idle = new Repairer({ edits: [], skipped: [] });
  const untouched = await repairAnchors(ctxFor(idle), dir, { edits: [good], skipped: [] }, clean);
  check('a clean proposal costs no repair call', idle.calls === 0);
  check('and is passed through unchanged', untouched.attempted === undefined);

  await rm(dir, { recursive: true, force: true });
}

// --- project memory ------------------------------------------------------
{
  const runOf = (over: Partial<RunRecord>): RunRecord => ({
    id: 'r', repoPath: '/repo',
    commit: { sha: 'a'.repeat(40), shortSha: 'aaaaaaa', subject: 's' },
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:01:00.000Z',
    status: 'done', traces: [], priorSymbolCount: 0, newSymbolCount: 0,
    ...over,
  });

  const edit = (path: string) => ({ path, find: 'x', replace: 'y', why: 'w' });

  // Two edits proposed to one file, one of which applied.
  const partial = runOf({
    docs: { edits: [edit('a.md'), edit('a.md')], skipped: [] },
    impact: { docs: [{ path: 'a.md', section: 's', reason: 'r', confidence: 1 }], code: [], symbolIndex: {} },
    proposedFiles: [{ path: 'a.md', before: '', after: '', appliedEdits: 1 }],
  });

  const once = observeRun(emptyProjectMemory(), partial);
  check('a run is counted once', once.observed.runs === 1);
  check('proposed edits are counted per file', once.files[0]?.proposed === 2);
  check('and applied edits with them', once.files[0]?.applied === 1);
  check('the commit is recorded', once.observed.lastCommit === 'a'.repeat(40));

  // Folding is cumulative, which is what makes a rate mean anything.
  const twice = observeRun(once, partial);
  check('folding is cumulative', twice.files[0]?.proposed === 4 && twice.files[0]?.applied === 2);
  check('and counts the runs it saw', twice.files[0]?.runs === 2);

  // A role that never returned says nothing about how well anchors match.
  const noDocs = observeRun(twice, runOf({ proposedFiles: [] }));
  check('a run with no proposal is not observed', noDocs.observed.runs === 2);

  // The hydration trap `scoreRuns` documents: a listing omits `proposedFiles`,
  // and folding one would record every anchor as having failed.
  const unhydrated = observeRun(twice, runOf({ docs: { edits: [edit('a.md')], skipped: [] } }));
  check('an unhydrated run is refused rather than scored zero', unhydrated.observed.runs === 2);

  // A repair pass can apply more than the first pass proposed.
  const overApplied = observeRun(emptyProjectMemory(), runOf({
    docs: { edits: [edit('b.md')], skipped: [] },
    proposedFiles: [{ path: 'b.md', before: '', after: '', appliedEdits: 4 }],
  }));
  check('applied edits cannot exceed proposed', overApplied.files[0]?.applied === 1);

  // An edit to a file the map never flagged is the Impact Mapper's problem.
  const strayed = observeRun(emptyProjectMemory(), runOf({
    docs: { edits: [edit('c.md')], skipped: [] },
    impact: { docs: [], code: [], symbolIndex: {} },
    proposedFiles: [{ path: 'c.md', before: '', after: '', appliedEdits: 1 }],
  }));
  check('an edit outside the map is counted', strayed.outOfScopeEdits === 1);

  // Rendering.
  check(
    'an unobserved repository says so',
    renderProjectMemory(emptyProjectMemory(), 'docs-updater').includes('has not yet completed'),
  );

  // Three observations is under the threshold; the file stays unjudged.
  const thin = observeRun(emptyProjectMemory(), runOf({
    docs: { edits: [edit('d.md'), edit('d.md'), edit('d.md')], skipped: [] },
    proposedFiles: [{ path: 'd.md', before: '', after: '', appliedEdits: 0 }],
  }));
  check(
    'too few observations name no file',
    !renderProjectMemory(thin, 'docs-updater').includes('d.md'),
  );

  const fragile = observeRun(thin, runOf({
    docs: { edits: [edit('d.md')], skipped: [] },
    proposedFiles: [{ path: 'd.md', before: '', after: '', appliedEdits: 0 }],
  }));
  const forUpdater = renderProjectMemory(fragile, 'docs-updater');
  check('a file that keeps missing is named', forUpdater.includes('d.md'));
  check('with the numbers behind the claim', forUpdater.includes('0 of 4'));
  check('and told how to quote', forUpdater.includes('character by character'));

  const forMapper = renderProjectMemory(fragile, 'impact-mapper');
  check('the mapper is told not to flag it', forMapper.includes('do not flag sample output'));
  check('and is not given the quoting instruction', !forMapper.includes('character by character'));

  // A round trip through storage, which is a string either way.
  const restored = parseProjectMemory(serializeProjectMemory(fragile));
  check('a record survives storage', restored.files[0]?.proposed === 4);
  check('an absent record reads as empty', parseProjectMemory(null).observed.runs === 0);
  check('so does an unparseable one', parseProjectMemory('{{{').observed.runs === 0);
  check(
    'and one written in a shape this version does not know',
    parseProjectMemory('{"version":99,"files":[]}').observed.runs === 0,
  );
}

// --- code mode -----------------------------------------------------------
{
  const FILE = '# Guide\n\nRuns **250 checks** with no network.\n\nSame line twice.\nSame line twice.\n';
  const edit = (over: Partial<ProposedEditInput> = {}): ProposedEditInput => ({
    path: 'g.md', section: 'Guide', find: 'Runs **250 checks** with no network.',
    replace: 'Runs **271 checks** with no network.', mode: 'replace', rationale: 'r',
    ...over,
  });

  check('an anchor copied from the file passes', checkProposedEdit(FILE, edit()) === null);

  // The failure the whole mode exists to remove: the same sentence, retyped
  // without its markdown.
  const retyped = checkProposedEdit(FILE, edit({ find: 'Runs 250 checks with no network.' }));
  check('a retyped anchor is refused', retyped !== null);
  check('and is told to take it from the text', (retyped ?? '').includes('instead of taking'));
  check('and where to take it from', (retyped ?? '').includes('docs["g.md"]'));

  const twice = checkProposedEdit(FILE, edit({ find: 'Same line twice.' }));
  check('an ambiguous anchor is refused', (twice ?? '').includes('appears 2 times'));

  check(
    'a too-short anchor is refused',
    (checkProposedEdit(FILE, edit({ find: 'Runs' })) ?? '').includes('too short'),
  );
  check(
    'a no-op edit is refused',
    (checkProposedEdit(FILE, edit({ replace: 'Runs **250 checks** with no network.' })) ?? '')
      .includes('changes nothing'),
  );
  check(
    'an empty replacement is refused',
    (checkProposedEdit(FILE, edit({ replace: '  ' })) ?? '').includes('empty replacement'),
  );

  // An append carries no anchor by design and must not be held to one.
  check(
    'an append needs no anchor',
    checkProposedEdit(FILE, edit({ mode: 'append', find: '', replace: '## New section' })) === null,
  );

  // The exfiltration boundary. A program that read a key off the host cannot
  // launder it into a documentation pull request.
  const key = ['-----BEGIN RSA PRIVATE KEY-----', 'MIIEowIBAAKCAQEAxxxxxxxxxxxx', '-----END RSA PRIVATE KEY-----'].join('\n');
  const leaked = checkProposedEdit(FILE, edit({ replace: `Use this key:\n${key}` }));
  check('a credential in a proposal is refused', leaked !== null);
  check('and named as one', (leaked ?? '').includes('looks like a credential'));
}

// --- code mode, through the sandbox --------------------------------------
{
  const isolation = LocalSandbox.detectIsolation();
  if (!isolation.available) {
    console.log(`  skip code mode sandbox - no isolation backend (${isolation.message})`);
  } else {
    const dir = await mkdtemp(join(tmpdir(), 'docxy-codemode-'));
    await writeFile(join(dir, 'g.md'), '# Guide\n\nRuns **250 checks** with no network.\n', 'utf8');
    await writeFile(join(dir, 'secret.md'), 'not in the impact map\n', 'utf8');

    const config = loadConfig();
    // The local sandbox is the one under test here: Daytona would need a key
    // and a network, and `npm test` has neither. It has to be asked for by
    // name, which is the point of the two checks either side of this.
    const local = {
      ...config,
      agent: { ...config.agent, codeModeSandbox: 'local' as const },
      sandbox: { ...config.sandbox, daytonaApiKey: '' },
    };
    const { sandbox, where } = await createDraftingSandbox(local);
    check('local is used when it is asked for by name', where === 'local');

    // The production default: no key is an error, never a quiet move onto this
    // machine. A deployment must not draft locally because a variable is unset.
    const demandsDaytona = {
      ...config,
      agent: { ...config.agent, codeModeSandbox: 'daytona' as const },
      sandbox: { ...config.sandbox, daytonaApiKey: '' },
    };
    let refused = '';
    try {
      await createDraftingSandbox(demandsDaytona);
    } catch (err) {
      refused = err instanceof Error ? err.message : String(err);
    }
    check('a missing daytona key is refused, not downgraded', refused.includes('DAYTONA_API_KEY'));
    check('and says how to ask for local instead', refused.includes('DOCXY_CODE_MODE_SANDBOX=local'));

    // Turning the docs build off must not relocate where a model's code runs.
    const buildOff = {
      ...config,
      agent: { ...config.agent, codeModeSandbox: 'daytona' as const },
      sandbox: { ...config.sandbox, enabled: false, daytonaApiKey: 'k' },
    };
    const stillRemote = await createDraftingSandbox(buildOff);
    check('DOCXY_SANDBOX=false does not move drafting onto this host', stillRemote.where === 'daytona');
    await stillRemote.sandbox.stop?.().catch(() => {});

    const session = createCodeModeSession({
      docsPath: dir, allowedPaths: ['g.md'], sandbox, where, timeoutMs: 60_000,
    });
    // SAFETY: the session exposes exactly one tool under the id `run_program`,
    // which the test drives directly so no model is needed to check the guards.
    const runner = session.tools as Record<string, CodeModeProgramRunner>;
    const tool = runner.run_program!;

    check('the program is told which files it has', session.instructions.includes('"g.md"'));
    check('and not told about the others', !session.instructions.includes('secret.md'));

    // The whole point, as a program: locate the line, take the anchor from the
    // bytes it was given, and derive the replacement from the same line. The
    // retyped anchor and the out-of-scope path are refused alongside it.
    const program = `
      const line = docs['g.md'].split('\\n').find((l) => l.includes('250 checks'));
      return {
        edits: [
          { path: 'g.md', section: 'Guide', mode: 'replace', rationale: 'r',
            find: 'Runs 250 checks with no network.', replace: 'x' },
          { path: 'g.md', section: 'Guide', mode: 'replace', rationale: 'r',
            find: line, replace: line.replace('250', '271') },
          { path: 'secret.md', section: 'x', mode: 'replace', rationale: 'r',
            find: 'not in the impact map', replace: 'y' },
        ],
        skipped: [{ path: 'g.md', reason: 'nothing else stale' }],
      };
    `;

    const outcome = await tool.execute({ code: program }, {});
    await sandbox.stop?.().catch(() => {});

    check('the program ran in the sandbox', outcome.accepted === 1);
    check('a retyped anchor is refused', 
      outcome.refused.some((r) => r.error.includes('does not appear in the file')));
    check('a file outside the impact map is refused',
      outcome.refused.some((r) => r.path === 'secret.md' && r.error.includes('not in the impact map')));

    const draft = session.draft();
    check('only the derived edit was collected', draft.proposal.edits.length === 1);
    check('and it carries the real bytes',
      draft.proposal.edits[0]?.find === 'Runs **250 checks** with no network.');
    check('the replacement kept the markdown',
      draft.proposal.edits[0]?.replace === 'Runs **271 checks** with no network.');
    // The same file was both edited and skipped by the program. The edit is the
    // work, so the contradictory skip is dropped rather than shown to a reviewer.
    check('a file that was edited is not also reported skipped', draft.proposal.skipped.length === 0);
    check('and the refusals were reported, not swallowed', draft.rejected.length === 2);

    // A skip for a file with no edits is kept, and trimmed to something a
    // person can read.
    const second = await tool.execute({ code: `
      return { edits: [], skipped: [{ path: 'g.md', reason: 'x'.repeat(900) }] };
    ` }, {});
    check('a program may report only skips', second.accepted === 0);

    // The edit the program built actually applies - the number this whole mode
    // exists to move.
    const applied = await applyDocEdits(dir, draft.proposal);
    check('the collected edit applies cleanly', applied.files[0]?.appliedEdits === 1);

    await rm(dir, { recursive: true, force: true });
  }
}

// --- code mode, program plumbing -----------------------------------------
{
  const wrapped = buildProgram('return { edits: [], skipped: [] };', { 'a.md': 'hello' });
  check('the docs are injected as data', wrapped.includes('"a.md":"hello"'));
  check('and the body can return at the top level', wrapped.includes('const run = async () =>'));

  check(
    'a program that printed nothing is reported, not crashed',
    readProgramOutput('some logs\n').ok === false,
  );
  check(
    'stray output before the frame is ignored',
    readProgramOutput('chatter\n__DOCXY_RESULT__{"ok":true,"result":{"edits":[]}}').ok === true,
  );
  check(
    'and an unparseable frame is reported',
    (readProgramOutput('__DOCXY_RESULT__{not json').error ?? '').includes('could not be read'),
  );
}

/*
 * Transactional mail: what a person can put inside a link.
 *
 * The template lives in the dashboard, but it has no imports of its own, so it
 * loads here and these run with the rest of the pure-logic suite.
 *
 * The bug being pinned: copy is written as `[label](url)` and escaping does not
 * touch `[` or `(`, so interpolating an organization name straight into the
 * body turned a name like `[Verify your account](https://phishing.example)`
 * into a live link inside a message sent from a verified sending domain.
 */
{
  const { renderEmail } = await import('../web/src/lib/email-template.ts');

  const hostile = '[Verify your account](https://phishing.example/steal)';
  const invitation = renderEmail({
    eyebrow: 'Invitation',
    heading: `Join ${hostile}`,
    body: ['{inviter} has invited you to join {organization} on Docxy.'],
    values: { inviter: 'Attacker', organization: hostile },
    action: { href: 'https://docxy.app/invite/x', label: 'Accept invitation' },
    footer: 'Sent because somebody invited this address.',
    preheader: 'You have been invited.',
  });

  check(
    'a name carrying link syntax cannot become a link',
    !invitation.includes('href="https://phishing.example/steal"'),
  );
  check(
    'and it is still shown, as the characters it is',
    invitation.includes('[Verify your account]'),
  );
  check('a heading with link syntax is escaped, not linked', !invitation.includes('<a href="https://phishing'));

  const links = renderEmail({
    eyebrow: 'Welcome',
    heading: 'Welcome',
    body: [
      'Read the [documentation](https://docxy.app/docs).',
      'Not this [one](javascript:alert).',
      'Nor this [one](data:text/html,hi).',
    ],
    action: { href: 'https://docxy.app', label: 'Open' },
    footer: 'Sent because you signed up.',
    preheader: 'Welcome.',
  });

  check('template copy still links', links.includes('href="https://docxy.app/docs"'));
  check('a javascript: target is refused', !links.includes('javascript:'));
  check('a data: target is refused', !links.includes('data:text/html'));
  check('and a refused link keeps its label as text', links.includes('Not this one.'));
  // The pattern stops at the first `)`, so a target containing one leaves a
  // stray bracket behind. Cosmetic, and only reachable from copy we write
  // ourselves: the refusal above is what matters, and it still holds.
  check(
    'a target with its own parentheses is still refused',
    !renderEmail({
      eyebrow: 'x',
      heading: 'x',
      body: ['[label](javascript:alert(1))'],
      action: { href: 'https://docxy.app', label: 'Open' },
      footer: 'f',
      preheader: 'p',
    }).includes('javascript:'),
  );
}

// --- what a plan sells, and what it allows -------------------------------
{
  check('free is not a provider subscription', plans.free.purchasable === false);
  check('free runs never start on a push', plans.free.entitlements.automaticRuns === false);
  check('pro is nineteen dollars', monthlyPriceMinor('pro') === 1_900);
  check('and it is priced in cents', formatUsd(monthlyPriceMinor('pro')) === '$19');

  // Only a plan key crosses from the browser; everything else is derived here.
  check('a known plan key parses', parsePlanKey('team') === 'team');
  check('an unknown one does not', parsePlanKey('enterprise') === null);
  check('and neither does an absent one', parsePlanKey(undefined) === null);

  // Seats: the base package is a floor, the pilot ceiling is a ceiling, and
  // a plan without seat expansion ignores the number entirely.
  check('team cannot be bought below its base', normalizeSeats('team', 2) === 5);
  check('team is capped at the pilot ceiling', normalizeSeats('team', 400) === 25);
  check('pro sells one seat whatever is asked', normalizeSeats('pro', 9) === 1);
  check('the add-on bills only the seats beyond the base', seatAddOnQuantity('team', 8) === 3);
  check('and nothing at the base package', seatAddOnQuantity('team', 5) === 0);

  const expanded = entitlementsFor('team', 8);
  check('a bought seat brings a repository', expanded.repositories === 8);
  check('and its share of the pool', expanded.runsPerMonth === 120 + 3 * 24);
  check('eight team seats cost $204', monthlyPriceMinor('team', 8) === 12_900 + 3 * 2_500);

  // A fractional or nonsense capacity is a number typed into a browser.
  check('a fractional capacity is truncated', normalizeSeats('team', 7.9) === 7);
  check('and an unusable one falls back to the base', normalizeSeats('team', Number.NaN) === 5);
}

// --- when a free allowance resets ----------------------------------------
{
  const anchor = new Date('2026-01-31T09:30:00.000Z');

  const first = freePeriodBounds(anchor, new Date('2026-02-02T00:00:00.000Z'));
  check('the first period starts at the anchor', first.start.toISOString() === anchor.toISOString());
  check(
    'and ends on the last day of a short month',
    first.end.toISOString() === '2026-02-28T09:30:00.000Z',
  );

  // Measured from the anchor every time, so a 31st that was clamped once does
  // not stay clamped: chaining month additions is how it would drift to the
  // 28th forever.
  const march = freePeriodBounds(anchor, new Date('2026-03-15T00:00:00.000Z'));
  check('a clamped day comes back', march.start.toISOString() === '2026-02-28T09:30:00.000Z');
  check('and the next window is the 31st again', march.end.toISOString() === '2026-03-31T09:30:00.000Z');

  // The moment the window opens belongs to the new window, not the old one.
  const boundary = freePeriodBounds(anchor, new Date('2026-03-31T09:30:00.000Z'));
  check('a reset is inclusive of its own start', boundary.start.toISOString() === '2026-03-31T09:30:00.000Z');
  const justBefore = freePeriodBounds(anchor, new Date('2026-03-31T09:29:59.999Z'));
  check('and the instant before it is not', justBefore.end.toISOString() === '2026-03-31T09:30:00.000Z');

  // A dormant account is priced by arithmetic, not by iteration.
  const dormant = freePeriodBounds(anchor, new Date('2028-07-04T12:00:00.000Z'));
  check('a long-dormant account lands in one window', dormant.start.toISOString() === '2028-06-30T09:30:00.000Z');
  check('with the next reset ahead of it', dormant.end > new Date('2028-07-04T12:00:00.000Z'));

  // A clock skewed behind the anchor must not hand out a second allowance.
  const early = freePeriodBounds(anchor, new Date('2025-12-01T00:00:00.000Z'));
  check('a time before the anchor still has one period', early.start.toISOString() === anchor.toISOString());

  check('adding months is UTC, not local', addMonthsUtc(anchor, 1).toISOString() === '2026-02-28T09:30:00.000Z');
}

// --- project rollup ------------------------------------------------------
// The dashboard's per-project cards are rolled up in the browser bundle from
// one organization-wide listing, rather than by asking the API for a report per
// project. That makes `rollUp` a second implementation of definitions that live
// in `buildReport`, and two implementations of "success rate" that disagree are
// worse than either alone: a card reading 80% beside a project whose own
// Insights page reads 60% makes both numbers untrustworthy. So they are checked
// against each other on the same runs.
{
  const at = (day: number) => `2026-08-0${day}T00:00:00.000Z`;
  const run = (
    id: string,
    status: RunRecord['status'],
    costUsd: number | undefined,
    day: number,
  ): RunRecord => {
    const record: RunRecord = {
      id,
      repoPath: '/repos/one',
      commit: { sha: `${id}0000`, shortSha: id, subject: 's' },
      startedAt: at(day),
      status,
      durationMs: 1000,
      traces: [],
      priorSymbolCount: 0,
      newSymbolCount: 0,
    };
    // Left off entirely rather than set to zero: a run with no price recorded
    // is the case both rollups have to report as unknown.
    if (costUsd !== undefined) {
      record.totals = { inputTokens: 1, outputTokens: 1, costUsd };
    }
    return record;
  };

  const records = [
    run('aaa', 'done', 0.01, 1),
    run('bbb', 'failed', 0.02, 2),
    run('ccc', 'approved', undefined, 3),
    // Still going, so it counts towards neither side of the success rate.
    run('ddd', 'running', undefined, 4),
  ];

  // The dashboard hands `rollUp` summaries newest first, which is the order
  // `projectRuns` produces.
  const summaries = [...records]
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .map((record) => ({
      id: record.id,
      repoPath: record.repoPath,
      commit: record.commit,
      status: record.status,
      startedAt: record.startedAt,
      durationMs: record.durationMs,
      totals: record.totals,
      pullRequestUrl: record.pullRequestUrl,
    }));

  const rolled = rollUp(summaries);
  const built = buildReport(records);

  check('a rollup counts every run in the window', rolled.runs === built.window.runs);
  check('a rollup agrees with the report on success rate',
    rolled.successRate === built.successRate && rolled.successRate === 2 / 3);
  check('a rollup agrees with the report on spend',
    rolled.costUsd === built.totals.costUsd && rolled.costUsd === 0.03);
  check('a rollup takes the newest run as the latest', rolled.latest?.id === 'ddd');

  // Unpriced runs must not sum to a confident zero: "we do not know" and "it
  // cost nothing" are different answers, and only one of them is honest.
  const unpriced = rollUp(summaries.filter((summary) => summary.totals === undefined));
  check('a rollup with no priced run reports no spend, not zero',
    unpriced.costUsd === undefined);
  check('a rollup with nothing settled reports no success rate',
    rollUp([summaries[0]]).successRate === undefined);

  // Failures, and proposals that never became a pull request.
  check('a rollup counts what needs attention', rolled.needsAttention === 2);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
