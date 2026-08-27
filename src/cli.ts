#!/usr/bin/env node
import { loadConfig, prBaseBranch, ROLE_NAMES, type Config } from './config.js';
import { createClient, assertReachable } from './trueforge/client.js';
import { listAvailableModels, listNebiusModels, registerNebiusProvider } from './trueforge/setup.js';
import { runPipeline, rebuildProposedFiles } from './pipeline/index.js';
import { createStores, type RunStorage } from './pipeline/stores.js';
import { closeDb } from './db/index.js';
import { appStatus } from './github/app.js';

/** `serve` returns while the server keeps running, so it must not close the pool. */
let holdOpen = false;
import { ApprovalError, deny, describeGate, signOff } from './approval/gate.js';
import { openPullRequest } from './github/pr.js';
import { startServer } from './server/index.js';
import { isGitRepo, recentCommits } from './git/diff.js';
import { openDocsTree } from './git/worktree.js';
import { ROLES } from './agents/roles.js';

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

function parseFlags(argv: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg.startsWith('--')) {
      const [key, inline] = arg.slice(2).split('=');
      if (inline !== undefined) flags[key!] = inline;
      else if (argv[i + 1] && !argv[i + 1]!.startsWith('--')) {
        flags[key!] = argv[i + 1]!;
        i += 1;
      } else flags[key!] = 'true';
    } else positional.push(arg);
  }
  return { positional, flags };
}

function usage(): void {
  console.log(`
${c.bold('Docxy')} — a multi-agent documentation-and-changelog pipeline.

${c.bold('Usage')}  docxy <command> [options]

${c.bold('Commands')}
  setup                       Register Nebius Token Factory with the TrueForge harness
  doctor                      Check the harness, the provider, and the repository
  models                      List models your Nebius account can serve
  run [commit]                Run the pipeline on a commit (default: HEAD)
  runs                        List recent runs
  show <run-id>               Show one run in detail
  approve <run-id> --by NAME  Sign off; opens the pull request once fully approved
                              --expect-pr  fail if the sign-off did not open a PR
  deny <run-id> --by NAME --reason TEXT
                              Reject the proposal
  serve                       Start the timeline UI and approval server
  reset [--sessions] [--knowledge]
                              Clear accumulated state for this repository
  roles                       Describe the agent roster

${c.bold('Options')}
  --repo PATH                 Repository to document (default: cwd)
  --docs-branch BRANCH        Branch docs live on and PRs target (default: the checkout)
  --json                      Machine-readable output where supported
`);
}

function summarizeRun(run: Awaited<ReturnType<RunStorage['load']>>, config: Config): void {
  if (!run) return;
  console.log(`\n${c.bold(run.commit.shortSha)} ${run.commit.subject}`);
  console.log(`${c.dim('run')} ${run.id}`);
  console.log(`${c.dim('status')} ${run.status}`);

  for (const role of ROLES) {
    const trace = run.traces.find((t) => t.role === role.name);
    const mark = !trace
      ? c.dim('·')
      : trace.status === 'done'
        ? c.green('✓')
        : trace.status === 'failed'
          ? c.red('✗')
          : c.yellow('…');
    const reuse = trace?.reusedSession ? c.cyan(' (session reused)') : '';
    console.log(`  ${mark} ${role.title}${reuse}`);
    if (trace?.error) console.log(`      ${c.red(trace.error)}`);
  }

  if (run.classification) {
    const cl = run.classification;
    console.log(
      `\n${c.dim('classification')} ${cl.kind} / ${cl.surface} (${Math.round(cl.confidence * 100)}%)`,
    );
    console.log(`  ${cl.summary}`);
  }
  if (run.impact) {
    console.log(`\n${c.dim('impacted docs')} ${run.impact.docs.length}`);
    for (const d of run.impact.docs) console.log(`  ${d.path} § ${d.section}`);
  }
  if (run.changelog) {
    console.log(`\n${c.dim('changelog')} [${run.changelog.section}] ${run.changelog.entry}`);
    console.log(`  bump: ${run.changelog.semverBump} — ${run.changelog.bumpRationale}`);
  }
  if (run.validation) {
    console.log(`\n${c.dim('validation')}`);
    for (const check of run.validation.checks) {
      const mark =
        check.status === 'pass' ? c.green('✓') : check.status === 'fail' ? c.red('✗') : c.dim('·');
      console.log(`  ${mark} ${check.name} ${c.dim(check.detail.split('\n')[0] ?? '')}`);
    }
  }
  console.log(
    `\n${c.dim('memory')} ${run.priorSymbolCount} symbol(s) carried in, ` +
      `${run.newSymbolCount} new mapping(s) learned`,
  );
  if (run.approval) console.log(`${c.dim('gate')} ${describeGate(run, config)}`);
  if (run.pullRequestUrl) console.log(`${c.dim('pull request')} ${run.pullRequestUrl}`);
  if (run.error) console.log(`\n${c.red(run.error)}`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const { positional, flags } = parseFlags(argv.slice(1));

  if (!command || command === 'help' || flags.help) {
    usage();
    return;
  }

  const config = loadConfig(flags.repo ? { repoPath: flags.repo } : {});
  if (flags['docs-branch']) config.docs.branch = flags['docs-branch'];

  switch (command) {
    case 'roles': {
      console.log(`\n${c.bold('Agent roster')}\n`);
      for (const role of ROLES) {
        console.log(`  ${c.bold(role.title.padEnd(20))} ${role.job}`);
        console.log(
          `  ${''.padEnd(20)} ${c.dim(`model ${config.models[role.name]}${role.skillPack ? `, skill pack ${role.skillPack}` : ''}`)}`,
        );
      }
      console.log(
        `\n${c.dim('Each role holds its own long-lived session per repository, so what it')}`,
      );
      console.log(`${c.dim('learns on one commit is still there for the next.')}\n`);
      return;
    }

    case 'setup': {
      const client = createClient(config);
      await assertReachable(client, config);
      const result = await registerNebiusProvider(client, config);
      console.log(`${c.green('✓')} Nebius provider ${result.action}: ${result.providerName}`);
      for (const model of result.models) console.log(`  ${model}`);
      console.log(`\n${c.dim('Verifying the harness resolves them...')}`);
      const available = await listAvailableModels(client);
      const missing = result.models.filter((m) => !available.includes(m));
      if (missing.length > 0) {
        console.log(`${c.yellow('!')} Not yet resolvable: ${missing.join(', ')}`);
        console.log(`  ${c.dim('Run `docxy models` to see what your account can serve.')}`);
      } else {
        console.log(`${c.green('✓')} All registered models resolve.`);
      }
      return;
    }

    case 'doctor': {
      console.log(`${c.bold('Repository')}  ${config.repoPath}`);
      console.log(
        (await isGitRepo(config.repoPath))
          ? `${c.green('✓')} is a git repository`
          : `${c.red('✗')} not a git repository`,
      );
      console.log(
        config.nebius.apiKey
          ? `${c.green('✓')} NEBIUS_API_KEY is set`
          : `${c.red('✗')} NEBIUS_API_KEY is missing`,
      );
      const client = createClient(config);
      try {
        await assertReachable(client, config);
        console.log(`${c.green('✓')} harness reachable at ${config.trueforge.baseUrl}`);
        const available = await listAvailableModels(client);
        for (const role of ROLE_NAMES) {
          const wanted = config.models[role];
          console.log(
            available.includes(wanted)
              ? `${c.green('✓')} ${role.padEnd(18)} ${wanted}`
              : `${c.red('✗')} ${role.padEnd(18)} ${wanted} ${c.dim('(not registered — run `docxy setup`)')}`,
          );
        }
      } catch (err) {
        console.log(`${c.red('✗')} ${err instanceof Error ? err.message : String(err)}`);
      }
      const github = appStatus();
      console.log(
        github.configured
          ? `${c.green('✓')} GitHub App ${github.slug} — pull requests open as ${c.bold(`${github.slug}[bot]`)}`
          : `${c.red('✗')} GitHub App not configured — pull requests cannot be opened\n` +
            `  ${c.dim(`missing: ${github.missing.join(', ')}`)}\n` +
            `  ${c.dim('see guides/GITHUB-APP.md')}`,
      );
      console.log(
        github.webhookSecretSet
          ? `${c.green('✓')} webhook secret set — pushes can trigger runs`
          : `${c.yellow('!')} no GITHUB_WEBHOOK_SECRET — /webhook refuses deliveries`,
      );

      console.log(`\n${c.bold('Docs')}`);
      if (!config.docs.branch) {
        console.log(
          `${c.dim('·')} docs live in the code checkout; pull requests target ${prBaseBranch(config)}`,
        );
      } else {
        try {
          const tree = await openDocsTree(config);
          console.log(
            `${c.green('✓')} docs branch ${config.docs.branch} at ${tree.head?.slice(0, 7)}`,
          );
          await tree.dispose();
          console.log(`${c.dim('·')} pull requests target ${prBaseBranch(config)}`);
        } catch (err) {
          console.log(`${c.red('✗')} ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return;
    }

    case 'models': {
      const ids = await listNebiusModels(config);
      if (flags.json) {
        console.log(JSON.stringify(ids, null, 2));
        return;
      }
      console.log(`${c.bold(`${ids.length} model(s) available on your Nebius account`)}\n`);
      for (const id of ids) console.log(`  ${id}`);
      console.log(
        `\n${c.dim('Set NEBIUS_MODEL_KIMI / _DEEPSEEK / _QWEN in .env to point the roster at these,')}`,
      );
      console.log(`${c.dim('then re-run `docxy setup`.')}`);
      return;
    }

    case 'run': {
      const client = createClient(config);
      await assertReachable(client, config);
      const ref = positional[0] ?? 'HEAD';

      console.log(`${c.dim('Running the pipeline on')} ${ref}\n`);
      const { run } = await runPipeline(client, config, ref, {
        onRoleEvent: (role, event) => {
          if (event.kind === 'session' || event.kind === 'subagent' || event.kind === 'approval') {
            console.log(`  ${c.dim(role.padEnd(18))} ${event.text}`);
          }
        },
      });

      summarizeRun(run, config);

      if (run.status === 'awaiting-approval') {
        console.log(`\n${c.yellow('▌')} ${c.bold('Waiting for human approval.')}`);
        console.log(`  ${run.approval!.scopeRationale}`);
        console.log(
          `\n  ${c.bold('Approve:')} docxy approve ${run.id} --by "your name"`,
        );
        console.log(`  ${c.bold('Deny:   ')} docxy deny ${run.id} --by "your name" --reason "..."`);
        console.log(`  ${c.bold('Review: ')} docxy serve  ${c.dim('(then open the timeline)')}`);
        console.log(
          `\n  ${c.dim('Nothing opens a pull request until you say so. This request will not')}`,
        );
        console.log(`  ${c.dim('expire, auto-approve, or auto-discard.')}`);
      }
      return;
    }

    case 'runs': {
      const store = createStores(config).runs;
      const list = await store.list(20);
      if (flags.json) {
        console.log(JSON.stringify(list, null, 2));
        return;
      }
      if (list.length === 0) {
        console.log('No runs yet. Try `docxy run`.');
        return;
      }
      for (const run of list) {
        const status =
          run.status === 'done'
            ? c.green(run.status)
            : run.status === 'failed' || run.status === 'denied'
              ? c.red(run.status)
              : c.yellow(run.status);
        console.log(
          `${c.dim(run.id.slice(0, 8))}  ${run.commit.shortSha}  ${status.padEnd(28)} ${run.commit.subject}`,
        );
      }
      return;
    }

    case 'show': {
      const id = positional[0];
      if (!id) throw new Error('Usage: docxy show <run-id>');
      const store = createStores(config).runs;
      const run = (await store.load(id)) ?? (await store.list(200)).find((r) => r.id.startsWith(id));
      if (!run) throw new Error(`No run found matching "${id}".`);
      if (flags.json) {
        console.log(JSON.stringify(run, null, 2));
        return;
      }
      summarizeRun(run, config);
      return;
    }

    case 'approve': {
      const id = positional[0];
      const by = flags.by;
      if (!id || !by) throw new Error('Usage: docxy approve <run-id> --by "your name"');

      const store = createStores(config).runs;
      const run = (await store.load(id)) ?? (await store.list(200)).find((r) => r.id.startsWith(id));
      if (!run?.approval) throw new Error(`No pending approval found for "${id}".`);

      const { approved } = signOff(run.approval, by);
      run.status = approved ? 'approved' : 'awaiting-approval';
      await store.save(run);

      if (!approved) {
        const remaining = run.approval.requiredSignoffs - run.approval.signoffs.length;
        if (flags['expect-pr']) {
          // Automation asked for a pull request. A partial sign-off is a correct
          // outcome but not the requested one, so it must not exit green.
          throw new Error(
            `Sign-off recorded, but this ${run.approval.scope} request still needs ` +
              `${remaining} more from a different reviewer, so no pull request was opened.\n` +
              `Record the remaining sign-off with:\n` +
              `  docxy approve ${run.id} --by "a second reviewer"`,
          );
        }
        console.log(
          `${c.green('✓')} Sign-off recorded. This ${run.approval.scope} request needs ${remaining} more, from a different reviewer.`,
        );
        return;
      }

      console.log(`${c.green('✓')} Fully approved. Opening the pull request...`);
      const files = await rebuildProposedFiles(config, run);
      try {
        const pr = await openPullRequest(config, run, files);
        run.pullRequestUrl = pr.url;
        run.status = 'done';
        run.finishedAt = new Date().toISOString();
        await store.save(run);
        console.log(`${c.green('✓')} ${pr.url}`);
      } catch (err) {
        // The sign-offs stand; only the publish step failed. Record it so the
        // run does not look silently finished.
        run.error = err instanceof Error ? err.message : String(err);
        await store.save(run);
        throw err;
      }
      return;
    }

    case 'deny': {
      const id = positional[0];
      const by = flags.by;
      const reason = flags.reason;
      if (!id || !by || !reason) {
        throw new Error('Usage: docxy deny <run-id> --by "your name" --reason "why"');
      }
      const store = createStores(config).runs;
      const run = (await store.load(id)) ?? (await store.list(200)).find((r) => r.id.startsWith(id));
      if (!run?.approval) throw new Error(`No pending approval found for "${id}".`);
      deny(run.approval, by, reason);
      run.status = 'denied';
      run.finishedAt = new Date().toISOString();
      await store.save(run);
      console.log(`${c.green('✓')} Denied. Nothing was opened.`);
      return;
    }

    case 'serve': {
      holdOpen = true;
      const client = createClient(config);
      await assertReachable(client, config);
      const handle = startServer(client, config);
      console.log(`${c.bold('Docxy')} is on http://localhost:${handle.port}`);
      console.log(`${c.dim('repository')} ${config.repoPath}`);
      console.log(`${c.dim('harness')}    ${config.trueforge.baseUrl}`);
      return;
    }

    case 'reset': {
      const all = !flags.sessions && !flags.knowledge;
      if (all || flags.sessions) {
        await createStores(config).sessions.clear();
        console.log(`${c.green('✓')} cleared agent sessions for this repository`);
      }
      if (all || flags.knowledge) {
        await createStores(config).knowledge.reset();
        console.log(`${c.green('✓')} cleared the symbol map for this repository`);
      }
      return;
    }

    case 'log': {
      const commits = await recentCommits(config.repoPath, Number(flags.n ?? 10));
      for (const commit of commits) {
        console.log(`${c.dim(commit.sha.slice(0, 7))} ${commit.subject}`);
      }
      return;
    }

    default:
      console.error(`Unknown command: ${command}`);
      usage();
      process.exitCode = 1;
  }
}

main()
  .catch((err: unknown) => {
    if (err instanceof ApprovalError) {
      console.error(`\n${c.red('✗')} ${err.message}`);
    } else {
      console.error(`\n${c.red('✗')} ${err instanceof Error ? err.message : String(err)}`);
    }
    process.exitCode = 1;
  })
  // Every command but `serve` would otherwise hang on an open Neon pool
  // instead of exiting.
  .finally(() => (holdOpen ? undefined : closeDb()));
