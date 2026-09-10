/**
 * Where an organization-wide Activity, Logs or Insights URL should land now
 * that all three live inside a project.
 *
 * The obvious answer is the project list, and it is the wrong one for the
 * common case. Most organizations watch a single repository, and sending
 * somebody who bookmarked their run history to a list with one entry on it is a
 * click that exists only because the routes moved. So one project resolves
 * straight through to its own section, and anything else lands on the list,
 * where choosing is the actual next step.
 *
 * Failing soft matters here too: an unreachable pipeline sends everybody to the
 * list, which renders its own offline state, rather than to a project page for
 * a project this cannot confirm exists.
 */

import { fetchProjects } from "@/lib/docxy";
import { activeOrganizationId } from "@/lib/organization";
import { projectHref, type ProjectSection } from "@/lib/projects";

export async function movedSectionHref(section: ProjectSection): Promise<string> {
  const result = await fetchProjects(await activeOrganizationId());
  const projects = result?.projects ?? [];
  return projects.length === 1 ? projectHref(projects[0].id, section) : "/dashboard";
}
