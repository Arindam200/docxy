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
