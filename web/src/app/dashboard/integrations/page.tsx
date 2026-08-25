import { LuPlug } from "react-icons/lu";
import { fetchIntegrations } from "@/lib/docxy";
import { Page, PageHead } from "@/components/dashboard/Page";
import { IntegrationsGrid } from "@/components/dashboard/IntegrationsGrid";
import { site } from "@/lib/site";

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
        lede="Everything docxy talks to, whether it is wired up, and what each missing piece needs. Status is read live from the pipeline, so a card that says connected has answered."
      >
        {online && (
          <p className="text-xs text-muted tabular-nums">
            <span className="text-foreground">{connected}</span> of {integrations.length} connected
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

      <IntegrationsGrid integrations={integrations} />

      {/*
        Connecting is a server-side act — env vars, then a restart — so the page
        closes by saying so rather than offering a button that cannot do it.
      */}
      <section
        aria-labelledby="integrations-how"
        className="flex flex-col gap-4 border border-rule bg-surface px-5 py-4 sm:flex-row sm:items-center sm:justify-between"
      >
        <div className="flex items-start gap-3">
          <span aria-hidden className="mt-0.5 text-accent [&>svg]:h-5 [&>svg]:w-5">
            <LuPlug />
          </span>
          <div>
            <h2 id="integrations-how" className="text-sm font-semibold tracking-tight">
              How connecting works
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-muted">
              Every integration is wired up with environment variables on the machine running the
              pipeline, not from this page. Set the variables a card lists, restart the server, and
              the status here follows. Missing something you need?
            </p>
          </div>
        </div>
        <a
          href={`${site.repo}/issues/new`}
          target="_blank"
          rel="noreferrer"
          className="shrink-0 self-start border border-rule bg-surface-2 px-3 py-1.5 text-xs font-medium transition-colors hover:border-accent hover:text-accent sm:self-auto"
        >
          Request an integration
        </a>
      </section>
    </Page>
  );
}
