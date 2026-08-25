import { fetchConfig, fetchIntegrations, fetchRuns, fetchTracking } from "@/lib/docxy";
import { timeAgo, tokens } from "@/lib/format";
import { Page, PageHead } from "@/components/dashboard/Page";
import { StatCard } from "@/components/dashboard/StatCard";
import { RunTimeline } from "@/components/dashboard/RunTimeline";

export const dynamic = "force-dynamic";

export default async function OverviewPage() {
  const [runs, config, tracking, integrations] = await Promise.all([
    fetchRuns(),
    fetchConfig(),
    fetchTracking(),
    fetchIntegrations(),
  ]);

  const online = runs !== null;
  const list = runs ?? [];
  const count = (status: string): number => list.filter((r) => r.status === status).length;
  const lastRun = [...list].sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  const spent = list.reduce(
    (total, run) => total + (run.totals?.inputTokens ?? 0) + (run.totals?.outputTokens ?? 0),
    0,
  );
  const blocking = (integrations?.integrations ?? []).filter(
    (item) => item.required && !item.connected,
  );

  return (
    <Page>
      <PageHead
        title="Overview"
        lede={
          <>
            {config ? (
              <code className="font-mono text-xs">{config.repoPath.split("/").slice(-2).join("/")}</code>
            ) : (
              "pipeline"
            )}
            <span aria-hidden> · </span>
            <span className={`inline-flex items-center gap-1.5 ${online ? "text-emerald-300" : "text-red-300"}`}>
              <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${online ? "bg-emerald-400" : "bg-red-400"}`} />
              {online ? "API connected" : "API offline"}
            </span>
          </>
        }
      >
        {lastRun && (
          <p className="text-xs text-muted">
            Last run <span className="text-foreground">{timeAgo(lastRun.startedAt)}</span>
          </p>
        )}
      </PageHead>

      {!online && (
        <div
          role="alert"
          className="border border-rule bg-surface px-4 py-3 text-sm leading-relaxed text-muted"
        >
          The docxy API is unreachable right now. Start it with{" "}
          <code className="font-mono text-foreground">npm run serve</code> and refresh.
        </div>
      )}

      {/* Stats strip — one bordered grid, hairline-divided cells */}
      <div className="grid grid-cols-2 md:grid-cols-4 border border-rule divide-x divide-y md:divide-y-0 divide-rule bg-surface">
        <StatCard label="Total runs" value={list.length} hint={lastRun ? `Last ${timeAgo(lastRun.startedAt)}` : "No runs yet"} />
        <StatCard label="Awaiting approval" value={count("awaiting-approval")} hint={count("running") > 0 ? `${count("running")} running now` : "Nothing blocked"} accent={count("awaiting-approval") > 0} />
        <StatCard
          label="Tokens used"
          value={tokens(spent)}
          hint={`across ${list.length} run${list.length === 1 ? "" : "s"}`}
        />
        <StatCard label="Symbols mapped" value={tracking?.symbolCount ?? 0} hint={`${tracking?.processedCommits ?? 0} commits processed`} />
      </div>

      {blocking.length > 0 && (
        <div
          role="alert"
          className="border border-red-500/30 bg-red-500/5 px-4 py-3 text-sm leading-relaxed text-red-200"
        >
          {blocking.map((item) => item.name).join(" and ")}{" "}
          {blocking.length === 1 ? "is" : "are"} not connected, so runs cannot complete.{" "}
          <a href="/dashboard/integrations" className="underline underline-offset-4">
            Set up integrations
          </a>
        </div>
      )}

      <section aria-labelledby="overview-recent" className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 id="overview-recent" className="text-lg font-semibold tracking-tight">
            Latest activity
          </h2>
          <a href="/dashboard/activity" className="text-xs text-muted underline decoration-rule underline-offset-4 hover:text-accent hover:decoration-accent">
            View all
          </a>
        </div>
        <RunTimeline runs={list.slice(0, 5)} />
      </section>
    </Page>
  );
}
