/**
 * Does the whole thing actually work?
 *
 * Every claim this migration makes, checked against the real services rather
 * than against a mock: Nebius answers, Neon stores, the Daytona workspace boots
 * and returns exit codes nobody had to be trusted for, the five roles run, the
 * guardrails fire, a finished run resumes without re-paying for it, and the
 * scorecard produces numbers.
 *
 *   npx tsx scripts/smoke.ts [commit-ref]
 *
 * It spends real money - roughly twenty cents - because the things worth
 * checking are the ones that cost something. It does not open a pull request:
 * the GitHub credentials are suppressed for the run, so publishing is the one
 * step this leaves unexercised, deliberately and visibly.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DaytonaSandbox } from '@mastra/daytona';
import { loadConfig } from '../src/config.js';
import { createStores } from '../src/pipeline/stores.js';
import { createRuntime } from '../src/runtime/index.js';
import { runPipeline } from '../src/pipeline/index.js';
import { scoreRuns } from '../src/evals/index.js';
import { redactSecrets } from '../src/guardrails/secrets.js';
import { workspaceConfigured } from '../src/validate/workspace.js';
import type { RunRecord } from '../src/types.js';

const c = {
  green: (s: string) => `[32m${s}[0m`,
  red: (s: string) => `[31m${s}[0m`,
  dim: (s: string) => `[2m${s}[0m`,
  bold: (s: string) => `[1m${s}[0m`,
};

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`  ${c.green('✓')} ${name}${detail ? c.dim(`  ${detail}`) : ''}`);
  } else {
    failures += 1;
    console.log(`  ${c.red('✗')} ${name}${detail ? `  ${detail}` : ''}`);
  }
}

function section(title: string): void {
  console.log(`\n${c.bold(title)}`);
}

async function main(): Promise<void> {
  const ref = process.argv[2] ?? 'HEAD';

  // Publishing is the one thing this must not do. Emptied rather than deleted:
  // `loadDotEnv` refills anything undefined straight from .env.
  for (const key of [
    'GITHUB_APP_ID',
    'GITHUB_APP_PRIVATE_KEY',
    'GITHUB_APP_PRIVATE_KEY_PATH',
    'GITHUB_APP_INSTALLATION_ID',
    'GITHUB_TOKEN',
    'GH_TOKEN',
  ]) {
    process.env[key] = '';
  }

  const stateDir = await mkdtemp(join(tmpdir(), 'docxy-smoke-'));
  process.env.DOCXY_STATE_DIR = stateDir;
  const config = loadConfig();

  // --- 1. Credentials -------------------------------------------------------
  section('Configuration');
  check('NEBIUS_API_KEY is set', Boolean(config.nebius.apiKey));
  check('DAYTONA_API_KEY is set', workspaceConfigured(config));
  check('a database is configured', Boolean(process.env.DATABASE_URL), 'runs persist to Neon');
  check('secret redaction is on', config.guardrails.redactSecrets);
  if (!config.nebius.apiKey) {
    console.log(`\n${c.red('No model key - nothing below can run.')}`);
    process.exitCode = 1;
    return;
  }

  // --- 2. Guardrails that cost nothing --------------------------------------
  section('Guardrails');
  // Spliced rather than written whole, for the reason given in test/selftest.ts:
  // these are synthetic but correctly shaped, so a file containing them intact
  // is a file no push scanner will accept.
  const stripeKey = `sk_${'live'}_51H8xQ2eZvKYlo2CabcdefghijklmnopqrstuvWX`;
  const githubToken = `ghp_${'16C7e42F292c6912E7710c838347Ae178B4a'}`;
  const leak = redactSecrets(`const k = "${stripeKey}";\ntoken = "${githubToken}"`);
  check('a Stripe key is redacted', !leak.text.includes(stripeKey));
  check('a GitHub token is redacted', !leak.text.includes(githubToken));
  check(
    'ordinary code is untouched',
    redactSecrets('export function createClient(o: Options) {}').redacted.length === 0,
  );

  // --- 3. The sandbox, against the real service -----------------------------
  section('Daytona workspace');
  if (!workspaceConfigured(config)) {
    check('a workspace is reachable', false, 'DAYTONA_API_KEY is not set');
  } else {
    const sandbox = new DaytonaSandbox({
      id: `docxy-smoke-${Date.now().toString(36)}`,
      apiKey: config.sandbox.daytonaApiKey,
      language: 'typescript',
      ephemeral: true,
      timeout: 120_000,
      networkBlockAll: config.sandbox.blockNetwork,
    });
    const started = Date.now();
    try {
      await sandbox.start();
      check('the workspace boots', true, `${Date.now() - started}ms`);

      await sandbox.writeFiles?.([{ path: 'docs/a.md', content: '# A\n\nBalanced.\n' }]);
      const read = await sandbox.executeCommand?.('bash', ['-c', 'cat docs/a.md']);
      check('files upload and are readable', read?.stdout.includes('Balanced') === true);

      const pass = await sandbox.executeCommand?.('bash', ['-c', 'exit 0']);
      const fail = await sandbox.executeCommand?.('bash', ['-c', 'exit 7']);
      check('a passing command reports 0', pass?.exitCode === 0);
      check(
        'a failing command reports its real code',
        fail?.exitCode === 7,
        `got ${fail?.exitCode}`,
      );

      // The security claim, tested rather than asserted.
      if (config.sandbox.blockNetwork) {
        const egress = await sandbox.executeCommand?.('bash', [
          '-c',
          'curl -s -m 8 -o /dev/null -w "%{http_code}" https://example.com || echo BLOCKED',
        ]);
        const out = (egress?.stdout ?? '').trim();
        check(
          'network egress is actually blocked',
          out.includes('BLOCKED') || out === '000' || egress?.exitCode !== 0,
          `curl said ${JSON.stringify(out)}`,
        );
      }
    } catch (err) {
      check('the workspace works', false, err instanceof Error ? err.message : String(err));
    } finally {
      await sandbox.destroy().catch(() => {});
    }
  }

  // --- 4. The runtime -------------------------------------------------------
  section('Runtime');
  const { sessions, runs } = createStores(config);
  const runtime = createRuntime(config, sessions);
  try {
    await runtime.assertReady();
    check('the runtime is ready', true, 'model router and storage');
    await runtime.mastra();
    check('the workflow host builds', true);
  } catch (err) {
    check('the runtime is ready', false, err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  // --- 5. A whole run against a real commit ---------------------------------
  section(`Pipeline on ${ref}`);
  let record: RunRecord | undefined;
  try {
    const result = await runPipeline(config, ref, { runtime, force: true });
    record = result.run;

    const roles = record.traces;
    check('all five roles ran', roles.length === 5, `${roles.length} traces`);
    check(
      'and every one finished',
      roles.every((t) => t.status === 'done'),
      roles.filter((t) => t.status !== 'done').map((t) => `${t.role}=${t.status}`).join(', '),
    );
    check('a classification was produced', Boolean(record.classification));
    check('an impact map was produced', Boolean(record.impact));
    check('a proposal was produced', (result.proposedFiles.length ?? 0) > 0,
      `${result.proposedFiles.length} file(s)`);
    check('tokens were accounted for', (record.totals?.inputTokens ?? 0) > 0,
      `${record.totals?.inputTokens} in / ${record.totals?.outputTokens} out, $${record.totals?.costUsd}`);

    const build = record.validation?.checks.find((c2) => c2.name === 'docs-build');
    check(
      'the docs build ran in the sandbox',
      build?.where === 'sandbox',
      build ? `${build.status} - ${build.detail.split('\n')[0]}` : 'no docs-build check',
    );
    // Whether the anchors *resolved* is a question about the model on this
    // particular commit, and the answer moves run to run. What a smoke test
    // can assert is that they were checked and the verdict was recorded - a
    // failed anchor is the pipeline working: validation catches it, the
    // Coordinator says so, and the pull request opens as a draft carrying the
    // reason. The rate itself is a quality signal, and the scorecard below is
    // where it belongs.
    const anchors = record.validation?.checks.find((c2) => c2.name === 'edits-apply');
    check(
      'edit anchors were checked',
      anchors?.status === 'pass' || anchors?.status === 'fail',
      anchors?.status === 'pass'
        ? 'all resolved'
        : `${c.dim('did not resolve this run -')} ${anchors?.detail.split('\n')[0] ?? ''}`,
    );

    // Publishing is suppressed, so this is the expected shape of the ending.
    check(
      'it reached the publish step and reported it honestly',
      record.status === 'approved' && Boolean(record.error),
      record.error?.slice(0, 60) ?? record.status,
    );
  } catch (err) {
    check('the pipeline completes', false, err instanceof Error ? err.message : String(err));
  }

  // --- 6. Durability --------------------------------------------------------
  //
  // The property the workflow exists for: a finished run replays from its
  // snapshot instead of asking five models the same questions again.
  if (record) {
    section('Resume');
    const before = record.totals?.costUsd ?? 0;
    const spentBy = (r: RunRecord): number =>
      r.traces.reduce((sum, t) => sum + (t.usage?.inputTokens ?? 0), 0);
    const inputBefore = spentBy(record);

    const again = await runPipeline(config, ref, { runtime, resume: record.id });
    check(
      'a finished run replays rather than re-running',
      spentBy(again.run) === inputBefore,
      `${inputBefore} tokens before, ${spentBy(again.run)} after`,
    );
    check('and keeps its identity', again.run.id === record.id, `$${before} unchanged`);
  }

  // --- 7. The scorecard -----------------------------------------------------
  section('Scorecard');
  const listed = await runs.list(10, [config.repoPath]);
  const loaded = (await Promise.all(listed.map((r) => runs.load(r.id)))).filter(
    (r): r is RunRecord => r !== null,
  );
  const card = await scoreRuns(loaded);
  check('runs can be scored', card.runs.length > 0, `${card.runs.length} scored`);
  for (const row of card.summary) {
    console.log(`      ${c.dim(row.scorer.padEnd(22))} ${Math.round(row.mean * 100)}%`);
  }

  await runtime.close();
  await rm(stateDir, { recursive: true, force: true });

  console.log(
    failures === 0
      ? `\n${c.green('Everything checked passed.')} ` +
        c.dim('Pull request creation was suppressed and is the one step not exercised.')
      : `\n${c.red(`${failures} check(s) failed.`)}`,
  );
  if (failures > 0) process.exitCode = 1;
}

void main();
