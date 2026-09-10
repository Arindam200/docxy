import Link from "next/link";
import { LuArrowUpRight, LuGitBranch, LuPlug, LuSlidersHorizontal } from "react-icons/lu";

const actions = [
  { href: "/dashboard/projects/new", label: "Connect a repository", description: "Choose one repository to keep documented.", icon: LuGitBranch },
  { href: "/dashboard/settings#instructions", label: "Set writing preferences", description: "Keep updates consistent with your style.", icon: LuSlidersHorizontal },
  { href: "/dashboard/integrations", label: "Integrations", description: "Connect services and manage repository access.", icon: LuPlug },
];

export function QuickActions() {
  return (
    <nav aria-label="Quick actions" className="grid gap-3 md:grid-cols-3">
      {actions.map(({ href, label, description, icon: Icon }) => (
        <Link
          key={href}
          href={href}
          className="focus-ring group flex items-center gap-3 border border-rule bg-surface p-4 transition-colors hover:border-accent/40 hover:bg-surface-2"
        >
          <span className="flex h-9 w-9 shrink-0 items-center justify-center border border-rule bg-surface-2 text-muted group-hover:text-accent">
            <Icon size={17} aria-hidden />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium">{label}</span>
            <span className="mt-1 block text-xs leading-relaxed text-muted">{description}</span>
          </span>
          <LuArrowUpRight size={14} className="shrink-0 text-muted" aria-hidden />
        </Link>
      ))}
    </nav>
  );
}

export function NoRunsYet() {
  return (
    <div className="border border-dashed border-rule px-5 py-6">
      <p className="text-sm font-medium">Your first update starts with a push</p>
      <p className="mt-1 text-xs leading-relaxed text-muted">
        Once a repository is connected, push to its default branch. Your documentation updates will appear here.
      </p>
    </div>
  );
}
