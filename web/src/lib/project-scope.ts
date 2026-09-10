/**
 * The project a `/dashboard/projects/[id]` route is rendering for.
 *
 * Every page under that path needs the same two things - the project record and
 * the organization it belongs to - and the layout above them needs both as
 * well, to draw the header and to decide between a 404 and an offline state.
 * Resolving it in one cached place is what keeps that from being five identical
 * reads of the same list on one render.
 *
 * Resolution happens *within* the signed-in organization's own projects rather
 * than by a global id lookup. That is the rule the project page has always
 * followed and the reason this returns a project at all rather than just
 * confirming an id: an id that names somebody else's project has to come back
 * as absent, not as a project.
 *
 * Server-only, because `activeOrganizationId` reads request headers. The link
 * builders live in `lib/projects.ts` so client components can import them.
 */

import { cache } from "react";
import { fetchProjects, type Project } from "@/lib/docxy";
import { activeOrganizationId } from "@/lib/organization";

/**
 * Three outcomes, kept apart because they read differently on the page.
 *
 * "offline" is the pipeline being unreachable, which says nothing about whether
 * the project exists - rendering it as a 404 would tell somebody their project
 * was gone because a server was restarting.
 */
export type ProjectScope =
  | { kind: "found"; project: Project; organizationId: string }
  | { kind: "missing"; organizationId: string }
  | { kind: "offline"; organizationId: string };

/**
 * Cached for the render, not across renders.
 *
 * The reads underneath use `cache: "no-store"`, so nothing dedupes them on its
 * own; React's `cache` is what makes the layout and the page it wraps share one
 * lookup. It lasts exactly one request, so a page never shows a project list
 * from an earlier one.
 */
export const currentProject = cache(async (id: string): Promise<ProjectScope> => {
  const organizationId = await activeOrganizationId();
  const result = await fetchProjects(organizationId);
  if (!result) return { kind: "offline", organizationId };

  const project = result.projects.find((candidate) => candidate.id === id);
  return project
    ? { kind: "found", project, organizationId }
    : { kind: "missing", organizationId };
});
