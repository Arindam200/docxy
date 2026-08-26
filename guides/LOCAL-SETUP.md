# Running docxy locally

From nothing to a documentation pull request on your own repository.

There are two halves and you do not need both. The **pipeline** is the five
agents, the CLI, and the API server — that is enough to run docxy end to end.
The **dashboard** is a Next.js app that renders runs in a browser; it is
optional and comes last.

Work through the stages in order. Each one ends in something you can check, so a
mistake surfaces where you made it rather than four steps later.

- [Stage 1 — the pipeline](#stage-1--the-pipeline) *(required, ~10 minutes)*
- [Stage 2 — publishing pull requests](#stage-2--publishing-pull-requests) *(needed for PRs)*
- [Stage 3 — Postgres](#stage-3--postgres-optional) *(optional)*
- [Stage 4 — the dashboard](#stage-4--the-dashboard-optional) *(optional)*
- [Stage 5 — running on every push](#stage-5--running-on-every-push) *(optional)*
- [Troubleshooting](#troubleshooting)

---

## Before you start

| You need | Why |
|---|---|
| **Node 20.11+** and **npm 11+** | `node --version` |
| **git** | The pipeline reads commits and writes branches with it |
| A **Nebius Token Factory** API key | Serves every model. Free tier is enough — [get one](https://tokenfactory.nebius.com) |

Everything else — Postgres, a GitHub App, the dashboard — is optional and has
its own stage below.

---

## Stage 1 — the pipeline

### 1.1 Install

```bash
git clone https://github.com/Arindam200/docxy.git
cd docxy
npm install
```

### 1.2 Start the harness

TrueForge is the agent harness. It runs the five agents and owns their
sessions. It is a separate process, so give it **its own terminal** and leave it
running:

```bash
npx @truefoundry/trueforge@latest
```

It listens on `http://localhost:8790`. Check it:

```bash
curl -s http://localhost:8790/healthz && echo " harness up"
```

### 1.3 Add your key

```bash
cp .env.example .env
```

Open `.env` and set one line:

```bash
NEBIUS_API_KEY=your-key-here
```

Every other variable has a working default. `.env` is gitignored — keep your key
there and nowhere else.

### 1.4 Register the models

```bash
npm run setup
```

This registers Token Factory with the harness as an OpenAI-compatible provider
and checks that every model the roster wants actually resolves.

**Model ids move.** If `setup` reports something unresolvable, see what your
account can serve and adjust `.env`:

```bash
npx tsx src/cli.ts models     # what your account can actually serve
npx tsx src/cli.ts doctor     # harness, key, repo, and per-role model check
```

`doctor` is the command to run whenever something is off. It checks each piece
separately and names the one that is wrong.

### 1.5 Run it

You need a repository with a commit and some documentation. The bundled demo
repo is the fastest way to see the whole thing work:

```bash
npm run demo                                  # creates .demo-repo
npx tsx src/cli.ts run HEAD --repo .demo-repo
```

Or point it at your own:

```bash
npx tsx src/cli.ts run HEAD --repo /path/to/your/repo
```

You will see each role start and finish. At the end docxy prints the
classification, the proposed edits, and the changelog entry.

**Without a GitHub App configured, that is where it stops** — the proposal is
complete and recorded, but there is no identity to open a pull request as.
Stage 2 fixes that.

Look at what it did:

```bash
npx tsx src/cli.ts runs              # recent runs
npx tsx src/cli.ts show <run-id>     # one run in detail
```

### 1.6 The API server

```bash
npm run serve
```

Serves the API on `http://localhost:4317` — the run timeline, the logs, and
what the dashboard reads. Leave it running in its own terminal.

```bash
curl -s http://localhost:4317/api/runs | head -c 200
```

**You now have a working pipeline.** Stages 2–5 are additive.

---

## Stage 2 — publishing pull requests

Docxy publishes **only** as its own GitHub App. There is no personal-token
fallback, deliberately: a machine's proposal opened under a human's name is the
thing a bot identity exists to prevent.

[**guides/GITHUB-APP.md**](GITHUB-APP.md) walks through registering the App and
finding the three ids. The short version:

1. Create an App at **Settings → Developer settings → GitHub Apps → New**.
2. Permissions: **Contents: Read & write**, **Pull requests: Read & write**.
3. Generate a private key — it downloads a `.pem`.
4. Install the App on a repository. The installation id is the number at the
   end of the URL you land on.

Then in `.env`:

```bash
GITHUB_APP_ID=123456
GITHUB_APP_PRIVATE_KEY_PATH=/absolute/path/to/app.pem
GITHUB_APP_INSTALLATION_ID=789012
GITHUB_APP_SLUG=your-app-slug
```

Verify:

```bash
curl -s http://localhost:4317/api/repositories | head -c 400
```

That lists the repositories the App is installed on. **That list is what
"synced" means** — not a local path. A repository is synced because you
installed the App on it, which is why the answer survives this server being
restarted somewhere else.

Now a run opens a real pull request:

```bash
npx tsx src/cli.ts run HEAD
```

### Approval

By default there is **no approval step**: the run signs itself off, opens the
pull request, and the pull request is the review surface. Nothing merges without
someone approving it on GitHub.

A proposal the Coordinator rejected, or one that failed validation, still opens
— as a **draft**, with the reasons at the top of the body. A stalled pipeline
tells nobody anything; an unmergeable draft tells them exactly what went wrong.

To require a human sign-off inside docxy as well:

```bash
DOCXY_REQUIRE_APPROVAL=true
```

Runs then stop at `awaiting-approval` and wait:

```bash
npx tsx src/cli.ts approve <run-id> --by "your name"
npx tsx src/cli.ts deny    <run-id> --by "your name" --reason "why"
```

Elevated scope — a breaking change, documented public API, a major bump — needs
two sign-offs from two different people. The gate never expires and is never
auto-resolved in either direction.

---

## Stage 3 — Postgres (optional)

Unset, docxy keeps runs, sessions, and the symbol map as JSON in `.docxy/`.
That needs no setup and is what the demo uses.

Set `DATABASE_URL` and all three move to Postgres, which is what you want if
more than one person is looking at the dashboard or if you are deploying it.
[Neon](https://neon.tech) has a free tier.

Use the **pooled** connection string — the one containing `-pooler`:

```bash
DATABASE_URL=postgresql://user:pass@ep-xxx-pooler.region.aws.neon.tech/docxy?sslmode=require
```

Apply the schema:

```bash
npm run db:migrate
```

Check which backend is live:

```bash
curl -s http://localhost:4317/api/config | grep -o '"storage":"[a-z]*"'
```

[guides/DATABASE.md](DATABASE.md) covers the schema and why the dashboard's auth
tables are kept in a separate `auth` schema.

---

## Stage 4 — the dashboard (optional)

A Next.js app that renders runs, logs, per-role traces, and spend. It needs
Postgres (Stage 3) because sign-in stores sessions there.

```bash
cd web
npm install
cp .env.local.example .env.local
```

In `web/.env.local`:

```bash
DATABASE_URL=            # the same Neon string as the pipeline
BETTER_AUTH_SECRET=      # openssl rand -base64 32
DOCXY_API_URL=http://localhost:4317
```

Google and GitHub sign-in are optional — email and password work without
either, and a provider's button only appears once its credentials are set.

```bash
npm run db:migrate   # the auth schema, separate from the pipeline's
npm run dev
```

Open `http://localhost:3000`, create an account, and go to `/dashboard`.

You now want **three terminals**: the harness, `npm run serve` in the repo root,
and `npm run dev` in `web/`. The dashboard reads the API server, so it shows
"API offline" if that one is not running.

---

## Stage 5 — running on every push

So far every run has been started by hand. A webhook makes a push start one.

Generate a secret and put it in `.env`:

```bash
openssl rand -hex 32
```

```bash
GITHUB_WEBHOOK_SECRET=the-value-you-just-generated
```

Without it `POST /webhook` refuses every delivery — an unauthenticated endpoint
that starts agent runs is not something to leave open.

GitHub needs to reach your machine, so expose the server:

```bash
npx untun@latest tunnel http://localhost:4317
```

In your App's settings set the **Webhook URL** to `<public-url>/webhook`, set
the same secret, and subscribe to **Push** events.

Push to the default branch and watch the run start. Only default-branch pushes
are acted on; anything else is acknowledged and ignored so GitHub does not retry
it.

A push arriving while another run is going **waits its turn** rather than being
dropped — one repository has one writer, but a queued commit is still
documented. A redelivered webhook for a commit already running or already queued
is recognised and not run twice.

---

## Troubleshooting

**Start here.** It checks each piece separately and names the one that is wrong:

```bash
npx tsx src/cli.ts doctor
```

### `Cannot reach the TrueForge harness`

The harness is not running, or it is on a different port. Start it with
`npx @truefoundry/trueforge@latest`, or point docxy elsewhere with
`TRUEFORGE_BASE_URL`.

### `Port 4317 is already in use`

Docxy is already running in another terminal. Stop that one, or start this one
elsewhere with `DOCXY_PORT=4318 npm run serve`.

### A role fails with `max-tokens`

The role spent its whole output budget without finishing. Docxy retries this
automatically on a fresh session, because a session carrying many commits is the
usual cause. If it survives all three attempts, shorten the session's memory:

```bash
DOCXY_SESSION_MAX_TURNS=6
```

Or clear what has accumulated:

```bash
npx tsx src/cli.ts reset --sessions
```

### A role fails with `parse-error`

The model returned something that was not the JSON the pipeline asked for.
Docxy shows the model its own output and asks again. If it keeps happening, the
model is the suspect — check `DOCXY_MODEL_*` in `.env` points at a
structured-output-capable model. A short visible answer is not a reason to use a
weaker one: the Changelog Author has previously exhausted a whole turn in a
Flash repetition loop.

The raw response is recorded either way:

```bash
npx tsx src/cli.ts show <run-id> --json
```

### The run says the pull request could not be opened

The proposal is sound and recorded; publishing is what failed. The error names
the cause — usually the App is not installed on that repository, or its
permissions are missing **Contents: Read & write**. Fix it and republish without
re-running the agents:

```bash
npx tsx src/cli.ts approve <run-id> --by "your name"
```

### The dashboard says "API offline"

`npm run serve` is not running, or `DOCXY_API_URL` in `web/.env.local` points
somewhere else.

### Runs work but the dashboard is empty

The dashboard lists runs for the repositories the App is installed on plus the
one this server was started in. If you ran the pipeline against some other
directory with `--repo`, its runs belong to that project and will not appear.

### Starting over

```bash
npx tsx src/cli.ts reset --sessions --knowledge
```

Clears the accumulated sessions and the symbol map for this repository. Runs are
kept.

---

## Configuration reference

Every variable, with its default and what it is for, is documented in
[`.env.example`](../.env.example). The ones worth knowing early:

| Variable | Default | What it does |
|---|---|---|
| `NEBIUS_API_KEY` | — | Required. Serves every model |
| `DOCXY_REQUIRE_APPROVAL` | `false` | Hold proposals behind a human sign-off |
| `DOCXY_REPO_PATH` | the current directory | Which repository to document |
| `DOCXY_DOCS_BRANCH` | unset | Keep docs on their own branch |
| `DATABASE_URL` | unset | Postgres instead of JSON files |
| `DOCXY_ROLE_MAX_ATTEMPTS` | `3` | Attempts per role before it gives up |
| `DOCXY_SESSION_MAX_TURNS` | `12` | Turns before a session is retired |
| `DOCXY_PORT` | `4317` | API server port |

---

## Where to go next

- [guides/GITHUB-APP.md](GITHUB-APP.md) — registering the App in full
- [guides/DATABASE.md](DATABASE.md) — the schema and why auth is kept apart
- [guides/OBSERVABILITY.md](OBSERVABILITY.md) — reading traces, spend, and reliability
- [guides/DEMO.md](DEMO.md) — the scripted walkthrough
- [guides/DEPLOY.md](DEPLOY.md) — running it somewhere other than your laptop
