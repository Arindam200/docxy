import { LuCircleCheck, LuCircleDashed, LuClock } from "react-icons/lu";

import { catalogIcons, integrationIcons } from "@/components/icons";
import type { CatalogEntry } from "@/lib/integrations";
import { lookup } from "@/lib/lookup";

/**
 * One integration in the catalogue.
 *
 * A card can be in three states and each gets a different action: connected,
 * connectable (only GitHub today), or ahead of us. The last one renders its
 * button disabled rather than hiding it, so the row of cards keeps its rhythm
 * and the reader can see what is planned without being invited to click it.
 */

export function IntegrationCard({
  entry,
  connected,
  detail,
  href,
}: {
  entry: CatalogEntry;
  /** Live entries only: what the pipeline reports right now. */
  connected?: boolean;
  /** A short live fact — the bot's name, the endpoint — under the summary. */
  detail?: string;
  href?: string;
}) {
  const soon = entry.status === "soon";
  const icon = lookup(catalogIcons, entry.id) ?? integrationIcons.plug;

  const badge = soon
    ? { label: "Coming soon", tone: "border-rule bg-surface-2 text-muted", icon: <LuClock /> }
    : connected
      ? {
          label: "Connected",
          tone: "border-ok/30 bg-ok/10 text-ok",
          icon: <LuCircleCheck />,
        }
      : {
          label: "Not connected",
          tone: "border-rule bg-surface-2 text-muted",
          icon: <LuCircleDashed />,
        };

  return (
    <article className="flex flex-col gap-3 bg-surface p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span
            aria-hidden
            className={`flex h-10 w-10 shrink-0 items-center justify-center border border-rule bg-surface-2 ${
              soon ? "opacity-60" : ""
            }`}
          >
            {icon}
          </span>
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold tracking-tight">{entry.name}</h3>
            <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted">
              {entry.category}
            </p>
          </div>
        </div>

        <span
          className={`inline-flex shrink-0 items-center gap-1.5 border px-1.5 py-0.5 text-[10px] font-semibold ${badge.tone}`}
        >
          <span aria-hidden className="[&>svg]:h-3 [&>svg]:w-3">
            {badge.icon}
          </span>
          {badge.label}
        </span>
      </div>

      <p className="text-xs leading-relaxed text-muted">{entry.summary}</p>

      {detail && (
        <p className="truncate font-mono text-[11px] text-foreground/80" title={detail}>
          {detail}
        </p>
      )}

      <div className="mt-auto pt-1">
        {soon ? (
          <button
            type="button"
            disabled
            title="Not available yet."
            className="w-full cursor-not-allowed border border-rule bg-surface-2 px-3 py-1.5 text-xs font-medium text-muted opacity-60"
          >
            {entry.action}
          </button>
        ) : (
          <a
            href={href ?? entry.href}
            target="_blank"
            rel="noreferrer"
            className="block w-full border border-transparent bg-accent px-3 py-1.5 text-center text-xs font-medium text-white transition-colors hover:bg-accent-deep"
          >
            {connected ? "Manage installation" : entry.action}
          </a>
        )}
      </div>
    </article>
  );
}
