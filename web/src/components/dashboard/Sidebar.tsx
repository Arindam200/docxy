"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  LuBot,
  LuDatabase,
  LuGithub,
  LuHouse,
  LuLayers,
  LuLogOut,
  LuActivity,
  LuPlug,
  LuScrollText,
  LuZap,
} from "react-icons/lu";
import { signOut } from "@/lib/auth-client";
import type { DashboardUser } from "@/lib/user";

/**
 * Collapsed icon rail: logo up top, routed nav with hover tooltips, identity
 * pinned to the bottom. Active state follows the current path.
 */

const NAV: Array<{ href: string; label: string; icon: ReactNode }> = [
  { href: "/dashboard", label: "Overview", icon: <LuHouse /> },
  { href: "/dashboard/synced", label: "Synced", icon: <LuDatabase /> },
  { href: "/dashboard/tracking", label: "Tracking", icon: <LuLayers /> },
  { href: "/dashboard/instructions", label: "Instructions", icon: <LuBot /> },
  { href: "/dashboard/activity", label: "Activity", icon: <LuZap /> },
  { href: "/dashboard/observability", label: "Observability", icon: <LuActivity /> },
  // Built, filterable, and until now reachable only by typing the URL.
  { href: "/dashboard/logs", label: "Logs", icon: <LuScrollText /> },
  { href: "/dashboard/integrations", label: "Integrations", icon: <LuPlug /> },
];

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
      className={`group relative flex h-9 w-9 mx-auto items-center justify-center rounded-md transition-colors ${
        active
          ? "bg-surface-2 text-accent"
          : "text-muted hover:bg-surface-2 hover:text-foreground"
      }`}
    >
      <span className="h-[18px] w-[18px] [&>svg]:h-full [&>svg]:w-full">{icon}</span>
      <span className="pointer-events-none absolute left-[calc(100%+10px)] top-1/2 -translate-y-1/2 z-50 whitespace-nowrap rounded-md bg-zinc-100 px-2.5 py-1.5 text-xs font-semibold text-zinc-900 opacity-0 invisible shadow-lg shadow-black/30 transition-all duration-150 group-hover:opacity-100 group-hover:visible">
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
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const container = useRef<HTMLDivElement>(null);

  // A menu that outlives the click that dismissed it reads as a stuck popover,
  // so both the outside click and Escape close it.
  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: MouseEvent) => {
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
      await signOut();
      router.replace("/");
      router.refresh();
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
          <span className="pointer-events-none absolute left-[calc(100%+10px)] top-1/2 z-50 -translate-y-1/2 whitespace-nowrap rounded-md bg-zinc-100 px-2.5 py-1.5 text-xs font-semibold text-zinc-900 opacity-0 shadow-lg shadow-black/30 transition-all duration-150 invisible group-hover:visible group-hover:opacity-100">
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
      <span className="pointer-events-none absolute left-[calc(100%+10px)] top-1/2 -translate-y-1/2 z-50 whitespace-nowrap rounded-md bg-zinc-100 px-2.5 py-1.5 text-xs font-semibold text-zinc-900 opacity-0 invisible shadow-lg shadow-black/30 transition-all duration-150 group-hover:opacity-100 group-hover:visible">
        Sign in
      </span>
    </Link>
  );
}

export function Sidebar({ user }: { user: DashboardUser | null }) {
  const pathname = usePathname();

  return (
    <aside className="h-screen w-14 shrink-0 flex flex-col border-r border-rule bg-background">
      <div className="flex h-14 shrink-0 items-center justify-center">
        <Link href="/" aria-label="Docxy home" className="flex h-8 items-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo-mark.png" alt="" className="h-6 w-auto object-contain" />
        </Link>
      </div>

      <nav className="flex-1 py-2">
        <ul className="space-y-1">
          {NAV.map((item) => (
            <li key={item.href}>
              <RailButton
                href={item.href}
                label={item.label}
                icon={item.icon}
                active={
                  item.href === "/dashboard"
                    ? pathname === "/dashboard"
                    : // Run detail lives under /dashboard/runs but is reached
                      // from Activity, so that entry stays lit there.
                      item.href === "/dashboard/activity"
                      ? pathname.startsWith("/dashboard/activity") ||
                        pathname.startsWith("/dashboard/runs")
                      : pathname.startsWith(item.href)
                }
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
          <span className="pointer-events-none absolute left-[calc(100%+10px)] top-1/2 -translate-y-1/2 z-50 whitespace-nowrap rounded-md bg-zinc-100 px-2.5 py-1.5 text-xs font-semibold text-zinc-900 opacity-0 invisible shadow-lg shadow-black/30 transition-all duration-150 group-hover:opacity-100 group-hover:visible">
            GitHub
          </span>
        </a>
        <div className="mx-3 my-2 rule-h" />
        {user ? <ProfileMenu user={user} /> : <SignInLink />}
      </div>
    </aside>
  );
}
