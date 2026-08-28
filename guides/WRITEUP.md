# Submission writeup

The text for the hackathon submission form. Copy from here.

---

## docxy — a documentation pipeline that five agents run and a human signs

**Repository:** https://github.com/Arindam200/docxy
**Harness:** TrueForge · **Models:** Nebius Token Factory · **Review:** Qodo

### The job it takes over

Documentation goes stale one commit at a time, and nobody notices until a reader
follows an instruction that no longer works. The job docxy takes over is the one
every team keeps meaning to do: read what just changed, work out which docs it
falsified, rewrite those sections, write the release note, and open a pull
request a reviewer can actually judge.

That is a job you would hand to a person, which is the test the theme sets. It
is not a summariser bolted to a diff.

### Why five agents and not one prompt

Because the four judgments are different jobs, and one context holding all of
them does all of them worse.

| Role | Decides | Skill pack |
|---|---|---|
| **Change Analyst** | Is this breaking, and what does a consumer who upgrades without changing code actually hit? | `breaking-change-policy` |
| **Impact Mapper** | Which doc sections did this falsify, and which downstream code follows? | `impact-map-hints` |
| **Docs Updater** | The smallest edit that makes each section true again | `docs-style` |
| **Changelog Author** | One user-facing line, and the semver bump it implies | `changelog-voice` |
| **Coordinator** | Whether the four agree, and what to tell the human | — |

The Docs Updater and the Changelog Author write in deliberately different
registers — instructional prose against a terse release note — and they are
separate agents partly so that neither voice contaminates the other.

### Where TrueForge is load-bearing

Not a wrapper around a model. Four harness capabilities decide the architecture:

**1. One long-lived session per role, per repository.** TrueForge spawns
subagents dynamically and has no concept of a fixed named roster — so instead of
one session per commit, each role holds its own session per repo and the
orchestration order lives in code. That is not a workaround, it is the better
shape: what a role learns on one commit is still there for the next. Run two
commits back to back and the timeline marks each role **session reused**. Our
last demo run reported `6 symbol(s) carried in, 3 new mapping(s) learned`.

Sessions are keyed by a hash of the agent spec, so editing a prompt rebuilds the
session instead of silently doing nothing — and they rotate after a turn budget,
because an accumulating transcript is an input that grows without bound.

**2. The sandbox runs the one thing that is untrusted.** The validation checks
split by who wrote what they execute. Anchors, links and semver consistency only
*read* the proposal. The docs build **runs a command over prose a model finished
writing a minute earlier**, so that one goes to the harness sandbox — never the
operator's checkout. A single-use agent stages the proposed files into a fresh
sandbox, runs the configured command there, and reports the exit code back:

```
validation
  ✓ edits-apply         3 file(s) patched cleanly
  ✓ link-check          no broken relative links or anchors
  ✓ semver-consistency  breaking -> major
  ✓ docs-build          markdown files: 4 | unbalanced fences: []   [sandbox]
```

That session is deliberately not one of the five and deliberately not long-lived:
a validation sandbox carrying state between commits would let one run's leftovers
decide the next run's verdict.

It needs no third-party account. A standalone harness carries its own sandbox —
Seatbelt on macOS, bubblewrap on Linux, both with allow-listed filesystem and
network egress. `DAYTONA_API_KEY` switches to a remote Daytona sandbox instead,
and the run record names which one it used, so "sandbox" never means two things.

**3. It reaches a real tool.** A GitHub App — not a personal token — opens the
pull request, from a throwaway git worktree so the operator's checkout, index and
current branch are never touched. Pull requests are authored by
`docxy-bot[bot]`, which is also what makes the audit trail honest about who did
what.

**4. It stops for a person, in the place that binds.** More below.

### Validation is the interesting safety property

The most common failure of an LLM editing prose is quoting text that is not
there. So the strictest check runs first: **every proposed edit must anchor to
text appearing verbatim, exactly once, in the real file.** A paraphrased anchor
fails the run rather than producing a broken patch. On top of that, links and
in-page anchors must resolve, and a `breaking` classification paired with
anything below a `major` bump is rejected as internally inconsistent — one agent
contradicting another is caught by machinery, not by hoping.

And a proposal that fails **still opens** — as a draft with the reasons at the
top of the body. A stalled run tells nobody anything; an unmergeable draft tells
them exactly what went wrong.

### Where the human sits

Deliberately at the pull request, not before it.

Nothing docxy proposes is irreversible. It opens a PR; a PR merges when a person
approves it on GitHub. A pipeline that stopped *before* opening anything would
not have added a review step — it would have gone quiet, which is how automation
gets switched off. What the gate protects is the *quality* of what gets opened,
and that is what validation and the Coordinator's veto do.

Two stronger gates are available and both are real:

- `DOCXY_REQUIRE_APPROVAL=true` holds the proposal behind docxy's own gate:
  **routine** needs one sign-off, **elevated** — anything breaking, touching
  documented public API, or proposing a major bump — needs **two sign-offs from
  two different people**. The same reviewer signing twice is rejected. The
  Coordinator also proposes a scope and the *stricter of the two wins*: a model
  may escalate, never relax. Nothing expires in either direction.

- In CI, the authority to publish lives in a job the agent cannot reach.
  `.github/workflows/docxy.yml` drafts in one job and publishes in a second
  declaring `environment: docxy-approval` — a protected environment, so **GitHub**
  suspends it until a named human clicks approve. Set required reviewers to 2
  with *prevent self-review* and an elevated run needs two people at the
  infrastructure level too.

### How we built it

Every substantive change went through a pull request Qodo reviewed first —
nothing of consequence was pushed to `main`. Qodo found 15 issues on #2 across
seven passes, 11 on #3, and 9 on #4. Three commits exist only to answer those
reviews. The sharpest finding: a run id was effectively an authorization token,
letting any signed-in user read another repository's runs and sign off on its
proposals. The full trail, including two suggestions we declined and why, is the
**Qodo Code Review Evidence** section of the README.

116 self-tests cover the pure logic — parsing, edit application, link and anchor
resolution, the approval gate's multi-party rules, session rotation, sandbox
routing.

### Try it

```bash
npx @truefoundry/trueforge@latest     # harness on :8790
npm install && cp .env.example .env   # add NEBIUS_API_KEY
npx tsx src/cli.ts setup
npx tsx src/cli.ts doctor             # confirms where validation will execute

npm run demo -- --force               # a 2-commit demo repository
npx tsx src/cli.ts run HEAD~1 --repo .demo-repo   # first: learns the repo
npx tsx src/cli.ts run HEAD   --repo .demo-repo   # second: reuses what it learned
npx tsx src/cli.ts serve              # timeline on :4317
```

---

## Three-minute demo script

| Time | Beat |
|---|---|
| 0:00–0:25 | A real stale doc, and the commit that falsified it |
| 0:25–1:15 | One commit in; five roles report out on the timeline |
| 1:15–1:50 | **The sandbox running the docs build** — hold on the `sandbox` badge in the validation report |
| 1:50–2:25 | **The gate** — the draft PR carrying its own objections, then the protected CI environment holding the publish job until a person clicks |
| 2:25–3:00 | The second commit reusing what the first learned: *session reused*, symbols carried in |

Full commands in [DEMO.md](DEMO.md).
