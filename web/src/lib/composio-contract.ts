export const COMPOSIO_TOOLKITS = ["slack", "notion", "linear", "jira"] as const;
export type ComposioToolkit = (typeof COMPOSIO_TOOLKITS)[number];

export function isComposioToolkit(value: string): value is ComposioToolkit {
  return COMPOSIO_TOOLKITS.some((toolkit) => toolkit === value);
}

export interface IntegrationAccount {
  id: string;
  toolkit: ComposioToolkit;
  status: string;
  active: boolean;
}

export interface IntegrationScope {
  organizationId: string;
  canManage: boolean;
}

/** Stable organization identity, shared by the dashboard and future workers. */
export function composioUserId(organizationId: string): string {
  if (!organizationId.trim()) throw new Error("An organization is required");
  return `docxy:org:${organizationId}`;
}
