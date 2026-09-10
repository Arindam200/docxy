import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { Page, PageHead } from "@/components/dashboard/Page";
import { MembersPanel } from "@/components/dashboard/MembersPanel";
import { getSessionUser } from "@/lib/auth";
import { emailReady } from "@/lib/env";
import { activeOrganizationId } from "@/lib/organization";
import { canManageMembers } from "@/lib/members";
import { getMembers, getPendingInvitations, getViewerRole } from "@/lib/members-store";

export const dynamic = "force-dynamic";

/**
 * Who is in this organization, and who has been asked to join.
 *
 * Everything an organization owns is shared by everyone in it - the connected
 * repositories, their diffs, the drafted documentation, the run history - so
 * this page is the one that says who "everyone" is. It is readable by every
 * member for that reason, and editable only by owners and admins.
 */
export default async function MembersPage() {
  const organizationId = await activeOrganizationId();
  const user = await getSessionUser(await headers());
  // The dashboard layout already refuses an unsigned request, so this is the
  // narrow window where a session ended between the layout and this page.
  if (!user) redirect("/login?next=/dashboard/members");

  const [role, members, invitations] = await Promise.all([
    getViewerRole(organizationId, user.id),
    getMembers(organizationId),
    getPendingInvitations(organizationId),
  ]);

  // Membership is checked here rather than inferred from the session's active
  // organization, which can name one the account has since been removed from.
  if (!role) redirect("/api/organization/activate?next=/dashboard/members");

  return (
    <Page>
      <PageHead
        title="Members"
        lede="Everyone here can see this organization's repositories, runs, and drafted documentation."
      />
      <MembersPanel
        members={members}
        invitations={invitations}
        viewerId={user.id}
        viewerRole={role}
        canManage={canManageMembers(role)}
        /* Invitations are an email or they are nothing: there is no in-product
           inbox to fall back on, so a deployment that cannot send mail must say
           so rather than accept an invitation that silently goes nowhere. */
        canSendEmail={emailReady()}
      />
    </Page>
  );
}
