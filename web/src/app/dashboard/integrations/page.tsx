import Link from "next/link";
import { LuArrowRight, LuClock, LuGitBranch, LuPlug } from "react-icons/lu";

import { fetchConfig, fetchIntegrations, fetchRepositories, fetchTracking } from "@/lib/docxy";
import { activeOrganizationId } from "@/lib/organization";
import { Page, PageHead } from "@/components/dashboard/Page";
import { IntegrationsGrid } from "@/components/dashboard/IntegrationsGrid";
import { ServiceStatus } from "@/components/dashboard/ServiceStatus";
import { SyncedPanel } from "@/components/dashboard/SyncedPanel";
import { TrackingPanel } from "@/components/dashboard/TrackingPanel";
import { CATALOG } from "@/lib/integrations";
import { site } from "@/lib/site";

export const dynamic = "force-dynamic";

export default async function IntegrationsPage() {
  const organizationId = await activeOrganizationId();
  const [result, config, tracking, repositories] = await Promise.all([
    fetchIntegrations(),
    fetchConfig(),
    fetchTracking(),
    fetchRepositories(organizationId),
  ]);

  const app = result?.integrations.find((item) => item.id === "github-app");
  const live = {
    github: {
      connected: app?.connected ?? false,
      detail: app?.connected ? app.detail : undefined,
      href: "/api/github/install",
    },
  };

  const soon = CATALOG.filter((entry) => entry.status === "soon").length;
  const reachable = repositories?.repositories.length ?? 0;
  const watched = repositories?.repositories.filter((repo) => repo.allowed).length ?? 0;

  return (
    <Page>
      <PageHead
        title="Integrations"
        lede="Connect services, manage repository access, and check connection status."
      />

      <section aria-labelledby="integration-shortcuts" className="space-y-3">
        <h2 id="integration-shortcuts" className="sr-only">
          Things you can change
        </h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <Shortcut
            href="/dashboard/repositories"
            icon={<LuGitBranch aria-hidden />}
            title="Repository access"
            body={
              repositories
                ? `${watched} of ${reachable} ${reachable === 1 ? "repository is" : "repositories are"} connected to a project. The rest are reachable but unwatched.`
                : "See every repository the GitHub App can reach, and which of them are watched."
            }
          />
        </div>
      </section>

      <section aria-labelledby="integration-services" className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3 border-b border-rule pb-3">
          <div>
            <h2 id="integration-services" className="text-lg font-semibold">
              Services
            </h2>
            <p className="mt-1 text-sm text-muted">
              Where docxy sends its work. Connect one once and every run uses it.
            </p>
          </div>
          <p className="text-xs text-muted">
            <span className="text-foreground">1</span> available · {soon} on the way
          </p>
        </div>

        {/* The honest headline: one of these works today. */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border border-accent/30 bg-accent/5 px-4 py-3">
          <span className="inline-flex items-center gap-1.5 border border-accent/40 bg-accent/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-accent">
            <span aria-hidden className="[&>svg]:h-3 [&>svg]:w-3">
              <LuClock />
            </span>
            Coming soon
          </span>
          <p className="text-sm leading-relaxed text-muted">
            GitHub is available now. The other integrations below are planned.
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

        {result && result.integrations.length > 0 && (
          <ServiceStatus integrations={result.integrations} />
        )}
      </section>

      <section id="pipeline" aria-labelledby="integration-pipeline" className="space-y-3">
        <div className="border-b border-rule pb-3">
          <h2 id="integration-pipeline" className="text-lg font-semibold">
            Pipeline
          </h2>
          {/* Said plainly, because it is the thing that made Tracking confusing
              as its own page: none of this belongs to one organization. It
              describes the deployment every organization here shares. */}
          <p className="mt-1 text-sm text-muted">
            How this deployment is built, and what it has learned. These settings belong to the
            installation rather than to your organization, so everyone here sees the same values.
          </p>
        </div>
        <SyncedPanel config={config} docsBranch={tracking?.docsBranch} />
        <TrackingPanel tracking={tracking} expanded />
      </section>
    </Page>
  );
}

function Shortcut({
  href,
  icon,
  title,
  body,
}: {
  href: string;
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <Link
      href={href}
      className="focus-ring group flex flex-col gap-3 border border-rule bg-surface p-5 transition-colors hover:border-accent/50"
    >
      <span className="text-accent [&>svg]:h-5 [&>svg]:w-5">{icon}</span>
      <div>
        <h3 className="flex items-center gap-2 text-sm font-semibold tracking-tight">
          {title}
          <LuArrowRight size={14} aria-hidden className="text-accent" />
        </h3>
        <p className="mt-1.5 text-xs leading-relaxed text-muted">{body}</p>
      </div>
    </Link>
  );
}
