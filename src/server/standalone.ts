/**
 * Production entry point.
 *
 * `docxy serve` is built for a developer at a terminal and listens on
 * DOCXY_PORT. A deployed container must bind the port the platform assigns, and
 * must come up even when its dependencies are not wired yet, so the platform
 * can route to it and report a real status instead of a crash loop.
 */
import { serve } from '@hono/node-server';
import { loadConfig } from '../config.js';
import { createServer } from './index.js';

/**
 * A rejection nobody handled must not take the process down.
 *
 * Node's default for an unhandled rejection is to exit, and a long-running
 * server has plenty of places one can escape from - a background refresh, a
 * detached publish, a driver's own internals. Exiting mid-run loses the run and
 * every connected event stream to fix a fault that was very likely survivable.
 * Logged loudly and left running; the deployment's health check is what should
 * decide whether this process deserves to live.
 */
process.on('unhandledRejection', (reason) => {
  console.error(
    `unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`,
  );
});

const config = loadConfig();
const { app } = createServer(config);

/**
 * Platform health check.
 *
 * The agents run in this process, so there is no harness to be up or down and
 * nothing here can fail for want of one. What is still worth reporting is
 * whether a model key and a workspace exist, because a deployment missing
 * either is running but cannot do its job - and that is exactly the state a
 * green health check used to hide.
 */
app.get('/health', (c) =>
  c.json({
    ok: true,
    model: config.nebius.apiKey ? 'configured' : 'missing NEBIUS_API_KEY',
    sandbox: config.sandbox.daytonaApiKey
      ? 'configured'
      : 'missing DAYTONA_API_KEY - the docs build cannot run in isolation',
    repo: config.repoPath,
  }),
);

// Platforms assign the port through PORT; DOCXY_PORT stays the local default.
const port = Number(process.env.PORT ?? config.server.port);
if (!Number.isFinite(port) || port <= 0) {
  throw new Error(`PORT is not a usable port number: ${process.env.PORT}`);
}

/**
 * Refuse to expose an unauthenticated API.
 *
 * This entry point binds every interface by design, and the routes behind it
 * sign off proposals, start runs and rewrite the instructions the agents read.
 * `docxy serve` may leave `DOCXY_API_TOKEN` unset because it stays on
 * loopback; here that combination puts approval endpoints on the public
 * internet. Failing to boot is the loud version of a problem whose quiet
 * version is silent and much worse.
 */
if (!config.server.apiToken) {
  throw new Error(
    'DOCXY_API_TOKEN is not set. This entry point binds 0.0.0.0, and the API it ' +
      'serves can approve proposals and open pull requests, so it will not start ' +
      'without a shared secret. Generate one with `openssl rand -hex 32` and set it ' +
      'here and on the dashboard, which sends it as a bearer token.',
  );
}

// 0.0.0.0, not localhost: a container's loopback is not reachable from outside it.
serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, (info) => {
  console.log(`docxy listening on 0.0.0.0:${info.port}`);
  console.log(`repo      ${config.repoPath}`);
});

if (!config.nebius.apiKey) {
  // Not fatal - this entry point comes up and reports a status rather than
  // crash-looping - but no run can start without it, so it says so once, loudly.
  console.error('error: NEBIUS_API_KEY is not set. No run can start without it.');
}
/**
 * Said at boot, because the alternative is saying it four roles into a run.
 *
 * Code mode fails closed - it will not run model-authored code with nowhere
 * isolated to put it - but that failure lands after the Change Analyst and the
 * Impact Mapper have already been paid for. A deployment missing its key should
 * hear about it while nothing is in flight.
 */
if (config.agent.codeMode && config.agent.codeModeSandbox === 'daytona' && !config.sandbox.daytonaApiKey) {
  console.error(
    'error: DOCXY_CODE_MODE is on and DAYTONA_API_KEY is not set, so the Docs Updater has ' +
      'nowhere isolated to run its program. Every run will fail at drafting until one is set.',
  );
}
if (config.agent.codeMode && config.agent.codeModeSandbox === 'local') {
  console.warn(
    'warning: DOCXY_CODE_MODE_SANDBOX=local runs model-authored code on this container. ' +
      'That is a development setting; production should use a Daytona workspace.',
  );
}
if (config.sandbox.enabled && !config.sandbox.daytonaApiKey) {
  console.warn(
    'warning: DAYTONA_API_KEY is not set, so the docs build has nowhere isolated to run. ' +
      'Proposals will be reported unvalidated unless DOCXY_SANDBOX_FALLBACK=local.',
  );
}
/**
 * The private key, checked at boot rather than at the moment it is needed.
 *
 * `GITHUB_APP_PRIVATE_KEY_PATH` is the right shape on a laptop and the wrong one
 * here: a managed platform hands a service environment variables, not a
 * filesystem to place a PEM on beforehand. Nothing reads the key until a run
 * mints an installation token, so a deployment carrying a laptop's path looks
 * configured, accepts the webhook, pays for all five roles, and then fails at
 * the publish step - the last place anyone would look for an environment
 * problem. Said here instead, while nothing is in flight.
 */
if (process.env.GITHUB_APP_PRIVATE_KEY_PATH?.trim() && !process.env.GITHUB_APP_PRIVATE_KEY?.trim()) {
  console.warn(
    'warning: GITHUB_APP_PRIVATE_KEY_PATH is set and GITHUB_APP_PRIVATE_KEY is not. That path ' +
      'is read from this container, not from wherever it was written, so a laptop path will ' +
      'fail - after a run has already paid for five roles. Set GITHUB_APP_PRIVATE_KEY to the ' +
      'PEM itself instead; guides/DEPLOY.md has the accepted formats.',
  );
}
