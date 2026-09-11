# Changelog

All notable changes to Docxy are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Relicensed new versions under the GNU AGPL v3 (AGPL-3.0-only), making Docxy
  open source. Commercial use is permitted; running a modified version as a
  network service requires offering its source to that service's users. The
  interim Docxy Personal Use License 1.0 is archived at
  `licenses/PERSONAL-USE-1.0.txt`, and earlier MIT and personal-use grants remain
  unchanged for the versions they shipped with. See
  [LICENSING.md](LICENSING.md).

- Production deployment routing now uses Vercel `docxy` and Railway
  `tender-laughter/docxy`, both connected to `Arindam200/docxy` on `main`.
  The obsolete `refreshing-tenderness/docxy` harness was disconnected from GitHub.
- Mastra runs the five agents inside the backend, with Nebius models and
  Daytona validation. A standalone TrueForge server is no longer part of the
  deployment. The GitHub pull request is the review surface.

### Added

- Contributor documentation and intake: [CONTRIBUTING.md](CONTRIBUTING.md),
  [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md), [SECURITY.md](SECURITY.md),
  [CLA.md](CLA.md), structured issue forms, and a pull request template. A CLA
  check runs on pull requests and records signatures once per contributor.

- Composio account connection setup for Slack, Notion, Linear and Jira, scoped
  to organizations and managed by owners/admins. Automated service workflows
  remain planned; deploying the UI and authorizing accounts are separate steps.
- A shared [connection map](guides/CONNECTIONS.md), contributor/agent deployment
  instructions and a read-only `scripts/check-deploy-targets.mjs` check for
  production routing, matching revisions and service health.

### Original implementation (historical)

- Five-role documentation pipeline on the TrueForge harness: Change Analyst,
  Impact Mapper, Docs Updater, Changelog Author, and Coordinator
- Nebius Token Factory registered as a custom OpenAI-compatible model provider
- One long-lived agent session per role, per repository, so what a role learns on
  one commit carries to the next
- A persistent symbol-to-doc-section map, reused by the Impact Mapper each run
- Pre-review validation: verbatim edit anchors, relative links and in-page
  anchors, semver consistency, plus your own docs-build and test commands
- The docs build runs **inside the harness sandbox** rather than against your
  checkout - it is the one check that executes a command over text a model
  wrote. No third-party account needed: a standalone harness carries its own
  sandbox, and `DAYTONA_API_KEY` switches to a remote one. Every executed check
  records whether it ran in the sandbox or locally
- Graduated approval - one sign-off for routine changes, two different reviewers
  for breaking or public-API changes - with no expiry in either direction
- Timeline UI showing what each role did, with the approval gate inline
- Pull requests opened from a throwaway git worktree, leaving your checkout alone
- GitHub Action gating publication on a protected environment
