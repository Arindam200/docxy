/**
 * Better Auth, backed by Neon through Drizzle.
 *
 * Built lazily and memoised. Constructing it eagerly would mean any module that
 * merely imports this file — the proxy, a layout, the landing page's shared
 * chunk — fails to load when `DATABASE_URL` is absent, which turns a missing
 * env var into a blank site rather than a legible message on /login.
 */

import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { getDb } from "@/db";
import { schema } from "@/db/schema";
import { appUrl } from "@/lib/env";

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

    database: drizzleAdapter(getDb(), {
      provider: "pg",
      schema,
      // Model names are singular (`user`, not `users`), matching db/schema.ts.
      usePlural: false,
    }),

    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      // No transactional email provider is wired up yet, so requiring
      // verification would strand every new account. Turn this on together
      // with `sendVerificationEmail`.
      requireEmailVerification: false,
      autoSignIn: true,
      // Registration is closed by default, and that is what makes an
      // email-based operator allowlist safe to have. Open signup plus no
      // verification step means an address can be claimed by whoever types it
      // first — so an attacker who reads DOCXY_ALLOWED_EMAILS, or guesses it,
      // registers the listed address before its owner does and is an operator.
      // Existing accounts still sign in; only creating new ones is shut.
      disableSignUp: process.env.DOCXY_ALLOW_SIGNUP !== "1",
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

    // Must stay last: it is what lets Better Auth set cookies from Server
    // Actions and route handlers.
    plugins: [nextCookies()],
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
 * The addresses allowed to operate this deployment.
 *
 * Being signed in and being an operator are two different questions. A session
 * proves somebody completed a sign-in; this answers whether they may read this
 * repository's runs and approve its pull requests.
 */
export function allowedOperators(): string[] {
  return (process.env.DOCXY_ALLOWED_EMAILS ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

export type OperatorVerdict = "ok" | "unauthenticated" | "not-configured" | "not-an-operator";

/**
 * One authorization rule, asked in every place that needs it.
 *
 * It lives here rather than in the proxy because the proxy is not the only way
 * to this deployment's data: dashboard pages are server components that read
 * the pipeline API directly. A check that only the proxy performed would leave
 * every read open to any account that could sign in.
 */
export function operatorVerdict(user: Pick<SessionUser, "email"> | null): OperatorVerdict {
  if (!user) return "unauthenticated";

  // Closed by default. An empty allowlist on a deployment with auth switched on
  // means nobody has said who the operators are — and the safe reading of
  // "unspecified" is nobody, not everybody.
  const operators = allowedOperators();
  if (operators.length === 0) return "not-configured";

  const email = user.email?.trim().toLowerCase();
  return email && operators.includes(email) ? "ok" : "not-an-operator";
}

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
