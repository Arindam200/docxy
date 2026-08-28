import Link from "next/link";

/**
 * What this dashboard can actually do, and where each thing lives.
 *
 * The sidebar is a collapsed icon rail — good for returning to a page you
 * already know, useless for discovering one you do not. Seven routes were
 * reachable only by hovering an icon and guessing, so the pages that carry the
 * interesting parts of the pipeline went unvisited. Each line says what the
 * page answers, not what it is called.
 */

const CAPABILITIES: Array<{
  href: string;
  name: string;
  answers: string;
}> = [
  {
    href: "/dashboard/synced",
    name: "Synced repositories",
    answers: "Which repositories docxy watches, and how to add one.",
  },
  {
    href: "/dashboard/tracking",
    name: "Tracking",
    answers:
      "The symbol-to-documentation map the Impact Mapper reuses — what makes the second commit cheaper than the first.",
  },
  {
    href: "/dashboard/instructions",
    name: "Standing instructions",
    answers:
      "House rules the two drafting roles follow on every run, ranked above their default style.",
  },
  {
    href: "/dashboard/activity",
    name: "Activity",
    answers: "Every run, its status, and the pull request it opened.",
  },
  {
    href: "/dashboard/logs",
    name: "Logs",
    answers:
      "Every event the agents emitted, filterable by role and kind — including where a command ran.",
  },
  {
    href: "/dashboard/observability",
    name: "Observability",
    answers:
      "Success rate, spend per run, which role fails most and how, and the docs that go stale most often.",
  },
  {
    href: "/dashboard/integrations",
    name: "Integrations",
    answers: "The GitHub App, the model provider, and the database — what is connected.",
  },
];

export function Capabilities() {
  return (
    <section aria-labelledby="overview-capabilities" className="space-y-3">
      <h2
        id="overview-capabilities"
        className="text-lg font-semibold tracking-tight"
      >
        Where things are
      </h2>
      {/*
        `gap-px` over a `bg-rule` parent draws the hairlines, which means an odd
        item count leaves the parent showing through the empty cell as a solid
        block. The last tile spans the row instead of leaving that gap.
      */}
      <ul className="grid gap-px border border-rule bg-rule sm:grid-cols-2 sm:[&>li:last-child:nth-child(odd)]:col-span-2">
        {CAPABILITIES.map((item) => (
          <li key={item.href} className="bg-surface">
            <Link
              href={item.href}
              className="block h-full px-4 py-3 transition-colors hover:bg-accent/5 focus-visible:bg-accent/5 focus-visible:outline-none"
            >
              <p className="text-sm font-medium">
                {item.name}
                <span aria-hidden className="ml-1.5 text-muted">
                  →
                </span>
              </p>
              <p className="mt-1 text-xs leading-relaxed text-muted">{item.answers}</p>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Shown instead of an empty run list.
 *
 * A dashboard whose main panel is blank on first visit reads as broken. This
 * says what has to be true before a run can happen, in the order it has to
 * become true.
 */
export function NoRunsYet({ hasRepo }: { hasRepo: boolean }) {
  return (
    <div className="border border-dashed border-rule px-6 py-10">
      <p className="text-sm font-medium">No runs yet</p>
      <p className="mt-1 text-xs leading-relaxed text-muted">
        A run starts when a commit lands on a watched repository, or when you
        trigger one by hand.
      </p>
      <ol className="mt-4 space-y-2 text-xs leading-relaxed text-muted">
        <li>
          <span className="text-foreground">1.</span> Connect the GitHub App and
          your model provider —{" "}
          <Link
            href="/dashboard/integrations"
            className="underline decoration-rule underline-offset-4 hover:text-accent hover:decoration-accent"
          >
            Integrations
          </Link>
        </li>
        <li>
          <span className="text-foreground">2.</span>{" "}
          {hasRepo ? "Confirm the repository docxy watches" : "Add a repository to watch"} —{" "}
          <Link
            href="/dashboard/synced"
            className="underline decoration-rule underline-offset-4 hover:text-accent hover:decoration-accent"
          >
            Synced
          </Link>
        </li>
        <li>
          <span className="text-foreground">3.</span> Push a commit, or run{" "}
          <code className="font-mono text-foreground">docxy run HEAD</code> locally.
        </li>
      </ol>
    </div>
  );
}
