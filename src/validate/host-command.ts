import { spawn } from 'node:child_process';

/**
 * Running a repository's own command - its test suite, its docs build - on the
 * machine Docxy runs on.
 *
 * Two things about that command are certain: somebody other than the operator
 * may have written it, and it may start processes of its own. Both used to be
 * ignored. It inherited the server's whole environment, so a connected
 * repository's `npm test` could read the GitHub App's private key, the database
 * URL and the dashboard's API token and send them anywhere. And it ran under
 * `/bin/sh`, so the timeout killed the shell and left `npm`, `node` and
 * whatever they had started running on, holding the lane's checkout open and
 * spending the host's CPU long after the run had given up on them.
 */

/**
 * What a build or a test runner genuinely needs from the environment.
 *
 * The locale, a `PATH` to find its tools, a home and a temp directory to write
 * caches into. Nothing that authenticates anything.
 */
const BASE_ENV = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TZ',
  'TMPDIR',
  'TMP',
  'TEMP',
  // Windows will not start a shell without these.
  'SystemRoot',
  'ComSpec',
  'PATHEXT',
  'windir',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
];

/**
 * The server's own credentials, which never reach a repository's command.
 *
 * Even when an operator lists one in `DOCXY_VALIDATION_ENV`: these are the
 * deployment's keys rather than the project's, and a test suite that needs
 * one is asking for access to every other tenant's data.
 */
const NEVER_PASSED = new Set([
  'DATABASE_URL',
  'DOCXY_API_TOKEN',
  'GITHUB_APP_PRIVATE_KEY',
  'GITHUB_APP_PRIVATE_KEY_PATH',
  'GITHUB_WEBHOOK_SECRET',
  'GITHUB_APP_CLIENT_SECRET',
  'BETTER_AUTH_SECRET',
  'COMPOSIO_API_KEY',
  'DAYTONA_API_KEY',
  'NEBIUS_API_KEY',
  'DODO_PAYMENTS_API_KEY',
  'DODO_PAYMENTS_WEBHOOK_SECRET',
]);

/**
 * The environment a repository's command runs with.
 *
 * Built up from nothing rather than copied and pruned: a list of what to remove
 * is always one new secret behind. `passEnv` is the operator's explicit
 * addition, for a suite that needs, say, `NODE_OPTIONS` or a service URL.
 */
export function commandEnvironment(
  source: NodeJS.ProcessEnv,
  passEnv: readonly string[] = [],
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of [...BASE_ENV, ...passEnv]) {
    if (NEVER_PASSED.has(name)) continue;
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  // What test runners read to stop asking questions and stop watching files.
  env.CI = 'true';
  return env;
}

export interface HostCommandResult {
  /** Null when the process was killed rather than exiting. */
  code: number | null;
  /** The tail of stdout and stderr, interleaved as they arrived. */
  output: string;
  timedOut: boolean;
  aborted: boolean;
}

export interface HostCommandOptions {
  cwd: string;
  timeoutMs: number;
  passEnv?: readonly string[];
  signal?: AbortSignal;
  /** How much output to keep. The tail is what explains a failure. */
  maxOutputBytes?: number;
  /** For tests: the environment to build from. Defaults to this process's. */
  sourceEnv?: NodeJS.ProcessEnv;
}

/** How long a process group gets to exit on SIGTERM before it is SIGKILLed. */
const GRACE_MS = 5_000;

/**
 * Run a shell command as its own process group, and end the whole group.
 *
 * `detached` makes the shell a group leader, so everything it starts shares a
 * group id that a single negative-pid signal reaches - the shell's children and
 * theirs included, which is the part `execFile`'s timeout never touched.
 * Windows has no process groups to signal; there the shell alone is killed,
 * which is no worse than before.
 */
export function runHostCommand(command: string, options: HostCommandOptions): Promise<HostCommandResult> {
  const maxOutput = options.maxOutputBytes ?? 256 * 1024;
  const posix = process.platform !== 'win32';

  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      resolve({ code: null, output: 'not started: the run was cancelled', timedOut: false, aborted: true });
      return;
    }

    const child = spawn(command, {
      cwd: options.cwd,
      shell: true,
      detached: posix,
      env: commandEnvironment(options.sourceEnv ?? process.env, options.passEnv),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // A rolling tail rather than everything: a chatty suite can print hundreds
    // of megabytes, and only the end of it explains a failure.
    let chunks: Buffer[] = [];
    let held = 0;
    const keep = (chunk: Buffer): void => {
      chunks.push(chunk);
      held += chunk.length;
      while (held > maxOutput && chunks.length > 1) {
        held -= chunks.shift()?.length ?? 0;
      }
    };
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);

    let timedOut = false;
    let aborted = false;
    let killTimer: NodeJS.Timeout | undefined;

    const signalGroup = (sig: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        if (posix) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        // The group has already gone.
      }
    };
    const stop = (): void => {
      signalGroup('SIGTERM');
      killTimer ??= setTimeout(() => signalGroup('SIGKILL'), GRACE_MS);
    };

    const deadline = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs);
    deadline.unref();

    const onAbort = (): void => {
      aborted = true;
      stop();
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    child.on('error', (err) => {
      clearTimeout(deadline);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', onAbort);
      reject(err);
    });

    // `close` rather than `exit`: it waits for the output pipes to drain, so
    // the last lines - usually the ones that matter - are not lost.
    child.on('close', (code) => {
      clearTimeout(deadline);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', onAbort);
      // The command is over, so nothing left in its group is wanted: a server
      // a suite started and forgot, or a grandchild that ignored SIGTERM.
      signalGroup('SIGKILL');
      let output = Buffer.concat(chunks).toString('utf8');
      chunks = [];
      if (held > maxOutput) output = output.slice(-maxOutput);
      resolve({ code, output, timedOut, aborted });
    });
  });
}
