import {
  fetchConfig,
  fetchIntegrations,
  fetchRepositories,
  fetchRuns,
  fetchTracking,
} from "@/lib/docxy";
import { Page, PageHead } from "@/components/dashboard/Page";
import { SyncedPanel } from "@/components/dashboard/SyncedPanel";
import { SyncedRepos } from "@/components/dashboard/SyncedRepos";
import { ServiceStatus } from "@/components/dashboard/ServiceStatus";

export const dynamic = "force-dynamic";

export default async function SyncedPage() {
  const [runs, config, tracking, services, repositories] = await Promise.all([
    fetchRuns(),
    fetchConfig(),
    fetchTracking(),
    fetchIntegrations(),
    fetchRepositories(),
  ]);

  const online = runs !== null;
  const list = runs ?? [];
  const lastRun = [...list].sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];

  return (
    <Page>
      <PageHead
        title="Synced"
        lede="The repositories the GitHub App is installed on, and the machinery behind them."
      >
        <span
          className={`inline-flex items-center gap-1.5 text-xs ${online ? "text-ok" : "text-danger"}`}
        >
          <span
            aria-hidden
            className={`h-1.5 w-1.5 rounded-full ${online ? "bg-ok" : "bg-danger"}`}
          />
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

      <SyncedRepos page={repositories} />

      <SyncedPanel config={config} docsBranch={tracking?.docsBranch} />

      {services && services.integrations.length > 0 && (
        <ServiceStatus integrations={services.integrations} />
      )}
    </Page>
  );
}
