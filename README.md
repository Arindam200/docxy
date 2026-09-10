![demo](assets/image.png)

# Docxy

A multi-agent documentation-and-changelog pipeline built on
[Mastra](https://mastra.ai), with models served by
[Nebius Token Factory](https://tokenfactory.nebius.com) and validation run in a
[Daytona](https://daytona.io) workspace.

Every push to `main` wakes five specialists. One classifies what changed. One
traces which docs and downstream code the change actually touches. Two draft the
edits - reference docs and release notes, in deliberately different voices. The
last reviews their work before anything is published. Everything is validated
first, and **a proposal that fails those checks opens as a draft that says why,
never as a clean pull request.**

**→ [Watch the three-minute demo](#demo-video)** - a commit landing, five roles
reacting, the docs build executing inside the harness sandbox, and two people
signing it off before anything is published.

**→ [Set it up locally](guides/LOCAL-SETUP.md)** - from nothing to a
documentation pull request on your own repository. The repository is public and
MIT-licensed; a clone and a Nebius API key are the whole prerequisite list, and
everything runs on your machine: docxy on `:4317` and the dashboard on `:3000`.

**→ [Check the harness did the work](#the-harness-is-doing-the-work-and-you-can-check)**
- the session and turn ids every run records, and the session store that
confirms them independently of anything docxy wrote down.

**→ [Read a pull request it opened](https://github.com/Arindam200/docxy-demo/pull/14)**
- drafted by the agents, validated before review, published only after two
distinct sign-offs. Fourteen of them exist on that repository, all authored by
`docxy-bot[bot]`.

---

## Demo video

The recorded demo link is pending. See the [demo walkthrough](guides/DEMO.md).

| Time | What you see |
|---|---|
| 0:00–0:25 | A documentation page that is now wrong, and the commit that falsified it |
| 0:25–1:15 | One commit in - five roles reporting out on the timeline |
| 1:15–1:50 | The docs build **executing inside the harness sandbox**, and the `sandbox` badge on the validation report |
| 1:50–2:25 | The gate - the same reviewer signing twice is refused, a second person is required, then the pull request opens |
| 2:25–3:00 | A second commit reusing what the first learned: *session reused*, symbols carried in |

Every command in it is written down in [guides/DEMO.md](guides/DEMO.md), and
every transcript in that guide came from a run against a live harness.

---

## Why this, and not something that already exists

| Existing tool | What it does | Where it stops |
|---|---|---|
| [Swimm](https://swimm.io) | Watches commits, auto-syncs doc snippets | One flat pass - no impact-mapping step, no changelog, nothing validated before it lands |
| [Mintlify automate-agent](https://www.mintlify.com/docs/guides/automate-agent) | GitHub Action → hosted agent job → docs PR | Closest structural precedent, but one proprietary job tied to one platform - no open harness, no changelog, no validation step |
| semantic-release / Release Please | Generate changelogs from commit messages | Reads intent from the commit message, not the diff - brittle when commit hygiene slips, blind to downstream impact |
| Dependency-graph / blast-radius tools | Trace what a change affects | Produce a report a human still has to act on - not wired into anything that drafts and gates a fix |

Every existing tool owns one slice as a single flat pass. Nobody chains
*classify → map impact → draft docs → author changelog → validate → gate behind
approval* as cooperating specialists with distinct judgment. That is the shape
this project builds.

---

## How it works

```
                          push to main
                               │
                               ▼
                    ┌──────────────────────┐
                    │    Change Analyst    │  breaking / feature / fix / chore
                    │  breaking-change-    │  public-api / internal / config / test
                    │      policy          │
                    └──────────┬───────────┘
                               ▼
                    ┌──────────────────────┐
                    │    Impact Mapper     │  which doc sections went stale,
                    │  impact-map-hints    │  which downstream code follows
                    └──────────┬───────────┘
                               │
                 ┌─────────────┴─────────────┐
                 ▼                           ▼
      ┌────────────────────┐      ┌────────────────────┐
      │   Docs Updater     │      │  Changelog Author  │
      │    docs-style      │      │  changelog-voice   │
      │ instructional prose│      │  terse release note│
      └─────────┬──────────┘      └─────────┬──────────┘
                └─────────────┬─────────────┘
                              ▼
                    ┌──────────────────────┐
                    │      Validation      │  anchors resolve · links resolve
                    │   (docs build in a   │  semver consistent · tests
                    │        sandbox)      │  docs build runs in the sandbox
                    └──────────┬───────────┘
                               ▼
                    ┌──────────────────────┐
                    │     Coordinator      │  rejects inconsistent work,
                    │                      │  writes the human summary
                    └──────────┬───────────┘
                               ▼
                    ┌──────────────────────┐
                    │    Approval gate     │  routine = 1 sign-off
                    │                      │  elevated = 2, different people
                    └──────────┬───────────┘
                               ▼
                        pull request
```

### The five roles

| Role | Job | Skill pack |
|---|---|---|
| **Change Analyst** | Classifies the diff; extracts the plain-language what and why | `breaking-change-policy` |
| **Impact Mapper** | Finds which doc sections and downstream files the change touches | `impact-map-hints` |
| **Docs Updater** | Drafts the smallest edit that makes each section correct | `docs-style` |
| **Changelog Author** | Writes one user-facing entry and proposes a semver bump | `changelog-voice` |
| **Coordinator** | Reviews all four, rejects inconsistent work, writes the summary | - |

Run `docxy roles` to see the roster with its current model assignments.

---

## The harness is doing the work, and you can check

Nothing in this section rests on a claim in this README. Every item is
verifiable from a checkout, and most of it from outside docxy entirely.

**Five real Mastra threads, one per role.** Every run records the thread
and turn id each role used:

```bash
npx tsx src/cli.ts show <run-id> --json --repo .demo-repo \
  | jq -r '.traces[] | "\(.role)\t\(.sessionId)\t\(.turnId)"'
```

Then check the session store, which is written from the other side and knows
nothing about what a run recorded:

```bash
jq -r 'to_entries[] | .value | to_entries[] | "\(.key)\t\(.value)"' .docxy/sessions.json
```

```
change-analyst      01m0vv5mz68rj0kngs63an30ph
impact-mapper       01m0vv5q13227p7hbn1c8fhbpf
docs-updater        01m0vv5ty923xc8h6qzth4fyjx
changelog-author    01m0vv5tya9jf5171ktc1pzd56
coordinator         01m0vv5xg3vrp6zj4zhrvwyptq
```

Five ids, one per role, and the same five on the next commit - that is the reuse.
With `DATABASE_URL` set they live in `agent_sessions` instead, where a `turns`
column counts how many commits each session has carried.

**The docs build executes in a sandbox.** Not a description of the
proposal - a command run over prose a model finished writing a minute earlier,
in a fresh sandbox that receives the proposed files and nothing else. Every
executed check records **where** it ran, and the run refuses to quietly fall
back to this host:

```bash
npx tsx src/cli.ts show <run-id> --json --repo .demo-repo \
  | jq -c '.validation.checks[] | {name, status, where}'
```

```json
{"name":"edits-apply","status":"pass"}
{"name":"link-check","status":"pass"}
{"name":"semver-consistency","status":"pass"}
{"name":"docs-build","status":"pass","where":"sandbox"}
```

Only the checks that *execute* something carry a `where`; the ones that merely
read the proposal have nothing to isolate. The dashboard renders that field as a
badge on the run detail page, so the distinction is visible on camera and not
only in the record.

**It reaches a real tool.** A GitHub App - not a personal token - opens the pull
request from a throwaway worktree.
[Fourteen pull requests](https://github.com/Arindam200/docxy-demo/pulls?q=is%3Apr)
on the demo repository were opened this way, authored by `docxy-bot[bot]`. Each
carries the classification, the changelog entry, the validation report and the
sign-offs in its body -
[#14](https://github.com/Arindam200/docxy-demo/pull/14) is a fair example.

**It records what scrutiny it judged the change to need.** A docs-only fix is
routine; anything breaking, touching documented public API, or proposing a major
bump is elevated, and the pull request body says which and why. The Coordinator
can escalate that judgement and never relax it.

**The prose is the model's, not a hand-edit.** `applyDocEdits` requires the
model's `find` string to appear in the target file **verbatim, exactly once**. A
paraphrase fails with `anchor-not-found`, an ambiguous match with
`anchor-ambiguous`. An edit the model did not quote from the real file cannot be
applied, which is what makes `✓ edits-apply` a claim rather than decoration.

[guides/DEMO.md](guides/DEMO.md) has the commands for each of these, and the
transcripts they produced.

---

## How Mastra is used

| Capability | What docxy does with it | Where |
|---|---|---|
| Model router | Nebius is a first-class provider, so a role names an upstream id directly - `nebius/deepseek-ai/DeepSeek-V4-Pro` - with no provider to register anywhere | `src/config.ts` |
| Structured output | Each role's contract is a Zod schema the provider enforces through native `response_format`. A turn cannot return prose, a missing field, or a fifth value for a four-value enum | `src/agents/schemas.ts` |
| Threads and memory | One long-lived thread per role, per repository, backed by Postgres or a local LibSQL file. The thread id carries a hash of the agent's configuration, so editing a prompt starts a new thread instead of silently doing nothing | `src/runtime/mastra.ts` |
| Working memory | Resource-scoped to the repository, under a Zod schema, so one record spans every role, every thread and every commit. It is **not** agent-managed: `agentManaged: false` means no role is given a tool to write it, and the counters in it are folded from what finished runs recorded | `src/pipeline/project-memory.ts` |
| Workspaces | The docs build runs in a Daytona sandbox with egress denied: files are uploaded over the SDK and the exit code is the process's own, so nothing about the result rests on a model's account of it | `src/validate/workspace.ts` |
| Code Mode | Optional drafting path (`DOCXY_CODE_MODE`): the Docs Updater writes one TypeScript program that is handed the impacted docs as data and returns the bytes it found as each anchor, instead of reproducing them from memory. The program runs in a Daytona workspace - no host filesystem, egress denied - and a missing key is an error, not a fall back onto the deployment; `DOCXY_CODE_MODE_SANDBOX=local` is the development setting | `src/pipeline/code-mode.ts` |
| Server adapter | `MastraServer` mounts into the existing Hono app behind the same `DOCXY_API_TOKEN` guard, so there is no second agent server to run | `src/server/index.ts` |

There is no harness service. The five agents run inside the API process, and the
only thing that leaves the machine is a model call and a sandbox.

---

## Three design decisions worth explaining

### 1. One session per role, per repository - so state accumulates

Instead of one thread per commit, **each role holds its own long-lived Mastra
thread per repository**, and the orchestration order lives in code.

That is not a workaround - it is the better shape for this problem. What a role
learns on one commit is still there for the next one. Alongside the sessions, a
`symbol → doc-section` map is persisted to disk and handed to the Impact Mapper
on every run, so it reuses what it already worked out instead of re-deriving it.

Two commits' worth of thread is not the same thing as knowing the repository,
though, and the difference is what **project memory** holds: resource-scoped
Mastra working memory, keyed to the repository rather than to a thread, counting
how often each doc file's proposed edits actually applied. Where anchoring keeps
failing - the transcript-heavy files, mostly - the next run is told so, in
numbers, before it drafts. `docxy memory` prints the record and `docxy memory
--prompt docs-updater` prints the exact text a role is handed.

The model never writes a word of it. Mastra's default is to hand the agent an
`updateWorkingMemory` tool, and this repository has already paid for
model-authored memory reaching a role that must quote exactly: the Docs Updater
once anchored on a README paragraph deleted twenty minutes earlier, which was in
no prompt it was given. So working memory is declared `agentManaged: false`, no
role is given the tool, and every number in the record is folded from what a
finished run recorded - reproducible, free, and checkable, which is what the
scorers in `src/evals/` insist on for the same reason. It is also why the Docs
Updater, which carries no thread at all, can still be given it: counters about
a file carry none of the file's text.

The timeline marks each role **"session reused"** when this happens. Running the
pipeline on two commits back to back makes the payoff visible:

```bash
npm run demo                                    # builds a 2-commit demo repo
npx tsx src/cli.ts run HEAD~1 --repo .demo-repo # first: learns the repo
npx tsx src/cli.ts run HEAD   --repo .demo-repo # second: reuses what it learned
```

### 2. Validation runs before a human sees anything

The most common failure mode of an LLM editing prose is quoting text that isn't
there. So the first validation check is the strictest: **every proposed edit
must anchor to text that appears verbatim, exactly once**, in the real file. A
paraphrased anchor is caught and the run fails rather than producing a broken
patch.

On top of that: relative links and in-page anchors must resolve, and a `breaking`
classification paired with anything below a `major` bump is rejected as
internally inconsistent. Your repo's own docs-build and test commands run too,
if you configure them.

The checks divide by who wrote what they run over. Anchors, links and semver
consistency only *read* the proposed text. The docs build **executes** it - a
command, over prose a model finished writing a minute earlier - so that one runs
**inside the harness sandbox**, never against your checkout. A run stages the
proposal into a fresh sandbox, builds it there, and reports the exit code back:

```
validation
  ✓ edits-apply         3 file(s) patched cleanly
  ✓ link-check          no broken relative links or anchors
  ✓ semver-consistency  breaking -> major
  ✓ docs-build          markdown files: 4 | unbalanced fences: []
```

Which of those ran where is recorded rather than printed: `docxy show <run-id>
--json` carries a `where` of `sandbox` or `local` on every executed check, and
the dashboard shows it as a badge.

**This needs no third-party account.** A harness started with
A Daytona workspace runs the build - a container
confinement on macOS, a bubblewrap namespace on Linux, both with an allow-listed
filesystem and allow-listed network egress. That is where the build runs by
default. Set `DAYTONA_API_KEY` and run `docxy setup` to use a remote Daytona
sandbox instead; the run names which one it used, and `docxy doctor` tells you
before a run does.

**The sandbox receives the proposed files and nothing else.** Not the repository,
not `package.json`, not `node_modules`. So `DOCXY_DOCS_BUILD_COMMAND` has to be a
command that works on markdown alone - a linter, a fence or front-matter check, a
link checker. A full site build (`mkdocs build`, `npm run docs:build`) needs a
tree that is not there and will report that it could not run. That is a real
limit of this design, not an oversight: shipping the whole checkout into a
sandbox on every commit costs more than the check is worth, and the check that
matters - does the *proposed prose* hold up - does not need it.

**If the sandbox cannot run it, the build is reported unvalidated.** It does not
quietly run here instead. An isolation boundary that disappears when nobody is
watching is not one, so the check fails, says why, and the proposal opens as a
draft carrying the reason. `DOCXY_SANDBOX_FALLBACK=local` opts into host
execution for operators who would rather have the coverage, and the report then
tags the check `local` instead of `sandbox`.

Your own test suite is the exception, and stays on the host on purpose: it is
your code, not the proposal's, already trusted enough to be checked out, and it
needs the whole working tree.

### 3. The pull request is the gate - and a graduated one is there if you want it

By default a run signs itself off and opens the pull request. That is not an
absence of review; it is review in the place teams already do it. Nothing merges
without someone approving it on GitHub, and a pipeline that stops short of
opening anything reviews nothing at all - it goes quiet instead.

What that default protects is the *quality* of what gets opened. A proposal the
Coordinator rejected, or one that failed validation, still opens - as a **draft
with the reasons at the top of the body**. A stalled run tells nobody anything;
an unmergeable draft tells them exactly what went wrong.

The scope is recorded on the run and in the pull request body:

- **Routine** - a docs-only fix.
- **Elevated** - anything classified breaking, touching documented public API, or
  proposing a major version bump.

### In CI, GitHub holds the job

The strongest version of the gate is not docxy's own - it is the one the
pipeline cannot talk its way past. [`.github/workflows/docxy.yml`](.github/workflows/docxy.yml)
splits the work in two: one job drafts and validates the proposal, and a second,
separate job opens the pull request. The second declares

```yaml
publish:
  needs: propose
  if: needs.propose.outputs.status == 'approved'
  environment: docxy-approval    # protected: required reviewers
```

The propose job is given no GitHub App credentials at all, which is what makes
the split hold rather than merely describe itself: the pipeline publishes on its
own whenever it can, so the thing standing between a model and an open pull
request is that the job it runs in has no identity to open one with.

A protected environment means **GitHub** suspends the job until a named human
clicks approve. Not the agent, not this codebase, not a flag someone can flip in
a config file - the CI platform, outside the process being gated. Nothing
auto-approves it and nothing expires into approval. Set that environment's
required reviewers to 2 and enable *prevent self-review*, and an elevated run
needs two different people at the infrastructure level as well as at docxy's.

That is the shape worth copying: the agent proposes in one job, and the
authority to publish lives in another that the agent cannot reach.

---

## Getting started

The five-minute version is below. For the whole thing - GitHub App, Postgres,
the dashboard, webhooks, and what to do when a role fails - see
**[guides/LOCAL-SETUP.md](guides/LOCAL-SETUP.md)**.

### Prerequisites

- Node 20.11+
- A [Nebius Token Factory](https://tokenfactory.nebius.com) API key
- Optionally a [Daytona](https://app.daytona.io) API key, to run the docs build
  in a remote sandbox. Without one the build is reported unvalidated rather than
  run on your machine.

### 1. Clone it

The repository is public - no access request, no waitlist.

```bash
git clone https://github.com/Arindam200/docxy.git
cd docxy
```

### 2. Configure

```bash
npm install
cp .env.example .env
# put your NEBIUS_API_KEY in .env
```

Two more are worth setting before the first run, because their absence is silent
rather than loud: `DOCXY_DOCS_BUILD_COMMAND`, without which the docs build is
skipped and the sandbox never appears in the validation report.

### 3. Register Nebius

```bash
npx tsx src/cli.ts setup
```

This registers Token Factory as a custom OpenAI-compatible provider and verifies
that every model the roster wants actually resolves.

Four models are registered: `deepseek-v4-pro` (the default for all five roles -
1M context and structured-output support, which matters because every role must
emit strict JSON), plus `deepseek-v4-flash`, `kimi-k3`, and `qwen3-5` as
alternatives. A short visible response is not a reason to use a weaker model:
the Changelog Author has previously exhausted a turn in a Flash repetition loop.

**Model ids move.** Check yours and adjust `.env` if `setup` reports anything
unresolvable:

```bash
npx tsx src/cli.ts models     # what your account can actually serve
npx tsx src/cli.ts doctor     # harness, key, repo, and per-role model check
```

### 4. Run it

```bash
npx tsx src/cli.ts run HEAD
```

The pipeline prints the classification, the proposed edits, and the changelog
entry. With the GitHub App configured it then opens the pull request; without
one it stops there, because there is no identity to publish as -
[guides/GITHUB-APP.md](guides/GITHUB-APP.md) sets that up.

The proposal is written to a branch **in a throwaway git worktree**, so your
checkout, index, and current branch are never touched.

### 5. Look at what it did

```bash
npx tsx src/cli.ts runs           # recent runs
npx tsx src/cli.ts show <run-id>  # one run, role by role
npx tsx src/cli.ts serve          # timeline UI on http://localhost:4317
```

Publishing can fail on its own - an expired token, a branch that already exists.
The proposal is kept, so it can be opened without re-running five agents:

```bash
npx tsx src/cli.ts publish <run-id>
```

---

## Commands

| Command | What it does |
|---|---|
| `setup` | Register Nebius Token Factory with the harness |
| `doctor` | Check the harness, the key, the repo, and every role's model |
| `models` | List models your Nebius account can serve |
| `run [commit]` | Run the pipeline (default `HEAD`) |
| `runs` | List recent runs |
| `show <run-id>` | Show one run in detail (`--json` for the full record) |
| `approve <run-id> --by NAME` | Sign off; opens the PR once fully approved |
| `deny <run-id> --by NAME --reason TEXT` | Reject the proposal |
| `serve` | Timeline UI and approval server |
| `reset [--sessions] [--knowledge]` | Clear accumulated state for this repo |
| `roles` | Describe the agent roster |

Add `--repo PATH` to point any command at a different repository.

---

## Skill packs

Four packs in [`skills/`](skills/) carry the judgment that would otherwise be
buried in prompts - what counts as breaking, how to trace impact, the docs voice,
the changelog voice. They are plain `SKILL.md` files, injected into each role's
instructions at session creation.

They're written in the portable `SKILL.md` format, so they can be promoted
to real harness skills (`DOCXY_USE_HARNESS_SKILLS=true`) once this repo is
public. Inlining is the default because it keeps a role's judgment visible in
this repository rather than in harness configuration - and because the two are
now independent settings, turning it on or off says nothing about where
validation executes.

**Editing a skill pack is the intended way to tune the pipeline for your repo** -
start with `skills/breaking-change-policy/SKILL.md`.

---

## Project layout

```
src/
  agents/roles.ts        the five role definitions and their prompts
  agents/parse.ts        tolerant JSON extraction from model output
  git/diff.ts            commit → structured diff (handles root and merge commits)
  git/repo.ts            doc discovery and outline building
  git/worktree.ts        materializes the docs branch as a second worktree
  runtime/mastra.ts      the five agents, their threads, and turn accounting
  pipeline/context.ts    retry policy, coalescing writes, trace bookkeeping
  validate/workspace.ts  the docs build, in a Daytona sandbox
  pipeline/index.ts      the orchestrator
  pipeline/state.ts      the persistent symbol → doc-section map
  pipeline/apply.ts      edit application and changelog splicing
  validate/              anchor, link, and consistency checks
  approval/gate.ts       graduated scope, multi-party sign-off, staleness
  github/pr.ts           worktree-isolated branch and PR creation
  server/                timeline UI and approval endpoints
skills/                  the four skill packs
test/selftest.ts         303 checks over the pure logic, with no network and no model
```

## Tests

```bash
npm test          # 303 checks, no network and no model
npm run typecheck
npm run lint
```

What they cover: parsing and schemas, edit application and changelog splicing,
link and consistency checks, the approval gate, the API's auth and repository
allowlists, sandbox execution, validation that never reads as validated when it
was not, GitHub App credentials, session rotation, the secret guardrail, anchor
repair, project memory, and code mode - including a real program run in a local
sandbox, which is skipped with a printed reason where no isolation backend
exists.

That suite deliberately touches nothing outside the process. The one that
exercises the real services is separate, costs about twenty cents, and opens no
pull request:

```bash
npx tsx scripts/smoke.ts
```

## Docs on their own branch

Plenty of repositories keep documentation on a separate branch - a `docs` branch
that a site builds from, with no application code on it at all. Set:

```bash
DOCXY_DOCS_BRANCH=docs
```

and the pipeline splits its two trees:

| Read from | Used for |
|---|---|
| the pushed commit on the code branch | the diff the Change Analyst classifies |
| a throwaway worktree at `docs`'s tip | the doc outline, the excerpts, the edits, the changelog |

Pull requests then target `docs` rather than the code branch. Your checkout is
never touched - the docs tree is a detached worktree in a temp directory, torn
down when the run ends, so this works even if you already have `docs` checked out
somewhere else.

The branch has to exist first; docxy will not create it. If it is missing, the
run stops with the command to create it rather than quietly documenting the wrong
tree. Leave `DOCXY_DOCS_BRANCH` unset and everything stays in one tree as before.

## Configuration

Every knob is an environment variable, all documented in
[`.env.example`](.env.example) - model per role, docs branch, docs roots,
changelog path, validation commands, retry and timeout budgets, session
rotation, staleness threshold, base branch, port.

[guides/LOCAL-SETUP.md](guides/LOCAL-SETUP.md) covers the ones worth knowing
early, and what to change when a role starts failing.

## Guides

| | |
|---|---|
| [LOCAL-SETUP.md](guides/LOCAL-SETUP.md) | From nothing to a documentation pull request on your own repository |
| [DEPLOY.md](guides/DEPLOY.md) | Standing it up as a service, so a push documents itself with nobody at a terminal |
| [GITHUB-APP.md](guides/GITHUB-APP.md) | Registering the App, so pull requests open as a bot and not as you |
| [DATABASE.md](guides/DATABASE.md) | Moving runs, sessions and the symbol map from JSON to Postgres |
| [OBSERVABILITY.md](guides/OBSERVABILITY.md) | What each run records, and how the dashboard derives the rest |
| [DOCS-INTEGRATIONS-PLAN.md](guides/DOCS-INTEGRATIONS-PLAN.md) | Direct Mintlify, Docusaurus, Fern, GitBook and Read the Docs integration plan |
| [LIVE-UPDATES-PLAN.md](guides/LIVE-UPDATES-PLAN.md) | Remaining dashboard streaming, tenant isolation and organization UI work |
| [PRICING.md](guides/PRICING.md) | Proposed Free, Pro and Team tiers, hosted costs and usage allowances |
| [TEAM-PRICING-PLAN.md](guides/TEAM-PRICING-PLAN.md) | Market research, five included Team seats, additional-seat pricing and collaboration requirements |
| [DODO-PAYMENTS-PLAN.md](guides/DODO-PAYMENTS-PLAN.md) | Planned checkout, subscriptions, seat billing and payment lifecycle handling |
| [ABUSE-PREVENTION-PLAN.md](guides/ABUSE-PREVENTION-PLAN.md) | Planned rate limits, account protections, execution budgets and shared spending controls |
| [DEMO.md](guides/DEMO.md) | Recording the demo, with commands that have been run for real |
| [WRITEUP.md](guides/WRITEUP.md) | What this is and how it uses the harness - the submission writeup |
| [SUBMISSION.md](guides/SUBMISSION.md) | The hackathon audit: what was missing, what was fixed, what was decided |

[TODO.md](TODO.md) tracks remaining engineering work. Completed or superseded
implementation plans are removed after their unfinished items are carried forward;
setup guides and historical submission material remain reference documents.

---

## Qodo Code Review Evidence

Every substantive change in this repository landed through a pull request, and
[Qodo](https://www.qodo.ai) reviewed each of #1 through #8 before it merged.

**If you read one: [#2 - Make the agent loop survive its own
failures](https://github.com/Arindam200/docxy/pull/2)** ✅ merged. Fifteen
findings over seven review passes, four of them written out below, and two
commits ([`f775f8c`](https://github.com/Arindam200/docxy/commit/f775f8c),
[`6d27250`](https://github.com/Arindam200/docxy/commit/6d27250)) that exist only
to answer it.

| PR | What it changed | Qodo's verdict |
|---|---|---|
| [#2](https://github.com/Arindam200/docxy/pull/2) ✅ merged | Retry, session rotation, and the operations dashboard | **15 findings** over 7 review passes |
| [#3](https://github.com/Arindam200/docxy/pull/3) ✅ merged | Run queueing, Postgres persistence, publish-path fixes | 11 findings, then re-reviewed to **0 bugs, 0 rule violations** |
| [#4](https://github.com/Arindam200/docxy/pull/4) ✅ merged | Neon persistence, Better Auth, a page per pipeline stage | **9 bugs**, 22 skill insights |
| [#5](https://github.com/Arindam200/docxy/pull/5) ✅ merged | Authentication on the API's own endpoints | **6 bugs, every one security or reliability**, re-reviewed to 0 |
| [#6](https://github.com/Arindam200/docxy/pull/6) ✅ merged | Running the docs build in the harness sandbox | **8 bugs**, 6 skill insights - 6 taken, 2 answered on the record |
| [#7](https://github.com/Arindam200/docxy/pull/7) ✅ merged | Turning the anti-slop lint rules on across both projects | 1 finding, re-reviewed to **0 bugs, 0 rule violations** |
| [#8](https://github.com/Arindam200/docxy/pull/8) ✅ merged | Making the backend deployable, and the deployment guide | 3 bugs, 2 skill insights - all three answered by #9–#13 |

([#1](https://github.com/Arindam200/docxy/pull/1) added the anti-slop lint rules
and was closed rather than merged - it targeted code the platform stack had since
rewritten, and its rules landed with #7 instead.)

Three commits exist only to answer those reviews:
[`f775f8c`](https://github.com/Arindam200/docxy/commit/f775f8c),
[`6d27250`](https://github.com/Arindam200/docxy/commit/6d27250),
[`44f2ce1`](https://github.com/Arindam200/docxy/commit/44f2ce1). Each names the
findings it took and, where it declined one, says why.

### Five findings worth reading

**"Arbitrary run logs exposed"** *(#2)* - the sharpest of them. A run id was
effectively an authorization token: `/api/logs?run=` skipped the
synced-repository filter entirely - the filter was an `else` branch - and
`/api/runs/:id`, its `/files`, `approve` and `deny` never had one at all. Run ids
appear in every dashboard URL, so any signed-in user holding one could read
another repository's role events, prompts and commit metadata, and sign off on
its proposals. Naming a run now narrows *within* the caller's scope instead of
replacing it, in both storage backends. A run outside that scope is reported
absent rather than forbidden - "forbidden" would confirm the id names something
real. Fixed in `6d27250`.

**"Failed turns evade rotation"** *(#2)* - the turn count advanced only after a
response parsed, and the comment justifying it said so out loud: *"the turn is
only counted once it produced something usable."* Backwards. The harness
transcript grows when a turn is **submitted**, so a session that kept failing
never reached its rotation limit, never rotated, and kept growing - precisely the
spiral rotation exists to stop, and worst for `max_tokens`, where the model
generates its entire budget into the transcript before failing. Counted on
submission now, including harness errors, parse failures and timeouts. Fixed in
`f775f8c`.

**"Instructions never reach agents"** *(#2)* - `PUT /api/instructions` had
written `instructions.md` since the endpoint existed, and nothing ever read it
back. Every instruction typed into the dashboard was persisted, rendered back to
the person who wrote it, and ignored. Worse, it could not have been saved anyway:
the dashboard's proxy stripped its own `/api/docxy` prefix along with the
upstream `/api`, so every mutation through it arrived one path segment short and
404'd behind an error toast. Both fixed in `f775f8c`; the two drafting roles now
receive standing instructions, ranked above their default style but never
licensing a fact the diff does not support.

**"Approval default changed silently"** *(#2, High)* - and the one where the
review and the answer disagree, which is worth showing rather than hiding. Qodo
read `DOCXY_REQUIRE_APPROVAL=false` as a safety default flipped from on to off.
That reading was wrong - nothing read the old flag by then either - but it landed
on something real: the variable it replaced, `DOCXY_APPROVAL_MODE`, had
`elevated` and `always` values that genuinely *did* gate, so retiring it meant a
deployment that had asked for a gate would come back up without one. The retired
name is honored now, as `true`, with a warning, because that is the one direction
this must never fail in (`config.ts:175-198`, held in place by four tests).

The default itself stayed off, deliberately. A pull request is a review surface -
nothing merges without someone approving it on GitHub - and a pipeline that stops
before opening anything reviews nothing at all; it just goes quiet. docxy's own
second gate was built and later removed for the same reason: it bought a place
for finished proposals to be forgotten rather than a decision anybody was
actually making. What survives it is the judgement - the scope a change was
found to need, recorded on the run and in the pull request body.

**"Host fallback defeats isolation"** *(#6, Security)* - the one that changed a
default rather than fixing a bug. Any sandbox-unavailable result staged the
proposal and ran the command on the host, on the reasoning that a missing sandbox
is a property of the deployment and should not fail correct work. True, and it
does not follow that the answer is to run it here anyway: an isolation boundary
that disappears whenever it is least observed is not one. Host execution is now
opt-in (`DOCXY_SANDBOX_FALLBACK=local`) and the default reports the build
unvalidated instead.

### What we did not take

Qodo's two remaining notes on #3 are architectural suggestions rather than
defects - a durable database-backed job queue, and per-repository worker queues.
Both are right for a multi-tenant deployment and both are past what this pipeline
needs today.

On #6 it observed that the sandbox carries only the proposed files, so a
full-tree build (`mkdocs build`, `npm run docs:build`) cannot run there. Correct,
and it is the design: shipping the checkout into a sandbox on every commit costs
more than the check is worth. Making it default-on did make it everyone's
problem, so it is now stated plainly rather than implied.

All of it is recorded here rather than silently dropped.

### Where the trail stops, and why

PRs [#9](https://github.com/Arindam200/docxy/pull/9)–[#13](https://github.com/Arindam200/docxy/pull/13)
are the deployment fixes that #8's review asked for: the Railway volume and
`RAILWAY_RUN_UID` for a state directory the container could not write, `railway
ssh` in place of `railway run` so `doctor` reports the container rather than the
laptop, the webhook credentials the guide had omitted, and a harness image
carrying what its sandbox needs. They went through pull requests like everything
else, but Qodo's bot answered each one with *"reviews are paused for this
user"* - a seat quota on our account, not a review that was skipped. Five later
commits went to `main` directly: four are documentation and Railway
configuration, and one ([`77ab402`](https://github.com/Arindam200/docxy/commit/77ab402))
is a 25-line fix to `serve --repo`, with tests. Saying so is more useful than a
table that would not survive someone opening #9.

---

## License

MIT - see [LICENSE](LICENSE).
