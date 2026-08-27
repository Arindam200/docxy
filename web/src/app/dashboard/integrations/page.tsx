import { LuClock, LuPlug } from "react-icons/lu";

import { fetchIntegrations } from "@/lib/docxy";
import { Page, PageHead } from "@/components/dashboard/Page";
import { IntegrationsGrid } from "@/components/dashboard/IntegrationsGrid";
import { CATALOG } from "@/lib/integrations";
import { site } from "@/lib/site";

export const dynamic = "force-dynamic";

export default async function IntegrationsPage() {
  // The catalogue is static; only GitHub has a live status to report, and it
  // comes from the App the pipeline actually publishes as.
  const result = await fetchIntegrations();
  const app = result?.integrations.find((item) => item.id === "github-app");

  const live = app
    ? {
        github: {
          connected: app.connected,
          detail: app.connected ? app.detail : undefined,
          href: site.install,
        },
      }
    : undefined;

  const soon = CATALOG.filter((entry) => entry.status === "soon").length;

  return (
    <Page>
      <PageHead
        title="Integrations"
        lede="Where docxy can send its work, and what it can watch. Connect a service once and every run uses it."
      >
        <p className="text-xs text-muted">
          <span className="text-foreground">1</span> available · {soon} on the way
        </p>
      </PageHead>

      {/* The honest headline: one of these works today. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border border-accent/30 bg-accent/5 px-4 py-3">
        <span className="inline-flex items-center gap-1.5 border border-accent/40 bg-accent/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-accent">
          <span aria-hidden className="[&>svg]:h-3 [&>svg]:w-3">
            <LuClock />
          </span>
          Coming soon
        </span>
        <p className="text-sm leading-relaxed text-muted">
          GitHub is live today. The rest are being built — the cards below are what is planned, not
          what is wired up.
        </p>
      </div>

      <IntegrationsGrid entries={CATALOG} live={live}>
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
              The order these ship in follows what people ask for. Tell us what your team would
              connect docxy to, and it moves up the list.
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

    </Page>
  );
}
