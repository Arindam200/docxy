import { redirect } from "next/navigation";
import { movedSectionHref } from "@/lib/moved-section";

export const dynamic = "force-dynamic";

/**
 * Moved inside projects. Insights is now a section of the one repository it
 * describes, rather than one list mixing every repository together.
 *
 * Kept as a redirect rather than deleted because bookmarks, the browser history
 * of anyone who used the old sidebar, and links written in earlier guides all
 * still point here. A 404 would read as the feature being gone.
 */
export default async function MovedPage() {
  redirect(await movedSectionHref("insights"));
}
