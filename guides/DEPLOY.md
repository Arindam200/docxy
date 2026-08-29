# Deploying docxy

docxy is two processes: **docxy itself**, and the **TrueForge harness** it drives.
The harness is a dependency, like a database — docxy talks to it over HTTP, and
nothing else ever needs to.

That single fact decides the whole deployment: the harness is not a public API,
so it does not get a public URL, and it needs no authentication of its own.

---

## Local (what you have now)

```bash
npx @truefoundry/trueforge@latest      # harness on :8790
npx tsx src/cli.ts setup               # register Nebius with it, once
npx tsx src/cli.ts run HEAD            # run the pipeline
npx tsx src/cli.ts serve               # timeline UI on :4317
```

Nothing to configure. `TRUEFORGE_BASE_URL` defaults to `http://localhost:8790`,
which is where `npx` puts the harness.

TrueForge calls this **local mode**: one process, SQLite, no login. Their docs are
explicit that it is for your own machine and should stay on localhost. That is
fine — and correct — for development and for recording a demo.

---

## Deployed: Railway

Five steps. The first three stand up the harness; the last two are docxy
itself and the dashboard that reads it.

### 1. Add the harness as a service

New service → **Deploy from Docker image**:

```
tfy.jfrog.io/tfy-images/trueforge:0.1.4-fba492f
```

The image is anonymously pullable, so there is no registry credential to set up.
Verified by pulling it: no login, no token.

**Stay on this tag.** `0.1.4` is npm's `latest`, and therefore what
`npx @truefoundry/trueforge@latest` runs on a laptop — so the deployed harness
behaves like the one you developed against.
[charts/trueforge/values.yaml](https://github.com/truefoundry/trueforge/blob/main/charts/trueforge/values.yaml)
has moved ahead to `0.2.0-rc.0-…`, which is a release candidate; following it
gets you a prerelease *and* a version skew with local.

### 2. Set three variables on it

```bash
PORT=8790
HOST=::
STANDALONE=true
```

**`STANDALONE=true` is not optional.** The container image defaults to
`mode: distributed` and expects Postgres — without this it exits immediately
with `Failed to start server: connect ECONNREFUSED 127.0.0.1:5432` and Railway
shows a crash loop with no obvious cause. (The `npx` harness defaults the other
way, which is why this never comes up locally.) With it set, the harness comes
up on SQLite and logs `Standalone mode: sqlite at
/root/.local/share/trueforge/db/db.sqlite`.

`HOST=::` is the one that is easy to miss and hard to debug. Railway's private
network is **IPv6-only**, and TrueForge's container image defaults to
`HOST=0.0.0.0`, which does not accept IPv6. Without this, `harness.railway.internal`
refuses the connection and docxy reports the harness as unreachable — exactly the
same symptom as not setting the URL at all. Set correctly, the harness logs
`Agent server listening on http://:::8790`.

Health check path: `/healthz`, which answers `OK!`.

**Attach a volume at `/root/.local/share/trueforge`.** That SQLite file is where
the role sessions live. Without it, a redeploy discards every session and the
next commit starts cold — the same loss the docxy service's own volume prevents,
one layer down.

### 3. Do **not** give it a public domain

Leave the harness with no domain. It is reachable only from your other Railway
services, which is the entire security model:

TrueForge ships **no machine authentication** — no API key, no bearer token, no
service account. Its only login is OIDC, a browser sign-in flow that a server
process cannot complete. So a harness on a public URL is unauthenticated admin
access to your Nebius key, every session, and the ability to run arbitrary agents.
There is no key you can add to fix that.

Keeping it private is not extra hardening. It is the access control.

### 4. Deploy docxy itself

A second service, from this repository. [`Dockerfile`](../Dockerfile) at the
root builds it and [`railway.json`](../railway.json) points the platform's
health check at `/health`, so nothing else needs configuring for the build.

Two things about that image are load-bearing:

- **It installs `git`.** The pipeline shells out to it for every diff, every
  throwaway worktree, and every managed checkout. A slimmer base without it
  builds fine and fails on the first run.
- **It sets `HOME=/data`.** `checkoutPathFor()` puts managed clones under
  `$HOME/.docxy/checkouts`, and role sessions and the symbol map both key on
  that path. **Attach a Railway volume mounted at `/data`.** Without one, every
  redeploy hands the next commit cold sessions and an empty symbol map — losing
  precisely the accumulation this design exists to produce.

  Two things about that volume:

  - The image carries **no `VOLUME` instruction**, on purpose. Railway refuses
    to build an image that has one (*"docker VOLUME at Line 47 is not supported,
    use Railway Volumes"*), and an anonymous volume would shadow the mount
    anyway. The mount is something you attach to the service, not something the
    image declares.
  - **Set `RAILWAY_RUN_UID=0`.** The image runs as a non-root user, which is
    correct anywhere the volume's ownership can be set, but Railway mounts
    volumes root-owned and documents the result: images running as a non-root
    uid *"will have permissions issues when performing operations within an
    attached volume."* Without this the container boots and then fails on the
    first `git clone` into `/data`, which is a long way from the cause.

Then point it at the harness:

```bash
TRUEFORGE_BASE_URL=http://harness.railway.internal:8790
```

`harness.railway.internal` is just what the other service is called on Railway's
network — the same role `localhost` played on your laptop. Substitute your
service's actual name if you called it something else.

Give **this** service a public domain. Unlike the harness it is authenticated
(`DOCXY_API_TOKEN`), and both the dashboard and GitHub's webhook have to reach
it from outside the private network.

### Register Nebius once

The provider lives in the harness's own database, so a fresh harness has never
heard of it. This has to run **inside** the docxy container, and the command is
not the obvious one:

```bash
railway ssh                       # into the docxy service
node dist/cli.js setup
```

Both halves matter, and both have an obvious-looking wrong version:

- **`railway ssh`, not `railway run`.** `railway run` executes on *your laptop*
  with Railway's environment variables injected — and `harness.railway.internal`
  resolves only inside Railway's network, so it fails with the harness
  unreachable while every variable looks correct.
- **`node dist/cli.js setup`, not `npm run setup`.** The `setup` script is
  `tsx src/cli.ts setup`, and the runtime image has neither `tsx` (a
  devDependency, dropped by `npm ci --omit=dev`) nor `src/`. It fails with
  `sh: 1: tsx: not found`. The compiled CLI is the same program.

Expect `✓ Nebius provider created` followed by `✓ All registered models
resolve.` A warning about no sandbox provider is separate and expected — see
below.

Needs the Railway CLI: `npm i -g @railway/cli`, then `railway login` and
`railway link` to the project.

### 5. Point the dashboard at it

**This is the step that makes the deployed dashboard show anything.**

Every page under `/dashboard` reads through `web/src/lib/docxy.ts`, which
fetches `DOCXY_API_URL` over HTTP and *fails soft* — a request that times out
renders an empty "offline" state rather than an error. The default is
`http://localhost:4317`, and on Vercel `localhost` is the serverless function's
own container, where nothing is listening. So a dashboard deployed without this
variable set does not look broken. It looks like a pipeline that has never run.

On **Vercel**, set all three:

```bash
DOCXY_API_URL=https://<your-docxy-service>.up.railway.app
DOCXY_API_TOKEN=<the same value as on the docxy service>
DOCXY_ALLOWED_EMAILS=you@example.com
```

The token has to match on both sides exactly. Both callers trim it before
sending, so trailing whitespace pasted into either dashboard is survivable, but
a mismatched value is a 401 on every read with nothing on the page to say so.

---

### 6. Wire the GitHub App, so a push is all it takes

Without this the deployment can be looked at but not exercised: nothing triggers
a run except an API call. With it, anyone who can push to an installed
repository can set the whole pipeline going and watch it on the dashboard.

On the **docxy** service:

```bash
GITHUB_APP_ID=
GITHUB_APP_PRIVATE_KEY=          # the PEM itself; no file to place first
GITHUB_APP_INSTALLATION_ID=
GITHUB_WEBHOOK_SECRET=           # openssl rand -hex 32
```

Then set the App's **webhook URL** to `https://<your-docxy-domain>/webhook` and
its secret to the same value. [guides/GITHUB-APP.md](GITHUB-APP.md) finds the
three ids.

Until `GITHUB_WEBHOOK_SECRET` is set, `POST /webhook` answers `503` to
everything rather than accepting unverified deliveries, so a webhook that
appears to do nothing is usually this.

A push to an installed repository should now produce a run in the dashboard with
nobody at a terminal. That is the whole difference between a hosted deployment
and a CLI: the CLI documents the repository you are standing in; the deployment
documents every repository the App is installed on.

---

## The sandbox does not survive containerization

Measured, not guessed. The same `/api/v1/capabilities` call against both:

| harness | `sandbox.enabled` |
|---|---|
| `npx @truefoundry/trueforge@latest` on a laptop | `true` |
| `tfy-images/trueforge:0.1.4-fba492f` in a container | **`false`** |

The cause is not the kernel and not the platform. `bwrap` is simply **not
installed in the image**, while the container's kernel offers user namespaces
perfectly happily (`/proc/sys/user/max_user_namespaces` reads five figures). The
harness says as much itself: *"Skills run in a sandbox, which is not
configured."*

So a deployed harness has no local sandbox, and there is no environment variable
that conjures one. What follows from that, by design rather than by accident:
`DOCXY_SANDBOX_FALLBACK` defaults to `skip`, so the docs build is **reported
unvalidated** rather than quietly executed on the host, and every proposal opens
as a draft carrying that reason. The isolation boundary holds. The `[sandbox]`
badge does not appear.

### Getting it back

**Register a Daytona provider.** It is a hosted sandbox, so it does not care
what the harness container can or cannot do, and it is the only option that
keeps the deployment fully hosted.

The key needs write access. Setting `DAYTONA_API_KEY` alone changes nothing —
the provider has to be registered in the harness, which `docxy setup` does, and
that step **builds a snapshot on Daytona**. A read-scoped key authenticates
against the API and is still refused here:

```
! No remote sandbox provider: the harness refused the Daytona provider
  (HTTP 422): {"error":{"message":"Daytona rejected the API key — check the credentials"}}
```

A key that returns `200` from `GET https://app.daytona.io/api/sandbox` can still
produce exactly that. Listing is not creating. Issue a key with snapshot-create
permission at [app.daytona.io](https://app.daytona.io), set it on **both** the
harness service and the docxy service, then re-run `docxy setup` against the
deployed harness. The validation report then reads `[daytona]` where it used to
read `[sandbox]`.

Confirm before relying on it, rather than at demo time:

```bash
curl -s https://<harness-or-docxy-domain>/api/v1/capabilities   # sandbox.enabled
docxy doctor                                                    # names the backend
```

---

## Optional: durable sessions

The steps above run the harness in standalone mode, which stores sessions in
SQLite inside the container — they are lost on redeploy. Attach a Railway volume
to keep them, or move to Postgres:

Add Railway's **Postgres** and **Redis** plugins, then on the harness:

```bash
STANDALONE=false
POSTGRES_HOST=${{Postgres.PGHOST}}
POSTGRES_PORT=${{Postgres.PGPORT}}
POSTGRES_USER=${{Postgres.PGUSER}}
POSTGRES_PASSWORD=${{Postgres.PGPASSWORD}}
POSTGRES_DB=${{Postgres.PGDATABASE}}
REDIS_URL=${{Redis.REDIS_URL}}
```

This matters more than it looks. One role holds one long-lived session per
repository, and what it learns on one commit is meant to still be there for the
next. In SQLite-in-a-container that memory dies on every redeploy; in Postgres it
survives.

---

## Environment variables

Everything docxy reads is documented in [`.env.example`](../.env.example). The ones
that matter for a deployment:

| Variable | Type | Default | Description |
|---|---|---|---|
| `TRUEFORGE_BASE_URL` | URL | `http://localhost:8790` | The harness. The default is wrong once deployed. |
| `NEBIUS_API_KEY` | string | *required* | Model access. |
| `DOCXY_REPO_PATH` | path | the working directory | **Give each repository a stable checkout directory.** Sessions and the symbol map key on this path. Clone to a fresh temp directory every run and each commit silently starts from cold sessions and an empty map. |
| `DOCXY_PORT` | integer | `4317` | The port `docxy serve` listens on. |
| `GITHUB_APP_ID` | string | *required* | The App's numeric id. `openPullRequest()` refuses to run without all three — there is no personal-token fallback. |
| `GITHUB_APP_PRIVATE_KEY` | string | *one of these two* | The PEM itself. **Prefer this when deployed** — a managed platform gives you environment variables, not a filesystem to place a secret on first. Accepts the PEM verbatim, base64 of it, or one whose newlines arrived as literal `\n`. |
| `GITHUB_APP_PRIVATE_KEY_PATH` | path | *one of these two* | The PEM as a file. The right shape on a laptop, where the key is a download that never has to move. |
| `GITHUB_APP_INSTALLATION_ID` | string | *required* | The installation on the account being documented. |
| `GITHUB_WEBHOOK_SECRET` | string | *required* | Shared with the App's webhook. Unset, `POST /webhook` answers 503 to everything. |
| `DOCXY_API_TOKEN` | string | *required* | Shared secret between the dashboard and this API. `npm start` refuses to boot without it. Set the identical value on Vercel. |
| `DOCXY_ALLOWED_EMAILS` | list | *required* | Who may sign in to the dashboard. Empty means nobody, and the dashboard says "No operators are configured". |
| `DATABASE_URL` | URL | none | Neon connection string. **Set it when deployed.** Unset, runs are JSON files under the state directory, which a container loses on every redeploy unless the volume covers them. |
| `DAYTONA_API_KEY` | string | none | Remote sandbox. See the sandbox note above — a container's own sandbox may not be available. |
| `DOCXY_DOCS_BRANCH` | string | none | Only if docs live on their own branch. |
| `DOCXY_REQUIRE_APPROVAL` | boolean | `false` | Hold every proposal behind a human sign-off before anything is published. |
| `DOCXY_APPROVAL_STALE_MINUTES` | integer | `60` | Minutes before a pending request is *reported* stale. It is never auto-resolved. |

> **The approval gate is off by default.** A run publishes on its own, and the
> pull request is the review surface. Set `DOCXY_REQUIRE_APPROVAL=true` to hold
> proposals back instead; `decideScope()` in `src/approval/gate.ts` then decides
> whether releasing one takes one reviewer or two. What the default protects is
> not review but *quality*: a proposal the Coordinator rejected or validation
> failed still opens, as a draft with the reasons at the top of its body.
>
> `DOCXY_APPROVAL_MODE` is retired. A deployment that still sets it to
> `elevated` or `always` is read as `DOCXY_REQUIRE_APPROVAL=true` and warned
> about at startup, so a gate someone asked for is never quietly dropped — but
> it will stop being read, so move across.
>
> There is no `DOCXY_PROJECT_KEY`. `grep -rhno 'DOCXY_[A-Z_]*'
> --include='*.ts' src/ | sed 's/.*://' | sort -u` prints the real list.

---

## The alternative: one VM

If you would rather not split this across managed services, the whole topology
runs on a single small VM with Docker Compose — docxy, harness, Postgres, Redis
on one box, roughly $5–15/month. TrueForge ships a
[docker-compose.yml](https://github.com/truefoundry/trueforge/blob/main/docker-compose.yml)
for its half.

The tradeoff is ownership: you handle TLS, restarts, and backups yourself. On
Railway those are the platform's problem. The service definitions are the same
either way, so this is not a decision you are locked into.

---

## What a deployed docxy can do that a local one cannot

The GitHub App is built, and it is what makes the deployment worth having. With
`GITHUB_APP_ID`, a private key, `GITHUB_APP_INSTALLATION_ID` and
`GITHUB_WEBHOOK_SECRET` set:

- `POST /webhook` accepts push deliveries, verifies the signature, and enqueues
  a run. Point the App's webhook URL at your public docxy domain.
- `ensureCheckout()` clones and fetches each installed repository itself, using
  a short-lived installation token that is never written to disk. A commit
  authored anywhere — the web editor, a colleague's machine — resolves, which is
  not true of the CLI reading whatever your local checkout happens to have.
- Runs across every installed repository show up in one dashboard, because
  `syncedRepoPaths()` reports the managed checkouts alongside the local one.

That is the whole point of hosting it: the CLI documents the repository you are
standing in, and the deployment documents every repository the App is installed
on, without anyone being at a terminal.
