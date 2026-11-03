/**
 * When a live page should go back to the server, decided without a browser.
 *
 * `LiveUpdates` turns feed events into `router.refresh()`, and every refresh is
 * a full server render: the session, the membership check, and every pipeline
 * read the page makes. It used to refresh on every connection and on any event
 * at all. The proxy closes each stream before a minute is up, so every open tab
 * re-rendered at least once a minute whether or not anything had happened, and
 * a run in one project re-rendered every other project's pages while it went.
 *
 * The two decisions that stop that live here rather than in the component, so
 * they can be tested without an `EventSource`: which events concern the page
 * on screen, and whether a stream that has just opened might have missed one.
 */

/** What a page is about, for telling its events apart from everybody else's. */
export interface LiveScope {
  /** The run a run page shows. Only that run's own updates change it. */
  runId?: string;
  /** The checkout a project's runs are recorded under - the project's `key`. */
  repoPath?: string;
  /** The `owner/name` a project watches, which is how a push names it. */
  repository?: string;
}

/**
 * Whether one feed event could change what this page renders.
 *
 * An event is ignored only when its own body proves it is about something
 * else. A run update names its run and its checkout, and a push names its
 * repository, so those can be told apart; a queue depth, a skipped delivery or
 * a run that failed before it had a record carry no project at all, and are
 * treated as possibly this page's. They are one apiece per push, so being
 * generous with them costs little. A body that will not parse refreshes too,
 * because that is the safe direction to be wrong in.
 */
export function concernsPage(event: string, data: string, scope: LiveScope): boolean {
  if (event === "run") {
    const summary = parse<{ id?: string; repoPath?: string }>(data);
    if (!summary) return true;
    if (scope.runId !== undefined && summary.id !== scope.runId) return false;
    if (scope.repoPath !== undefined && summary.repoPath !== scope.repoPath) return false;
    return true;
  }

  if (event === "webhook") {
    const delivery = parse<{ repository?: string }>(data);
    if (!delivery?.repository || scope.repository === undefined) return true;
    // GitHub's `full_name` and a project's stored source repository can differ
    // in case, and on GitHub they name the same repository either way.
    return delivery.repository.toLowerCase() === scope.repository.toLowerCase();
  }

  return true;
}

/**
 * How long the page can go without a stream before anything at all might have
 * happened in the gap.
 *
 * The proxy's scheduled close costs a backoff of half a second and a fresh
 * connection, which together stay well under this. A tab that was hidden, a
 * pipeline that was restarting, or a Retry after the badge gave up all come in
 * over it.
 */
export const GAP_MS = 5000;

/**
 * How long after its last event a feed still counts as busy.
 *
 * A run publishes on every turn of every role, so while one is going the gaps
 * between events are a model call long - and the event that matters most, the
 * one that finishes the run, can arrive after the longest of them. Five minutes
 * covers a slow turn with room to spare, and costs an idle page at most one
 * extra refresh per reconnect for that long after a run ends.
 */
export const BUSY_MS = 5 * 60_000;

/**
 * Whether a stream that has just opened should be followed by a refresh.
 *
 * Nothing is replayed across a gap - the pipeline keeps no history for a
 * subscriber that was not there - so the question is whether anything is
 * likely to have fallen into it. Two cases say yes. A long gap, because
 * anything could have happened in it. A short gap while the feed was busy,
 * because the next event of a run in flight may have been the one that landed
 * there, and if it was the last one nothing would ever come along to correct
 * the page.
 *
 * A short gap on a quiet feed says no, and that is the common case: the
 * scheduled close on an idle dashboard, and the first connection after a page
 * that has only just been rendered. A push that lands in that half-second is
 * not lost either, because the run it starts publishes again within moments.
 *
 * @param uncoveredMs How long the page had no stream: since it was drawn, for
 *   its first connection, or since the last connection dropped.
 * @param sinceActivityMs How long since an event that concerned this page, or
 *   undefined when there has not been one.
 */
export function refreshOnOpen(uncoveredMs: number, sinceActivityMs: number | undefined): boolean {
  if (uncoveredMs > GAP_MS) return true;
  return sinceActivityMs !== undefined && sinceActivityMs < BUSY_MS;
}

/** JSON or nothing. An event body that will not parse is not worth throwing over. */
function parse<T>(data: string): T | null {
  try {
    // SAFETY: the callers name the fields they expect, read each as optional,
    // and treat a missing one as "cannot tell"; anything that is not JSON
    // returns null through the catch below.
    return JSON.parse(data) as T;
  } catch {
    return null;
  }
}
