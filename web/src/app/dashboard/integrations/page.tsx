import { LuPlug } from "react-icons/lu";
import { headers } from "next/headers";
import type { ReactNode } from "react";

import { fetchIntegrations } from "@/lib/docxy";
import { InfoTip } from "@/components/dashboard/InfoTip";
import { Page, PageHead } from "@/components/dashboard/Page";
import { IntegrationsGrid } from "@/components/dashboard/IntegrationsGrid";
import { CATALOG, type IntegrationConnections } from "@/lib/integrations";
import { site } from "@/lib/site";
import { composioConfigured, listComposioAccounts } from "@/lib/composio";
import { integrationScope } from "@/lib/integration-scope";
import { COMPOSIO_TOOLKITS, isComposioToolkit, type IntegrationAccount } from "@/lib/composio-contract";
import { ComposioConnection } from "@/components/dashboard/ComposioConnection";

export const dynamic = "force-dynamic";

export default async function IntegrationsPage() {
  const configured = composioConfigured();
  const scope = await integrationScope(await headers());
  let accounts: IntegrationAccount[] = [];
  let unavailable = false;
  if (configured && scope) {
    try {
      accounts = await listComposioAccounts(scope.organizationId);
    } catch {
      unavailable = true;
    }
  }
  const result = await fetchIntegrations();

  const app = result?.integrations.find((item) => item.id === "github-app");
  const live: IntegrationConnections = {
    github: {
      connected: app?.connected ?? false,
      detail: app?.connected ? app.detail : undefined,
      href: "/api/github/install",
    },
  };

  const entries = CATALOG.map((entry) => isComposioToolkit(entry.id) ? {
    ...entry,
    status: "live" as const,
    summary: `Connect your ${entry.name} account to this organization.`,
    note: "Account connection only. Automated workflows are coming soon.",
  } : entry);
  const controls: Partial<Record<string, ReactNode>> = {};
  for (const toolkit of COMPOSIO_TOOLKITS) {
    const toolkitAccounts = accounts.filter((account) => account.toolkit === toolkit);
    live[toolkit] = { connected: toolkitAccounts.some((account) => account.active), unavailable: unavailable || !configured || !scope };
    controls[toolkit] = <ComposioConnection
      key={`${scope?.organizationId ?? "demo"}:${toolkit}`}
      toolkit={toolkit} organizationId={scope?.organizationId ?? ""} accounts={toolkitAccounts}
      canManage={scope?.canManage ?? false} configured={configured} unavailable={unavailable}
    />;
  }
  const soon = entries.filter((entry) => entry.status === "soon").length;

  return (
    <Page>
      <PageHead
        title="Integrations"
        lede="Connect your tools and manage your organization’s services."
      >
        <div className="flex shrink-0 items-center gap-2 text-xs text-muted">
          <span><span className="text-foreground">{configured && scope ? 5 : 1}</span> available · {soon} planned</span>
          <InfoTip label="About integration availability">
            GitHub powers documentation runs. Slack, Notion, Linear, and Jira support account connections; their automated workflows are coming soon.
          </InfoTip>
        </div>
      </PageHead>

      <section aria-label="Available and planned integrations">
        <IntegrationsGrid entries={entries} live={live} controls={controls}>
          {/* The last cell rather than a banner below: it fills the short final
              row, and asking for one belongs among the ones you can pick. */}
          <section
            aria-labelledby="integrations-request"
            className="flex flex-col justify-center gap-3 bg-surface p-5"
          >
            <span aria-hidden className="text-accent [&>svg]:h-5 [&>svg]:w-5">
              <LuPlug />
            </span>
            <div>
              <h2 id="integrations-request" className="text-sm font-semibold tracking-tight">
                Need one that is not here?
              </h2>
              <p className="mt-1.5 text-xs leading-relaxed text-muted">
                The order these ship in follows what people ask for. Tell us what your team
                would connect docxy to, and it moves up the list.
              </p>
            </div>
            <a
              href={`${site.repo}/issues/new`}
              target="_blank"
              rel="noreferrer"
              className="mt-auto border border-rule bg-surface-2 px-3 py-1.5 text-center text-xs font-medium transition-colors hover:border-accent hover:text-accent"
            >
              Request an integration
            </a>
          </section>
        </IntegrationsGrid>
      </section>
    </Page>
  );
}
