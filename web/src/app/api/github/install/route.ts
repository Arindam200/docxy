import { getActiveOrganizationId, getSessionUser } from "@/lib/auth";
import { bindInstallation } from "@/lib/docxy";
import { authorizeInstaller } from "@/lib/github-app";
import { githubInstallationHandlers } from "@/lib/github-installation";

export const GET = githubInstallationHandlers({
  getUser: getSessionUser,
  getOrganization: getActiveOrganizationId,
  authorize: authorizeInstaller,
  bind: bindInstallation,
}).install;
