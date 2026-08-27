"use client";

import { useEffect } from "react";

/**
 * Anything the dashboard cannot recover from — Neon unreachable, a missing
 * migration — lands here instead of a blank screen. Server errors arrive with
 * only a digest in production, which is what the operator needs to find the
 * matching log line.
 */
export default function DashboardError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error("[dashboard]", error);
  }, [error]);

  return (
    <div className="flex min-h-full items-center justify-center px-8 py-16">
      <div className="max-w-md">
        <h2 className="text-xl font-semibold tracking-tight text-foreground">
          The dashboard could not load
        </h2>
        <p className="mt-3 text-sm leading-relaxed text-muted">
          This is usually the database: check that{" "}
          <code className="font-mono text-xs text-foreground">DATABASE_URL</code> points at a
          reachable Neon branch and that migrations have been applied with{" "}
          <code className="font-mono text-xs text-foreground">npm run db:migrate</code>.
        </p>

        {error.digest && (
          <p className="mt-4 text-xs text-muted">
            Error digest <code className="font-mono text-foreground">{error.digest}</code>
          </p>
        )}

        <button
          type="button"
          onClick={() => retry()}
          className="focus-ring mt-6 rounded-md border border-rule bg-surface-2 px-4 py-2 text-sm font-medium text-foreground transition-colors hover:border-accent"
        >
          Try again
        </button>
      </div>
    </div>
  );
}
