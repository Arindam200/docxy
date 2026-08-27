import type { ReactNode } from "react";

import { IntegrationCard } from "@/components/dashboard/IntegrationCard";
import type { CatalogEntry } from "@/lib/integrations";

/**
 * The catalogue as one hairline-gapped field: the 1px gutters sit on the rule
 * colour, so the grid reads as ruled cells rather than floating boxes — the
 * same idiom the landing page uses for its integration tiles.
 */
export function IntegrationsGrid({
  entries,
  live,
  children,
}: {
  entries: CatalogEntry[];
  /** Live status for the entries that have any, keyed by catalogue id. */
  live?: Record<string, { connected: boolean; detail?: string; href?: string }>;
  /** Rendered as the last cell, so a short final row is filled rather than bare. */
  children?: ReactNode;
}) {
  return (
    <div className="grid grid-cols-1 gap-px border border-rule bg-rule sm:grid-cols-2 lg:grid-cols-3">
      {entries.map((entry) => (
        <IntegrationCard
          key={entry.id}
          entry={entry}
          connected={live?.[entry.id]?.connected}
          detail={live?.[entry.id]?.detail}
          href={live?.[entry.id]?.href}
        />
      ))}
      {children}
    </div>
  );
}
