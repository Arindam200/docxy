import type { ReactNode } from "react";

/** Dashed hairline. `bleed` pushes it past the section padding to the gutters. */
export function Rule({ bleed = false }: { bleed?: boolean }) {
  return <div className={bleed ? "rule-h -mx-8 lg:-mx-14" : "rule-h"} />;
}

/** The two vertical hairlines that run the full height of the page body. */
export function SideRails() {
  const inset = "max(2rem, calc((100% - 80rem) / 2))";
  return (
    <>
      <div
        className="rule-v hidden lg:block absolute top-0 bottom-0 pointer-events-none z-30"
        style={{ left: inset }}
      />
      <div
        className="rule-v hidden lg:block absolute top-0 bottom-0 pointer-events-none z-30"
        style={{ right: inset }}
      />
    </>
  );
}

export function Section({
  id,
  children,
  className = "",
}: {
  id?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section id={id} className={`max-w-7xl mx-auto px-8 lg:px-14 ${className}`}>
      {children}
    </section>
  );
}

/** Section heading with the eyebrow, rule, and lede that follow it everywhere. */
export function SectionHead({
  eyebrow,
  title,
  lede,
}: {
  eyebrow?: string;
  title: string;
  lede?: string;
}) {
  return (
    <>
      {eyebrow && (
        <p className="text-xs font-semibold tracking-widest text-zinc-400 mb-4">
          {eyebrow}
        </p>
      )}
      <div className="max-w-2xl">
        <h2 className="text-3xl lg:text-[42px] font-semibold text-zinc-900 tracking-tight leading-[1.1]">
          {title}
        </h2>
      </div>
      <div className="mt-3 mb-6">
        <Rule bleed />
      </div>
      {lede && (
        <div className="max-w-xl mb-10">
          <p className="text-lg text-zinc-500 leading-relaxed">{lede}</p>
        </div>
      )}
    </>
  );
}

export function ButtonLink({
  href,
  children,
  variant = "primary",
}: {
  href: string;
  children: ReactNode;
  variant?: "primary" | "outline" | "ghost" | "invert";
}) {
  const styles = {
    primary:
      "bg-zinc-900 text-white hover:bg-zinc-700 border border-transparent",
    outline:
      "text-zinc-600 border border-zinc-200 hover:border-zinc-300 hover:text-zinc-900",
    ghost:
      "text-zinc-300 border border-zinc-700 hover:border-zinc-500 hover:text-white",
    invert:
      "bg-white text-zinc-900 hover:bg-zinc-100 border border-transparent justify-center",
  }[variant];

  return (
    <a
      href={href}
      className={`inline-flex items-center gap-1.5 text-sm font-medium px-5 py-2.5 transition-colors ${styles}`}
    >
      {children}
    </a>
  );
}

/** Hairline-gapped grid: cells sit on a zinc field so the 1px gaps read as rules. */
export function CellGrid({
  children,
  cols = "sm:grid-cols-2 lg:grid-cols-3",
}: {
  children: ReactNode;
  cols?: string;
}) {
  return (
    <div className={`grid grid-cols-1 ${cols} gap-px bg-zinc-200 border border-zinc-200`}>
      {children}
    </div>
  );
}
