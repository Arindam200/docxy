import { redirect } from "next/navigation";

/**
 * Moved to `/dashboard`, which is the project list now.
 *
 * Kept as a redirect rather than deleted because bookmarks, the browser history
 * of anyone who used the old sidebar, and links written in earlier guides all
 * still point here. A 404 would read as the feature being gone.
 */
export default function MovedPage() {
  redirect("/dashboard");
}
