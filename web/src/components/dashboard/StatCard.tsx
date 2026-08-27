export function StatCard({
  label,
  value,
  hint,
  accent = false,
}: {
  label: string;
  value: number | string;
  hint?: string;
  accent?: boolean;
}) {
  return (
    <div className={`p-4 bg-surface ${accent ? "border-l-2 border-l-accent" : ""}`}>
      <p className="text-[10px] font-semibold tracking-[0.08em] uppercase text-muted mb-2">
        {label}
      </p>
      <p className="text-3xl font-semibold tabular-nums tracking-tight leading-none">{value}</p>
      {hint && <p className="mt-2 text-xs text-muted">{hint}</p>}
    </div>
  );
}
