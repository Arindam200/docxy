/**
 * Every piece of copy and every outbound link on the marketing page.
 * Sections read from here so wording changes never mean touching layout.
 */

export const site = {
  name: "docxy",
  tagline: "Documentation that keeps up with your code",
  description:
    "Install the GitHub App and every push wakes five agents. They read the diff, find the docs that went stale, rewrite them, draft the release note, and open a pull request for you to approve.",
  repo: "https://github.com/Arindam200/docxy",
  install: "https://github.com/apps/docxy",
  docs: "https://github.com/Arindam200/docxy#readme",
  trueforge: "https://trueforge.dev",
  nebius: "https://tokenfactory.nebius.com",
} as const;

export const author = {
  name: "Arindam Majumder",
  title: "Creator of Docxy · Co-founder, Studio1",
  avatar: "/pfp-avatar.png",
  /**
   * The quote is split into runs so the beats can be highlighted.
   * `hl: true` renders in the accent colour.
   */
  quote: [
    { t: "I got tired of writing " },
    { t: "the same docs twice", hl: true },
    {
      t: ". Ship the feature, forget the page, remember it a week later. Once the team grew it stopped being ",
    },
    { t: "one page and became ten", hl: true },
    {
      t: ", spread across a repo nobody had read end to end, and the community was already in the issues telling us ",
    },
    { t: "the examples were broken", hl: true },
    {
      t: ". Docxy is the thing I kept wishing existed while I was the one falling behind.",
    },
  ],
} as const;

export const nav = [
  { label: "How it works", href: "#how-it-works" },
  { label: "The agents", href: "#roster" },
  { label: "Approvals", href: "#approval" },
  { label: "Install", href: "#setup" },
  { label: "Docs", href: site.docs },
] as const;

export const why = [
  {
    title: "Install it once, forget it",
    body: "No CLI to run, no scripts to babysit. Add the GitHub App to your org, pick your repos, and it starts watching. Every push is a chance to catch drift.",
  },
  {
    title: "Five agents, not one prompt",
    body: "Classify the change. Map what it broke. Rewrite the docs. Draft the release note. Review the lot. Each step is a separate agent with its own judgment, and the last one throws out work that contradicts itself.",
  },
  {
    title: "It remembers your repo",
    body: "Every agent keeps a long-lived session per repository, backed by a saved map of which symbol lives in which doc section. The tenth run knows things the first one had to work out.",
  },
  {
    title: "Checked before you read it",
    body: "Every edit has to anchor to text that really exists in your file, word for word, exactly once. Invented quotes fail the run instead of landing in your docs as a broken patch.",
  },
  {
    title: "Reads code, not commit messages",
    body: "Changelog tools that parse commit subjects fall apart the week your team gets sloppy. Docxy reads the actual diff, so a lazy commit message still gets an accurate release note.",
  },
  {
    title: "You have the last word",
    body: "Nothing merges on its own. Every run lands as a normal pull request with a summary of what changed and why, and it sits there until a human approves it.",
  },
] as const;

export const roles = [
  {
    step: "01",
    title: "Change Analyst",
    job: "Works out what kind of change you just shipped",
    skill: "breaking-change-policy",
    detail:
      "Breaking, feature, fix, or chore, crossed with public API, internal, config, or test. Everything downstream leans on this call, so it is tuned to be careful rather than confident.",
  },
  {
    step: "02",
    title: "Impact Mapper",
    job: "Finds the docs and downstream code that just went stale",
    skill: "impact-map-hints",
    detail:
      "Loads the saved symbol to doc-section map before it starts, so it builds on what earlier runs figured out instead of tracing the same links from scratch every time.",
  },
  {
    step: "03",
    title: "Docs Updater",
    job: "Makes the smallest edit that makes each page correct",
    skill: "docs-style",
    detail:
      "Plain instructional prose, anchored to text that already exists in the file. It proposes the minimum change that makes a section true again, never a rewrite you did not ask for.",
  },
  {
    step: "04",
    title: "Changelog Author",
    job: "Writes the release note and proposes a version bump",
    skill: "changelog-voice",
    detail:
      "A deliberately different voice from the docs. Terse release-note register, one entry per change, plus the semver bump the change actually earns.",
  },
  {
    step: "05",
    title: "Coordinator",
    job: "Reviews the other four and writes your summary",
    skill: null,
    detail:
      "The last stop before a human. A breaking change paired with a minor bump does not get through, and the summary you read on the pull request is written here.",
  },
] as const;

export const validations = [
  { label: "Edit anchors", detail: "real text, exactly once" },
  { label: "Relative links", detail: "every path resolves" },
  { label: "In-page anchors", detail: "every heading exists" },
  { label: "Version bumps", detail: "breaking means major" },
  { label: "Docs build", detail: "your own command" },
  { label: "Test suite", detail: "your own command" },
] as const;

export const integrations = [
  { name: "GitHub", detail: "Install once, every repo covered" },
  { name: "GitHub Actions", detail: "Fires on push and pull request" },
  { name: "Claude", detail: "The agent behind the roster" },
  { name: "Nebius", detail: "Token Factory models" },
  { name: "TrueForge", detail: "The open agent harness" },
  { name: "Markdown & MDX", detail: "Small, anchored edits" },
  { name: "Keep a Changelog", detail: "Release note format" },
  { name: "Semantic Versioning", detail: "Bump proposals" },
] as const;

export const faqs = [
  {
    q: "What is Docxy?",
    a: "A GitHub App that keeps your documentation and changelog in step with your code. Install it, and every push wakes a Claude agent running a harness of five specialists. They classify the change, trace what it broke, rewrite the affected docs, draft the release note, and open a pull request for you to review.",
  },
  {
    q: "Do I have to run anything myself?",
    a: "No. Installing the GitHub App is the whole setup. It runs on GitHub's side and shows up as a pull request on your repo. If you would rather host it yourself, the same pipeline ships as a CLI and a GitHub Action you can drop into your own workflow.",
  },
  {
    q: "When does it trigger?",
    a: "On push to your default branch by default. You can point it at pull requests instead, or restrict it to certain paths, in the app settings or in the Action's workflow file.",
  },
  {
    q: "How is this different from Swimm, Mintlify, or semantic-release?",
    a: "Each of those owns one slice in a single flat pass. Swimm syncs doc snippets with no impact mapping and no changelog. semantic-release reads your commit messages rather than your diff. Blast-radius tools hand you a report you still have to act on. Docxy chains all of it as separate agents that check each other.",
  },
  {
    q: "Will it merge anything without me?",
    a: "Never. Every run stops at a pull request. Routine docs fixes need one approval. Anything breaking, anything touching public API, and anything proposing a major bump needs two approvals from two different people, and the same reviewer cannot count twice.",
  },
  {
    q: "What if nobody reviews a run?",
    a: "Nothing expires in either direction. The pull request sits open and gets flagged as stale. It never merges itself and it never quietly disappears.",
  },
  {
    q: "How do I stop it inventing things?",
    a: "The strictest check runs first. Every proposed edit has to anchor to text that appears in your file word for word, exactly once. A paraphrased anchor fails the run rather than producing a broken patch. Links, in-page anchors, version consistency, and your own docs build and test commands all run too.",
  },
  {
    q: "Can I tune it for my repo?",
    a: "Yes, and editing the skill packs is the intended way. Four plain SKILL.md files hold the judgment that would otherwise be buried in a prompt: what counts as breaking, how to trace impact, your docs voice, your changelog voice. Start with breaking-change-policy.",
  },
] as const;
