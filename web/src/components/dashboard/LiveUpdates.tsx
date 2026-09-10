"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

/**
 * Keeps a server-rendered page current while a run is in flight.
 *
 * Every dashboard page is a Server Component reading through the pipeline API,
 * so there is nothing here to update in place: the component holds a stream
 * open and calls `router.refresh()`, and the server re-renders with whatever is
 * true now. That is why it renders a status badge and nothing else - the data
 * on the page is not this component's to draw.
 *
 * What it does own is honesty about the connection. A page that silently
 * stopped receiving events looks exactly like a page where nothing is
 * happening, and the difference matters most in the case the feed exists for:
 * watching a run you just triggered.
 */

/** Feed events that change what a page renders. */
const EVENTS = ["run", "queue", "skipped", "webhook"] as const;

/**
 * Role events are deliberately not in that list.
 *
 * The pipeline publishes one on every turn of every role, and publishes a run
 * update alongside each of them - see `onEvent` in src/pipeline/context.ts. So
 * subscribing to both would double the refresh rate to render the same thing.
 */

/** At most one server round trip per second, however chatty a run gets. */
const REFRESH_MS = 1000;

/**
 * How long a gap has to last before it is worth reporting.
 *
 * The proxy closes each stream after under a minute so it can re-check
 * membership on the reconnect, which means a healthy page disconnects
 * regularly and by design. Announcing each of those would make a badge that
 * blinks "Reconnecting" every minute on a dashboard that is working perfectly.
 */
const GRACE_MS = 4000;

/** Backoff between attempts, and the point at which it gives up saying "soon". */
const BACKOFF_MS = [500, 1000, 2000, 5000, 10_000, 30_000];

type Connection = "connecting" | "live" | "reconnecting" | "offline";

const LABEL = {
  connecting: "Connecting",
  live: "Live",
  reconnecting: "Reconnecting",
  offline: "Offline",
} satisfies Record<Connection, string>;

const DOT = {
  connecting: "bg-muted",
  live: "bg-ok",
  reconnecting: "bg-warn",
  offline: "bg-danger",
} satisfies Record<Connection, string>;

const TITLE = {
  connecting: "Opening the live feed.",
  live: "This page updates itself as runs progress.",
  reconnecting: "The live feed dropped. Trying again.",
  offline: "The live feed is closed. Reload to see new activity.",
} satisfies Record<Connection, string>;

export function LiveUpdates({ runId }: { runId?: string }) {
  const router = useRouter();
  const [status, setStatus] = useState<Connection>("connecting");
  // Bumped to force the effect to run again after somebody asks for a retry.
  const [attempt, setAttempt] = useState(0);

  const retry = useCallback(() => {
    setStatus("connecting");
    setAttempt((value) => value + 1);
  }, []);

  useEffect(() => {
    let stopped = false;
    let source: EventSource | null = null;
    let failures = 0;

    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    let lastRefresh = 0;

    /**
     * Refresh now, or at the end of the current window if one just happened.
     *
     * Leading and trailing both, because dropping the trailing call is how a
     * run's *final* event - the one that flips it to done and adds the pull
     * request link - gets thrown away for arriving too soon after the one
     * before it.
     */
    const refresh = (): void => {
      if (stopped || refreshTimer) return;
      const wait = REFRESH_MS - (Date.now() - lastRefresh);
      if (wait <= 0) {
        lastRefresh = Date.now();
        router.refresh();
        return;
      }
      refreshTimer = setTimeout(() => {
        refreshTimer = undefined;
        if (stopped) return;
        lastRefresh = Date.now();
        router.refresh();
      }, wait);
    };

    const disconnect = (): void => {
      source?.close();
      source = null;
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    };

    const connect = (): void => {
      if (stopped || document.visibilityState === "hidden") return;
      disconnect();

      const feed = new EventSource("/api/docxy/events");
      source = feed;

      feed.onopen = () => {
        failures = 0;
        clearTimeout(graceTimer);
        graceTimer = undefined;
        setStatus("live");
        // Whatever happened while this page had no stream is not replayed, so
        // the reconnect itself is the cue to go and look.
        refresh();
      };

      const onEvent = (event: MessageEvent<string>): void => {
        // On a run's own page, only that run is worth a re-render: another
        // repository finishing a run changes nothing on screen.
        if (runId && event.type === "run") {
          // SAFETY: only `id` is read, as an optional string; a body that is
          // not JSON falls through to refreshing, which is the safe direction.
          const summary = parse<{ id?: string }>(event.data);
          if (summary && summary.id !== runId) return;
        }
        refresh();
      };

      for (const name of EVENTS) feed.addEventListener(name, onEvent);

      feed.onerror = (event) => {
        // Two different things arrive here. The pipeline publishes an `error`
        // event for a run that failed before it had a record to attach to, and
        // that is a message with a body. A connection failure is a bare Event.
        if ("data" in event) {
          refresh();
          return;
        }

        disconnect();
        if (stopped) return;

        // The badge waits out the grace period before saying anything, so the
        // proxy's scheduled close does not read as a fault.
        graceTimer ??= setTimeout(() => setStatus("reconnecting"), GRACE_MS);

        const backoff = BACKOFF_MS[Math.min(failures, BACKOFF_MS.length - 1)];
        failures += 1;
        if (failures > BACKOFF_MS.length) {
          // Out of attempts. This is where a revoked member ends up - the proxy
          // refuses the stream and no amount of retrying changes that - so it
          // says so rather than retrying forever behind a hopeful badge.
          clearTimeout(graceTimer);
          graceTimer = undefined;
          setStatus("offline");
          return;
        }
        reconnectTimer = setTimeout(connect, backoff);
      };
    };

    /**
     * A hidden tab holds a serverless invocation open to watch a page nobody is
     * looking at. Dropping the stream and picking it up on return costs one
     * refresh and saves the rest.
     */
    const onVisibility = (): void => {
      if (document.visibilityState === "hidden") {
        disconnect();
        clearTimeout(graceTimer);
        graceTimer = undefined;
        setStatus("connecting");
        return;
      }
      failures = 0;
      connect();
    };

    document.addEventListener("visibilitychange", onVisibility);
    connect();

    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", onVisibility);
      disconnect();
      clearTimeout(graceTimer);
      clearTimeout(refreshTimer);
    };
  }, [router, runId, attempt]);

  return (
    <span
      role="status"
      title={TITLE[status]}
      className="inline-flex items-center gap-2 text-xs text-muted"
    >
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT[status]}`} aria-hidden />
      {LABEL[status]}
      {status === "offline" && (
        <button
          type="button"
          onClick={retry}
          className="focus-ring underline decoration-rule underline-offset-4 hover:text-accent hover:decoration-accent"
        >
          Retry
        </button>
      )}
    </span>
  );
}

/** JSON or nothing. An event body that will not parse is not worth throwing over. */
function parse<T>(data: string): T | null {
  try {
    // SAFETY: the caller names the shape it expects and reads one optional
    // field from it; anything else returns null through the catch below.
    return JSON.parse(data) as T;
  } catch {
    return null;
  }
}
