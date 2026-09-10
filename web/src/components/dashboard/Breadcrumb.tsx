"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { projectIdFromPath } from "@/components/dashboard/Sidebar";

/**
 * The tail of the header trail, after the organization switcher.
 *
 * It replaced a fixed "Dashboard", which was true of every page and so told
 * nobody anything. Now that the rail swaps its entries inside a project, the
 * header is the one place that still says *which* project those entries belong
 * to - an icon rail has no room to.
 *
 * Client-side and derived from the path for the same reason the rail is: this
 * renders in the dashboard layout, above the project layout that knows the
 * project, so nothing can be passed up. The names come down from the layout as
 * a list instead.
 */
export function Breadcrumb({
  projects,
}: {
  projects: Array<{ id: string; label: string }>;
}) {
  const pathname = usePathname();
  const projectId = projectIdFromPath(pathname);
  const project = projects.find((candidate) => candidate.id === projectId);

  if (!projectId) {
    const section = pathname.startsWith("/dashboard/repositories") || pathname === "/dashboard/projects/new"
      ? "Repositories"
      : pathname === "/dashboard/projects"
        ? "Projects"
      : pathname.startsWith("/dashboard/integrations")
      ? "Integrations"
      : pathname.startsWith("/dashboard/settings") || pathname.startsWith("/dashboard/instructions")
        ? "Settings"
        : pathname.startsWith("/dashboard/members") ? "Members" : "Overview";
    return (
      <>
        <span aria-hidden className="hidden text-muted sm:inline">
          /
        </span>
        <span className="hidden text-muted sm:inline">{section}</span>
      </>
    );
  }

  return (
    <>
      <span aria-hidden className="hidden text-muted sm:inline">
        /
      </span>
      <Link
        href="/dashboard/projects"
        className="focus-ring hidden text-muted transition-colors hover:text-accent sm:inline"
      >
        Projects
      </Link>
      <span aria-hidden className="text-muted">
        /
      </span>
      {/*
        Truncated rather than wrapped: the header is a fixed 56px tall, and a
        long `owner/repository` name is exactly the case that would push the
        organization switcher off the row.
      */}
      <span className="min-w-0 truncate font-medium" title={project?.label}>
        {project?.label ?? "Project"}
      </span>
    </>
  );
}
