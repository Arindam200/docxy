# Getting this submitted

An audit of where docxy stands against the [Agent Harness Hackathon][rules]
rules, and what the remaining three days go on.

Audited **27 August 2026** against `fix/reliability-and-performance` at
`ebda697`. Deadline is **30 August, 20:00 London**.

> **Status, 28 August.** Every P0 and P1 in this document is closed except the
> two that are not code: the demo video and the submission itself. The sandbox
> work is [PR #6](https://github.com/Arindam200/docxy/pull/6), verified end to
> end against a live harness. PRs #2, #3 and #4 are merged. The approval-gate
> default stays off deliberately — see
> [the decision below](#p0--the-approval-default-stays-off-a-decision-not-a-gap).
>
> The dashboard is live at **https://docxy-lilac.vercel.app** and now surfaces
> the sandbox: a badge on the check, a Sandbox panel with the execution trail,
> and a `sandbox` filter in Logs.

[rules]: https://www.wemakedevs.org/hackathons/trueforge

---

## Verdict

**The build is in good shape.** 98 self-tests pass, both TypeScript projects
typecheck clean, the Next.js app builds all 17 routes, the repo is public, the
working tree is clean and pushed, and Qodo has genuinely reviewed all three pull
requests. The first commit lands 25 August — comfortably inside the build window.

**The submission is not.** Four of the checks a judge performs before scoring
anything currently fail. Three are documentation and process, fixable in an
afternoon. The fourth — sandbox execution — is a real code change, and the README
currently makes a case *against* doing it.

| | |
|---|---|
| Blocking gaps | **4** → **1 open** (the merge) |
| Score-costing gaps | **3** → **2 open** |
| Tests passing | 98 → **116** |
| Qodo-reviewed pull requests | 3 (merging in hand) |

---

## Findings, ranked

### P0 — Not one pull request is merged · **being handled separately**

> Qodo evidence — README section linking to at least one **merged** PR reviewed
> by Qodo with discussion of findings.
>
> — required submission component

PRs [#1][pr1], [#2][pr2] and [#3][pr3] are all `OPEN`. Qodo reviewed every one of
them — #2 carries seven separate review passes — and the findings were acted on in
`f775f8c`, `6d27250` and `44f2ce1`. The work is done; the merge never happened. As
it stands the requirement reads as unmet on inspection, regardless of the review
history behind it.

[pr1]: https://github.com/Arindam200/docxy/pull/1
[pr2]: https://github.com/Arindam200/docxy/pull/2
[pr3]: https://github.com/Arindam200/docxy/pull/3

**Fix — 30 minutes.** Merge all three today. They are the evidence trail. Keep
merging through the rest of the week too: direct pushes to `main` do not qualify
as reviewed work, so every remaining change this week needs to travel through a
pull request that Qodo sees first.

---

### P0 — Nothing runs in a sandbox, and the README defends that · **DONE**

> The harness must be doing real work: a judge has to see TrueForge reaching a
> tool, **running code in the sandbox**, and stopping for a person.
>
> — core requirement, listed under disqualification

`src/agents/roles.ts:49` sets `sandbox: { enabled: config.useHarnessSkills }`, and
`DOCXY_USE_HARNESS_SKILLS` defaults to `false` (`src/config.ts:265`). The sandbox
is therefore off on every default run. Validation instead shells out against the
working copy on local disk — and `src/validate/index.ts:69` and the README both
state this as a design virtue:

> Validation runs against the working copy on disk, not a remote sandbox, so it
> needs no third-party account.

This is the one finding where the fix is not just paperwork. A judge who greps for
the sandbox finds it disabled by default and a paragraph explaining why that was
deliberate. Nothing else in the submission recovers from that.

**Fixed on `feat/sandbox-validation`.**

- `src/validate/sandbox.ts` (new) runs the docs build inside the harness
  sandbox. A single-use validator agent — deliberately not one of the five
  drafting roles, and deliberately not long-lived — writes the proposed files
  into a fresh Daytona sandbox, runs the configured command there, and reports
  the exit code back as structured JSON.
- `DOCXY_SANDBOX` defaults to **true**, and is now independent of
  `DOCXY_USE_HARNESS_SKILLS`. `sandboxEnabled()` in `src/agents/roles.ts` keeps
  the one remaining coupling honest: harness skills are only served from inside
  a sandbox, so asking for them still asks for one.
- `docxy setup` registers Daytona as the harness's sandbox provider;
  `docxy doctor` reports which way validation will execute before a run does.
- Every executed check now records **where** it ran. `ValidationCheck.where` is
  `sandbox` or `local`, rendered as a badge on the run detail page — so the
  distinction is visible on camera, not just true in the code.
- No sandbox provider configured is a **fallback, not a failure**: the build
  still runs locally and the report says so. Failing a correct proposal over a
  missing Daytona key would be the wrong answer.
- The test command stays local on purpose — it is the operator's own code, not
  the proposal's, and it needs the whole working tree.

Ten tests cover the routing and the defaults, and seven more cover the
availability check after it was caught reading the wrong endpoint —
`/api/v1/capabilities` reports `sandbox.enabled: true` on a harness where no
provider has ever been configured, describing what the build supports rather
than what it holds. The settings endpoint is the one that knows. The suite is at
116.

**Verified end to end on 27 August.** Two runs against `.demo-repo`, both
opening real pull requests ([#10](https://github.com/Arindam200/docxy-demo/pull/10),
[#11](https://github.com/Arindam200/docxy-demo/pull/11)), with the docs build
executing in the sandbox and the run record proving it:

```
✓ docs-build   markdown files: 4 | unbalanced fences: []   where=sandbox
```

Two things turned up in the process that change the story for the better:

- **Daytona is not required.** A harness started with
  `npx @truefoundry/trueforge@latest` carries its own sandbox — Seatbelt on
  macOS, bubblewrap on Linux, both with an allow-listed filesystem and
  allow-listed network egress. Sandboxed execution needs no external account at
  all, which is a stronger claim than the one the plan started with.
- **`DOCXY_DOCS_BUILD_COMMAND` has to be set**, and it must not assume a
  checkout — the sandbox receives the proposed markdown and nothing else, so
  `npm test` would find no `package.json` there. `.env` now runs a fence-balance
  check over the proposed files, which is real, fast, and reads well on camera.

---

### P0 — The README never mentions Qodo · **DONE**

Zero occurrences of "Qodo" across `README.md`, `web/README.md` and all six files
in `guides/`. The rules ask for a named section, and judging axis 4 asks
explicitly whether "Qodo review the pull requests on the way there."

There is unusually good material for this and none of it is written down: three
pull requests, seven review passes on #2 alone, and three commits whose messages
name the review they answer.

**Fixed.** `README.md` now carries a **Qodo Code Review Evidence** section: a
table of all three PRs with their verdicts (15 findings over 7 passes on #2; #3
re-reviewed to 0 bugs), the three commits that exist only to answer reviews, and
four findings written out in full —

- *Arbitrary run logs exposed* — a run id was effectively an authorization
  token, letting any signed-in user read another repository's runs and sign off
  on its proposals. The strongest single piece of evidence in the trail.
- *Failed turns evade rotation* — turns counted on success rather than
  submission, so a failing session never rotated and kept growing.
- *Instructions never reach agents* — the dashboard persisted standing
  instructions that nothing read back, behind a proxy that could not have saved
  them anyway.
- *Approval default changed silently* — including where the review's reading was
  wrong and what it nevertheless caught.

The section also records the two suggestions on #3 that were **not** taken, and
why. Declining a finding on the record reads better than a trail with no
disagreement in it.

---

### P0 — The approval default stays off: a decision, not a gap

> **Control and safety** — Does the agent run its code somewhere safe and stop
> for a human before anything irreversible?
>
> — judging criterion 5 of 6

`DOCXY_REQUIRE_APPROVAL` defaults to `false`, so a default run opens the pull
request on its own authority. Qodo flagged this on #2 as well, under *"Approval
default changed silently."*

**This is staying as it is.** Holding every run behind a second gate does not fit
how docxy is actually used, and that is the operator's call to make. What follows
is the argument to make in the writeup and on camera, because the default is
defensible — it just has to be *argued*, not left for a judge to discover.

The gate is at the pull request. Nothing docxy proposes is irreversible: the
pipeline opens a PR, and a PR merges only when a person approves it on GitHub.
A pipeline that stops *before* opening anything has not added a review step; it
has gone quiet, and a stalled run tells nobody anything. A proposal the
Coordinator rejected or validation failed still opens — as a **draft with the
reasons at the top of the body**. That is the safety property worth demonstrating:
docxy never publishes a clean-looking PR over its own objections.

Three things make this argument land rather than sound like a rationalisation:

1. **Show the sandbox instead.** Criterion 5 has two halves — "somewhere safe"
   and "stop for a human." The sandbox work now answers the first half properly,
   and it is the half that was genuinely missing. Lead with it.
2. **Show the gate existing.** `DOCXY_REQUIRE_APPROVAL=true` gives graduated
   scope, two distinct sign-offs for elevated changes, and no expiry in either
   direction. Demonstrate it once on camera as a capability, then say plainly
   that the default is off and why. A judge who sees the gate work and hears a
   reason will score the decision; one who greps the default and finds no
   argument will score a gap.
3. **Show the CI path.** `.github/workflows/docxy.yml` gates the publish job on a
   protected `docxy-approval` environment — GitHub itself holds the job until a
   human clicks approve, and never auto-approves it. That is a human in the loop
   at the point of publication, enforced by infrastructure rather than by trust.
   It is the strongest safety artifact in the repo and the README barely mentions
   it. Give it a callout.

One related detail worth knowing: `runTurn` sets `autoApproveHarnessTools = true`
(`src/trueforge/run.ts:181`), so the harness's own `tool.approval_required`
events are auto-allowed. That is correct for an unattended pipeline — the gate
that matters is in front of the pull request, not in front of every tool call —
but be ready for the question, because a judge reading the event handler will
ask it.

---

### P1 — No LICENSE file, though the README claims MIT · **DONE**

GitHub reports `licenseInfo: null`. The README's final line says MIT. Open source
is a stated requirement, and the repo currently has no license at all — which
legally means all rights reserved.

**Fixed.** A standard MIT `LICENSE` is at the repo root, and the README's final
line links to it.

---

### P1 — PLAN.md promises a sandbox that was never built · **DONE**

`PLAN.md` is checked in at the repo root and describes Daytona running the doc
build, link-checker and test suite in a sandbox — architecture that does not exist.
It also describes a Coordinator that delegates via subagents, while
`src/agents/roles.ts:108` enables `dynamicSubAgents` on exactly one role and the
README explains that orchestration order lives in code instead.

A judge who opens both files finds two different projects. The README's version is
the honest one, and the discrepancy reads as a broken promise rather than a
changed plan.

**Fixed.** Moved to [`guides/ORIGINAL-PLAN.md`](ORIGINAL-PLAN.md), unedited, under
a header that says it is the 24 August proposal and tabulates the four things that
changed once the harness was real: Daytona became optional, the Coordinator became
five long-lived sessions orchestrated in code, the sandbox scope narrowed to the
docs build, and the approval gate moved to the pull request. Showing the plan
against what shipped is stronger than either deleting it or quietly rewriting it.

---

### P1 — No MCP server is ever reached · **deliberately not done**

The rules list MCP servers first among the real tools an agent should reach. The
codebase touches MCP only on the failure path: `src/trueforge/run.ts:334` handles
`mcp.auth_required` by aborting the run.

docxy does reach a real tool — the GitHub App calls the REST API to open pull
requests, and the rules name GitHub and APIs explicitly, so the base requirement is
met. But the Double-O track is judged on maximizing harness features, and MCP is
the most visible one not being used.

**Recommendation: do not do this before the deadline.** It was scoped as an
upgrade and it should stay unbuilt, for a specific reason rather than for lack of
time.

Sessions are keyed by a hash of the agent spec. Adding an MCP server to the
Impact Mapper's spec changes that hash, which retires every Impact Mapper session
and discards the accumulated symbol map — the thing that makes the second commit
cheaper than the first, and the strongest beat in the demo. Two days out, that
trades a verified demo for a marginal gain on an axis already satisfied: the
GitHub App calls the REST API to open pull requests, and the rules name GitHub
and APIs explicitly.

If it is built later, warm the sessions again before recording anything.

---

### P2 — No demo video, writeup, or live URL

Nothing in the README links to a video, a deployed dashboard, or a writeup. Two of
these are required components, and presentation is a full sixth of the score. The
dashboard builds and deploys — there is a Vercel bot on PRs #2 and #3 — so a live
URL is nearly free.

---

## Where this stands on the six axes

All six are weighted equally.

| Judging axis | Today | What moves it |
|---|---|---|
| **Potential impact** | Strong | Every repo's docs go stale. The prior-art table in the README already argues this well — leave it alone. |
| **Creativity & originality** | Strong | Five specialists with distinct judgment, plus session state that accumulates per repo. The two-commit reuse demo is the beat that proves it — rehearse it. |
| **Technical excellence** | Strong | 98 tests, clean builds, retry and rotation handling, real failure classification. Say the number out loud in the writeup. |
| **Use of sponsor tools** | Recovered | TrueForge is genuinely central, and the Qodo evidence section now exists. The merge is the last piece. |
| **Control & safety** | Recovered | The docs build runs in the sandbox by default and the run says where it ran. The approval default stays off deliberately — argue it, don't hide it. |
| **Presentation** | Failing | No video, no writeup, no live link. The dashboard is good and nobody can see it. |

---

## What is left

Everything below needs a person. The code is done.

### 1. Put the live URL in the README — **5 minutes**

The app is deployed and healthy at **https://docxy-lilac.vercel.app** — `/`,
`/login` and `/signup` all serve, and `/dashboard` correctly redirects to sign-in.
It is not linked from the README, so nobody arriving at the repository knows it
exists. Add it to the top.

(`docxy.vercel.app` is a different, stale project — `/login` 404s and
`/dashboard` 500s there. Do not link that one.)

### 2. Record the demo — **blocking**

Shot list in [WRITEUP.md](WRITEUP.md), commands in [DEMO.md](DEMO.md). Two things
to rehearse rather than trust:

- The two-commit reuse beat. Sessions are already warm from the 27 August runs,
  so it should report *session reused* immediately — but run it once before
  recording to be sure, because a cold session makes the beat vanish.
- The sandbox badge. `DOCXY_DOCS_BUILD_COMMAND` must be set or the docs-build
  check is skipped and the sandbox never appears. It is set in `.env` now.

Check the recording and the repo for keys before uploading.

### 3. Submit — **by 14:00 London on 30 August**

Six hours of buffer, not zero. The writeup is [WRITEUP.md](WRITEUP.md); paste it.

### 4. Then the open tracks, after submitting

- **Field Report** — the blog post. The honest version writes itself: a
  submission audit found the safety story was backwards, the sandbox was off by
  default with a paragraph defending it, and the fix turned up an SDK docstring
  that was wrong in a way that cost a working sandbox. That reads better than a
  feature tour.
- **Radio Traffic** — post the demo clip tagging WeMakeDevs, TrueFoundry and Qodo.

---

## Which track to aim at

One team cannot win more than one judged track, so the submission should be tuned
for a single target rather than hedged across three.

**Aim at Double-O** — best use of TrueForge, NVIDIA DGX Spark, $5,000. It is both
the largest prize and the closest on merit: five roles, long-lived per-repo
sessions, accumulated state, skill packs, subagents, approval events. Once the
sandbox lands on Friday, docxy exercises more of the harness than most entries
will, and that is precisely what the track rewards. Tune the README and the
writeup around harness depth.

**Q Branch** (best code quality) is the credible fallback and needs no work beyond
the Qodo section written on Thursday — 98 tests and a real review trail is a strong
showing. **Savile Row** (best UI) is real but riskier: the dashboard is good, and
"best UI" attracts entries that are nothing but UI.

The two open tracks — **Field Report** and **Radio Traffic** — cost hours rather
than days and sit outside the judged set. Do both on Sunday, after submitting.

---

## Submission checklist

| | Requirement | Status |
|---|---|---|
| ✅ | Public repository with a README a stranger can follow | done |
| ✅ | Built during the hackathon window — first commit 25 August | done |
| ✅ | TrueForge central to the project, not a thin model wrapper | done |
| ✅ | At least one **merged** Qodo-reviewed PR | #2, #3, #4 merged |
| ✅ | README section documenting the Qodo review findings | done |
| ✅ | Reaches a real tool — GitHub REST via the App | done |
| ✅ | Code executing in an isolated sandbox, on by default | done, verified live |
| ✅ | A human gate before anything merges — at the PR, and at the CI environment | by design |
| ✅ | Open-source LICENSE file | done |
| ✅ | Writeup: what it does and how it uses TrueForge | [WRITEUP.md](WRITEUP.md) |
| ☐ | Live dashboard linked from the README | deployed, needs the link |
| ☐ | Three-minute demo video showing tool, sandbox and pause | you |
| ☐ | No API keys or personal data in the repo or the video | check before upload |
| ☐ | Submitted before 20:00 London | 30 Aug |

---

## What was verified in this audit

Run against `fix/reliability-and-performance` at `ebda697`, 27 August 2026:

- `npm test` — 98 passed, 0 failed (now **116** after the sandbox work)
- `npm run typecheck` — clean, both root and `web/`
- `npm run build` in `web/` — clean, 17 routes
- `git status` clean, in sync with `origin`
- Repository public, `licenseInfo: null`
- PRs #1–#3 reviewed by `qodo-code-review`, none merged
- First commit `11a6f94`, 25 August 2026 — inside the build window
