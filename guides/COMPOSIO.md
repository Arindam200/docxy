# Composio setup

The [shared connection map](CONNECTIONS.md) explains how this fits with Vercel,
Railway, GitHub and Neon. The Composio key was validated and synchronized to
Vercel production and the local web environment on September 11, 2026. Deploy
the connection UI through `main`, then authorize each provider account from
the dashboard; the key alone does not authorize accounts.

Docxy uses Composio to connect an organization's Slack, Notion, Linear, and Jira
accounts from **Dashboard → Integrations**. Composio hosts authentication and
stores the provider credentials. This setup enables account connections and
disconnection; automated notifications, Notion publishing, and issue workflows
are not implemented yet. The GitHub App continues to handle repository access,
push webhooks, and documentation pull requests.

## Configure the web app

Use Node.js 22.22.3 or newer for the web app; the installed Composio SDK requires
it. This setup was built and tested with Node.js 24.19.0. Select a compatible
Node version in the hosting provider's web project settings too.

1. Sign in to the [Composio developer dashboard](https://dashboard.composio.dev/)
   and create or select a project for Docxy. Use separate projects for local
   development and production so their connections stay separate.
2. Copy that project's API key into `web/.env.local`:

   ```dotenv
   COMPOSIO_API_KEY=your-project-api-key
   BETTER_AUTH_URL=http://localhost:3000
   ```

   Keep the existing database, authentication, and pipeline settings. Do not put
   the key in a `NEXT_PUBLIC_` variable, commit it, or send it through chat.
   Restart `npm run dev` from `web/` after changing the environment.
3. For a hosted deployment, set `COMPOSIO_API_KEY` on the **web app** and set
   `BETTER_AUTH_URL` to its public origin, then redeploy. The pipeline service
   does not need this key for account setup.
4. Sign in as an organization owner or admin, open **Integrations**, and click
   **Connect account** on a supported service. Complete Composio's hosted
   authorization flow. It returns to `/dashboard/integrations`.
5. Confirm the card shows **Connected**. The page reads connection status from
   Composio; callback query parameters are never treated as proof of success.
   If authorization was cancelled, the card remains unconnected. Refresh if
   the provider has not finished activating the account yet.

No additional database migration is needed. Connections belong to the stable
Composio user ID `docxy:org:<organization-id>`. Owners and admins manage them;
members can see status. The unauthenticated demo cannot connect accounts.
Switching organizations during a connection flow does not change the connection's
owner: it belongs to the organization that started the flow.

## Optional auth configs

The session uses Composio-managed authentication by default. To use your own
OAuth app or restrict requested scopes, create an auth config for the toolkit
in the same Composio project and set its ID:

```dotenv
COMPOSIO_AUTH_CONFIG_SLACK=ac_...
COMPOSIO_AUTH_CONFIG_NOTION=ac_...
COMPOSIO_AUTH_CONFIG_LINEAR=ac_...
COMPOSIO_AUTH_CONFIG_JIRA=ac_...
```

Configure provider OAuth redirect URIs using the value Composio shows for that
auth config. That provider callback is distinct from Docxy's final return page.
Check Composio's [managed versus custom auth guidance](https://docs.composio.dev/docs/authentication/custom-app-vs-managed-app)
before launching publicly, and grant only the scopes your planned workflow needs.

## Verify and troubleshoot

- Missing key: cards say setup is not enabled and cannot start authorization.
- Invalid key or provider outage: cards say status is unavailable. Existing
  connections are not silently presented as disconnected.
- Missing permissions: a member can view status but cannot connect or disconnect.
- Expired or failed account: disconnect its entry, then connect again.
- Changed organization: refresh the page before submitting an action from an old tab.
- Multiple accounts: each connection can be disconnected separately. A future
  workflow must select an explicit account and destination before executing tools.

`Disconnect` removes that connected account from the Composio project. To revoke
the OAuth application's grant entirely, also use the provider's own app settings.

Local checks, from the repository root:

```bash
node_modules/.bin/tsx --test web/test/composio.test.ts
npm --prefix web run typecheck
npm --prefix web run lint
```

The tests cover organization isolation and HTTP authorization without making
external calls. A real OAuth round trip requires your API key and an interactive
provider login. No notifications or other provider content are sent during setup.

References: [manual account connections](https://docs.composio.dev/docs/authentication/manually-authenticating),
[session configuration](https://docs.composio.dev/docs/configuring-sessions).
