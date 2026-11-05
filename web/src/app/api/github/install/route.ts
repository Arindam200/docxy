import { getMemberOrganizationId, getSessionUser } from "@/lib/auth";
import { bindInstallation } from "@/lib/docxy";
import { authorizeInstaller } from "@/lib/github-app";
import { githubInstallationHandlers } from "@/lib/github-installation";
import { getViewerRole } from "@/lib/members-store";

export const GET = githubInstallationHandlers({
  getUser: getSessionUser,
  getOrganization: getMemberOrganizationId,
  getRole: (userId, organizationId) => getViewerRole(organizationId, userId),
  authorize: authorizeInstaller,
  bind: bindInstallation,
}).install;
