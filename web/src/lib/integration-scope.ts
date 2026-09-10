import "server-only";
import { authRequired, getActiveOrganizationId, getSessionUser } from "@/lib/auth";
import { getViewerRole } from "@/lib/members-store";
import type { IntegrationScope } from "./composio-contract";

export async function integrationScope(headers: Headers): Promise<IntegrationScope | null> {
  // The demo has no organization identity to own external credentials.
  if (!authRequired()) return null;
  const user = await getSessionUser(headers);
  if (!user) return null;
  const organizationId = await getActiveOrganizationId(headers);
  if (!organizationId) return null;
  // Recheck membership on every read/mutation, including cached sessions.
  const role = await getViewerRole(organizationId, user.id);
  if (!role) return null;
  return { organizationId, canManage: role === "owner" || role === "admin" };
}
