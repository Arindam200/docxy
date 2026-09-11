![demo](/assets/image.png)

# Docxy

[Website](https://docxy.app) · [Issues](https://github.com/Arindam200/docxy/issues) · [License](LICENSING.md)

**Keep documentation and changelogs in sync with your code.**

Docxy turns Git commits into documentation pull requests. It reads the diff,
finds affected documentation, drafts edits and release notes, and validates the
proposal before opening it for review.

Run it locally from the CLI or connect repositories through the GitHub App and
manage them in the dashboard. Documentation can live alongside your code, on
another branch, or in a separate repository.

## How it works

Five agent roles run inside a Mastra workflow:

```text
Git commit → Change Analyst → Impact Mapper
                                   ↓
                       Docs Updater + Changelog Author
                                   ↓
                       Validation → Coordinator → Pull request
```

The analyst classifies the change, the mapper identifies affected sections, and
two writers draft documentation and release notes in parallel. Validation checks
exact edit matches, local links, and version consistency. The coordinator reviews
the result and records any concerns.

- **Focused edits:** replacements must match a unique passage in the existing file.
- **Repository memory:** sessions and symbol mappings carry context across runs.
- **Visible checks:** runs record passed, failed, and skipped validations.
- **Review on GitHub:** failed validation or a coordinator rejection makes the
  proposal a draft PR with reasons attached. Docxy opens PRs; it does not merge them.

Optional documentation commands run in Daytona sandboxes containing the proposed
files. Repository test commands run on the backend host. Checks without a
configured command are reported as skipped.

## Quickstart

Requires **Git**, **Node.js 22.22.3+**, **npm 11+**, and a
[Nebius API key](https://tokenfactory.nebius.com). Model calls use your provider
account. The CLI works without the dashboard or a database.

```bash
git clone https://github.com/Arindam200/docxy.git
cd docxy
npm ci
cp .env.example .env
```

Set `NEBIUS_API_KEY` in `.env`, then run these commands from the Docxy checkout:

```bash
npm run docxy -- doctor
npm run docxy -- run HEAD --repo /absolute/path/to/your/repository
npm run docxy -- show <run-id> --json --repo /absolute/path/to/your/repository
```

Replace `<run-id>` with the ID printed by the run. Proposals are stored locally
in `.docxy/` by default. Configure GitHub App credentials in `.env` to publish
pull requests, and `DAYTONA_API_KEY` plus `DOCXY_DOCS_BUILD_COMMAND` for sandboxed
documentation checks. No separate agent server or model registration is needed.

For automatic runs, configure the signed webhook and connect a repository as a
dashboard project. Installing the GitHub App grants access; connecting a project
selects which repository Docxy documents.

## Dashboard and integrations

The Next.js dashboard provides organizations, projects, run timelines, logs, and
usage insights. Run `npm run serve` from the repository root for the backend.
In a second terminal, run `cd web`, `npm ci`, and `npm run dev` for the dashboard.

Copy `web/.env.local.example` to `web/.env.local` and configure database,
Better Auth, and email settings before using authenticated pages. Both apps
must share `DATABASE_URL` and `DOCXY_API_TOKEN`; set the web app's `DOCXY_API_URL`
to `http://localhost:4317`. Apply `npm run db:migrate` from the root for the
`public` and `billing` schemas and from `web/` for the `auth` schema.

| Component | Purpose |
| --- | --- |
| Mastra | Agent execution, workflows, and memory inside the backend. |
| Nebius | Model inference. |
| Daytona | Sandboxed documentation checks and optional code-mode drafting. |
| GitHub App | Repository access, push webhooks, and documentation PRs. |
| Better Auth, Neon, Resend | Sign-in, persistent data, and account email. |
| Composio | Slack, Notion, Linear, and Jira account connections. |

Composio connection controls are implemented. Notifications, Notion publishing,
and issue automations are not yet implemented.

The maintained deployment uses **Vercel for the dashboard** and **Railway for the
backend**, with a shared Neon database. Both track `main`. The backend reads the
root `.env`; local Next.js reads `web/.env.local`. Hosted deployments use their
platform environment settings.

## Contributing

Contributions are welcome, from a typo fix to a new documentation platform.
Start with [CONTRIBUTING.md](CONTRIBUTING.md) for setup, the checks to run, and
how pull requests are reviewed. Good entry points are the
[good first issue](https://github.com/Arindam200/docxy/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22)
and [help wanted](https://github.com/Arindam200/docxy/issues?q=is%3Aissue+is%3Aopen+label%3A%22help+wanted%22)
issues. Comment on one to claim it.

```bash
# Backend checks, from the repository root
npm run lint
npm run typecheck
npm test

# Dashboard checks
cd web && npm ci && npm run lint && npm run typecheck && npm run build && npm test
```

No check calls a live provider, so they run offline and on a fork. The separate
web `test:billing` command writes to a real database; use a dedicated
development database for it.

Code lives in `src/` (backend and CLI) and `web/` (dashboard). Agent writing
instructions live in `skills/`. Configuration options are documented in the
[backend](.env.example) and [web](web/.env.local.example) environment templates.
Please read the [code of conduct](CODE_OF_CONDUCT.md), and report security
problems through [SECURITY.md](SECURITY.md) rather than a public issue.

## License

Docxy is free software under the [GNU AGPL v3](LICENSE).
Copyright (c) 2026 Arindam Majumder.

Use it for anything, including commercially. If you run a modified Docxy as a
service other people use, the AGPL requires you to offer those users your
modified source. Personal use, internal company use, and contributing carry no
such obligation. Earlier releases under MIT or the
[personal-use license](licenses/PERSONAL-USE-1.0.txt) keep their original terms,
as recorded in [LICENSING.md](LICENSING.md).
