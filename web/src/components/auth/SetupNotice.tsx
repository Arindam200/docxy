import type { EnvRequirement } from "@/lib/env";

/**
 * What a deployment shows instead of a form it cannot honour.
 *
 * Without `DATABASE_URL` and `BETTER_AUTH_SECRET` every submission ends in a
 * 500 and an error message that blames the credentials. Naming the missing
 * variables here puts the failure where it belongs — on the deployment.
 */
export function SetupNotice({ missing }: { missing: EnvRequirement[] }) {
  return (
    <div className="rounded-md border border-rule bg-surface px-4 py-4">
      <p className="text-sm font-medium text-foreground">Sign-in is not configured yet</p>
      <p className="mt-1.5 text-xs leading-relaxed text-muted">
        This deployment is missing the environment it needs to hold a session. Set{" "}
        {missing.length === 1 ? "this variable" : "these variables"} in{" "}
        <code className="font-mono text-foreground">web/.env.local</code> and restart.
      </p>
      <dl className="mt-3 space-y-2.5 border-t border-rule pt-3">
        {missing.map((item) => (
          <div key={item.key}>
            <dt className="font-mono text-[11px] text-foreground">{item.key}</dt>
            <dd className="text-xs leading-relaxed text-muted">{item.hint}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
