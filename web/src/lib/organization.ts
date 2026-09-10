/**
 * The organization a dashboard page is rendering for.
 *
 * Every server-rendered read goes to the pipeline API directly, carrying the
 * shared credential and bypassing the /api/docxy proxy - so the proxy's tenant
 * rule does not protect these pages and each one has to name its own scope.
 * This is where that name comes from, and it comes from the session rather than
 * from anything in the URL.
 *
 * The dashboard layout already sends an account with no organization to
 * onboarding, so reaching a page without one means arriving somewhere the
 * layout does not wrap - or a session that lost its organization between the
 * layout and the page. Both are answered by the same redirect rather than by
 * rendering a page with nothing in it.
 */

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { authRequired, getActiveOrganizationId } from "@/lib/auth";

/**
 * The active organization id, or a redirect.
 *
 * Returns an empty string when this deployment has sign-in switched off. That
 * is the demo, which runs against the JSON stores: with no database there are
 * no organizations, and the API reads "everything" and "mine" as the same set.
 * A deployment that has a database *and* `DOCXY_REQUIRE_AUTH=0` cannot answer
 * the question at all, and the API refuses those reads rather than guessing -
 * the dashboard then renders its offline state, which is the honest result.
 */
export async function activeOrganizationId(): Promise<string> {
  if (!authRequired()) return "";

  const id = await getActiveOrganizationId(await headers());
  if (!id) redirect("/onboarding");
  return id;
}
