---
name: docs-style
description: Documentation voice, structure, and editing conventions for this repository.
---

# Documentation style

## Voice

Instructional and present-tense. Address the reader as "you". Describe what the
software does, not what it will do. Prefer the concrete noun to the abstract one.

- Good: "Pass `--format json` to get machine-readable output."
- Bad: "Users may optionally leverage the format functionality."

Never write "simply", "just", "easy", or "obviously". If a step is hard, the
sentence should say what makes it hard.

## Structure

- Headings are sentence case, not title case.
- A section opens with what the thing is for, then how to use it, then the edge
  cases. Never open with a caveat.
- Code examples are complete enough to run. If an example needs an import or an
  env var, show it.
- Reference tables list the parameter, its type, its default, and what it does —
  in that order.

## Editing rules

You are editing existing prose, not rewriting it. This matters more than style:

- **Change the smallest span that makes the doc correct.** If one flag name is
  stale, replace that sentence, not the section.
- **Match the surrounding voice** even where it differs from this guide. A
  consistent doc beats a doc with one paragraph in a different register.
- **Preserve formatting exactly** — indentation, list markers, fence languages,
  and trailing punctuation.
- **Never touch an unrelated line.** A diff that reflows a paragraph hides the
  real change from the reviewer.

## Producing edits

Each edit is a `find`/`replace` pair. The `find` text must appear **verbatim and
exactly once** in the file as given to you — copy it character for character,
including indentation. If you cannot find a unique anchor, widen the `find` span
until it is unique rather than guessing.

Use `mode: "append"` only to add a genuinely new section at the end of a file,
and leave `find` empty when you do.

If a doc listed as impacted turns out not to need a change, put it in `skipped`
with a reason. Reporting an honest no-op is a correct answer.
