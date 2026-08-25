import type { Integration } from "@/lib/docxy";

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

export function IntegrationCard({ integration }: { integration: Integration }) {
  const { connected, required } = integration;
  // Not connected is only a problem when the integration is required; the rest
  // are genuinely optional and should not read as broken.
  const tone = connected ? "ok" : required ? "error" : "idle";

  return (
    <div
      className={`border bg-surface p-4 ${
        tone === "error" ? "border-red-500/30" : "border-rule"
      }`}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span
              aria-hidden
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                tone === "ok" ? "bg-emerald-400" : tone === "error" ? "bg-red-400" : "bg-zinc-500"
              }`}
            />
            <h3 className="truncate text-sm font-semibold tracking-tight">{integration.name}</h3>
            {required && (
              <span className="rounded border border-rule px-1.5 py-px text-[10px] uppercase tracking-wide text-muted">
                required
              </span>
            )}
          </div>
          <p className="mt-1.5 text-xs leading-relaxed text-muted">{integration.summary}</p>
        </div>

        <span
          className={`shrink-0 text-xs font-medium ${
            tone === "ok" ? "text-emerald-300" : tone === "error" ? "text-red-300" : "text-muted"
          }`}
        >
          {connected ? "connected" : "not connected"}
        </span>
      </div>

      <dl className="mt-3 border-t border-rule pt-3 text-xs">
        <div className="flex gap-3">
          <dt className="w-20 shrink-0 text-muted">{CATEGORY_LABEL[integration.category]}</dt>
          <dd className="min-w-0 flex-1 truncate font-mono text-[11px]" title={integration.detail}>
            {integration.detail}
          </dd>
        </div>
      </dl>

      {integration.missing.length > 0 && (
        <div className="mt-3 border-t border-rule pt-3">
          <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted">
            to connect
          </p>
          <ul className="mt-1.5 space-y-1">
            {integration.missing.map((item) => (
              <li key={item} className="text-xs leading-relaxed">
                {/* Some entries are variable names, some are a sentence. A name
                    has no spaces, which is enough to tell them apart. */}
                {item.includes(" ") ? (
                  <span className="text-muted">{item}</span>
                ) : (
                  <code className="font-mono text-[11px] text-foreground">{item}</code>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="mt-3 text-[11px] text-muted">
        <code className="font-mono">{integration.docs}</code>
      </p>
    </div>
  );
}
