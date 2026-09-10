# Deploying docxy

Start with [CONNECTIONS.md](CONNECTIONS.md) for the shared service map,
configuration ownership, callbacks and retired-service context. This guide
contains the deployment procedures and exact platform IDs.

## Production targets

Production deploys automatically from **`Arindam200/docxy`, branch `main`**.
These are the established targets; use their IDs when operating a CLI.

| Component | Project | Production URL | Build root |
|---|---|---|---|
| Vercel dashboard | `docxy` (`prj_3RMsBtkY6Xhe6XnODSW1M8q1DdyJ`), team `arindam-1729` | https://docxy.app | `web/` |
| Railway backend | `tender-laughter` (`5c333e8f-d5fc-4440-82e8-427386ec0350`), service `docxy` (`af62c917-dffd-48f3-9b69-87f42b1f7a91`) | https://docxy-production.up.railway.app | Repository root, `Dockerfile` |

Railway's production environment is `07200c23-c711-4fb6-a65e-09cbd4c22ea6`.
Both platforms use the same `DATABASE_URL` and `DOCXY_API_TOKEN`. Vercel's
production `DOCXY_API_URL` points to the Railway URL above. Keep the database,
API token, GitHub App credentials, and volume on the existing backend when
changing deployment settings.

The former standalone harness at **`refreshing-tenderness/docxy`** is obsolete.
It was disconnected from GitHub on September 11, 2026 after its remaining GitHub
link deployed the new backend without backend credentials. Do not reconnect it
or copy the production secrets there. Its historical failed deployment remains
visible; future pushes deploy to `tender-laughter/docxy`.

After pushing to `main`, check the deployment entries in GitHub, then run this
read-only verification from the repository root with the Railway and Vercel
CLIs signed in:

```bash
node scripts/check-deploy-targets.mjs
```

It verifies the project links, backend URL, Composio key presence, automatic
deployment setting, successful deployments, matching Git revisions, and public
health endpoints. Run it after both builds finish; it intentionally fails while
one platform still runs an older revision. It does not print secret values.
Automatic deployment routes pushes to the right services; application changes
can still fail a build, so check locally before pushing:

```bash
npm run build
npm --prefix web run typecheck
npm --prefix web run build
node_modules/.bin/tsx --test web/test/composio.test.ts
```

Composio's server key belongs in **Vercel production** and **`web/.env.local`**
for local development. A key in the repository root `.env` is not loaded by
Next.js running in `web/`. See [Composio setup](COMPOSIO.md) for the account
authorization steps. Environment changes require a new Vercel deployment.

## Architecture

docxy is **one process**. The five agents run inside it through Mastra, so there
is no second service to stand up and nothing to point it at. What it reaches out
to is four managed things: **Nebius** for models, **Daytona** for the sandbox
that runs the docs build, **Neon** for storage, and **GitHub** for the
repositories it documents.

> **If you are following an older copy of this guide:** it described a separate
> harness service on its own Railway deployment, reached over private
> networking. That service no longer exists - the agents moved in-process with
> the Mastra migration, and `harness.Dockerfile` went with it. This file
> replaces it entirely.

---

## The shape of it

| Piece | What it is | Public URL | Required |
|---|---|---|---|
| **docxy** | This repository's `Dockerfile`. API, webhook receiver, and the five agents in one Node process. | **Yes** - GitHub's webhook and the dashboard both reach it from outside | Yes |
| **dashboard** | `web/`, a Next app. Reads the docxy API server-side and holds the token. | Yes | No - the API and CLI work without it |
| **Neon** | One Postgres database, three schemas: `public` for the pipeline, `auth` for sign-in, `billing` for shared billing records. | - | Strongly recommended |
| **Nebius** | Token Factory, as an OpenAI-compatible provider. | - | Yes - no run starts without it |
| **Daytona** | The isolated workspace the docs build runs in. | - | See [the sandbox](#the-sandbox-what-the-daytona-key-has-to-be-able-to-do) |
| **GitHub App** | The bot identity. Mints installation tokens, clones repositories, opens pull requests. | - | Yes, for anything webhook-driven |
| **Composio** | Dashboard account authorization for Slack, Notion, Linear and Jira. Provider workflows are still planned. | Hosted authorization link | Optional |
| **Resend** | Dashboard verification, welcome and invitation email. | - | Required for email registration |
| **Dodo Payments** | Optional dashboard billing integration. Credentials and explicit switches are required. | Dashboard endpoints | Optional; not configured in the production verification |

The instructions below use **Railway** for docxy and **Vercel** for the
dashboard, because that is what this project has been deployed on. Nothing in
the image is Railway-specific except two notes that are called out where they
matter; [the last section](#the-alternative-one-vm) covers a single VM instead.

---

## Before you start

Have these five things in hand. Each one has a step below that uses it.

- [ ] A **Nebius Token Factory** API key.
- [ ] A **Neon** project, and its **pooled** connection string - the one
      containing `-pooler`.
- [ ] A **Daytona** API key that can **create** sandboxes, not merely list them.
      This distinction has cost real time; see [the sandbox](#the-sandbox-what-the-daytona-key-has-to-be-able-to-do).
- [ ] A registered **GitHub App** with its App id, installation id, webhook
      secret, and private key PEM. [GITHUB-APP.md](GITHUB-APP.md) registers one
      and finds all four.
- [ ] A shared secret for the API: `openssl rand -hex 32`.

---

## Test the build before you ship it

Two suites, and they answer different questions. Run the first every time; run
the second when the deployment's dependencies are what you are unsure about.

```bash
npm test          # 308 checks - no network, no model, no cost
npm run typecheck
npm run lint
```

That is the whole of the pure logic: parsing, edit application, the approval
gate, the API's auth and repository allowlists, validation that never reads as
validated when it was not, GitHub App credential handling, the secret guardrail,
and code mode. It touches nothing outside the process, so a green run says the
code is sound and says nothing about whether your keys work.

```bash
npx tsx scripts/smoke.ts
```

That one does the opposite: Nebius answers, Neon stores, a Daytona workspace
boots and returns real exit codes, all five roles run, the guardrails fire, a
finished run resumes without re-paying for it, and the scorecard produces
numbers. It costs roughly twenty cents, which is the point - the things worth
checking before a deploy are the ones that cost something.

It deliberately **suppresses the GitHub credentials**, so it opens no pull
request. Publishing is the one step it leaves unexercised, and the first real
webhook is where you will find out about it - which is why
[step 2](#step-2--the-github-app-private-key) is worth reading rather than
skimming.

Run the smoke test with the same environment the deployment will have, not your
laptop's. A key that works locally and is missing on the service is the failure
this catches; a key that works locally because your `.env` has something the
service does not is the one it hides.

---

## Step 1 - the database, before anything boots

**Migrations do not run at startup.** The `drizzle/` directory is in
`.dockerignore` and nothing in `standalone.ts` applies it, which is deliberate -
a container that migrates on boot migrates once per replica and once per restart.
So the schema is your job, done once, from your machine, before the service
first comes up.

```bash
export DATABASE_URL='postgresql://…-pooler…'   # the pooled Neon string

npm run db:migrate                 # pipeline tables, into `public`
cd web && npm run db:migrate       # Better Auth tables, into `auth`
```

Two things worth knowing before you run that:

- **Use `db:migrate`, not `db:push` or `db:generate`.** Mastra's own storage
  creates its tables in `public` on first boot (`store.init()`), and they are not
  in `src/db/schema.ts`. `db:migrate` applies the migration files and does not
  care; `push` diffs the live database against the schema file and will offer to
  drop what it does not recognise.
- **The two sides keep separate ledgers.** `__drizzle_migrations` for the
  pipeline, `__drizzle_migrations_auth` for the dashboard, both in a `drizzle`
  schema. They share one database and would otherwise read each other's journal
  timestamps, judge each other's migrations already applied, and skip them while
  reporting success.

[DATABASE.md](DATABASE.md) has the full layout and the reasoning behind it.

**Without `DATABASE_URL`, docxy still runs** - every run, session, and symbol map
becomes JSON under the state directory. That is the right answer on a laptop and
the wrong one in a container, where the next deploy takes it all with it. Set it.

---

## Step 2 - the GitHub App private key

**On a deployment, set `GITHUB_APP_PRIVATE_KEY` - the PEM itself - and do not
set `GITHUB_APP_PRIVATE_KEY_PATH` at all.**

The path variable is the right shape on a laptop, where the key is a download
that never has to move. It is the wrong shape on Railway, Render, Fly, or any
other managed platform: they hand a service environment variables, not a
filesystem you can place a secret on beforehand. A `_PATH` pointing at
`/Users/you/.docxy/app.pem` resolves to nothing inside the container, and
`readPrivateKey()` (`src/github/app.ts`) throws rather than guessing.

That failure is worth understanding, because of *when* it lands. Nothing reads
the key at boot. It is read when a run tries to mint an installation token - so
the App looks configured, the webhook is accepted, all five roles run and are
paid for, and the run dies at the publish step with a message about a path on a
laptop. docxy now warns about this at startup, but the variable is still the
thing to get right.

### Pasting the PEM

`normalizePem()` accepts three forms, so use whichever your platform's UI
survives:

| Form | When |
|---|---|
| The PEM verbatim, newlines and all | Railway's variable editor and Vercel's both accept multi-line values |
| Base64 of the PEM | A one-line field, or a CI secret that mangles newlines |
| A PEM whose newlines arrived as literal `\n` | What happens when a `.env` file gets pasted through a shell |

For the base64 form:

```bash
base64 -i ~/.docxy/app.pem | tr -d '\n'      # macOS
base64 -w0 app.pem                            # Linux
```

`GITHUB_APP_PRIVATE_KEY` wins whenever both are set, so an old `_PATH` left over
on a service is harmless - but delete it anyway, so there is no ambiguity about
which one is being read.

---

## Step 3 - the docxy service

On Railway: **New Service → GitHub Repo → this repository.** The root
`Dockerfile` is detected automatically, so the build needs no configuration.
Then set **Healthcheck Path** to `/health` in the service settings.

### The volume, and the two settings around it

`checkoutPathFor()` puts every managed clone under `$HOME/.docxy/checkouts`, and
the image sets `HOME=/data` for exactly that reason. **Attach a volume mounted at
`/data`.** Without one, every redeploy hands the next commit a cold clone and an
empty symbol map - losing precisely the accumulation this design exists to build.

Two things about that volume are easy to get wrong:

- **The image carries no `VOLUME` instruction, on purpose.** Railway refuses to
  build an image that has one (*"docker VOLUME at Line 47 is not supported, use
  Railway Volumes"*), and an anonymous volume would shadow the real mount
  anyway. The mount is something you attach to the service, not something the
  image declares.
- **Set `RAILWAY_RUN_UID=0`.** The image runs as a non-root user, which is
  correct anywhere the volume's ownership can be set. Railway mounts volumes
  root-owned and documents the consequence: images running as a non-root uid
  *"will have permissions issues when performing operations within an attached
  volume."* Without this the container boots green and then fails on the first
  `git clone` into `/data`, a long way from the cause.

And one that is easy to miss entirely:

- **Set `DOCXY_STATE_DIR=/data/.docxy`.** The state directory defaults to
  `.docxy` under the working directory, which in this image is `/app` - not on
  the volume. It holds the standing instructions the dashboard edits, and, when
  `DATABASE_URL` is unset, every run record too. Left at its default, all of it
  is discarded on each deploy.

### Environment

```bash
# --- required ---------------------------------------------------------------
NEBIUS_API_KEY=
DOCXY_API_TOKEN=                 # openssl rand -hex 32 - the service will not boot without it
DATABASE_URL=                    # the pooled Neon string
DOCXY_STATE_DIR=/data/.docxy     # onto the volume, not into the image
RAILWAY_RUN_UID=0                # Railway only; see above

# --- the GitHub App ---------------------------------------------------------
GITHUB_APP_ID=
GITHUB_APP_INSTALLATION_ID=
GITHUB_APP_PRIVATE_KEY=          # the PEM itself - never the _PATH variant
GITHUB_WEBHOOK_SECRET=           # openssl rand -hex 32, same value as in the App

# --- the sandbox ------------------------------------------------------------
DAYTONA_API_KEY=                 # must be able to create, not just list

# --- worth setting ----------------------------------------------------------
DOCXY_DOCS_BUILD_COMMAND=        # without it the docs build is skipped silently
DOCXY_ALLOWED_REPOS=             # optional: narrows the App's installation further
```

**Leave `DOCXY_REPO_PATH` unset.** On a webhook-driven deployment the repository
comes from the delivery, and docxy manages its own checkout under `/data`.
Setting it pins every run to one tree - and `ensureCheckout()` refuses outright
if a push arrives for a repository that tree is not a clone of, which is the
correct behaviour and a confusing one to debug.

`DOCXY_API_TOKEN` is not optional here. This entry point binds `0.0.0.0`, and the
API behind it can approve proposals and open pull requests, so `standalone.ts`
throws at startup rather than putting those routes on the public internet. The
built-in timeline page stands itself down when a token is set - it drives itself
from the browser with `fetch` and an `EventSource`, and `EventSource` cannot send
an `Authorization` header at all. The dashboard is the operator UI for a
deployment; `GET /` says so and `/health` stays open for the platform's probe.

Finally, **give this service a public domain.** Both the dashboard and GitHub's
webhook have to reach it from outside.

---

## Step 4 - the webhook, so a push is all it takes

Without this the deployment can be looked at but not exercised: nothing starts a
run except an API call.

In the App's settings, set the **webhook URL** to
`https://<your-docxy-domain>/webhook` and its **secret** to the same value as
`GITHUB_WEBHOOK_SECRET`. Subscribe to **Push** events.

A push to a **connected repository's default branch** should now produce a run
in the dashboard with nobody at a terminal. Connected, not merely installed -
see the allowlist note below, and Step 5 for where repositories are connected.

When it produces nothing instead, the receiver is deliberately quiet - it
answers `200` to deliveries that are genuine but not actionable, so GitHub does
not retry them forever. The body says which:

| Response | Meaning |
|---|---|
| `503 GITHUB_WEBHOOK_SECRET is not set` | The secret is missing. Every delivery is refused rather than accepted unverified. |
| `401 bad signature` | The secret does not match the App's. |
| `200 ignored: not the default branch` | Only pushes to the repository's default branch start a run. |
| `200 ignored: <repo> is not connected to a project, so nothing is watching it` | The App can see the repository, but nobody connected it in the dashboard. **This is the usual answer** after an *All repositories* install. |
| `200 ignored: the GitHub App is not installed on <repo>` | The delivery is correctly signed - the secret belongs to the App - and names a repository this installation was not given access to. |
| `200 ignored: <repo> is not in DOCXY_ALLOWED_REPOS` | Connected, but excluded by the optional narrowing below. |
| `200 ignored: payload named no commit` | A push event with no `after` SHA - nothing identifiable to run against. |
| `503 ok: false` | The queue did not take the work. This is the one case where GitHub retrying is right. |

**The allowlist is the set of connected projects, not the installation.**
Installing the App is an access grant, and *All repositories* is how most people
install one - it says which repositories docxy *can* read, never which ones
anybody wants documented. A project is where that is said, one repository at a
time, on **Repositories → Connect a repository** in the dashboard. `/webhook`
checks each delivery against the projects table, re-read per delivery, so
connecting a repository takes effect on its next push with nothing to redeploy;
disconnecting it stops the runs the same way.

This is the difference between a bot that documents the one repository you asked
about and a bot that opens pull requests across every repository your account
owns. Granting access to all of them is fine, and expected. Nothing runs until a
project connects one.

The installation is still checked, second, because the webhook secret belongs to
the App rather than to a repository: if somebody else installs your App, their
pushes reach your `/webhook` and pass the signature. Token minting is scoped to
your `GITHUB_APP_INSTALLATION_ID`, so their code could never be cloned - but the
run would still be queued and reported as a failure, which is a confusing way to
find out.

`DOCXY_ALLOWED_REPOS` remains, and only ever *narrows* - it cannot add a
repository nobody connected. Use it to document fewer repositories than the
projects cover; leave it unset otherwise, which is the normal case.

A deployment with no `DATABASE_URL` has no projects at all. There, the
installation *is* the answer, which is the single-repository install and the
demo.

---

## Step 5 - the dashboard

**This is the step that makes a deployed dashboard show anything.**

Every page under `/dashboard` reads through `web/src/lib/docxy.ts`, which fetches
`DOCXY_API_URL` server-side and **fails soft** - a request that times out renders
an empty "offline" state rather than an error. The default is
`http://localhost:4317`, which on Vercel is the serverless function's own
container, where nothing is listening. A dashboard deployed without these
variables does not look broken. It looks like a pipeline that has never run.

On Vercel, import this repository with **Root Directory** set to `web`, and set:

```bash
DOCXY_API_URL=https://<your-docxy-domain>
DOCXY_API_TOKEN=<identical to the value on the docxy service>
DATABASE_URL=<the same pooled Neon string>
COMPOSIO_API_KEY=                # account connections; see COMPOSIO.md
BETTER_AUTH_SECRET=              # openssl rand -base64 32
BETTER_AUTH_URL=https://<your-dashboard-domain>   # the canonical one, exactly

# Registration is open exactly when these are set, and closed otherwise.
# Verify the domain in Resend BEFORE setting them: an unverified domain means
# an open signup form whose confirmation mail is refused on every send.
RESEND_API_KEY=
EMAIL_DOMAIN=docxy.app

# Optional. Email and password works without either; a provider's button
# appears only once its credentials are set.
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
```

- The **token has to match exactly**. Both callers trim before sending, so
  trailing whitespace is survivable, but a mismatched value is a `401` on every
  read with nothing on the page to say so.
- **`BETTER_AUTH_URL` is the canonical origin, not just any name that reaches
  the dashboard.** A deployment usually answers on several - a custom domain,
  its `www`, the platform's own `*.vercel.app` alias, a preview's one-off
  hostname - and Better Auth refuses a sign-in whose origin is none of them.
  Put the one you want in the address bar here, make every other name redirect
  to it, and list any that must keep working in `BETTER_AUTH_TRUSTED_ORIGINS`
  (comma-separated). The platform's own hostnames are trusted automatically.
- **There is no operator allowlist.** Anyone who signs up and confirms their
  address gets an account. Authorization is by organization membership: a
  session carries the organization it is looking at, every dashboard read names
  it, and the pipeline API refuses a read that does not. An account sees its own
  organization's runs, logs, repositories and instructions, and nothing else.
  `DOCXY_ALLOWED_EMAILS` is no longer read by anything; remove it.
- Add each provider's callback URL - `https://<your-dashboard-domain>/api/auth/callback/google`,
  and the same with `github` - to that provider's console.
- `DOCXY_REQUIRE_AUTH=0` opens `/dashboard` without signing in. That is how the
  demo runs; it is not how a deployment should.
- **The dashboard holds a live-update stream open per open tab.** The overview,
  activity and run pages subscribe to the pipeline's event feed through
  `/api/docxy/events` and re-render themselves as a run progresses. Each stream
  lasts `DOCXY_STREAM_SECONDS` (55 by default) and is then closed and reopened,
  which is what re-checks the viewer's membership: a connection that never ends
  is a permission nobody asks about again. Fifty-five seconds fits inside the
  60-second function ceiling every plan has. Check what your plan actually
  allows before raising it, and raise `maxDuration` in
  `web/src/app/api/docxy/[...path]/route.ts` with it - the two are a pair, and a
  stream longer than the invocation is cut off mid-event rather than closed.

`web/.env.local.example` documents the rest.

---

## Step 6 - confirm it, rather than assume it

```bash
curl -s https://<your-docxy-domain>/health
```

```json
{
  "ok": true,
  "model": "configured",
  "sandbox": "configured",
  "repo": "/app"
}
```

`ok: true` only means the process is up. The other three fields are the point:
`model` reports whether a run could start at all, and `sandbox` whether the docs
build has anywhere isolated to run. A deployment missing either is *running* and
cannot do its job - the exact state a plain green health check used to hide.

`"repo": "/app"` is expected and correct when `DOCXY_REPO_PATH` is unset; the
repositories that matter are the managed checkouts under `/data`.

Then push a docs-worthy commit to an installed repository and watch the run
appear. The deploy logs also state the remaining problems at boot, one line each
- a missing Nebius key, a code-mode configuration that cannot work, a private key
still configured as a path.

---

## The sandbox: what the Daytona key has to be able to do

**The key must be able to create sandboxes, not just read them.** Registration
builds a snapshot. A read-scoped key authenticates against the API perfectly and
is still refused at the moment it is used, and from outside the two failure modes
look identical:

```
GET https://app.daytona.io/api/sandbox   -> 200          # listing works
docxy setup                              -> HTTP 422     # creating does not
```

Without a working key the consequence is bounded and by design: `DOCXY_SANDBOX`
is on but `DOCXY_SANDBOX_FALLBACK` defaults to `skip`, so the docs build is
**reported unvalidated** rather than quietly executed on the host, and proposals
open as drafts carrying that reason. The isolation boundary holds. Set
`DOCXY_SANDBOX_FALLBACK=local` only where you have decided a host-run build is
acceptable.

**A container cannot run docxy's local sandbox on Railway.** The local backend
needs `bwrap` mounting `/proc`, which needs a fully privileged container -
`--cap-add SYS_ADMIN` is not enough, and no environment variable substitutes.
Railway does not offer privileged containers. That is the whole reason Daytona
is the deployed answer rather than a nicety.

### Code mode

`DOCXY_CODE_MODE` is **off by default**, and a deployment should leave it off
until it has earned its cost against `docxy eval`. If you do turn it on:

- It runs its program in a **Daytona workspace and nowhere else**. A missing
  `DAYTONA_API_KEY` is an **error**, not a fallback - every run fails at
  drafting, and the service says so at boot. That is deliberate: a missing
  variable must never relocate model-authored code onto the production
  container.
- `DOCXY_CODE_MODE_SANDBOX=local` runs that program on the machine docxy is
  running on. It is a development setting, it has to be asked for by name, and
  the service warns at boot when a deployment has it set.
- `DOCXY_SANDBOX=false` turns the *docs build* off and has no effect on where a
  program runs. The two are deliberately independent.

---

## Environment variables

Everything docxy reads is documented in [`.env.example`](../.env.example). These
are the ones a deployment turns on.

| Variable | Default | Why it matters here |
|---|---|---|
| `NEBIUS_API_KEY` | *required* | Model access. No run starts without it. |
| `DOCXY_API_TOKEN` | *required* | Shared secret for the API. `standalone.ts` refuses to boot without it. Identical value on the dashboard. |
| `DATABASE_URL` | none | Neon, pooled. Unset, runs are JSON the container loses on redeploy. |
| `DOCXY_STATE_DIR` | `<cwd>/.docxy` | Point at `/data/.docxy` so standing instructions and file-backed state land on the volume. |
| `GITHUB_APP_ID` | *required* | The App's numeric id. There is no personal-token fallback. |
| `GITHUB_APP_PRIVATE_KEY` | *required* | **The PEM itself.** See [step 2](#step-2--the-github-app-private-key). |
| `GITHUB_APP_PRIVATE_KEY_PATH` | - | **Do not set on a deployment.** A laptop-shaped variable that fails at the publish step. |
| `GITHUB_APP_INSTALLATION_ID` | *required* | The installation being documented. |
| `GITHUB_WEBHOOK_SECRET` | *required* | Shared with the App. Unset, `/webhook` answers `503` to everything. |
| `DOCXY_ALLOWED_REPOS` | empty | Optional narrowing of the connected projects. Empty - the normal case - means every repository connected in the dashboard. It cannot widen: an unconnected repository stays unwatched. |
| `DAYTONA_API_KEY` | none | The sandbox. Must be create-capable. |
| `DOCXY_SANDBOX_FALLBACK` | `skip` | `local` permits a host-run docs build. Leave it alone unless you mean it. |
| `DOCXY_DOCS_BUILD_COMMAND` | empty | Without it the docs build is skipped and the sandbox never appears in the validation report. |
| `DOCXY_REPO_PATH` | the working directory | **Leave unset when webhook-driven.** Setting it pins every run to one checkout. |
| `DOCXY_CODE_MODE` | `false` | Off until measured. On, it requires a Daytona key. |
| `DOCXY_DOCS_BRANCH` | none | Only if docs live on their own branch. |
| `DOCXY_APPROVAL_STALE_MINUTES` | `60` | Minutes before a pending request is *reported* stale. Never auto-resolved. |
| `PORT` | `4317` | Set by the platform. `DOCXY_PORT` stays the local default. |

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| The service will not start, log names `DOCXY_API_TOKEN` | Working as intended. Set it. |
| Container boots, first run fails on `git clone` into `/data` | No `RAILWAY_RUN_UID=0`; the volume is root-owned and the image is not. |
| Every redeploy starts from cold sessions and an empty symbol map | No volume at `/data`, or `DOCXY_STATE_DIR` still on its default. |
| The webhook "does nothing" | Check the response body - the table in [step 4](#step-4--the-webhook-so-a-push-is-all-it-takes) names each ignore reason. |
| Everything runs, then the pull request fails | `GITHUB_APP_PRIVATE_KEY_PATH` is set instead of `GITHUB_APP_PRIVATE_KEY`. |
| Proposals all open as drafts, "reported unvalidated" | No usable `DAYTONA_API_KEY`. Check it can create, not just list. |
| Dashboard renders an empty "offline" state | `DOCXY_API_URL` unset or `DOCXY_API_TOKEN` mismatched. It fails soft by design. |
| Login page renders and no button works | No OAuth provider configured. Email and password still works. |
| Signup page says registration is closed | `RESEND_API_KEY` or `EMAIL_DOMAIN` unset. Registration opens only when a confirmation email can be sent. |
| Signups open but no confirmation mail arrives | The sending domain is not verified in Resend. It accepts the key and refuses each message. |
| Dashboard reads all fail with `organizationId is required` | Migrations not applied, so the session carries no organization. Run both migration sets. |
| Every run fails at drafting | `DOCXY_CODE_MODE=true` with no Daytona key. Set the key or turn code mode off. |

---

## The alternative: one VM

If you would rather not split this across managed services, the whole thing runs
on a single small VM with Docker Compose: docxy from this `Dockerfile`, Postgres
beside it, and a reverse proxy in front for TLS.

The tradeoff is ownership - TLS, restarts, and backups become yours, where on
Railway they are the platform's problem. One thing you gain: a VM **can** run a
privileged container, so the local sandbox backend works there and a Daytona
account becomes optional. Install `bubblewrap`, `socat`, `ripgrep`, and
`python3` in the image and run it privileged.

---

## What a deployed docxy can do that a local one cannot

This is what makes the deployment worth having:

- **`POST /webhook` accepts pushes.** A commit authored anywhere - the web
  editor, a colleague's machine, another CI job - starts a run with nobody at a
  terminal.
- **`ensureCheckout()` clones each repository itself**, with a short-lived
  installation token that is never written to disk. The CLI can only read
  whatever your local checkout happens to have.
- **Every installed repository appears in one dashboard**, because
  `syncedRepoPaths()` reports the managed checkouts alongside the local one.

The CLI documents the repository you are standing in. The deployment documents
every repository the App is installed on.

---

## See also

- [LOCAL-SETUP.md](LOCAL-SETUP.md) - from nothing to a documentation pull request on your own machine
- [GITHUB-APP.md](GITHUB-APP.md) - registering the App and finding all four credentials
- [DATABASE.md](DATABASE.md) - the three schemas, the two migration histories, and why
- [OBSERVABILITY.md](OBSERVABILITY.md) - what each run records
