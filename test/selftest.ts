import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractJson, normalizeConfidence } from '../src/agents/parse.js';
import { applyDocEdits, applyChangelogEntry } from '../src/pipeline/apply.js';
import { checkLinks } from '../src/validate/links.js';
import { decideScope, createApprovalRequest, signOff, deny, ApprovalError } from '../src/approval/gate.js';
import { openDocsTree, resolveBaseRef } from '../src/git/worktree.js';
import { listDocs, readRepoFile } from '../src/git/repo.js';
import { loadConfig, prBaseBranch } from '../src/config.js';
import type { Config } from '../src/config.js';
import { RunStore } from '../src/pipeline/store.js';
import { costOf, priceFor } from '../src/trueforge/pricing.js';
import { classifyTurnError } from '../src/trueforge/run.js';
import { renderDiffForPrompt } from '../src/git/diff.js';
import { nextPage } from '../src/github/checkout.js';
import type { CommitDiff, DiffFile } from '../src/types.js';
import { planRetry } from '../src/pipeline/retry.js';
import type { RoleName } from '../src/config.js';
import type { DocEdit, RoleTrace, RunRecord } from '../src/types.js';
import { buildReport } from '../src/server/observability.js';
import { isCommitSha, isLoopbackHost, repoAllowed, tokenMatches } from '../src/server/index.js';
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
  // drops twenty thousand files would otherwise pay a line for every one —
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
// A heading with punctuation between two spaces — em dashes are everywhere in
// this project's own headings — must slug to the double hyphen GitHub produces.
{
  const doc = [{
    path: 'g.md', before: '', appliedEdits: 0,
    after: '# Guide\n\n[go](#stage-1--the-pipeline)\n[bad](#stage-1-the-pipeline)\n\n## Stage 1 — the pipeline\n\nx\n',
  }];
  const anchors = checkLinks(repo, doc);
  check('an em-dash heading keeps both hyphens',
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
const breaking = { kind: 'breaking', surface: 'public-api', summary: '', changedSymbols: [],
  breakingRationale: '', confidence: 0.9 } as any;
const chore = { kind: 'chore', surface: 'internal', summary: '', changedSymbols: [],
  breakingRationale: '', confidence: 0.9 } as any;
check('breaking is elevated', decideScope(breaking, { semverBump: 'major' } as any, 'routine').scope === 'elevated');
check('chore is routine', decideScope(chore, { semverBump: 'none' } as any, 'routine').scope === 'routine');
check('coordinator can escalate', decideScope(chore, { semverBump: 'none' } as any, 'elevated').scope === 'elevated');

const req = createApprovalRequest('run1', 'elevated', 'because', 'summary');
check('elevated needs two', req.requiredSignoffs === 2);
check('first signoff not enough', signOff(req, 'alice').approved === false);
try { signOff(req, 'alice'); check('same reviewer rejected', false); }
catch (e) { check('same reviewer rejected', e instanceof ApprovalError); }
check('second reviewer approves', signOff(req, 'bob').approved === true);

const req2 = createApprovalRequest('run2', 'routine', 'r', 's');
deny(req2, 'carol', 'wrong');
check('deny sets status', req2.status === 'denied');
try { signOff(req2, 'dave'); check('cannot approve denied', false); }
catch (e) { check('cannot approve denied', e instanceof ApprovalError); }

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

// An empty history must not divide by zero or invent a rate.
const empty = buildReport([]);
check('empty history has no rates',
  empty.window.runs === 0 && empty.successRate === undefined &&
  empty.totals.costUsd === undefined && empty.roles.length === 0);

// --- run scoping ---------------------------------------------------------
// A run id is printed in every dashboard URL, so naming one in a query must
// narrow the listing rather than reach past the repository filter.
{
  const dir = await mkdtemp(join(tmpdir(), 'docxy-runs-'));
  const store = new RunStore({ stateDir: dir } as Config);

  const runIn = (id: string, repoPath: string): RunRecord => ({
    id,
    repoPath,
    commit: { sha: `${id}0000`, shortSha: id.slice(0, 7), subject: 's' },
    startedAt: '2026-08-01T00:00:00.000Z',
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

  await rm(dir, { recursive: true, force: true });
}

// --- the retired approval variable ---------------------------------------
// DOCXY_APPROVAL_MODE stopped being read. A deployment that had asked for a
// gate with it must not silently lose one, and the new name must still win.
{
  const before = { ...process.env };
  const reload = () => loadConfig().approval.required;

  delete process.env.DOCXY_REQUIRE_APPROVAL;
  delete process.env.DOCXY_APPROVAL_MODE;
  check('no approval setting means no gate', reload() === false);

  process.env.DOCXY_APPROVAL_MODE = 'always';
  check('a retired "always" still gates', reload() === true);

  process.env.DOCXY_APPROVAL_MODE = 'elevated';
  check('a retired "elevated" still gates', reload() === true);

  process.env.DOCXY_APPROVAL_MODE = 'auto';
  check('a retired "auto" asked for no gate and gets none', reload() === false);

  process.env.DOCXY_APPROVAL_MODE = 'always';
  process.env.DOCXY_REQUIRE_APPROVAL = 'false';
  check('the current name wins over the retired one', reload() === false);

  process.env = before;
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
  const allowed = ['arindam200/docxy', 'arindam200/other'];
  check('a listed repository is accepted', repoAllowed(allowed, 'Arindam200/docxy'));
  check('an unlisted repository is refused', repoAllowed(allowed, 'someone/else') === false);
  check('an empty allowlist keeps multi-repo behaviour', repoAllowed([], 'anyone/anything'));

  const sha = '0'.repeat(40);
  check('a full object name is a commit', isCommitSha(sha));
  check('a short sha is not', isCommitSha('0123abc') === false);
  check('a branch name is not', isCommitSha('HEAD') === false);
  check('an argument-looking value is not', isCommitSha('--upload-pack=touch /tmp/x') === false);
}

// --- the API token and repository allowlist read from the environment -----
{
  const before = { ...process.env };

  delete process.env.DOCXY_API_TOKEN;
  delete process.env.DOCXY_ALLOWED_REPOS;
  check('no token configured leaves the API open to the proxy',
    loadConfig().server.apiToken === undefined);
  check('no allowlist configured means every repository', loadConfig().server.allowedRepos.length === 0);

  process.env.DOCXY_API_TOKEN = 'shhh';
  check('a configured token is read', loadConfig().server.apiToken === 'shhh');

  // Both dashboard callers trim before sending. If this side kept the padding,
  // the token would be "set" here and a different string there — every request
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
