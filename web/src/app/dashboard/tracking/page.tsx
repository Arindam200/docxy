import { redirect } from "next/navigation";

/**
 * Moved. Kept as a redirect rather than deleted because bookmarks, the browser
 * history of anyone who used the old sidebar, and links written in earlier
 * guides all still point here. A 404 would read as the feature being gone.
 *
 * It pointed at `/dashboard/integrations#pipeline`, an anchor no page has
 * rendered since the pipeline panels were taken off Integrations, so it landed
 * at the top of a page about something else. What this page answered was which
 * repositories docxy is watching, and Repositories is where that lives now.
 */
export default function MovedPage() {
  redirect("/dashboard/repositories");
}
