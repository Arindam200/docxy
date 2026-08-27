import type { ReactNode } from "react";
import Link from "next/link";
import { LuCheck } from "react-icons/lu";
import { LogoMark } from "@/components/Logo";
/**
 * Split-screen auth shell: form panel on the dark ground, brand panel in
 * logo blue with a starfield texture. Both /login and /signup render through
 * this so the two routes stay pixel-identical except for their copy.
 */

const PITCH_ITEMS = [
  "Docs and changelogs drafted on every push",
  "Impact-mapped edits, never shotgun rewrites",
  "Human approval gates before any PR",
];

export function AuthShell({
  eyebrow,
  title,
  lede,
  error,
  alt,
  children,
}: {
  eyebrow: string;
  title: string;
  lede: string;
  error?: string;
  /** Swap-link under the form, e.g. "New here? Sign up". */
  alt: ReactNode;
  children: ReactNode;
}) {
  return (
    // Light theme by default — the root tokens are the light palette. The
    // dashboard opts into the dark scope separately.
    <div className="min-h-screen flex bg-background text-foreground">
      {/* Form panel */}
      <div className="flex-1 flex flex-col">
        <div className="flex items-center justify-between px-6 py-5">
          <Link href="/" className="flex items-center gap-2">
            <LogoMark className="h-6" />
            <span className="text-lg font-semibold tracking-tight">docxy</span>
          </Link>
          <Link
            href="/"
            className="text-[11px] font-mono uppercase tracking-[0.18em] text-muted hover:text-foreground transition-colors"
          >
            ← Back to home
          </Link>
        </div>

        <div className="flex-1 flex items-center justify-center px-6 pb-16">
          <div className="w-full max-w-sm space-y-7">
            <div className="text-center space-y-2.5">
              <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-muted">
                <span aria-hidden className="text-accent">› </span>
                {eyebrow}
              </p>
              <h1 className="text-3xl font-semibold tracking-tight leading-tight">{title}</h1>
              <p className="text-sm leading-relaxed text-muted">{lede}</p>
            </div>

            {error && (
              <div
                role="alert"
                className="border border-rule bg-surface px-4 py-3 text-sm leading-relaxed text-muted"
              >
                {error}
              </div>
            )}

            {children}

            <div className="text-center text-sm text-muted">{alt}</div>
          </div>
        </div>
      </div>

      {/* Brand panel — hidden where the form needs the full width */}
      <div
        className="relative hidden lg:flex w-[46%] shrink-0 flex-col justify-between overflow-hidden px-12 py-8"
        style={{
          backgroundColor: "#0a56d8",
          backgroundImage:
            "radial-gradient(circle at 20% 30%, rgba(33,121,252,0.55), transparent 55%), radial-gradient(circle at 80% 70%, rgba(2,32,84,0.6), transparent 60%), radial-gradient(rgba(255,255,255,0.35) 1px, transparent 1px), radial-gradient(rgba(255,255,255,0.18) 1px, transparent 1px)",
          backgroundSize: "auto, auto, 34px 34px, 74px 74px",
          backgroundPosition: "0 0, 0 0, 9px 17px, 41px 53px",
        }}
      >
        <p className="relative font-mono text-[11px] uppercase tracking-[0.22em] text-white/80 text-center">
          <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full bg-white mr-2 align-middle" />
          Docxy
        </p>

        <div className="relative max-w-md mx-auto text-center space-y-6">
          <h2 className="text-4xl font-semibold text-white tracking-tight leading-[1.15]">
            Docs that write themselves.
          </h2>
          <p className="text-[15px] leading-relaxed text-white/80">
            Five specialist agents read every push, update the docs they touch, and open a PR —
            you stay the editor-in-chief.
          </p>
          <ul className="space-y-3 pt-2 text-left inline-block">
            {PITCH_ITEMS.map((item) => (
              <li key={item} className="flex items-center gap-3 text-sm text-white/90">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-white/40 bg-white/10">
                  <LuCheck className="h-3 w-3" />
                </span>
                {item}
              </li>
            ))}
          </ul>
        </div>

        <p className="relative font-mono text-[11px] uppercase tracking-[0.22em] text-white/60 text-center">
          Built for teams who ship
        </p>
      </div>
    </div>
  );
}
