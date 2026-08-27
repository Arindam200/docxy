# Setting up the docxy GitHub bot

Right now the demo has two things wrong with it, and they are separate problems:

| | Now | After |
|---|---|---|
| Who opens the PR | `Arindam200` (your `gh` CLI login) | `docxy[bot]` |
| What triggers a run | you typing `docxy run` | a push to the repo |

This guide fixes both.

---

## Do I need to deploy for this?

**No — not for either of them.** This is the important part.

| Goal | Deployment needed? | Why |
|---|---|---|
| PR authored by `docxy[bot]` | **No** | Just credentials + a code change. Runs from your laptop. |
| Push automatically triggers a run | **No, for a demo** | A webhook proxy (Smee) forwards GitHub's webhooks to `localhost`. GitHub's own recommended way to develop Apps. |
| Runs when your laptop is closed | **Yes** | Only then. See [DEPLOY.md](DEPLOY.md). |

So you can record the entire flow — push code, bot opens PR — with nothing
deployed. Smee is a relay, not a host: GitHub posts to a Smee URL, and a small
local process forwards it to your machine.

---

# Part 1 — Register the App

Go to **https://github.com/settings/apps/new**

### Fields

| Field | Value | Notes |
|---|---|---|
| **GitHub App name** | `docxy` | **Globally unique across GitHub**, and it decides your bot's login. See the warning below — do not type `docxy[bot]`. |
| **Homepage URL** | `https://github.com/Arindam200/docxy` | Any valid URL. Not used functionally. |
| **Webhook → Active** | ☑ checked | Uncheck only if you want the bot identity but not the automatic trigger. |
| **Webhook URL** | your Smee URL (Part 2) | Get this first, then come back. |
| **Webhook secret** | a long random string | **Set this.** The server returns 503 to every delivery while `GITHUB_WEBHOOK_SECRET` is unset, and without it anyone who finds your URL can forge events. Generate: `openssl rand -hex 32` |
| **SSL verification** | Enabled | Smee serves valid TLS. Never disable it. |
| **Redirect URI**, **Setup URL** | leave blank | This App is a bot identity, not a login provider. Nothing in `src/` implements an OAuth flow. |
| **Request user authorization (OAuth)** | ☐ unchecked | Same reason. |
| **Enable Device Flow** | ☐ unchecked | Same reason. |
| **Where can this be installed?** | Only on this account | Unless you want others installing it. |

> **The name is not the bot login — GitHub appends `[bot]` for you.**
>
> | You type | Slug | Your bot becomes |
> |---|---|---|
> | `docxy` | `docxy` | `docxy[bot]` |
> | `docxy[bot]` | `docxy-bot` | `docxy-bot[bot]` ← almost certainly not what you wanted |
>
> Typing the `[bot]` suffix yourself gets it slugified into the name and then
> suffixed again. If `docxy` is taken, prefer `docxy-app` or `docxy-arindam`
> over anything containing `[bot]`.
>
> The slug is also what the downloaded private key is named after, so
> `docxy-bot.2026-08-25.private-key.pem` in your Downloads folder is telling you
> the slug is `docxy-bot`. Renaming later is possible — the App ID and private
> key survive it — but the login on every PR you have already opened does not
> change retroactively. Get it right before the first run.

### What about the Client ID and client secret?

Your App's settings page shows a **Client ID** and offers to generate a **client
secret**. Docxy uses neither. They exist for Apps that sign users in, and every
App gets them whether or not it wants them. Docxy authenticates as an
*installation* — a JWT signed with the private key, exchanged for a short-lived
installation token — which is a different mechanism entirely.

Leave the client secret ungenerated. If you generated one and it leaked, rotate
it and move on; nothing in this repo reads it.

### Repository permissions

Set exactly these two. Leave everything else as **No access**.

| Permission | Level | Why |
|---|---|---|
| **Metadata** | Read-only | Mandatory. GitHub sets it automatically. |
| **Contents** | Read and write | Clone the repo; push the proposal branch. |
| **Pull requests** | Read and write | Open the PR. |

These are exactly the two `installationToken()` asks for in `src/github/app.ts`.
A token cannot exceed the installation's grant, so anything extra you tick here
is scope on the install screen that no code path can use.

> **Not Checks.** Earlier drafts of this guide asked for `Checks: read/write`
> for the approval gate. Nothing in `src/` calls the Checks API — the gate lives
> in docxy's own store and dashboard, never on the commit. Do not grant it.

Organization, Account, and Enterprise permissions: **none**.

> Ask for nothing more. Every extra permission is a line a stranger reads on the
> install screen, and `Contents: write` is already the one that makes people pause.

### Subscribe to events

- ☑ **Push** — the only event the server acts on; `src/server/index.ts` ignores
  every other `x-github-event` with a 200 so GitHub does not retry it
- ☑ **Installation** and ☑ **Installation repositories** — not handled yet, but
  subscribing now costs nothing and saves a round trip later

Adding events later needs no re-approval from installers, as long as the
permissions behind them do not change. **Changing permissions does.**

Click **Create GitHub App**.

---

# Part 2 — Get your credentials

After creation you land on the App's settings page.

### 2a. App ID

At the top: **App ID: 123456**. Copy it.

### 2b. Private key

Scroll to **Private keys** → **Generate a private key**. A `.pem` file downloads.

```bash
mkdir -p ~/.docxy
mv ~/Downloads/docxy.*.private-key.pem ~/.docxy/app.pem
chmod 600 ~/.docxy/app.pem
```

> This key is equivalent to your App's password, and it is the one file in this
> setup that cannot be rotated quietly — leaking it means revoking the key and
> re-keying every deployment.
>
> **Move it out of the repository, do not just gitignore it.** `.gitignore`
> covers `.docxy/`, but a `.pem` that lands at the repo root — which is where
> browsers and `mv` put it if you are not careful — matches no rule and shows up
> as an untracked file that `git add -A` will happily commit. `*.pem` is now in
> `.gitignore` as a backstop, but the real fix is keeping the key in `~/.docxy`,
> outside the working tree entirely.
>
> Confirm the key you saved is the one GitHub has — this prints the fingerprint
> shown on the App's settings page:
>
> ```bash
> openssl rsa -in ~/.docxy/app.pem -pubout -outform DER 2>/dev/null \
>   | openssl dgst -sha256 -binary | openssl base64
> ```

### 2c. Webhook secret

The one you generated. If you skipped it, set it now under **Webhook → Secret**.

### 2d. Smee URL (only for the automatic trigger)

1. Open **https://smee.io/** → **Start a new channel**
2. Copy the URL, e.g. `https://smee.io/AbC123xyz`
3. Paste it into your App's **Webhook URL** field → **Save changes**

---

# Part 3 — Install the App

App settings → **Install App** (left sidebar) → **Install** next to your account.

Choose **Only select repositories** → pick `docxy-demo` → **Install**.

You are redirected to a URL ending in `/installations/12345678`. **That number is
your installation ID.** If you missed it, see Part 4.

---

# Part 4 — Find your installation ID

```bash
# Easiest: ask which installation covers a specific repo
gh api /repos/Arindam200/docxy-demo/installation --jq .id
```

Other endpoints that work:

```
GET /app/installations                  # all installations (needs App JWT)
GET /users/{username}/installation
GET /orgs/{org}/installation
```

The webhook payload also carries it at `payload.installation.id` — which is what
the worker uses in production, since it varies per customer.

---

# Part 5 — Find your bot's identity

For commits to show as the bot rather than a generic name, you need the bot's
numeric user id. Replace `docxy` with your actual slug:

```bash
gh api 'users/docxy[bot]' --jq '"\(.id)+\(.login)@users.noreply.github.com"'
```

This prints the exact commit email to use, e.g.:

```
198765432+docxy[bot]@users.noreply.github.com
```

The format is `<user-id>+<slug>[bot]@users.noreply.github.com`. Verified against
a real bot: `dependabot[bot]` commits as
`49699333+dependabot[bot]@users.noreply.github.com`.

---

# Part 6 — Environment variables

Add to `.env`:

```bash
# ---- GitHub App -------------------------------------------------------------
GITHUB_APP_ID=123456
GITHUB_APP_PRIVATE_KEY_PATH=/Users/arindammajumder/.docxy/app.pem
GITHUB_APP_INSTALLATION_ID=12345678
GITHUB_APP_SLUG=docxy
GITHUB_APP_BOT_EMAIL=198765432+docxy[bot]@users.noreply.github.com
GITHUB_WEBHOOK_SECRET=<the openssl rand -hex 32 value>
```

`.env` is gitignored. Add the same keys, blank, to `.env.example`.

---

# Part 7 — The code

> **This is already implemented.** Part 7 documents how the pieces fit together;
> it is not a checklist of files to create. `src/github/app.ts`,
> `src/github/pr.ts`, and the `/webhook` route in `src/server/index.ts` all exist
> on disk and have moved ahead of the listings below — `app.ts` also exports
> `scrubToken()` and `appStatus()`, and reports a readable error when the private
> key path is wrong. **Read the files, not these excerpts**, and never paste a
> listing from here over the real one.
>
> **One exception: 7c is not fully built.** The `/webhook` route exists and
> verifies signatures, but `runPipelineForPush` does not — see the note in 7c.
>
> Skip to [Part 8](#part-8--run-it-locally) unless you want the rationale.

## 7a. `src/github/app.ts` — the identity

```ts
import { createSign, createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';

/** App JWT: RS256, ten minutes max, issued by the App id. */
function appJwt(appId: string, pem: string): string {
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const body =
    `${b64({ alg: 'RS256', typ: 'JWT' })}.` +
    `${b64({ iat: now - 60, exp: now + 540, iss: appId })}`;
  return `${body}.${createSign('RSA-SHA256').update(body).sign(pem, 'base64url')}`;
}

export interface AppCredentials {
  appId: string;
  privateKey: string;
  installationId: string;
  slug: string;
  botEmail: string;
}

export function readAppCredentials(): AppCredentials | null {
  const appId = process.env.GITHUB_APP_ID;
  const keyPath = process.env.GITHUB_APP_PRIVATE_KEY_PATH;
  const installationId = process.env.GITHUB_APP_INSTALLATION_ID;
  if (!appId || !keyPath || !installationId) return null;
  const slug = process.env.GITHUB_APP_SLUG ?? 'docxy';
  return {
    appId,
    privateKey: readFileSync(keyPath, 'utf8'),
    installationId,
    slug,
    botEmail: process.env.GITHUB_APP_BOT_EMAIL ?? `${slug}[bot]@users.noreply.github.com`,
  };
}

/**
 * Installation token: one hour, attenuated to the repos this run touches.
 *
 * Mint it at the moment you need it. Never store one on a run record and reuse
 * it later — the approval gate can wait days and the token will be long dead.
 */
export async function installationToken(
  creds: AppCredentials,
  repos: string[],
): Promise<string> {
  const res = await fetch(
    `https://api.github.com/app/installations/${creds.installationId}/access_tokens`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${appJwt(creds.appId, creds.privateKey)}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'docxy',
      },
      body: JSON.stringify({
        repositories: repos,
        permissions: { contents: 'write', pull_requests: 'write' },
      }),
    },
  );
  if (!res.ok) {
    throw new Error(`Could not mint an installation token (HTTP ${res.status}): ${await res.text()}`);
  }
  return ((await res.json()) as { token: string }).token;
}

/** Timing-safe webhook signature check. Never use a plain === compare. */
export function verifyWebhook(body: Buffer, header: string | undefined, secret: string): boolean {
  const mine = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
  const a = Buffer.from(mine);
  const b = Buffer.from(header ?? '');
  return a.length === b.length && timingSafeEqual(a, b);
}
```

## 7b. `src/github/pr.ts` — the publish path

Four things make the PR the App's rather than yours:

**1. No `gh` CLI branch.** `hasGhCli()` and `gh pr create` are gone — that call
is what attributed the PR to whoever ran it.

**2. Push to a tokenized URL, not `origin`.** `git push origin` uses your
credential helper — your account. Instead:

```ts
const creds = readAppCredentials();
const repo = config.github.repo ?? (await inferRepo(config.repoPath));  // "owner/name"
const token = await installationToken(creds, [repo.split('/')[1]!]);

await git(worktree, [
  'push',
  `https://x-access-token:${token}@github.com/${repo}.git`,
  `HEAD:refs/heads/${branch}`,
]);
```

> The token appears in the command arguments. It is short-lived, but do not log
> the command — scrub it before printing any error.

**3. Commit as the bot.** Replace the hardcoded identity:

```ts
await git(worktree, [
  '-c', `user.name=${creds.slug}[bot]`,
  '-c', `user.email=${creds.botEmail}`,
  'commit', '-m', subject, '-m', trailer,
]);
```

**4. Open the PR with the token:**

```ts
const res = await fetch(`https://api.github.com/repos/${repo}/pulls`, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'user-agent': 'docxy',
  },
  body: JSON.stringify({ title, body, head: branch, base }),
});
```

Because the token is an installation token, GitHub attributes the PR to
`docxy[bot]`.

**There is deliberately no fallback.** An earlier draft suggested dropping back
to `gh`/`GITHUB_TOKEN` when `readAppCredentials()` returns `null`. The shipped
code does the opposite — `openPullRequest()` throws, naming the three variables
to set:

```
The docxy GitHub App is not configured, so there is no identity to open a
pull request as. Set GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY_PATH, and
GITHUB_APP_INSTALLATION_ID …
```

A fallback is the failure mode this whole guide exists to prevent: it does not
stop the run, it just quietly signs a machine's proposal with a human's name.
Failing loudly is the feature.

## 7c. `src/server/index.ts` — the webhook receiver

Add to `src/server/index.ts` (or a new route file):

```ts
app.post('/webhook', async (c) => {
  const raw = Buffer.from(await c.req.arrayBuffer());
  const secret = process.env.GITHUB_WEBHOOK_SECRET ?? '';
  if (!verifyWebhook(raw, c.req.header('x-hub-signature-256'), secret)) {
    return c.json({ error: 'bad signature' }, 401);
  }

  const event = c.req.header('x-github-event');
  const delivery = c.req.header('x-github-delivery');
  if (event !== 'push') return c.json({ ok: true, ignored: event });

  const payload = JSON.parse(raw.toString());
  if (payload.ref !== `refs/heads/${payload.repository.default_branch}`) {
    return c.json({ ok: true, ignored: 'not the default branch' });
  }

  // Answer GitHub immediately — it times out around ten seconds and a five-role
  // run takes minutes. Do the work after responding.
  queueMicrotask(() => {
    void runPipelineForPush(payload, delivery).catch((cause) =>
      console.error('pipeline failed', cause),
    );
  });
  return c.json({ ok: true, queued: delivery });
});
```

> **`runPipelineForPush` does not exist yet — this part is aspirational.**
>
> What the shipped route actually does is call `startRun(payload.after)`
> (`src/server/index.ts`), which passes the **server's own `config`** to
> `runPipeline` and takes only the commit SHA from the payload. Nothing is
> cloned. The run therefore executes against whatever `DOCXY_REPO_PATH` pointed
> at when the server booted — and if that checkout is a different repository
> from the one that was pushed, the SHA does not resolve and the run fails.
>
> Two consequences:
>
> - **One server serves one repository.** Start it with `DOCXY_REPO_PATH` set to
>   the checkout you want documented, and only wire that repository's pushes to
>   it. A single instance cannot fan out across an installation's repos.
> - **The checkout must be able to see the pushed commit.** The webhook arrives
>   the instant GitHub accepts the push; a local checkout that has not fetched
>   yet does not have that SHA.
>
> Closing this gap is what turns the demo into a product: clone (or fetch) the
> payload's repository with an installation token into a stable per-repository
> directory, build a `Config` for it, and pass *that* to `runPipeline` instead of
> the server's own.

> **Dedupe on `x-github-delivery`.** GitHub retries deliveries. Without a dedupe
> key a retry opens a second pull request for the same commit.

> **Session reuse keys on the repository path.** `DOCXY_REPO_PATH` defaults to
> the current working directory (`src/config.ts`), and a webhook-driven run
> clones to a fresh temp directory every time — so each push starts from cold
> sessions and an empty symbol map, with no error at all. Give hosted runs a
> stable checkout directory per repository rather than a new `mkdtemp` each time.
>
> Earlier drafts of this guide told you to set `DOCXY_PROJECT_KEY` here. **That
> variable does not exist.** Nothing in `src/` reads it. To see the real list:
>
> ```bash
> grep -rhno 'DOCXY_[A-Z_]*' --include='*.ts' src/ | sed 's/.*://' | sort -u
> ```

---

# Part 8 — Run it locally

Four terminals:

```bash
# 1. the harness
npx @truefoundry/trueforge@latest

# 2. docxy's server (which now has /webhook)
npx tsx src/cli.ts serve

# 3. forward GitHub's webhooks to it
npx smee -u https://smee.io/AbC123xyz -t http://localhost:4317/webhook

# 4. make a change and push
cd .demo-repo
echo "\n## Notes\n\nSomething new.\n" >> docs/guide.md
git commit -am "docs: add a notes section"
git push
```

Terminal 3 shows the delivery arriving. Terminal 2 shows the five roles running.
A minute or two later the PR appears — **opened by `docxy[bot]`**.

That is the whole flow, with nothing deployed.

---

# Part 9 — Verify each piece

One script checks the whole credential chain. Save it as `verify-app.mts`
anywhere outside `src/` and run it from the repository root:

```ts
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { resolve } from 'node:path';

for (const line of readFileSync('.env', 'utf8').split('\n')) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
}

const { appStatus, readAppCredentials, installationToken, verifyWebhook } =
  await import(resolve('src/github/app.ts'));

const repo = process.env.DOCXY_VERIFY_REPO ?? 'Arindam200/docxy-demo';
console.log('1. appStatus() ....', JSON.stringify(appStatus()));

const creds = readAppCredentials();
if (!creds) throw new Error('credentials are null — see "missing" above');

const token = await installationToken(creds, [repo.split('/')[1]!]);
console.log('2. token mints ....', `ok, length ${token.length}`);

const res = await fetch(`https://api.github.com/repos/${repo}`, {
  headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json',
             'user-agent': 'docxy' },
});
const body = await res.json() as { full_name?: string; default_branch?: string };
console.log('3. token sees repo', `HTTP ${res.status}, ${body.full_name}, default=${body.default_branch}`);

const secret = process.env.GITHUB_WEBHOOK_SECRET ?? '';
const payload = Buffer.from('{"zen":"test"}');
const sig = 'sha256=' + createHmac('sha256', secret).update(payload).digest('hex');
console.log('4. webhook HMAC ...', verifyWebhook(payload, sig, secret) ? 'verifies' : 'FAILED');
console.log('5. bot identity ...', `${creds.slug}[bot] <${creds.botEmail}>`);
```

```bash
npx tsx verify-app.mts
```

A fully configured App prints:

```
1. appStatus() .... {"configured":true,"slug":"docxy","appId":"…","installationId":"…",…,"missing":[]}
2. token mints .... ok, length 390
3. token sees repo HTTP 200, Arindam200/docxy-demo, default=main
4. webhook HMAC ... verifies
5. bot identity ... docxy[bot] <…+docxy[bot]@users.noreply.github.com>
```

Read it top-down; each line depends on the one above. `appStatus().missing`
names the variable to fix. Line 2 failing while line 1 is clean means the App ID
and private key do not match, or the App is not installed on that account.

> **Two traps.** Run this against `src/`, not `dist/` — `npm run build` output
> goes stale the moment you edit a source file, and this repo is ESM, so the
> `require('./dist/github/app.js')` one-liners in older drafts of this guide fail
> twice over. And use a script file rather than `npx tsx -e`: the `-e` form
> compiles as CommonJS and rejects top-level `await`.

> **Line 4 does not prove GitHub agrees.** It checks your secret against your own
> HMAC — it passes even if the App's **Webhook → Secret** field is empty. Only a
> real delivery proves those match.

**6. Webhooks arrive** — push, then check the Smee channel page in your browser,
and your App's **Advanced → Recent Deliveries** tab, which shows every payload
and its response code.

---

# Part 10 — Troubleshooting

| Symptom | Cause |
|---|---|
| `401 Bad credentials` minting a token | App ID does not match the private key, or the `.pem` was truncated. Re-download it. |
| `404` on `/app/installations/{id}/access_tokens` | Wrong installation ID, or the App is not installed on that account. |
| `422 Resource not accessible by integration` | A permission is missing. Changing permissions **requires the installation to approve them again** — check the repo's install settings for a pending approval banner. |
| `403` on push | `Contents: write` not granted, or the repo is outside the installation's selected repositories. |
| PR still shows your username | The `gh` fallback is still being used. Confirm `readAppCredentials()` is not returning `null`. |
| Webhook never arrives | Smee not running, wrong URL on the App, or webhook not marked Active. Check **Advanced → Recent Deliveries**. |
| `401 bad signature` in your logs | `GITHUB_WEBHOOK_SECRET` does not match the App's. Also make sure you hash the **raw body**, not a re-serialized JSON object. |
| `503 GITHUB_WEBHOOK_SECRET is not set` | The server refuses deliveries until the variable is set. Set it in `.env` **and** in the App's Webhook → Secret field. |
| Bot is named `something-bot[bot]` | The App name contained `[bot]`. See the warning in Part 1. |
| `Cannot find module .../dist/github/app.js` | Verifying against stale build output. Point at `src/` instead. |
| Runs work but never remember anything | Each run started from a different checkout directory, so no session was reused. See Part 7c. |

---

# Part 11 — When you do need deployment

Everything above runs on your laptop. You need a deployed instance when:

- runs should happen while your machine is off
- other people install the App
- you want the Smee relay gone (point the webhook URL straight at your server)

The only changes: set the App's Webhook URL to `https://your-host/webhook`, and
put the App ID, private key, and webhook secret in the host's secret store.
Nothing in the code differs. See [DEPLOY.md](DEPLOY.md).

---

# Part 12 — Later: docs in a separate repo

`openDocsTree()` already returns `{ path, branch, disposable, dispose }`, and
every caller goes through that interface. A separate docs repo is a second
implementation: clone instead of worktree, nothing downstream changes.

The catch is the token, not the tree. **An installation token can only reach one
account.** Same owner for both repos: one installation, pass both repo names to
`repositories` when minting. Different owners: two installations, two tokens, and
your onboarding has to walk the user through a second install you cannot perform
for them.
