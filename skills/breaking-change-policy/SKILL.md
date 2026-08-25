---
name: breaking-change-policy
description: How this repository decides whether a change is breaking, and what counts as public surface.
---

# Breaking-change policy

## What counts as public surface

Public surface is anything a consumer can depend on without reading the source:

- Exported functions, classes, types, and constants in package entry points
- HTTP routes, their request/response shapes, and status codes
- CLI commands, flags, and their output format when documented
- Configuration keys, environment variables, and their accepted values
- Serialized formats written to disk or the wire

Not public surface: anything under an `internal/`, `_private`, or test path; a
symbol that is exported only so a sibling module can import it and is absent from
the docs; and log or debug output.

## What makes a change breaking

A change is **breaking** when working consumer code stops working after upgrade
without the consumer changing anything:

- Removing or renaming a public symbol, route, flag, or config key
- Narrowing an accepted input — a new required parameter, a tightened type, a
  stricter validation rule
- Widening a return type in a way callers must now handle, or removing a field
- Changing a default value in a way that alters observable behavior
- Changing an error type, code, or the conditions under which it is raised

A change is **not** breaking when:

- Behavior changes only under a flag that defaults off
- A new optional parameter is added with a default matching prior behavior
- The change is confined to internal surface, tests, or build tooling
- A bug is fixed such that the code now matches its documented contract — say so
  explicitly in the rationale, because this is the case most often misjudged

## Classification tags

Pick exactly one `kind`:

- `breaking` — meets the test above; always pairs with a major bump
- `feature` — adds public surface without removing or narrowing any
- `fix` — corrects behavior to match its documented or obviously intended contract
- `chore` — build, CI, dependency, formatting, or internal refactor with no
  observable change in public behavior

Pick exactly one `surface`: `public-api`, `internal`, `config`, `test-only`, or
`docs-only`.

## Calibration

State the rationale in terms of a consumer, not the diff: "a caller passing two
arguments now gets a type error" beats "the signature changed". When the diff is
genuinely ambiguous, say so and lower your confidence rather than picking
confidently at random — a hedged classification is useful, a wrong confident one
is not.
