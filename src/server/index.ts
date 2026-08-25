import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import type { TrueForge } from '@truefoundry/trueforge-sdk';
import type { Config } from '../config.js';
import type { RunRecord } from '../types.js';
import { PACKAGE_ROOT } from '../paths.js';
import { RunStore } from '../pipeline/store.js';
import { rebuildProposedFiles, runPipeline } from '../pipeline/index.js';
import { ApprovalError, deny, describeGate, signOff, staleness } from '../approval/gate.js';
import { openPullRequest } from '../github/pr.js';

/** Fan-out for server-sent events, so the timeline updates while a run is live. */
class Broadcaster {
  private readonly clients = new Set<(chunk: string) => void>();

  add(send: (chunk: string) => void): () => void {
    this.clients.add(send);
    return () => this.clients.delete(send);
  }

  publish(event: string, data: unknown): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const send of this.clients) {
      try {
        send(payload);
      } catch {
        this.clients.delete(send);
      }
    }
  }
}

export interface ServerHandle {
  close: () => void;
  port: number;
}

export function createServer(client: TrueForge, config: Config): { app: Hono; bus: Broadcaster } {
  const app = new Hono();
  const runs = new RunStore(config);
  const bus = new Broadcaster();
  /** Guards against two runs racing on the same commit. */
  let activeRun: Promise<unknown> | null = null;

  app.get('/', async (c) => {
    const html = await readFile(join(PACKAGE_ROOT, 'src/server/public/index.html'), 'utf8');
    return c.html(html);
  });

  app.get('/api/config', (c) =>
    c.json({
      repoPath: config.repoPath,
      trueforgeBaseUrl: config.trueforge.baseUrl,
      provider: config.nebius.providerName,
      models: config.models,
      validationEnabled: config.validation.enabled,
    }),
  );

  app.get('/api/runs', async (c) => {
    const list = await runs.list(50);
    return c.json(
      list.map((run) => ({
        id: run.id,
        commit: run.commit,
        status: run.status,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        scope: run.approval?.scope,
        gate: describeGate(run, config),
        pullRequestUrl: run.pullRequestUrl,
      })),
    );
  });

  app.get('/api/runs/:id', async (c) => {
    const run = await runs.load(c.req.param('id'));
    if (!run) return c.json({ error: 'No such run.' }, 404);
    const withStaleness = run.approval
      ? { ...run, approvalStaleness: staleness(run.approval, config) }
      : run;
    return c.json(withStaleness);
  });

  app.get('/api/runs/:id/files', async (c) => {
    const run = await runs.load(c.req.param('id'));
    if (!run) return c.json({ error: 'No such run.' }, 404);
    const files = await rebuildProposedFiles(config, run);
    return c.json(files.map((f) => ({ path: f.path, before: f.before, after: f.after })));
  });

  app.post('/api/runs', async (c) => {
    if (activeRun) return c.json({ error: 'A run is already in progress.' }, 409);
    const body = (await c.req.json().catch(() => ({}))) as { commit?: string };
    const commit = body.commit || 'HEAD';

    const promise = runPipeline(client, config, commit, {
      onRunUpdate: (run) => bus.publish('run', run),
      onRoleEvent: (role, event) => bus.publish('role', { role, event }),
    })
      .catch((err: unknown) => {
        bus.publish('error', { message: err instanceof Error ? err.message : String(err) });
      })
      .finally(() => {
        activeRun = null;
      });

    activeRun = promise;
    return c.json({ started: true, commit });
  });

  app.post('/api/runs/:id/approve', async (c) => {
    const run = await runs.load(c.req.param('id'));
    if (!run?.approval) return c.json({ error: 'No such run, or it has no approval request.' }, 404);

    const body = (await c.req.json().catch(() => ({}))) as { by?: string };
    const by = (body.by || '').trim();
    if (!by) return c.json({ error: 'A reviewer name is required to sign off.' }, 400);

    try {
      const { approved } = signOff(run.approval, by);
      run.status = approved ? 'approved' : 'awaiting-approval';
      await runs.save(run);
      bus.publish('run', run);

      if (!approved) {
        return c.json({
          approved: false,
          remaining: run.approval.requiredSignoffs - run.approval.signoffs.length,
          message: 'Sign-off recorded. This elevated request needs a second reviewer.',
        });
      }

      const files = await rebuildProposedFiles(config, run);
      const pr = await openPullRequest(config, run, files);
      run.pullRequestUrl = pr.url;
      run.status = 'done';
      run.finishedAt = new Date().toISOString();
      await runs.save(run);
      bus.publish('run', run);
      return c.json({ approved: true, pullRequestUrl: pr.url, branch: pr.branch });
    } catch (err) {
      if (err instanceof ApprovalError) return c.json({ error: err.message }, 409);
      const message = err instanceof Error ? err.message : String(err);
      run.error = message;
      await runs.save(run);
      bus.publish('run', run);
      return c.json({ error: message }, 500);
    }
  });

  app.post('/api/runs/:id/deny', async (c) => {
    const run = await runs.load(c.req.param('id'));
    if (!run?.approval) return c.json({ error: 'No such run, or it has no approval request.' }, 404);

    const body = (await c.req.json().catch(() => ({}))) as { by?: string; reason?: string };
    const by = (body.by || '').trim();
    const reason = (body.reason || '').trim();
    if (!by || !reason) return c.json({ error: 'Both a reviewer name and a reason are required.' }, 400);

    try {
      deny(run.approval, by, reason);
      run.status = 'denied';
      run.finishedAt = new Date().toISOString();
      await runs.save(run);
      bus.publish('run', run);
      return c.json({ denied: true });
    } catch (err) {
      if (err instanceof ApprovalError) return c.json({ error: err.message }, 409);
      throw err;
    }
  });

  app.get('/api/events', (c) => {
    return new Response(
      new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          const send = (chunk: string): void => controller.enqueue(encoder.encode(chunk));
          send(': connected\n\n');
          const heartbeat = setInterval(() => send(': ping\n\n'), 20_000);
          const remove = bus.add(send);
          c.req.raw.signal.addEventListener('abort', () => {
            clearInterval(heartbeat);
            remove();
            try {
              controller.close();
            } catch {
              // already closed
            }
          });
        },
      }),
      {
        headers: {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        },
      },
    );
  });

  return { app, bus };
}

export function startServer(client: TrueForge, config: Config): ServerHandle {
  const { app } = createServer(client, config);
  const server = serve({ fetch: app.fetch, port: config.server.port });
  return {
    port: config.server.port,
    close: () => server.close(),
  };
}

export type { RunRecord };
