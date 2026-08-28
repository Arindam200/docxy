# TODO

Everything left before the hackathon deadline: **Sunday 30 August, 20:00 London**.

The code is done. What follows needs a person. Ordered so nothing blocking waits
on anything optional.

---

## 1. Merge the sandbox work

- [X] Check Qodo's re-review on [PR #6](https://github.com/Arindam200/docxy/pull/6)
- [X] Merge it

Qodo found 8 bugs on the first pass. Seven are fixed in `a358381`; the eighth —
the sandbox carries only the proposed files, so a full-tree docs build can't run
there — is answered in the README as a design limit rather than patched. If the
re-review raises something new, act on it in a commit that names the finding, the
way the previous three do.

---

## 2. Merge the two other open PRs

Both are green, both have been through Qodo, neither is merged. One of them
needs environment variables set **before** it merges or the live dashboard
breaks — that is the only genuinely dangerous item on this page.

### [PR #7](https://github.com/Arindam200/docxy/pull/7) — anti-slop lint · *no prerequisites, merge whenever*

- [X] Merge it

`oxlint.config.ts` had been in the repo since week one with nothing running it.
Turning it on reported 85 errors and 3 warnings across 36 files; this adds
`npm run lint` and gets that to zero. 64 fixed, 21 switched off by file in an
`overrides` block that explains why — three of those rules say "don't accept
`unknown`, parse at the boundary", and the eleven files listed *are* that
boundary. It also answers 18 of the 30 findings Qodo raised on #4.

Qodo found one bug: the exemption glob `runs/*/page.tsx` would have silently
exempted future sibling routes. Fixed in `1a2ab86` and verified both ways — a
decoy `runs/summary/page.tsx` drew no finding under the old glob and is reported
under the new one.

`npm run lint` exits 0, 98 tests, both projects typecheck. Zero behaviour
changes; the `roles.ts` template literals are byte-identical, which matters
because they are the instructions the models are actually sent.

### [PR #5](https://github.com/Arindam200/docxy/pull/5) — API authentication · **set the env vars first**

Closes Qodo findings 23, 24 and 25 from its review of #4 — a review that landed
*after* #4 merged, so all three describe code that is on `main` right now.

Better Auth guarded the dashboard proxy and nothing else. The Hono API listens
separately, answers `approve`, `deny`, `run` and `instructions`, and the deployed
entry point binds `0.0.0.0`. Anything that could reach the port signed off
proposals without meeting the sign-in — which made the approval gate decorative.

**This is a breaking change. Merging without these set will lock you out of your
own dashboard.**

- [X] Pipeline host: `DOCXY_API_TOKEN=$(openssl rand -hex 32)`
      *(without it `npm start` refuses to boot outright)*
- [X] Vercel: the **same** `DOCXY_API_TOKEN` value
      *(without it every dashboard read 401s)*
- [x] Vercel: `DOCXY_ALLOWED_EMAILS=arindammajumder2020@gmail.com`
      *(without it: "No operators are configured", and you are locked out)*
- [X] Confirm you already have an account on the deployed dashboard — signup is
      now closed by default. If not, create it first or set `DOCXY_ALLOW_SIGNUP=1`
      temporarily.
- [ ] Merge, then load the dashboard and confirm it still works - it has merge conflicts

Qodo reviewed it twice. The second pass found six ways the first commit's own
protection could be walked around — an unverified email could claim an
allowlisted address, the allowlist covered mutations but not the reads that
dashboard pages make directly, and missing auth config failed *open*. All fixed
in `b75c3de`. 132 tests, both projects typecheck, Vercel build green.

One finding was declined on the record: Qodo asked for `kind`/`surface`
classification tags this repo has no convention for. Its substance — that this is
breaking — is documented instead.

**If you would rather not touch production config on demo day, leaving #5 open is
defensible.** It is a reviewed, green PR that demonstrates the security work and
you can point at it. Shipping a breaking auth change hours before recording is
the riskier of the two options.

### Ordering

#5, #6 and #7 all touch `src/config.ts`; #5 and #7 also both touch
`src/server/index.ts` and `web/src/lib/docxy.ts`. Whichever merges last wants a
rebase. All three are additive on those files, so expect it to be clean.

Suggested order: **#6 → #7 → #5**. Sandbox first because it is the submission
evidence, lint second because it is risk-free, auth last because it is the one
with a deploy step.

---

## 3. Record the demo · **blocking**

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

## 4. Submit · **by 14:00 London on Sunday**

Six hours of buffer, not zero. Nothing new ships after this.

- [ ] Writeup — [guides/WRITEUP.md](guides/WRITEUP.md) is paste-ready
- [ ] Repo link: https://github.com/Arindam200/docxy
- [ ] Demo video link
- [ ] Confirm the README's **Qodo Code Review Evidence** section still matches
      reality after #6 merges

---

## 5. Open tracks — after submitting, not before

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
- **PR #4 opened and merged** — `feat/platform-buildout` was the base of the
  stack and had no pull request of its own, so nothing below it could reach
  `main` through review. #2 and #3 were retargeted onto `main` as each one below
  them landed.
- **PR #1 closed as superseded**, with the reasoning on the record. Its fixes
  targeted code the platform stack had since rewritten, and merging it would have
  silently resurrected `DOCXY_APPROVAL_MODE` — which #3 deliberately retired —
  leaving `config.ts` declaring the flag dead and reading it in the same file.
  Replaced by #7.
- **Three security findings confirmed against the code** rather than taken at
  face value (#5), and one of Qodo's reads corrected: the webhook issue is
  narrower than described, because installation-token minting already bounds it
  to one `GITHUB_APP_INSTALLATION_ID`. Its suggested fix would have broken the
  multi-repo design #2 built on purpose; an allowlist gets the safety without
  discarding the feature.
