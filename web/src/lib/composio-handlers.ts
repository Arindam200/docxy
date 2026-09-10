import {
  isComposioToolkit, type ComposioToolkit, type IntegrationAccount, type IntegrationScope,
} from "./composio-contract";

interface Dependencies {
  configured: () => boolean;
  appUrl: () => string | undefined;
  scope: (headers: Headers) => Promise<IntegrationScope | null>;
  list: (organizationId: string) => Promise<IntegrationAccount[]>;
  connect: (organizationId: string, toolkit: ComposioToolkit, callbackUrl: string) => Promise<string>;
  disconnect: (accountId: string) => Promise<void>;
}

function problem(error: string, status: number) {
  return Response.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
}

export function composioHandlers(deps: Dependencies) {
  return {
    async POST(request: Request): Promise<Response> {
      try {
        const origin = new URL(deps.appUrl() ?? request.url).origin;
        if (request.headers.get("origin") !== origin) return problem("Invalid request origin.", 403);
        const scope = await deps.scope(request.headers);
        if (!scope) return problem("Sign in to an organization to manage connections.", 401);
        if (!scope.canManage) return problem("Only owners and admins can manage connections.", 403);
        if (!deps.configured()) return problem("Composio has not been configured on this deployment.", 503);

        const form = await request.formData();
        // A stale tab must not mutate the organization selected in another tab.
        if (form.get("organizationId") !== scope.organizationId) {
          return problem("Your organization changed. Refresh this page and try again.", 409);
        }
        const toolkit = String(form.get("toolkit") ?? "");
        if (!isComposioToolkit(toolkit)) return problem("Unsupported integration.", 400);
        const action = form.get("action");
        if (action === "connect") {
          const url = await deps.connect(scope.organizationId, toolkit, `${origin}/dashboard/integrations`);
          const target = new URL(url);
          if (target.protocol !== "https:" || target.hostname !== "connect.composio.dev") {
            return problem("The provider returned an invalid connection link.", 502);
          }
          return Response.json({ redirectUrl: target.toString() }, { headers: { "Cache-Control": "no-store" } });
        }
        if (action === "disconnect") {
          const accountId = form.get("accountId");
          const accounts = await deps.list(scope.organizationId);
          if (!accounts.some((account) => account.id === accountId && account.toolkit === toolkit)) {
            return problem("Connection not found in this organization.", 404);
          }
          await deps.disconnect(String(accountId));
          return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
        }
        return problem("Unsupported action.", 400);
      } catch {
        // Provider errors may include credentials or account metadata.
        return problem("Could not update the connection. Refresh and try again.", 502);
      }
    },
  };
}
