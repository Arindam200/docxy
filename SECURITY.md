# Security policy

## Reporting a vulnerability

Please do not open a public issue, pull request, or discussion for a security
problem.

Report it privately through
[GitHub security advisories](https://github.com/Arindam200/docxy/security/advisories/new).
That reaches the maintainer directly and keeps the details private until a fix
is out. If advisories are unavailable to you, contact
[@Arindam200](https://github.com/Arindam200) on GitHub and ask for a private
channel before sharing any detail.

Include what you can: affected version or commit, the steps to reproduce, the
impact you believe it has, and anything needed to confirm it. You will get an
acknowledgement within a few days. This is a small project, so please allow
reasonable time for a fix before disclosing publicly.

## In scope

- The agent pipeline, validation, and anything that reaches a repository's files
- The CLI and the backend API, including the `DOCXY_API_TOKEN` boundary
- The GitHub App and the signed push webhook
- The dashboard, its authentication, and its database access
- Sandbox escape from documentation or test command execution
- Prompt injection that makes an agent exceed its intended authority, such as
  writing outside the documentation scope or exfiltrating secrets

## Out of scope

- Vulnerabilities in third-party services such as Nebius, Daytona, GitHub,
  Vercel, Railway, or Neon. Report those to them.
- Findings that need credentials or access you were never meant to have
- Missing hardening with no demonstrated impact, and automated scanner output
  without a working reproduction
- Denial of service through volume alone

## Handling your own secrets

Docxy needs provider keys, a GitHub App private key, and database credentials.
Keep them in `.env` and `web/.env.local`, which are gitignored, or in your host's
environment settings. Never commit them, paste them into an issue, or include
them in logs attached to a report. If you expose a key, rotate it with the
provider first and then tell us what happened.
