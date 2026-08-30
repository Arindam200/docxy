# Recording the demo

The flow, end to end: a commit lands → five specialists react → docs and a
changelog are drafted and validated → a human signs off → a pull request opens.

Every step below has been run for real against `.demo-repo`. What the pipeline
actually produced is at the bottom, so you know what to expect on camera.

---

## Before you record

```bash
npx @truefoundry/trueforge@latest      # harness on :8790, leave it running
npx tsx src/cli.ts setup               # once, registers Nebius
npx tsx src/cli.ts doctor              # all five models should resolve
```

**Set `DOCXY_REQUIRE_APPROVAL=true` in `.env` before you record.** The gate is
**off** by default: `approvalRequired()` returns false, the pipeline calls
`autoApprove()`, and the run goes straight to opening a pull request. Nothing
warns you — the run simply succeeds without ever pausing, and step 4 below, the
best beat in the demo, silently does not happen.

`doctor` is worth running immediately before recording. If a model does not
resolve, the run fails four minutes in, which is a bad thing to discover live.

### The demo repository

`.demo-repo` is purpose-built for this and is gitignored. Recreate it any time:

```bash
npm run demo -- --force
```

Two commits, staged deliberately:

1. `feat: initial report command with --output flag` — the baseline the docs describe
2. `feat!: rename --output to --format and add csv` — a breaking change

Its remote is **https://github.com/Arindam200/docxy-demo** — already wired, and
already carrying two real pull requests opened by the pipeline:

- [PR #1](https://github.com/Arindam200/docxy-demo/pull/1) — changelog only, from commit 1
- [PR #2](https://github.com/Arindam200/docxy-demo/pull/2) — 4 files, from the breaking change

If you recreate the repo with `npm run demo -- --force`, re-wire it:

```bash
cd .demo-repo && git remote set-url origin https://github.com/Arindam200/docxy-demo.git
```

---

## The recording

### 1. Reset, so the memory beat is real

```bash
npx tsx src/cli.ts reset --repo .demo-repo
```

This clears sessions and the symbol map. Do it before recording, not during —
the payoff in step 3 depends on starting from nothing.

### 2. First commit: the pipeline learns the repo

```bash
npx tsx src/cli.ts run HEAD~1 --repo .demo-repo
```

Five roles run. Watch for `(session reused)` being **absent** — every role is
creating its session for the first time.

### 3. Second commit: it remembers

```bash
npx tsx src/cli.ts run HEAD --repo .demo-repo
```

This is the beat worth pausing on. The summary line reads:

```
memory 2 symbol(s) carried in, 7 new mapping(s) learned
```

Symbols carried in — the first run taught it where `--output` is documented, and
the second run did not re-derive that. **The counts vary between runs**: the
models are not deterministic, so treat a non-zero "carried in" as the thing to
point at, not the specific number. The run below produced 2; an earlier one
produced 6.

With `DOCXY_REQUIRE_APPROVAL=true` set, every run stops for sign-off. What the
change itself decides is *how many* reviewers: `decideScope()` returns
**elevated** (two sign-offs) when the change is classified breaking, touches
documented public API, proposes a major bump, or the Coordinator asks for a
second look, and **routine** (one) otherwise.

Both demo commits reach **elevated**, for different reasons — commit 1 on the
public-API surface alone, commit 2 on all four. So the two-sign-off beat is
available on either run, not just the second.

So this commit reaches the two-sign-off gate on its merits. If your run prints
`routine scope, 0/1` instead, the classifier read the change as smaller than the
demo script assumes — pick a commit that edits a documented public symbol.

### 4. The gate

The run stops:

```
gate elevated scope, 0/2 sign-off(s), status pending

▌ Waiting for human approval.
  Elevated because the change is classified breaking, and it touches documented
  public API, and it proposes a major version bump, and the Coordinator asked for
  a second look. Two sign-offs required.
```

Show that one reviewer is not enough:

```bash
npx tsx src/cli.ts approve <run-id> --by "arindam" --repo .demo-repo
# ✓ Sign-off recorded. This elevated request needs 1 more, from a different reviewer.

npx tsx src/cli.ts approve <run-id> --by "arindam" --repo .demo-repo
# ✗ arindam has already signed off. An elevated request needs a second, different reviewer.
```

That second command failing is the strongest three seconds in the demo — the
same person cannot wave their own change through.

```bash
npx tsx src/cli.ts approve <run-id> --by "second-reviewer" --repo .demo-repo
# ✓ Fully approved. Opening the pull request...
```

### 5. The timeline UI

```bash
npx tsx src/cli.ts serve --repo .demo-repo    # http://localhost:4317
```

Confirm the boot line reads `repository .../.demo-repo (pinned by --repo)`. If
it says **(from the App installation)** you are on a build from before `serve`
honoured `--repo`, and the timeline will come up showing a different
repository's runs — populated with the wrong project rather than empty, which is
much harder to notice on camera. `DOCXY_REPO_PATH=$PWD/.demo-repo` pins it the
same way.

The list is scoped to every synced repository, so runs from other checkouts
appear below the demo's. The two you just made are the newest, at the top.

Better on camera than terminal scrollback: each role, what it produced, which
session it reused, and the proposed diff.

---

## What it actually produced

Both runs below were executed for real against the live repo.

### Run 1 — commit 1, cold

```
classification  feature / public-api (95%)
impacted docs   4
changelog       [Added] Added the `report` command with a `--output` flag
                supporting `table` (default) and `json` formats
                bump: minor
validation      ✓ edits-apply        0 file(s) patched cleanly
                ✓ link-check         no broken relative links or anchors
                ✓ semver-consistency feature -> minor
                ✓ docs-build         markdown files: 1 | unbalanced fences: []
memory          0 symbol(s) carried in, 6 new mapping(s) learned
gate            elevated scope, 0/2 sign-off(s), status pending
```

Commit 1 gates too, and as **elevated** — it touches documented public API and
the Coordinator asked for a second look. Earlier versions of this guide showed
it opening a pull request unattended, which is what happens with the gate off;
with the gate on, as the demo needs, it stops here like commit 2 does.

Only `CHANGELOG.md` changed, and that is correct: commit 1 is what *added* the
docs describing `--output`, so nothing was stale yet. Worth saying out loud on
camera — it shows the Docs Updater declining to invent work.

### Run 2 — the breaking change, gated

```
  ✓ Change Analyst    (session reused)
  ✓ Impact Mapper     (session reused)
  ✓ Docs Updater      (session reused)
  ✓ Changelog Author  (session reused)
  ✓ Coordinator       (session reused)

classification  breaking / public-api (100%)
impacted docs   4
changelog       [Changed] Renamed the `--output` flag to `--format` and added
                `csv` as a supported format; passing `--output` now throws an
                error directing you to `--format`
  bump: major

validation
  ✓ edits-apply        3 file(s) patched cleanly
  ✓ link-check         no broken relative links or anchors
  ✓ semver-consistency breaking -> major
  ✓ docs-build         markdown files: 4 | unbalanced fences: []

memory          2 symbol(s) carried in, 7 new mapping(s) learned
gate            elevated scope, 0/2 sign-off(s), status pending
```

Every role reports `(session reused)` — confirmed on the run above, all five
roles — and the symbol map carried in from run 1.

`docs-build` appears here and not in older transcripts because the **local**
harness carries its own sandbox. That is the one thing the Railway deployment
cannot do (no privileged containers), so recording locally is what gets you a
green `docs-build` line instead of an unvalidated report.

Then the gate:

```
✓ Sign-off recorded. This elevated request needs 1 more, from a different reviewer.
✗ arindam has already signed off. An elevated request needs a second, different reviewer.
✓ Fully approved. Opening the pull request...
✓ https://github.com/Arindam200/docxy-demo/pull/2
```

PR #2 carries `CHANGELOG.md`, `README.md`, `docs/cli.md`, `docs/guide.md`, with
edits like:

```diff
-Pass `--output json` to get machine-readable output. The default is
-`--output table`, which prints an aligned text table.
+Pass `--format json` to get machine-readable output. The default is
+`--format table`, which prints an aligned text table. Use `--format csv`

-| `--output` | `table` | Output format: `table` or `json` |
+| `--format` | `table` | Output format: `table`, `json`, or `csv` |
```

### Before a clean take

The two PRs above already exist. Close them if you want a fresh screen — branch
names include the run id, so re-running never collides with them.

```bash
gh pr close 1 --repo Arindam200/docxy-demo --delete-branch
gh pr close 2 --repo Arindam200/docxy-demo --delete-branch
npx tsx src/cli.ts reset --repo .demo-repo
```

## Proving the agents did the work

Worth being able to answer on camera, and worth checking yourself rather than
taking anyone's word for it.

**1. The harness holds real sessions and turns.** Every run records the session
and turn id for each role:

```bash
npx tsx src/cli.ts show <run-id> --json --repo .demo-repo \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      for (const t of JSON.parse(s).traces)
        console.log(t.role.padEnd(18), t.sessionId, t.turnId);
    })'
```

Then ask the harness directly — this is independent of anything docxy logged:

```bash
curl -s http://localhost:8790/api/v1/sessions/<session-id> | jq '.data.agent.spec.model'
# => "nebius/deepseek-v4-pro"

curl -s http://localhost:8790/api/v1/sessions/<session-id>/turns | jq '.data | length'
# => 2   (one turn per run — this is the session reuse, provable)
```

**2. The diff is verbatim model output.** The run record stores what the Docs
Updater returned, before anything was applied:

```bash
npx tsx src/cli.ts show <run-id> --json --repo .demo-repo | jq '.docs.edits[0]'
```

```json
{
  "path": "README.md",
  "find": "npx demo-report --output json",
  "replace": "npx demo-report --format json"
}
```

Compare that against the PR diff — they match exactly.

**3. The anchor check makes hand-editing impossible to hide.** `applyDocEdits`
requires the model's `find` string to appear in the file *exactly once*. A
paraphrase fails with `anchor-not-found`; an ambiguous match fails with
`anchor-ambiguous`. The pipeline cannot apply an edit that the model did not
quote from the real file, which is why `✓ edits-apply` is a meaningful line and
not decoration.

**What is not the agents' work:** the reviewer names at the approval step. Those
are typed at the CLI. The gate logic is real — two distinct sign-offs, same
reviewer rejected — but the names are yours to supply, and in the current demo
nobody actually reviewed anything.

## If something goes wrong

**A role fails with `max_tokens breached`.** The model may be looping, not
running out of room — inspect the stored raw output before raising the cap. For
the Changelog Author, use the default `nebius/deepseek-v4-pro`; if your `.env`
explicitly pins Flash, remove that line or set
`DOCXY_MODEL_CHANGELOG_AUTHOR=nebius/deepseek-v4-pro`. This is exactly what
happened with the Flash model on the Changelog Author.

**A prompt or model change seems to have no effect.** Sessions are created once
and reused, but docxy hashes the role spec, so the next run creates a new session
when its model or instructions change. To discard every role's accumulated
memory deliberately, run `npx tsx src/cli.ts reset --sessions --repo .demo-repo`.

**The pull request step fails.** Check `git -C .demo-repo remote -v` points at
GitHub. Everything before that step still ran — the run record holds the full
proposal, and `docxy show <run-id>` replays it.
