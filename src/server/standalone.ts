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

const config = loadConfig();
const client = createClient(config);
const { app } = createServer(client, config);

/** Platform health check. Reports the harness without depending on it. */
app.get('/health', async (c) => {
  let harness = 'unreachable';
  try {
    await assertReachable(client, config);
    harness = 'ok';
  } catch {
    // Reported, not fatal: the service is up and can still serve the UI.
  }
  return c.json({
    ok: true,
    harness,
    harnessUrl: config.trueforge.baseUrl,
    repo: config.repoPath,
  });
});

// Platforms assign the port through PORT; DOCXY_PORT stays the local default.
const port = Number(process.env.PORT ?? config.server.port);
if (!Number.isFinite(port) || port <= 0) {
  throw new Error(`PORT is not a usable port number: ${process.env.PORT}`);
}

// 0.0.0.0, not localhost: a container's loopback is not reachable from outside it.
serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, (info) => {
  console.log(`docxy listening on 0.0.0.0:${info.port}`);
  console.log(`harness   ${config.trueforge.baseUrl}`);
});

void assertReachable(client, config).catch((cause: unknown) => {
  // A warning, deliberately not a failure. Runs will report this clearly when
  // one is actually attempted; refusing to boot would only hide the service.
  console.warn(
    `warning: the TrueForge harness is not reachable yet — ` +
      `${cause instanceof Error ? cause.message.split('\n')[0] : String(cause)}`,
  );
});
