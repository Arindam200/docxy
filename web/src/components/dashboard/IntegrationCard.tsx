import { LuCircleCheck, LuCircleDashed, LuExternalLink } from "react-icons/lu";
import type { Integration } from "@/lib/docxy";
import { integrationIcons } from "@/components/icons";
import { site } from "@/lib/site";

/**
 * One integration, and — when it is not connected — exactly what would connect
 * it. A card that only said "not connected" would send the reader to the docs
 * to find out which variable is missing, which is the thing this already knows.
 */

const CATEGORY_LABEL: Record<Integration["category"], string> = {
  harness: "Harness",
  models: "Models",
  storage: "Storage",
  source: "Source control",
};

/** Repo-relative doc paths from the API, resolved against the public repo. */
function docsUrl(path: string): string {
  return `${site.repo}/blob/main/${path}`;
}

function StatusBadge({ connected, required }: { connected: boolean; required: boolean }) {
  // Not connected is only a problem when the integration is required; the rest
  // are genuinely optional and should not read as broken.
  const tone = connected
    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
    : required
      ? "border-red-500/30 bg-red-500/10 text-red-300"
      : "border-rule bg-surface-2 text-muted";

  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 border px-1.5 py-0.5 text-[10px] font-semibold ${tone}`}
    >
      <span aria-hidden className="[&>svg]:h-3 [&>svg]:w-3">
        {connected ? <LuCircleCheck /> : <LuCircleDashed />}
      </span>
      {connected ? "Connected" : required ? "Action needed" : "Not connected"}
    </span>
  );
}

export function IntegrationCard({ integration }: { integration: Integration }) {
  const { id, name, category, summary, detail, missing, docs, connected, required } = integration;

  return (
    <article className="flex flex-col gap-3 bg-surface p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span
            aria-hidden
            className="flex h-9 w-9 shrink-0 items-center justify-center border border-rule bg-surface-2"
          >
            {integrationIcons[id] ?? integrationIcons.plug}
          </span>
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold tracking-tight">{name}</h3>
            <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted">
              {CATEGORY_LABEL[category]}
              {required && <span className="text-muted"> · Required</span>}
            </p>
          </div>
        </div>
        <StatusBadge connected={connected} required={required} />
      </div>

      <p className="text-xs leading-relaxed text-muted">{summary}</p>

      <p className="break-all font-mono text-[11px] text-foreground/80" title={detail}>
        {detail}
      </p>

      {missing.length > 0 && (
        <div className="border-t border-rule pt-3">
          <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted">
            To connect
          </p>
          <ul className="flex flex-wrap gap-1.5">
            {missing.map((item) => (
              <li key={item}>
                {/* Some entries are variable names, some are a sentence. A name
                    has no spaces, which is enough to tell them apart. */}
                {item.includes(" ") ? (
                  <span className="text-xs leading-relaxed text-muted">{item}</span>
                ) : (
                  <code className="border border-rule bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-foreground/80">
                    {item}
                  </code>
                )}
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
        How it works · <span className="font-mono text-[11px]">{docs}</span>
        <span aria-hidden className="[&>svg]:h-3 [&>svg]:w-3">
          <LuExternalLink />
        </span>
      </a>
    </article>
  );
}
