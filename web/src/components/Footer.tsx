import { SiGithub } from "react-icons/si";
import { site } from "@/lib/site";
import { Wordmark } from "./Logo";

const columns = [
  {
    heading: "Product",
    links: [
      { label: "How it works", href: "#how-it-works" },
      { label: "The five agents", href: "#roster" },
      { label: "Approvals", href: "#approval" },
      { label: "What it costs", href: "#setup" },
    ],
  },
  {
    heading: "Get started",
    links: [
      { label: "Install the GitHub App", href: site.install },
      { label: "Use the Action", href: site.repo },
      { label: "Run it yourself", href: site.docs },
      { label: "Configuration", href: `${site.repo}/blob/main/.env.example` },
    ],
  },
  {
    heading: "Reference",
    links: [
      { label: "Documentation", href: site.docs },
      { label: "Changelog", href: `${site.repo}/blob/main/CHANGELOG.md` },
      { label: "Skill packs", href: `${site.repo}/tree/main/skills` },
      { label: "Report an issue", href: `${site.repo}/issues` },
    ],
  },
  {
    heading: "Built on",
    links: [
      { label: "TrueForge", href: site.trueforge },
      { label: "Nebius Token Factory", href: site.nebius },
      { label: "Keep a Changelog", href: "https://keepachangelog.com" },
      { label: "Semantic Versioning", href: "https://semver.org" },
    ],
  },
];

export function Footer() {
  return (
    <footer className="max-w-7xl mx-auto px-6 lg:px-14 py-16">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-10 mb-16">
        <div className="sm:col-span-2">
          <div className="mb-4">
            <Wordmark />
          </div>
          <p className="text-sm text-zinc-500 leading-relaxed max-w-xs mt-3">
            {site.tagline}. Five agents write the update, GitHub delivers it as
            a pull request, and you decide whether it ships.
          </p>
          <a
            href={site.install}
            className="inline-flex items-center gap-1.5 mt-6 text-sm font-medium bg-zinc-900 text-white px-4 py-2 hover:bg-zinc-700 transition-colors"
          >
            <SiGithub size={14} />
            Install the GitHub App
          </a>
        </div>

        {columns.map((col) => (
          <div key={col.heading}>
            <p className="text-xs font-semibold text-zinc-400 mb-4">
              {col.heading}
            </p>
            <ul className="space-y-3">
              {col.links.map((link) => (
                <li key={link.label}>
                  <a
                    href={link.href}
                    className="text-sm text-zinc-500 hover:text-zinc-900 transition-colors"
                  >
                    {link.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <div className="pt-8 border-t border-zinc-100 flex flex-col sm:flex-row items-center justify-between gap-4">
        <p className="text-xs text-zinc-400">
          © {new Date().getFullYear()} Docxy. Released under the MIT License.
        </p>
        <p className="text-xs text-zinc-400">
          Nothing merges without your approval.
        </p>
      </div>
    </footer>
  );
}
