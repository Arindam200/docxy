/**
 * Better Auth, backed by Neon through Drizzle.
 *
 * Built lazily and memoised. Constructing it eagerly would mean any module that
 * merely imports this file - the proxy, a layout, the landing page's shared
 * chunk - fails to load when `DATABASE_URL` is absent, which turns a missing
 * env var into a blank site rather than a legible message on /login.
 */

import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { organization as organizationPlugin } from "better-auth/plugins";
import { and, asc, eq } from "drizzle-orm";
import { cache } from "react";
import { getDb } from "@/db";
import { member, organization, schema, session as sessionTable, user } from "@/db/schema";
import { invitationsAhead, seatUsage, withdrawInvitation } from "@/lib/billing/seats";
import type { DashboardOrganization } from "@/lib/dashboard-organization";
import { appUrl, emailReady, signupOpen, trustedOrigins } from "@/lib/env";
import { sendInvitationEmail, sendVerificationEmail, sendWelcomeEmail } from "@/lib/email";
import { rankRefusal, strongestRole, type MembershipChange } from "@/lib/members";
import { acceptSeatRefusal, invitationFits, inviteSeatRefusal } from "@/lib/seats";

type Auth = ReturnType<typeof create>;

interface OAuthCredentials {
  clientId: string;
  clientSecret: string;
}

function credentials(idKey: string, secretKey: string): OAuthCredentials | undefined {
  const clientId = process.env[idKey]?.trim();
  const clientSecret = process.env[secretKey]?.trim();
  if (!clientId || !clientSecret) return undefined;
  return { clientId, clientSecret };
}

interface SocialProviders {
  google?: OAuthCredentials;
  github?: OAuthCredentials;
}

/** Only providers this deployment can actually complete a flow with. */
function socialProviders(): SocialProviders {
  const providers: SocialProviders = {};

  const google = credentials("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET");
  if (google) providers.google = google;

  const github = credentials("GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET");
  if (github) providers.github = github;

  return providers;
}

function create() {
  return betterAuth({
    appName: "Docxy",
    baseURL: appUrl(),
    secret: process.env.BETTER_AUTH_SECRET,

    // The canonical domain is not the only name this deployment answers to.
    // See `trustedOrigins` for why the list is built rather than written down.
    trustedOrigins: trustedOrigins(),

    database: drizzleAdapter(getDb(), {
      provider: "pg",
      schema,
      // Model names are singular (`user`, not `users`), matching db/schema.ts.
      usePlural: false,
    }),

    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      // The address has to be proved before the account can do anything.
      // Without it an address is claimed by whoever types it first, and an
      // organization invitation sent to that address reaches them.
      requireEmailVerification: emailReady(),
      // Signing in immediately would defeat the line above.
      autoSignIn: false,
      // Open exactly when a verification email can actually be delivered. See
      // `signupOpen()` - the invariant lives there, in one place, because the
      // signup page renders from the same answer.
      disableSignUp: !signupOpen(),
    },

    emailVerification: {
      sendOnSignUp: true,
      // The link is the last step of signing up, so it should land the person
      // in the product rather than on a login form they have just filled in.
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user, url }) => {
        await sendVerificationEmail(user.email, url);
      },
      /**
       * The welcome, at the first moment it is honest to send one.
       *
       * Not at signup: that address is unproven, and the note would arrive
       * beside the verification mail telling somebody to do things they cannot
       * do yet. Here the person is real, confirmed, and one step from
       * onboarding.
       *
       * Failure is swallowed deliberately. Verification has already succeeded
       * by this point, and throwing would turn a missing welcome into a broken
       * confirmation link - losing the account to save the greeting.
       */
      afterEmailVerification: async (user) => {
        try {
          await sendWelcomeEmail(user.email, user.name);
        } catch (cause) {
          console.error(
            `could not send the welcome email to ${user.email}: ${
              cause instanceof Error ? cause.message : String(cause)
            }`,
          );
        }
      },
    },

    socialProviders: socialProviders(),

    hooks: {
      /**
       * Rank between admins, which the organization plugin does not enforce.
       *
       * Its remove-member and update-member-role endpoints protect the owner
       * and check the caller's permission, and that is all: any admin could
       * remove or demote any other admin. The plugin's own `beforeRemoveMember`
       * and `beforeUpdateMemberRole` hooks cannot close that, because they are
       * told who is being changed and never who is changing them. A request
       * hook sees the session, so the rule goes here - and it is the same
       * `rankRefusal` the Members page asks before it offers a button.
       *
       * Anything this cannot resolve - no session, a caller or target that is
       * not in the organization - is left for the endpoint, which refuses all
       * of those itself.
       */
      before: createAuthMiddleware(async (ctx) => {
        const removing = ctx.path === "/organization/remove-member";
        if (!removing && ctx.path !== "/organization/update-member-role") return;

        const current = await getSessionFromCtx(ctx);
        if (!current) return;

        // Read as the endpoint reads it: a named organization, or else the
        // session's active one. Checking any other organization than the one
        // the endpoint is about to act on would check nothing.
        const named = ctx.body?.organizationId ? String(ctx.body.organizationId) : "";
        const organizationId = named || claimedOrganization(current.session);
        if (!organizationId) return;

        const target = removing
          ? String(ctx.body?.memberIdOrEmail ?? "")
          : String(ctx.body?.memberId ?? "");
        const change: MembershipChange = removing
          ? { kind: "remove" }
          : { kind: "role", roles: requestedRoles(ctx.body?.role) };

        const refusal = await membershipRefusal(current.user.id, organizationId, target, change);
        if (refusal) throw new APIError("FORBIDDEN", { message: refusal });
      }),
    },

    account: {
      accountLinking: {
        // Signing in with Google and later with GitHub on the same verified
        // address lands on one user rather than two.
        enabled: true,
        trustedProviders: ["google", "github"],
      },
    },

    session: {
      expiresIn: 60 * 60 * 24 * 30, // 30 days
      updateAge: 60 * 60 * 24, // refresh the expiry at most once a day
      cookieCache: {
        // Lets the proxy and layouts read a signed session off the cookie
        // instead of hitting Neon on every navigation.
        enabled: true,
        maxAge: 5 * 60,
      },
    },

    /**
     * Every session carries the organization it is looking at.
     *
     * Set when the session is created rather than read per request: the
     * dashboard asks "which org am I in" on every server component, and that
     * should not be a query each time. A user with no membership yet - signed
     * up, verified, not yet through onboarding - gets null, which the dashboard
     * reads as "send them to name their first organization".
     */
    databaseHooks: {
      session: {
        create: {
          before: async (session) => {
            const rows = await getDb()
              .select({ organizationId: member.organizationId })
              .from(member)
              .where(eq(member.userId, session.userId))
              .limit(1);
            return { data: { ...session, activeOrganizationId: rows[0]?.organizationId ?? null } };
          },
        },
      },
    },

    plugins: [
      organizationPlugin({
        // Anyone may create one, because everyone needs one: an account with no
        // organization owns nothing and can see nothing.
        allowUserToCreateOrganization: true,
        // Whoever creates an org owns it, and an owner is the only role that
        // can delete it or hand it over.
        creatorRole: "owner",
        invitationExpiresIn: 60 * 60 * 24 * 7, // one week
        sendInvitationEmail: async ({ id, email, organization: org, inviter }) => {
          await sendInvitationEmail({
            to: email,
            organizationName: org.name,
            inviterName: inviter.user.name || inviter.user.email,
            url: `${appUrl() ?? ""}/invite/${id}`,
          });
        },
        organizationHooks: {
          /**
           * Hold an invitation to the seats the organization's plan includes.
           *
           * Without this the plugin's default of a hundred members applied to
           * everybody, so a one-seat plan could invite twenty people. A pending
           * invitation reserves its seat - see `lib/seats.ts` - so this counts
           * them too. Re-sending an invitation that already exists returns
           * before this hook runs, which is right: it takes no new seat.
           */
          beforeCreateInvitation: async ({ organization: org }) => {
            const usage = await seatUsage(org.id);
            const refusal = usage ? inviteSeatRefusal(usage) : null;
            if (refusal) throw new APIError("FORBIDDEN", { message: refusal });
          },
          /**
           * The same limit again, now that the invitation exists.
           *
           * The check above and the plugin's insert are separate statements,
           * so two invitations sent at once could both pass it for the last
           * seat. Seats go to invitations in the order they were created, so
           * the later of two that raced is withdrawn here and its sender told
           * why. Its email may already have gone out; the link then finds a
           * cancelled invitation, which is the right answer for it.
           */
          afterCreateInvitation: async ({ invitation: created, organization: org }) => {
            const usage = await seatUsage(org.id);
            if (!usage) return;
            if (invitationFits(usage, await invitationsAhead(org.id, created.id))) return;
            await withdrawInvitation(created.id);
            const others = { ...usage, pendingInvitations: Math.max(0, usage.pendingInvitations - 1) };
            throw new APIError("FORBIDDEN", {
              message:
                inviteSeatRefusal(others) ??
                "Another invitation took this organization's last free seat a moment ago.",
            });
          },
          /**
           * The same limit, at the moment a reservation becomes a member.
           *
           * Checked here rather than through the plugin's `membershipLimit`,
           * which can be a function of the organization but answers a full plan
           * with a generic sentence that names neither the plan nor the limit.
           * That option still defaults to a hundred, so this is the tighter of
           * the two whenever seats are enforced.
           */
          beforeAcceptInvitation: async ({ organization: org }) => {
            const usage = await seatUsage(org.id);
            const refusal = usage ? acceptSeatRefusal(usage) : null;
            if (refusal) throw new APIError("FORBIDDEN", { message: refusal });
          },
          /**
           * Take the organization out of every session the removed account holds.
           *
           * Better Auth clears `activeOrganizationId` only on the session that
           * made the request, which is the remover's - so it covers somebody
           * leaving and nobody being removed. Every session the removed account
           * already had kept naming the organization for its thirty-day life.
           *
           * This is tidiness rather than the boundary. The cookie cache serves
           * a signed copy of the session for up to five minutes without reading
           * this row, so the field can still name the organization for that
           * long; what actually refuses those requests is the membership check
           * in `getMemberOrganizationId` below. What this buys is that the next
           * fresh session read lands on onboarding's repair path instead of
           * carrying a dead id indefinitely.
           *
           * Failure is logged and swallowed for the same reason the welcome
           * email's is: the member row is already gone by the time this runs,
           * and throwing would report a removal that succeeded as one that
           * failed.
           */
          afterRemoveMember: async ({ member: removed, organization: org }) => {
            try {
              await getDb()
                .update(sessionTable)
                .set({ activeOrganizationId: null })
                .where(
                  and(
                    eq(sessionTable.userId, removed.userId),
                    eq(sessionTable.activeOrganizationId, org.id),
                  ),
                );
            } catch (cause) {
              console.error(
                `could not clear ${org.id} from the sessions of removed user ${removed.userId}: ${
                  cause instanceof Error ? cause.message : String(cause)
                }`,
              );
            }
          },
        },
      }),
      // Must stay last: it is what lets Better Auth set cookies from Server
      // Actions and route handlers.
      nextCookies(),
    ],
  });
}

/**
 * The roles an update-member-role request asks for, split the way the plugin
 * splits them: a string or a list, each of which may itself be comma-separated.
 */
function requestedRoles(raw: string | string[] | undefined): string[] {
  return (Array.isArray(raw) ? raw : [raw ?? ""])
    .flatMap((role) => String(role).split(","))
    .map((role) => role.trim())
    .filter(Boolean);
}

/**
 * Whether rank lets this user make `change` to the member `target` names.
 *
 * `target` is resolved as the plugin resolves it: an address names a user in
 * the organization the request acts on, and anything else is a member row id.
 * A row id is looked up wherever it is, and rank is then checked in the
 * organization that row actually belongs to - the only one the endpoint can
 * act on it in, whichever organization the request named. A target that does
 * not exist is left for the endpoint, which refuses it itself.
 */
async function membershipRefusal(
  actorUserId: string,
  organizationId: string,
  target: string,
  change: MembershipChange,
): Promise<string | null> {
  if (!target) return null;
  const db = getDb();
  const fields = { userId: member.userId, role: member.role, organizationId: member.organizationId };
  const [targeted] = target.includes("@")
    ? await db
        .select(fields)
        .from(member)
        .innerJoin(user, eq(member.userId, user.id))
        .where(and(eq(member.organizationId, organizationId), eq(user.email, target.toLowerCase())))
        .limit(1)
    : await db.select(fields).from(member).where(eq(member.id, target)).limit(1);
  if (!targeted) return null;

  const [actor] = await db
    .select({ role: member.role })
    .from(member)
    .where(and(eq(member.organizationId, targeted.organizationId), eq(member.userId, actorUserId)))
    .limit(1);
  // Not a member where the target is: the endpoint refuses that on its own.
  if (!actor) return null;

  return rankRefusal(
    strongestRole(actor.role),
    strongestRole(targeted.role),
    targeted.userId === actorUserId,
    change,
  );
}

let cached: Auth | undefined;

export function getAuth(): Auth {
  cached ??= create();
  return cached;
}

export type Session = Auth["$Infer"]["Session"]["session"];
export type SessionUser = Auth["$Infer"]["Session"]["user"];

/**
 * The session behind one request, read once however many places ask.
 *
 * A dashboard render asks for it from the layout, from the page, and from the
 * helpers both of those call - two to four times a request, and each of them a
 * query whenever the cookie cache has lapsed. React's `cache` keys on its
 * argument, and inside a render `await headers()` resolves to the same object
 * for the whole request (Next memoises it per request, in
 * next/dist/server/request/headers.js), so every caller lands on one entry. A
 * caller holding some other object reads the session again, which is slower
 * and no less correct.
 *
 * A route handler is not a render. There is no request for `cache` to scope
 * to, so it passes straight through and each call reads, as it always did.
 */
const sessionFor = cache((headers: Headers) => getAuth().api.getSession({ headers }));

/** The organization a session *claims*, before anybody has checked it. */
function claimedOrganization(session: Session | undefined): string | null {
  // SAFETY: the organization plugin adds `activeOrganizationId` to the session
  // model - it is in the schema this adapter reads and writes - but the
  // inferred type does not carry plugin fields through. The property is read as
  // optional and defaulted, so a build where it is genuinely absent yields null
  // rather than lying.
  const claim = session as { activeOrganizationId?: string | null } | undefined;
  return claim?.activeOrganizationId ?? null;
}

/**
 * The signed-in user for the current request, or null.
 *
 * Errors are not swallowed: a database that is down should surface as an error
 * boundary, not as a silent sign-out.
 */
export async function getSessionUser(headers: Headers): Promise<SessionUser | null> {
  const result = await sessionFor(headers);
  return result?.user ?? null;
}

/**
 * The organization this session names, unconfirmed, or null.
 *
 * A claim, not an authorization. The id is stamped on when the session is
 * created and trusted from then on, so it keeps naming an organization the
 * account has since been removed from. The callers left each pair it with a
 * membership check of their own: the dashboard layout and onboarding through
 * `resolveOrganization`, because they need to tell "names nothing" from "names
 * the wrong thing" in order to repair it, and `integrationScope` through the
 * member's role, which it needs anyway. Anything else that reads or writes an
 * organization's data asks `getMemberOrganizationId` instead.
 *
 * Null has one meaning and it is not "everything": the account has not finished
 * onboarding and owns nothing yet. Callers send those people to /onboarding
 * rather than rendering an empty dashboard that looks like a broken one.
 */
export async function getActiveOrganizationId(headers: Headers): Promise<string | null> {
  const result = await sessionFor(headers);
  return claimedOrganization(result?.session);
}

/**
 * The organization this session is looking at, confirmed against the member
 * table, or null.
 *
 * `activeOrganizationId` is written into the session when the session is
 * created and trusted from then on, so removing somebody from an organization
 * did not remove the organization from their session: every page and every
 * proxied write went on serving it for the rest of a thirty-day session. This
 * is the question that outlives the session field, and it is now the one every
 * read and write asks - the proxy, the live stream, every dashboard page by way
 * of `activeOrganizationId()`, the GitHub install flow and billing.
 *
 * The confirmation is the account's membership listing rather than a lookup of
 * its own, so that a render asks the database once: the dashboard layout
 * already needs that listing for the organization switcher, and both share one
 * `cache` entry per user id. Memoised per request the same way as the session.
 */
export const getMemberOrganizationId = cache(
  async (headers: Headers): Promise<string | null> => {
    const result = await sessionFor(headers);
    const organizationId = claimedOrganization(result?.session);
    const userId = result?.user?.id;
    if (!organizationId || !userId) return null;

    const organizations = await getUserOrganizations(userId);
    return organizations.some((entry) => entry.id === organizationId) ? organizationId : null;
  },
);

/**
 * Every organization the user may switch this session to.
 *
 * Memoised per request, keyed by user id: the layout reads it for the switcher
 * and `getMemberOrganizationId` reads it to confirm the session's claim, and
 * that is one question asked twice rather than two.
 */
export const getUserOrganizations = cache(
  async (userId: string): Promise<DashboardOrganization[]> =>
    getDb()
      .select({
        id: organization.id,
        name: organization.name,
        slug: organization.slug,
        logo: organization.logo,
      })
      .from(member)
      .innerJoin(organization, eq(member.organizationId, organization.id))
      .where(eq(member.userId, userId))
      .orderBy(asc(organization.name), asc(organization.id)),
);

/*
 * There was a deployment-wide operator allowlist here - DOCXY_ALLOWED_EMAILS,
 * and an `operatorVerdict` every entry point asked before showing anything.
 *
 * It was removed when registration opened, because it answered the wrong
 * question. It asked whether an address belonged to whoever runs the
 * deployment, which is a sensible thing to ask of a single-operator install and
 * meaningless once anybody can sign up: it let one person in and turned every
 * other account into a dead end at /dashboard.
 *
 * What replaced it is not a laxer version of the same check. It is a different
 * one, asked in a different place: authorization is now by organization
 * membership, enforced where the data is read rather than at the door. The
 * session carries `activeOrganizationId`, every API read names it, and the
 * pipeline refuses a read that does not - see `requestPaths` in
 * src/server/index.ts. Being signed in gets an account as far as its own
 * organization, and no further.
 */

/**
 * Whether this deployment enforces sign-in at all.
 *
 * `DOCXY_REQUIRE_AUTH=0` is the demo escape hatch and the only thing that turns
 * the checks off. A deployment that merely *forgot* DATABASE_URL or
 * BETTER_AUTH_SECRET is misconfigured, not public: treating that as "no auth
 * needed" would fail open exactly when someone is least likely to notice.
 */
export function authRequired(): boolean {
  return process.env.DOCXY_REQUIRE_AUTH !== "0";
}
