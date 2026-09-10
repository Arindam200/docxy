import { formatUsd, planList, type PlanKey } from "@billing";

/**
 * Shared copy and outbound links on the marketing page.
 * Sections read from here so wording changes never mean touching layout.
 */

export const site = {
  name: "docxy",
  /**
   * The canonical origin. Metadata is built at build time, so this is a
   * constant rather than a request-time lookup - `BETTER_AUTH_URL` overrides it
   * where a deployment answers on something else, which is what keeps a preview
   * from advertising production's URL as its own canonical.
   */
  url: "https://docxy.app",
  tagline: "Documentation that keeps up with your code",
  description:
    "Keep your docs and release notes up to date as you ship. Review the changes in GitHub and get back to building.",
  repo: "https://github.com/Arindam200/docxy",
  install: "https://github.com/apps/docxy",
  docs: "https://github.com/Arindam200/docxy#readme",
  mastra: "https://mastra.ai",
  daytona: "https://www.daytona.io",
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
    { t: "Ship the feature, " },
    { t: "forget the page", hl: true },
    { t: ", remember it a week later. Docxy is the thing I kept wishing existed while I was the one falling behind." },
  ],
} as const;

export const nav = [
  { label: "How it works", href: "#how-it-works" },
  { label: "Features", href: "#roster" },
  { label: "Review", href: "#approval" },
  { label: "Pricing", href: "#cost" },
] as const;

export const why = [
  {
    title: "Less manual upkeep",
    body: "Get suggested doc updates when your code changes, without writing them from scratch.",
  },
  {
    title: "Docs and release notes together",
    body: "Review both in one pull request, with a summary of what changed.",
  },
  {
    title: "You control the merge",
    body: "Use your existing GitHub review process. Docxy never merges for you.",
  },
] as const;

export const roles = [
  {
    step: "01",
    title: "Find affected docs",
    job: "See which pages need attention after a code change.",
  },
  {
    step: "02",
    title: "Review focused edits",
    job: "Get targeted updates to your existing Markdown and MDX files.",
  },
  {
    step: "03",
    title: "Keep a useful changelog",
    job: "Get a release note and a suggested version bump based on the diff.",
  },
  {
    step: "04",
    title: "Follow your writing style",
    job: "Set instructions for your docs and release notes.",
  },
  {
    step: "05",
    title: "Track every update",
    job: "See progress, check results, and pull requests in one dashboard.",
  },
] as const;

export const validations = [
  { label: "Edits", detail: "match the existing file" },
  { label: "Links", detail: "point to existing files" },
  { label: "Heading links", detail: "point to existing sections" },
  { label: "Version bumps", detail: "match the change" },
  { label: "Docs build", detail: "runs when configured" },
  { label: "Tests", detail: "run when configured" },
] as const;

export const integrations = [
  { name: "GitHub", detail: "Code changes and pull requests" },
  { name: "Mastra", detail: "Update workflow" },
  { name: "Nebius", detail: "AI models" },
  { name: "Daytona", detail: "Docs build checks" },
  { name: "Neon", detail: "Run history" },
  { name: "GitHub Actions", detail: "Manual runs" },
  { name: "Markdown & MDX", detail: "Your existing docs" },
  { name: "Semantic Versioning", detail: "Version suggestions" },
] as const;

/**
 * The hosted offer, as the pricing page shows it.
 *
 * Derived from the billing catalog rather than restated here. The page used to
 * carry its own copy of the prices and allowances, which is one place for them
 * to be wrong: a plan sold as fifteen runs and metered at three is a support
 * ticket, not a typo. The catalog is the single source, shared with checkout
 * and with admission - see src/billing/catalog.ts and guides/PRICING.md.
 *
 * Only what the catalog has no opinion about lives here: the line of copy that
 * says why somebody should move up a plan.
 */
const planPitch = {
  free: "No credit card required",
  pro: "5× the Free allowance",
  team: "Shared run allowance across repositories",
} satisfies Record<PlanKey, string>;

export const hostedPlans = planList.map((plan) => ({
  name: plan.name,
  description: plan.description,
  /** Already formatted, because the catalog holds cents and the page holds copy. */
  price: formatUsd(plan.monthlyPriceMinor),
  repositories: plan.entitlements.repositories,
  runsPerMonth: plan.entitlements.runsPerMonth,
  trigger: plan.entitlements.automaticRuns
    ? "Automatic runs on push + manual runs"
    : "Start runs manually",
  benefit: planPitch[plan.key],
  featured: plan.featured,
}));

export const faqs = [
  {
    q: "What does Docxy do?",
    a: "Docxy reads your code changes and opens a pull request with suggested doc updates and release notes. Your team reviews and merges it in GitHub.",
  },
  {
    q: "Which docs can it update?",
    a: "Markdown and MDX files in your GitHub repository, including your README and changelog. You choose which docs to track.",
  },
  {
    q: "When does it run?",
    a: "Free lets you start runs manually. Pro and Team also run automatically when you push to a connected repository’s default branch.",
  },
  {
    q: "Will it merge changes for me?",
    a: "No. Docxy opens the pull request. Your team reviews and merges it using your GitHub review rules.",
  },
  {
    q: "What if a check fails?",
    a: "The update opens as a draft pull request with the failed checks listed. Docs builds and tests run only when configured.",
  },
  {
    q: "Can it follow our writing style?",
    a: "Yes. Add instructions for your docs and release notes, including terminology, tone, and formatting.",
  },
  {
    q: "Do we need our own API keys?",
    a: "No. Hosted plans include AI usage, validation, and hosting. Self-hosting is also available with your own infrastructure.",
  },
  {
    q: "How does pricing work?",
    a: "Free includes 3 runs per month on 1 repository. Pro is $19/month for 15 runs on 1 repository. Team is $129/month for 120 runs shared across 5 repositories. All plans include AI usage, validation, and hosting.",
  },
] as const;
