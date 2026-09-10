# Shared project context

Read [guides/CONNECTIONS.md](guides/CONNECTIONS.md) before changing integrations,
deployment settings, authentication, environment variables or infrastructure.
It records the verified service map and distinguishes configured credentials
from implemented workflows. Update it when the connections change.

## Deployment targets

- GitHub: `Arindam200/docxy`, production branch `main`.
- Frontend: Vercel project `docxy`, ID `prj_3RMsBtkY6Xhe6XnODSW1M8q1DdyJ`,
  team `arindam-1729`, production URL `https://docxy.app`. Build root is `web/`.
  CLI uploads start from the repository root because the web app imports shared
  files from `src/`. Do not create another Vercel project from inside `web/`.
- Backend: Railway project `tender-laughter`, ID
  `5c333e8f-d5fc-4440-82e8-427386ec0350`; service `docxy`, ID
  `af62c917-dffd-48f3-9b69-87f42b1f7a91`; production environment ID
  `07200c23-c711-4fb6-a65e-09cbd4c22ea6`. It builds the root `Dockerfile` and
  serves `https://docxy-production.up.railway.app`.
- Both production services auto-deploy from `main`. Use explicit project and
  service IDs for CLI operations; do not trust a remembered CLI selection.
- `refreshing-tenderness/docxy` is the retired harness, disconnected from GitHub.
  Do not reconnect it, deploy there, or copy production secrets into it.
- No Render service is part of the verified deployment. A new host is an
  infrastructure change, not a synonym for the existing Railway project.

Run `node scripts/check-deploy-targets.mjs` after deployment changes. It checks
the provider links, production settings, revisions and health without printing
secrets. See [guides/DEPLOY.md](guides/DEPLOY.md) for operations.

## Connection boundaries

- The dashboard reads `web/.env.local` locally and Vercel environment settings
  in production. The backend reads its own environment. Root `.env` does not
  configure Next.js in `web/`.
- Vercel and Railway must share `DOCXY_API_TOKEN` and the environment's
  `DATABASE_URL`. Keep credentials server-side and out of logs, commits and docs.
- Mastra runs inside the backend. Nebius supplies models; Daytona supplies
  sandboxes. There is no standalone TrueForge server.
- The GitHub App handles repository access, push webhooks and documentation PRs.
  Composio handles organization account connections for Slack, Notion, Linear
  and Jira. Those connection controls do not yet implement their automations.
- Connection metadata in the UI must not claim a provider workflow is active
  just because an API key or OAuth account exists.
- Neon has `public`, `auth` and `billing` schemas. Root migrations own `public`
  and `billing`; web migrations own `auth`. Do not run a migration from the
  wrong package or silently migrate production during a deployment check.

For web changes, also follow [web/AGENTS.md](web/AGENTS.md), including reading
the installed Next.js documentation before using its APIs.
