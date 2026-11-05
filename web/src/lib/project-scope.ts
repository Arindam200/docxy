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
 * Reads beside the lookup. A page used to wait for this before starting its own
 * reads, which put the project list and then the page's data end to end - two
 * round trips where one would do, on every move between a project's sections.
 * The pages now start theirs at the same time, with the URL's id, and that
 * gives nothing away: the organization is the session's, confirmed against the
 * member table; the API narrows a `projectId` within that organization, so an
 * id from anywhere else reads as nothing rather than as somebody's runs; and
 * nothing a page fetched is rendered until this has found the project in the
 * organization's own list. A missing project still 404s, and the reads made
 * alongside it are dropped unread.
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
 * The reads underneath carry a timeout signal, which opts them out of Next's
 * fetch memoisation, so nothing dedupes them on its own; React's `cache` is
 * what makes the layout and the page it wraps share one lookup. It lasts
 * exactly one request, so a page never shows a project list from an earlier
 * one. `fetchProjects` and `activeOrganizationId` are cached the same way, so a
 * page that asks for either directly as well shares this one's answer.
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
