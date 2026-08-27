import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import type { TrueForge } from '@truefoundry/trueforge-sdk';
import type { Config, RoleName } from '../config.js';
import type { RunRecord } from '../types.js';
import { PACKAGE_ROOT } from '../paths.js';
import { createStores, storageBackend, type LogQuery } from '../pipeline/stores.js';
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
import { ApprovalError, deny, signOff, staleness } from '../approval/gate.js';
import { openPullRequest } from '../github/pr.js';
import { resolveCommit } from '../git/diff.js';

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

/**
 * A run reduced to what a list — or a live update — actually renders.
 *
 * Also what goes over the event stream. Broadcasting the whole `RunRecord` on
 * every role event meant every prompt, every raw model response, and every
 * proposed file body crossed the wire a dozen times per run, to every connected
 * browser, none of which the timeline draws. On a diff-heavy commit that is
 * megabytes of duplicated payload for a handful of rendered fields.
 */
function summarize(run: RunRecord) {
  return {
    id: run.id,
    repoPath: run.repoPath,
    commit: run.commit,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    scope: run.approval?.scope,
    pullRequestUrl: run.pullRequestUrl,
    durationMs: run.durationMs,
    totals: run.totals,
    /** Roles that failed without stopping the run, so a list can say so. */
    degraded: run.degraded,
    error: run.error,
    // One dot per role, in pipeline order. The whole run at a glance, and the
    // reason a listing does not need to fetch role bodies.
    roles: run.traces.map((trace) => ({
      role: trace.role,
      status: trace.status,
      failure: trace.failure,
      durationMs: trace.durationMs,
      // A role that needed three tries looks identical to a clean one without
      // this, which hides exactly the flakiness worth seeing.
      attempts: trace.attempts,
    })),
  };
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

  /**
   * Close out runs abandoned by a previous process.
   *
   * The lanes below live in memory, so any run still marked `running` when this
   * server starts belongs to a process that is gone — killed, crashed, or
   * redeployed mid-pipeline. Left alone it sits in the dashboard spinning
   * forever, which reads as "still working" when the truth is "nobody is
   * working on this". Marked failed, with the reason, it reads as what it is.
   */
  const reapAbandonedRuns = async (): Promise<void> => {
    try {
      const paths = await syncedPaths();
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
   * Shared with the CLI — see `syncedRepoPaths` — so the two cannot drift apart
   * on which runs exist. Wrapped here only to reuse the cached installation
   * listing above rather than fetching it again on every request.
   */
  const syncedPaths = async (): Promise<string[]> => {
    try {
      const installed = await installedRepos();
      return [...new Set([config.repoPath, ...installed.map((r) => checkoutPathFor(r.fullName))])];
    } catch {
      // The dashboard degrades to the local repository rather than to nothing.
      return [config.repoPath];
    }
  };

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
    const recent = await runs.list(200, await syncedPaths());

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
    const list = await runs.list(50, await syncedPaths());
    return c.json(list.map(summarize));
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
    const runId = c.req.query('run');
    const kind = c.req.query('kind');
    const role = c.req.query('role');

    const query: LogQuery = { limit };
    if (kind) query.kind = kind;
    if (role) {
      // SAFETY: an unknown role simply matches nothing, which is the right
      // answer for a query string naming a role that does not exist.
      query.role = role as RoleName;
    }
    // Scoped to the repositories this deployment is synced to, whether or not
    // a run was named. Naming one narrows the listing; it does not reach past
    // the filter. Run ids are printed in the dashboard's own URLs, so a `?run=`
    // that skipped this was the way to read another repository's role events
    // with nothing but a signed-in session.
    query.repoPaths = await syncedPaths();
    if (runId) query.runId = runId;

    return c.json(await runs.logs(query));
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
    return c.json(buildReport(await runs.list(limit, await syncedPaths())));
  });

  /**
   * A run by id, but only one this dashboard is synced to.
   *
   * `load` addresses the store by primary key and knows nothing about which
   * repositories the caller may see, so the scope check belongs here — and a
   * run outside it is reported as absent rather than forbidden, because
   * "forbidden" confirms the id names something real.
   */
  const scopedRun = async (id: string): Promise<RunRecord | null> => {
    const run = await runs.load(id);
    if (!run) return null;
    return (await syncedPaths()).includes(run.repoPath) ? run : null;
  };

  app.get('/api/runs/:id', async (c) => {
    const run = await scopedRun(c.req.param('id'));
    if (!run) return c.json({ error: 'No such run.' }, 404);
    const withStaleness = run.approval
      ? { ...run, approvalStaleness: staleness(run.approval, config) }
      : run;
    return c.json(withStaleness);
  });

  app.get('/api/runs/:id/files', async (c) => {
    const run = await scopedRun(c.req.param('id'));
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
  interface QueuedRun {
    commit: string;
    prepare?: () => Promise<Config>;
    /** Where it came from, for the log line when it finally starts. */
    source: string;
    /** Run even if this commit has already been documented. */
    force?: boolean;
  }

  /**
   * Runs waiting their turn.
   *
   * One writer per repository is a real constraint — two runs drive the same
   * long-lived harness sessions concurrently and the symbol map cannot absorb
   * that — but *dropping* the second one was the wrong way to enforce it. A
   * push that arrives while another run is going is not a mistake to reject; it
   * is work to do next. Dropped, the commit was never documented and nothing
   * anywhere said so, because GitHub had already been answered 200.
   */
  /**
   * One lane per repository.
   *
   * The constraint that matters is one writer *per repository*: two runs on the
   * same repo drive the same long-lived harness sessions and the same symbol
   * map, and neither can absorb that. A single global lock enforced it by
   * enforcing far more — a push to one repository waited behind an unrelated
   * run on another, and before the queue existed it was dropped outright.
   * Keying the lanes by repository keeps the invariant that is real and drops
   * the one that was incidental.
   */
  interface Lane {
    queue: QueuedRun[];
    active: Promise<unknown> | null;
    /** The commit running in this lane, for deduplicating a redelivery. */
    running: string | null;
  }

  const lanes = new Map<string, Lane>();
  /** Bounded so a burst of pushes cannot grow a lane without limit. */
  const QUEUE_LIMIT = 20;

  const laneFor = (key: string): Lane => {
    const existing = lanes.get(key);
    if (existing) return existing;
    const lane: Lane = { queue: [], active: null, running: null };
    lanes.set(key, lane);
    return lane;
  };

  /** Total depth across lanes, which is what the dashboard shows. */
  const totalDepth = (): number =>
    [...lanes.values()].reduce((sum, lane) => sum + lane.queue.length, 0);

  const drainLane = (key: string): void => {
    const lane = laneFor(key);
    if (lane.active || lane.queue.length === 0) return;
    const next = lane.queue.shift();
    if (!next) return;
    lane.running = next.commit;

    // `prepare` runs inside the same promise as the pipeline rather than before
    // it, because the caller has already answered GitHub and cannot await
    // anything: cloning a repository plus a five-role run is far past the ten
    // seconds a delivery is given. It also decides which checkout the run uses,
    // so a webhook can document the repository it names rather than whichever
    // directory the server happened to start in.
    lane.active = (async () => {
      const runConfig = next.prepare ? await next.prepare() : config;
      const result = await runPipeline(client, runConfig, next.commit, {
        force: next.force ?? false,
        onRunUpdate: (run) => bus.publish('run', summarize(run)),
        onRoleEvent: (role, event) => bus.publish('role', { role, event }),
      });
      // Not an error, and not silent either: a delivery that was already
      // handled should say so rather than look like a run that vanished.
      if (result.skipped) {
        console.log(`skipped ${next.commit.slice(0, 7)}: ${result.skipped.reason}`);
        bus.publish('skipped', { commit: next.commit, ...result.skipped });
      }
      return result;
    })()
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        // Also to stderr: a failure before the first role has no run record to
        // attach to, so the event bus is the only place it would otherwise go —
        // and nobody is watching an SSE stream at push time.
        console.error(`run for ${next.commit.slice(0, 7)} failed: ${message}`);
        bus.publish('error', { commit: next.commit, message });
      })
      .finally(() => {
        lane.active = null;
        lane.running = null;
        // Nothing left to do in this lane, and nothing waiting: forget it, so a
        // long-lived server does not accumulate one entry per repository it has
        // ever seen.
        if (lane.queue.length === 0) lanes.delete(key);
        bus.publish('queue', { depth: totalDepth() });
        // Synchronously after clearing `active`, so the next run in this lane
        // starts without waiting for anything to poll.
        drainLane(key);
      });
  };

  type EnqueueResult =
    | { accepted: true; queued: boolean; depth: number }
    | { accepted: false; reason: string };

  /**
   * Take a run, now or as soon as this repository's current one finishes.
   *
   * Deduplicated on the commit, against both the queue and the run already in
   * flight: GitHub retries a delivery it thinks failed, and a reviewer clicking
   * twice means one run, not two. Checking only the queue was not enough — a
   * run leaves the queue the moment it starts, so a redelivery arriving
   * mid-run found nothing to match.
   *
   * `commit` must already be a resolved SHA. Deduplication is only as good as
   * the identity it compares, and a symbolic ref is not one: `HEAD` matches
   * `HEAD` however far the branch moved in between. Callers resolve first.
   */
  const enqueueRun = (
    repoKey: string,
    commit: string,
    source: string,
    prepare?: () => Promise<Config>,
    force = false,
  ): EnqueueResult => {
    const lane = laneFor(repoKey);

    if (commit === lane.running || lane.queue.some((item) => item.commit === commit)) {
      // Already in hand. Reported as accepted, because it is: the commit will
      // be documented, and the caller does not need to know it asked twice.
      return { accepted: true, queued: true, depth: totalDepth() };
    }
    if (lane.queue.length >= QUEUE_LIMIT) {
      return {
        accepted: false,
        reason: `The run queue for ${repoKey} is full (${QUEUE_LIMIT} waiting). Try again once it drains.`,
      };
    }

    lane.queue.push(prepare ? { commit, prepare, source, force } : { commit, source, force });
    const willWait = Boolean(lane.active);
    drainLane(repoKey);
    bus.publish('queue', { depth: totalDepth() });
    return { accepted: true, queued: willWait, depth: totalDepth() };
  };

  app.post('/api/runs', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { commit?: string; force?: boolean };
    const ref = body.commit || 'HEAD';

    // Resolved before the queue ever sees it. The queue deduplicates on this
    // string, and `HEAD` is not the name of one commit: two clicks either side
    // of a push both said `HEAD`, the second matched the first, and the newer
    // commit was answered "accepted" without being queued or ever documented.
    let commit: string;
    try {
      commit = await resolveCommit(config.repoPath, ref);
    } catch {
      return c.json({ error: `Nothing in ${config.repoPath} resolves to "${ref}".` }, 400);
    }

    const result = enqueueRun(config.repoPath, commit, 'api', undefined, body.force === true);
    if (!result.accepted) return c.json({ error: result.reason }, 503);
    return c.json({ started: true, commit, queued: result.queued, depth: result.depth });
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

    const commit = payload.after;
    const repository = payload.repository?.full_name;
    if (!repository) {
      return c.json({ ok: true, ignored: 'payload carried no repository' });
    }
    // Falling back to `HEAD` here used to look harmless. It is the one string
    // the queue cannot deduplicate on, and it names a different commit in every
    // checkout — including one this delivery has not synced yet. A push event
    // without `after` is not a push this can identify, and it is acknowledged
    // rather than rejected so GitHub stops redelivering it.
    if (!commit) {
      return c.json({ ok: true, ignored: 'payload named no commit' });
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
    // Keyed by the repository the delivery names, which is what makes two
    // repositories' pushes independent of one another.
    const result = enqueueRun(repository, commit, `webhook ${delivery}`, async () => ({
      ...config,
      repoPath: await ensureCheckout(repository, defaultBranch, commit, pinned),
    }));

    if (!result.accepted) {
      // 503 rather than 200: this is the one case where GitHub retrying is
      // exactly what should happen, because the work genuinely was not taken.
      return c.json({ ok: false, error: result.reason, delivery }, 503);
    }

    bus.publish('webhook', { delivery, commit, repository });
    return c.json({
      ok: true,
      queued: delivery,
      commit,
      // A push during another run now waits its turn instead of being dropped.
      waiting: result.queued,
      depth: result.depth,
    });
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
    const run = await scopedRun(c.req.param('id'));
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
      // As in the CLI: the draft intent and the concerns were decided when the
      // run finished, and the sign-off does not overturn them.
      const pr = await openPullRequest(config, run, files, run.publication);
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
    const run = await scopedRun(c.req.param('id'));
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

  // Fire and forget, at construction, because it was written and then never
  // called: a run the previous process abandoned spins in the dashboard as
  // "still working" until something says otherwise, and nothing did. Not
  // awaited — the server must accept its first request whether or not the
  // store is reachable — and its own catch keeps a storage hiccup from taking
  // the boot down with it.
  void reapAbandonedRuns();

  return { app, bus };
}

export function startServer(client: TrueForge, config: Config): ServerHandle {
  const { app } = createServer(client, config);
  const server = serve({ fetch: app.fetch, port: config.server.port });

  // A listen failure arrives as an `error` event, and an `error` event with no
  // listener is a process-level throw — so the commonest mistake in local
  // development, a server already running, surfaced as a `node:net` stack
  // trace. Say what happened and what to do about it.
  server.on('error', (cause: NodeJS.ErrnoException) => {
    if (cause.code === 'EADDRINUSE') {
      console.error(
        `Port ${config.server.port} is already in use — docxy is very likely ` +
          `already running.\nStop it, or start this one elsewhere with ` +
          `DOCXY_PORT=<port> docxy serve`,
      );
      process.exit(1);
    }
    if (cause.code === 'EACCES') {
      console.error(
        `Not allowed to listen on port ${config.server.port}. Ports below 1024 ` +
          `need elevated privileges; pick a higher one with DOCXY_PORT.`,
      );
      process.exit(1);
    }
    throw cause;
  });

  return {
    port: config.server.port,
    close: () => server.close(),
  };
}

export type { RunRecord };
