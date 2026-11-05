import type { ReactNode } from "react";

/**
 * Placeholders for a dashboard page that has not arrived yet.
 *
 * Every page here is rendered on the server against the pipeline API, so a
 * click used to do nothing visible until the whole of the next page was ready -
 * on a slow pipeline, long enough to click again. These are what `loading.tsx`
 * shows in the meantime. They copy the real pages' frames - the stat grid, the
 * run list, the hairline rules - rather than drawing a spinner, so the page that
 * replaces them lands where the eye already is instead of jumping into place.
 *
 * No server or client dependencies: a loading file is prefetched with the
 * route, and it should be as cheap to send as it is to draw.
 */

/** One grey bar standing in for a line of text. Width and height are the caller's. */
function Bar({ className }: { className: string }) {
  return <span className={`block animate-pulse bg-surface-2 ${className}`} />;
}

/**
 * The announced wrapper. Screen readers hear one "Loading" rather than a run of
 * empty boxes, which is all the bars inside are to anybody not looking at them.
 */
export function LoadingRegion({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="status" aria-busy="true" className="space-y-6">
      <span className="sr-only">{label}</span>
      <div aria-hidden className="space-y-6">
        {children}
      </div>
    </div>
  );
}

/** A route heading's title and lede, at the sizes `PageHead` gives them. */
export function HeadSkeleton({ level = 1 }: { level?: 1 | 2 }) {
  return (
    <div className="border-b border-rule pb-6">
      <Bar className={level === 1 ? "h-7 w-48" : "h-5 w-36"} />
      <Bar className="mt-2 h-4 w-72 max-w-full" />
    </div>
  );
}

/** The four-up figures grid most pages open with, empty. */
export function StatsSkeleton() {
  return (
    <div className="grid grid-cols-2 divide-x divide-y divide-rule border border-rule bg-surface md:grid-cols-4 md:divide-y-0">
      {[0, 1, 2, 3].map((cell) => (
        <div key={cell} className="p-4">
          <Bar className="h-2.5 w-16" />
          <Bar className="mt-3 h-7 w-14" />
          <Bar className="mt-2 h-3 w-24" />
        </div>
      ))}
    </div>
  );
}

/** A run list's rows: the short sha, the subject, and the figures at the end. */
export function RowsSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="divide-y divide-rule border border-rule bg-surface">
      {Array.from({ length: rows }, (_, row) => (
        <div key={row} className="flex items-center gap-4 px-4 py-3">
          <Bar className="h-3 w-14" />
          <Bar className="h-3.5 min-w-0 flex-1" />
          <Bar className="hidden h-3 w-24 sm:block" />
          <Bar className="h-3 w-14" />
        </div>
      ))}
    </div>
  );
}
