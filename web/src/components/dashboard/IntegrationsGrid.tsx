import { LuCircleCheck, LuCircleDashed, LuExternalLink } from "react-icons/lu";
import type { Integration } from "@/lib/docxy";
import { integrationIcons } from "@/components/icons";
import { site } from "@/lib/site";

/**
 * One card per integration, straight off `GET /api/integrations`. Nothing here
 * is a client control: connecting docxy to a service means setting variables on
 * the server, so a card's job is to say what the integration does, whether it
 * answered, and — when it did not — exactly which variables are missing.
 */

const CATEGORY_LABELS: Record<Integration["category"], string> = {
  harness: "Harness",
  models: "Models",
  storage: "Storage",
  source: "Source",
};

/** Repo-relative doc paths from the API, resolved against the public repo. */
function docsUrl(path: string): string {
  return `${site.repo}/blob/main/${path}`;
}

function StatusBadge({ integration }: { integration: Integration }) {
  const { connected, required } = integration;

  const tone = connected
    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
    : required
      ? "border-amber-500/30 bg-amber-500/10 text-amber-300"
      : "border-rule bg-surface-2 text-muted";

  const label = connected ? "Connected" : required ? "Action needed" : "Not connected";

  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 border px-1.5 py-0.5 text-[10px] font-semibold ${tone}`}
    >
      <span aria-hidden className="[&>svg]:h-3 [&>svg]:w-3">
        {connected ? <LuCircleCheck /> : <LuCircleDashed />}
      </span>
      {label}
    </span>
  );
}

function IntegrationCard({ integration }: { integration: Integration }) {
  const { id, name, category, summary, detail, missing, docs, connected, required } = integration;

  return (
    <article className="flex flex-col gap-3 bg-surface p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0">
          <span
            aria-hidden
            className="flex h-9 w-9 shrink-0 items-center justify-center border border-rule bg-surface-2"
          >
            {integrationIcons[id] ?? integrationIcons.plug}
          </span>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold tracking-tight truncate">{name}</h3>
            <p className="text-[10px] font-semibold tracking-[0.08em] uppercase text-muted">
              {CATEGORY_LABELS[category]}
              {required && <span className="text-amber-300/80"> · Required</span>}
            </p>
          </div>
        </div>
        <StatusBadge integration={integration} />
      </div>

      <p className="text-xs leading-relaxed text-muted">{summary}</p>

      <p className="font-mono text-[11px] text-foreground/80 break-all" title={detail}>
        {detail}
      </p>

      {!connected && missing.length > 0 && (
        <div className="border-t border-rule pt-3">
          <p className="text-[10px] font-semibold tracking-[0.08em] uppercase text-muted mb-1.5">
            To connect
          </p>
          <ul className="flex flex-wrap gap-1.5">
            {missing.map((item) => (
              <li
                key={item}
                className="border border-rule bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-foreground/80"
              >
                {item}
              </li>
            ))}
          </ul>
        </div>
      )}

      <a
        href={docsUrl(docs)}
        target="_blank"
        rel="noreferrer"
        className="mt-auto inline-flex items-center gap-1.5 pt-1 text-xs text-muted underline decoration-rule underline-offset-4 hover:text-accent hover:decoration-accent"
      >
        How it works
        <span aria-hidden className="[&>svg]:h-3 [&>svg]:w-3">
          <LuExternalLink />
        </span>
      </a>
    </article>
  );
}

export function IntegrationsGrid({ integrations }: { integrations: Integration[] }) {
  if (integrations.length === 0) {
    return (
      <p className="border border-rule bg-surface px-4 py-3 text-sm text-muted">
        The pipeline reported no integrations.
      </p>
    );
  }

  /* Hairline-gapped cells: the 1px gutters on the rule colour read as rules. */
  return (
    <div className="grid grid-cols-1 gap-px border border-rule bg-rule sm:grid-cols-2 lg:grid-cols-3">
      {integrations.map((integration) => (
        <IntegrationCard key={integration.id} integration={integration} />
      ))}
    </div>
  );
}
