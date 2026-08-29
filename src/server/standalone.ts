/**
 * Production entry point.
 *
 * `docxy serve` is built for a developer at a terminal: it refuses to start
 * unless the harness is already reachable, and it listens on DOCXY_PORT. A
 * deployed container needs the opposite of both — it must bind the port the
 * platform assigns, and it must come up even when its dependencies are not
 * wired yet, so the platform can route to it and report a real status instead
 * of a crash loop.
 */
import { serve } from '@hono/node-server';
import { loadConfig } from '../config.js';
import { assertReachable, createClient } from '../trueforge/client.js';
import { createServer } from './index.js';

/**
 * A rejection nobody handled must not take the process down.
 *
 * Node's default for an unhandled rejection is to exit, and a long-running
 * server has plenty of places one can escape from — a background refresh, a
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
const client = createClient(config);
const { app } = createServer(client, config);

/**
 * A harness URL this container can never reach.
 *
 * `TRUEFORGE_BASE_URL` defaults to `http://localhost:8790`, which is correct on
 * a laptop and impossible here: a container's loopback is the container, and
 * nothing in this image serves 8790. Left as an ordinary connection failure it
 * reports "unreachable" — the same word used when a real, deployed harness is
 * merely down — and reads like the code is hardwired to localhost rather than
 * like an unset variable. Distinguished so the answer names itself.
 */
function harnessIsLoopback(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '::1' || host === '0.0.0.0' || host.startsWith('127.');
  } catch {
    return false;
  }
}

const loopbackHarness = harnessIsLoopback(config.trueforge.baseUrl);

/** Platform health check. Reports the harness without depending on it. */
app.get('/health', async (c) => {
  let harness = 'unreachable';
  if (loopbackHarness) {
    harness = 'misconfigured';
  } else {
    try {
      await assertReachable(client, config);
      harness = 'ok';
    } catch {
      // Reported, not fatal: the service is up and can still serve the UI.
    }
  }
  // Undefined, not absent: JSON.stringify drops the key entirely, so a healthy
  // deployment's payload is unchanged and only a misconfigured one carries this.
  const detail = loopbackHarness
    ? 'TRUEFORGE_BASE_URL is unset or points at loopback, which in a container ' +
      'is this container. Deploy the TrueForge harness as its own service and ' +
      'set TRUEFORGE_BASE_URL to its address. See guides/DEPLOY.md.'
    : undefined;

  return c.json({
    ok: true,
    harness,
    harnessUrl: config.trueforge.baseUrl,
    detail,
    repo: config.repoPath,
  });
});

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
  console.log(`harness   ${config.trueforge.baseUrl}`);
});

if (loopbackHarness) {
  // Still not fatal — this entry point is meant to come up and report a status
  // rather than crash-loop — but this particular failure has one cause and one
  // fix, so it says both instead of leaving them to be inferred from a refused
  // connection.
  console.error(
    `error: TRUEFORGE_BASE_URL is ${config.trueforge.baseUrl}, which this container ` +
      `cannot reach — in a container, localhost is this container, and nothing here ` +
      `serves the harness.\n` +
      `       Deploy the TrueForge harness as its own service and set ` +
      `TRUEFORGE_BASE_URL to its address (on Railway, something like ` +
      `http://harness.railway.internal:8790).\n` +
      `       Until then no run can start. guides/DEPLOY.md step 1 covers it.`,
  );
}

void assertReachable(client, config).catch((cause: unknown) => {
  // A warning, deliberately not a failure. Runs will report this clearly when
  // one is actually attempted; refusing to boot would only hide the service.
  if (loopbackHarness) return; // already reported above, with the actual cause
  console.warn(
    `warning: the TrueForge harness is not reachable yet — ` +
      `${cause instanceof Error ? cause.message.split('\n')[0] : String(cause)}`,
  );
});
