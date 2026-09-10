import { redirect } from "next/navigation";
import { movedSectionHref } from "@/lib/moved-section";

export const dynamic = "force-dynamic";

/**
 * Moved twice, and forwarded once.
 *
 * This was renamed to Insights, and Insights then moved inside projects. Going
 * by way of `/dashboard/insights` would work, but it would cost a second
 * redirect to reach the same place - so this resolves to the destination
 * directly and the two stubs stay independent of each other.
 */
export default async function MovedPage() {
  redirect(await movedSectionHref("insights"));
}
