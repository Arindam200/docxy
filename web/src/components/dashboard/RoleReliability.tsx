import type { RoleStats } from "@/lib/docxy";
import { duration, roleTitle, tokens } from "@/lib/format";

/**
 * Which role fails, how often, and how it fails.
 *
 * The failure kind is the column that earns its place: a harness error and a
 * parse error come from opposite ends of the system, and a role that is merely
 * slow is a different problem from one that is unreliable.
 */

const FAILURE_LABELS: Record<string, string> = {
  "harness-error": "harness",
  "parse-error": "parse",
  timeout: "timeout",
  aborted: "aborted",
};

function usd(value: number | undefined): string {
  if (value === undefined) return "—";
  // Sub-cent roles are the common case, so two decimals would read as $0.00.
  return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

export function RoleReliability({ roles }: { roles: RoleStats[] }) {
  return (
    <section aria-labelledby="role-reliability" className="border border-rule bg-surface">
      <div className="border-b border-rule px-4 py-3">
        <h2
          id="role-reliability"
          className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted"
        >
          Per role
        </h2>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-xs">
          <thead>
            <tr className="border-b border-rule text-left text-muted">
              <th scope="col" className="px-4 py-2 font-medium">Role</th>
              <th scope="col" className="px-4 py-2 font-medium tabular-nums">Turns</th>
              <th scope="col" className="px-4 py-2 font-medium">Failures</th>
              <th scope="col" className="px-4 py-2 font-medium tabular-nums">Median</th>
              <th scope="col" className="px-4 py-2 font-medium tabular-nums">p95</th>
              <th scope="col" className="px-4 py-2 font-medium tabular-nums">Tokens</th>
              <th scope="col" className="px-4 py-2 font-medium tabular-nums">Cost</th>
              <th scope="col" className="px-4 py-2 font-medium tabular-nums">Reuse</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-rule">
            {roles.map((role) => {
              const failures = Object.entries(role.failures);
              return (
                <tr key={role.role}>
                  <td className="px-4 py-2.5 font-medium">{roleTitle(role.role)}</td>
                  <td className="px-4 py-2.5 tabular-nums text-muted">{role.runs}</td>
                  <td className="px-4 py-2.5">
                    {failures.length === 0 ? (
                      <span className="text-muted">none</span>
                    ) : (
                      <span className="flex flex-wrap gap-1">
                        {failures.map(([kind, count]) => (
                          <span
                            key={kind}
                            className="border border-danger/30 bg-danger/10 px-1.5 py-px text-[10px] text-danger"
                          >
                            {count} {FAILURE_LABELS[kind] ?? kind}
                          </span>
                        ))}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 tabular-nums">{duration(role.medianMs)}</td>
                  <td className="px-4 py-2.5 tabular-nums text-muted">{duration(role.p95Ms)}</td>
                  <td className="px-4 py-2.5 tabular-nums text-muted">
                    {tokens(role.inputTokens + role.outputTokens)}
                  </td>
                  <td className="px-4 py-2.5 tabular-nums">{usd(role.costUsd)}</td>
                  <td className="px-4 py-2.5 tabular-nums text-muted">
                    {role.reuseRate === undefined ? "—" : `${Math.round(role.reuseRate * 100)}%`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
