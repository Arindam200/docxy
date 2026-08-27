# Persistence: Neon + Drizzle

**Status: built.** `DATABASE_URL` selects the backend. Unset, the pipeline keeps
everything as JSON in `.docxy/` — zero setup, and what the demo uses. Set it and
runs, sessions, and the symbol map move to Postgres. Both are supported; the
JSON stores are not deprecated.

The dashboard in `web/` is the other half: Better Auth stores users, sessions,
and OAuth accounts in the same Neon database, in a separate `auth` schema.

---

## Layout

One Neon database, two schemas, two migration histories:

| Schema | Owner | Tables | Migrations |
|---|---|---|---|
| `public` | the pipeline | runs, sessions, knowledge | `drizzle/` |
| `auth` | the dashboard | Better Auth's four tables | `web/drizzle/` |

Each `drizzle.config.ts` sets `schemaFilter` to its own schema. Without that,
running drizzle-kit on one side sees the other side's tables, finds them absent
from its schema file, and offers to drop them.

```
# pipeline
npm run db:generate      # diff schema against drizzle/, write a migration
npm run db:migrate       # apply
npm run db:backfill      # one-off: copy .docxy/ into Postgres

# dashboard
cd web && npm run db:migrate
```

Use Neon's **pooled** connection string — the one containing `-pooler`.

---

## Which Neon driver

Drizzle offers three ways in, and the two sides want different ones:

| Driver | Transactions | Used by |
|---|---|---|
| `drizzle-orm/neon-http` | **No** | **the dashboard** — Better Auth's Drizzle adapter never opens a transaction on Postgres |
| `drizzle-orm/neon-serverless` | **Yes** (Pool over WebSocket) | **the pipeline** — writing a run is one transaction |
| `drizzle-orm/node-postgres` | Yes | any Postgres, if you leave Neon |

Writing a run means inserting the run, its roles, their events, and their file
bodies together. That wants a transaction, which `neon-http` cannot do. The
dashboard has no such need, so it skips the WebSocket machinery entirely.

`neon-serverless` is a drop-in for `pg`, so moving off Neon later costs one
import.

---

## Schema

`src/db/schema.ts` is the source of truth. Two principles shape it:

1. **Big text lives outside the hot tables.** Prompts, raw model output, and
   file before/after bodies are large and read only on a detail view. In
   `run_files` and `run_events`, the run list stays a cheap query.
2. **Model output is jsonb.** `classification`, `impact`, `docs`, `changelog`,
   and `validation` are shaped but still evolving. Columns would mean a
   migration every time a role's output schema moves.

| Table | Holds |
|---|---|
| `projects` | one row per repository; sessions and knowledge hang off it |
| `agent_sessions` | one harness session per role per project, plus `spec_hash` |
| `runs` | the indexed run list — commit, status, counts, timing |
| `run_outputs` | the five roles' structured output, as jsonb |
| `run_roles` | one row per trace, ordered by `ordinal` |
| `run_events` | timeline lines, ordered by `ordinal` within a role |
| `run_files` | proposed file bodies — large, detail-only |
| `approvals` / `approval_signoffs` | the gate, one row per sign-off |
| `knowledge_symbols` | the symbol → doc-section map |
| `knowledge_commits` | commits already folded in |

Three things differ from the original sketch, all for the same reason — the
sketch invented fields that `RunRecord` does not have:

- **No token or cost columns.** The harness does not report usage yet. Adding
  the columns before there is anything to put in them would have meant a
  migration to fix their shape once there is.
- **`scope` and `summary` live only on `approvals`.** The sketch also
  denormalised them onto `runs`; one copy cannot go stale.
- **`ordinal` on the child tables.** Events within a role routinely share a
  timestamp, so ordering by `at` alone does not reload a timeline in the order
  it happened.

`knowledge_commits` is a table rather than an array column so that recording a
commit is an insert instead of a read-modify-write of the whole list — which is
what makes it safe for two workers to process different commits on one repo.

### The `spec_hash` column

This fixes a real bug in the file-backed version. The harness freezes an agent's
spec when the session is created, so editing a role's prompt or pointing it at a
different model changed nothing until sessions were cleared by hand. Sessions
are now keyed on a hash of the spec: a changed spec is a miss, and the next run
transparently starts a fresh session.

Both stores do this. `SessionStore` reads the older bare-string format too, and
adopts those sessions rather than orphaning them.

---

## How the swap works

The three stores already had clean interfaces. `src/pipeline/stores.ts` names
them — `RunStorage`, `SessionStorage`, `KnowledgeStorage` — and holds the one
function that picks a backend:

```ts
export function createStores(config: Config): Stores {
  if (databaseConfigured()) {
    return {
      runs: new PgRunStore(config),
      sessions: new PgSessionStore(config),
      knowledge: new PgKnowledgeStore(config),
    };
  }
  return {
    runs: new RunStore(config),
    sessions: new SessionStore(config),
    knowledge: new KnowledgeStore(config),
  };
}
```

Nothing else in the pipeline knows which one it got.

`PgRunStore.save` upserts the whole aggregate in one transaction. The pipeline
calls it at each role boundary with a record that has grown, and a partially
written run is worse than a slow one. Children are replaced rather than diffed:
they are append-only in practice and small enough that working out what changed
would cost more than rewriting them.

`list()` hydrates a page of runs with one query per child table over the full id
set — listing 50 runs is six queries, not three hundred.

---

## Notes

**Retention.** `run_files` and `run_events` are what grow. Drop rows past N days;
the run and role rows stay, so history and metrics survive without bodies.

**One writer per project.** Two workers processing two commits on the same repo
drive the same harness session concurrently, which the symbol map cannot absorb.
Shard by project, or take a per-project advisory lock:
`SELECT pg_advisory_xact_lock(hashtext($1))`.

**Neon branching.** Neon branches a database like git. A branch per preview
environment, seeded from production, is genuinely useful for testing a migration
before it lands.

**Money.** Nothing stores currency yet. When something does: `numeric(12,6)` or
text, never a float.

Sources: [Drizzle · Neon](https://orm.drizzle.team/docs/connect-neon) ·
[Neon serverless driver](https://neon.com/docs/serverless/serverless-driver) ·
[Better Auth · Drizzle](https://www.better-auth.com/docs/adapters/drizzle)
