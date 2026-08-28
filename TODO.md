# TODO

Everything left before the hackathon deadline: **Sunday 30 August, 20:00 London**.

The code is done. What follows needs a person. Ordered so nothing blocking waits
on anything optional.

---

## 1. Merge the sandbox work

- [ ] Check Qodo's re-review on [PR #6](https://github.com/Arindam200/docxy/pull/6)
- [ ] Merge it

Qodo found 8 bugs on the first pass. Seven are fixed in `a358381`; the eighth —
the sandbox carries only the proposed files, so a full-tree docs build can't run
there — is answered in the README as a design limit rather than patched. If the
re-review raises something new, act on it in a commit that names the finding, the
way the previous three do.

---

## 2. Record the demo · **blocking**

Commands in [guides/DEMO.md](guides/DEMO.md). Rehearse once before recording.

| Time | Beat |
|---|---|
| 0:00–0:25 | A real stale doc, and the commit that falsified it |
| 0:25–1:15 | One commit in, five roles reporting out on the timeline |
| 1:15–1:50 | **The sandbox running the docs build** — hold on the `sandbox` badge in the validation report |
| 1:50–2:25 | **The gate** — the draft PR carrying its own objections, then the protected `docxy-approval` CI environment holding the publish job |
| 2:25–3:00 | The second commit reusing what the first learned: *session reused*, symbols carried in |

Three things to check before you hit record:

- [ ] `npx tsx src/cli.ts doctor` says **sandbox ready**. If it doesn't, the badge
      never appears and the whole 1:15 beat is gone.
- [ ] Get fresh SHAs — `git -C .demo-repo rev-parse --short HEAD`. The demo repo
      was rebuilt, so any commit hash written down earlier is stale.
- [ ] Run it once end to end. Sessions are warm (last run carried 9 symbols in),
      but a cold session kills the reuse beat and you won't know until you're
      filming.

- [ ] Record it
- [ ] Watch it back for keys, tokens, and anything personal on screen

---

## 3. Submit · **by 14:00 London on Sunday**

Six hours of buffer, not zero. Nothing new ships after this.

- [ ] Writeup — [guides/WRITEUP.md](guides/WRITEUP.md) is paste-ready
- [ ] Repo link: https://github.com/Arindam200/docxy
- [ ] Demo video link
- [ ] Confirm the README's **Qodo Code Review Evidence** section still matches
      reality after #6 merges

---

## 4. Open tracks — after submitting, not before

- [ ] **Field Report** — [blog/field-report.md](blog/field-report.md) is written.
      Read it once in your own voice, then post to dev.to. Add the demo video
      embed and screenshots of the validation report if you want it to carry.
- [ ] **Radio Traffic** — post the demo clip tagging WeMakeDevs, TrueFoundry and
      Qodo.

Both are open tracks and cost hours, not days. One team can't win two judged
tracks, so these sit outside the thing you're actually optimising for.

---

## Decisions already made — don't relitigate these under time pressure

**The approval gate stays off by default.** A pull request *is* a review surface;
nothing merges without someone approving it on GitHub. A pipeline that stops
before opening anything hasn't added review, it's gone quiet. `DOCXY_REQUIRE_APPROVAL=true`
is there for teams that want the second gate, and CI has a protected environment
regardless. Argue it on camera rather than hiding it — that's what the 1:50 beat
is for.

**Aim at Double-O** (best use of TrueForge, $5,000 DGX Spark). It's the largest
prize and the closest on merit: five roles, long-lived per-repo sessions,
accumulated state, skill packs, subagents, approval events, and now sandboxed
execution. Tune the writeup around harness depth. Q Branch is the fallback and
needs no extra work.

**No MCP before the deadline.** Sessions are keyed by a hash of the agent spec,
so adding an MCP server to the Impact Mapper retires every session and discards
the accumulated symbol map — the thing that makes the second commit cheaper and
the strongest beat in the demo. Not worth trading a verified demo for a marginal
gain on an axis the GitHub App already satisfies.

---

## Already done

- Sandbox execution, on by default, verified end to end — [demo PR #12](https://github.com/Arindam200/docxy-demo/pull/12)
- Qodo Code Review Evidence section in the README
- MIT LICENSE
- `PLAN.md` reconciled with what shipped → [guides/ORIGINAL-PLAN.md](guides/ORIGINAL-PLAN.md)
- Dashboard surfaces the sandbox: badge, trail, `sandbox` log filter, navigation
- Live dashboard linked from the README — https://docxy-lilac.vercel.app
- PRs #2, #3, #4 merged
- 120 tests, both projects typecheck, dashboard builds
