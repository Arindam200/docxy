"use client";

import { useToast } from "./Toast";
import { useState } from "react";
import { ORGANIZATION_HEADER } from "@/lib/organization-guard";

const SAVE_FAILED = "Could not save instructions. Please try again.";

/**
 * Editor for the standing custom instructions handed to the docs agent.
 * Saves through the BFF to PUT /api/instructions on the pipeline server.
 *
 * The save names the organization these instructions were loaded for. One
 * organization's house style typed into a tab that has since been switched to
 * another would otherwise replace the other's, wholesale and without a trace,
 * so the proxy refuses it and this says why.
 */
export function InstructionsEditor({
  organizationId,
  initial,
  updatedAt,
}: {
  organizationId: string;
  initial: string;
  updatedAt: string | null;
}) {
  const [value, setValue] = useState(initial);
  const [savedValue, setSavedValue] = useState(initial);
  const notify = useToast();
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  // What went wrong, in the proxy's words when it gave any. "Is the API up?"
  // is the wrong question to ask somebody whose organization changed.
  const [failure, setFailure] = useState(SAVE_FAILED);
  const dirty = value !== savedValue;

  async function save() {
    if (!dirty || state === "saving") return;
    setState("saving");
    // The proxy's own words when it gave any, and the generic message when the
    // request never got that far - "Failed to fetch" helps nobody.
    let message = SAVE_FAILED;
    try {
      const res = await fetch("/api/docxy/instructions", {
        method: "PUT",
        headers: { "content-type": "application/json", [ORGANIZATION_HEADER]: organizationId },
        body: JSON.stringify({ instructions: value }),
      });
      if (!res.ok) {
        // SAFETY: only `error` is read, as an optional string, and a body that
        // is not that shape - or not JSON - falls back to the generic message.
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        if (body?.error) message = body.error;
        throw new Error(message);
      }
      setSavedValue(value);
      setState("saved");
      notify("Instructions saved. Applies from the next run.");
    } catch {
      setFailure(message);
      setState("error");
      notify(message, "error");
    }
  }

  return (
    <div className="border border-rule bg-surface">
      <textarea
        aria-label="Custom instructions"
        disabled={state === "saving"}
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setState("idle");
        }}
        rows={8}
        spellCheck={false}
        placeholder={"e.g.\n- Keep the voice in README.md dry and second person.\n- Never rewrite the Security section without flagging it.\n- Changelog entries: one line, imperative mood."}
        className="focus-ring w-full resize-y rounded-t-lg bg-transparent px-5 py-4 font-mono text-sm leading-relaxed text-foreground placeholder:text-muted/60 border-b border-rule"
      />
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
        <p className="text-xs text-muted" aria-live="polite">
          {state === "saving" && "Saving…"}
          {state === "saved" && "Saved. Applies from the next run."}
          {state === "error" && <span className="text-danger">{failure}</span>}
          {state === "idle" &&
            (dirty
              ? "Unsaved changes"
              : updatedAt
                ? `Last updated ${new Date(updatedAt).toLocaleString()}`
                : "No custom instructions yet. Default instructions will be used.")}
        </p>
        <button
          type="button"
          onClick={save}
          disabled={!dirty || state === "saving"}
          className="focus-ring rounded-md bg-accent-deep px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-accent disabled:opacity-40 disabled:pointer-events-none"
        >
          {state === "saving" ? "Saving…" : "Save instructions"}
        </button>
      </div>
    </div>
  );
}
