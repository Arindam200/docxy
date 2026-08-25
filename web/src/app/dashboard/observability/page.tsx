import { fetchObservability } from "@/lib/docxy";
import { Page, PageHead } from "@/components/dashboard/Page";
import { StatCard } from "@/components/dashboard/StatCard";
import { RoleReliability } from "@/components/dashboard/RoleReliability";
import { RunTrend } from "@/components/dashboard/RunTrend";
import { SpendPanel } from "@/components/dashboard/SpendPanel";
import { duration, timeAgo } from "@/lib/format";

export const dynamic = "force-dynamic";

function usd(value: number | undefined): string {
  if (value === undefined) return "—";
  return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

export default async function ObservabilityPage() {
  const report = await fetchObservability();

  const online = report !== null;
  const window = report?.window.runs ?? 0;
  const failed = report?.outcomes.failed ?? 0;
  const worstRole = [...(report?.roles ?? [])].sort((a, b) => b.failed - a.failed)[0];

  return (
    <Page>
      <PageHead
        title="Observability"
        lede="Across runs rather than within one: which role fails, what a run costs, and which docs keep going stale."
      >
        {online && report.window.from && (
          <p className="text-xs text-muted">
            {window} run{window === 1 ? "" : "s"} · since{" "}
            <span className="text-foreground">{timeAgo(report.window.from)}</span>
          </p>
        )}
      </PageHead>

      {!online && (
        <div
          role="alert"
          className="border border-rule bg-surface px-4 py-3 text-sm leading-relaxed text-muted"
        >
          The docxy API is unreachable right now, so nothing can be aggregated. Start it with{" "}
          <code className="font-mono text-foreground">npm run serve</code> and refresh.
        </div>
      )}

      {online && window === 0 && (
        <div className="border border-dashed border-rule px-6 py-12 text-center">
          <p className="text-sm text-muted">
            No runs recorded yet. This page fills in from the first one.
          </p>
        </div>
      )}

      {online && window > 0 && (
        <>
          <div className="grid grid-cols-2 divide-x divide-y divide-rule border border-rule bg-surface md:grid-cols-4 md:divide-y-0">
            <StatCard
              label="Success rate"
              value={
                report.successRate === undefined
                  ? "—"
                  : `${Math.round(report.successRate * 100)}%`
              }
              hint={`${failed} failed of ${window}`}
              accent={report.successRate !== undefined && report.successRate < 0.8}
            />
            <StatCard
              label="Median run"
              value={duration(report.totals.medianRunMs)}
              hint="wall clock, start to finish"
            />
            <StatCard
              label="Spend"
              value={usd(report.totals.costUsd)}
              hint={
                report.totals.costPerRunUsd === undefined
                  ? "no model rates available"
                  : `${usd(report.totals.costPerRunUsd)} per run`
              }
            />
            <StatCard
              label="Least reliable"
              value={
                worstRole && worstRole.failed > 0
                  ? `${worstRole.failed}×`
                  : "None"
              }
              hint={
                worstRole && worstRole.failed > 0
                  ? `${worstRole.role} failed most`
                  : "every role finished"
              }
              accent={Boolean(worstRole && worstRole.failed > 0)}
            />
          </div>

          {/*
            Records written before durations were captured have none, and a
            chart of zeroes says nothing — fall back to the axis that has data.
          */}
          <RunTrend
            series={report.series}
            metric={
              report.series.some((run) => run.durationMs !== undefined) ? "duration" : "tokens"
            }
          />

          <RoleReliability roles={report.roles} />

          <div className="grid gap-6 lg:grid-cols-2">
            <SpendPanel breakdown={report.inputBreakdown} />

            <section aria-labelledby="stale-docs" className="border border-rule bg-surface">
              <div className="border-b border-rule px-4 py-3">
                <h2
                  id="stale-docs"
                  className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted"
                >
                  Goes stale most often
                </h2>
              </div>
              {report.staleDocs.length === 0 ? (
                <p className="px-4 py-6 text-xs leading-relaxed text-muted">
                  No doc edits proposed in this window.
                </p>
              ) : (
                <ul className="divide-y divide-rule">
                  {report.staleDocs.map((doc) => (
                    <li
                      key={doc.path}
                      className="flex items-baseline justify-between gap-4 px-4 py-2.5"
                    >
                      <span className="truncate font-mono text-xs" title={doc.path}>
                        {doc.path}
                      </span>
                      <span className="shrink-0 text-xs tabular-nums text-muted">
                        {doc.runs} run{doc.runs === 1 ? "" : "s"} · {doc.edits} edit
                        {doc.edits === 1 ? "" : "s"}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </>
      )}
    </Page>
  );
}
