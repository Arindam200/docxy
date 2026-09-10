import { composioHandlers } from "@/lib/composio-handlers";
import { composioConfigured, connectComposioAccount, deleteComposioAccount, listComposioAccounts } from "@/lib/composio";
import { integrationScope } from "@/lib/integration-scope";
import { appUrl } from "@/lib/env";

export const runtime = "nodejs";
export const POST = composioHandlers({
  configured: composioConfigured,
  appUrl,
  scope: integrationScope,
  list: listComposioAccounts,
  connect: connectComposioAccount,
  disconnect: deleteComposioAccount,
}).POST;
