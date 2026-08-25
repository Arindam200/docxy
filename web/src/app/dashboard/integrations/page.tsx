import { fetchIntegrations } from "@/lib/docxy";
import { Page, PageHead } from "@/components/dashboard/Page";
import { IntegrationCard } from "@/components/dashboard/IntegrationCard";

export const dynamic = "force-dynamic";

export default async function IntegrationsPage() {
  const result = await fetchIntegrations();

  const online = result !== null;
  const integrations = result?.integrations ?? [];
  const connected = integrations.filter((item) => item.connected).length;
  const blocking = integrations.filter((item) => item.required && !item.connected);

  return (
    <Page>
      <PageHead
        title="Integrations"
        lede="Everything docxy talks to, whether it is wired up, and what each missing piece needs."
      >
        {online && (
          <p className="text-xs text-muted tabular-nums">
            {connected} of {integrations.length} connected
          </p>
        )}
      </PageHead>

      {!online && (
        <div
          role="alert"
          className="border border-rule bg-surface px-4 py-3 text-sm leading-relaxed text-muted"
        >
          The docxy API is unreachable, so nothing here can be checked. Start it with{" "}
          <code className="font-mono text-foreground">npm run serve</code> and refresh.
        </div>
      )}

      {blocking.length > 0 && (
        <div
          role="alert"
          className="border border-red-500/30 bg-red-500/5 px-4 py-3 text-sm leading-relaxed text-red-200"
        >
          {blocking.map((item) => item.name).join(" and ")}{" "}
          {blocking.length === 1 ? "is" : "are"} required and not connected. The pipeline cannot
          complete a run until {blocking.length === 1 ? "it is" : "they are"} set up.
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        {integrations.map((integration) => (
          <IntegrationCard key={integration.id} integration={integration} />
        ))}
      </div>

      {online && integrations.length === 0 && (
        <div className="border border-dashed border-rule px-6 py-12 text-center">
          <p className="text-sm text-muted">No integrations reported.</p>
        </div>
      )}
    </Page>
  );
}
