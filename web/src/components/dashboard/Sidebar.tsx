"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import {
  LuBot,
  LuDatabase,
  LuGithub,
  LuHouse,
  LuLayers,
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
 * Sign-out is a POST through Better Auth, so it cannot be a link. Refreshing
 * after it resolves is what clears the server-rendered shell.
 */
function SignOutButton({ user }: { user: DashboardUser }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

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
    <button
      type="button"
      onClick={handleSignOut}
      disabled={pending}
      aria-label={`Signed in as ${user.email}. Sign out`}
      className="group relative flex h-9 w-9 mx-auto items-center justify-center disabled:opacity-50"
    >
      {user.image ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={user.image}
          alt=""
          referrerPolicy="no-referrer"
          className="h-6 w-6 rounded-full border border-rule object-cover"
        />
      ) : (
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-accent-deep text-[10px] font-semibold">
          {(user.name[0] ?? "?").toUpperCase()}
        </span>
      )}
      <span className="pointer-events-none absolute left-[calc(100%+10px)] top-1/2 -translate-y-1/2 z-50 whitespace-nowrap rounded-md bg-zinc-100 px-2.5 py-1.5 text-xs font-semibold text-zinc-900 opacity-0 invisible shadow-lg shadow-black/30 transition-all duration-150 group-hover:opacity-100 group-hover:visible">
        {pending ? "Signing out…" : `Sign out · ${user.email}`}
      </span>
    </button>
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

      <nav className="flex-1 overflow-y-auto py-2">
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
        {user ? <SignOutButton user={user} /> : <SignInLink />}
      </div>
    </aside>
  );
}
