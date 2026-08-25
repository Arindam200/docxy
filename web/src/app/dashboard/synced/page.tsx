import { fetchConfig, fetchRuns } from "@/lib/docxy";
import { Page, PageHead } from "@/components/dashboard/Page";
import { SyncedPanel } from "@/components/dashboard/SyncedPanel";

export const dynamic = "force-dynamic";

export default async function SyncedPage() {
  const [runs, config] = await Promise.all([fetchRuns(), fetchConfig()]);
  const online = runs !== null;
  const lastRun = (runs ?? []).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];

  return (
    <Page>
      <PageHead
        title="Synced"
        lede="The repository this pipeline documents and where the machinery lives."
      >
        <span className={`inline-flex items-center gap-1.5 text-xs ${online ? "text-emerald-300" : "text-red-300"}`}>
          <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${online ? "bg-emerald-400" : "bg-red-400"}`} />
          {online ? "API connected" : "API offline"}
        </span>
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

      <div className="max-w-xl">
        <SyncedPanel config={config} lastRunAt={lastRun?.startedAt} online={online} />
      </div>
    </Page>
  );
}
