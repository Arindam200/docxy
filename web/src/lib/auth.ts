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
import { nextCookies } from "better-auth/next-js";
import { organization as organizationPlugin } from "better-auth/plugins";
import { and, asc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { member, organization, schema } from "@/db/schema";
import type { DashboardOrganization } from "@/lib/dashboard-organization";
import { appUrl, emailReady, signupOpen, trustedOrigins } from "@/lib/env";
import { sendInvitationEmail, sendVerificationEmail, sendWelcomeEmail } from "@/lib/email";

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
      }),
      // Must stay last: it is what lets Better Auth set cookies from Server
      // Actions and route handlers.
      nextCookies(),
    ],
  });
}

let cached: Auth | undefined;

export function getAuth(): Auth {
  cached ??= create();
  return cached;
}

export type Session = Auth["$Infer"]["Session"]["session"];
export type SessionUser = Auth["$Infer"]["Session"]["user"];

/**
 * The signed-in user for the current request, or null.
 *
 * Errors are not swallowed: a database that is down should surface as an error
 * boundary, not as a silent sign-out.
 */
export async function getSessionUser(headers: Headers): Promise<SessionUser | null> {
  const result = await getAuth().api.getSession({ headers });
  return result?.user ?? null;
}

/**
 * The organization this session is looking at, or null.
 *
 * Null has one meaning and it is not "everything": the account has not finished
 * onboarding and owns nothing yet. Callers send those people to /onboarding
 * rather than rendering an empty dashboard that looks like a broken one.
 */
export async function getActiveOrganizationId(headers: Headers): Promise<string | null> {
  const result = await getAuth().api.getSession({ headers });
  // SAFETY: the organization plugin adds `activeOrganizationId` to the session
  // model - it is in the schema this adapter reads and writes - but the
  // inferred type does not carry plugin fields through. The property is read as
  // optional and defaulted, so a build where it is genuinely absent yields null
  // rather than lying.
  const session = result?.session as { activeOrganizationId?: string | null } | undefined;
  return session?.activeOrganizationId ?? null;
}

/**
 * The organization this session is looking at, confirmed against the member
 * table, or null.
 *
 * `activeOrganizationId` is written into the session when the session is
 * created and trusted from then on, so removing somebody from an organization
 * does not remove the organization from their session. Anything that hands out
 * data for the whole life of a connection rather than for the life of one
 * request has to ask the question that outlives the session field, and this is
 * that question.
 *
 * It costs a query, which is why the ordinary per-request reads still use
 * `getActiveOrganizationId`: closing that gap everywhere is separate work,
 * tracked in guides/LIVE-UPDATES-PLAN.md. A live stream is where it matters
 * most, because there the alternative is an hour of somebody else's runs.
 */
export async function getMemberOrganizationId(headers: Headers): Promise<string | null> {
  const result = await getAuth().api.getSession({ headers });
  // SAFETY: same reading as `getActiveOrganizationId` above - the organization
  // plugin writes `activeOrganizationId` onto the session model but the
  // inferred type does not carry plugin fields, so it is read as optional and
  // an absent value yields null rather than a claim.
  const session = result?.session as { activeOrganizationId?: string | null } | undefined;
  const organizationId = session?.activeOrganizationId;
  const userId = result?.user?.id;
  if (!organizationId || !userId) return null;

  const rows = await getDb()
    .select({ id: member.id })
    .from(member)
    .where(and(eq(member.organizationId, organizationId), eq(member.userId, userId)))
    .limit(1);
  return rows.length > 0 ? organizationId : null;
}

/** Every organization the user may switch this session to. */
export async function getUserOrganizations(userId: string): Promise<DashboardOrganization[]> {
  return getDb()
    .select({
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      logo: organization.logo,
    })
    .from(member)
    .innerJoin(organization, eq(member.organizationId, organization.id))
    .where(eq(member.userId, userId))
    .orderBy(asc(organization.name), asc(organization.id));
}

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
