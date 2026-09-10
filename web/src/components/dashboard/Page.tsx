import type { ReactNode } from "react";

/** Standard content column for dashboard routes. */
export function Page({ children }: { children: ReactNode }) {
  return (
    <div className="w-full min-h-full p-5 lg:p-8">
      <div className="max-w-5xl mx-auto space-y-6 pb-8">{children}</div>
    </div>
  );
}

/**
 * Route heading: title + lede on the left, optional meta on the right.
 *
 * `level` exists because a route can now sit inside another route's heading.
 * The project layout owns the page's `h1`, so a run opened inside a project
 * needs the same header treatment one rank down - two `h1`s on one page is a
 * document with two subjects, which is exactly what a screen reader reports.
 */
export function PageHead({
  title,
  lede,
  children,
  level = 1,
}: {
  title: string;
  lede?: ReactNode;
  children?: ReactNode;
  level?: 1 | 2;
}) {
  const Heading = level === 1 ? "h1" : "h2";
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between border-b border-rule pb-6">
      <div>
        <Heading className={level === 1 ? "text-2xl font-bold tracking-tight" : "text-lg font-semibold tracking-tight"}>
          {title}
        </Heading>
        {lede && <p className="mt-1 text-sm text-muted">{lede}</p>}
      </div>
      {children}
    </div>
  );
}
