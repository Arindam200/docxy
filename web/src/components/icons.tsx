import type { ReactNode } from "react";
import {
  SiGithub,
  SiGithubactions,
  SiClaude,
  SiMarkdown,
  SiKeepachangelog,
  SiSemver,
  SiNeon,
} from "react-icons/si";
import {
  SiBitbucket,
  SiDiscord,
  SiGitlab,
  SiIntercom,
  SiJira,
  SiLinear,
  SiNotion,
  SiZapier,
} from "react-icons/si";
// Simple Icons dropped Slack's mark; Font Awesome still carries it.
import { FaSlack } from "react-icons/fa6";
import { LuPlug, LuWebhook } from "react-icons/lu";

/**
 * Real brand marks for the integration tiles. Simple Icons covers most of them;
 * Nebius and TrueForge have no Simple Icons entry, so their own favicons are
 * vendored under public/brand instead of hotlinked.
 */
export const brandIcons: Record<string, ReactNode> = {
  GitHub: <SiGithub size={20} color="#24292e" />,
  "GitHub Actions": <SiGithubactions size={20} color="#2088FF" />,
  Claude: <SiClaude size={20} color="#D97757" />,
  Nebius: (
    // eslint-disable-next-line @next/next/no-img-element
    <img src="/brand/nebius.png" alt="" width={20} height={20} aria-hidden />
  ),
  TrueForge: (
    // eslint-disable-next-line @next/next/no-img-element
    <img src="/brand/trueforge.png" alt="" width={20} height={20} aria-hidden />
  ),
  "Markdown & MDX": <SiMarkdown size={20} color="#18181b" />,
  "Keep a Changelog": <SiKeepachangelog size={20} color="#E05735" />,
  "Semantic Versioning": <SiSemver size={20} color="#3F4551" />,
};

/**
 * The same marks again, sized and coloured for the dark dashboard: brand hexes
 * that only pass on white (GitHub's near-black, Markdown's zinc) give way to
 * `currentColor` so the tile inherits the card's foreground. Keyed by the
 * integration `id` the API reports, with `plug` as the fallback for anything
 * added server-side that has no mark here yet.
 */
export const integrationIcons: Record<string, ReactNode> = {
  "github-app": <SiGithub size={20} />,
  "github-webhook": <LuWebhook size={20} />,
  neon: <SiNeon size={20} color="#00E599" />,
  nebius: (
    // eslint-disable-next-line @next/next/no-img-element
    <img src="/brand/nebius.png" alt="" width={20} height={20} aria-hidden />
  ),
  trueforge: (
    // eslint-disable-next-line @next/next/no-img-element
    <img src="/brand/trueforge.png" alt="" width={20} height={20} aria-hidden />
  ),
  plug: <LuPlug size={20} />,
};

/**
 * The catalogue's brand marks, keyed by entry id.
 *
 * Brand hexes are picked for the dark ground: Slack's aubergine and Algolia's
 * navy both disappear against it, so each falls back to the lighter mark from
 * the same palette. Anything monochrome inherits `currentColor` and follows the
 * card, which is what keeps a "coming soon" tile reading as muted.
 */
export const catalogIcons: Record<string, ReactNode> = {
  github: <SiGithub size={22} />,
  slack: <FaSlack size={22} color="#36C5F0" />,
  discord: <SiDiscord size={22} color="#5865F2" />,
  webhooks: <LuWebhook size={22} />,
  notion: <SiNotion size={22} />,
  linear: <SiLinear size={22} color="#7B87E8" />,
  jira: <SiJira size={22} color="#2684FF" />,
  zapier: <SiZapier size={22} color="#FF6A2B" />,
  gitlab: <SiGitlab size={22} color="#FC6D26" />,
  bitbucket: <SiBitbucket size={22} color="#2684FF" />,
  intercom: <SiIntercom size={22} color="#3B9CF5" />,
};
