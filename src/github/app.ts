import { createHmac, createSign, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';

/**
 * GitHub App identity.
 *
 * The difference this makes is whose name is on the pull request. Without it,
 * docxy pushes through whatever credential helper the machine has configured
 * and the PR is authored by a person. With it, the PR is authored by the app,
 * which is what makes an automated proposal legible as one.
 */

export interface AppCredentials {
  appId: string;
  privateKey: string;
  installationId: string;
  slug: string;
  botEmail: string;
}

/** App JWT: RS256, ten minutes maximum, issued by the App id. */
function appJwt(appId: string, pem: string): string {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url');

  // `iat` is backdated a minute to tolerate clock skew between here and GitHub;
  // `exp` stays inside the ten-minute ceiling GitHub enforces.
  const body =
    `${encode({ alg: 'RS256', typ: 'JWT' })}.` +
    `${encode({ iat: now - 60, exp: now + 540, iss: appId })}`;

  return `${body}.${createSign('RSA-SHA256').update(body).sign(pem, 'base64url')}`;
}

/** Null when the App is not configured, which is the signal to fall back. */
export function readAppCredentials(): AppCredentials | null {
  const appId = process.env.GITHUB_APP_ID?.trim();
  const keyPath = process.env.GITHUB_APP_PRIVATE_KEY_PATH?.trim();
  const installationId = process.env.GITHUB_APP_INSTALLATION_ID?.trim();
  if (!appId || !keyPath || !installationId) return null;

  const slug = process.env.GITHUB_APP_SLUG?.trim() || 'docxy';
  let privateKey: string;
  try {
    privateKey = readFileSync(keyPath, 'utf8');
  } catch (cause) {
    throw new Error(
      `GITHUB_APP_PRIVATE_KEY_PATH points at ${keyPath}, which could not be read: ` +
        `${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  return {
    appId,
    privateKey,
    installationId,
    slug,
    botEmail:
      process.env.GITHUB_APP_BOT_EMAIL?.trim() || `${slug}[bot]@users.noreply.github.com`,
  };
}

/**
 * An installation token: one hour, attenuated to the repositories this run
 * touches and to the two permissions it needs.
 *
 * Minted at the moment it is used and never stored on a run record. The
 * approval gate can wait days, and a token recorded when the run started would
 * be long dead by the time someone signs off.
 */
export async function installationToken(
  credentials: AppCredentials,
  repositories: string[],
): Promise<string> {
  const response = await fetch(
    `https://api.github.com/app/installations/${credentials.installationId}/access_tokens`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${appJwt(credentials.appId, credentials.privateKey)}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'docxy',
      },
      body: JSON.stringify({
        repositories,
        permissions: { contents: 'write', pull_requests: 'write' },
      }),
    },
  );

  if (!response.ok) {
    throw new Error(
      `Could not mint an installation token (HTTP ${response.status}): ${await response.text()}`,
    );
  }

  const body = (await response.json()) as { token?: string };
  if (!body.token) throw new Error('GitHub returned an installation token response with no token.');
  return body.token;
}

/**
 * Timing-safe webhook signature check.
 *
 * A plain `===` on an HMAC leaks the position of the first differing byte, and
 * with an attacker-controlled body that is enough to recover a valid signature
 * one byte at a time.
 */
export function verifyWebhook(
  body: Buffer,
  header: string | undefined,
  secret: string,
): boolean {
  if (!secret || !header) return false;

  const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(body).digest('hex')}`);
  const received = Buffer.from(header);
  // `timingSafeEqual` throws on a length mismatch, so that is checked first —
  // length is not secret, the contents are.
  return expected.length === received.length && timingSafeEqual(expected, received);
}

/** Never let a tokenized remote URL reach a log line or an error message. */
export function scrubToken(text: string): string {
  return text.replace(/x-access-token:[^@]+@/g, 'x-access-token:***@');
}

export interface AppStatus {
  configured: boolean;
  slug?: string;
  appId?: string;
  installationId?: string;
  botEmail?: string;
  webhookSecretSet: boolean;
  /** What is missing, for a setup checklist. */
  missing: string[];
}

/** Read-only view of the App configuration, for the integrations dashboard. */
export function appStatus(): AppStatus {
  const missing: string[] = [];
  for (const key of [
    'GITHUB_APP_ID',
    'GITHUB_APP_PRIVATE_KEY_PATH',
    'GITHUB_APP_INSTALLATION_ID',
  ]) {
    if (!process.env[key]?.trim()) missing.push(key);
  }

  const webhookSecretSet = Boolean(process.env.GITHUB_WEBHOOK_SECRET?.trim());
  if (missing.length > 0) {
    return { configured: false, webhookSecretSet, missing };
  }

  let credentials: AppCredentials | null = null;
  try {
    credentials = readAppCredentials();
  } catch (cause) {
    return {
      configured: false,
      webhookSecretSet,
      missing: [cause instanceof Error ? cause.message : String(cause)],
    };
  }
  if (!credentials) return { configured: false, webhookSecretSet, missing };

  return {
    configured: true,
    slug: credentials.slug,
    appId: credentials.appId,
    installationId: credentials.installationId,
    botEmail: credentials.botEmail,
    webhookSecretSet,
    missing: [],
  };
}
