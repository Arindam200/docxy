"use client";

import { useToast } from "./Toast";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  LuArrowLeft,
  LuGithub,
  LuGitBranch,
  LuFolderOpen,
  LuHouse,
  LuPlug,
  LuLogOut,
  LuChartLine,
  LuScrollText,
  LuSettings,
  LuUsers,
  LuZap,
} from "react-icons/lu";
import { signOut } from "@/lib/auth-client";
import { projectHref } from "@/lib/projects";
import type { DashboardUser } from "@/lib/user";

/**
 * Collapsed icon rail: logo up top, routed nav with hover tooltips, identity
 * pinned to the bottom. Active state follows the current path.
 */

/** One rail entry. */
interface NavItem {
  href: string;
  label: string;
  icon: ReactNode;
  /** Sub-paths that should keep this entry lit. Defaults to the href itself. */
  match?: (pathname: string) => boolean;
}

/** Organization navigation stays separate from each project's own sections. */
const ORGANIZATION_NAV: NavItem[] = [
  {
    href: "/dashboard",
    label: "Overview",
    icon: <LuHouse />,
    match: (pathname) => pathname === "/dashboard",
  },
  {
    href: "/dashboard/projects",
    label: "Projects",
    icon: <LuFolderOpen />,
    match: (pathname) => pathname === "/dashboard/projects",
  },
  {
    href: "/dashboard/repositories",
    label: "Repositories",
    icon: <LuGitBranch />,
    match: (pathname) => pathname.startsWith("/dashboard/repositories") || pathname === "/dashboard/projects/new",
  },
  {
    href: "/dashboard/integrations",
    label: "Integrations",
    icon: <LuPlug />,
    match: (pathname) => pathname.startsWith("/dashboard/integrations"),
  },
  { href: "/dashboard/members", label: "Members", icon: <LuUsers /> },
  {
    href: "/dashboard/settings",
    label: "Settings",
    icon: <LuSettings />,
    // Older instruction links still belong to Settings.
    match: (pathname) =>
      pathname.startsWith("/dashboard/settings") ||
      pathname.startsWith("/dashboard/instructions"),
  },
];

/**
 * Inside a project, the same rail lists that project's sections.
 *
 * Every one of these used to be an organization-wide page mixing every
 * repository together, which meant arriving with "how is acme/api doing" and
 * having to filter a shared list by eye. They read the same endpoints, narrowed
 * to the one repository this project watches.
 */
function projectNav(id: string): NavItem[] {
  const base = projectHref(id);
  return [
    { href: base, label: "Overview", icon: <LuHouse />, match: (pathname) => pathname === base },
    {
      href: projectHref(id, "activity"),
      label: "Activity",
      icon: <LuZap />,
      // Run detail is one run out of this list, and it lives under the
      // project's own path now, so it lights Activity rather than stranding
      // the rail on nothing.
      match: (pathname) =>
        pathname.startsWith(`${base}/activity`) || pathname.startsWith(`${base}/runs`),
    },
    { href: projectHref(id, "logs"), label: "Logs", icon: <LuScrollText /> },
    { href: projectHref(id, "insights"), label: "Insights", icon: <LuChartLine /> },
    { href: projectHref(id, "settings"), label: "Settings", icon: <LuSettings /> },
  ];
}

/**
 * The project this path is inside, or null.
 *
 * Read from the URL rather than passed down, because the rail is rendered by
 * the dashboard layout and the project layout sits below it - there is no prop
 * that could travel upward. The path already carries the answer.
 *
 * `new` is the connect form rather than a project id, and treating it as one
 * would put somebody inside a project that does not exist while they are still
 * choosing a repository.
 */
export function projectIdFromPath(pathname: string): string | null {
  const match = /^\/dashboard\/projects\/([^/]+)/.exec(pathname);
  if (!match || match[1] === "new") return null;
  return decodeURIComponent(match[1]);
}

function RailButton({
  href,
  label,
  icon,
  active,
}: {
  href: string;
  label: string;
  icon: ReactNode;
  active?: boolean;
}) {
  return (
    <Link
      href={href}
      aria-label={label}
      aria-current={active ? "page" : undefined}
      className={`focus-ring group relative flex h-9 w-9 mx-auto items-center justify-center rounded-md transition-colors ${
        active
          ? "bg-accent/10 text-accent"
          : "text-muted hover:bg-surface-2 hover:text-foreground"
      }`}
    >
      <span className="h-[18px] w-[18px] [&>svg]:h-full [&>svg]:w-full">{icon}</span>
      <span className="pointer-events-none absolute left-[calc(100%+10px)] top-1/2 -translate-y-1/2 z-50 whitespace-nowrap rounded-md bg-zinc-100 px-2.5 py-1.5 text-xs font-semibold text-zinc-900 opacity-0 invisible shadow-lg shadow-black/30 transition-all duration-150 group-hover:opacity-100 group-hover:visible group-focus-visible:visible group-focus-visible:opacity-100">
        {label}
      </span>
    </Link>
  );
}

/**
 * The profile button and its menu.
 *
 * Clicking the avatar used to sign you straight out, which put an irreversible
 * action one stray click from every page. It now opens a menu that says who you
 * are first and offers sign-out as a deliberate second step.
 *
 * Sign-out is a POST through Better Auth, so it cannot be a link. Refreshing
 * after it resolves is what clears the server-rendered shell.
 */
function Avatar({ user }: { user: DashboardUser }) {
  if (user.image) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={user.image}
        alt=""
        referrerPolicy="no-referrer"
        className="h-6 w-6 shrink-0 rounded-full border border-rule object-cover"
      />
    );
  }
  return (
    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent-deep text-[10px] font-semibold">
      {(user.name[0] ?? "?").toUpperCase()}
    </span>
  );
}

function ProfileMenu({ user }: { user: DashboardUser }) {
  const notify = useToast();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const container = useRef<HTMLDivElement>(null);

  // A menu that outlives the click that dismissed it reads as a stuck popover,
  // so both the outside click and Escape close it.
  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: MouseEvent) => {
      // SAFETY: an event dispatched into this handler always carries a Node target, and `contains` only compares identity.
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  async function handleSignOut() {
    setPending(true);
    try {
      const result = await signOut();
      if (result.error) throw new Error("Could not sign out. Please try again.");
      router.replace("/");
      router.refresh();
    } catch {
      notify("Could not sign out. Please try again.", "error");
    } finally {
      setPending(false);
    }
  }

  return (
    <div ref={container} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account: ${user.name}`}
        className={`group relative mx-auto flex h-9 w-9 items-center justify-center rounded-md transition-colors ${
          open ? "bg-surface-2" : "hover:bg-surface-2"
        }`}
      >
        <Avatar user={user} />
        {!open && (
          <span className="pointer-events-none absolute left-[calc(100%+10px)] top-1/2 z-50 -translate-y-1/2 whitespace-nowrap rounded-md bg-zinc-100 px-2.5 py-1.5 text-xs font-semibold text-zinc-900 opacity-0 shadow-lg shadow-black/30 transition-all duration-150 invisible group-hover:visible group-focus-visible:visible group-focus-visible:opacity-100 group-hover:opacity-100">
            {user.name}
          </span>
        )}
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Account"
          className="absolute bottom-0 left-[calc(100%+10px)] z-50 w-60 rounded-md border border-rule bg-surface shadow-xl shadow-black/40"
        >
          <div className="flex items-center gap-2.5 border-b border-rule px-3 py-2.5">
            <Avatar user={user} />
            <div className="min-w-0">
              <p className="truncate text-xs font-medium">{user.name}</p>
              <p className="truncate text-[11px] text-muted" title={user.email}>
                {user.email}
              </p>
            </div>
          </div>

          <Link
            href="/dashboard/settings"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="focus-ring flex items-center gap-2 px-3 py-2.5 text-xs text-muted transition-colors hover:bg-surface-2 hover:text-foreground"
          >
            <LuSettings size={14} aria-hidden /> Account settings
          </Link>
          <button
            type="button"
            role="menuitem"
            onClick={handleSignOut}
            disabled={pending}
            className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-xs text-muted transition-colors hover:bg-surface-2 hover:text-foreground disabled:opacity-60"
          >
            <span aria-hidden className="[&>svg]:h-3.5 [&>svg]:w-3.5">
              <LuLogOut />
            </span>
            {pending ? "Signing out…" : "Sign out"}
          </button>
        </div>
      )}
    </div>
  );
}

function SignInLink() {
  return (
    <Link
      href="/login"
      aria-label="Sign in"
      className="group relative flex h-9 w-9 mx-auto items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-foreground transition-colors"
    >
      <span className="flex h-6 w-6 items-center justify-center rounded-full border border-rule bg-surface-2 font-mono text-[10px]">
        ?
      </span>
      <span className="pointer-events-none absolute left-[calc(100%+10px)] top-1/2 -translate-y-1/2 z-50 whitespace-nowrap rounded-md bg-zinc-100 px-2.5 py-1.5 text-xs font-semibold text-zinc-900 opacity-0 invisible shadow-lg shadow-black/30 transition-all duration-150 group-hover:opacity-100 group-hover:visible group-focus-visible:visible group-focus-visible:opacity-100">
        Sign in
      </span>
    </Link>
  );
}

export function Sidebar({
  user,
  projects = [],
}: {
  user: DashboardUser | null;
  /** Enough of each project to name the one the rail is currently inside. */
  projects?: Array<{ id: string; label: string }>;
}) {
  const pathname = usePathname();
  const projectId = projectIdFromPath(pathname);
  const items = projectId ? projectNav(projectId) : ORGANIZATION_NAV;

  // A project the session cannot see has no name to show, and the page below is
  // about to render a 404 anyway - so the tooltip falls back to the generic
  // word rather than to a raw id.
  const projectLabel = projects.find((project) => project.id === projectId)?.label ?? "Project";

  return (
    <aside className="h-screen w-14 shrink-0 flex flex-col border-r border-rule bg-background">
      <div className="flex h-14 shrink-0 items-center justify-center">
        <Link href="/" aria-label="Docxy home" className="flex h-8 items-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo-mark.png" alt="" className="h-6 w-auto object-contain" />
        </Link>
      </div>

      <nav className="flex-1 py-2" aria-label={projectId ? projectLabel : "Organization"}>
        {projectId && (
          <>
            {/*
              The way out, above the divider that separates it from the
              project's own sections. Without it the rail has swapped every
              entry for a project's and left no route back to the list - which
              is how a switching nav becomes a trap.
            */}
            <RailButton href="/dashboard/projects" label="All projects" icon={<LuArrowLeft />} />
            <div className="mx-3 my-2 rule-h" />
          </>
        )}
        <ul className="space-y-1">
          {items.map((item) => (
            <li key={item.href}>
              <RailButton
                href={item.href}
                label={item.label}
                icon={item.icon}
                active={item.match ? item.match(pathname) : pathname.startsWith(item.href)}
              />
            </li>
          ))}
        </ul>
      </nav>

      <div className="space-y-1 pb-3">
        <a
          href="https://github.com"
          target="_blank"
          rel="noreferrer"
          aria-label="GitHub"
          className="group relative flex h-9 w-9 mx-auto items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-foreground transition-colors"
        >
          <span className="h-[18px] w-[18px] [&>svg]:h-full [&>svg]:w-full"><LuGithub /></span>
          <span className="pointer-events-none absolute left-[calc(100%+10px)] top-1/2 -translate-y-1/2 z-50 whitespace-nowrap rounded-md bg-zinc-100 px-2.5 py-1.5 text-xs font-semibold text-zinc-900 opacity-0 invisible shadow-lg shadow-black/30 transition-all duration-150 group-hover:opacity-100 group-hover:visible group-focus-visible:visible group-focus-visible:opacity-100">
            GitHub
          </span>
        </a>
        <div className="mx-3 my-2 rule-h" />
        {user ? <ProfileMenu user={user} /> : <SignInLink />}
      </div>
    </aside>
  );
}
