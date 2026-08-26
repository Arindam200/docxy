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
import { stat } from 'node:fs/promises';
import { buildReport } from './observability.js';
import { rebuildProposedFiles, runPipeline } from '../pipeline/index.js';
import {
  checkoutPathFor,
  ensureCheckout,
  installationRepositories,
  type InstalledRepo,
} from '../github/checkout.js';
import { readAppCredentials } from '../github/app.js';
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

async function exists(path: string): Promise<boolean> {
  return stat(path)
    .then(() => true)
    .catch(() => false);
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

  /**
   * Close out runs abandoned by a previous process.
   *
   * `activeRun` lives in memory, so any run still marked `running` when this
   * server starts belongs to a process that is gone — killed, crashed, or
   * redeployed mid-pipeline. Left alone it sits in the dashboard spinning
   * forever, which reads as "still working" when the truth is "nobody is
   * working on this". Marked failed, with the reason, it reads as what it is.
   */
  const reapAbandonedRuns = async (): Promise<void> => {
    try {
      const paths = await syncedRepoPaths();
      for (const run of await runs.list(200, paths)) {
        if (run.status !== 'running') continue;
        run.status = 'failed';
        run.error =
          'The server restarted while this run was in flight, so it was abandoned. ' +
          'Nothing was published. Start it again from Activity.';
        run.finishedAt = new Date().toISOString();
        for (const trace of run.traces) {
          if (trace.status !== 'running') continue;
          trace.status = 'failed';
          trace.failure = 'aborted';
          trace.finishedAt = run.finishedAt;
        }
        await runs.save(run);
        bus.publish('run', run);
      }
    } catch (err) {
      // Housekeeping. A storage hiccup here must not stop the server booting.
      console.error(
        `could not reap abandoned runs: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  /**
   * Anything a route throws becomes JSON, not an empty 500.
   *
   * The dashboard reads every endpoint through one `fetch` that returns null on
   * a non-2xx, so a thrown route rendered as "offline" — indistinguishable from
   * the server being down, and with the actual cause only in a terminal nobody
   * was watching. A dropped database connection is the common case and it is
   * worth naming.
   */
  app.onError((err, c) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${c.req.method} ${c.req.path} failed: ${message}`);
    return c.json({ error: message }, 500);
  });

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

  /**
   * The repositories docxy is synced to.
   *
   * The GitHub App installation is the authority, not a local path. A checkout
   * on this machine is an implementation detail — it appears and disappears
   * with the server's disk — whereas "the App is installed on this repository"
   * is the fact that survives a redeploy, and it is the thing a user actually
   * did. Repositories are listed from the installation and *annotated* with
   * whether a checkout happens to exist, rather than the other way round.
   *
   * Cached for a minute: the dashboard polls, the list only changes when
   * somebody clicks something on github.com, and the API has a rate limit.
   */
  let repoCache: { at: number; value: InstalledRepo[] } | null = null;

  const installedRepos = async (): Promise<InstalledRepo[]> => {
    const credentials = readAppCredentials();
    if (!credentials) return [];
    if (repoCache && Date.now() - repoCache.at < 60_000) return repoCache.value;
    const value = await installationRepositories(credentials);
    repoCache = { at: Date.now(), value };
    return value;
  };

  /**
   * Every repository path whose runs belong on this dashboard.
   *
   * The configured path is always included — a developer pointing
   * `DOCXY_REPO_PATH` at a working tree is still using docxy — and so is the
   * managed checkout of each installed repository, because that is where a
   * webhook-driven run actually happened. Without this the dashboard showed
   * only the directory the server started in, and every webhook run was
   * invisible.
   */
  const syncedRepoPaths = async (): Promise<string[]> => {
    try {
      const installed = await installedRepos();
      return [...new Set([config.repoPath, ...installed.map((r) => checkoutPathFor(r.fullName))])];
    } catch {
      // The dashboard degrades to the local repository rather than to nothing.
      return [config.repoPath];
    }
  };

  // Deferred to here only because it needs `syncedRepoPaths`; it runs once, at
  // startup, and nothing waits on it.
  void reapAbandonedRuns();

  app.get('/api/repositories', async (c) => {
    let credentials;
    try {
      credentials = readAppCredentials();
    } catch (err) {
      return c.json({
        configured: false,
        repositories: [],
        localRepoPath: config.repoPath,
        pinned: Boolean(process.env.DOCXY_REPO_PATH?.trim()),
        error: err instanceof Error ? err.message : String(err),
      });
    }

    if (!credentials) {
      return c.json({
        configured: false,
        repositories: [],
        localRepoPath: config.repoPath,
        pinned: Boolean(process.env.DOCXY_REPO_PATH?.trim()),
        error:
          'The GitHub App is not configured, so docxy cannot tell which repositories ' +
          'it is installed on. Set GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY_PATH, and ' +
          'GITHUB_APP_INSTALLATION_ID — guides/GITHUB-APP.md walks through all three.',
      });
    }

    let installed: InstalledRepo[];
    try {
      installed = await installedRepos();
    } catch (err) {
      return c.json({
        configured: true,
        repositories: [],
        localRepoPath: config.repoPath,
        pinned: Boolean(process.env.DOCXY_REPO_PATH?.trim()),
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const pinned = Boolean(process.env.DOCXY_REPO_PATH?.trim());
    const recent = await runs.list(200, await syncedRepoPaths());

    const repositories = await Promise.all(
      installed.map(async (repo) => {
        const checkoutPath = checkoutPathFor(repo.fullName);
        // Matched on the managed checkout. The configured path only counts when
        // exactly one repository is installed — with several, attributing the
        // same local runs to all of them would be a guess dressed as a fact.
        const owned = recent.filter(
          (run) =>
            run.repoPath === checkoutPath ||
            (installed.length === 1 && run.repoPath === config.repoPath),
        );
        const last = owned[0];
        return {
          fullName: repo.fullName,
          defaultBranch: repo.defaultBranch,
          url: `https://github.com/${repo.fullName}`,
          checkoutPath,
          /** Whether the commits have been fetched here yet. Not what "synced" means. */
          hasCheckout: await exists(checkoutPath),
          runCount: owned.length,
          lastRunAt: last?.startedAt,
          lastRunId: last?.id,
          lastRunStatus: last?.status,
          lastPullRequestUrl: owned.find((run) => run.pullRequestUrl)?.pullRequestUrl,
        };
      }),
    );

    return c.json({
      configured: true,
      repositories,
      localRepoPath: config.repoPath,
      /** True when DOCXY_REPO_PATH overrides the installation's own checkout. */
      pinned,
      error: null,
    });
  });

  app.get('/api/runs', async (c) => {
    const list = await runs.list(50, await syncedRepoPaths());
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
        /** Roles that failed without stopping the run, so a list can say so. */
        degraded: run.degraded,
        error: run.error,
        // One dot per role, in pipeline order. The whole run at a glance, and
        // the reason a listing does not need to fetch role bodies.
        roles: run.traces.map((trace) => ({
          role: trace.role,
          status: trace.status,
          failure: trace.failure,
          durationMs: trace.durationMs,
          // A role that needed three tries looks identical to a clean one
          // without this, which hides exactly the flakiness worth seeing.
          attempts: trace.attempts,
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

    const list = runId
      ? [await runs.load(runId)].filter((r) => r !== null)
      : await runs.list(50, await syncedRepoPaths());

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

  /**
   * Cross-run aggregates: reliability per role, spend, and what goes stale.
   *
   * Derived on read rather than stored. Runs are the source of truth and the
   * window is small enough that recomputing costs less than keeping a second
   * copy of the same numbers correct.
   */
  app.get('/api/observability', async (c) => {
    const limit = Math.min(Number(c.req.query('limit') ?? 50) || 50, 200);
    return c.json(buildReport(await runs.list(limit, await syncedRepoPaths())));
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
  const startRun = (commit: string, prepare?: () => Promise<Config>): boolean => {
    if (activeRun) return false;

    // `prepare` runs inside the same promise as the pipeline rather than before
    // it, because the caller has already answered GitHub and cannot await
    // anything: cloning a repository plus a five-role run is far past the ten
    // seconds a delivery is given. It also decides which checkout the run uses,
    // so a webhook can document the repository it names rather than whichever
    // directory the server happened to start in.
    activeRun = (async () => {
      const runConfig = prepare ? await prepare() : config;
      return runPipeline(client, runConfig, commit, {
        onRunUpdate: (run) => bus.publish('run', run),
        onRoleEvent: (role, event) => bus.publish('role', { role, event }),
      });
    })()
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        // Also to stderr: a failure before the first role has no run record to
        // attach to, so the event bus is the only place it would otherwise go —
        // and nobody is watching an SSE stream at push time.
        console.error(`run for ${commit.slice(0, 7)} failed: ${message}`);
        bus.publish('error', { commit, message });
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
    const repository = payload.repository?.full_name;
    if (!repository) {
      return c.json({ ok: true, ignored: 'payload carried no repository' });
    }

    // The delivery names a commit the checkout has probably never seen — it was
    // authored wherever the pusher was, not here. Sync it first or the run dies
    // in `resolveCommit` before any role starts.
    //
    // An explicit DOCXY_REPO_PATH still wins, so a developer can point the
    // server at a working tree they are editing. With nothing set, the
    // repository named in the payload is the one documented: that is the one
    // the App was installed on, which is the only thing that survives the
    // server being restarted somewhere else.
    const pinned = process.env.DOCXY_REPO_PATH?.trim() ? config.repoPath : undefined;
    const started = startRun(commit, async () => ({
      ...config,
      repoPath: await ensureCheckout(repository, defaultBranch, commit, pinned),
    }));
    if (!started) {
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
