import { randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { dirname, join } from 'node:path';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { serve } from '@hono/node-server';
import type { Config, RoleName } from '../config.js';
import type { RunRecord } from '../types.js';
import type { KnowledgeMap } from '../pipeline/state.js';
import { PACKAGE_ROOT } from '../paths.js';
import { createStores, storageBackend, type LogQuery } from '../pipeline/stores.js';
import { workspaceConfigured } from '../validate/workspace.js';
import type {
  DocxyConfig,
  IntegrationsPage,
  ProjectRollupsPage,
  RunSummary,
  SkipKind,
  SkippedCommit,
  SkippedCommitsPage,
  StartProjectRunRefusal,
  StartProjectRunResult,
  Tracking,
} from '../api/contract.js';
import { clearSkip, recordSkip, skipsForProject, type SkippedCommitRef } from '../db/skip-store.js';
import {
  admitRun,
  allowancesEnforced,
  openReservation,
  settleReservation,
  type Admission,
  type Settlement,
  type SettlementDetails,
} from '../billing/admission.js';
import { appStatus, verifyWebhook } from '../github/app.js';
import { stat } from 'node:fs/promises';
import { buildReport, rollUpProject } from './observability.js';
import { rebuildProposedFiles, runPipeline } from '../pipeline/index.js';
import {
  checkoutPathFor,
  ensureCheckout,
  installationRepositories,
  type InstalledRepo,
} from '../github/checkout.js';
import { readAppCredentials } from '../github/app.js';
import { staleness } from '../approval/gate.js';
import { BranchConflictError, openPullRequest, StaleProposalError } from '../github/pr.js';
import { resolveCommit } from '../git/diff.js';
import { deliveryAllowed } from './allowlist.js';
import { databaseConfigured } from '../db/index.js';
import {
  bindInstallation,
  installationsForOrganization,
  InstallationOwnedError,
  type Installation,
} from '../db/installation-store.js';
import {
  CheckoutPathTakenError,
  connectedSourceRepos,
  createProject,
  deleteProject,
  projectForCheckoutPath,
  projectForSourceRepo,
  projectsForOrganization,
  SourceRepoTakenError,
  type NewProject,
} from '../db/project-store.js';

/**
 * What an event is about, and therefore who is allowed to be told about it.
 *
 * Every publish names the repository checkout it concerns, or the organization
 * it concerns when it concerns no repository. An event that names neither is
 * about the deployment and reaches everyone; nothing published today is in that
 * category, and a new one should have to justify itself.
 */
export interface EventScope {
  /** The checkout this event happened in. */
  repoPath?: string;
  /** The organization this event belongs to, when it is not about a checkout. */
  organizationId?: string;
}

/** What one connected browser is allowed to see. */
export interface EventAudience {
  /** The checkouts this subscriber's organization has connected as projects. */
  paths: string[];
  /** Absent on a deployment with no database, where there is one tenant. */
  organizationId?: string;
}

/**
 * Whether one subscriber may see one event.
 *
 * Exported because it is the tenant boundary of the live feed and the boundary
 * is worth testing without standing a server up. Both dimensions are checked
 * when both are present, and a scope dimension the event does not carry is not
 * a dimension it passes by default - it is one the event is not about.
 */
export function eventVisible(scope: EventScope, to: EventAudience): boolean {
  if (scope.repoPath !== undefined && !to.paths.includes(scope.repoPath)) return false;
  if (scope.organizationId !== undefined && scope.organizationId !== to.organizationId) {
    return false;
  }
  return true;
}

/**
 * Fan-out for server-sent events, so the timeline updates while a run is live.
 *
 * Fan-out used to mean every client, which was survivable only while every
 * account on the deployment belonged to the same person: a run in one
 * organization's repository pushed its commit subject, its status and its role
 * timings to every browser holding a stream open. Each subscriber now carries
 * the scope it was opened with, and each publish carries the scope it belongs
 * to - see `eventVisible`.
 */
class Broadcaster {
  private readonly clients = new Set<{ send: (chunk: string) => void; to: EventAudience }>();

  add(send: (chunk: string) => void, to: EventAudience): () => void {
    const client = { send, to };
    this.clients.add(client);
    return () => this.clients.delete(client);
  }

  publish(event: string, data: unknown, scope: EventScope = {}): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this.clients) {
      if (!eventVisible(scope, client.to)) continue;
      try {
        client.send(payload);
      } catch {
        this.clients.delete(client);
      }
    }
  }
}

/**
 * A run reduced to what a list - or a live update - actually renders.
 *
 * Also what goes over the event stream. Broadcasting the whole `RunRecord` on
 * every role event meant every prompt, every raw model response, and every
 * proposed file body crossed the wire a dozen times per run, to every connected
 * browser, none of which the timeline draws. On a diff-heavy commit that is
 * megabytes of duplicated payload for a handful of rendered fields.
 */
function summarize(run: RunRecord): RunSummary {
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

/**
 * Constant-time comparison of the API's shared secret against what a caller
 * offered. Exported so the rule can be tested without standing a server up.
 *
 * Length is checked first because `timingSafeEqual` throws on a length
 * mismatch, and the length of the secret is not the part worth hiding.
 */
export function tokenMatches(expected: string, offered: string | undefined): boolean {
  const value = offered?.replace(/^Bearer\s+/i, '').trim() ?? '';
  // Compare the buffers' byte lengths, not the strings'. A JavaScript string
  // length counts UTF-16 units, so a header of non-ASCII characters can match
  // the expected length and still produce a longer buffer - and
  // `timingSafeEqual` throws on that, turning a wrong password into a 500.
  const a = Buffer.from(value, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * What a failed request may tell its caller about why.
 *
 * Drizzle reports a failed statement as `Failed query: <the SQL>` followed by
 * `params: <every bound value>`, with the driver's own error as its cause. The
 * route error handler returned that message verbatim, and the dashboard proxy
 * forwards it to the browser - so any query that failed showed a signed-in
 * user the schema and whatever values were bound into it, which can be
 * another tenant's ids or a commit message. The cause is the part worth
 * showing ("Connection terminated unexpectedly"); the statement is for the
 * server log, which still gets all of it.
 */
export function publicErrorMessage(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  if (err.message.startsWith('Failed query:')) {
    const cause = err.cause instanceof Error ? err.cause.message.split('\n')[0]?.trim() : '';
    return cause ? `Database error: ${cause}` : 'A database query failed.';
  }
  return err.message;
}

/**
 * The largest request bodies the server will read.
 *
 * Nothing bounded them, and the webhook reads its whole body into memory
 * *before* it can check the signature - so anyone who could reach the port
 * could make the process buffer as much as they cared to send. GitHub caps a
 * delivery at 25 MB; nothing the dashboard sends comes near a megabyte (the
 * largest field, standing instructions, is capped at 20,000 characters).
 */
export const BODY_LIMITS = { webhook: 25 * 1024 * 1024, api: 1024 * 1024 } as const;

// Which repositories a delivery may start a run for is decided by the projects
// somebody connected - not by what the App happens to be installed on - and may
// be narrowed further by `DOCXY_ALLOWED_REPOS`. `deliveryAllowed` in
// ./allowlist.ts holds that reading, and the reason it hands back to the
// webhook.

/** GitHub sends a full object name in `after`; anything else is not a push. */
export function isCommitSha(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

/**
 * Whether a bind address keeps the server on this machine.
 *
 * Anything else is reachable by something that is not this process's operator,
 * which is what makes an absent API token a problem rather than a preference.
 */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
  // `127.` with the dot, so `1270.0.0.1` is not mistaken for a loopback octet.
  return host === 'localhost' || host === '::1' || host.startsWith('127.');
}

/**
 * The repository a queued run syncs and documents.
 *
 * Plain data, because it is written to disk when the process stops with runs
 * still waiting and read back by the next one.
 */
export interface RunOrigin {
  /** `owner/name`, as GitHub spells it. */
  repository: string;
  defaultBranch: string;
  /** A working tree the operator pinned with DOCXY_REPO_PATH, used as-is. */
  pinned?: string;
}

/** How a queued run is to be run. */
export interface RunOptions {
  /** Run even if this commit has already been documented. */
  force?: boolean;
  /** Ask Jev first. Pushes only; see `src/triage.ts`. */
  triage?: boolean;
  /** Finish this interrupted run rather than starting a new one. */
  resume?: string;
  /**
   * The allowance slot this run was admitted on (`src/billing/admission.ts`),
   * settled when the run ends: consumed when it produced a run, released when
   * it was skipped or failed. Absent where allowances are not enforced.
   */
  reservation?: string;
}

/**
 * Whether a run found in flight at boot may be resumed.
 *
 * Two limits, so a run that keeps taking the process down cannot keep doing
 * it: at most two resumes, and only within six hours of starting - past that
 * the commit has likely been superseded, and the run's sessions with it.
 */
export function resumeVerdict(
  startedAt: string,
  attempts: number,
  now: number,
): { resume: true } | { resume: false; why: string } {
  if (attempts >= 2) return { resume: false, why: `it had already been resumed ${attempts} times` };
  const started = Date.parse(startedAt);
  if (Number.isNaN(started) || now - started > 6 * 60 * 60 * 1000) {
    return { resume: false, why: 'it had started too long ago to resume' };
  }
  return { resume: true };
}

/** The app to serve, and the bus the pipeline publishes run events onto. */
export interface ServerParts {
  app: Hono;
  bus: Broadcaster;
  /**
   * Stop starting runs, give the ones in flight `graceMs` to finish, and write
   * down whatever is still waiting for the next process. Resolves when it is
   * safe to exit; anything still running then is resumed on the next boot.
   */
  shutdown: (graceMs: number) => Promise<void>;
}

export function createServer(config: Config): ServerParts {
  const app = new Hono();
  const { runs, knowledge: knowledgeStore } = createStores(config);
  const bus = new Broadcaster();

  /**
   * Close out a run a previous process left in flight and nobody will finish.
   *
   * Left alone it sits in the dashboard spinning forever, which reads as
   * "still working" when the truth is "nobody is working on this". Marked
   * failed, with the reason, it reads as what it is. Most interrupted runs are
   * resumed instead - see `recoverInterruptedRuns` - and this is for the ones
   * that cannot be.
   */
  /** The allowance slot an interrupted run was admitted on, if it holds one. */
  const reservationOf = async (run: RunRecord): Promise<string | null> => {
    if (!databaseConfigured()) return null;
    try {
      const project = await projectForCheckoutPath(run.repoPath);
      return project ? await openReservation(project.id, run.commit.sha) : null;
    } catch {
      return null;
    }
  };

  const abandonRun = async (run: RunRecord, why: string): Promise<void> => {
    // Nobody will finish it, so nothing is charged for it.
    const reservation = await reservationOf(run);
    if (reservation) await settleReservation(reservation, 'released', { runId: run.id, reason: `abandoned: ${why}` }).catch(() => false);
    run.status = 'failed';
    run.error = `The server restarted while this run was in flight, and ${why}. Nothing was published. Start it again from Activity.`;
    run.finishedAt = new Date().toISOString();
    for (const trace of run.traces) {
      if (trace.status !== 'running') continue;
      trace.status = 'failed';
      trace.failure = 'aborted';
      trace.finishedAt = run.finishedAt;
    }
    await runs.save(run);
    bus.publish('run', summarize(run), { repoPath: run.repoPath });
  };

  /**
   * Anything a route throws becomes JSON, not an empty 500.
   *
   * The dashboard reads every endpoint through one `fetch` that returns null on
   * a non-2xx, so a thrown route rendered as "offline" - indistinguishable from
   * the server being down, and with the actual cause only in a terminal nobody
   * was watching. A dropped database connection is the common case and it is
   * worth naming.
   */
  app.onError((err, c) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${c.req.method} ${c.req.path} failed: ${message}`);
    return c.json({ error: publicErrorMessage(err) }, 500);
  });

  // Before anything reads a body, including the signature check, which has to
  // read all of it. See BODY_LIMITS.
  const tooLarge = (limit: number) => (c: { json: (body: unknown, status: 413) => Response }) =>
    c.json({ error: `Request body exceeds ${Math.round(limit / 1024)} KiB.` }, 413);
  app.use('/webhook', bodyLimit({ maxSize: BODY_LIMITS.webhook, onError: tooLarge(BODY_LIMITS.webhook) }));
  app.use('/api/*', bodyLimit({ maxSize: BODY_LIMITS.api, onError: tooLarge(BODY_LIMITS.api) }));

  /**
   * The API's own front door.
   *
   * Better Auth guards the Next.js proxy, but the proxy is not the only way
   * here: the deployed entry point binds `0.0.0.0`, and these routes approve
   * runs, open pull requests and rewrite the standing instructions the agents
   * read. A caller that can reach the port would otherwise skip the sign-in
   * entirely, which makes the approval gate decorative.
   *
   * `/webhook` is exempt because it carries its own proof - an HMAC over the
   * body with the App's secret - and GitHub cannot be asked to send a bearer
   * token. `/` and `/health` are exempt because they are the landing page and
   * the platform's liveness probe, and neither reads a run.
   */
  /**
   * No percent-encoding in an API path.
   *
   * Hono routes on the decoded path, but whoever forwarded the request decided
   * what it was allowed to reach by reading the encoded one. The dashboard
   * proxy scopes `/api/runs` to the caller's organization; `/api/%72uns` read
   * as an unscoped path there and as `/api/runs` here, with whatever
   * `organizationId` the caller wrote. No route here takes an id that needs
   * escaping, so an encoded path is refused rather than interpreted.
   */
  app.use('/api/*', async (c, next) => {
    if (new URL(c.req.url).pathname.includes('%')) {
      return c.json({ error: 'Encoded characters are not accepted in API paths.' }, 400);
    }
    return next();
  });

  app.use('/api/*', async (c, next) => {
    const expected = config.server.apiToken;
    if (!expected) return next();

    if (!tokenMatches(expected, c.req.header('authorization'))) {
      return c.json({ error: 'This API requires DOCXY_API_TOKEN as a bearer token.' }, 401);
    }
    return next();
  });

  /**
   * The built-in page, and why it stands down when a token is set.
   *
   * This page drives itself from the browser: `fetch('/api/...')` and an
   * `EventSource` on `/api/events`, neither carrying a credential. That is
   * exactly right for `docxy serve` on loopback, and impossible once the API
   * wants a bearer token - `EventSource` cannot send headers at all, so the
   * live feed would fail no matter what the page did.
   *
   * A token means this is a deployment, and a deployment's operator UI is the
   * Next dashboard. Serving a second dashboard that silently 401s on every
   * panel is worse than not serving one, so it says what it is instead.
   */
  app.get('/', async (c) => {
    if (config.server.apiToken) {
      return c.html(
        `<!doctype html><meta charset="utf-8"><title>docxy API</title>` +
          `<style>body{font:16px/1.6 system-ui,sans-serif;max-width:34rem;margin:20vh auto;padding:0 1.5rem}` +
          `code{background:#f4f4f5;padding:.15em .4em;border-radius:.25rem}</style>` +
          `<h1>docxy API</h1>` +
          `<p>This API requires <code>DOCXY_API_TOKEN</code> as a bearer token, so the ` +
          `built-in page cannot drive it from a browser. Use the dashboard, which holds ` +
          `the token server-side.</p>` +
          `<p><code>GET /health</code> is open, and reports whether a model key and a ` +
          `workspace are configured.</p>`,
      );
    }
    const html = await readFile(join(PACKAGE_ROOT, 'src/server/public/index.html'), 'utf8');
    return c.html(html);
  });

  app.get('/api/config', (c) =>
    c.json<DocxyConfig>({
      repoPath: config.repoPath,
      provider: config.nebius.providerName,
      models: config.models,
      validationEnabled: config.validation.enabled,
      storage: storageBackend(),
    }),
  );

  /**
   * Free-form standing instructions the Docs Updater and Changelog Author read.
   *
   * One file per organization, because a house style is the clearest statement
   * a team makes about its own writing and it used to be a single file every
   * organization on the deployment could read *and overwrite*. The path is
   * built from the organization id, which Better Auth generates, and is checked
   * against a strict pattern anyway - this value ends up in a filesystem path,
   * so it is never trusted to be shaped the way it should be.
   *
   * `instructionsPath(undefined)` is the pre-organization file, still read by
   * deployments with no database. See `standingInstructionsFor` in the pipeline
   * for the matching fallback on the reading side.
   */
  const instructionsPath = (organizationId: string | undefined): string | null => {
    if (!organizationId) return join(config.stateDir, 'instructions.md');
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(organizationId)) return null;
    return join(config.stateDir, 'instructions', `${organizationId}.md`);
  };

  /**
   * The instructions file this request may touch, or null to refuse.
   *
   * Null covers both "named no organization" and "named one that could not be a
   * real id", and both are answered with the same 400. Distinguishing them
   * would only tell a caller which guess got closer.
   */
  const requestInstructionsPath = (organizationId: string | undefined): string | null => {
    if (!databaseConfigured()) return instructionsPath(undefined);
    const id = organizationId?.trim();
    return id ? instructionsPath(id) : null;
  };

  app.get('/api/instructions', async (c) => {
    const file = requestInstructionsPath(c.req.query('organizationId'));
    if (!file) return c.json(noOrganization, 400);
    try {
      const text = await readFile(file, 'utf8');
      return c.json({ instructions: text, updatedAt: null });
    } catch {
      return c.json({ instructions: '', updatedAt: null });
    }
  });

  app.put('/api/instructions', async (c) => {
    const organizationId = c.req.query('organizationId')?.trim() || undefined;
    const file = requestInstructionsPath(organizationId);
    if (!file) return c.json(noOrganization, 400);
    // SAFETY: a body that is not JSON falls back to `{}`, and every field below is optional and checked before use.
    const body = (await c.req.json().catch(() => ({}))) as { instructions?: string };
    if (typeof body.instructions !== 'string') {
      return c.json({ error: 'A string body field `instructions` is required.' }, 400);
    }
    if (body.instructions.length > 20_000) {
      return c.json({ error: 'Instructions are capped at 20,000 characters.' }, 413);
    }
    await mkdir(dirname(file), { recursive: true });
    const updatedAt = new Date().toISOString();
    await writeFile(file, body.instructions, 'utf8');
    // The one event that belongs to an organization rather than to a checkout:
    // a house style is written once and read by every project under it.
    bus.publish('instructions', { updatedAt }, { organizationId });
    return c.json({ instructions: body.instructions, updatedAt });
  });

  /**
   * What the pipeline is watching for a repository.
   *
   * Single-tenant, that is the server's own checkout. On a database-backed
   * deployment it is one project's, named by `projectId` and checked against
   * the caller's organization like every other scoped read. It used to answer
   * with the host's own map to anyone signed in, and - because the knowledge
   * store resolves its project by upserting one - left an ownerless project
   * row behind for the host's checkout path on the way.
   */
  app.get('/api/tracking', async (c) => {
    let knowledge: KnowledgeMap;
    let tracking: Pick<Tracking, 'repoPath' | 'docsBranch' | 'docsRoots' | 'changelogPath'>;
    if (databaseConfigured()) {
      const organizationId = c.req.query('organizationId')?.trim();
      const projectId = c.req.query('projectId')?.trim();
      if (!organizationId || !projectId) {
        return c.json({ error: 'Name the project: organizationId and projectId are required.' }, 400);
      }
      const project = (await projectsForOrganization(organizationId)).find((p) => p.id === projectId);
      if (!project) return c.json({ error: 'No such project.' }, 404);
      knowledge = await createStores({ ...config, repoPath: project.key }).knowledge.load();
      tracking = {
        repoPath: project.sourceRepo ?? project.name ?? '',
        docsBranch: config.docs.branch,
        docsRoots: project.docsRoots
          ? project.docsRoots.split(',').map((entry) => entry.trim()).filter(Boolean)
          : config.docs.roots,
        changelogPath: config.docs.changelogPath,
      };
    } else {
      knowledge = await knowledgeStore.load();
      tracking = {
        repoPath: config.repoPath,
        docsBranch: config.docs.branch,
        docsRoots: config.docs.roots,
        changelogPath: config.docs.changelogPath,
      };
    }
    // Doc paths are derived from the symbol map: every section the Impact
    // Mapper has ever linked a symbol to is, by definition, tracked.
    const trackedDocs = [...new Set(Object.values(knowledge.symbols).flat())].sort();
    const body: Tracking = {
      ...tracking,
      trackedDocs,
      symbolCount: Object.keys(knowledge.symbols).length,
      symbols: knowledge.symbols,
      processedCommits: knowledge.processedCommits.length,
      knowledgeUpdatedAt: knowledge.updatedAt,
    };
    return c.json(body);
  });

  /**
   * The repositories docxy is synced to.
   *
   * The GitHub App installation is the authority, not a local path. A checkout
   * on this machine is an implementation detail - it appears and disappears
   * with the server's disk - whereas "the App is installed on this repository"
   * is the fact that survives a redeploy, and it is the thing a user actually
   * did. Repositories are listed from the installation and *annotated* with
   * whether a checkout happens to exist, rather than the other way round.
   *
   * Cached for a minute: the dashboard polls, the list only changes when
   * somebody clicks something on github.com, and the API has a rate limit.
   */
  let repoCache: { at: number; value: InstalledRepo[] } | null = null;
  /**
   * The listing in flight, shared by everyone who asks while it is.
   *
   * The cache only helps once a listing has landed. When it expired, every
   * request that arrived before the next one finished - a dashboard page asks
   * from several components at once, and pushes arrive in bursts - started its
   * own paginated walk of the installation, spending the App's rate limit on
   * the same answer several times over.
   */
  let repoFetch: Promise<InstalledRepo[]> | null = null;

  const installedRepos = async (): Promise<InstalledRepo[]> => {
    const credentials = readAppCredentials();
    if (!credentials) return [];
    if (repoCache && Date.now() - repoCache.at < 60_000) return repoCache.value;
    repoFetch ??= installationRepositories(credentials)
      .then((value) => {
        repoCache = { at: Date.now(), value };
        return value;
      })
      .finally(() => {
        repoFetch = null;
      });
    return repoFetch;
  };

  /**
   * One repository the App is installed on, by full name, or null.
   *
   * A lookup failure is "nothing known" rather than an error: every caller
   * refuses on null, which is the right answer to "is it installed?" when the
   * question could not be asked.
   */
  const installedRepo = async (fullName: string): Promise<InstalledRepo | null> => {
    const installed = await installedRepos().catch((): InstalledRepo[] => []);
    return installed.find((repo) => repo.fullName.toLowerCase() === fullName.toLowerCase()) ?? null;
  };

  /**
   * The repositories somebody actually connected, or null on a deployment that
   * has no projects.
   *
   * This is what decides whether a push runs - see `deliveryAllowed`. It is a
   * separate question from `installedRepos` above, and keeping the two apart is
   * the whole point: choosing *All repositories* on GitHub's install screen is
   * how most people install an App, and it must not be read as "document
   * everything I own".
   *
   * Not cached. It changes the moment somebody connects a repository in the
   * dashboard, and the first push after that should run rather than wait out a
   * cache; it is one indexed column read against a table with a row per
   * project. Failures propagate rather than degrading to null, because "the
   * database is down" is not the same answer as "this deployment has no
   * projects" and the callers need to tell them apart.
   */
  const connectedRepos = async (): Promise<string[] | null> => {
    if (!databaseConfigured()) return null;
    return connectedSourceRepos();
  };

  /**
   * Every repository path on this deployment, regardless of who owns it.
   *
   * Shared with the CLI - see `syncedRepoPaths` - so the two cannot drift apart
   * on which runs exist. Wrapped here only to reuse the cached installation
   * listing above rather than fetching it again on every request.
   *
   * Deployment-wide, so it is not an answer to "what may this caller see". It
   * is the right scope for the CLI, the webhook, and the bundled operator page,
   * all of which act for the deployment itself. Anything serving the dashboard
   * wants `organizationPaths` instead.
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

  /**
   * The repository paths one organization may see.
   *
   * Runs, logs and role events are addressed by repository path, and a project
   * row is the only thing that says which organization a path belongs to. So
   * the projects table is the tenant boundary: a path with no project row is
   * nobody's, and a path belonging to another organization is not returned at
   * all.
   *
   * Note what is *not* here. `config.repoPath` - the pipeline host's own
   * checkout - is deployment state rather than customer data, and installed
   * repositories are not included merely for being installed: an installation
   * is claimed by an organization, but the App can be installed on repositories
   * nobody has connected yet. Only a connected project grants visibility.
   *
   * An organization with no projects gets an empty list, which reads downstream
   * as "no runs" rather than as "no filter". That distinction is the whole
   * point: an empty filter used to mean everything.
   */
  const organizationPaths = async (organizationId: string): Promise<string[]> => {
    const owned = await projectsForOrganization(organizationId);
    return [...new Set(owned.map((project) => project.key).filter(Boolean))];
  };

  /**
   * The scope for a dashboard request, or null when it named no organization.
   *
   * The id is read from the query string because the pipeline has no session of
   * its own: it authenticates the dashboard's proxy with a shared token and
   * takes the tenant as a parameter. That is only safe because the proxy
   * overwrites the parameter from the session before forwarding - see
   * ORGANIZATION_SCOPED in the dashboard's /api/docxy route. Anything that
   * reaches this API with a token and a hand-written organizationId is already
   * inside the trust boundary.
   *
   * Returning null rather than falling back to `syncedPaths()` is deliberate.
   * A missing parameter once meant "show everything", which is how a signed-in
   * account on one organization could read another's runs. The callers below
   * turn null into a 400.
   *
   * The one deployment that still sees everything is the one with no database:
   * organizations live in Postgres, so without it there is no second tenant to
   * be confused with and "everything" and "mine" are the same set. That is the
   * single-repository install and the demo, and it is a property of the
   * deployment rather than a flag anyone can pass.
   */
  const requestPaths = async (organizationId: string | undefined): Promise<string[] | null> => {
    if (!databaseConfigured()) return syncedPaths();
    const id = organizationId?.trim();
    if (!id) return null;
    return organizationPaths(id);
  };

  /**
   * The scope for a dashboard request, narrowed to one project when it named
   * one.
   *
   * The dashboard is organized around projects rather than around the
   * organization as a whole, so its run, log and aggregate reads each ask about
   * one repository. Narrowing here rather than in the browser is not a
   * refinement: `runs.list` takes the newest fifty runs across the scope, so a
   * quiet project's runs vanish from an organization-wide window as soon as a
   * busier one fills it.
   *
   * A `projectId` outside the caller's organization narrows to nothing rather
   * than reaching past the filter, which reads downstream as "no runs" - the
   * same convention `organizationPaths` establishes for an organization that
   * owns nothing. It is deliberately not a 404: saying which ids exist is
   * information the caller has not earned.
   *
   * Deployments with no database have no project rows at all, so there is
   * nothing to narrow by and the id is ignored.
   */
  const requestScope = async (
    organizationId: string | undefined,
    projectId: string | undefined,
  ): Promise<string[] | null> => {
    if (!databaseConfigured()) return syncedPaths();
    const organization = organizationId?.trim();
    if (!organization) return null;

    // One read of the organization's projects serves both the scope and the
    // narrowing; this used to ask for the same rows twice per request.
    const owned = await projectsForOrganization(organization);
    const id = projectId?.trim();
    if (!id) return [...new Set(owned.map((project) => project.key).filter(Boolean))];
    const project = owned.find((candidate) => candidate.id === id);
    return project?.key ? [project.key] : [];
  };

  /** The 400 every scoped endpoint returns when no organization was named. */
  const noOrganization = { error: 'organizationId is required.' } as const;

  /**
   * Claim a GitHub App installation for an organization.
   *
   * Called by the dashboard the moment GitHub redirects somebody back from
   * installing the App - which is the only moment when the installation id and
   * the person who created it are known at the same time. Waiting for the first
   * push instead would mean a webhook that names an installation nobody owns.
   *
   * Idempotent, because GitHub sends people back here again on every
   * installation update when "Redirect on update" is on.
   */
  app.post('/api/installations', async (c) => {
    if (!databaseConfigured()) {
      // The JSON stores document one repository and have no concept of whose it
      // is. Saying so is better than accepting the call and dropping it.
      return c.json(
        {
          error:
            'This deployment stores state in .docxy/, which has no organizations. ' +
            'Set DATABASE_URL to bind installations to one.',
        },
        409,
      );
    }

    // SAFETY: every field is read through String() below, so the assertion
    // claims only that this is an object with unknown properties - which a
    // parsed JSON body either is, or is null, which the optional chaining
    // covers.
    const body = (await c.req.json().catch(() => null)) as {
      installationId?: unknown;
      accountLogin?: unknown;
    } | null;

    const installationId = String(body?.installationId ?? '').trim();
    const accountLogin = String(body?.accountLogin ?? '').trim();

    /*
     * The tenant comes from the query, never from the body.
     *
     * It used to be read from the body, and that was a cross-tenant claim. The
     * dashboard proxy establishes the tenant by overwriting `organizationId` in
     * the *query string* from the session, and forwards the body untouched - so
     * an endpoint reading the body read whatever the browser typed. Any signed-
     * in account could bind an installation into an organization it had nothing
     * to do with, and skip the GitHub ownership check that the dashboard's
     * callback route performs before it ever calls this.
     *
     * Taking it from the query puts this endpoint under the same rule as every
     * other tenant-scoped route, which is the only reason the proxy's overwrite
     * means anything.
     */
    const organizationId = c.req.query('organizationId')?.trim() ?? '';

    if (!installationId || !organizationId) {
      return c.json(
        { error: 'installationId (body) and organizationId (query) are both required.' },
        400,
      );
    }

    const installation: Installation = { installationId, organizationId };
    if (accountLogin) installation.accountLogin = accountLogin;

    try {
      await bindInstallation(installation);
    } catch (err) {
      // Already owned by a different organization. Refused rather than moved:
      // the caller proved it controls the installation on GitHub, which is not
      // the same as the current owner agreeing to give it up.
      if (err instanceof InstallationOwnedError) {
        return c.json({ error: err.message }, 409);
      }
      throw err;
    }
    return c.json({ bound: true, installationId, organizationId });
  });

  /** The installations one organization owns. */
  app.get('/api/installations', async (c) => {
    const organizationId = c.req.query('organizationId')?.trim();
    if (!organizationId) return c.json({ error: 'organizationId is required.' }, 400);
    if (!databaseConfigured()) return c.json({ installations: [] });
    return c.json({ installations: await installationsForOrganization(organizationId) });
  });

  /**
   * The projects an organization has connected.
   *
   * A project is one repository. Installing the App does not create any - see
   * `db/project-store.ts` for why access and intent are kept apart.
   */
  app.get('/api/projects', async (c) => {
    const organizationId = c.req.query('organizationId')?.trim();
    if (!organizationId) return c.json({ error: 'organizationId is required.' }, 400);
    if (!databaseConfigured()) return c.json({ projects: [] });
    return c.json({ projects: await projectsForOrganization(organizationId) });
  });

  /**
   * The GitHub accounts an organization has claimed an installation on,
   * lowercased - the owners whose repositories it may see and connect.
   *
   * The join is on owner login because that is the one identifier both sides
   * hold; see the note in `/api/repositories`.
   */
  const claimedAccounts = (installations: Installation[]): Set<string> =>
    new Set(
      installations
        .map((entry) => entry.accountLogin?.toLowerCase())
        .filter((login): login is string => Boolean(login)),
    );

  /** `owner/name` -> `owner`, lowercased. */
  const ownerOf = (fullName: string): string => fullName.split('/')[0]?.toLowerCase() ?? '';

  /**
   * Connect one repository as a project, and say where its documentation lives.
   *
   * Both repositories are checked against the installation before anything is
   * written. Without that, the docs repository is a free-text field that names
   * any repository on GitHub - and the pipeline would later be asked to open a
   * pull request against one this installation has no business touching.
   */
  app.post('/api/projects', async (c) => {
    if (!databaseConfigured()) {
      return c.json(
        {
          error:
            'This deployment stores state in .docxy/, which has no projects. ' +
            'Set DATABASE_URL to connect repositories.',
        },
        409,
      );
    }

    // SAFETY: every field is read through String() below, so this claims only
    // that the parsed body is an object with unknown properties - which it is,
    // or it is null, which the optional chaining covers.
    const body = (await c.req.json().catch(() => null)) as {
      name?: unknown;
      sourceRepo?: unknown;
      docsRepo?: unknown;
      docsRoots?: unknown;
    } | null;

    /*
     * The tenant comes from the query string and never from the body.
     *
     * Both used to be accepted, and the body was the one that counted - which
     * made the organization a field the browser filled in. The dashboard proxy
     * is the only thing that can establish a tenant here (this API has no
     * session, only a shared token), and it writes the session's organization
     * into the query string on every organization-scoped call. Reading it from
     * exactly one place is what stops a caller from supplying a second.
     */
    const organizationId = c.req.query('organizationId')?.trim() ?? '';
    const sourceRepo = String(body?.sourceRepo ?? '').trim();
    const docsRepo = String(body?.docsRepo ?? '').trim();
    // Normalised here rather than trusted: leading slashes and stray whitespace
    // are the difference between `docs` matching and matching nothing.
    const docsRoots = String(body?.docsRoots ?? '')
      .split(',')
      .map((entry) => entry.trim().replace(/^\.?\/+/, '').replace(/\/+$/, ''))
      .filter(Boolean)
      .join(',');
    const name = String(body?.name ?? '').trim() || sourceRepo.split('/')[1] || sourceRepo;

    if (!organizationId || !sourceRepo) {
      return c.json({ error: 'organizationId and sourceRepo are both required.' }, 400);
    }

    let installed: InstalledRepo[];
    try {
      installed = await installedRepos();
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        502,
      );
    }

    /*
     * Reachable *by this organization*, not merely by the App.
     *
     * The App's installation spans every account it was installed on, and the
     * check below used to stop there - so an organization that had claimed no
     * installation at all could connect any repository the deployment's App
     * could read, as long as nobody had connected it yet, and then start runs
     * on it and read its diffs and drafted documentation. The repository list
     * already hid those repositories; this is the same rule, on the write.
     */
    const claimed = claimedAccounts(await installationsForOrganization(organizationId));
    const reachable = new Set(
      installed
        .filter((repo) => claimed.has(ownerOf(repo.fullName)))
        .map((repo) => repo.fullName.toLowerCase()),
    );
    if (!reachable.has(sourceRepo.toLowerCase())) {
      return c.json(
        {
          error:
            // One answer whether the App is absent or installed for somebody
            // else: which repositories other organizations hold is not this
            // caller's to learn.
            `The GitHub App is not installed on ${sourceRepo} for this organization, so docxy ` +
            'cannot read it. Install it from the dashboard first, then connect the repository.',
        },
        403,
      );
    }
    if (docsRepo && !reachable.has(docsRepo.toLowerCase())) {
      return c.json(
        {
          error:
            `The GitHub App is not installed on ${docsRepo} for this organization, so docxy ` +
            'cannot open a pull request against it. Install it from the dashboard first.',
        },
        403,
      );
    }

    const draft: NewProject = {
      organizationId,
      name,
      sourceRepo,
      // The checkout path this host will use, so the pipeline's remaining
      // path-based lookups resolve to this row instead of making a second one.
      key: checkoutPathFor(sourceRepo),
    };
    if (docsRepo) draft.docsRepo = docsRepo;
    if (docsRoots) draft.docsRoots = docsRoots;

    try {
      const project = await createProject(draft);
      return c.json({ project }, 201);
    } catch (err) {
      if (err instanceof SourceRepoTakenError) return c.json({ error: err.message }, 409);
      if (err instanceof CheckoutPathTakenError) {
        // 409 rather than 500: a real conflict with a row already on this host,
        // and one no retry will clear. Named so support can find it.
        return c.json(
          {
            error:
              `${sourceRepo} could not be connected: another project already occupies ` +
              'the checkout path this host would use for it. Disconnect that project first.',
          },
          409,
        );
      }
      throw err;
    }
  });

  /** Disconnect a project. The repository and its pull requests are untouched. */
  app.delete('/api/projects/:id', async (c) => {
    const organizationId = c.req.query('organizationId')?.trim();
    if (!organizationId) return c.json({ error: 'organizationId is required.' }, 400);
    if (!databaseConfigured()) return c.json({ error: 'No projects on this deployment.' }, 409);

    const removed = await deleteProject(c.req.param('id'), organizationId);
    if (!removed) return c.json({ error: 'No such project in that organization.' }, 404);
    return c.json({ deleted: true });
  });

  /**
   * The allowance's answer for one commit of a project, or null when there is
   * nothing to ask: allowances are not enforced here, or the project belongs to
   * no organization (a deployment's own repository). Throws when the answer
   * could not be read, which callers treat as "do not run".
   */
  const admitFor = async (
    project: { id: string; organizationId: string | null } | null,
    commit: string,
    trigger: 'push' | 'manual',
    invocationKey: string,
  ): Promise<Admission | null> => {
    if (!allowancesEnforced() || !project?.organizationId) return null;
    return admitRun({
      organizationId: project.organizationId,
      projectId: project.id,
      commitSha: commit,
      trigger,
      invocationKey,
    });
  };

  /** One of an organization's projects, or null - never another organization's. */
  const ownedProject = async (organizationId: string | undefined, id: string) => {
    if (!organizationId || !databaseConfigured()) return null;
    const owned = await projectsForOrganization(organizationId);
    return owned.find((project) => project.id === id) ?? null;
  };

  /**
   * Every project's own card figures, each over that project's newest runs.
   *
   * One request for the grid rather than one per card, and each project's
   * window its own: deriving them from the organization's newest fifty runs let
   * a busy project push a quiet one's history out of view.
   */
  app.get('/api/projects/rollups', async (c) => {
    const organizationId = c.req.query('organizationId')?.trim();
    if (!organizationId) return c.json(noOrganization, 400);
    if (!databaseConfigured()) {
      const page: ProjectRollupsPage = { rollups: [] };
      return c.json(page);
    }

    const owned = await projectsForOrganization(organizationId);
    // One query for every card rather than a listing per project.
    const byRepo = await runs.listByRepo(
      50,
      owned.map((project) => project.key),
    );
    const rollups = owned.map((project) =>
      rollUpProject(project.id, (byRepo.get(project.key) ?? []).map(summarize)),
    );
    const page: ProjectRollupsPage = { rollups };
    return c.json(page);
  });

  /** Pushes this project passed over, newest first. */
  app.get('/api/projects/:id/skips', async (c) => {
    const project = await ownedProject(c.req.query('organizationId')?.trim(), c.req.param('id'));
    if (!project) {
      const page: SkippedCommitsPage = { skipped: [] };
      return c.json(page, databaseConfigured() ? 404 : 200);
    }
    const page: SkippedCommitsPage = { skipped: await skipsForProject(project.id) };
    return c.json(page);
  });

  /**
   * Document one commit of a project now, because somebody asked.
   *
   * Never triaged, and forced: whether the commit was skipped, already
   * documented or never seen, a person asking for it is the whole decision. It
   * runs in the same lane as the project's pushes, so it waits its turn behind
   * them rather than racing them for the checkout.
   */
  app.post('/api/projects/:id/runs', async (c) => {
    const project = await ownedProject(c.req.query('organizationId')?.trim(), c.req.param('id'));
    if (!project?.sourceRepo) {
      const refusal: StartProjectRunRefusal = { error: 'No such project in that organization.', code: 'not-found' };
      return c.json(refusal, 404);
    }

    const parsed = z
      .object({ commit: z.string().trim().regex(/^[0-9a-fA-F]{7,40}$/) })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: 'Name the commit to document, as a SHA.' }, 400);
    }

    const repo = await installedRepo(project.sourceRepo);
    if (!repo) {
      return c.json(
        { error: `The GitHub App is no longer installed on ${project.sourceRepo}, so docxy cannot read it.` },
        409,
      );
    }

    // The queue deduplicates on the exact string, so an abbreviation is
    // resolved first - against the checkout, which is the only place that can.
    let commit = parsed.data.commit.toLowerCase();
    if (!isCommitSha(commit)) {
      try {
        commit = await resolveCommit(checkoutPathFor(repo.fullName), commit);
      } catch {
        return c.json({ error: `Give the full SHA: ${commit} could not be resolved here.` }, 400);
      }
    }

    // A run somebody asked for still spends the organization's allowance. Each
    // request is its own invocation: clicking again is asking again.
    let admission: Admission | null;
    try {
      admission = await admitFor(project, commit, 'manual', `manual:${randomUUID()}`);
    } catch (err) {
      return c.json(
        { error: `The allowance could not be checked: ${err instanceof Error ? err.message : String(err)}` },
        503,
      );
    }
    if (admission && !admission.admitted) {
      const refusal: StartProjectRunRefusal = { error: admission.reason, code: admission.code };
      return c.json(refusal, 409);
    }

    const options: RunOptions = { force: true };
    if (admission?.reservationId) options.reservation = admission.reservationId;
    const result = enqueueRun(
      { key: repo.fullName, path: checkoutPathFor(repo.fullName) },
      commit,
      'dashboard',
      { repository: repo.fullName, defaultBranch: repo.defaultBranch },
      options,
    );
    if (!result.accepted || result.duplicate) {
      await settle(options.reservation, 'released', {
        reason: result.accepted ? 'already queued' : result.reason,
      });
    }
    if (!result.accepted) {
      const refusal: StartProjectRunRefusal = { error: result.reason, code: 'queue-full' };
      return c.json(refusal, 503);
    }

    await clearSkip(project.id, commit).catch(() => {});
    const started: StartProjectRunResult = {
      started: true,
      commit,
      queued: result.queued,
      depth: result.depth,
    };
    return c.json(started);
  });

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
          'GITHUB_APP_INSTALLATION_ID. guides/GITHUB-APP.md walks through all three.',
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

    /*
     * Narrowed to the calling organization before anything is annotated.
     *
     * The App's installation can see repositories belonging to several GitHub
     * accounts, and this endpoint used to return all of them to whoever asked.
     * Repository names are not nothing - they are the list of what a company is
     * working on - so the listing is cut to the GitHub accounts this
     * organization has actually claimed an installation for.
     *
     * Owner login is the join because that is the only identifier both sides
     * hold: `installationRepositories` reports `owner/repo` and nothing about
     * which installation produced it. A finer boundary needs per-installation
     * tokens, which is a larger change than this one.
     */
    const organizationId = c.req.query('organizationId')?.trim();
    if (databaseConfigured() && !organizationId) return c.json(noOrganization, 400);

    // Three reads that do not depend on one another, so they are made at once
    // rather than one round trip after another. The connected list's failure
    // is carried rather than thrown; see below for why it is reported.
    const [claimedInstallations, scoped, connected] = await Promise.all([
      databaseConfigured() && organizationId
        ? installationsForOrganization(organizationId)
        : Promise.resolve(null),
      requestPaths(organizationId).then(async (scope) =>
        scope ? { recent: await runs.list(200, scope) } : null,
      ),
      connectedRepos().then(
        (names) => ({ ok: true as const, names }),
        (err: unknown) => ({ ok: false as const, err }),
      ),
    ]);

    if (claimedInstallations) {
      const claimed = claimedAccounts(claimedInstallations);
      installed = installed.filter((repo) => claimed.has(ownerOf(repo.fullName)));
    }

    if (!scoped) return c.json(noOrganization, 400);
    const { recent } = scoped;
    const installedNames = installed.map((repo) => repo.fullName.toLowerCase());
    // The same list the webhook decides on, so this page cannot claim a
    // repository is watched when a push to it would be ignored.
    //
    // A failure is reported rather than caught, because null already means
    // something specific here - "this deployment has no projects, the
    // installation is the answer" - and a database outage silently borrowing
    // that meaning would paint every installed repository as monitored at
    // exactly the moment none of them are.
    if (!connected.ok) {
      const { err } = connected;
      return c.json({
        configured: true,
        repositories: [],
        localRepoPath: config.repoPath,
        pinned,
        error:
          'Could not read the connected projects, so this page cannot say which ' +
          `repositories are watched: ${publicErrorMessage(err)}`,
      });
    }
    const connectedNames = connected.names;

    const repositories = await Promise.all(
      installed.map(async (repo) => {
        const checkoutPath = checkoutPathFor(repo.fullName);
        // Matched on the managed checkout. The configured path only counts when
        // exactly one repository is installed - with several, attributing the
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
          /**
           * Whether a push here starts a run, decided by the same function the
           * webhook uses. For most repositories this is false, and that is the
           * point: the App is installed on everything the account chose to
           * grant, and only the ones somebody connected as a project are
           * watched.
           */
          allowed: deliveryAllowed(
            {
              installed: installedNames,
              connected: connectedNames,
              fromEnv: config.server.allowedRepos,
            },
            repo.fullName,
          ).ok,
          /**
           * Whether a project connects this repository. Separate from `allowed`
           * so the page can tell "nobody connected it" apart from "connected,
           * but `DOCXY_ALLOWED_REPOS` excludes it" - two rows that look
           * identical otherwise and need opposite things done about them.
           */
          connected: connectedNames
            ? connectedNames.includes(repo.fullName.toLowerCase())
            : true,
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
      /**
       * The narrowing, so the page can explain a repository it is showing as
       * installed but not documented. Empty is the normal case: every
       * repository the App was given access to.
       */
      envAllowlist: config.server.allowedRepos,
      error: null,
    });
  });

  app.get('/api/runs', async (c) => {
    const paths = await requestScope(c.req.query('organizationId'), c.req.query('projectId'));
    if (!paths) return c.json(noOrganization, 400);
    const list = await runs.list(50, paths);
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
    // Scoped to the calling organization's repositories, whether or not a run
    // was named. Naming one narrows the listing; it does not reach past the
    // filter. Run ids are printed in the dashboard's own URLs, so a `?run=`
    // that skipped this was the way to read another organization's role events
    // with nothing but a signed-in session. `?projectId=` narrows the same way,
    // and a project belonging to somebody else narrows to nothing.
    const paths = await requestScope(c.req.query('organizationId'), c.req.query('projectId'));
    if (!paths) return c.json(noOrganization, 400);
    query.repoPaths = paths;
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
    const paths = await requestScope(c.req.query('organizationId'), c.req.query('projectId'));
    if (!paths) return c.json(noOrganization, 400);
    return c.json(buildReport(await runs.list(limit, paths)));
  });

  /**
   * A run by id, but only one the calling organization owns.
   *
   * `load` addresses the store by primary key and knows nothing about which
   * repositories the caller may see, so the scope check belongs here - and a
   * run outside it is reported as absent rather than forbidden, because
   * "forbidden" confirms the id names something real.
   */
  const scopedRun = async (id: string, organizationId: string | undefined) => {
    const paths = await requestPaths(organizationId);
    if (!paths) return { run: null, scoped: false as const };
    const run = await runs.load(id);
    if (!run) return { run: null, scoped: true as const };
    return { run: paths.includes(run.repoPath) ? run : null, scoped: true as const };
  };

  app.get('/api/runs/:id', async (c) => {
    const { run, scoped } = await scopedRun(c.req.param('id'), c.req.query('organizationId'));
    if (!scoped) return c.json(noOrganization, 400);
    if (!run) return c.json({ error: 'No such run.' }, 404);
    const withStaleness = run.approval
      ? { ...run, approvalStaleness: staleness(run.approval, config) }
      : run;
    return c.json(withStaleness);
  });

  app.get('/api/runs/:id/files', async (c) => {
    const { run, scoped } = await scopedRun(c.req.param('id'), c.req.query('organizationId'));
    if (!scoped) return c.json(noOrganization, 400);
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
  interface QueuedRun extends RunOptions {
    commit: string;
    /**
     * Which repository to sync and document, for a run in a managed checkout.
     *
     * Data rather than a closure, so a queue can outlive the process that took
     * it: what is waiting when the server is told to stop is written to the
     * state volume and taken up again by the next one (see `shutdown`). Absent
     * for a run in the deployment's own checkout, which needs no preparing.
     */
    origin?: RunOrigin;
    /** Where it came from, for the log line when it finally starts. */
    source: string;
  }

  /**
   * Runs waiting their turn.
   *
   * One writer per repository is a real constraint - two runs drive the same
   * long-lived harness sessions concurrently and the symbol map cannot absorb
   * that - but *dropping* the second one was the wrong way to enforce it. A
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
   * enforcing far more - a push to one repository waited behind an unrelated
   * run on another, and before the queue existed it was dropped outright.
   * Keying the lanes by repository keeps the invariant that is real and drops
   * the one that was incidental.
   */
  interface Lane {
    /** How this lane is addressed: a repository full name, or a checkout path. */
    key: string;
    /**
     * The checkout this lane's runs happen in.
     *
     * Not the same string as the key. A webhook lane is keyed by the repository
     * GitHub named, because that is what makes two repositories' pushes
     * independent, while the runs themselves are addressed by the directory the
     * repository was cloned into - and the directory is what says which
     * organization may hear about them. Carrying both is how a queue event can
     * be scoped without changing what keeps the lanes apart.
     */
    repoPath: string;
    queue: QueuedRun[];
    active: Promise<unknown> | null;
    /** The commit running in this lane, for deduplicating a redelivery. */
    running: string | null;
    /**
     * The entry being worked on, and the run record it produced once there is
     * one. An entry with no record yet - still cloning, still in triage - has
     * nothing a restart could resume, so a shutdown hands it on like a queued
     * one instead of losing it.
     */
    current: { item: QueuedRun; runId: string | null } | null;
  }

  const lanes = new Map<string, Lane>();

  /**
   * One `ensureCheckout` at a time per repository.
   *
   * Lanes serialise runs per *code* repository, but a docs repository can be
   * shared by several projects, and its managed checkout is a single working
   * tree. Two lanes syncing it at once - a fetch and a forced checkout each -
   * fail on git's own lock files at best, and at worst leave one run reading
   * the docs at the other's commit. Keyed case-insensitively, as GitHub names
   * are.
   */
  const checkoutQueues = new Map<string, Promise<unknown>>();
  const oneCheckoutAtATime = <T>(repository: string, work: () => Promise<T>): Promise<T> => {
    const key = repository.toLowerCase();
    const next = (checkoutQueues.get(key) ?? Promise.resolve()).then(work, work);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    checkoutQueues.set(key, settled);
    void settled.then(() => {
      if (checkoutQueues.get(key) === settled) checkoutQueues.delete(key);
    });
    return next;
  };

  /**
   * The configuration a run in a managed checkout runs with.
   *
   * Syncs the repository to the commit, then applies what the project connected
   * for it says about its docs - their paths, and their own repository when they
   * live apart from the code. Every way a run reaches a managed checkout comes
   * through here: a push, a run somebody asked for from the dashboard, and a run
   * resumed after a restart.
   */
  const preparedConfig = async (origin: RunOrigin, commit: string): Promise<Config> => {
    const { repository, defaultBranch, pinned } = origin;
    const repoPath = await oneCheckoutAtATime(repository, () =>
      ensureCheckout(repository, defaultBranch, commit, pinned),
    );

    /*
     * What the project connected for this repository said about its docs.
     *
     * The webhook's verdict already refused a repository with no project row on
     * a database-backed deployment, so absent here means a file-backed one -
     * which leaves the environment's own settings in charge, and is what a
     * single-repository install and every CLI run rely on.
     */
    const project = databaseConfigured()
      ? await projectForSourceRepo(repository).catch(() => null)
      : null;
    if (!project) return { ...config, repoPath };

    const docs = { ...config.docs };
    if (project.docsRoots) {
      docs.roots = project.docsRoots.split(',').map((entry) => entry.trim()).filter(Boolean);
    }

    // Documentation in its own repository needs its own checkout, and its own
    // default branch: the code repository's says nothing about it.
    if (project.docsRepo && project.docsRepo !== repository) {
      const target = await installedRepo(project.docsRepo);
      if (!target) {
        throw new Error(
          `This project documents ${repository} into ${project.docsRepo}, but the ` +
            'GitHub App is not installed on that repository, so there is nowhere to ' +
            'read the documentation from or open a pull request against.',
        );
      }
      docs.repo = target.fullName;
      docs.baseBranch = target.defaultBranch;
      docs.repoPath = await oneCheckoutAtATime(target.fullName, () =>
        ensureCheckout(target.fullName, target.defaultBranch),
      );
    }

    return { ...config, repoPath, docs };
  };

  /** Bounded so a burst of pushes cannot grow a lane without limit. */
  const QUEUE_LIMIT = 20;

  /**
   * Set once the process has been told to stop.
   *
   * Lanes stop *starting* runs - the ones already going are given the grace
   * period to finish - but they keep *accepting* them: GitHub does not retry a
   * refused delivery, so a push turned away during a deploy would never be
   * documented. What is still waiting is written down for the next process.
   */
  let draining = false;

  const laneFor = (key: string, repoPath: string): Lane => {
    const existing = lanes.get(key);
    if (existing) return existing;
    const lane: Lane = { key, repoPath, queue: [], active: null, running: null, current: null };
    lanes.set(key, lane);
    return lane;
  };

  /**
   * Record a skipped commit against the project checked out at `repoPath`.
   *
   * Best effort: a skip that cannot be written is logged, not thrown, because
   * the decision it describes has already been made and acted on.
   */
  const rememberSkip = async (
    repoPath: string,
    commit: SkippedCommitRef,
    kind: SkipKind,
    reason: string,
    triage?: SkippedCommit['triage'],
  ): Promise<void> => {
    if (!databaseConfigured()) return;
    try {
      const project = await projectForCheckoutPath(repoPath);
      if (project) await recordSkip(project.id, commit, kind, reason, triage);
    } catch (err) {
      console.error(
        `could not record that ${commit.shortSha} was skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  /**
   * Settle an allowance slot, once. Best effort: a settlement that fails is
   * logged, and the reservation stays held until somebody settles it, which
   * errs toward the customer's allowance rather than toward free work.
   */
  const settle = async (
    reservation: string | undefined,
    outcome: Settlement,
    details: SettlementDetails,
  ): Promise<void> => {
    if (!reservation) return;
    try {
      await settleReservation(reservation, outcome, details);
    } catch (err) {
      console.error(
        `could not settle reservation ${reservation} as ${outcome}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const drainLane = (lane: Lane): void => {
    if (draining || lane.active || lane.queue.length === 0) return;
    const next = lane.queue.shift();
    if (!next) return;
    lane.running = next.commit;
    const current: NonNullable<Lane['current']> = { item: next, runId: next.resume ?? null };
    lane.current = current;

    // Preparing runs inside the same promise as the pipeline rather than before
    // it, because the caller has already answered GitHub and cannot await
    // anything: cloning a repository plus a five-role run is far past the ten
    // seconds a delivery is given. It also decides which checkout the run uses,
    // so a webhook can document the repository it names rather than whichever
    // directory the server happened to start in.
    lane.active = (async () => {
      const runConfig = next.origin ? await preparedConfig(next.origin, next.commit) : config;
      const result = await runPipeline(runConfig, next.commit, {
        force: next.force ?? false,
        // Pushes only. A run started from the dashboard or the API is somebody
        // asking for it, and triage does not get to overrule them.
        triage: next.triage ?? false,
        resume: next.resume,
        // Scoped by the checkout the run is actually in, which `prepare` has
        // just decided and which is not always this lane's key.
        onRunUpdate: (run) => {
          current.runId ??= run.id;
          bus.publish('run', summarize(run), { repoPath: run.repoPath });
        },
        onRoleEvent: (role, event) =>
          bus.publish('role', { role, event }, { repoPath: runConfig.repoPath }),
      });
      // Not an error, and not silent either: a delivery that was already
      // handled should say so rather than look like a run that vanished.
      if (result.skipped) {
        console.log(`skipped ${next.commit.slice(0, 7)}: ${result.skipped.reason}`);
        bus.publish(
          'skipped',
          { commit: next.commit, ...result.skipped },
          { repoPath: runConfig.repoPath },
        );
      }
      // A run that did work spends the slot it was admitted on. One that was
      // skipped - triaged out, or already documented - hands it back.
      if (result.run && !result.skipped) {
        await settle(next.reservation, 'consumed', { runId: result.run.id });
      } else {
        await settle(next.reservation, 'released', { reason: result.skipped?.reason ?? 'skipped' });
      }

      // Triage passed over this push, so no run will ever say so. The Activity
      // page reads it from here, and can offer to document it anyway.
      if (result.run === null) {
        const { commit, reason, triage } = result.skipped;
        await rememberSkip(runConfig.repoPath, commit, 'triage', reason, {
          needsDocs: triage.needsDocs,
          surface: triage.surface,
          surfaceConfidence: triage.surfaceConfidence,
          model: triage.model,
        });
      }
      return result;
    })()
      .catch(async (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        // A run that failed is not charged for: platform and provider failures
        // give the slot back (guides/ABUSE-PREVENTION-PLAN.md). A stop during
        // shutdown never reaches here - that slot goes with the resumed run.
        await settle(next.reservation, 'released', { reason: `failed: ${message}` });
        // Also to stderr: a failure before the first role has no run record to
        // attach to, so the event bus is the only place it would otherwise go -
        // and nobody is watching an SSE stream at push time.
        console.error(`run for ${next.commit.slice(0, 7)} failed: ${message}`);
        // `runConfig` is inside the promise above and unavailable here, so this
        // is scoped by the lane's own checkout. They differ only when preparing
        // redirected the run, and a preparation that threw never got that far.
        bus.publish('error', { commit: next.commit, message }, { repoPath: lane.repoPath });
      })
      .finally(() => {
        lane.active = null;
        lane.running = null;
        lane.current = null;
        // Nothing left to do in this lane, and nothing waiting: forget it, so a
        // long-lived server does not accumulate one entry per repository it has
        // ever seen.
        if (lane.queue.length === 0) lanes.delete(lane.key);
        bus.publish('queue', { depth: lane.queue.length }, { repoPath: lane.repoPath });
        // Synchronously after clearing `active`, so the next run in this lane
        // starts without waiting for anything to poll.
        drainLane(lane);
      });
  };

  type EnqueueResult =
    | {
        accepted: true;
        queued: boolean;
        depth: number;
        /** The commit was already waiting or running here; nothing was added. */
        duplicate: boolean;
      }
    | { accepted: false; reason: string };

  /**
   * Take a run, now or as soon as this repository's current one finishes.
   *
   * Deduplicated on the commit, against both the queue and the run already in
   * flight: GitHub retries a delivery it thinks failed, and a reviewer clicking
   * twice means one run, not two. Checking only the queue was not enough - a
   * run leaves the queue the moment it starts, so a redelivery arriving
   * mid-run found nothing to match.
   *
   * `commit` must already be a resolved SHA. Deduplication is only as good as
   * the identity it compares, and a symbolic ref is not one: `HEAD` matches
   * `HEAD` however far the branch moved in between. Callers resolve first.
   */
  const enqueueRun = (
    repo: { key: string; path: string },
    commit: string,
    source: string,
    origin?: RunOrigin,
    options: RunOptions = {},
  ): EnqueueResult => {
    const lane = laneFor(repo.key, repo.path);

    if (commit === lane.running || lane.queue.some((item) => item.commit === commit)) {
      // Already in hand. Reported as accepted, because it is: the commit will
      // be documented, and the caller does not need to know it asked twice.
      return { accepted: true, queued: true, depth: lane.queue.length, duplicate: true };
    }
    if (lane.queue.length >= QUEUE_LIMIT) {
      return {
        accepted: false,
        reason: `The run queue for ${repo.key} is full (${QUEUE_LIMIT} waiting). Try again once it drains.`,
      };
    }

    const item: QueuedRun = { commit, source, ...options };
    if (origin) item.origin = origin;
    lane.queue.push(item);
    const willWait = Boolean(lane.active);
    drainLane(lane);
    // This lane's own depth, not the deployment's. The number a customer's
    // dashboard can act on is how many of their pushes are waiting, and the
    // total across every tenant is not something to broadcast to one of them.
    bus.publish('queue', { depth: lane.queue.length }, { repoPath: lane.repoPath });
    // This lane's depth too: a caller answering one customer must not tell them
    // how busy every other customer's repositories are.
    return { accepted: true, queued: willWait, depth: lane.queue.length, duplicate: false };
  };

  /**
   * Document a commit of the server's own checkout.
   *
   * The single-tenant path: `docxy serve` and the bundled operator page. On a
   * database-backed deployment it is refused, because it belongs to nobody.
   * It runs against the host's checkout rather than a project, so there is no
   * organization to scope it to and no allowance to admit it against - and the
   * dashboard proxy forwards any `/api/runs` request from any signed-in account,
   * which made it a way for anyone who registered to spend the operator's model
   * budget, with `force` to do it again for the same commit. A project's runs
   * start from `POST /api/projects/:id/runs`, which checks both.
   */
  app.post('/api/runs', async (c) => {
    if (databaseConfigured()) {
      return c.json(
        {
          error:
            "This deployment starts runs from a project, which checks the organization's " +
            'allowance: POST /api/projects/:id/runs.',
        },
        403,
      );
    }
    // SAFETY: a body that is not JSON falls back to `{}`, and every field below is optional and checked before use.
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

    const result = enqueueRun({ key: config.repoPath, path: config.repoPath }, commit, 'api', undefined, {
      force: body.force === true,
    });
    if (!result.accepted) return c.json({ error: result.reason }, 503);
    return c.json({ started: true, commit, queued: result.queued, depth: result.depth });
  });

  /**
   * GitHub push webhook.
   *
   * GitHub gives a delivery about ten seconds before it times out, and a
   * five-role run takes minutes - so this answers immediately and does the work
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

    let payload: {
      ref?: string;
      after?: string;
      repository?: { default_branch?: string; full_name?: string };
      head_commit?: { message?: string } | null;
    };
    try {
      // SAFETY: the HMAC above proves this body came from GitHub with our secret,
      // and every field below is read as optional and checked before use.
      payload = JSON.parse(raw.toString('utf8')) as typeof payload;
    } catch {
      // Signed, so genuinely GitHub's - most likely a webhook configured to send
      // `application/x-www-form-urlencoded`. A 400 puts that in the delivery log
      // where somebody can see it, rather than a 500 that reads as an outage.
      return c.json(
        {
          ok: false,
          error: 'The payload is not JSON. Set the webhook content type to application/json.',
          delivery,
        },
        400,
      );
    }

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
    // checkout - including one this delivery has not synced yet. A push event
    // without `after` is not a push this can identify, and it is acknowledged
    // rather than rejected so GitHub stops redelivering it.
    if (!commit) {
      return c.json({ ok: true, ignored: 'payload named no commit' });
    }
    // `after` is interpolated into git commands and used as a queue key. GitHub
    // only ever sends a full object name here, so anything else did not come
    // from a push this should act on.
    if (!isCommitSha(commit)) {
      return c.json({ ok: true, ignored: 'payload named no usable commit' });
    }

    // Whether this push is ours to act on. Read per delivery rather than cached
    // at boot: connecting a repository, and installing the App on another one,
    // are both things somebody does while this server is running, and either
    // should take effect on the next push rather than the next deploy.
    //
    // The decisive half is the projects table. The webhook secret belongs to
    // the App, not to a repository, so every installation of it produces
    // deliveries that pass the HMAC above - and an "All repositories" install,
    // which is how most people install an App, would otherwise mean every
    // repository the account owns starts getting documentation pull requests
    // nobody asked for.
    let connected: string[] | null;
    try {
      connected = await connectedRepos();
    } catch (err) {
      // A database that will not answer is not the same as nobody having
      // connected this repository, and guessing either way is wrong: guessing
      // "connected" documents repositories nobody asked about, guessing "not"
      // silently drops a real push. 503 is the one status that makes GitHub
      // redeliver, so the push survives the outage.
      return c.json(
        {
          ok: false,
          error: `could not read the connected projects: ${
            err instanceof Error ? err.message : String(err)
          }`,
          delivery,
        },
        503,
      );
    }

    const verdict = deliveryAllowed(
      {
        installed: await installedRepos()
          .then((repos) => repos.map((repo) => repo.fullName.toLowerCase()))
          // GitHub being unreachable must not stop a pipeline that was working;
          // `deliveryAllowed` treats an unknown installation as unverifiable.
          .catch(() => null),
        connected,
        fromEnv: config.server.allowedRepos,
      },
      repository,
    );
    if (!verdict.ok) {
      // 200, not 403: the delivery is genuine and correctly signed, it is just
      // not ours to act on. Rejecting it would make GitHub retry it forever.
      return c.json({ ok: true, ignored: verdict.reason });
    }

    // The allowance, before anything is cloned or any provider is called. Keyed
    // by GitHub's delivery id, so a redelivery of the same push is recognised
    // and not charged twice.
    const project = databaseConfigured()
      ? await projectForSourceRepo(repository).catch(() => null)
      : null;
    let admission: Admission | null;
    try {
      admission = await admitFor(
        project,
        commit,
        'push',
        delivery === 'unknown' ? `github:${repository}:${commit}` : `github:${delivery}`,
      );
    } catch (err) {
      // Neither "yes" nor "no" is known, so nothing is run - and 503 so the
      // failure shows in GitHub's delivery log, where it can be redelivered.
      return c.json(
        {
          ok: false,
          error: `could not check the allowance: ${err instanceof Error ? err.message : String(err)}`,
          delivery,
        },
        503,
      );
    }
    if (admission && !admission.admitted && project) {
      const subject = payload.head_commit?.message?.split('\n')[0]?.trim() ?? '';
      await recordSkip(
        project.id,
        { sha: commit, shortSha: commit.slice(0, 7), subject },
        admission.code,
        admission.reason,
      ).catch(() => {});
      bus.publish(
        'skipped',
        { commit, reason: admission.reason, code: admission.code },
        { repoPath: checkoutPathFor(repository) },
      );
      return c.json({ ok: true, ignored: admission.reason, code: admission.code, delivery });
    }
    if (admission?.admitted && admission.replayed) {
      return c.json({ ok: true, duplicate: true, delivery });
    }

    // The delivery names a commit the checkout has probably never seen - it was
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
    // repositories' pushes independent of one another. The path is the same one
    // `ensureCheckout` resolves below, computed here because a live update has
    // to be addressed before the clone finishes.
    const checkout = pinned ?? checkoutPathFor(repository);
    const options: RunOptions = { triage: true };
    if (admission?.admitted && admission.reservationId) options.reservation = admission.reservationId;
    const result = enqueueRun(
      { key: repository, path: checkout },
      commit,
      `webhook ${delivery}`,
      pinned ? { repository, defaultBranch, pinned } : { repository, defaultBranch },
      options,
    );
    // Taken, but not added: the queue was full, or this commit is already
    // waiting or running under the slot it was admitted on the first time.
    if (!result.accepted || result.duplicate) {
      await settle(options.reservation, 'released', {
        reason: result.accepted ? 'already queued' : result.reason,
      });
    }

    if (!result.accepted) {
      // 503 rather than 200: this is the one case where GitHub retrying is
      // exactly what should happen, because the work genuinely was not taken.
      return c.json({ ok: false, error: result.reason, delivery }, 503);
    }

    bus.publish('webhook', { delivery, commit, repository }, { repoPath: checkout });
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

    return c.json<IntegrationsPage>({
      integrations: [
        {
          id: 'daytona',
          name: 'Daytona',
          category: 'sandbox',
          summary: 'Runs the docs build in an isolated workspace, over text a model wrote.',
          connected: workspaceConfigured(config),
          // Not required: without it the docs build is reported unvalidated, or
          // run on this machine if the operator has explicitly allowed that.
          // Neither is a broken deployment, and marking it required made one
          // look broken.
          required: false,
          detail: config.sandbox.blockNetwork ? 'network egress blocked' : 'network egress allowed',
          missing: workspaceConfigured(config)
            ? []
            : ['Set DAYTONA_API_KEY. Without it the docs build cannot run in isolation.'],
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

  /**
   * Open the pull request for a run whose proposal is ready.
   *
   * What is left of the approval gate. The gate itself is gone - nothing merges
   * without a human approving it on GitHub either way, so holding a finished
   * proposal behind a second sign-off in docxy's own UI bought a place for
   * proposals to be forgotten rather than a decision anybody was making.
   *
   * This remains because publishing can fail on its own - a token expired, the
   * branch already existed, GitHub was down - and a run whose five agents have
   * already been paid for should be publishable again without re-running them.
   */
  /**
   * Runs being published right now.
   *
   * The "already has a pull request" check reads the stored run, and the URL is
   * only stored once GitHub has answered - seconds later. A second click, or a
   * proxy retrying a write that outlived its timeout, passed the check in that
   * window and opened a second pull request for the same proposal, or failed
   * halfway on the branch the first had just pushed.
   */
  const publishing = new Set<string>();

  app.post('/api/runs/:id/publish', async (c) => {
    const { run: found, scoped } = await scopedRun(c.req.param('id'), c.req.query('organizationId'));
    if (!scoped) return c.json(noOrganization, 400);
    if (!found) return c.json({ error: 'No such run.' }, 404);
    if (publishing.has(found.id)) {
      return c.json({ error: 'This run is already being published.' }, 409);
    }
    publishing.add(found.id);

    // Read again under the lock: the copy above may predate a publish that
    // finished while this request was on its way here.
    const run = (await runs.load(found.id).catch(() => null)) ?? found;
    try {
      if (run.pullRequestUrl) {
        return c.json({ error: 'This run already has a pull request.', url: run.pullRequestUrl }, 409);
      }

      const files = await rebuildProposedFiles(config, run);
      if (files.length === 0) return c.json({ error: 'This run proposed no changes.' }, 409);

      // The draft intent and the concerns were decided when the run finished,
      // and republishing does not overturn them.
      const pr = await openPullRequest(config, run, files, run.publication);
      run.pullRequestUrl = pr.url;
      run.status = 'done';
      run.error = undefined;
      run.finishedAt = new Date().toISOString();
      await runs.save(run);
      bus.publish('run', summarize(run), { repoPath: run.repoPath });
      return c.json({ published: true, pullRequestUrl: pr.url, branch: pr.branch });
    } catch (err) {
      run.error = err instanceof Error ? err.message : String(err);
      await runs.save(run);
      bus.publish('run', summarize(run), { repoPath: run.repoPath });
      // The docs or the branch moved under the proposal: a state the caller can
      // act on (redraft, look at the branch), not a server failure.
      const conflict = err instanceof StaleProposalError || err instanceof BranchConflictError;
      return c.json({ error: publicErrorMessage(err) }, conflict ? 409 : 500);
    } finally {
      publishing.delete(found.id);
    }
  });

  /**
   * The live feed, scoped like every other read.
   *
   * This was the last deployment-wide endpoint carrying work product. It
   * pushed every run, every role transition and every webhook delivery to
   * whoever held a stream open, which meant the dashboard could not consume it
   * at all without handing one customer another's commit subjects.
   *
   * The scope is resolved once, when the stream opens, and the connection is
   * then long-lived - so this is also the point at which a caller's access is
   * checked, and it is checked again only when they reconnect. The dashboard's
   * proxy bounds the lifetime of a stream for exactly that reason; see
   * STREAM_SECONDS in web/src/app/api/docxy/[...path]/route.ts.
   *
   * A deployment with no database still sees everything, on the same reading as
   * every other endpoint: with no organizations there is no second tenant, and
   * "everything" and "mine" are the same set. The bundled operator page relies
   * on that, and stops receiving events on a database-backed deployment for the
   * same reason its other panels already return 400 there.
   */
  app.get('/api/events', async (c) => {
    const paths = await requestPaths(c.req.query('organizationId'));
    if (!paths) return c.json(noOrganization, 400);
    const organizationId = databaseConfigured()
      ? c.req.query('organizationId')?.trim() || undefined
      : undefined;

    /*
     * Torn down exactly once, whichever way the stream ends.
     *
     * The request's abort signal is one way; the response body being cancelled
     * - the socket closing under the writer - is another, and only the first was
     * handled. A stream cancelled without an abort left its heartbeat running,
     * and the next tick enqueued onto a closed controller. That throws, and a
     * throw inside a `setInterval` callback is an uncaught exception, which
     * takes the whole server down with every run in it.
     */
    let teardown: (() => void) | null = null;

    return new Response(
      new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          let closed = false;
          const send = (chunk: string): void => {
            if (closed) throw new Error('stream closed');
            controller.enqueue(encoder.encode(chunk));
          };
          const heartbeat = setInterval(() => {
            try {
              send(': ping\n\n');
            } catch {
              teardown?.();
            }
          }, 20_000);
          // The broadcaster drops a subscriber whose `send` throws.
          const remove = bus.add(send, { paths, organizationId });
          teardown = () => {
            if (closed) return;
            closed = true;
            clearInterval(heartbeat);
            remove();
            try {
              controller.close();
            } catch {
              // already closed or cancelled
            }
          };
          c.req.raw.signal.addEventListener('abort', () => teardown?.(), { once: true });
          send(': connected\n\n');
        },
        cancel() {
          teardown?.();
        },
      }),
      {
        headers: {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          // Nginx and several managed proxies buffer a response body by
          // default, which turns a stream into one delivery at the end of it.
          'x-accel-buffering': 'no',
        },
      },
    );
  });

  // Fire and forget, at construction, because it was written and then never
  // called: a run the previous process abandoned spins in the dashboard as
  // "still working" until something says otherwise, and nothing did. Not
  // awaited - the server must accept its first request whether or not the
  // store is reachable - and its own catch keeps a storage hiccup from taking
  // the boot down with it.
  /**
   * The repository an interrupted run was documenting, rebuilt from its record.
   *
   * Its checkout names a project, the project names a repository, and the
   * installation names that repository's default branch. `undefined` is the
   * deployment's own checkout, which needs no origin; null is a run whose
   * repository can no longer be found or reached.
   */
  const originOf = async (run: RunRecord): Promise<RunOrigin | null | undefined> => {
    if (run.repoPath === config.repoPath) return undefined;
    if (!databaseConfigured()) return null;
    const project = await projectForCheckoutPath(run.repoPath).catch(() => null);
    if (!project?.sourceRepo) return null;
    const repo = await installedRepo(project.sourceRepo);
    return repo ? { repository: repo.fullName, defaultBranch: repo.defaultBranch } : null;
  };

  /** How many times each run has been resumed, kept on the state volume. */
  const resumeLedger = join(config.stateDir, 'resumed-runs.json');
  const readResumeCounts = async (): Promise<Record<string, number>> => {
    try {
      const parsed = z
        .record(z.string(), z.number())
        .safeParse(JSON.parse(await readFile(resumeLedger, 'utf8')));
      return parsed.success ? parsed.data : {};
    } catch {
      return {};
    }
  };

  /**
   * Finish what a previous process was doing when it stopped.
   *
   * Every push to `main` redeploys this service, and a redeploy used to fail
   * every run in flight - work already paid for, five roles' worth, binned
   * because the process holding it was replaced. Runs are snapshotted step by
   * step under their own id (see `runRoles`), so an interrupted one is queued
   * again with `resume` and picks up at the first step that did not finish.
   *
   * `resumeVerdict` bounds it, so a run that keeps taking the process down
   * cannot keep doing it. Past its limits, or when its repository cannot be
   * found, a run is closed out as before.
   */
  const recoverInterruptedRuns = async (): Promise<void> => {
    try {
      const counts = await readResumeCounts();
      const resumed: Record<string, number> = {};
      const paths = await syncedPaths();
      for (const run of await runs.list(200, paths)) {
        if (run.status !== 'running') continue;

        const attempts = counts[run.id] ?? 0;
        const verdict = resumeVerdict(run.startedAt, attempts, Date.now());
        if (!verdict.resume) {
          await abandonRun(run, verdict.why);
          continue;
        }
        const origin = await originOf(run);
        if (origin === null) {
          await abandonRun(run, 'its repository could no longer be reached');
          continue;
        }

        const options: RunOptions = { resume: run.id };
        const reservation = await reservationOf(run);
        if (reservation) options.reservation = reservation;
        const result = enqueueRun(
          { key: origin?.repository ?? config.repoPath, path: run.repoPath },
          run.commit.sha,
          'resumed after a restart',
          origin,
          options,
        );
        if (!result.accepted) {
          await abandonRun(run, 'its queue was full');
          continue;
        }
        resumed[run.id] = attempts + 1;
        console.log(`resuming ${run.id.slice(0, 8)} on ${run.commit.shortSha} (attempt ${attempts + 1})`);
      }
      // Only the runs resumed this time are carried forward: one that finished,
      // or was closed out, has no further use for a count.
      await mkdir(dirname(resumeLedger), { recursive: true });
      await writeFile(resumeLedger, JSON.stringify(resumed));
    } catch (err) {
      // Housekeeping. A storage hiccup here must not stop the server booting.
      console.error(
        `could not recover interrupted runs: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  /**
   * Runs that were waiting when the last process stopped, written to the state
   * volume by `shutdown` and taken up once here.
   */
  const handoffFile = join(config.stateDir, 'queue-handoff.json');
  const handoffSchema = z.array(
    z.object({
      key: z.string(),
      path: z.string(),
      commit: z.string(),
      source: z.string(),
      origin: z
        .object({ repository: z.string(), defaultBranch: z.string(), pinned: z.string().optional() })
        .optional(),
      force: z.boolean().optional(),
      triage: z.boolean().optional(),
      resume: z.string().optional(),
      reservation: z.string().optional(),
    }),
  );
  type Handoff = z.infer<typeof handoffSchema>[number];

  const restoreHandoff = async (): Promise<void> => {
    let raw: string;
    try {
      raw = await readFile(handoffFile, 'utf8');
    } catch {
      return;
    }
    // Taken once, whatever happens next: a file that fails to parse would
    // otherwise be retried, and fail, on every boot.
    await rm(handoffFile, { force: true });
    try {
      const parsed = handoffSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) throw new Error(parsed.error.message);
      for (const { key, path, commit, source, origin, ...options } of parsed.data) {
        const result = enqueueRun({ key, path }, commit, `${source}, carried over a restart`, origin, options);
        if (!result.accepted) console.error(`could not requeue ${commit.slice(0, 7)}: ${result.reason}`);
      }
      if (parsed.data.length > 0) {
        console.log(`requeued ${parsed.data.length} run(s) the previous process left waiting`);
      }
    } catch (err) {
      console.error(
        `could not read the queue the previous process left: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  /**
   * Write down what a restart would otherwise lose: everything still queued,
   * plus anything started that never produced a run record - a restart has
   * nothing to resume for those.
   */
  const handOff = async (): Promise<void> => {
    const waiting: Handoff[] = [...lanes.values()].flatMap((lane) =>
      [
        ...(lane.active && lane.current && !lane.current.runId ? [lane.current.item] : []),
        ...lane.queue,
      ].map((item) => ({ key: lane.key, path: lane.repoPath, ...item })),
    );
    try {
      if (waiting.length === 0) {
        await rm(handoffFile, { force: true });
        return;
      }
      await mkdir(dirname(handoffFile), { recursive: true });
      await writeFile(handoffFile, JSON.stringify(waiting));
      console.log(`stopping: ${waiting.length} waiting run(s) written down for the next process`);
    } catch (err) {
      console.error(
        `stopping: could not write down ${waiting.length} waiting run(s): ${
          err instanceof Error ? err.message : String(err)
        }. Their commits: ${waiting.map((item) => item.commit.slice(0, 7)).join(', ')}`,
      );
    }
  };

  const shutdown = async (graceMs: number): Promise<void> => {
    draining = true;
    // Written once at the start, before waiting on anything: the platform may
    // kill the container well before the grace period is up, and a queue that
    // was only going to be saved at the end would be lost with it. A run that
    // ends up both resumed and handed on is queued once - the lane dedupes it
    // by commit.
    await handOff();

    const active = [...lanes.values()].flatMap((lane) => (lane.active ? [lane.active] : []));
    if (active.length === 0) return;
    console.log(`stopping: giving ${active.length} run(s) up to ${Math.round(graceMs / 1000)}s to finish`);
    await Promise.race([
      Promise.allSettled(active),
      new Promise((resolve) => setTimeout(resolve, graceMs)),
    ]);
    // And again with whatever finished meanwhile taken out.
    await handOff();
  };

  // Resumed runs first, so each lane finishes what it was doing before it
  // takes up what was waiting behind it.
  void recoverInterruptedRuns().then(restoreHandoff);

  return { app, bus, shutdown };
}

export function startServer(config: Config): ServerHandle {
  const { app } = createServer(config);
  // Loopback, deliberately. `serve` is the developer-at-a-terminal path and may
  // run without `DOCXY_API_TOKEN`; Node's default of every interface would put
  // unauthenticated approval endpoints on whatever network the laptop is on.
  // The deployed path is `standalone.ts`, which binds 0.0.0.0 and refuses to
  // start without the token.
  const hostname = process.env.DOCXY_HOST?.trim() || '127.0.0.1';

  // The override has to fail closed the same way the deployed path does, or it
  // is simply a second way to publish the approval endpoints unauthenticated -
  // and the quieter one, since nothing about `DOCXY_HOST=0.0.0.0` announces
  // that it is switching the lock off.
  if (!isLoopbackHost(hostname) && !config.server.apiToken) {
    throw new Error(
      `DOCXY_HOST is set to ${hostname}, which is reachable from outside this machine, ` +
        'but DOCXY_API_TOKEN is not set - the approval and run endpoints would be open ' +
        'to anyone who can reach the port. Set DOCXY_API_TOKEN, or leave DOCXY_HOST unset ' +
        'to listen on loopback only.',
    );
  }

  const server = serve({ fetch: app.fetch, port: config.server.port, hostname });

  // A listen failure arrives as an `error` event, and an `error` event with no
  // listener is a process-level throw - so the commonest mistake in local
  // development, a server already running, surfaced as a `node:net` stack
  // trace. Say what happened and what to do about it.
  server.on('error', (cause: NodeJS.ErrnoException) => {
    if (cause.code === 'EADDRINUSE') {
      console.error(
        `Port ${config.server.port} is already in use - docxy is very likely ` +
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
