import type { DocxyConfig } from "@/lib/docxy";

/** Connection panel: which repo is synced, where the pipeline runs, last sync. */
export function SyncedPanel({
  config,
  lastRunAt,
  online,
}: {
  config: DocxyConfig | null;
  lastRunAt?: string;
  online: boolean;
}) {
  return (
    <section aria-labelledby="synced-heading" className="border border-rule bg-surface h-fit">
      <div className="flex items-center justify-between px-4 py-3 border-b border-rule">
        <h2
          id="synced-heading"
          className="flex items-center gap-2 text-[10px] font-semibold tracking-[0.08em] uppercase text-muted"
        >
          Synced
          <span
            aria-hidden
            className={`h-1.5 w-1.5 rounded-full ${online ? "bg-emerald-400" : "bg-red-400"}`}
          />
        </h2>
      </div>

      <dl className="divide-y divide-rule">
        <div className="flex items-baseline justify-between gap-6 px-4 py-3">
          <dt className="text-xs text-muted">Repository</dt>
          <dd className="font-mono text-xs text-right truncate" title={config?.repoPath}>
            {config?.repoPath ?? "—"}
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-6 px-4 py-3">
          <dt className="text-xs text-muted">Last sync</dt>
          <dd className="text-xs tabular-nums">
            {lastRunAt ? new Date(lastRunAt).toLocaleString() : "Never"}
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-6 px-4 py-3">
          <dt className="text-xs text-muted">Harness</dt>
          <dd className="font-mono text-xs">{config?.trueforgeBaseUrl ?? "—"}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-6 px-4 py-3">
          <dt className="text-xs text-muted">Validation</dt>
          <dd className="text-xs">{config ? (config.validationEnabled ? "Enabled" : "Disabled") : "—"}</dd>
        </div>
      </dl>
    </section>
  );
}
