import Link from "next/link";
import { notFound } from "next/navigation";
import { fetchRun } from "@/lib/docxy";
import { dateTime, duration } from "@/lib/format";
import { Page, PageHead } from "@/components/dashboard/Page";
import { StatusChip } from "@/components/dashboard/RunTimeline";
import { Waterfall } from "@/components/dashboard/Waterfall";
import { TokenBreakdown } from "@/components/dashboard/TokenBreakdown";
import { RoleInspector } from "@/components/dashboard/RoleInspector";

export const dynamic = "force-dynamic";

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const run = await fetchRun(id);
  if (!run) notFound();

  // The role a tab shows under "Parsed" is whichever run-level field that role
  // produced; the Coordinator's verdict survives only as the approval summary.
  const parsed: Record<string, unknown> = {
    "change-analyst": run.classification,
    "impact-mapper": run.impact,
    "docs-updater": run.docs,
    "changelog-author": run.changelog,
    coordinator: run.approval
      ? { summary: run.approval.summary, scope: run.approval.scope }
      : undefined,
  };

  return (
    <Page>
      <PageHead
        title={run.commit.subject}
        lede={
          <>
            <code className="font-mono text-xs text-accent">{run.commit.shortSha}</code>
            <span aria-hidden> · </span>
            {dateTime(run.startedAt)}
            <span aria-hidden> · </span>
            {duration(run.durationMs)}
          </>
        }
      >
        <div className="flex items-center gap-4">
          <StatusChip status={run.status} />
          {run.pullRequestUrl && (
            <a
              href={run.pullRequestUrl}
              target="_blank"
              rel="noreferrer"
              className="text-xs text-muted underline decoration-rule underline-offset-4 hover:text-accent hover:decoration-accent"
            >
              Pull request ↗
            </a>
          )}
          <Link
            href="/dashboard/activity"
            className="text-xs text-muted underline decoration-rule underline-offset-4 hover:text-accent hover:decoration-accent"
          >
            All runs
          </Link>
        </div>
      </PageHead>

      {/*
        A Coordinator rejection is the system working, not a crash, so it is
        styled as a decision. Everything else that sets `error` is a failure.
      */}
      {run.error && (
        <div
          role="alert"
          className={`border px-4 py-3 text-sm leading-relaxed ${
            run.status === "denied" || run.error.startsWith("Coordinator rejected")
              ? "border-amber-500/30 bg-amber-500/5 text-amber-200"
              : "border-red-500/30 bg-red-500/5 text-red-200"
          }`}
        >
          {run.error}
        </div>
      )}

      <section aria-labelledby="run-waterfall" className="space-y-3">
        <h2 id="run-waterfall" className="text-lg font-semibold tracking-tight">
          Roles
        </h2>
        <Waterfall traces={run.traces} />
      </section>

      <section aria-labelledby="run-tokens" className="space-y-3">
        <h2 id="run-tokens" className="text-lg font-semibold tracking-tight">
          Tokens
        </h2>
        <TokenBreakdown totals={run.totals} traces={run.traces} />
      </section>

      {run.validation && (
        <section aria-labelledby="run-validation" className="space-y-3">
          <h2 id="run-validation" className="text-lg font-semibold tracking-tight">
            Validation
          </h2>
          <ul className="border border-rule divide-y divide-rule bg-surface">
            {run.validation.checks.map((check) => (
              <li key={check.name} className="flex gap-3 px-4 py-2.5 text-xs">
                <span
                  className={`w-14 shrink-0 font-medium ${
                    check.status === "pass"
                      ? "text-emerald-300"
                      : check.status === "fail"
                        ? "text-red-300"
                        : "text-muted"
                  }`}
                >
                  {check.status}
                </span>
                <span className="w-40 shrink-0 font-mono">{check.name}</span>
                {/* `anchor-not-found` names the anchor that missed, which is the
                    most actionable message the pipeline produces — so the detail
                    is shown verbatim rather than summarised. */}
                <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-muted">
                  {check.detail}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {run.approval && (
        <section aria-labelledby="run-approval" className="space-y-3">
          <h2 id="run-approval" className="text-lg font-semibold tracking-tight">
            Approval
          </h2>
          <div className="border border-rule bg-surface p-4 text-sm">
            <p className="leading-relaxed">{run.approval.summary}</p>
            <p className="mt-3 text-xs leading-relaxed text-muted">
              {run.approval.scopeRationale}
            </p>
            <p className="mt-3 text-xs text-muted">
              {run.approval.signoffs.length} of {run.approval.requiredSignoffs} sign-off
              {run.approval.requiredSignoffs === 1 ? "" : "s"}
              {run.approval.signoffs.length > 0 &&
                ` — ${run.approval.signoffs.map((s) => s.by).join(", ")}`}
            </p>
          </div>
        </section>
      )}

      <section aria-labelledby="run-roles" className="space-y-3">
        <h2 id="run-roles" className="text-lg font-semibold tracking-tight">
          Role detail
        </h2>
        <RoleInspector traces={run.traces} parsed={parsed} />
      </section>

      <p className="text-xs text-muted">
        Memory: {run.priorSymbolCount} symbol{run.priorSymbolCount === 1 ? "" : "s"} carried in,{" "}
        {run.newSymbolCount} learned.
      </p>
    </Page>
  );
}
