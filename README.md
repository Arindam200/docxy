# Docxy

A multi-agent documentation-and-changelog pipeline built on [TrueForge](https://trueforge.dev),
TrueFoundry's open-source agent harness, with models served by
[Nebius Token Factory](https://tokenfactory.nebius.com).

Every push to `main` wakes five specialists. One classifies what changed. One
traces which docs and downstream code the change actually touches. Two draft the
edits — reference docs and release notes, in deliberately different voices. The
last reviews their work before a human sees any of it. Everything is validated
before review, and **nothing opens a pull request without explicit sign-off.**

---

## Why this, and not something that already exists

| Existing tool | What it does | Where it stops |
|---|---|---|
| [Swimm](https://swimm.io) | Watches commits, auto-syncs doc snippets | One flat pass — no impact-mapping step, no changelog, nothing validated before it lands |
| [Mintlify automate-agent](https://www.mintlify.com/docs/guides/automate-agent) | GitHub Action → hosted agent job → docs PR | Closest structural precedent, but one proprietary job tied to one platform — no open harness, no changelog, no validation step |
| semantic-release / Release Please | Generate changelogs from commit messages | Reads intent from the commit message, not the diff — brittle when commit hygiene slips, blind to downstream impact |
| Dependency-graph / blast-radius tools | Trace what a change affects | Produce a report a human still has to act on — not wired into anything that drafts and gates a fix |

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
                    │                      │  semver consistent · build · tests
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
| **Coordinator** | Reviews all four, rejects inconsistent work, writes the summary | — |

Run `docxy roles` to see the roster with its current model assignments.

---

## Three design decisions worth explaining

### 1. One session per role, per repository — so state accumulates

TrueForge spawns subagents dynamically (via its built-in `create_sub_agent`
tool); it has no concept of a fixed, named roster. So instead of one session
per commit, **each role holds its own long-lived TrueForge session per
repository**, and the orchestration order lives in code.

That is not a workaround — it is the better shape for this problem. What a role
learns on one commit is still there for the next one. Alongside the sessions, a
`symbol → doc-section` map is persisted to disk and handed to the Impact Mapper
on every run, so it reuses what it already worked out instead of re-deriving it.

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

Validation runs **against the working copy on disk**, not a remote sandbox, so it
needs no third-party account. TrueForge's own sandbox can be switched on with
`DOCXY_USE_HARNESS_SKILLS=true` if you'd rather run it there.

### 3. Graduated approval, and no silent timeout

- **Routine** — a docs-only fix needs one sign-off.
- **Elevated** — anything classified breaking, touching documented public API, or
  proposing a major bump needs **two sign-offs from two different people**. The
  same reviewer signing twice is rejected.
- The Coordinator also proposes a scope, and the **stricter of the two wins**: a
  model may escalate, never relax.
- **Nothing expires.** A request nobody answers stays pending and is reported
  stale. It never auto-approves and never auto-discards.

In CI this maps onto a protected GitHub environment, so GitHub itself holds the
job open until a human clicks approve — see [`.github/workflows/docxy.yml`](.github/workflows/docxy.yml).

---

## Getting started

### Prerequisites

- Node 20.11+
- A [Nebius Token Factory](https://tokenfactory.nebius.com) API key
- The TrueForge harness running locally

### 1. Start the harness

```bash
npx @truefoundry/trueforge@latest
```

It listens on `http://localhost:8790`.

### 2. Configure

```bash
npm install
cp .env.example .env
# put your NEBIUS_API_KEY in .env
```

### 3. Register Nebius with the harness

```bash
npx tsx src/cli.ts setup
```

This registers Token Factory as a custom OpenAI-compatible provider and verifies
that every model the roster wants actually resolves.

Four models are registered: `deepseek-v4-pro` (the default for four of the five
roles — 1M context and structured-output support, which matters because every
role must emit strict JSON), `deepseek-v4-flash` (used by the Changelog Author,
whose output is one line), plus `kimi-k3` and `qwen3-5` as alternatives.

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

The pipeline stops at the approval gate and tells you exactly how to proceed.

### 5. Review and approve

```bash
npx tsx src/cli.ts serve      # timeline UI on http://localhost:4317
```

or from the terminal:

```bash
npx tsx src/cli.ts approve <run-id> --by "your name"
npx tsx src/cli.ts deny    <run-id> --by "your name" --reason "why"
```

Once fully approved, the proposal is written to a branch **in a throwaway git
worktree** — your checkout, index, and current branch are never touched — and a
pull request is opened.

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
buried in prompts — what counts as breaking, how to trace impact, the docs voice,
the changelog voice. They are plain `SKILL.md` files, injected into each role's
instructions at session creation.

They're written in TrueForge's git-backed skill format, so they can be promoted
to real harness skills (`DOCXY_USE_HARNESS_SKILLS=true`) once this repo is
public. Inlining is the default because harness skills require a sandbox, and
this way the pipeline runs with no external account beyond Nebius.

**Editing a skill pack is the intended way to tune the pipeline for your repo** —
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
  trueforge/setup.ts     registers Nebius as a custom provider
  trueforge/session.ts   one long-lived session per role, per repo
  trueforge/run.ts       turn streaming, delta merging, approval/question resumes
  pipeline/index.ts      the orchestrator
  pipeline/state.ts      the persistent symbol → doc-section map
  pipeline/apply.ts      edit application and changelog splicing
  validate/              anchor, link, and consistency checks
  approval/gate.ts       graduated scope, multi-party sign-off, staleness
  github/pr.ts           worktree-isolated branch and PR creation
  server/                timeline UI and approval endpoints
skills/                  the four skill packs
test/selftest.ts         40 checks over the pure logic and the docs-branch wiring
```

## Tests

```bash
npm test        # 40 checks: parsing, edits, links, changelog, gate, docs branch
npm run typecheck
```

## Docs on their own branch

Plenty of repositories keep documentation on a separate branch — a `docs` branch
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
never touched — the docs tree is a detached worktree in a temp directory, torn
down when the run ends, so this works even if you already have `docs` checked out
somewhere else.

The branch has to exist first; docxy will not create it. If it is missing, the
run stops with the command to create it rather than quietly documenting the wrong
tree. Leave `DOCXY_DOCS_BRANCH` unset and everything stays in one tree as before.

## Configuration

Every knob is an environment variable, all documented in
[`.env.example`](.env.example) — model per role, docs branch, docs roots,
changelog path, validation commands, staleness threshold, base branch, port.

## License

MIT
