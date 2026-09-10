import { localDev } from "@/lib/runtime";

/**
 * What every page says when the pipeline API does not answer.
 *
 * One component rather than the same paragraph copied into four pages, because
 * the paragraph is not the same in both places: on a laptop the remedy is to
 * start the server, and on a deployment there is no server to start by hand -
 * the service is down, restarting, or `DOCXY_API_URL` is pointing somewhere
 * that is not it. Telling a deployed operator to run `npm run serve` sends them
 * to a terminal that has nothing to do with the outage.
 */
export function ApiOffline({ detail }: { detail?: string }) {
  return (
    <div
      role="alert"
      className="border border-rule bg-surface px-4 py-3 text-sm leading-relaxed text-muted"
    >
      The docxy API is unreachable right now{detail ? `, ${detail}` : ""}.{" "}
      {localDev ? (
        <>
          Start it with <code className="font-mono text-foreground">npm run serve</code> and
          refresh.
        </>
      ) : (
        <>
          It may be restarting. Refresh in a moment. If it persists, check that the pipeline
          service is running and that{" "}
          <code className="font-mono text-foreground">DOCXY_API_URL</code> points at it.
        </>
      )}
    </div>
  );
}
