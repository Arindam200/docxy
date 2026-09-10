import { SiGithub } from "react-icons/si";
import { site } from "@/lib/site";
import { Wordmark } from "./Logo";

const columns = [
  {
    heading: "Product",
    links: [
      { label: "How it works", href: "#how-it-works" },
      { label: "Features", href: "#roster" },
      { label: "Review workflow", href: "#approval" },
      { label: "Pricing", href: "#cost" },
    ],
  },
  {
    heading: "Get started",
    links: [
      { label: "Sign up", href: "/signup" },
      { label: "Sign in", href: "/login" },
      { label: "Dashboard", href: "/dashboard" },
      { label: "How to set up", href: "#setup" },
    ],
  },
  {
    heading: "Resources",
    links: [
      { label: "FAQs", href: "#faq" },
      { label: "GitHub repository", href: site.repo },
      { label: "Report an issue", href: `${site.repo}/issues` },
      { label: "Request a feature", href: `${site.repo}/issues/new?title=Feature%20request%3A%20` },
    ],
  },
];

export function Footer() {
  return (
    <footer className="max-w-7xl mx-auto px-6 lg:px-14 py-16">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-10 mb-16">
        <div className="sm:col-span-2">
          <div className="mb-4">
            <Wordmark />
          </div>
          <p className="text-sm text-zinc-500 leading-relaxed max-w-xs mt-3">
            {site.tagline}. Review every update in GitHub.
          </p>
          <a
            href="/signup"
            className="inline-flex items-center gap-1.5 mt-6 text-sm font-medium bg-zinc-900 text-white px-4 py-2 hover:bg-zinc-700 transition-colors"
          >
            <SiGithub size={14} />
            Get started
          </a>
        </div>

        {columns.map((col) => (
          <nav key={col.heading} aria-label={`Footer ${col.heading.toLowerCase()}`}>
            <h2 className="text-xs font-semibold text-zinc-400 mb-4">
              {col.heading}
            </h2>
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
          </nav>
        ))}
      </div>

      <div className="pt-8 border-t border-zinc-100 flex flex-col sm:flex-row items-center justify-between gap-4">
        <p className="text-xs text-zinc-400">
          © {new Date().getFullYear()} Docxy. Released under the MIT License.
        </p>
        <p className="text-xs text-zinc-400">
          You decide what gets merged.
        </p>
      </div>
    </footer>
  );
}
