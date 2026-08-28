> **This is the plan as written on 24 August 2026, before any code existed.**
> It is kept unedited, as a record of what was proposed against what shipped.
> For how docxy actually works, read the [README](../README.md).
>
> Four things changed once the harness was real:
>
> | The plan said | What shipped | Why |
> |---|---|---|
> | Daytona runs the sandbox | The harness's **own** sandbox runs it — Seatbelt on macOS, bubblewrap on Linux. Daytona is optional | A standalone harness carries isolation already; requiring an external account bought nothing |
> | A Coordinator delegates to four subagents | Five roles, each with **its own long-lived session per repository**, orchestrated in code | TrueForge spawns subagents dynamically and has no fixed named roster. One session per role is what makes state accumulate across commits — the better shape, not a workaround |
> | Sandbox validates the doc build, link check *and* test suite | The sandbox runs the **docs build**; links and anchors are checked in-process; the test suite stays local | Links need no execution. The test suite is the operator's own code and needs the whole working tree, which a sandbox turn does not carry |
> | Nothing opens a PR without explicit sign-off | A run opens the PR by default; `DOCXY_REQUIRE_APPROVAL=true` adds docxy's own gate, and CI adds a protected environment | A pull request *is* a review surface. A pipeline that stops before opening anything reviews nothing — it goes quiet. A rejected proposal still opens, as a draft carrying its reasons |

---

# Docxy

A multi-agent documentation-and-changelog pipeline built on [TrueForge](https://github.com/truefoundry/trueforge), TrueFoundry's open-source agent harness. Built for WeMakeDevs' Agent Harness Hackathon (Aug 24–30, 2026), theme: "Give AI models a License to act."

## The idea, in one paragraph

Every push to `main` wakes a coordinator agent that delegates to four specialists: one classifies what changed, one traces which docs and downstream code the change actually touches, one drafts the doc edits, one writes the changelog entry — in a deliberately different voice from the docs. The sandbox validates all of it (doc build, link check, test run) before a human ever sees it. Nothing opens a pull request without explicit approval.

## Why this, not something that already exists

| Existing tool | What it does | Where it stops |
|---|---|---|
| [Swimm](https://swimm.io) | Watches commits, auto-syncs doc snippets via Verify/Auto-sync | One flat pass — no impact-mapping step, no changelog, nothing sandbox-validated before it lands |
| [Mintlify automate-agent](https://www.mintlify.com/docs/guides/automate-agent) | GitHub Action → hosted agent API job → PR with doc edits in a separate docs repo | Closest structural precedent, but one proprietary agent job tied to Mintlify's platform — no open harness, no changelog, no validation step |
| semantic-release / Release Please / Changesmith | Generate changelogs and version bumps from commit messages | Reads intent from a commit message, not the diff — brittle if commit hygiene slips, blind to downstream impact |
| Blast-radius / dependency-graph tools | Trace what a change affects | Answers "what's affected" as a report a human still has to act on — not wired into anything that then drafts and gates a fix |

**The gap:** every existing tool owns one slice — sync, trigger-to-PR, changelog text, or impact analysis — as a single flat pass. Nobody chains *classify → map impact → draft docs → author changelog → sandbox-validate → gate behind approval* as cooperating specialists with distinct judgment. That's the unclaimed shape, and it's exactly what a multi-agent harness is for.

## Architecture

### Pipeline

1. **Trigger** — push to `main` fires a GitHub Action that pulls the commit diff and calls the TrueForge HTTP API to start (or resume) this repo's session.
2. **Change Analyst** — classifies the diff: public API vs. internal-only vs. config vs. test-only. Tags it breaking / feature / fix / chore.
3. **Impact Mapper** — traces which doc sections and downstream files actually reference what changed, using repo search over the session's running symbol → doc-section map.
4. **Docs Updater** and **Changelog Author**, in parallel — draft from the same classification and impact map, in two different registers: instructional reference docs vs. terse user-facing release notes.
5. **Sandbox validation** — Daytona runs the doc build, a link-checker, and the existing test suite against the proposed edits. Catches a hallucinated function name or broken link before a human ever sees it.
6. **Approval gate** — a compact summary goes to a human. Nothing opens a PR without explicit sign-off.

### Agent roster

| Agent | Job | Skill pack |
|---|---|---|
| Coordinator | Owns the session, delegates, aggregates outputs into one PR | — |
| Change Analyst | Classifies the diff, extracts the plain-language "what and why" | What counts as breaking, for this repo |
| Impact Mapper | Finds which docs and downstream code the change actually touches | Repo-specific mapping hints |
| Docs Updater | Drafts the specific edits to affected doc sections | Doc style & conventions |
| Changelog Author | Writes one entry in house format, proposes a semver bump | Changelog voice & format |

### Trigger mechanics

TrueForge's HTTP API is built for exactly this — sessions are created and driven from code, not just chat:

```ts
// Start the Coordinator
const { data: session } = await client.sessions.create({
  agent: { spec: { model: { name: 'anthropic/claude-sonnet-4-6' }, instructions: coordinatorPrompt } },
});

// Hand it the commit
const stream = await client.sessions.createTurnStream(session.id, {
  input: [{ type: 'user.message', content: diffPayload }],
});
```

This is structurally the same shape as Mintlify's own automation — a GitHub Action calling an agent API on push — just pointed at a self-hosted, open harness instead of a proprietary vendor endpoint.

**Day-one task:** read TrueForge's own cookbook (`/api/use-agent`) for the confirmed subagent-delegation and approval-event API before building around assumptions. Public docs cover session/turn creation clearly; they don't yet spell out subagent delegation or approval-event handling in detail.

### Session state, made to matter

One TrueForge session per repository, not per commit — state accumulates. Inside it, a lightweight symbol → doc-section map updates incrementally after each processed commit instead of being rebuilt from scratch. The demo should pay this off directly: run the pipeline on two commits back-to-back and the second run visibly reuses what the first one already learned about the repo, instead of re-deriving it.

### Approval, designed on purpose

Two deliberate choices, aimed straight at the "control & safety" judging axis:

- **Graduated scope** — a docs-only fix needs one approval; anything touching a documented public API or a semver bump needs an explicit second look.
- **No silent timeout** — if nobody approves in the window, the PR stays a visibly pending draft. It never auto-merges and never auto-discards.

Worth stating explicitly in the write-up: an independent review of TrueForge flagged approval-timeout and bypass behavior as an open question for the harness in general. Designing this on purpose is a direct, specific answer to that gap — not a generic safety gesture.

## Build schedule (Mon Aug 24 – Sun Aug 30)

- **Mon — stand up.** `npx @truefoundry/trueforge@latest` against a provider you already have keys for. Wire read-only GitHub MCP access. Pick the demo repo — this repo itself works, and dogfooding reads well on camera. Get the GitHub Action calling the TrueForge API on a push, even with a stub reply.
- **Tue — Change Analyst + Impact Mapper.** Real diff in, real classification and a real (even if rough) map of affected docs/files out. Grep and embeddings search over the repo is enough for a demo repo — don't build a full call-graph engine.
- **Wed — Docs Updater + Changelog Author.** Both drafting from the same classification and map, in their two distinct registers. Wire sandbox validation: doc build, link-check, existing test suite against the proposal.
- **Thu — approval + PR.** Graduated gate, no-silent-timeout behavior, PR-opening on approval. Write the three Skill packs. Start the session-state knowledge map persisting for real.
- **Fri — polish the surface.** A timeline view of what each of the five roles did, not a raw chat log. Confirm the Qodo + PR trail has been running since Monday.
- **Sat — rehearse.** Run two real commits back-to-back to capture the session-state payoff. Record the three-minute demo. Write the README and submission write-up.
- **Sun — buffer and submit.** Nothing new; fix whatever the rehearsal exposed.

## Risks, honestly

- **Impact-mapping accuracy** — no full static-analysis engine in a week. Scope the claim to "docs and changelog," curate the demo repo's Skill pack rather than promising general-purpose correctness.
- **Unconfirmed API shapes** — public docs don't fully cover subagent delegation and approval events. Budget Monday to read TrueForge's own cookbook before designing around assumptions.
- **The state-reuse demo beat** — showing "the second run reuses what the first one learned" live is risky if it's slow. Rehearse it for real — don't fake the timing — but don't leave it to chance on camera either.

## Against the six judging axes

1. **Potential impact** — every repo's docs and changelog go stale; universal, not speculative.
2. **Creativity & originality** — the multi-agent split itself is the unclaimed idea; the prior-art table above backs that up in the write-up.
3. **Technical excellence** — incremental session-state reuse and sandbox-validated output before human review are both real, checkable engineering.
4. **Sponsor tool integration** — exercises all six harness capabilities (MCP, sandbox, approval, skills, subagents, session state) at once; Qodo reviews the pipeline's own PRs from day one.
5. **Control & safety** — graduated approval plus explicit no-silent-timeout behavior, argued against a named gap in an independent review, not asserted generically.
6. **Presentation** — inherently visual: one commit in, five roles visibly report out, one PR out the other end, gated behind a click.

## Submission checklist

- [ ] Public repo, README a stranger can follow
- [ ] Qodo installed from day one, real PR review history
- [ ] Only tools/data/accounts the team owns — no keys or personal data in the repo or video
- [ ] ~3-minute demo showing the agent actually working, including the approval pause
- [ ] Write-up explaining the agent and its TrueForge implementation
- [ ] Optional blog post

---
*Source research and 13 alternate project concepts: [License to Build](https://claude.ai/code/artifact/e93e4f67-2457-4ab2-8f39-d0917458bdd2)*
