import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractJson, normalizeConfidence } from '../src/agents/parse.js';
import { applyDocEdits, applyChangelogEntry } from '../src/pipeline/apply.js';
import { checkLinks } from '../src/validate/links.js';
import { decideScope, createApprovalRequest, signOff, deny, ApprovalError, requiresSignoff } from '../src/approval/gate.js';
import { openDocsTree, resolveBaseRef } from '../src/git/worktree.js';
import { listDocs, readRepoFile } from '../src/git/repo.js';
import { prBaseBranch } from '../src/config.js';
import type { Classification, ChangelogProposal } from '../src/types.js';
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
const breaking: Classification = { kind: 'breaking', surface: 'public-api', summary: '', changedSymbols: [],
  breakingRationale: '', confidence: 0.9 };
const chore: Classification = { kind: 'chore', surface: 'internal', summary: '', changedSymbols: [],
  breakingRationale: '', confidence: 0.9 };
const majorBump: ChangelogProposal = { entry: '', section: 'Changed', semverBump: 'major', bumpRationale: '' };
const noneBump: ChangelogProposal = { entry: '', section: 'Fixed', semverBump: 'none', bumpRationale: '' };
check('breaking is elevated', decideScope(breaking, majorBump, 'routine').scope === 'elevated');
check('chore is routine', decideScope(chore, noneBump, 'routine').scope === 'routine');
check('coordinator can escalate', decideScope(chore, noneBump, 'elevated').scope === 'elevated');

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

// --- approval modes -------------------------------------------------------
// Opening a pull request is a review request, not a merge, so the default adds
// no gate in front of the gate GitHub already provides.
check('auto never gates routine', requiresSignoff('auto', 'routine') === false);
check('auto never gates elevated', requiresSignoff('auto', 'elevated') === false);
check('elevated mode lets routine through', requiresSignoff('elevated', 'routine') === false);
check('elevated mode gates elevated', requiresSignoff('elevated', 'elevated') === true);
check('always gates routine', requiresSignoff('always', 'routine') === true);
check('always gates elevated', requiresSignoff('always', 'elevated') === true);

// Scope is still computed under auto, so the PR body can explain the change.
const autoScope = decideScope(breaking, { semverBump: 'major' } as any, 'routine');
check('scope still computed when ungated', autoScope.scope === 'elevated');

await rm(codeRepo, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
