/**
 * The organization a dashboard page is rendering for.
 *
 * Every server-rendered read goes to the pipeline API directly, carrying the
 * shared credential and bypassing the /api/docxy proxy - so the proxy's tenant
 * rule does not protect these pages and each one has to name its own scope.
 * This is where that name comes from, and it comes from the session rather than
 * from anything in the URL - confirmed against the member table, because the
 * session's own field outlives a removal by up to thirty days.
 *
 * The dashboard layout already sends an account with no organization to
 * onboarding, so reaching a page without one means arriving somewhere the
 * layout does not wrap - or a session that lost its organization between the
 * layout and the page. The layout is also not re-rendered when somebody moves
 * between pages under it, which is exactly when a removed member's next click
 * lands here. All of those are answered by the same redirect rather than by
 * rendering a page with nothing in it, and onboarding repairs the session from
 * whatever memberships are left.
 */

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { authRequired, getMemberOrganizationId } from "@/lib/auth";

/**
 * The active organization id, or a redirect.
 *
 * Returns an empty string when this deployment has sign-in switched off. That
 * is the demo, which runs against the JSON stores: with no database there are
 * no organizations, and the API reads "everything" and "mine" as the same set.
 * A deployment that has a database *and* `DOCXY_REQUIRE_AUTH=0` cannot answer
 * the question at all, and the API refuses those reads rather than guessing -
 * the dashboard then renders its offline state, which is the honest result.
 *
 * Cached for the request. A project page asks this directly and again through
 * `currentProject`, and the layout above it asks the same question by another
 * route; the membership check underneath is one query however many ask.
 */
export const activeOrganizationId = cache(async (): Promise<string> => {
  if (!authRequired()) return "";

  const id = await getMemberOrganizationId(await headers());
  if (!id) redirect("/onboarding");
  return id;
});
