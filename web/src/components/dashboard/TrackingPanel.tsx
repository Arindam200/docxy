import type { Tracking } from "@/lib/docxy";

/** What the pipeline watches: docs roots, changelog, knowledge map size. */
export function TrackingPanel({
  tracking,
  expanded = false,
}: {
  tracking: Tracking | null;
  /** Full-page mode: list every mapped symbol without the height clamp. */
  expanded?: boolean;
}) {
  const entries = Object.entries(tracking?.symbols ?? {});
  const symbols = (expanded ? entries : entries.slice(0, 8)).map(
    ([symbol, sections]) => ({ symbol, section: sections[0] ?? "" }),
  );

  return (
    <section aria-labelledby="tracking-heading" className="border border-rule bg-surface h-fit">
      <div className="flex items-center justify-between px-4 py-3 border-b border-rule">
        <h2
          id="tracking-heading"
          className="text-[10px] font-semibold tracking-[0.08em] uppercase text-muted"
        >
          Tracking
        </h2>
        <span className="text-xs text-muted tabular-nums">
          {tracking?.processedCommits ?? 0} commits · {tracking?.symbolCount ?? 0} symbols
        </span>
      </div>

      <div className="px-4 py-3 flex flex-wrap gap-1.5">
        {(tracking?.docsRoots ?? []).map((root) => (
          <code key={root} className="border border-accent/40 bg-accent/10 px-2 py-0.5 font-mono text-xs text-accent">
            {root}
          </code>
        ))}
        {tracking && (
          <code className="border border-rule bg-surface-2 px-2 py-0.5 font-mono text-xs text-muted">
            {tracking.changelogPath}
          </code>
        )}
        {tracking?.docsBranch && (
          <code className="border border-rule bg-surface-2 px-2 py-0.5 font-mono text-xs text-muted">
            branch: {tracking.docsBranch}
          </code>
        )}
      </div>

      {symbols.length > 0 && (
        <ul
          className={`border-t border-rule divide-y divide-rule ${
            expanded ? "" : "max-h-52 overflow-y-auto"
          }`}
        >
          {symbols.map(({ symbol, section }) => (
            <li key={symbol} className="flex items-baseline justify-between gap-6 px-4 py-2">
              <code className="font-mono text-xs truncate">{symbol}</code>
              <span className="font-mono text-xs text-muted truncate" title={section}>
                {section}
              </span>
            </li>
          ))}
        </ul>
      )}

      {tracking === null && (
        <p className="border-t border-rule px-4 py-3 text-xs text-muted">
          Nothing learned yet — the knowledge map fills in as runs process commits.
        </p>
      )}
    </section>
  );
}
