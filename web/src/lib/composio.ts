import "server-only";
import { Composio } from "@composio/core";
import {
  COMPOSIO_TOOLKITS, composioUserId, isComposioToolkit,
  type ComposioToolkit, type IntegrationAccount,
} from "./composio-contract";

export function composioConfigured(): boolean {
  return Boolean(process.env.COMPOSIO_API_KEY?.trim());
}

function client() {
  const apiKey = process.env.COMPOSIO_API_KEY?.trim();
  if (!apiKey) throw new Error("Composio is not configured");
  return new Composio({ apiKey, disableVersionCheck: true });
}

/** Never return SDK account objects: they may contain provider credentials. */
export async function listComposioAccounts(organizationId: string): Promise<IntegrationAccount[]> {
  const composio = client();
  const userId = composioUserId(organizationId);
  const accounts: IntegrationAccount[] = [];
  let cursor: string | undefined;
  const visited = new Set<string>();
  do {
    const page = await composio.connectedAccounts.list({
      userIds: [userId], toolkitSlugs: [...COMPOSIO_TOOLKITS], limit: 100, cursor,
    }, { signal: AbortSignal.timeout(10_000) });
    for (const account of page.items) {
      if (isComposioToolkit(account.toolkit.slug)) {
        accounts.push({
          id: account.id, toolkit: account.toolkit.slug, status: account.status,
          active: account.status === "ACTIVE" && !account.isDisabled,
        });
      }
    }
    cursor = page.nextCursor || undefined;
    if (cursor && visited.has(cursor)) throw new Error("Repeated Composio cursor");
    if (cursor) visited.add(cursor);
  } while (cursor);
  return accounts;
}

export async function connectComposioAccount(
  organizationId: string, toolkit: ComposioToolkit, callbackUrl: string,
): Promise<string> {
  const authConfig = process.env[`COMPOSIO_AUTH_CONFIG_${toolkit.toUpperCase()}`]?.trim();
  const session = await client().sessions.create(composioUserId(organizationId), {
    toolkits: [toolkit],
    manageConnections: false,
    authConfigs: authConfig ? { [toolkit]: authConfig } : undefined,
  }, { signal: AbortSignal.timeout(10_000) });
  const connection = await session.authorize(toolkit, { callbackUrl });
  if (!connection.redirectUrl) throw new Error("Composio did not return a connection link");
  return connection.redirectUrl;
}

/** Called only after the handler finds this id in the organization's accounts. */
export async function deleteComposioAccount(accountId: string): Promise<void> {
  await client().connectedAccounts.delete(accountId, { signal: AbortSignal.timeout(10_000) });
}
