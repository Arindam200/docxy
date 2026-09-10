import Link from "next/link";
import { notFound } from "next/navigation";
import { fetchRun, type RoleOutputs } from "@/lib/docxy";
import { dateTime, duration } from "@/lib/format";
import { PageHead } from "@/components/dashboard/Page";
import { currentProject } from "@/lib/project-scope";
import { projectHref } from "@/lib/projects";
import { StatusChip } from "@/components/dashboard/RunTimeline";
import { Waterfall } from "@/components/dashboard/Waterfall";
import { TokenBreakdown } from "@/components/dashboard/TokenBreakdown";
import { RoleInspector } from "@/components/dashboard/RoleInspector";
import { SandboxTrail } from "@/components/dashboard/SandboxTrail";
import { LiveUpdates } from "@/components/dashboard/LiveUpdates";

export const dynamic = "force-dynamic";

export default async function RunPage({
  params,
}: {
  params: Promise<{ id: string; runId: string }>;
}) {
  const { id, runId } = await params;
  const scope = await currentProject(id);
  if (scope.kind === "offline") return null;
  if (scope.kind === "missing") notFound();

  const { project, organizationId } = scope;
  const run = await fetchRun(runId, organizationId);
  if (!run) notFound();

  // The run has to belong to the project in the path, not merely to the same
  // organization. Without this, any of an organization's run ids would render
  // under any of its projects - a URL that reads as a fact about one repository
  // while showing another's work.
  if (run.repoPath !== project.key) notFound();

  // The role a tab shows under "Parsed" is whichever run-level field that role
  // produced; the Coordinator's verdict survives only as the approval summary.
  const parsed = {
    "change-analyst": run.classification,
    "impact-mapper": run.impact,
    "docs-updater": run.docs,
    "changelog-author": run.changelog,
    coordinator: run.approval
      ? { summary: run.approval.summary, scope: run.approval.scope }
      : undefined,
  } satisfies RoleOutputs;

  return (
    <>
      <PageHead
        level={2}
        title={run.commit.subject}
        lede={
          <>
            <code className="font-mono text-xs text-accent">{run.commit.shortSha}</code>
            <span aria-hidden> · </span>
            {dateTime(run.startedAt)}
            <span aria-hidden> · </span>
            {duration(run.durationMs)}
          </>
        }
      >
        <div className="flex items-center gap-4">
          {/* Scoped to this run: another repository finishing changes nothing here. */}
          <LiveUpdates runId={run.id} />
          <StatusChip status={run.status} />
          {run.pullRequestUrl && (
            <a
              href={run.pullRequestUrl}
              target="_blank"
              rel="noreferrer"
              className="text-xs text-muted underline decoration-rule underline-offset-4 hover:text-accent hover:decoration-accent"
            >
              Pull request ↗
            </a>
          )}
          <Link
            href={projectHref(project.id, "activity")}
            className="text-xs text-muted underline decoration-rule underline-offset-4 hover:text-accent hover:decoration-accent"
          >
            All runs
          </Link>
        </div>
      </PageHead>

      {/*
        A Coordinator rejection is the system working, not a crash, so it is
        styled as a decision. Everything else that sets `error` is a failure.
      */}
      {run.error && (
        <div
          role="alert"
          className={`border px-4 py-3 text-sm leading-relaxed ${
            run.status === "denied" || run.error.startsWith("Coordinator rejected")
              ? "border-warn/30 bg-warn/10 text-warn"
              : "border-danger/30 bg-danger/5 text-danger"
          }`}
        >
          {run.error}
        </div>
      )}

      <section aria-labelledby="run-waterfall" className="space-y-3">
        <h3 id="run-waterfall" className="text-sm font-semibold tracking-tight">
          Roles
        </h3>
        <Waterfall traces={run.traces} />
      </section>

      <section aria-labelledby="run-tokens" className="space-y-3">
        <h3 id="run-tokens" className="text-sm font-semibold tracking-tight">
          Tokens
        </h3>
        <TokenBreakdown totals={run.totals} traces={run.traces} />
      </section>

      {run.validation && (
        <section aria-labelledby="run-validation" className="space-y-3">
          <h3 id="run-validation" className="text-sm font-semibold tracking-tight">
            Validation
          </h3>
          <ul className="border border-rule divide-y divide-rule bg-surface">
            {run.validation.checks.map((check) => (
              <li key={check.name} className="flex gap-3 px-4 py-2.5 text-xs">
                <span
                  className={`w-14 shrink-0 font-medium ${
                    check.status === "pass"
                      ? "text-ok"
                      : check.status === "fail"
                        ? "text-danger"
                        : "text-muted"
                  }`}
                >
                  {check.status}
                </span>
                <span className="w-40 shrink-0 font-mono">
                  {check.name}
                  {/* Where a command ran is part of the result, not trivia: the
                      same "docs-build passed" means something different when the
                      build ran against the operator's own filesystem. */}
                  {check.where && (
                    <span
                      className={`ml-2 rounded-sm px-1 py-px text-[10px] font-sans uppercase tracking-wide ${
                        check.where === "sandbox"
                          ? "bg-ok/10 text-ok"
                          : "bg-muted/10 text-muted"
                      }`}
                    >
                      {check.where}
                    </span>
                  )}
                </span>
                {/* `anchor-not-found` names the anchor that missed, which is the
                    most actionable message the pipeline produces - so the detail
                    is shown verbatim rather than summarised. */}
                <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-muted">
                  {check.detail}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {run.validation && (
        <SandboxTrail checks={run.validation.checks} events={run.validation.events} />
      )}

      {run.approval && (
        <section aria-labelledby="run-approval" className="space-y-3">
          <h3 id="run-approval" className="text-sm font-semibold tracking-tight">
            Approval
          </h3>
          <div className="border border-rule bg-surface p-4 text-sm">
            <p className="leading-relaxed">{run.approval.summary}</p>
            <p className="mt-3 text-xs leading-relaxed text-muted">
              {run.approval.scopeRationale}
            </p>
            <p className="mt-3 text-xs text-muted">
              {run.approval.signoffs.length} of {run.approval.requiredSignoffs} sign-off
              {run.approval.requiredSignoffs === 1 ? "" : "s"}
              {run.approval.signoffs.length > 0 &&
                `: ${run.approval.signoffs.map((s) => s.by).join(", ")}`}
            </p>
          </div>
        </section>
      )}

      <section aria-labelledby="run-roles" className="space-y-3">
        <h3 id="run-roles" className="text-sm font-semibold tracking-tight">
          Role detail
        </h3>
        <RoleInspector traces={run.traces} parsed={parsed} />
      </section>

      <p className="text-xs text-muted">
        Memory: {run.priorSymbolCount} symbol{run.priorSymbolCount === 1 ? "" : "s"} carried in,{" "}
        {run.newSymbolCount} learned.
      </p>
    </>
  );
}
