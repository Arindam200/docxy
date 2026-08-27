#!/usr/bin/env node
import { loadConfig, prBaseBranch, ROLE_NAMES, type Config } from './config.js';
import { createClient, assertReachable } from './trueforge/client.js';
import { listAvailableModels, listNebiusModels, registerNebiusProvider, registerSandboxProvider } from './trueforge/setup.js';
import { sandboxAvailability } from './validate/sandbox.js';
import { runPipeline, rebuildProposedFiles } from './pipeline/index.js';
import { createStores, type RunStorage } from './pipeline/stores.js';
import type { RunRecord } from './types.js';
import { closeDb } from './db/index.js';
import { appStatus } from './github/app.js';

/** `serve` returns while the server keeps running, so it must not close the pool. */
let holdOpen = false;

/**
 * A run by id or by a unique prefix of one, always as a full record.
 *
 * The listing is only ever used to turn a prefix into an id — never as the
 * record itself. A run taken from a listing carries no `proposedFiles`, since
 * listings deliberately skip the file bodies, and publishing one would silently
 * re-derive the edits against a docs tree that may have moved since the
 * reviewer looked at them.
 */
async function loadRunByPrefix(
  store: RunStorage,
  id: string,
  config: Config,
): Promise<RunRecord | null> {
  const direct = await store.load(id);
  if (direct) return direct;

  // Widened to every synced repository, not just this directory. A webhook run
  // belongs to the checkout docxy manages, so scoping the search to wherever
  // the command was typed made exactly the runs the dashboard shows the ones it
  // could not find.
  const scope = await syncedRepoPaths(config.repoPath);
  const match = (await store.list(200, scope)).find((run) => run.id.startsWith(id));
  return match ? store.load(match.id) : null;
}
import { ApprovalError, deny, describeGate, signOff } from './approval/gate.js';
import { openPullRequest } from './github/pr.js';
import { startServer } from './server/index.js';
import { isGitRepo, recentCommits } from './git/diff.js';
import { openDocsTree } from './git/worktree.js';
import { ROLES } from './agents/roles.js';
import { readAppCredentials } from './github/app.js';
import { installationRepositories, ensureCheckout, syncedRepoPaths } from './github/checkout.js';

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
                              --force re-runs a commit already documented
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

      const sandbox = await registerSandboxProvider(client, config);
      if (sandbox.action === 'registered') {
        console.log(`${c.green('✓')} Daytona sandbox provider registered`);
      } else {
        console.log(`${c.yellow('!')} No remote sandbox provider: ${sandbox.reason}`);
      }

      // What matters is whether a sandbox exists, not whose it is. A standalone
      // harness carries its own, so "Daytona was refused" and "nothing will be
      // isolated" are very different sentences and setup should not conflate them.
      const ready = await sandboxAvailability(client);
      console.log(
        ready.available
          ? `${c.green('✓')} Sandbox ready (${ready.backend}) — the docs build runs there`
          : `${c.yellow('!')} ${ready.reason}\n` +
            `  ${c.dim('the docs build still runs, locally, and the report says so')}`,
      );
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
      console.log(`\n${c.bold('Validation')}`);
      if (!config.sandbox.enabled) {
        console.log(
          `${c.yellow('!')} DOCXY_SANDBOX is off — the docs build runs on this machine, ` +
            `over text a model wrote`,
        );
      } else {
        const sandbox = await sandboxAvailability(client);
        console.log(
          sandbox.available
            ? `${c.green('✓')} sandbox ready (${sandbox.backend}) — the docs build runs there, ` +
              `not against your checkout`
            : `${c.yellow('!')} ${sandbox.reason}\n` +
              `  ${c.dim('the docs build still runs, locally, and the report says so')}`,
        );
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
      const { run, skipped } = await runPipeline(client, config, ref, {
        force: Boolean(flags.force),
        onRoleEvent: (role, event) => {
          if (event.kind === 'session' || event.kind === 'subagent' || event.kind === 'approval') {
            console.log(`  ${c.dim(role.padEnd(18))} ${event.text}`);
          }
        },
      });

      if (skipped) {
        console.log(`${c.yellow('▌')} ${skipped.reason}`);
        if (skipped.pullRequestUrl) console.log(`  ${skipped.pullRequestUrl}`);
        console.log(`\n  ${c.dim(`Run it again anyway with:  docxy run ${ref} --force`)}`);
        return;
      }

      summarizeRun(run, config);

      if (run.degraded && run.degraded.length > 0) {
        console.log(`\n${c.yellow('▌')} ${c.bold('Some agents did not finish.')}`);
        for (const item of run.degraded) {
          console.log(`  ${c.dim(item.role.padEnd(18))} ${item.reason}`);
        }
        console.log(`  ${c.dim('The proposal went ahead with what the others produced.')}`);
      }

      if (run.pullRequestUrl) {
        console.log(`\n${c.green('▌')} ${c.bold('Pull request opened.')}`);
        console.log(`  ${run.pullRequestUrl}`);
        if (run.error) console.log(`  ${c.yellow('Opened as a draft:')} ${run.error}`);
      } else if (run.status === 'awaiting-approval') {
        console.log(`\n${c.yellow('▌')} ${c.bold('Waiting for human approval.')}`);
        console.log(`  ${run.approval!.scopeRationale}`);
        console.log(
          `\n  ${c.bold('Approve:')} docxy approve ${run.id} --by "your name"`,
        );
        console.log(`  ${c.bold('Deny:   ')} docxy deny ${run.id} --by "your name" --reason "..."`);
        console.log(`  ${c.bold('Review: ')} docxy serve  ${c.dim('(then open the timeline)')}`);
        console.log(
          `\n  ${c.dim('DOCXY_REQUIRE_APPROVAL is on, so nothing opens a pull request until')}`,
        );
        console.log(`  ${c.dim('you say so. This request will not expire or auto-discard.')}`);
      } else if (run.status === 'approved' && run.error) {
        // Approved but unpublished: the proposal is sound and the push failed.
        console.log(`\n${c.red('▌')} ${c.bold('The proposal is ready but was not published.')}`);
        console.log(`  ${run.error}`);
        console.log(`\n  ${c.dim(`Retry publishing with:  docxy approve ${run.id} --by "your name"`)}`);
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
      const run = await loadRunByPrefix(store, id, config);
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
        // The pipeline's own judgement, replayed. A proposal the Coordinator
        // rejected or validation failed stays a draft that says why, however
        // many days sat between the run and this sign-off.
        const pr = await openPullRequest(config, run, files, run.publication);
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
      const run = await loadRunByPrefix(store, id, config);
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

      // The same net the deployed entry point casts. `serve` runs for hours
      // with a pipeline attached, and a rejection escaping some background
      // corner of a driver is not a reason to lose the run in flight and every
      // connected event stream. Logged loudly, and the process stays up.
      process.on('unhandledRejection', (reason) => {
        console.error(
          `${c.red('unhandled rejection:')} ${
            reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)
          }`,
        );
      });

      // Resolve the repository *before* the server starts, not per request.
      // Runs, sessions, logs, and the symbol map all key on `repoPath`, so a
      // config that changed per webhook would file a run under one project and
      // list it under another — the dashboard would show nothing while the
      // pipeline worked perfectly.
      let serveConfig = config;
      let pinned = true;
      if (!process.env.DOCXY_REPO_PATH?.trim()) {
        const credentials = readAppCredentials();
        const repos = credentials ? await installationRepositories(credentials) : [];
        if (repos[0]) {
          pinned = false;
          serveConfig = {
            ...config,
            repoPath: await ensureCheckout(repos[0].fullName, repos[0].defaultBranch),
          };
        }
      }

      const client = createClient(serveConfig);
      await assertReachable(client, serveConfig);
      const handle = startServer(client, serveConfig);
      console.log(`${c.bold('Docxy')} is on http://localhost:${handle.port}`);
      console.log(`${c.dim('harness')}    ${serveConfig.trueforge.baseUrl}`);

      // Which repository a push will actually document. Without this the only
      // way to find out is to push and see, and the answer differs depending on
      // whether DOCXY_REPO_PATH is set — the exact thing worth being explicit
      // about at boot.
      console.log(
        `${c.dim('repository')} ${serveConfig.repoPath}` +
          (pinned ? ` ${c.dim('(pinned by DOCXY_REPO_PATH)')}` : ` ${c.dim('(from the App installation)')}`),
      );
      if (pinned && !process.env.DOCXY_REPO_PATH?.trim()) {
        console.log(
          `${c.red('!')} the GitHub App is not configured, or is installed on no repositories — ` +
            `pushes will not be documented`,
        );
      }
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
