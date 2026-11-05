"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { concernsPage, refreshOnOpen } from "@/lib/live-updates";

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

/**
 * At most one server round trip every three seconds, however chatty a run gets.
 *
 * It was one a second. A refresh re-renders the whole page on the server - the
 * session, the membership check and every pipeline read - and a run publishes
 * on every turn of every role, so a busy run held each open tab at a render a
 * second. Nobody reads a status flip faster than this, and the trailing call
 * below still guarantees the last one lands.
 */
const REFRESH_MS = 3000;

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

/**
 * What survives a stream being torn down and opened again, which is what
 * `refreshOnOpen` needs to know.
 *
 * Held in a ref rather than in the effect because the effect itself is torn
 * down and rebuilt by a Retry, and a Retry after the badge went offline is the
 * one reconnect that most needs to know how long the page went without a feed.
 */
interface FeedMemory {
  /** The last moment the page was known current: when it was drawn, or when its stream dropped. */
  coveredUntil: number;
  /** When an event that concerned this page last arrived, if one ever has. */
  heardAt?: number;
}

export function LiveUpdates({
  runId,
  repoPath,
  repository,
  running = false,
}: {
  /** On a run's page: only that run's updates are worth a re-render. */
  runId?: string;
  /** Inside a project: its checkout key, so other projects' runs are ignored. */
  repoPath?: string;
  /** Inside a project: its `owner/name`, so other repositories' pushes are ignored. */
  repository?: string;
  /**
   * Whether the page was drawn with a run still in flight. Such a page is busy
   * before its first event arrives, so the gap between rendering and the stream
   * opening is treated like any other gap in a busy feed.
   */
  running?: boolean;
}) {
  const router = useRouter();
  const [status, setStatus] = useState<Connection>("connecting");
  // Bumped to force the effect to run again after somebody asks for a retry.
  const [attempt, setAttempt] = useState(0);
  const memory = useRef<FeedMemory | null>(null);
  // Read once, when the feed is first set up. Later renders change what the
  // page shows, not what the feed has already heard.
  const drawnRunning = useRef(running);

  const retry = useCallback(() => {
    setStatus("connecting");
    setAttempt((value) => value + 1);
  }, []);

  useEffect(() => {
    const now = Date.now();
    const feed = (memory.current ??= {
      coveredUntil: now,
      heardAt: drawnRunning.current ? now : undefined,
    });
    const scope = { runId, repoPath, repository };

    let stopped = false;
    let source: EventSource | null = null;
    let open = false;
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
      // Coverage ends when a stream that was delivering stops, not when an
      // attempt that never opened is abandoned.
      if (open) feed.coveredUntil = Date.now();
      open = false;
      source?.close();
      source = null;
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    };

    const connect = (): void => {
      if (stopped || document.visibilityState === "hidden") return;
      disconnect();

      const stream = new EventSource("/api/docxy/events");
      source = stream;

      stream.onopen = () => {
        open = true;
        failures = 0;
        clearTimeout(graceTimer);
        graceTimer = undefined;
        setStatus("live");
        // Whatever happened while this page had no stream is not replayed. It
        // used to refresh on every open regardless, which with the proxy
        // closing streams on a schedule meant every tab re-rendered at least
        // once a minute. Now only when something could have been missed.
        const opened = Date.now();
        const since = feed.heardAt === undefined ? undefined : opened - feed.heardAt;
        if (refreshOnOpen(opened - feed.coveredUntil, since)) refresh();
      };

      const onEvent = (event: MessageEvent<string>): void => {
        // Another project's run, or a push to another repository, changes
        // nothing on a page scoped to this one.
        if (!concernsPage(event.type, event.data, scope)) return;
        feed.heardAt = Date.now();
        refresh();
      };

      for (const name of EVENTS) stream.addEventListener(name, onEvent);

      stream.onerror = (event) => {
        // Two different things arrive here. The pipeline publishes an `error`
        // event for a run that failed before it had a record to attach to, and
        // that is a message with a body. A connection failure is a bare Event.
        // The message names a commit and no project, so it counts as this
        // page's - see `concernsPage`.
        if ("data" in event) {
          feed.heardAt = Date.now();
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
     * looking at. Dropping the stream and picking it up on return costs at most
     * one refresh and saves the rest - and none at all for a glance at another
     * tab that comes back inside `GAP_MS` to a quiet feed.
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
  }, [router, runId, repoPath, repository, attempt]);

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
