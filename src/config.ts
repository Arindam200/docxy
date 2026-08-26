import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

/** Minimal .env loader — avoids a dependency for one job. */
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
  trueforge: {
    baseUrl: string;
    token?: string;
    timeoutInSeconds: number;
  };
  nebius: {
    apiKey: string;
    baseUrl: string;
    /** Name the provider is registered under inside TrueForge. */
    providerName: string;
  };
  /** Model FQN (`provider/model`) per role, as TrueForge resolves it. */
  models: Record<RoleName, string>;
  /** Upstream Nebius model ids to register under the provider. */
  registeredModels: Array<{ name: string; modelId: string; contextLength: number }>;
  docs: {
    /**
     * Branch the documentation lives on, and the branch pull requests target.
     * Empty means docs live in the code checkout and PRs target `github.baseBranch`.
     */
    branch: string;
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
  approval: {
    /** Minutes before a pending request is reported stale. It is never auto-resolved. */
    staleAfterMinutes: number;
    /**
     * Whether a human has to sign off before the pull request is opened.
     *
     * Off by default: the pipeline's job is to land a documentation pull
     * request, and a pull request is itself a review surface — nothing is
     * merged without someone approving it on GitHub. Turn this on to hold the
     * proposal behind docxy's own gate as well.
     */
    required: boolean;
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
     * the accumulated transcript is also an input that grows without bound —
     * and an overfull session is what produced every `max_tokens breached`
     * failure in this repository's history. Zero disables rotation.
     */
    sessionMaxTurns: number;
  };
  server: { port: number };
  github: { token?: string; repo?: string; baseBranch: string };
  /** Enable TrueForge sandbox + git-backed skills instead of inlined skill packs. */
  useHarnessSkills: boolean;
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

/**
 * Default roster model. DeepSeek V4 Pro is chosen because every role in this
 * pipeline must emit strict JSON, and it advertises `json_mode` and
 * `structured_outputs` alongside a 1M context window — enough to hold a large
 * docs outline and a full diff in one turn.
 */
const DEFAULT_MODEL = 'deepseek-ai/DeepSeek-V4-Pro';

export function loadConfig(overrides: Partial<{ repoPath: string }> = {}): Config {
  const cwd = process.cwd();
  loadDotEnv(cwd);

  const repoPath = resolve(overrides.repoPath ?? env('DOCXY_REPO_PATH', cwd));
  const providerName = env('NEBIUS_PROVIDER_NAME', 'nebius');

  // A role's model is `provider/registered-model-name`. The registered name is a
  // TrueForge ResourceName (lowercase, no slashes), so upstream ids are mapped.
  const roleModel = (key: string, fallback: string): string =>
    env(key, `${providerName}/${fallback}`);

  return {
    repoPath,
    stateDir: resolve(env('DOCXY_STATE_DIR', join(cwd, '.docxy'))),
    trueforge: {
      baseUrl: env('TRUEFORGE_BASE_URL', 'http://localhost:8790'),
      token: env('TRUEFORGE_TOKEN') || undefined,
      timeoutInSeconds: envInt('TRUEFORGE_TIMEOUT_SECONDS', 900),
    },
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
    approval: {
      staleAfterMinutes: envInt('DOCXY_APPROVAL_STALE_MINUTES', 60),
      required: envBool('DOCXY_REQUIRE_APPROVAL', false),
    },
    agent: {
      maxAttempts: Math.max(1, envInt('DOCXY_ROLE_MAX_ATTEMPTS', 3)),
      attemptTimeoutMs: Math.max(30, envInt('DOCXY_ROLE_TIMEOUT_SECONDS', 420)) * 1000,
      runTimeoutMs: Math.max(60, envInt('DOCXY_RUN_TIMEOUT_SECONDS', 2700)) * 1000,
      sessionMaxTurns: Math.max(0, envInt('DOCXY_SESSION_MAX_TURNS', 12)),
    },
    server: { port: envInt('DOCXY_PORT', 4317) },
    github: {
      token: env('GITHUB_TOKEN') || env('GH_TOKEN') || undefined,
      repo: env('GITHUB_REPOSITORY') || undefined,
      baseBranch: env('DOCXY_BASE_BRANCH', 'main'),
    },
    useHarnessSkills: envBool('DOCXY_USE_HARNESS_SKILLS', false),
  };
}

/**
 * The branch a pull request is opened against. When docs live on their own
 * branch that branch is both where the docs were read from and where the
 * proposal lands — basing the PR anywhere else would diff against the wrong tree.
 */
export function prBaseBranch(config: Config): string {
  return config.docs.branch || config.github.baseBranch;
}
