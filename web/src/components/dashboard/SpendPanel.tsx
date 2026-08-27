import { tokens } from "@/lib/format";

/**
 * Where the input tokens went.
 *
 * The `skills` row is the one worth having: it is the direct answer to whether
 * the skill packs earn their keep, and almost no agent product can show it.
 * The harness reports the split; this only renders it.
 */

const CATEGORY_LABELS: Record<string, string> = {
  instructions: "Instructions",
  skills: "Skill packs",
  messages: "Messages",
  harness: "Harness",
  tool_definitions: "Tool definitions",
};

const CATEGORY_NOTES: Record<string, string> = {
  instructions: "each role's persona and task",
  skills: "the four skill packs",
  messages: "the diff and doc excerpts",
  harness: "the harness's own scaffolding",
  tool_definitions: "tool schemas sent with every turn",
};

export function SpendPanel({ breakdown }: { breakdown: Record<string, number> }) {
  const rows = Object.entries(breakdown).sort((a, b) => b[1] - a[1]);
  const total = rows.reduce((sum, [, value]) => sum + value, 0);

  return (
    <section aria-labelledby="input-split" className="border border-rule bg-surface">
      <div className="flex items-baseline justify-between border-b border-rule px-4 py-3">
        <h2
          id="input-split"
          className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted"
        >
          Input split
        </h2>
        <span className="text-xs tabular-nums text-muted">{tokens(total)} in</span>
      </div>

      {rows.length === 0 ? (
        <p className="px-4 py-6 text-xs leading-relaxed text-muted">
          No breakdown recorded yet. The harness reports it per turn, so this fills in after the
          next run.
        </p>
      ) : (
        <dl className="divide-y divide-rule">
          {rows.map(([key, value]) => {
            const share = total > 0 ? value / total : 0;
            return (
              <div key={key} className="px-4 py-3">
                <div className="flex items-baseline justify-between gap-4">
                  <dt className="text-xs font-medium">
                    {CATEGORY_LABELS[key] ?? key}
                    {CATEGORY_NOTES[key] && (
                      <span className="ml-2 font-normal text-muted">{CATEGORY_NOTES[key]}</span>
                    )}
                  </dt>
                  <dd className="shrink-0 text-xs tabular-nums">
                    {tokens(value)}
                    <span className="ml-2 text-muted">{Math.round(share * 100)}%</span>
                  </dd>
                </div>
                <div className="mt-2 h-1 bg-surface-2">
                  <div
                    className={`h-full ${key === "skills" ? "bg-accent" : "bg-muted/50"}`}
                    style={{ width: `${Math.max(share * 100, 1)}%` }}
                  />
                </div>
              </div>
            );
          })}
        </dl>
      )}
    </section>
  );
}
