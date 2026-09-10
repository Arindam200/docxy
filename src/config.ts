import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

/** Minimal .env loader - avoids a dependency for one job. */
function loadDotEnv(dir: string): void {
  const file = join(dir, '.env');
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export type RoleName =
  | 'coordinator'
  | 'change-analyst'
  | 'impact-mapper'
  | 'docs-updater'
  | 'changelog-author';

export const ROLE_NAMES: RoleName[] = [
  'coordinator',
  'change-analyst',
  'impact-mapper',
  'docs-updater',
  'changelog-author',
];

export interface Config {
  /** Repository the pipeline documents. */
  repoPath: string;
  /** Where session ids, the knowledge map, and pending approvals are persisted. */
  stateDir: string;
  nebius: {
    apiKey: string;
    baseUrl: string;
    /** Provider id in Mastra's model router. */
    providerName: string;
  };
  /** Model per role, as configured. Resolved to a router id by `mastraModelFor`. */
  models: Record<RoleName, string>;
  /**
   * Short aliases for upstream Nebius model ids.
   *
   * These were the models `docxy setup` registered with the harness, which is
   * why `DOCXY_MODEL_*` may name one. Nothing registers anything now - the
   * router takes upstream ids directly - so this survives only as an alias
   * table, which keeps existing configuration working and lets a role be
   * pointed at `deepseek-v4-flash` instead of `deepseek-ai/DeepSeek-V4-Flash`.
   */
  registeredModels: Array<{ name: string; modelId: string; contextLength: number }>;
  docs: {
    /**
     * Branch the documentation lives on, and the branch pull requests target.
     * Empty means docs live in the code checkout and PRs target `github.baseBranch`.
     */
    branch: string;
    /**
     * The repository the documentation lives in, as `owner/repo`.
     *
     * Empty means it lives with the code, which was the only case the pipeline
     * used to allow. A docs site, a handbook, or one central documentation
     * repository fed by several services are all ordinary arrangements, and
     * assuming a monorepo silently excluded every one of them.
     *
     * This is the *intent*; `repoPath` is where that repository was actually
     * checked out for this run.
     */
    repo: string;
    /**
     * Local checkout of `repo`, resolved by whoever started the run.
     *
     * Empty means the documentation is read from the code checkout. Kept apart
     * from `repo` because the pipeline works against paths - the name is what a
     * project records, the path is what this host managed to clone.
     */
    repoPath: string;
    /**
     * Default branch of the documentation repository.
     *
     * Only meaningful with `repo` set, and only because it is not safe to
     * assume: the code repository's base branch says nothing about a different
     * repository, which may well be on `master` or `trunk`.
     */
    baseBranch: string;
    /** Globs-ish roots the Impact Mapper treats as documentation. */
    roots: string[];
    changelogPath: string;
  };
  validation: {
    enabled: boolean;
    /** Shell command that builds the docs; skipped when empty. */
    docsBuildCommand: string;
    /** Shell command that runs the test suite; skipped when empty. */
    testCommand: string;
    checkLinks: boolean;
  };
  sandbox: {
    /**
     * Execute the docs build inside a remote workspace instead of on this
     * machine.
     *
     * On by default. The docs build is the one validation step that runs a
     * command over text a model wrote, and pointing that at the operator's own
     * filesystem is the wrong default however convenient it is.
     *
     * Without a Daytona key the check still runs, locally, and says so. An
     * unvalidated proposal is worse than a locally validated one, and silently
     * skipping the check would hide the difference.
     */
    enabled: boolean;
    /**
     * What to do when the sandbox cannot run the build.
     *
     * `skip` (the default) fails the check and says why. `local` stages the
     * proposal and runs the command on this machine instead.
     *
     * The default is not the convenient one on purpose. Falling back to the host
     * silently hands model-authored content the filesystem this whole path
     * exists to keep it away from - an isolation boundary that disappears
     * exactly when it is least observed. A failed check still lands: the
     * proposal opens as a draft carrying the reason, which is louder and safer
     * than a green tick earned on the host.
     */
    fallback: 'skip' | 'local';
    /** Daytona key. The workspace cannot run without one. */
    daytonaApiKey: string;
    /** Idle minutes before Daytona stops the sandbox. 0 disables. */
    autoStopMinutes: number;
    /** Minutes before Daytona deletes it outright. 0 disables. */
    autoDeleteMinutes: number;
    /** Ceiling on one command executed inside the sandbox. */
    execTimeoutMs: number;
    /**
     * Deny the sandbox outbound network access.
     *
     * On by default. The command inside runs over prose a model wrote minutes
     * ago, and a sandbox that can still reach the network is a sandbox in name
     * only - the isolation it exists to provide is exactly the part that goes
     * missing. Turn it off for a docs build that genuinely needs a package
     * registry, and know that you have.
     *
     */
    blockNetwork: boolean;
  };
  /**
   * Guardrails on what reaches a model, and on what a model is allowed to be
   * told to do.
   *
   * Both exist because a commit diff is not trusted input. It is written by
   * whoever opened the pull request, it can carry a committed `.env` straight to
   * a model provider, and it can carry a sentence addressed to the agent that
   * reads it.
   */
  guardrails: {
    /**
     * Redact anything matching a known secret shape before it reaches a model.
     *
     * On by default and cheap: the match is a regex, not a model call. It is
     * belt and braces rather than a substitute for not committing secrets, but
     * the alternative is a key leaving the machine because somebody committed
     * one and docxy quoted it into a prompt.
     */
    redactSecrets: boolean;
    /**
     * Refuse a diff that is trying to give the agents instructions.
     *
     * A model call of its own, so it runs once per run rather than once per
     * role, on the first role that reads the diff. Off by default because it
     * costs a call and its judgement is a model's; a deployment documenting
     * repositories that outsiders can open pull requests against wants it on.
     *
     * It fails open. If the detecting model errors, Mastra logs and lets the
     * content through, so this raises the cost of an attack rather than making
     * one impossible - the redaction above and the pull request review are what
     * stand behind it.
     */
    detectPromptInjection: boolean;
    /**
     * Model that judges the diff.
     *
     * Not a small fast one, despite the temptation. The detector asks its model
     * for structured output and, when that fails, logs and **allows the content
     * through** - so a model that cannot reliably produce the shape does not
     * make this guard cheap, it makes it absent while appearing configured.
     * DeepSeek-V4-Flash did exactly that in testing.
     */
    injectionModel: string;
    /** How sure it must be before a run is refused. */
    injectionThreshold: number;
  };
  approval: {
    /** Minutes before a request is reported stale. Retained for old records. */
    staleAfterMinutes: number;
  };
  /** How hard the pipeline tries before it gives up on a role. */
  agent: {
    /** Attempts per role, including the first. */
    maxAttempts: number;
    /** Wall-clock ceiling for a single attempt. */
    attemptTimeoutMs: number;
    /**
     * Wall-clock ceiling for a whole run.
     *
     * Per-attempt timeouts bound each role but not their sum: five roles, three
     * attempts each, all crawling just inside their own deadline, is a run that
     * never ends and blocks every push behind it. This is the outer bound.
     */
    runTimeoutMs: number;
    /**
     * Turns a session may carry before it is retired and rebuilt.
     *
     * Session reuse is what makes the second commit cheaper than the first, but
     * the accumulated transcript is also an input that grows without bound -
     * and an overfull session is what produced every `max_tokens breached`
     * failure in this repository's history. Zero disables rotation.
     */
    sessionMaxTurns: number;
    /**
     * Ask the Docs Updater to re-anchor edits that did not apply.
     *
     * On by default, and it costs one extra model call only on runs that need
     * one. An anchor that does not match byte for byte is thrown away and the
     * whole proposal is rejected with it, so the alternative to asking again is
     * usually a draft pull request nobody can merge.
     */
    repairAnchors: boolean;
    /**
     * Let the Docs Updater write a program that finds its own anchors.
     *
     * Off by default, and that is a measurement decision rather than a doubt.
     * It changes the role from one cheap structured call into an agentic turn
     * that runs model-authored code, so it has to earn its cost against
     * `anchor-resolution` the same way the repair pass does - ten commits with
     * it off, ten with it on, `docxy eval` either side.
     *
     * The program runs under OS-level isolation with the network denied, and
     * every proposal it makes is checked against the real file and redacted
     * before it is kept; see `src/pipeline/code-mode.ts` for what that does and
     * does not contain.
     */
    codeMode: boolean;
    /**
     * Where a drafting program runs.
     *
     * `daytona` by default, and deliberately not "whichever is available".
     * Docxy is deployed as a service: falling back to a local sandbox because a
     * key was missing would mean model-authored code running on the production
     * container, decided by an absent environment variable rather than by
     * anyone. Asking for Daytona and not having it is an error, not a
     * downgrade.
     *
     * `local` is the development answer - seatbelt or bubblewrap on the
     * machine you are sitting at - and has to be asked for by name.
     *
     * Deliberately independent of `sandbox.enabled`, which turns the *docs
     * build* on and off. Whether a validation command runs has nothing to say
     * about where a model's program is allowed to execute, and reading one from
     * the other let `DOCXY_SANDBOX=false` quietly relocate the other.
     */
    codeModeSandbox: 'daytona' | 'local';
    /**
     * Run the program even when the local platform offers no isolation.
     *
     * Only consulted for `codeModeSandbox: 'local'`. For a developer who has
     * read what that means and wants it anyway; it is separate from `codeMode`
     * because "I want to try this feature" and "I accept executing
     * model-authored code on this host" are different decisions.
     */
    codeModeForceUnsandboxed: boolean;
  };
  server: {
    port: number;
    /**
     * Shared secret the dashboard proxy presents to this API.
     *
     * The Hono app answers `/api/runs/:id/approve`, `/api/runs` and
     * `PUT /api/instructions` - sign-off, execution and the standing
     * instructions the agents read. Better Auth guards the Next.js proxy in
     * front of it, but the proxy is not the only way in: the deployed entry
     * point binds `0.0.0.0`, so anything that can route to the port speaks to
     * these endpoints directly. Authentication at the proxy alone is a lock on
     * one of two doors.
     *
     * Unset leaves the API open, which is only safe on loopback - so
     * `standalone.ts` refuses to boot without it.
     */
    apiToken?: string;
    /**
     * Repositories a push webhook is allowed to start a run for.
     *
     * Empty means "any repository this GitHub App installation can mint a token
     * for", which is the multi-repo behaviour the webhook was built for. The
     * blast radius is already bounded - `installationToken` mints against a
     * fixed `GITHUB_APP_INSTALLATION_ID`, so a repository outside that
     * installation fails before it can be cloned - but an operator who knows
     * exactly which repositories should be in play can say so here.
     */
    allowedRepos: string[];
  };
  github: { token?: string; repo?: string; baseBranch: string };
}

function env(key: string, fallback?: string): string {
  const v = process.env[key];
  if (v === undefined || v === '') {
    if (fallback !== undefined) return fallback;
    return '';
  }
  return v;
}

function envInt(key: string, fallback: number): number {
  const v = process.env[key];
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  return /^(1|true|yes|on)$/i.test(v);
}

/** A comma-separated env var as a trimmed list, with the blanks dropped. */
function splitList(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Default roster model. DeepSeek V4 Pro is chosen because every role in this
 * pipeline must emit strict JSON, and it advertises `json_mode` and
 * `structured_outputs` alongside a 1M context window - enough to hold a large
 * docs outline and a full diff in one turn.
 */
const DEFAULT_MODEL = 'deepseek-ai/DeepSeek-V4-Pro';

export function loadConfig(overrides: Partial<{ repoPath: string }> = {}): Config {
  const cwd = process.cwd();
  loadDotEnv(cwd);

  const repoPath = resolve(overrides.repoPath ?? env('DOCXY_REPO_PATH', cwd));
  const providerName = env('NEBIUS_PROVIDER_NAME', 'nebius');

  // A role's model is `provider/name`, where the name may be a short alias from
  // `registeredModels` or an upstream id the router takes directly.
  const roleModel = (key: string, fallback: string): string =>
    env(key, `${providerName}/${fallback}`);

  return {
    repoPath,
    stateDir: resolve(env('DOCXY_STATE_DIR', join(cwd, '.docxy'))),
    nebius: {
      apiKey: env('NEBIUS_API_KEY'),
      baseUrl: env('NEBIUS_BASE_URL', 'https://api.tokenfactory.nebius.com/v1'),
      providerName,
    },
    models: {
      coordinator: roleModel('DOCXY_MODEL_COORDINATOR', 'deepseek-v4-pro'),
      'change-analyst': roleModel('DOCXY_MODEL_CHANGE_ANALYST', 'deepseek-v4-pro'),
      'impact-mapper': roleModel('DOCXY_MODEL_IMPACT_MAPPER', 'deepseek-v4-pro'),
      'docs-updater': roleModel('DOCXY_MODEL_DOCS_UPDATER', 'deepseek-v4-pro'),
      // This role has a tiny visible output but must reliably finish strict JSON.
      // Flash has entered a repetition loop here and exhausted whole turns, so
      // use the structured-output-capable default unless an operator explicitly
      // selects a proven alternative.
      'changelog-author': roleModel('DOCXY_MODEL_CHANGELOG_AUTHOR', 'deepseek-v4-pro'),
    },
    // Verify these against your account with `docxy models`; ids move.
    registeredModels: [
      {
        name: 'deepseek-v4-pro',
        modelId: env('NEBIUS_MODEL_PRIMARY', DEFAULT_MODEL),
        contextLength: envInt('NEBIUS_MODEL_PRIMARY_CONTEXT', 1_048_576),
      },
      {
        name: 'deepseek-v4-flash',
        modelId: env('NEBIUS_MODEL_FAST', 'deepseek-ai/DeepSeek-V4-Flash'),
        contextLength: envInt('NEBIUS_MODEL_FAST_CONTEXT', 1_048_576),
      },
      {
        name: 'kimi-k3',
        modelId: env('NEBIUS_MODEL_KIMI', 'moonshotai/Kimi-K3'),
        contextLength: envInt('NEBIUS_MODEL_KIMI_CONTEXT', 1_048_576),
      },
      {
        name: 'qwen3-5',
        modelId: env('NEBIUS_MODEL_QWEN', 'Qwen/Qwen3.5-397B-A17B'),
        contextLength: envInt('NEBIUS_MODEL_QWEN_CONTEXT', 262144),
      },
    ],
    docs: {
      branch: env('DOCXY_DOCS_BRANCH', ''),
      repo: env('DOCXY_DOCS_REPO', '').trim(),
      // Resolved per run by the caller that clones it - the webhook handler for
      // a deployment, or `DOCXY_DOCS_REPO_PATH` for somebody working locally.
      repoPath: env('DOCXY_DOCS_REPO_PATH', '').trim(),
      baseBranch: env('DOCXY_DOCS_BASE_BRANCH', '').trim(),
      roots: env('DOCXY_DOCS_ROOTS', 'docs,README.md,doc,website/docs')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      changelogPath: env('DOCXY_CHANGELOG', 'CHANGELOG.md'),
    },
    validation: {
      enabled: envBool('DOCXY_VALIDATE', true),
      docsBuildCommand: env('DOCXY_DOCS_BUILD_COMMAND', ''),
      testCommand: env('DOCXY_TEST_COMMAND', ''),
      checkLinks: envBool('DOCXY_CHECK_LINKS', true),
    },
    sandbox: {
      enabled: envBool('DOCXY_SANDBOX', true),
      fallback: env('DOCXY_SANDBOX_FALLBACK', 'skip').trim().toLowerCase() === 'local'
        ? 'local'
        : 'skip',
      daytonaApiKey: env('DAYTONA_API_KEY'),
      autoStopMinutes: Math.max(0, envInt('DOCXY_SANDBOX_AUTOSTOP_MINUTES', 15)),
      autoDeleteMinutes: Math.max(0, envInt('DOCXY_SANDBOX_AUTODELETE_MINUTES', 60)),
      execTimeoutMs: Math.max(1000, envInt('DOCXY_SANDBOX_EXEC_TIMEOUT_SECONDS', 600) * 1000),
      blockNetwork: !envBool('DOCXY_SANDBOX_ALLOW_NETWORK', false),
    },
    guardrails: {
      redactSecrets: envBool('DOCXY_REDACT_SECRETS', true),
      detectPromptInjection: envBool('DOCXY_DETECT_PROMPT_INJECTION', false),
      injectionModel: env('DOCXY_INJECTION_MODEL', 'nebius/deepseek-ai/DeepSeek-V4-Pro'),
      injectionThreshold: Number.parseFloat(env('DOCXY_INJECTION_THRESHOLD', '0.7')) || 0.7,
    },
    approval: {
      staleAfterMinutes: envInt('DOCXY_APPROVAL_STALE_MINUTES', 60),
    },
    agent: {
      maxAttempts: Math.max(1, envInt('DOCXY_ROLE_MAX_ATTEMPTS', 3)),
      attemptTimeoutMs: Math.max(30, envInt('DOCXY_ROLE_TIMEOUT_SECONDS', 420)) * 1000,
      runTimeoutMs: Math.max(60, envInt('DOCXY_RUN_TIMEOUT_SECONDS', 2700)) * 1000,
      sessionMaxTurns: Math.max(0, envInt('DOCXY_SESSION_MAX_TURNS', 12)),
      repairAnchors: envBool('DOCXY_REPAIR_ANCHORS', true),
      codeMode: envBool('DOCXY_CODE_MODE', false),
      // Anything other than an explicit `local` means Daytona, so a typo lands
      // on the safe side rather than silently moving execution onto this host.
      codeModeSandbox: env('DOCXY_CODE_MODE_SANDBOX', 'daytona') === 'local' ? 'local' : 'daytona',
      codeModeForceUnsandboxed: envBool('DOCXY_CODE_MODE_FORCE_UNSANDBOXED', false),
    },
    server: {
      port: envInt('DOCXY_PORT', 4317),
      // Trimmed here, once. Both dashboard callers trim before sending, so a
      // value with stray whitespace would otherwise be "configured" on this
      // side and a different string on theirs - every request a 401, for a
      // reason nothing reports. All-whitespace is no token at all.
      apiToken: env('DOCXY_API_TOKEN').trim() || undefined,
      allowedRepos: splitList(env('DOCXY_ALLOWED_REPOS')).map((r) => r.toLowerCase()),
    },
    github: {
      token: env('GITHUB_TOKEN') || env('GH_TOKEN') || undefined,
      repo: env('GITHUB_REPOSITORY') || undefined,
      baseBranch: env('DOCXY_BASE_BRANCH', 'main'),
    },
  };
}

/**
 * The branch a pull request is opened against.
 *
 * Three cases, narrowest first. A docs *branch* is both where the docs were
 * read from and where the proposal lands, so it wins. Failing that, a separate
 * docs *repository* contributes its own default branch - the code repository's
 * base branch says nothing about a different repository, which may be on
 * `master` or `trunk`. Otherwise the docs sit with the code and the code's base
 * branch is the answer.
 */
export function prBaseBranch(config: Config): string {
  return config.docs.branch || config.docs.baseBranch || config.github.baseBranch;
}

/** Where documentation is read from and written to on this host. */
export function docsRoot(config: Config): string {
  return config.docs.repoPath || config.repoPath;
}

/**
 * A role's model as Mastra's router names it.
 *
 * The router takes an upstream id directly - `nebius/deepseek-ai/DeepSeek-V4-Pro`
 * - but `DOCXY_MODEL_*` may name a short alias instead, so the alias table is
 * consulted first and anything unknown is passed through as an id. That is what
 * lets a role be pointed at a Nebius model this deployment has never listed.
 */
export function mastraModelFor(config: Config, role: RoleName): string {
  const configured = config.models[role];
  const slash = configured.indexOf('/');
  const provider = slash === -1 ? config.nebius.providerName : configured.slice(0, slash);
  const rest = slash === -1 ? configured : configured.slice(slash + 1);

  const registered = config.registeredModels.find((m) => m.name === rest);
  return `${provider}/${registered ? registered.modelId : rest}`;
}
