import { headers } from "next/headers";
import Link from "next/link";
import { fetchInstructions } from "@/lib/docxy";
import { getSessionUser } from "@/lib/auth";
import { authReady } from "@/lib/env";
import { activeOrganizationId } from "@/lib/organization";
import { Page, PageHead } from "@/components/dashboard/Page";
import { InstructionsEditor } from "@/components/dashboard/InstructionsEditor";
import { ProfileSettings } from "@/components/dashboard/ProfileSettings";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const organizationId = await activeOrganizationId();
  const [instructions, user] = await Promise.all([
    fetchInstructions(organizationId),
    authReady() ? getSessionUser(await headers()) : null,
  ]);

  return (
    <Page>
      <PageHead title="Settings" lede="Manage your profile and the instructions Docxy follows." />

      <section aria-labelledby="profile-heading" className="space-y-3">
        <div>
          <h2 id="profile-heading" className="text-lg font-semibold">Profile</h2>
          <p className="mt-1 text-sm text-muted">Your personal account details, shared across your organizations.</p>
        </div>
        {user ? (
          <ProfileSettings key={user.id} user={{ id: user.id, name: user.name, email: user.email }} />
        ) : (
          <p className="border border-rule bg-surface p-5 text-sm text-muted">
            <Link href="/login?next=/dashboard/settings" className="focus-ring text-accent hover:underline">Sign in</Link> to manage your profile.
          </p>
        )}
      </section>

      <section id="instructions" aria-labelledby="instructions-heading" className="space-y-3 scroll-mt-6">
        <div>
          <h2 id="instructions-heading" className="text-lg font-semibold">Custom instructions</h2>
          <p className="mt-1 text-sm text-muted">
            Set the tone, terminology, and content to preserve in every draft. These instructions apply to all projects in this organization from the next run.
          </p>
        </div>
        {instructions ? (
          <InstructionsEditor key={organizationId} initial={instructions.instructions} updatedAt={instructions.updatedAt ?? null} />
        ) : (
          <p role="status" className="border border-rule bg-surface p-5 text-sm text-muted">
            Custom instructions could not be loaded. Refresh the page to try again.
          </p>
        )}
      </section>
    </Page>
  );
}
