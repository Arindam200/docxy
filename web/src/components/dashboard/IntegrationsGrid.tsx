import type { Integration } from "@/lib/docxy";
import { IntegrationCard } from "@/components/dashboard/IntegrationCard";

/**
 * The cards as one hairline-gapped field: the 1px gutters sit on the rule
 * colour, so the grid reads as ruled cells rather than floating boxes — the
 * same idiom the landing page uses for its integration tiles.
 */
export function IntegrationsGrid({ integrations }: { integrations: Integration[] }) {
  if (integrations.length === 0) {
    return (
      <div className="border border-dashed border-rule px-6 py-12 text-center">
        <p className="text-sm text-muted">No integrations reported.</p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-px border border-rule bg-rule sm:grid-cols-2 lg:grid-cols-3">
      {integrations.map((integration) => (
        <IntegrationCard key={integration.id} integration={integration} />
      ))}
    </div>
  );
}
