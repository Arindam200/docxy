/**
 * Configuration status, readable without touching the database.
 *
 * Deliberately free of side effects and heavy imports so that pages can render
 * an honest "not configured yet" state instead of a 500 when a deployment is
 * missing its environment. Nothing here throws.
 */

export interface EnvRequirement {
  key: string;
  present: boolean;
  hint: string;
}

function has(key: string): boolean {
  return Boolean(process.env[key]?.trim());
}

/** Sign-in cannot work at all without these. */
export function requiredEnv(): EnvRequirement[] {
  return [
    {
      key: "DATABASE_URL",
      present: has("DATABASE_URL"),
      hint: "Pooled Neon connection string, from the Neon console.",
    },
    {
      key: "BETTER_AUTH_SECRET",
      present: has("BETTER_AUTH_SECRET"),
      hint: "Signing key for sessions: openssl rand -base64 32",
    },
  ];
}

export function googleConfigured(): boolean {
  return has("GOOGLE_CLIENT_ID") && has("GOOGLE_CLIENT_SECRET");
}

export function githubConfigured(): boolean {
  return has("GITHUB_CLIENT_ID") && has("GITHUB_CLIENT_SECRET");
}

/** Email + password needs no third-party credentials, so it is always available. */
export function authReady(): boolean {
  return requiredEnv().every((item) => item.present);
}

/**
 * Whether new accounts may be created here.
 *
 * Closed by default: there is no email verification step, so an open form would
 * let whoever types an address in DOCXY_ALLOWED_EMAILS first become an
 * operator. Opened deliberately, for long enough to create the first account.
 */
export function signupOpen(): boolean {
  return process.env.DOCXY_ALLOW_SIGNUP === "1";
}

export function missingEnv(): EnvRequirement[] {
  return requiredEnv().filter((item) => !item.present);
}

/**
 * The origin Better Auth builds callback URLs from. Behind a proxy or tunnel
 * the request origin is not the public one, so an explicit value wins.
 */
export function appUrl(): string | undefined {
  return process.env.BETTER_AUTH_URL?.trim() || process.env.APP_URL?.trim() || undefined;
}
