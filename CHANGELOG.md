# Changelog

All notable changes to Docxy are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Five-role documentation pipeline on the TrueForge harness: Change Analyst,
  Impact Mapper, Docs Updater, Changelog Author, and Coordinator
- Nebius Token Factory registered as a custom OpenAI-compatible model provider
- One long-lived agent session per role, per repository, so what a role learns on
  one commit carries to the next
- A persistent symbol-to-doc-section map, reused by the Impact Mapper each run
- Pre-review validation: verbatim edit anchors, relative links and in-page
  anchors, semver consistency, plus your own docs-build and test commands
- The docs build runs **inside the harness sandbox** rather than against your
  checkout — it is the one check that executes a command over text a model
  wrote. No third-party account needed: a standalone harness carries its own
  sandbox, and `DAYTONA_API_KEY` switches to a remote one. Every executed check
  records whether it ran in the sandbox or locally
- Graduated approval — one sign-off for routine changes, two different reviewers
  for breaking or public-API changes — with no expiry in either direction
- Timeline UI showing what each role did, with the approval gate inline
- Pull requests opened from a throwaway git worktree, leaving your checkout alone
- GitHub Action gating publication on a protected environment
