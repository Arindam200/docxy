# Observability plan

Goal: a user can open any run and see exactly what each of the five agents was
asked, what it answered, how long it took, what it cost, and — when something
failed — enough to diagnose it without reading server logs.

Most of the data already exists. The work is mostly surfacing it, plus three
things that are not being captured at all.

---

## 1. What is already recorded

Every run is a JSON document in `.docxy/runs/<id>.json`. Per run:

| Field | Contents |
|---|---|
| `commit` | sha, short sha, subject |
| `status` | running / ready / awaiting-approval / approved / denied / failed / done |
| `startedAt`, `finishedAt` | run duration is derivable |
| `traces[]` | one per role — see below |
| `classification`, `impact`, `docs`, `changelog` | each role's parsed output |
| `validation` | every check with pass/fail/skip and detail |
| `approval` | scope, rationale, required vs actual sign-offs, who and when |
| `proposedFiles[]` | before/after for every file the PR would touch |
| `priorSymbolCount`, `newSymbolCount` | the memory story, per run |
| `pullRequestUrl` | if one opened |

Per role (`RoleTrace`):

| Field | Contents |
|---|---|
| `role`, `status` | which agent, and running / done / failed |
| `sessionId`, `turnId` | the harness's own identifiers — independently queryable |
| `reusedSession` | whether this run reused an existing session |
| `startedAt`, `finishedAt` | duration is derivable |
| `events[]` | `{ at, kind, text }` — kinds: `session`, `tool`, `subagent`, `sandbox`, `approval`, `mcp`, `resume`, `error`, `result` |
| `error` | the failure message, when it failed |

There is already a UI at `src/server/public/index.html` with a run list, a role
timeline, diff rendering, approval controls, and a live SSE feed. This plan
extends it rather than replacing it.

---

## 2. What is missing

### 2a. Token usage is silently zero — a real bug

Every run so far recorded `0 in / 0 out tokens`. The cause is in
`src/trueforge/run.ts`:

```ts
usage.inputTokens  += Number(event.usage.inputTokens  ?? 0);
usage.outputTokens += Number(event.usage.outputTokens ?? 0);
```

That reads the SDK's **typed** camelCase shape. But the stream is consumed as
`data as AnyEvent`, bypassing the SDK's deserializer, so the fields arrive in
their wire form — `input_tokens` / `output_tokens`. Neither key matches, both
default to `0`.

Fix — accept either:

```ts
const u = event.usage as Record<string, unknown>;
const n = (...keys: string[]) =>
  Number(keys.map((k) => u[k]).find((v) => v != null) ?? 0);

usage.inputTokens  += n('inputTokens', 'input_tokens');
usage.outputTokens += n('outputTokens', 'output_tokens');
usage.cacheReadTokens  += n('cacheReadTokens', 'cache_read_tokens');
usage.cacheWriteTokens += n('cacheWriteTokens', 'cache_write_tokens');
```

**There is a bonus here worth taking.** The harness also sends
`input_tokens_breakdown`, split into `harness`, `instructions`, `messages`,
`skills`, and `tool_definitions`. That means you can show a user *exactly what
the skill packs cost them* on every run — a number almost no agent product can
show, and a direct answer to "are the skill packs worth it?"

### 2b. The prompt is never stored

You cannot see what a role was asked. For debugging a bad classification this is
the single most useful field, and it is thrown away after the call.

### 2c. The raw model output is never stored

`extractJson()` parses the response and only the parsed object is kept. When
parsing fails, or the model returns something malformed, the raw text is gone —
which is precisely when you need it.

This is not hypothetical. The Changelog Author failed three runs in a row with:

```
the harness ended the turn in an error state: max_tokens breached
```

That message is actively misleading — it reads like a budget too small. The
actual cause was only visible in the raw output:

```
"entry": "Changed `--output? The `--format` flag? ... Let's. Let's. Let's. Let's."
```

The model was in a repetition loop. Storing the raw text would have made that
diagnosis immediate instead of a three-run investigation.

### 2d. No durations, no cost, no cross-run view

Durations are derivable from timestamps but never computed. Cost is not tracked
at all. There is no way to compare runs or spot a role getting slower.

---

## 3. Data model changes

Small, additive, backward-compatible — old records simply lack the fields.

```ts
export interface RoleTrace {
  // ... everything today, plus:

  /** Exactly what this role was asked. Truncate above ~100KB. */
  prompt?: string;
  /** Exactly what came back, before parsing. The field that matters on failure. */
  rawOutput?: string;
  /** Which model actually ran — roles can be pointed at different ones. */
  model?: string;
  durationMs?: number;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    /** harness / instructions / messages / skills / tool_definitions */
    inputBreakdown?: Record<string, number>;
  };
  /** How it failed, so the UI can choose what to show. */
  failure?: 'harness-error' | 'parse-error' | 'timeout' | 'aborted';
}

export interface RunRecord {
  // ... everything today, plus:
  durationMs?: number;
  totals?: { inputTokens: number; outputTokens: number; costUsd?: number };
}
```

**Store `rawOutput` even on success.** It is what makes a run auditable — a user
can see the model's actual words, not just your rendering of them.

**Size.** A run currently holds every proposed file's before *and* after. Adding
prompts and raw outputs roughly doubles it. Fine on disk; when you move to
Postgres, put `prompt`, `rawOutput`, and `proposedFiles` in a separate table so
listing runs stays cheap.

---

## 4. Three views

### View 1 — Run list

Scannable. The five dots are the whole story at a glance.

```
STATUS   COMMIT    SUBJECT                          ROLES      DUR    TOKENS   PR
● done   c29fc9e   feat!: rename --output to...     ●●●●●     4m12s   38.2k    #2
● gated  a91b0e2   feat: add --quiet flag           ●●●●●     3m48s   31.0k    —
● failed 7f3d201   refactor: split report module    ●●●○○     1m02s    9.4k    —
                                                       ↑
                                            Docs Updater failed
● done   7ee9a8e   feat: initial report command     ●●●●●     3m55s   28.7k    #1
```

Filters that earn their place: status, role-that-failed, date. Not much else.

### View 2 — Run detail: a waterfall

The five roles are not a flat list — two of them run **in parallel**. Show that;
it is true, and it explains the wall-clock time.

```
Change Analyst     ████████                              0:52   ✓  reused
Impact Mapper              ██████████                    1:04   ✓  reused
Docs Updater                         ████████████████    1:38   ✓  reused
Changelog Author                     ███████             0:41   ✓  reused
Coordinator                                       █████  0:37   ✓  reused
                   └─────────┴─────────┴─────────┴────
                   0:00      1:00      2:00      3:00
```

Under it, the run-level facts: classification, impacted docs, changelog entry,
validation checks, approval state, memory carried in/out — most of which the
current UI already renders.

Add a **token breakdown** panel, because you now have the data:

```
Tokens        input 31,204   output 6,998   cached 12,880

input split   instructions  8,412   ← the role's persona and task
              skills        5,110   ← the skill pack
              messages     17,204   ← the diff and doc excerpts
              harness         478
```

That `skills` number is the answer to "do the skill packs earn their keep."

### View 3 — Role detail

Click a role, get four tabs:

```
┌ Docs Updater ─────────────────────────────── ✓ done · 1m38s ─┐
│ model  nebius/deepseek-v4-pro    session 01m0vv5t… (reused)  │
│ turn   01m0vv780g…                        [open in TrueForge]│
├──────────────────────────────────────────────────────────────┤
│ [ Prompt ]  [ Raw output ]  [ Parsed ]  [ Events ]           │
└──────────────────────────────────────────────────────────────┘
```

- **Prompt** — verbatim, with the instructions and the user message separated
- **Raw output** — verbatim, before parsing
- **Parsed** — the JSON the pipeline acted on
- **Events** — the `events[]` timeline, icon per `kind`

Deep-link the session and turn ids to the TrueForge UI. Do not rebuild what the
harness already renders well.

---

## 5. Failure presentation

This is the part worth designing deliberately. There are four distinct failure
classes and they need different things shown.

| Failure | Where it surfaces | Show the user |
|---|---|---|
| **Harness error** (`max_tokens`, timeout, provider 5xx) | `trace.error` | The **raw output**, prominently. The error string is often misleading — `max_tokens breached` means a repetition loop as often as a small budget. |
| **Parse failure** (`extractJson` threw) | `trace.error` | The raw output with the failing region highlighted. Almost always the model wrapping JSON in prose, or truncation. |
| **Validation failure** | `run.validation.checks[]` | The specific check and its `detail`. `anchor-not-found` already reports the anchor that missed — surface that verbatim, it is the most actionable message in the system. |
| **Coordinator rejection** | `run.status === 'failed'`, `run.error` | The Coordinator's `concerns[]`. Not a bug — the system working. Style it as a *decision*, not an error. |

Two rules for the UI:

**Never show only the error string.** Always pair it with the raw output. The
three-run `max_tokens` investigation is the case study: the message pointed the
wrong way, the raw output pointed the right way immediately.

**A failed role must not hide the roles that succeeded.** Today a Changelog
Author failure rejects the `Promise.all` and discards the Docs Updater's
completed work. Even if the run cannot continue, persist and display what the
other roles produced — three of four roles had already done correct work in
every one of those failed runs, and none of it was visible.

---

## 6. Implementation order

Each step is useful on its own.

| # | Step | Why first |
|---|---|---|
| 1 | Fix the token-usage field names | One-line fix; every number in the UI is currently zero |
| 2 | Store `prompt`, `rawOutput`, `model`, `durationMs` on each trace | The rest is presentation of these |
| 3 | Roll up `totals` and `durationMs` onto the run | Makes the run list useful |
| 4 | Run list: status dots, duration, tokens | Highest value per line of code |
| 5 | Role detail: the four tabs | Where users actually debug |
| 6 | Failure rules from §5 | Turns a bad run into a diagnosable one |
| 7 | Waterfall view | The parallelism is genuinely interesting; pure presentation |
| 8 | Token breakdown panel | Needs §2a's breakdown capture |
| 9 | Persist partial results when a role fails | Behaviour change; do it deliberately |

Steps 1–3 are backend and roughly an afternoon. 4–6 are the product.

---

## 7. Later

**Cost.** Nebius bills per token per model. A small price table plus the usage
you are now capturing gives per-run and per-role cost. Users care about this more
than latency.

**Retention.** Run records grow with prompts and raw outputs. Postgres, with
large columns in a side table; drop bodies past N days but keep the summary row
so the history stays intact.

**Cross-run trends.** Once several runs exist: classification confidence over
time, which docs go stale most often, which role fails most. This is the report
that makes the tool feel like infrastructure rather than a script.

**Export.** A `docxy show <run-id> --json` already exists and is the whole record.
Keep it — it is the escape hatch that makes the UI optional.
