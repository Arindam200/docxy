import { and, eq } from 'drizzle-orm';
import { getDb } from './index.js';
import { githubInstallations } from './schema.js';

/**
 * The mapping from a GitHub App installation to the organization that owns it.
 *
 * Deliberately not part of the three storage interfaces in `pipeline/stores.ts`.
 * Those exist because runs, sessions and knowledge each have a JSON-backed
 * implementation for the zero-setup path; this one has no such fallback and
 * should not pretend to. Multi-tenancy is a deployment concern, and a
 * deployment has Postgres - a laptop running against `.docxy/` documents one
 * repository and needs no notion of whose it is.
 */

export interface Installation {
  installationId: string;
  organizationId: string;
  accountLogin?: string;
}

/** Raised when an installation is already owned by a different organization. */
export class InstallationOwnedError extends Error {
  constructor(readonly installationId: string) {
    super(`Installation ${installationId} is already bound to another organization.`);
    this.name = 'InstallationOwnedError';
  }
}

/**
 * Record who owns an installation.
 *
 * An upsert rather than an insert because the same installation legitimately
 * arrives twice: GitHub redirects on install, and again on every update when
 * "Redirect on update" is on.
 *
 * It will not, however, move an installation between organizations. That was
 * the first version of this function and it was a cross-tenant takeover: the
 * installation id arrives on a query string, so anyone with an account could
 * call the callback with somebody else's id - they are small integers - and
 * repoint it at their own organization. Every subsequent push to that
 * repository would then have been attributed to them, along with its diffs,
 * prompts and drafted documentation.
 *
 * The callers verify with GitHub that the installer controls the installation
 * before getting here. This is the second lock, at the only layer every path
 * must pass through: a re-bind is refused rather than silently applied, so a
 * verification step that is ever missed or bypassed still cannot take an
 * installation away from the organization that owns it. Handing one over is a
 * deliberate act and needs `releaseInstallation` first.
 */
export async function bindInstallation(installation: Installation): Promise<void> {
  const { installationId, organizationId, accountLogin } = installation;

  // One statement, so the check and the write cannot be separated by another
  // caller: the update applies only where the owner already matches, and an
  // empty RETURNING means the row exists under a different one.
  const written = await getDb()
    .insert(githubInstallations)
    .values({ installationId, organizationId, accountLogin })
    .onConflictDoUpdate({
      target: githubInstallations.installationId,
      set: { organizationId, accountLogin, updatedAt: new Date() },
      setWhere: eq(githubInstallations.organizationId, organizationId),
    })
    .returning({ installationId: githubInstallations.installationId });

  if (written.length === 0) throw new InstallationOwnedError(installationId);
}

/**
 * Give up an installation, so another organization may claim it.
 *
 * The deliberate half of the refusal above. Callers must establish that the
 * requester owns it now - this only performs the release.
 */
export async function releaseInstallation(
  installationId: string,
  organizationId: string,
): Promise<boolean> {
  const removed = await getDb()
    .delete(githubInstallations)
    .where(
      and(
        eq(githubInstallations.installationId, installationId),
        eq(githubInstallations.organizationId, organizationId),
      ),
    )
    .returning({ installationId: githubInstallations.installationId });
  return removed.length > 0;
}

/** Who owns this installation, or null if nobody has claimed it yet. */
export async function organizationForInstallation(
  installationId: string,
): Promise<string | null> {
  const [row] = await getDb()
    .select({ organizationId: githubInstallations.organizationId })
    .from(githubInstallations)
    .where(eq(githubInstallations.installationId, installationId))
    .limit(1);
  return row?.organizationId ?? null;
}

/** Every installation an organization has, for listing its repositories. */
export async function installationsForOrganization(
  organizationId: string,
): Promise<Installation[]> {
  const rows = await getDb()
    .select({
      installationId: githubInstallations.installationId,
      organizationId: githubInstallations.organizationId,
      accountLogin: githubInstallations.accountLogin,
    })
    .from(githubInstallations)
    .where(eq(githubInstallations.organizationId, organizationId));

  return rows.map((row) => {
    const installation: Installation = {
      installationId: row.installationId,
      organizationId: row.organizationId,
    };
    if (row.accountLogin) installation.accountLogin = row.accountLogin;
    return installation;
  });
}
