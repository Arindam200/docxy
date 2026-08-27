import { LuGitBranch } from "react-icons/lu";

import type { DocxyConfig } from "@/lib/docxy";
import { roleTitle } from "@/lib/format";

/**
 * The machinery behind the pipeline: the harness that runs the agents, the
 * provider behind the models, where runs are kept, and which model each role
 * is pointed at.
 *
 * Which *repositories* are synced is deliberately not here — that is a fact
 * about the GitHub App installation, and `SyncedRepos` reads it from the
 * installation itself rather than from a local path this process happens to
 * hold. Everything below is one fact per line, so the section reads at a glance
 * instead of as a column of key/value pairs stranded on a wide monitor.
 */

function Card({
  label,
  value,
  hint,
  mono = false,
}: {
  label: string;
  value: string;
  hint?: string;
  mono?: boolean;
}) {
  return (
    <div className="bg-surface p-4">
      <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted">{label}</p>
      <p
        className={`mt-2 break-words text-sm ${mono ? "font-mono text-[13px]" : "font-medium"}`}
        title={value}
      >
        {value}
      </p>
      {hint && <p className="mt-1.5 text-xs leading-relaxed text-muted">{hint}</p>}
    </div>
  );
}

export function SyncedPanel({
  config,
  docsBranch,
}: {
  config: DocxyConfig | null;
  docsBranch?: string;
}) {
  const models = Object.entries(config?.models ?? {});

  return (
    <div className="space-y-6">
      {docsBranch && (
        <p className="inline-flex items-center gap-1.5 text-xs text-muted">
          <span aria-hidden className="[&>svg]:h-3 [&>svg]:w-3">
            <LuGitBranch />
          </span>
          Documentation lives on <span className="font-mono text-foreground">{docsBranch}</span>,
          and pull requests target it.
        </p>
      )}

      {/* Hairline-gapped cells, the same idiom the integration tiles use. */}
      <div className="grid grid-cols-1 gap-px border border-rule bg-rule sm:grid-cols-2 lg:grid-cols-4">
        <Card
          label="Harness"
          value={config?.trueforgeBaseUrl ?? "—"}
          hint="Runs the five agents and owns their sessions."
          mono
        />
        <Card
          label="Provider"
          value={config?.provider ?? "—"}
          hint={models.length > 0 ? `${models.length} roles pointed at it` : "Serves every model."}
        />
        <Card
          label="Storage"
          value={
            config?.storage === "postgres" ? "Postgres" : config?.storage === "files" ? "Files" : "—"
          }
          hint={
            config?.storage === "postgres"
              ? "Runs, sessions, and the symbol map are in Neon."
              : config?.storage === "files"
                ? "Runs, sessions, and the symbol map are JSON in .docxy/."
                : undefined
          }
        />
        <Card
          label="Validation"
          value={config ? (config.validationEnabled ? "Enabled" : "Disabled") : "—"}
          hint={
            config?.validationEnabled
              ? "Edits are checked before a human sees them."
              : "Proposals reach approval unchecked."
          }
        />
      </div>

      {models.length > 0 && (
        <section aria-labelledby="synced-models" className="border border-rule bg-surface">
          <div className="border-b border-rule px-4 py-3">
            <h2
              id="synced-models"
              className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted"
            >
              Model per role
            </h2>
          </div>
          <dl className="divide-y divide-rule">
            {models.map(([role, model]) => (
              <div key={role} className="flex items-baseline justify-between gap-6 px-4 py-2.5">
                <dt className="text-xs">{roleTitle(role)}</dt>
                <dd className="truncate font-mono text-xs text-muted" title={model}>
                  {model}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      )}
    </div>
  );
}
