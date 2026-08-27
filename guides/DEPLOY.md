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

Four steps. No auth, no OIDC, no tokens.

### 1. Add the harness as a service

New service → **Deploy from Docker image**:

```
tfy.jfrog.io/tfy-images/trueforge:0.1.4-fba492f
```

The image is anonymously pullable, so there is no registry credential to set up.
Check for a newer tag in [charts/trueforge/values.yaml](https://github.com/truefoundry/trueforge/blob/main/charts/trueforge/values.yaml).

### 2. Set two variables on it

```bash
PORT=8790
HOST=::
```

`HOST=::` is the one that is easy to miss and hard to debug. Railway's private
network is **IPv6-only**, and TrueForge's container image defaults to
`HOST=0.0.0.0`, which does not accept IPv6. Without this, `harness.railway.internal`
refuses the connection and docxy reports the harness as unreachable — exactly the
same symptom as not setting the URL at all.

Health check path: `/healthz`.

### 3. Do **not** give it a public domain

Leave the harness with no domain. It is reachable only from your other Railway
services, which is the entire security model:

TrueForge ships **no machine authentication** — no API key, no bearer token, no
service account. Its only login is OIDC, a browser sign-in flow that a server
process cannot complete. So a harness on a public URL is unauthenticated admin
access to your Nebius key, every session, and the ability to run arbitrary agents.
There is no key you can add to fix that.

Keeping it private is not extra hardening. It is the access control.

### 4. Point docxy at it

On the **docxy** service:

```bash
TRUEFORGE_BASE_URL=http://harness.railway.internal:8790
```

`harness.railway.internal` is just what the other service is called on Railway's
network — the same role `localhost` played on your laptop. Substitute your
service's actual name if you called it something else.

### Then register Nebius once

The provider lives in the harness's database, so a fresh harness needs it:

```bash
railway run npm run setup
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

| Variable | Why |
|---|---|
| `TRUEFORGE_BASE_URL` | The harness. Defaults to localhost, which is wrong once deployed. |
| `NEBIUS_API_KEY` | Model access. |
| `DOCXY_PROJECT_KEY` | **Set this.** Sessions and the symbol map key on it, and it defaults to the checkout path — which is a fresh temp directory on every hosted run. Leave it unset and every commit silently starts from cold sessions and an empty map. Use `owner/repo`. |
| `PORT` | Set by the platform. Read automatically. |
| `DOCXY_APPROVAL_MODE` | `auto` (default) opens the PR straight away; `elevated` gates breaking changes; `always` gates everything. |
| `DOCXY_DOCS_BRANCH` | Only if docs live on their own branch. |

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

## Not deployed yet

The GitHub App — webhook receiver, installation tokens, cross-repo docs — is
designed but unbuilt. Until then, docxy runs from the CLI or its own server, and
the deployment above is what hosts that.
