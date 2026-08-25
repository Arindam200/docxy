import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import type { TrueForge } from '@truefoundry/trueforge-sdk';
import type { Config } from '../config.js';
import type { RunRecord } from '../types.js';
import { PACKAGE_ROOT } from '../paths.js';
import { createStores, storageBackend } from '../pipeline/stores.js';
import { appStatus, verifyWebhook } from '../github/app.js';
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
  const { runs, knowledge: knowledgeStore } = createStores(config);
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
      storage: storageBackend(),
    }),
  );

  /** Free-form standing instructions the Docs Updater and Changelog Author read. */
  const instructionsFile = (): string => join(config.stateDir, 'instructions.md');

  app.get('/api/instructions', async (c) => {
    try {
      const text = await readFile(instructionsFile(), 'utf8');
      return c.json({ instructions: text, updatedAt: null });
    } catch {
      return c.json({ instructions: '', updatedAt: null });
    }
  });

  app.put('/api/instructions', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { instructions?: string };
    if (typeof body.instructions !== 'string') {
      return c.json({ error: 'A string body field `instructions` is required.' }, 400);
    }
    if (body.instructions.length > 20_000) {
      return c.json({ error: 'Instructions are capped at 20,000 characters.' }, 413);
    }
    await mkdir(config.stateDir, { recursive: true });
    const updatedAt = new Date().toISOString();
    await writeFile(instructionsFile(), body.instructions, 'utf8');
    bus.publish('instructions', { updatedAt });
    return c.json({ instructions: body.instructions, updatedAt });
  });

  /** What the pipeline is watching for this repository. */
  app.get('/api/tracking', async (c) => {
    const knowledge = await knowledgeStore.load();
    // Doc paths are derived from the symbol map: every section the Impact
    // Mapper has ever linked a symbol to is, by definition, tracked.
    const trackedDocs = [...new Set(Object.values(knowledge.symbols).flat())].sort();
    return c.json({
      repoPath: config.repoPath,
      docsBranch: config.docs.branch,
      docsRoots: config.docs.roots,
      changelogPath: config.docs.changelogPath,
      trackedDocs,
      symbolCount: Object.keys(knowledge.symbols).length,
      symbols: knowledge.symbols,
      processedCommits: knowledge.processedCommits.length,
      knowledgeUpdatedAt: knowledge.updatedAt,
    });
  });

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
        durationMs: run.durationMs,
        totals: run.totals,
        // One dot per role, in pipeline order. The whole run at a glance, and
        // the reason a listing does not need to fetch role bodies.
        roles: run.traces.map((trace) => ({
          role: trace.role,
          status: trace.status,
          failure: trace.failure,
          durationMs: trace.durationMs,
        })),
      })),
    );
  });

  /**
   * Every role event across recent runs, newest first.
   *
   * The events already exist per role; this flattens them into one stream so
   * the dashboard can show a log without opening runs one at a time. Filtering
   * happens here rather than in the browser because the tail is what people
   * want and shipping every event to filter client-side would defeat the limit.
   */
  app.get('/api/logs', async (c) => {
    const limit = Math.min(Number(c.req.query('limit') ?? 200) || 200, 1000);
    const kind = c.req.query('kind');
    const role = c.req.query('role');
    const runId = c.req.query('run');

    const list = runId ? [await runs.load(runId)].filter((r) => r !== null) : await runs.list(50);

    const entries = list.flatMap((run) =>
      run.traces.flatMap((trace) =>
        trace.events.map((event) => ({
          at: event.at,
          kind: event.kind,
          text: event.text,
          role: trace.role,
          runId: run.id,
          commit: run.commit.shortSha,
          subject: run.commit.subject,
          /** `error` events are the ones worth surfacing on their own. */
          level: event.kind === 'error' ? 'error' : 'info',
        })),
      ),
    );

    const filtered = entries.filter(
      (entry) => (!kind || entry.kind === kind) && (!role || entry.role === role),
    );
    filtered.sort((a, b) => b.at.localeCompare(a.at));

    return c.json({
      entries: filtered.slice(0, limit),
      total: filtered.length,
      kinds: [...new Set(entries.map((entry) => entry.kind))].sort(),
    });
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

  /**
   * Start a run, unless one is already going.
   *
   * One writer per repository: two runs on the same repo drive the same
   * long-lived harness sessions concurrently, and the symbol map cannot absorb
   * that. Returns false when a run is already in flight.
   */
  const startRun = (commit: string): boolean => {
    if (activeRun) return false;

    activeRun = runPipeline(client, config, commit, {
      onRunUpdate: (run) => bus.publish('run', run),
      onRoleEvent: (role, event) => bus.publish('role', { role, event }),
    })
      .catch((err: unknown) => {
        bus.publish('error', { message: err instanceof Error ? err.message : String(err) });
      })
      .finally(() => {
        activeRun = null;
      });

    return true;
  };

  app.post('/api/runs', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { commit?: string };
    const commit = body.commit || 'HEAD';
    if (!startRun(commit)) return c.json({ error: 'A run is already in progress.' }, 409);
    return c.json({ started: true, commit });
  });

  /**
   * GitHub push webhook.
   *
   * GitHub gives a delivery about ten seconds before it times out, and a
   * five-role run takes minutes — so this answers immediately and does the work
   * afterwards. A delivery that is not a default-branch push is acknowledged and
   * ignored rather than rejected, which keeps GitHub from retrying it.
   */
  app.post('/webhook', async (c) => {
    const raw = Buffer.from(await c.req.arrayBuffer());
    const secret = process.env.GITHUB_WEBHOOK_SECRET ?? '';

    if (!secret) {
      return c.json({ error: 'GITHUB_WEBHOOK_SECRET is not set; refusing to accept webhooks.' }, 503);
    }
    if (!verifyWebhook(raw, c.req.header('x-hub-signature-256'), secret)) {
      return c.json({ error: 'bad signature' }, 401);
    }

    const event = c.req.header('x-github-event');
    const delivery = c.req.header('x-github-delivery') ?? 'unknown';
    if (event !== 'push') return c.json({ ok: true, ignored: event ?? 'no event header' });

    // SAFETY: the HMAC above proves this body came from GitHub with our secret,
    // and every field below is read as optional and checked before use.
    const payload = JSON.parse(raw.toString('utf8')) as {
      ref?: string;
      after?: string;
      repository?: { default_branch?: string; full_name?: string };
    };

    const defaultBranch = payload.repository?.default_branch;
    if (!defaultBranch || payload.ref !== `refs/heads/${defaultBranch}`) {
      return c.json({ ok: true, ignored: 'not the default branch' });
    }

    const commit = payload.after ?? 'HEAD';
    if (!startRun(commit)) {
      return c.json({ ok: true, ignored: 'a run is already in progress', delivery });
    }

    bus.publish('webhook', { delivery, commit, repository: payload.repository?.full_name });
    return c.json({ ok: true, queued: delivery, commit });
  });

  /**
   * What docxy is wired up to, and what is missing.
   *
   * Every integration reports the same shape so the dashboard can render them
   * uniformly, and each one that is not connected says which variables would
   * connect it rather than only that it is off.
   */
  app.get('/api/integrations', async (c) => {
    const github = appStatus();

    let harnessReachable = false;
    try {
      const res = await fetch(`${config.trueforge.baseUrl}/healthz`, {
        signal: AbortSignal.timeout(3000),
      });
      harnessReachable = res.ok;
    } catch {
      harnessReachable = false;
    }

    return c.json({
      integrations: [
        {
          id: 'trueforge',
          name: 'TrueForge',
          category: 'harness',
          summary: 'Runs the five agents and owns their long-lived sessions.',
          connected: harnessReachable,
          required: true,
          detail: config.trueforge.baseUrl,
          missing: harnessReachable
            ? []
            : ['Start it with `npx @truefoundry/trueforge@latest`, or set TRUEFORGE_BASE_URL.'],
          docs: 'guides/DEPLOY.md',
        },
        {
          id: 'nebius',
          name: 'Nebius Token Factory',
          category: 'models',
          summary: 'Serves every model the roles run on.',
          connected: Boolean(config.nebius.apiKey),
          required: true,
          detail: config.nebius.baseUrl,
          missing: config.nebius.apiKey ? [] : ['NEBIUS_API_KEY'],
          docs: 'README.md',
        },
        {
          id: 'neon',
          name: 'Neon Postgres',
          category: 'storage',
          summary:
            storageBackend() === 'postgres'
              ? 'Runs, sessions, and the symbol map are in Postgres.'
              : 'Runs, sessions, and the symbol map are JSON files in .docxy/.',
          connected: storageBackend() === 'postgres',
          required: false,
          detail: storageBackend() === 'postgres' ? 'postgres' : `${config.stateDir} (files)`,
          missing: storageBackend() === 'postgres' ? [] : ['DATABASE_URL'],
          docs: 'guides/DATABASE.md',
        },
        {
          id: 'github-app',
          name: 'GitHub App',
          category: 'source',
          summary: github.configured
            ? `Pull requests are opened by ${github.slug}[bot].`
            : 'Required to open pull requests. Docxy publishes only as the App.',
          connected: github.configured,
          required: true,
          detail: github.configured ? `${github.slug}[bot]` : 'not configured',
          missing: github.missing,
          docs: 'guides/GITHUB-APP.md',
        },
        {
          id: 'github-webhook',
          name: 'Push webhook',
          category: 'source',
          summary: 'Starts a run when someone pushes to the default branch.',
          connected: github.webhookSecretSet,
          required: false,
          detail: github.webhookSecretSet ? 'POST /webhook' : 'not accepting deliveries',
          missing: github.webhookSecretSet ? [] : ['GITHUB_WEBHOOK_SECRET'],
          docs: 'guides/GITHUB-APP.md',
        },
      ],
    });
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
