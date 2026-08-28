import type { RoleDot } from "@/lib/docxy";
import { duration, roleTitle, ROLE_ORDER } from "@/lib/format";

/**
 * Five dots, one per role, in pipeline order.
 *
 * This is the whole run at a glance: where it got to, and which role stopped
 * it. A role that has not started yet is hollow rather than absent, so the row
 * keeps its width and the gap reads as "not reached" instead of "missing".
 */

const STATUS_CLASS = {
  running: "bg-accent animate-pulse",
  done: "bg-ok",
  failed: "bg-danger",
} satisfies Record<RoleDot["status"], string>;

export function RoleDots({ roles }: { roles: RoleDot[] | undefined }) {
  const byRole = new Map((roles ?? []).map((role) => [role.role, role]));

  return (
    <span className="inline-flex items-center gap-1" role="img" aria-label={label(roles)}>
      {ROLE_ORDER.map((name) => {
        const role = byRole.get(name);
        return (
          <span
            key={name}
            title={
              role
                ? `${roleTitle(name)} — ${role.status}${
                    role.failure ? ` (${role.failure})` : ""
                  } · ${duration(role.durationMs)}`
                : `${roleTitle(name)} — not reached`
            }
            className={`h-1.5 w-1.5 rounded-full ${
              role ? STATUS_CLASS[role.status] : "border border-rule bg-transparent"
            }`}
          />
        );
      })}
    </span>
  );
}

function label(roles: RoleDot[] | undefined): string {
  const list = roles ?? [];
  const failed = list.find((role) => role.status === "failed");
  if (failed) return `${roleTitle(failed.role)} failed`;

  const done = list.filter((role) => role.status === "done").length;
  return `${done} of ${ROLE_ORDER.length} roles complete`;
}
