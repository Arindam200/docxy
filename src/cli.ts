#!/usr/bin/env node
import { loadConfig, mastraModelFor, prBaseBranch, ROLE_NAMES, type Config } from './config.js';
import { createRuntime } from './runtime/index.js';
import { emptyProjectMemory, renderProjectMemory } from './pipeline/project-memory.js';
import { listNebiusModels } from './nebius.js';
import { workspaceConfigured } from './validate/workspace.js';
import { LocalSandbox } from '@mastra/core/workspace';
import { runPipeline, rebuildProposedFiles } from './pipeline/index.js';
import { createStores, type RunStorage } from './pipeline/stores.js';
import { scoreRuns } from './evals/index.js';
import type { RunRecord } from './types.js';
import { closeDb } from './db/index.js';
import { appStatus } from './github/app.js';

/** `serve` returns while the server keeps running, so it must not close the pool. */
let holdOpen = false;

/**
 * A run by id or by a unique prefix of one, always as a full record.
 *
 * The listing is only ever used to turn a prefix into an id - never as the
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
import { describeGate } from './approval/gate.js';
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

/** A parsed argv: the bare words, and the `--name=value` pairs. */
interface ParsedArgs {
  positional: string[];
  flags: Record<string, string>;
}

function parseFlags(argv: string[]): ParsedArgs {
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
${c.bold('Docxy')} - a multi-agent documentation-and-changelog pipeline.

${c.bold('Usage')}  docxy <command> [options]

${c.bold('Commands')}
  doctor                      Check the harness, the provider, and the repository
  models                      List models your Nebius account can serve
  run [commit]                Run the pipeline on a commit (default: HEAD)
                              --force re-runs a commit already documented
  runs                        List recent runs
  show <run-id>               Show one run in detail
  publish <run-id>            Open the pull request for a run whose proposal is ready
  serve                       Start the timeline UI and approval server
  memory                      Show what earlier runs learned about this repository
                              --prompt [role]  the exact text a role is given
  reset [--sessions] [--knowledge] [--memory]
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
    console.log(`  bump: ${run.changelog.semverBump} - ${run.changelog.bumpRationale}`);
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
      // Kept only to answer people following older docs. There is nothing to
      // register any more: the model router reads NEBIUS_API_KEY and the
      // workspace reads DAYTONA_API_KEY, both straight from the environment.
      console.log(
        `${c.yellow('!')} \`docxy setup\` is gone. It registered models and a sandbox with the
` +
          `  separate harness service, which no longer exists - the agents run in this
` +
          `  and the docs build runs in a Daytona workspace.\n\n` +
          `  Put NEBIUS_API_KEY and DAYTONA_API_KEY in .env, then run \`docxy doctor\`.`,
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
      for (const role of ROLE_NAMES) {
        console.log(`${c.green('✓')} ${role.padEnd(18)} ${mastraModelFor(config, role)}`);
      }
      console.log(
        `  ${c.dim('Model ids are resolved by Mastra\'s router; `docxy models` lists what')}\n` +
          `  ${c.dim('your Nebius account can actually serve.')}`,
      );

      console.log(`\n${c.bold('Validation')}`);
      if (!config.sandbox.enabled) {
        console.log(
          `${c.yellow('!')} DOCXY_SANDBOX is off - the docs build runs on this machine, ` +
            `over text a model wrote`,
        );
      } else {
        console.log(
          workspaceConfigured(config)
            ? `${c.green('✓')} Daytona workspace configured - the docs build runs there, ` +
              `not against your checkout` +
              (config.sandbox.blockNetwork ? `\n  ${c.dim('network egress is blocked inside it')}` : '')
            : `${c.yellow('!')} DAYTONA_API_KEY is not set, so there is no workspace\n` +
              `  ${c.dim(
                config.sandbox.fallback === 'local'
                  ? 'DOCXY_SANDBOX_FALLBACK=local - the docs build will run on this machine'
                  : 'the docs build will be reported unvalidated rather than run here',
              )}`,
        );
      }

      console.log(`\n${c.bold('Drafting')}`);
      if (!config.agent.codeMode) {
        console.log(
          `${c.dim('·')} code mode is off - the Docs Updater quotes anchors from its prompt\n` +
            `  ${c.dim('DOCXY_CODE_MODE=true has it write a program that finds them instead')}`,
        );
      } else if (config.agent.codeModeSandbox === 'local') {
        console.log(
          `${c.yellow('!')} code mode runs its program on this machine ` +
            `(DOCXY_CODE_MODE_SANDBOX=local)\n` +
            `  ${c.dim(
              LocalSandbox.detectIsolation().available
                ? 'isolated by the platform, but this is a development setting - a deployment ' +
                  'should use a Daytona workspace'
                : 'and this machine offers no isolation, so drafting will refuse to run',
            )}`,
        );
      } else {
        console.log(
          workspaceConfigured(config)
            ? `${c.green('✓')} code mode runs its program in a Daytona workspace\n` +
              `  ${c.dim('no host filesystem' + (config.sandbox.blockNetwork ? ', network egress blocked' : ''))}`
            : `${c.red('✗')} code mode is on but DAYTONA_API_KEY is not set - every run will ` +
              `fail at drafting\n  ${c.dim('set the key, or DOCXY_CODE_MODE_SANDBOX=local for development')}`,
        );
      }

      console.log(`\n${c.bold('Guardrails')}`);
      console.log(
        config.guardrails.redactSecrets
          ? `${c.green('✓')} secret redaction on - credential shapes are removed before a model sees them`
          : `${c.yellow('!')} DOCXY_REDACT_SECRETS is off - a committed key in a diff would reach the model`,
      );
      console.log(
        config.guardrails.detectPromptInjection
          ? `${c.green('✓')} prompt-injection detection on (${config.guardrails.injectionModel})\n` +
            `  ${c.dim('it fails open: if that model errors, the diff is allowed through')}`
          : `${c.yellow('!')} prompt-injection detection off - a diff can address the agents directly\n` +
            `  ${c.dim('set DOCXY_DETECT_PROMPT_INJECTION=true for repositories that take outside PRs')}`,
      );

      const github = appStatus();
      console.log(
        github.configured
          ? `${c.green('✓')} GitHub App ${github.slug} - pull requests open as ${c.bold(`${github.slug}[bot]`)}`
          : `${c.red('✗')} GitHub App not configured - pull requests cannot be opened\n` +
            `  ${c.dim(`missing: ${github.missing.join(', ')}`)}\n` +
            `  ${c.dim('see guides/GITHUB-APP.md')}`,
      );
      console.log(
        github.webhookSecretSet
          ? `${c.green('✓')} webhook secret set - pushes can trigger runs`
          : `${c.yellow('!')} no GITHUB_WEBHOOK_SECRET - /webhook refuses deliveries`,
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
        `\n${c.dim('Point a role at one with DOCXY_MODEL_<ROLE> in .env; the id goes in verbatim.')}`,
      );
      return;
    }

    case 'eval': {
      const limit = Number.parseInt(String(flags.limit ?? '25'), 10) || 25;
      const store = createStores(config).runs;
      // Loaded one at a time, not listed. `list` leaves out the proposed files
      // for speed, and a scorer reading those absences concluded that no run
      // had ever proposed anything.
      const listed = await store.list(limit, [config.repoPath]);
      const records = (await Promise.all(listed.map((r) => store.load(r.id))))
        .filter((r): r is RunRecord => r !== null);
      const card = await scoreRuns(records);

      if (flags.json) {
        console.log(JSON.stringify(card, null, 2));
        return;
      }

      if (card.runs.length === 0) {
        console.log(`${c.yellow('▌')} No scorable runs yet. Run the pipeline first.`);
        return;
      }

      console.log(
        `${c.bold(`Scored ${card.runs.length} run(s)`)} ${c.dim(`of the last ${records.length}`)}\n`,
      );
      for (const row of card.summary) {
        const pct = Math.round(row.mean * 100);
        const mark = pct === 100 ? c.green('✓') : pct >= 80 ? c.yellow('!') : c.red('✗');
        console.log(
          `  ${mark} ${row.scorer.padEnd(22)} ${String(pct).padStart(3)}%` +
            c.dim(row.imperfect > 0 ? `  (${row.imperfect} of ${row.runs} below 1)` : ''),
        );
        console.log(`    ${c.dim(row.description)}`);
      }

      // The question this command exists to answer.
      if (card.trend) {
        const moved = card.trend.filter((t) => Math.abs(t.recent - t.earlier) >= 0.01);
        console.log(`\n${c.bold('Recent runs against earlier ones')}`);
        if (moved.length === 0) {
          console.log(`  ${c.dim('nothing moved')}`);
        }
        for (const t of moved) {
          const delta = Math.round((t.recent - t.earlier) * 100);
          const arrow = delta > 0 ? c.green(`+${delta}`) : c.red(String(delta));
          console.log(
            `  ${t.scorer.padEnd(22)} ${Math.round(t.earlier * 100)}% → ` +
              `${Math.round(t.recent * 100)}%  ${arrow}`,
          );
        }
      }

      // The averages say something moved; these say where to look.
      if (card.worst.length > 0) {
        console.log(`\n${c.bold('Worth opening')}`);
        for (const run of card.worst.slice(0, 5)) {
          const failed = run.scores.filter((s) => s.score < 1).map((s) => s.scorer);
          console.log(
            `  ${c.dim(run.runId.slice(0, 8))}  ${run.commit}  ${run.subject.slice(0, 46)}`,
          );
          console.log(`    ${c.red(failed.join(', '))}`);
        }
      }
      return;
    }

    case 'resume': {
      const runId = positional[0];
      if (!runId) {
        console.error('usage: docxy resume <run-id>');
        process.exitCode = 1;
        return;
      }
      const { sessions } = createStores(config);
      const runtime = createRuntime(config, sessions);
      await runtime.assertReady();

      const store = createStores(config).runs;
      const target = await store.load(runId);
      if (!target) {
        console.error(`No run ${runId}.`);
        process.exitCode = 1;
        return;
      }

      console.log(
        `${c.dim('Resuming')} ${runId.slice(0, 8)} ${c.dim(`on ${target.commit.shortSha}`)}\n`,
      );
      const { run } = await runPipeline(config, target.commit.sha, {
        runtime,
        resume: runId,
        onRoleEvent: (role, event) => {
          if (
            event.kind === 'session' ||
            event.kind === 'subagent' ||
            event.kind === 'approval' ||
            event.kind === 'workflow'
          ) {
            console.log(`  ${c.dim(role.padEnd(18))} ${event.text}`);
          }
        },
      });
      summarizeRun(run, config);
      return;
    }

    case 'run': {
      const { sessions } = createStores(config);
      const runtime = createRuntime(config, sessions);
      await runtime.assertReady();
      const ref = positional[0] ?? 'HEAD';

      console.log(`${c.dim('Running the pipeline on')} ${ref}\n`);
      const { run, skipped } = await runPipeline(config, ref, {
        runtime,
        force: Boolean(flags.force),
        onRoleEvent: (role, event) => {
          if (
            event.kind === 'session' ||
            event.kind === 'subagent' ||
            event.kind === 'repair' ||
            event.kind === 'workflow'
          ) {
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
        // A run recorded before the gate was removed. Nothing produces this any
        // more, and its proposal is still publishable.
        console.log(`\n${c.yellow('▌')} ${c.bold('Recorded before the approval gate was removed.')}`);
        console.log(`  ${c.dim(`Open its pull request with:  docxy publish ${run.id.slice(0, 8)}`)}`);
      } else if (run.status === 'approved' && run.error) {
        // Approved but unpublished: the proposal is sound and the push failed.
        console.log(`\n${c.red('▌')} ${c.bold('The proposal is ready but was not published.')}`);
        console.log(`  ${run.error}`);
        console.log(`\n  ${c.dim(`Retry publishing with:  docxy publish ${run.id.slice(0, 8)}`)}`);
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

    case 'publish': {
      const id = positional[0];
      if (!id) throw new Error('Usage: docxy publish <run-id>');

      const store = createStores(config).runs;
      const run = await loadRunByPrefix(store, id, config);
      if (!run) throw new Error(`No run matching "${id}".`);
      if (run.pullRequestUrl) {
        console.log(`${c.yellow('▌')} This run already has a pull request.`);
        console.log(`  ${run.pullRequestUrl}`);
        return;
      }

      const files = await rebuildProposedFiles(config, run);
      if (files.length === 0) {
        console.log(`${c.yellow('▌')} This run proposed no changes, so there is nothing to open.`);
        return;
      }

      console.log(`${c.dim('Opening the pull request for')} ${run.commit.shortSha}...`);
      // The pipeline's own judgement, replayed. A proposal the Coordinator
      // rejected or validation failed stays a draft that says why, however many
      // days sat between the run and this.
      const pr = await openPullRequest(config, run, files, run.publication);
      run.pullRequestUrl = pr.url;
      run.status = 'done';
      run.error = undefined;
      run.finishedAt = new Date().toISOString();
      await store.save(run);
      console.log(`${c.green('✓')} ${pr.url}`);
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
      // list it under another - the dashboard would show nothing while the
      // pipeline worked perfectly.
      //
      // `--repo` pins it just as DOCXY_REPO_PATH does. Reading only the
      // environment variable meant `serve --repo X` silently served the App's
      // first installed repository instead: every other subcommand honours the
      // flag, so runs filed under X were listed from somewhere else, and the
      // timeline came up populated with the wrong project rather than empty.
      let serveConfig = config;
      const explicitRepo = flags.repo
        ? '--repo'
        : process.env.DOCXY_REPO_PATH?.trim()
          ? 'DOCXY_REPO_PATH'
          : null;
      let fromApp = false;
      if (!explicitRepo) {
        const credentials = readAppCredentials();
        const repos = credentials ? await installationRepositories(credentials) : [];
        if (repos[0]) {
          fromApp = true;
          serveConfig = {
            ...config,
            repoPath: await ensureCheckout(repos[0].fullName, repos[0].defaultBranch),
          };
        }
      }

      const { sessions: serveSessions } = createStores(serveConfig);
      await createRuntime(serveConfig, serveSessions).assertReady();
      const handle = startServer(serveConfig);
      console.log(`${c.bold('Docxy')} is on http://localhost:${handle.port}`);

      // Which repository a push will actually document. Without this the only
      // way to find out is to push and see, and the answer differs depending on
      // whether DOCXY_REPO_PATH is set - the exact thing worth being explicit
      // about at boot.
      console.log(
        `${c.dim('repository')} ${serveConfig.repoPath}` +
          (fromApp
            ? ` ${c.dim('(from the App installation)')}`
            : explicitRepo
              ? ` ${c.dim(`(pinned by ${explicitRepo})`)}`
              : ''),
      );
      if (!fromApp && !explicitRepo) {
        console.log(
          `${c.red('!')} the GitHub App is not configured, or is installed on no repositories - ` +
            `pushes will not be documented`,
        );
      }
      return;
    }

    /**
     * What the pipeline has learned about this repository, as it is stored and
     * as the roles are told it.
     *
     * Worth a command of its own because this is the one piece of state that
     * silently changes what a model is asked. The symbol map is visible in
     * every run's output and the sessions are named on every trace; a memory
     * that only ever appeared inside a prompt would be the one input nobody
     * could check, which is the opposite of what the rest of this project
     * claims. `--prompt` prints the exact text a role receives.
     */
    case 'memory': {
      const { sessions: memorySessions } = createStores(config);
      const runtime = createRuntime(config, memorySessions);
      const memory = await runtime.loadProjectMemory();
      await runtime.close();

      if (flags.json) {
        console.log(JSON.stringify(memory, null, 2));
        return;
      }

      if (flags.prompt) {
        const audience = flags.prompt === 'impact-mapper' ? 'impact-mapper' : 'docs-updater';
        console.log(`\n${c.bold(`As the ${audience} is told it`)}\n`);
        console.log(renderProjectMemory(memory, audience));
        console.log();
        return;
      }

      console.log(`\n${c.bold('What docxy has learned about this repository')}\n`);
      if (memory.observed.runs === 0) {
        console.log(`  ${c.dim('nothing yet - no run has completed against this repository')}\n`);
        return;
      }
      console.log(
        `  ${c.dim('observed')} ${memory.observed.runs} run(s), last ${memory.observed.lastCommit.slice(0, 7)}` +
          ` on ${memory.observed.updatedAt.slice(0, 10)}`,
      );
      console.log(`  ${c.dim('out-of-scope edits')} ${memory.outOfScopeEdits}\n`);
      console.log(`  ${c.dim('anchoring, by file')}`);
      for (const file of memory.files) {
        const rate = file.proposed > 0 ? file.applied / file.proposed : 1;
        const mark = rate >= 0.95 ? c.green('✓') : rate < 0.6 ? c.red('✗') : c.yellow('·');
        console.log(
          `  ${mark} ${file.path.padEnd(40)} ${file.applied}/${file.proposed} applied ` +
            c.dim(`over ${file.runs} run(s)`),
        );
      }
      console.log(`\n${c.dim('--prompt [docs-updater|impact-mapper] shows the text a role is given')}\n`);
      return;
    }

    case 'reset': {
      const all = !flags.sessions && !flags.knowledge && !flags.memory;
      if (all || flags.sessions) {
        await createStores(config).sessions.clear();
        console.log(`${c.green('✓')} cleared agent sessions for this repository`);
      }
      if (all || flags.knowledge) {
        await createStores(config).knowledge.reset();
        console.log(`${c.green('✓')} cleared the symbol map for this repository`);
      }
      if (all || flags.memory) {
        // Cleared by writing an empty record rather than deleting the resource
        // row, which also carries the roles' threads. A bare `reset` includes
        // this because the command promises to clear accumulated state, and
        // memory that survived it would be state the user was told was gone.
        const { sessions: resetSessions } = createStores(config);
        const runtime = createRuntime(config, resetSessions);
        await runtime.saveProjectMemory(emptyProjectMemory());
        await runtime.close();
        console.log(`${c.green('✓')} cleared what earlier runs learned about this repository`);
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
    console.error(`\n${c.red('✗')} ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  })
  // Every command but `serve` would otherwise hang on an open Neon pool
  // instead of exiting.
  .finally(() => (holdOpen ? undefined : closeDb()));
