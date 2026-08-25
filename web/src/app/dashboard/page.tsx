import { fetchConfig, fetchRuns, fetchTracking } from "@/lib/docxy";
import { Page, PageHead } from "@/components/dashboard/Page";
import { StatCard } from "@/components/dashboard/StatCard";
import { RunTimeline } from "@/components/dashboard/RunTimeline";

export const dynamic = "force-dynamic";

function timeAgo(iso?: string): string {
  if (!iso) return "—";
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export default async function OverviewPage() {
  const [runs, config, tracking] = await Promise.all([fetchRuns(), fetchConfig(), fetchTracking()]);

  const online = runs !== null;
  const list = runs ?? [];
  const count = (status: string): number => list.filter((r) => r.status === status).length;
  const lastRun = [...list].sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];

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
        <StatCard label="PRs opened" value={list.filter((r) => r.pullRequestUrl).length} hint={`${count("denied")} denied`} />
        <StatCard label="Symbols mapped" value={tracking?.symbolCount ?? 0} hint={`${tracking?.processedCommits ?? 0} commits processed`} />
      </div>

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
