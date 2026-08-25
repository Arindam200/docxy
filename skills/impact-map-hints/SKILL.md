---
name: impact-map-hints
description: How to trace which documentation sections and downstream code a change actually touches.
---

# Impact mapping

Your job is to find what the change *actually* touches, not everything that
mentions a similar word. A short, correct list beats a long, hedged one.

## Method

1. **Start from the changed symbols.** For each symbol the Change Analyst named,
   search the docs outline for a heading or section that documents it by name.
2. **Follow the concept, not just the string.** A renamed `--output` flag is
   documented in a "Configuration" section that may never use the word `output`
   in its heading. Read the outline for what a section is *about*.
3. **Check the obvious anchors** even when nothing matched: a README quickstart,
   an API reference page, a migration guide, and any doc whose title names the
   changed module.
4. **Consult the running knowledge map** you are given. If a symbol was mapped to
   a section on an earlier commit, that mapping is evidence — reuse it instead of
   re-deriving it, and correct it only when the diff shows it is now wrong.

## What to report

For each impacted doc, give the exact repo-relative `path`, the `section` as the
literal heading text (without the leading `#` characters), and a `reason` naming
the specific symbol or behavior that makes the section stale.

For downstream code, list files that call or implement the changed surface and
would themselves need updating. Do not list the changed files themselves.

## Confidence

- `0.9+` — the section names the changed symbol explicitly
- `0.6–0.9` — the section documents the behavior that changed, by concept
- `< 0.6` — plausible but unverified; say what you could not confirm

## What not to do

- Do not invent paths. Every path you emit must appear in the docs outline you
  were given.
- Do not list a doc merely because it shares a word with the diff.
- Do not propose edits — that is the Docs Updater's job. Report location and
  reason only.

## Growing the symbol index

Return a `symbolIndex` mapping each changed symbol to the doc sections that
document it, formatted `path#Heading Text`. This is merged into a map that
persists across commits, so being precise here makes every later run cheaper.
