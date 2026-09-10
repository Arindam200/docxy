import { and, eq, isNull, sql } from 'drizzle-orm';
import { getDb } from './index.js';
import { projects } from './schema.js';

/**
 * Projects, as the dashboard creates and lists them.
 *
 * A project is one repository, bound deliberately. Installing the GitHub App
 * grants access to a set of repositories; it does not say which of them anybody
 * wants documented, and most of the time the answer is "one of these fifteen".
 * So access and intent are kept separate: the installation is the menu, a
 * project is an order.
 */

export interface ProjectRecord {
  id: string;
  organizationId: string | null;
  name: string | null;
  /** `owner/repo` being watched. */
  sourceRepo: string | null;
  /** `owner/repo` the documentation lives in, or null when it is the source. */
  docsRepo: string | null;
  /** Comma-separated documentation paths, or null to use the built-in guesses. */
  docsRoots: string | null;
  key: string;
}

export interface NewProject {
  organizationId: string;
  name: string;
  sourceRepo: string;
  /** Omitted or equal to the source when documentation sits beside the code. */
  docsRepo?: string;
  /** Comma-separated documentation paths. Omitted to use the built-in guesses. */
  docsRoots?: string;
  /**
   * The path this repository is checked out at on the pipeline host.
   *
   * Written into the legacy `key` column so that the path-based lookups still
   * in the pipeline resolve to this row rather than silently creating a second,
   * organization-less one beside it. It disappears with the move off `key`.
   */
  key: string;
}

/** Raised when a repository is already documented by another project. */
export class SourceRepoTakenError extends Error {
  constructor(readonly sourceRepo: string) {
    super(`${sourceRepo} is already connected to a project.`);
    this.name = 'SourceRepoTakenError';
  }
}

/**
 * Raised when a checkout path is held by a row this cannot explain.
 *
 * Not the ordinary "already connected" case, which `SourceRepoTakenError`
 * covers. This is a row that owns the path while naming a different repository
 * or none, and it is surfaced rather than overwritten because overwriting it
 * would move somebody else's run history onto this project.
 */
export class CheckoutPathTakenError extends Error {
  constructor(readonly key: string) {
    super(`Another project already occupies the checkout path ${key}.`);
    this.name = 'CheckoutPathTakenError';
  }
}

/**
 * Create a project for one repository, or claim the row a run already made.
 *
 * Two unique columns are in play and only one of them is about intent.
 * `source_repo` is the real one: it is unique across every organization, so it
 * doubles as the check that nobody else has claimed the repository - two
 * organizations documenting one repository would each be able to read the
 * other's runs for it.
 *
 * `key` is the accident. Every run needs a project row to hang off, so
 * `projectId()` in `db/executor.ts` mints one on first sight of a checkout
 * path, with no owner and no repository name. Any repository that has ever run
 * therefore already has a row holding its path - and an insert that named only
 * `source_repo` in its conflict target collided with that row's unique `key`
 * and raised, which made connecting exactly the repositories with history the
 * one thing that could not be done.
 *
 * So a row like that is adopted rather than fought with. The runs recorded
 * against that path are this repository's runs; claiming the row keeps them and
 * is the only outcome that does.
 */
export async function createProject(project: NewProject): Promise<ProjectRecord> {
  const { organizationId, name, sourceRepo, key } = project;
  // Null rather than a copy of the source: "beside the code" is the absence of
  // a separate docs repository, and storing it twice invites the two to drift.
  const docsRepo = project.docsRepo && project.docsRepo !== sourceRepo ? project.docsRepo : null;

  const docsRoots = project.docsRoots?.trim() || null;
  const claim = { organizationId, name, sourceRepo, docsRepo, docsRoots };

  // One transaction, because the checks below and the write that acts on them
  // are only meaningful together: two people connecting the same repository at
  // once must not both pass the "nobody has it" check.
  return getDb().transaction(async (tx) => {
    // Whoever holds the repository holds it, in any organization. Matched
    // case-insensitively for the same reason `projectForSourceRepo` is.
    const [taken] = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(sql`lower(${projects.sourceRepo}) = ${sourceRepo.trim().toLowerCase()}`)
      .limit(1);
    if (taken) throw new SourceRepoTakenError(sourceRepo);

    // A row a run left behind: this path, no repository, no owner.
    const [placeholder] = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(
        and(eq(projects.key, key), isNull(projects.sourceRepo), isNull(projects.organizationId)),
      )
      .limit(1);

    if (placeholder) {
      const [adopted] = await tx
        .update(projects)
        .set(claim)
        // Still unclaimed at the moment of writing, so a second connection
        // racing this one updates nothing and is told the repository is taken
        // rather than silently overwriting the winner.
        .where(and(eq(projects.id, placeholder.id), isNull(projects.sourceRepo)))
        .returning();
      if (!adopted) throw new SourceRepoTakenError(sourceRepo);
      return toRecord(adopted);
    }

    // No placeholder, so the path should be free. If it is not, the row holding
    // it is one the checks above did not explain, and guessing is worse than
    // saying so.
    const [occupied] = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.key, key))
      .limit(1);
    if (occupied) throw new CheckoutPathTakenError(key);

    const [row] = await tx
      .insert(projects)
      .values({ key, ...claim })
      .onConflictDoNothing({ target: projects.sourceRepo })
      .returning();

    if (!row) throw new SourceRepoTakenError(sourceRepo);

    return toRecord(row);
  });
}

function toRecord(row: typeof projects.$inferSelect): ProjectRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    name: row.name,
    sourceRepo: row.sourceRepo,
    docsRepo: row.docsRepo,
    docsRoots: row.docsRoots,
    key: row.key,
  };
}

/**
 * Every repository anybody has connected, deployment-wide and lowercased.
 *
 * The webhook's allowlist. It is deliberately not scoped to an organization:
 * the question a delivery asks is "did *anyone* ask for this repository to be
 * documented", and `sourceRepo` is unique across every organization, so the
 * answer cannot belong to two of them. Scoping it would mean the webhook first
 * had to know whose push it was holding, which is the thing this establishes.
 *
 * Lowercased here rather than at each call site: GitHub is case-insensitive
 * about repository names and a delivery may spell one differently from the
 * person who typed it into the connect form.
 */
export async function connectedSourceRepos(): Promise<string[]> {
  const rows = await getDb().select({ sourceRepo: projects.sourceRepo }).from(projects);
  return rows
    .map((row) => row.sourceRepo?.trim().toLowerCase())
    .filter((repo): repo is string => Boolean(repo));
}

/**
 * The project documenting a repository, if one has been connected.
 *
 * The webhook's question: a push names a repository, and this says whether
 * anybody asked for it to be documented and where its documentation lives.
 *
 * Matched case-insensitively, because GitHub is: a delivery spells the
 * repository however the account does today, and a project row was typed at
 * whatever it was called when somebody connected it. An exact comparison turns
 * a rename that only changed capitalisation into a repository that silently
 * stops being documented.
 */
export async function projectForSourceRepo(sourceRepo: string): Promise<ProjectRecord | null> {
  const [row] = await getDb()
    .select()
    .from(projects)
    .where(sql`lower(${projects.sourceRepo}) = ${sourceRepo.trim().toLowerCase()}`)
    .limit(1);
  return row ? toRecord(row) : null;
}

/**
 * The project checked out at a path, or null.
 *
 * The pipeline's question, and the mirror of `projectForSourceRepo`. A run
 * knows where it is working on disk and nothing about who asked for it, so this
 * is how work in progress finds the organization it belongs to - which is what
 * decides whose standing instructions the drafting roles read.
 */
export async function projectForCheckoutPath(key: string): Promise<ProjectRecord | null> {
  const [row] = await getDb().select().from(projects).where(eq(projects.key, key)).limit(1);
  return row ? toRecord(row) : null;
}

/** Every project an organization has, newest first. */
export async function projectsForOrganization(organizationId: string): Promise<ProjectRecord[]> {
  const rows = await getDb()
    .select()
    .from(projects)
    .where(eq(projects.organizationId, organizationId));

  return rows.map(toRecord);
}

/** Remove a project. Scoped by organization so an id alone is not enough. */
export async function deleteProject(id: string, organizationId: string): Promise<boolean> {
  const removed = await getDb()
    .delete(projects)
    .where(and(eq(projects.id, id), eq(projects.organizationId, organizationId)))
    .returning({ id: projects.id });
  return removed.length > 0;
}
