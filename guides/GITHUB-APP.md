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
| **GitHub App name** | `docxy` | **Globally unique across GitHub.** If taken, use `docxy-bot` or `docxy-arindam`. Whatever you pick becomes the slug, and your bot login becomes `<slug>[bot]`. This name appears on every PR — choose it deliberately. |
| **Homepage URL** | `https://github.com/Arindam200/docxy` | Any valid URL. Not used functionally. |
| **Webhook → Active** | ☑ checked | Uncheck only if you want the bot identity but not the automatic trigger. |
| **Webhook URL** | your Smee URL (Part 2) | Get this first, then come back. |
| **Webhook secret** | a long random string | **Set this.** Without it anyone who finds your URL can forge events. Generate: `openssl rand -hex 32` |
| **Where can this be installed?** | Only on this account | Unless you want others installing it. |

### Repository permissions

Set exactly these four. Leave everything else as **No access**.

| Permission | Level | Why |
|---|---|---|
| **Metadata** | Read-only | Mandatory. GitHub sets it automatically. |
| **Contents** | Read and write | Clone the repo; push the proposal branch. |
| **Pull requests** | Read and write | Open the PR. |
| **Checks** | Read and write | Only if you use the pre-PR approval gate. Skip if `DOCXY_APPROVAL_MODE=auto`. |

> Ask for nothing more. Every extra permission is a line a stranger reads on the
> install screen, and `Contents: write` is already the one that makes people pause.

### Subscribe to events

- ☑ **Push**
- ☑ **Installation** (keeps your records straight when someone adds/removes repos)
- ☑ **Installation repositories**
- ☑ **Check run** — only if using the approval gate

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

> This key is equivalent to your App's password. Never commit it. `.docxy/` at
> the repo root is already gitignored, but keeping it in `~/.docxy` outside the
> repo is safer.

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

## 7a. New file: `src/github/app.ts`

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

## 7b. Rewrite the publish path in `src/github/pr.ts`

Three changes:

**1. Delete the `gh` CLI branch.** `hasGhCli()` and the `gh pr create` call go
away entirely. That is what attributes the PR to you.

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

Keep a fallback: if `readAppCredentials()` returns `null`, use the current
`gh`/`GITHUB_TOKEN` path, so local development without the App still works.

## 7c. The webhook receiver

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

`runPipelineForPush` clones the repo with an installation token, sets
`DOCXY_PROJECT_KEY` to `owner/repo`, and calls the existing `runPipeline`.

> **Dedupe on `x-github-delivery`.** GitHub retries deliveries. Without a dedupe
> key a retry opens a second pull request for the same commit.

> **`DOCXY_PROJECT_KEY` is not optional here.** It defaults to the checkout path,
> and a webhook-driven run clones to a fresh temp directory every time. Leave it
> unset and every push starts from cold sessions and an empty symbol map — with
> no error at all. The pipeline appears to work and remembers nothing.

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

Work down this list; each step isolates one failure.

**1. Credentials load**

```bash
node -e 'const {readAppCredentials}=require("./dist/github/app.js");
const c=readAppCredentials();
console.log(c ? `ok: app ${c.appId}, install ${c.installationId}, bot ${c.slug}[bot]` : "MISSING");'
```

**2. The JWT is accepted** (proves App ID and private key match)

```bash
node -e '...' # or simply:
gh api /repos/Arindam200/docxy-demo/installation --jq .id
```

**3. A token mints**

```bash
node --input-type=module -e '
import { readAppCredentials, installationToken } from "./dist/github/app.js";
const c = readAppCredentials();
const t = await installationToken(c, ["docxy-demo"]);
console.log("token ok, length", t.length);
'
```

**4. The token can see the repo**

```bash
curl -s -H "authorization: Bearer $TOKEN" \
  https://api.github.com/repos/Arindam200/docxy-demo | jq .full_name
```

**5. The PR is authored by the bot** — after a run:

```bash
gh pr view <n> --repo Arindam200/docxy-demo --json author -q .author.login
# expect: docxy[bot]     (not Arindam200)
```

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
| Runs work but never remember anything | `DOCXY_PROJECT_KEY` unset. See Part 7c. |

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
