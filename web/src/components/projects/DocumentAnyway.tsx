"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LuCircleCheck, LuPlay } from "react-icons/lu";

import { useToast } from "@/components/dashboard/Toast";
import { ORGANIZATION_HEADER } from "@/lib/organization-guard";
import { queuedNotice } from "@/lib/skips";
// `import type` only - erased at build, so the server-side module it lives in
// is never pulled into this client bundle.
import type {
  StartProjectRun,
  StartProjectRunRefusal,
  StartProjectRunResult,
} from "@/lib/docxy";

const START_FAILED = "Could not start a run for this commit. Please try again.";

/**
 * Document one skipped push now, overriding whatever skipped it.
 *
 * Triage is the one reason this really does override: a run somebody asked
 * for is never triaged. The other three are the organization's plan speaking,
 * and the API says so again here - a 409 whose sentence names the allowance,
 * the plan or the billing hold. That sentence is shown as it is, because it is
 * the only thing on the page that says what to do next.
 *
 * The write names the organization this page was rendered for, like every
 * dashboard write. A tab left open on one organization while the session moved
 * to another would otherwise spend the second one's allowance on a commit from
 * the first one's list; the proxy refuses it with a 409 of its own, which reads
 * the same way and is shown the same way.
 *
 * "Queued" stays on the button once the API has taken the run, for as long as
 * the row is still on screen. The refresh that follows normally takes it away,
 * but not necessarily at once: a run that has to wait has no record until it
 * starts, so the row goes only when the API has forgotten the skip, and until
 * then an enabled button would invite asking twice. The API would deduplicate
 * that, but the person pressing it would not know.
 */
export function DocumentAnyway({
  organizationId,
  projectId,
  commit,
  shortSha,
}: {
  /** The organization this page was rendered for. A check, not the tenant. */
  organizationId: string;
  projectId: string;
  /** The full SHA, which is what the API is asked for. */
  commit: string;
  /** What the row shows, and so what the toast and the label say. */
  shortSha: string;
}) {
  const router = useRouter();
  const notify = useToast();
  const [state, setState] = useState<"idle" | "pending" | "queued">("idle");
  const [failure, setFailure] = useState<string | null>(null);

  async function start() {
    if (state !== "idle") return;
    setState("pending");
    setFailure(null);
    // The API's own words when it gave any, and the generic message when the
    // request never got that far - "Failed to fetch" helps nobody.
    let message = START_FAILED;
    try {
      const res = await fetch(`/api/docxy/projects/${encodeURIComponent(projectId)}/runs`, {
        method: "POST",
        headers: { "content-type": "application/json", [ORGANIZATION_HEADER]: organizationId },
        body: JSON.stringify({ commit } satisfies StartProjectRun),
      });
      // SAFETY: `started` is what tells the two answers apart and is checked
      // before anything else is read; a body that is neither - or not JSON, as
      // an older API's 404 is not - falls back to the generic message.
      const body = (await res.json().catch(() => null)) as
        | StartProjectRunResult
        | StartProjectRunRefusal
        | null;
      if (!res.ok || !body || !("started" in body)) {
        if (body && "error" in body && body.error) message = body.error;
        throw new Error(message);
      }
      setState("queued");
      notify(queuedNotice(shortSha, body));
      router.refresh();
    } catch {
      setState("idle");
      setFailure(message);
      notify(message, "error");
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={start}
        disabled={state !== "idle"}
        className="focus-ring inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap border border-rule bg-surface-2 px-2.5 py-1.5 text-xs font-medium transition-colors hover:border-accent hover:text-accent disabled:pointer-events-none disabled:opacity-60"
      >
        {state === "queued" ? (
          <LuCircleCheck size={13} aria-hidden className="text-ok" />
        ) : (
          <LuPlay size={12} aria-hidden />
        )}
        {state === "pending" ? "Starting…" : state === "queued" ? "Queued" : "Document anyway"}
        {/* Every row has this button, so the commit is part of its name: a
            list of identical "Document anyway" buttons read out one after
            another says nothing about which push each one is for. */}
        <span className="sr-only">, commit {shortSha}</span>
      </button>
      {/* Kept beside the row it belongs to once the toast has gone. Not a live
          region: the toast already announced it, as an alert. */}
      {failure && (
        <p className="basis-full text-xs leading-relaxed text-danger">{failure}</p>
      )}
    </>
  );
}
