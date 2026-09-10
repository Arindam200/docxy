"use client";

import { useState } from "react";
import Link from "next/link";
import { nav } from "@/lib/site";
import { useSession } from "@/lib/auth-client";
import { Wordmark } from "./Logo";
import { Rule } from "./primitives";

export function Banner() {
  return (
    <div className="sticky top-0 z-40 bg-[var(--accent-deep)] flex items-center justify-center gap-2 px-4 py-2 text-[13px] text-white">
      <span className="font-medium">
        Keep your docs up to date.
      </span>
      <a
        href="#how-it-works"
        className="inline-flex items-center gap-1 underline decoration-white/40 underline-offset-[3px] hover:decoration-white transition-[text-decoration-color]"
      >
        See how it works
        <svg
          width="1em"
          height="1em"
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden
          className="size-3.5 translate-y-px"
        >
          <path
            d="M9 6L15 12L9 18"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </a>
    </div>
  );
}

export function Navbar() {
  const [open, setOpen] = useState(false);
  const { data: session, isPending } = useSession();
  const signedIn = Boolean(session?.user);
  const actionHref = signedIn ? "/dashboard" : "/signup";
  const actionLabel = signedIn ? "Dashboard" : "Get started";

  return (
    <nav className="sticky top-[36px] z-40 w-full bg-white">
      <div className="max-w-7xl mx-auto w-full px-6 flex items-center justify-between h-14">
        <Wordmark />

        <ul className="hidden md:flex items-center gap-7">
          {nav.map((item) => (
            <li key={item.label}>
              <a
                href={item.href}
                className="text-sm text-zinc-500 hover:text-zinc-900 transition-colors"
              >
                {item.label}
              </a>
            </li>
          ))}
        </ul>

        <div className={`hidden md:flex items-center gap-6 ${isPending ? "invisible" : ""}`}>
          {!signedIn && <Link
            href="/login"
            className="text-sm text-zinc-600 hover:text-zinc-900 transition-colors"
          >
            Sign in
          </Link>}
          <Link
            href={actionHref}
            className="inline-flex items-center gap-2 text-sm font-medium bg-zinc-900 text-white px-5 py-2 hover:bg-zinc-700 transition-colors"
          >
            {actionLabel} <span aria-hidden>→</span>
          </Link>
        </div>

        <button
          onClick={() => setOpen((v) => !v)}
          className="md:hidden p-2 text-zinc-600"
          aria-label="Toggle menu"
          aria-expanded={open}
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 17 14" aria-hidden>
            <path
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2"
              d={open ? "M2 2l13 10M15 2L2 12" : "M1 1h15M1 7h15M1 13h15"}
            />
          </svg>
        </button>
      </div>

      {open && (
        <div className="md:hidden border-t border-zinc-100 px-6 py-4 space-y-3">
          {nav.map((item) => (
            <a
              key={item.label}
              href={item.href}
              onClick={() => setOpen(false)}
              className="block text-sm text-zinc-600 hover:text-zinc-900"
            >
              {item.label}
            </a>
          ))}
          <div className={`flex items-center gap-6 pt-2 ${isPending ? "invisible" : ""}`}>
            {!signedIn && <Link
              href="/login"
              onClick={() => setOpen(false)}
              className="text-sm text-zinc-600 hover:text-zinc-900 transition-colors"
            >
              Sign in
            </Link>}
            <Link
              href={actionHref}
              onClick={() => setOpen(false)}
              className="inline-flex items-center gap-2 text-sm font-medium bg-zinc-900 text-white px-5 py-2 hover:bg-zinc-700 transition-colors"
            >
              {actionLabel} <span aria-hidden>→</span>
            </Link>
          </div>
        </div>
      )}

      <Rule />
    </nav>
  );
}
