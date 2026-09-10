import Link from "next/link";
import { LuArrowRight, LuCircleAlert } from "react-icons/lu";
import type { Project } from "@/lib/docxy";
import { timeAgo } from "@/lib/format";
import { projectHref, projectTitle, type ProjectRollup } from "@/lib/projects";
import { StatusChip } from "@/components/dashboard/RunTimeline";

export interface ProjectSummary {
  project: Pick<Project, "id" | "name" | "sourceRepo">;
  stats: ProjectRollup;
}

function usd(value: number | undefined): string {
  if (value === undefined) return "N/A";
  return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

function percent(value: number | undefined): string {
  return value === undefined ? "N/A" : `${Math.round(value * 100)}%`;
}

export function ProjectCard({ project, stats, online }: ProjectSummary & { online: boolean }) {
  return (
    <Link
      href={projectHref(project.id)}
      className="focus-ring group flex flex-1 flex-col gap-4 border border-rule bg-surface p-5 transition-colors hover:border-accent/50"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="break-all font-semibold">{projectTitle(project)}</h3>
          <p className="mt-1 break-all text-xs text-muted">
            {project.sourceRepo || "Connected repository"}
          </p>
        </div>
        {stats.needsAttention > 0 ? (
          <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs font-medium text-danger">
            <LuCircleAlert size={13} aria-hidden />
            {stats.needsAttention}
          </span>
        ) : (
          <LuArrowRight className="shrink-0 text-accent" aria-hidden />
        )}
      </div>

      {/* The same figures as the totals above, for this one
          repository, so the summary is a way in rather than a
          number you have to go and re-derive. */}
      <dl className="grid grid-cols-3 gap-3 border-y border-rule py-3">
        <ProjectStat label="Runs" value={online ? String(stats.runs) : "N/A"} />
        <ProjectStat
          label="Success"
          value={percent(stats.successRate)}
          alert={stats.successRate !== undefined && stats.successRate < 0.8}
        />
        <ProjectStat label="Spend" value={usd(stats.costUsd)} />
      </dl>

      <div className="mt-auto flex items-center justify-between gap-3 text-xs">
        {!online ? (
          <span className="text-muted">Activity unavailable</span>
        ) : stats.latest ? (
          <>
            <StatusChip status={stats.latest.status} />
            <span className="text-muted tabular-nums">
              {timeAgo(stats.latest.startedAt)}
            </span>
          </>
        ) : (
          <span className="text-muted">No runs yet</span>
        )}
      </div>
    </Link>
  );
}

function ProjectStat({
  label,
  value,
  alert = false,
}: {
  label: string;
  value: string;
  alert?: boolean;
}) {
  return (
    <div>
      <dt className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted">{label}</dt>
      <dd className={`mt-1 text-sm font-semibold tabular-nums ${alert ? "text-danger" : ""}`}>
        {value}
      </dd>
    </div>
  );
}
