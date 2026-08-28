import { lookup } from "@/lib/lookup";
import type { RoleTrace, RunTotals } from "@/lib/docxy";

/**
 * Where the input tokens went.
 *
 * The harness reports its own split — `instructions`, `skills`, `messages`,
 * `harness`, `tool_definitions` — and the `skills` row is the interesting one:
 * it is a direct answer to whether the skill packs earn what they cost.
 */

const LABELS = {
  harness: "harness",
  instructions: "instructions",
  messages: "messages",
  skills: "skills",
  tool_definitions: "tool definitions",
} satisfies Record<string, string>;

const EXPLAINS = {
  instructions: "the role's persona and task",
  skills: "the skill pack",
  messages: "the diff and doc excerpts",
  harness: "the harness's own scaffolding",
  tool_definitions: "tool schemas",
} satisfies Record<string, string>;

export function TokenBreakdown({
  totals,
  traces,
}: {
  totals: RunTotals | undefined;
  traces: RoleTrace[];
}) {
  const breakdown: Record<string, number> = {};
  for (const trace of traces) {
    for (const [key, value] of Object.entries(trace.usage?.inputBreakdown ?? {})) {
      breakdown[key] = (breakdown[key] ?? 0) + value;
    }
  }

  const rows = Object.entries(breakdown).sort(([, a], [, b]) => b - a);
  const largest = rows[0]?.[1] ?? 0;

  return (
    <div className="border border-rule bg-surface p-4">
      <div className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
        <Figure label="input" value={totals?.inputTokens ?? 0} />
        <Figure label="output" value={totals?.outputTokens ?? 0} />
        <Figure label="cached" value={totals?.cacheReadTokens ?? 0} />
      </div>

      {rows.length === 0 ? (
        <p className="mt-4 border-t border-rule pt-3 text-xs leading-relaxed text-muted">
          No input breakdown recorded. The harness sends one per model message —
          runs from before that was captured simply do not have it.
        </p>
      ) : (
        <div className="mt-4 border-t border-rule pt-3">
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted">
            input split
          </p>
          <ul className="space-y-1.5">
            {rows.map(([key, value]) => (
              <li key={key} className="flex items-center gap-3 text-xs">
                <span className="w-28 shrink-0 truncate">{lookup(LABELS, key) ?? key}</span>
                <span className="relative h-1.5 flex-1 rounded-sm bg-surface-2">
                  <span
                    className="absolute inset-y-0 left-0 rounded-sm bg-accent/60"
                    style={{ width: `${largest > 0 ? (value / largest) * 100 : 0}%` }}
                  />
                </span>
                <span className="w-16 shrink-0 text-right tabular-nums">
                  {value.toLocaleString()}
                </span>
                <span className="hidden w-44 shrink-0 text-muted sm:block">
                  {lookup(EXPLAINS, key) ? `← ${lookup(EXPLAINS, key)}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Figure({ label, value }: { label: string; value: number }) {
  return (
    <span>
      <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted">
        {label}{" "}
      </span>
      <span className="tabular-nums">{value.toLocaleString()}</span>
    </span>
  );
}
