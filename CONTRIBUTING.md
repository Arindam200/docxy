# Contributing to Docxy

Thanks for being here. Docxy turns Git commits into documentation pull requests,
and it gets better every time someone runs it against a repository we have not
seen yet.

You do not need to understand the whole pipeline to help. Fixing a confusing log
line, adding a docs platform, or reporting a run that went wrong are all useful.

- **Browse work:** [open issues](https://github.com/Arindam200/docxy/issues)
- **Good starting points:** [good first issue](https://github.com/Arindam200/docxy/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22)
  and [help wanted](https://github.com/Arindam200/docxy/issues?q=is%3Aissue+is%3Aopen+label%3A%22help+wanted%22)
- **Ask anything:** open a [question issue](https://github.com/Arindam200/docxy/issues/new/choose)

## Before you start writing code

Comment on the issue you want to take so two people do not build the same thing.
If there is no issue yet, open one first and describe the change. For small
fixes such as a typo, a broken link, or a wrong error message, skip straight to
the pull request.

Please keep a pull request to one change. A focused diff gets reviewed in days.
A large one that mixes refactoring with a feature usually stalls.

## Set up your machine

You need **Git**, **Node.js 22.22.3+**, **npm 11+**, and a free
[Nebius API key](https://tokenfactory.nebius.com) for the models. Everything
else is optional.

```bash
git clone https://github.com/Arindam200/docxy.git
cd docxy
npm ci
cp .env.example .env
```

Set `NEBIUS_API_KEY` in `.env`. Every other variable has a working default.
Then confirm your setup:

```bash
npm run docxy -- doctor
```

Run the pipeline against any local repository to see it work end to end:

```bash
npm run docxy -- run HEAD --repo /absolute/path/to/your/repository
npm run docxy -- show <run-id> --repo /absolute/path/to/your/repository
```

Proposals are written to `.docxy/` and no pull request is opened until you
configure GitHub App credentials. If you have no repository handy, run
`npm run demo` to create a small one.

The dashboard is optional and comes last. Do not set it up unless your change
touches `web/`. [guides/LOCAL-SETUP.md](guides/LOCAL-SETUP.md) covers the
database, the GitHub App, and the dashboard in stages.

## Where things live

| Path | What it holds |
| --- | --- |
| `src/agents/` | The five agent roles, their prompts and schemas |
| `src/pipeline/` | Workflow, run state, project memory, applying edits |
| `src/validate/` | Edit anchors, link checks, version consistency |
| `src/git/`, `src/github/` | Diff reading, checkout, pull requests |
| `src/cli.ts`, `src/config.ts` | CLI commands and every environment option |
| `src/server/`, `src/api/` | Backend HTTP server and its API contract |
| `skills/` | Writing instructions the agents follow |
| `web/` | Next.js dashboard |
| `test/selftest.ts` | The backend test suite |
| `guides/` | Setup, deployment, database, and integration guides |

## Run the checks

Run these from the repository root before pushing. They are the same checks CI
runs, so a green local run usually means a green pull request.

```bash
npm run lint
npm run typecheck
npm test
```

If your change touches `web/`:

```bash
cd web
npm ci
npm run lint
npm run typecheck
npm run build
npm test
```

No check calls a live model, a database, or a sandbox, so they work offline and
on a fork. Checks that need a backend they cannot find report themselves as
skipped with a reason, which is expected.

The one exception is `npm run test:billing` in `web/`, which writes to a real
database. Point it at a throwaway development database, never production.

## Open the pull request

1. Branch off `main`. Name it for the change, such as `fix/link-check-anchors`
   or `feat/mintlify-support`.
2. Write a commit message that says what changed and why. One line of summary,
   then detail if it needs it.
3. Add a note to the `## [Unreleased]` section of
   [CHANGELOG.md](CHANGELOG.md) for anything a user would notice.
4. Update the docs your change affects. A new environment variable belongs in
   `.env.example` or `web/.env.local.example` and in `src/config.ts`.
5. Push and open the pull request. Fill in the template, link the issue, and say
   how you tested it.

CI runs lint, types, and tests on every pull request including forks. Maintainer
review comes after CI is green. Expect questions; they are about the code, not
about you.

Please do not commit secrets, `.env` files, build output, or unrelated
formatting changes. Do not add a new dependency without saying in the pull
request why it is needed.

## Style that reviewers look for

- Match the surrounding code. Read the file you are editing before adding to it.
- Prefer a clear name over a comment. Keep comments for the reason behind
  something, not a description of what the next line does.
- Errors should say what failed and what to do next.
- Validation is the safety net of this project. If you change what it accepts,
  add a test that proves the new behaviour.

## Licensing of contributions

Docxy is free software under the [GNU AGPL v3](LICENSE), and that is the only
license it carries. Your contribution is licensed under it too.

Contributors sign a [Contributor License Agreement](CLA.md) once. A bot comments
on your first pull request with a link and the sentence to reply with, so signing
takes one comment and you are never asked again. You keep the copyright in what
you wrote.

If the agreement is a problem for you, say so in the issue before you start
writing code, and we will work out what is possible.

## Reporting something sensitive

Do not open a public issue for a security problem. Follow
[SECURITY.md](SECURITY.md) instead.

## Conduct

Be decent to people. [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) has the details
and tells you how to report a problem.
