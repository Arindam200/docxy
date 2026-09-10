import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { AuthShell } from "@/components/auth/AuthShell";
import { CreateOrganization } from "@/components/onboarding/CreateOrganization";
import { getActiveOrganizationId, getSessionUser, getUserOrganizations } from "@/lib/auth";
import { authReady } from "@/lib/env";
import { resolveOrganization } from "@/lib/onboarding";

export const metadata: Metadata = {
  title: "Create your organization · Docxy",
};

export const dynamic = "force-dynamic";

/**
 * The step between having an account and having anything to look at.
 *
 * The decision here is made on *membership*, never on the session's
 * `activeOrganizationId`. That id is stamped on at sign-in and can disagree
 * with the membership table in both directions, and reading it as the answer
 * produced the two ways onboarding used to fail:
 *
 * - An account that joined an organization after signing in still carries null,
 *   so this page offered to create a second organization beside the one they
 *   already had.
 * - An account whose organization was deleted or left still carries an id, so
 *   this page redirected to the dashboard, whose own membership check sent them
 *   straight back here. A loop with no way out but clearing cookies.
 *
 * Membership answers both. Somebody who belongs to an organization is sent to
 * have their session repaired and does not see this page; somebody who belongs
 * to none sees the form, whatever their session claims.
 */
export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  if (!authReady()) redirect("/login?next=/onboarding");

  const { error } = await searchParams;
  const requestHeaders = await headers();
  const user = await getSessionUser(requestHeaders);
  if (!user) redirect("/login?next=/onboarding");

  const organizations = await getUserOrganizations(user.id);
  const route = resolveOrganization(
    organizations,
    await getActiveOrganizationId(requestHeaders),
  );

  // Already settled: on to the product, and this page is not shown at all.
  if (route.kind === "ready") redirect("/dashboard");
  // The session needs writing, which a Server Component cannot do - see
  // /api/organization/activate. `error` means that route has already tried and
  // failed, so the form below is a better answer than another round trip.
  if (route.kind === "activate" && !error) redirect("/api/organization/activate?next=/dashboard");

  const firstName = user.name.trim().split(/\s+/)[0];
  const returning = route.kind !== "create";

  return (
    <AuthShell
      eyebrow={returning ? "Something went wrong" : "One more step"}
      title={firstName ? `Welcome, ${firstName}` : "Welcome to Docxy"}
      lede={
        returning
          ? "Your organization could not be opened. Sign out and back in to try again, or create a new one below."
          : "Name the organization your repositories will belong to. Working alone is fine - it just means a team of one."
      }
      alt={
        <>
          Everything in Docxy belongs to an organization, so this is the only
          thing standing between you and your first documentation pull request.
        </>
      }
    >
      <CreateOrganization />
    </AuthShell>
  );
}
