---
name: changelog-voice
description: Changelog entry format, voice, and semver policy for this repository.
---

# Changelog voice

The changelog is read by someone deciding whether to upgrade. It is not the docs
and not the commit log. Write for that decision.

## Format

Keep a Changelog conventions. One entry per change, under exactly one of:
`Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`.

An entry is **one line**, starts with a capital letter, ends without a period,
and is written in the imperative-adjacent past tense used by the existing file.

- Good: `Renamed the --output flag to --format; --output still works and warns`
- Bad: `This release includes a change to the output flag which has been renamed`

## Voice

Terse and user-facing. Name the user-visible thing that changed, not the
internal one. `Fixed a crash when the config file is empty` — not `Fixed a null
dereference in ConfigLoader.parse`.

Mention the migration inline when one is needed. If a change is breaking, the
entry must say what the reader has to do about it, in the same line.

## Semver policy

- `major` — any `breaking` classification, without exception
- `minor` — new public surface added, nothing removed or narrowed
- `patch` — a `fix` with no public surface change
- `none` — `chore` or `test-only`; nothing users can observe

State the bump rationale in one sentence referencing the classification you were
given. If the classification says breaking and you propose anything below major,
you are wrong — defer to the classification.

## What not to do

- Do not write more than one entry for one commit. Pick the change that matters.
- Do not repeat the docs. The reader can click through.
- Do not mention refactors, tests, or CI unless they change what users get.
