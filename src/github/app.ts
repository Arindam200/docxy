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

/**
 * A GitHub request that survives a bad moment.
 *
 * Every call here is a network hop to api.github.com, and the failures worth
 * distinguishing are: a transient one (`fetch failed` - DNS, a dropped socket,
 * a blip), which is worth repeating; a 5xx or a rate limit, likewise; and a
 * 4xx, which will say exactly the same thing however many times it is asked.
 *
 * Not decoration. A run reached the point of publishing with five agents' work
 * finished behind it, and lost the pull request to one `fetch failed` - the
 * proposal survived, but somebody then had to notice and republish it by hand.
 */
/** Back off, but not past a caller that has already given up. */
async function sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error('The request was cancelled.');
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error('The request was cancelled.'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function githubFetch(
  url: string,
  init: RequestInit,
  attempts = 3,
): Promise<Response> {
  let last: Error = new Error('never attempted');

  const caller = init.signal ?? undefined;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    // Without a timeout a hung connection blocks until the platform's own,
    // which is minutes and long past useful. Composed with the caller's rather
    // than replacing it: the signature takes a whole `RequestInit`, so a caller
    // that passes a signal means it - and overwriting it left a run's deadline
    // unable to cancel the request it was waiting on.
    const timeout = AbortSignal.timeout(20_000);
    try {
      const response = await fetch(url, {
        ...init,
        signal: caller ? AbortSignal.any([caller, timeout]) : timeout,
      });
      // A 401 is GitHub saying the credential is dead. When that credential is
      // a cached installation token, the cache is wrong about it, and the next
      // caller should get a fresh one rather than the same refusal.
      if (response.status === 401) forgetBearer(new Headers(init.headers).get('authorization'));
      // 5xx and 429 are GitHub having a moment; anything else is an answer.
      if (response.status < 500 && response.status !== 429) return response;
      if (attempt === attempts) return response;
      last = new Error(`HTTP ${response.status}`);
    } catch (cause) {
      last = cause instanceof Error ? cause : new Error(String(cause));
      // A caller cancelling is a decision, not a fault. Retrying it would work
      // around the thing that asked for the work to stop.
      if (caller?.aborted) throw last;
      if (attempt === attempts) break;
    }
    await sleepUnlessAborted(500 * 2 ** (attempt - 1), caller);
  }

  throw new Error(
    `Could not reach the GitHub API at ${new URL(url).pathname} after ${attempts} ` +
      `attempts: ${last.message}`,
  );
}

/**
 * Repair a PEM that travelled through an environment variable.
 *
 * Two shapes arrive, and both are what a deployment dashboard's paste box
 * actually produces. Base64 of the PEM is the shape people reach for precisely
 * to avoid the newline problem, so it is decoded when the value carries no
 * header and nothing outside the base64 alphabet. The other shape is a PEM
 * whose line breaks survived as the two characters `\` and `n`, which is what
 * a shell `export` and most web forms do to a multi-line value - repaired
 * rather than rejected, because the resulting key fails to parse with an error
 * that points nowhere near the cause.
 */
export function normalizePem(raw: string): string {
  const value = raw.trim();
  if (!value.includes('-----BEGIN') && /^[A-Za-z0-9+/=\s]+$/.test(value)) {
    const decoded = Buffer.from(value, 'base64').toString('utf8');
    if (decoded.includes('-----BEGIN')) return decoded.trim();
  }
  return value.includes('\\n') ? value.replace(/\\n/g, '\n') : value;
}

/**
 * The App's PEM, from the environment or from a file.
 *
 * A path is the right shape on a laptop, where the key is a download that never
 * needs to move. It is the wrong shape on a managed platform: Railway, Render
 * and Fly hand a service environment variables, not a filesystem to place
 * secrets on beforehand. So `GITHUB_APP_PRIVATE_KEY` carries the key itself and
 * wins when both are set, and neither being set is "not configured" rather than
 * an error - the same signal an absent App id gives.
 */
function readPrivateKey(): string | null {
  const inline = process.env.GITHUB_APP_PRIVATE_KEY?.trim();
  if (inline) return normalizePem(inline);

  const keyPath = process.env.GITHUB_APP_PRIVATE_KEY_PATH?.trim();
  if (!keyPath) return null;

  try {
    return readFileSync(keyPath, 'utf8');
  } catch (cause) {
    throw new Error(
      `GITHUB_APP_PRIVATE_KEY_PATH points at ${keyPath}, which could not be read: ` +
        `${cause instanceof Error ? cause.message : String(cause)}. ` +
        `On a platform with nowhere to put the file, set GITHUB_APP_PRIVATE_KEY ` +
        `to the PEM itself instead.`,
    );
  }
}

/**
 * `owner/name` from a GitHub remote URL, or null when it is not one.
 *
 * Shared because three copies of the same regex each stopped the name at its
 * first dot - `vercel/next.js` read as `vercel/next`, `alice/alice.github.io`
 * as `alice/alice` - so a repository with a dot in its name minted a token for
 * a different repository, or none, and could not be published. Only a trailing
 * `.git` is a suffix; every other dot is part of the name.
 */
export function githubRepoFromUrl(url: string): string | null {
  const match = /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(url.trim());
  return match?.[1] ?? null;
}

/** Null when the App is not configured, which is the signal to fall back. */
export function readAppCredentials(): AppCredentials | null {
  const appId = process.env.GITHUB_APP_ID?.trim();
  const installationId = process.env.GITHUB_APP_INSTALLATION_ID?.trim();
  if (!appId || !installationId) return null;

  const privateKey = readPrivateKey();
  if (!privateKey) return null;

  const slug = process.env.GITHUB_APP_SLUG?.trim() || 'docxy';
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
 * How long before GitHub's own expiry a cached token stops being handed out.
 *
 * A token is checked when each request *starts*, so the margin has to cover
 * the longest stretch between asking for one and starting the last request
 * made with it - a push, a pull request and its retries. Five minutes of an
 * hour-long token is cheap insurance against a request that starts with
 * seconds to spare and is refused halfway through publishing.
 */
const TOKEN_REUSE_MARGIN_MS = 5 * 60 * 1000;

/**
 * Tokens already minted, by installation and repository set.
 *
 * Memory only, and only for this process: never written to a run record, a
 * log line or the disk, so a restart forgets every one of them and nothing
 * outlives the hour GitHub gives it. The cost it removes is real - a single
 * webhook run asked for a fresh token to sync the code, again for the docs
 * checkout, again for each docs-branch fetch and again to publish, each one a
 * signed JWT and a round trip to GitHub for a credential it already had.
 */
const tokenCache = new Map<string, { token: string; reusableUntil: number }>();

/**
 * Until when a token GitHub says expires at `expiresAt` may be handed out again.
 *
 * `now` - reuse never - when the answer carries no expiry or one that does not
 * parse: a token whose lifetime is unknown is used once by the caller that
 * minted it, rather than cached on a guess about when it dies.
 */
export function tokenReusableUntil(expiresAt: string | undefined, now: number): number {
  const expiry = expiresAt ? Date.parse(expiresAt) : Number.NaN;
  if (!Number.isFinite(expiry)) return now;
  return Math.max(now, expiry - TOKEN_REUSE_MARGIN_MS);
}

/**
 * Drop a token GitHub has refused, so the next caller mints a fresh one.
 *
 * Keyed by the token itself because that is all a refusal carries: a 401 from
 * the API or "Authentication failed" from git names no installation. A token
 * that was never cached matches nothing, which is the right answer for the
 * App JWT and for anything else that reaches here.
 */
export function forgetInstallationToken(token: string): void {
  for (const [key, cached] of tokenCache) {
    if (cached.token === token) tokenCache.delete(key);
  }
}

/** The token half of an `authorization` header, forgotten if it was cached. */
function forgetBearer(header: string | null): void {
  const token = header?.replace(/^(?:bearer|token)\s+/i, '').trim();
  if (token) forgetInstallationToken(token);
}

/**
 * An installation token: one hour, attenuated to the repositories this run
 * touches and to the two permissions it needs.
 *
 * Asked for at the moment it is used and never stored on a run record. The
 * approval gate can wait days, and a token recorded when the run started would
 * be long dead by the time someone signs off. Reused from memory while it has
 * more than `TOKEN_REUSE_MARGIN_MS` to live, so asking is cheap and every
 * caller can keep asking at the point of use rather than holding one.
 */
export async function installationToken(
  credentials: AppCredentials,
  repositories: string[],
): Promise<string> {
  // Repository names are case-insensitive on GitHub, and the order a caller
  // listed them in says nothing about which token it needs.
  const key = [
    credentials.appId,
    credentials.installationId,
    ...repositories.map((name) => name.toLowerCase()).sort(),
  ].join('\n');
  const cached = tokenCache.get(key);
  if (cached && Date.now() < cached.reusableUntil) return cached.token;
  tokenCache.delete(key);

  const response = await githubFetch(
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

  // SAFETY: a 2xx from GitHub's token endpoint is its published shape, and `token` is checked for presence before use; `expires_at` is optional and parsed by `tokenReusableUntil`.
  const body = (await response.json()) as { token?: string; expires_at?: string };
  if (!body.token) throw new Error('GitHub returned an installation token response with no token.');

  const now = Date.now();
  const reusableUntil = tokenReusableUntil(body.expires_at, now);
  if (reusableUntil > now) tokenCache.set(key, { token: body.token, reusableUntil });
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
  // `timingSafeEqual` throws on a length mismatch, so that is checked first -
  // length is not secret, the contents are.
  return expected.length === received.length && timingSafeEqual(expected, received);
}

/** Never let a tokenized remote URL reach a log line or an error message. */
export { githubFetch };

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
  for (const key of ['GITHUB_APP_ID', 'GITHUB_APP_INSTALLATION_ID']) {
    if (!process.env[key]?.trim()) missing.push(key);
  }

  // Either source satisfies the key. Naming only one would send an operator on
  // a managed platform looking for a filesystem to put it on.
  if (
    !process.env.GITHUB_APP_PRIVATE_KEY?.trim() &&
    !process.env.GITHUB_APP_PRIVATE_KEY_PATH?.trim()
  ) {
    missing.push('GITHUB_APP_PRIVATE_KEY or GITHUB_APP_PRIVATE_KEY_PATH');
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
