import type { ReactNode } from "react";
import {
  SiGithub,
  SiGithubactions,
  SiClaude,
  SiMarkdown,
  SiKeepachangelog,
  SiSemver,
} from "react-icons/si";

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
