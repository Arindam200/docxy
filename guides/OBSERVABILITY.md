# Reading runs and observability

Current implementation reference, checked against the working tree on September 8, 2026. Core capture, cost reporting and dashboard views are implemented. This describes code behavior, not a fresh verification of deployed services.

## Where to look

For deployment health, first run `node scripts/check-deploy-targets.mjs`.
Production logs belong to Vercel `docxy` and Railway **`tender-laughter/docxy`**;
see [CONNECTIONS.md](CONNECTIONS.md) for the complete service map. The old
`refreshing-tenderness/docxy` crash is a retired deployment, not the live backend.
Historical failed GitHub statuses can remain on old commits after that service
is disconnected.

`/health` verifies that the backend responds and reports model/sandbox
configuration. It does not execute a model request, launch a sandbox or certify
a documentation run. Composio connection status belongs in **Integrations**;
an API key does not prove that an organization authorized a provider account.

Every view below is scoped to one project, because every one of them answers a
question about a single repository. The organization level is the project list
at `/dashboard`. The former organization-wide routes - `/dashboard/activity`,
`/dashboard/logs`, `/dashboard/insights`, `/dashboard/observability` and
`/dashboard/runs/<id>` - all redirect to their new homes rather than 404ing.

| View | What it shows |
| --- | --- |
| `/dashboard/projects/<id>` | Success rate, median run, last run, latest five runs and the documentation setup in brief |
| `/dashboard/projects/<id>/activity` | Run history for this repository: role outcomes, duration, tokens and PR links |
| `/dashboard/projects/<id>/runs/<run>` | Role waterfall, token breakdown, validation, sandbox evidence, approval metadata and each role's details |
| `/dashboard/projects/<id>/logs` | Recorded role events across this repository's runs |
| `/dashboard/projects/<id>/insights` | Aggregated reliability, durations, token/cost trends and affected documentation |
| `/dashboard/projects/<id>/settings` | Source repository, documentation repository and paths, and what triggers a run |

`GET /api/runs`, `/api/logs` and `/api/observability` each take an optional
`projectId` alongside `organizationId`, which is how those views narrow. The
narrowing happens in the query rather than in the dashboard: the listing is
capped, so a busy repository would otherwise crowd a quiet one out of the window
entirely. A `projectId` outside the calling organization narrows to nothing.

The Next.js dashboard does not yet subscribe to the backend event stream. Navigate or refresh to retrieve updated records. The bundled operator page has an event consumer; it is a separate interface. Remaining dashboard streaming work is in [LIVE-UPDATES-PLAN.md](LIVE-UPDATES-PLAN.md).

## What gets recorded

[RunRecord and RoleTrace](../src/types.ts) define the stored data. Each run includes its source commit, status, timestamps, role traces, parsed proposals, validation results and any published PR URL. Proposed files preserve the before/after content used for publication.

Role traces record the model, prompt, raw output, structured outcome, usage, timing, events and failure information when available. [RunContext](../src/pipeline/context.ts) captures bodies and rolls up duration, tokens and estimated cost. Captured bodies are bounded; they are not guaranteed to contain unlimited model output or the entire provider conversation.

Mastra supplies the runtime in [runtime/mastra.ts](../src/runtime/mastra.ts); there is no separate TrueForge service. Workflow snapshots support resuming completed steps without re-running every agent. Session identifiers and reuse indicators are audit metadata, not proof that every role retains conversational memory; the Docs Updater deliberately does not retain old document text.

With Postgres configured, [schema.ts](../src/db/schema.ts) separates role bodies from summary records. Without it, the pipeline uses local state storage. Older records may lack newer fields. Treat a missing duration or price as unknown rather than zero.

## Costs and reliability

[pricing.ts](../src/pricing.ts) obtains and caches model rates, and run accounting applies rates to the model actually used. Costs are estimates from token usage, not provider invoices. Sandbox, hosting and other provider charges are not included in the model-cost total.

[server/observability.ts](../src/server/observability.ts) derives cross-run aggregates from stored records. Inspect the selected window and available sample before drawing conclusions from success rates or trends. If a record lacks pricing, the UI should show that limitation instead of treating the run as free.

For quality measurements use the existing CLI:

```bash
npm run docxy -- eval
npm run docxy -- memory
npm run docxy -- show <full-run-id> --json
```

Use a full run ID for an export requiring all stored bodies; summary listings are not a substitute for loading the complete record. Eval scores are deterministic checks of recorded proposals, not an independent human assessment of prose accuracy. See [TODO.md](../TODO.md) for the outstanding comparative evaluations.

## Diagnosing a run

1. Open the run and inspect the failed role or validation check.
2. Compare the role's prompt, raw output and parsed result. A timeout or token-limit error alone may not explain the underlying generation failure. Bodies may be missing on older records or failures that returned no usable output.
3. Read validation details literally. A build over proposed files only does not certify that the complete documentation site builds. A skipped check supplies no positive evidence.
4. Preserve the distinction between execution failure and a review concern. Successful roles remain visible when another role fails. A rejected or invalid proposal may still be published as a draft carrying its concerns.
5. Use the PR as the human review surface. Stored approval metadata describes pipeline scrutiny; it is not a separate customer approval gate or permission to merge automatically.

The relevant UI components are [RoleInspector](../web/src/components/dashboard/RoleInspector.tsx), [Waterfall](../web/src/components/dashboard/Waterfall.tsx), [TokenBreakdown](../web/src/components/dashboard/TokenBreakdown.tsx) and [SandboxTrail](../web/src/components/dashboard/SandboxTrail.tsx).

## Remaining work

Retention/expiry of captured bodies and exports beyond the existing single-run JSON command are still pending in [TODO.md](../TODO.md). Customer authorization across logs, bodies, aggregates and events is unfinished in [LIVE-UPDATES-PLAN.md](LIVE-UPDATES-PLAN.md). Do not expose deployment-wide observability to arbitrary customer accounts before that work passes isolation checks.

The completed observability implementation checklist has been removed from this guide; its history remains in git.
