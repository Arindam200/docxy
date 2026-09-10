"use client";

import { useState } from "react";

/**
 * Editor for the standing custom instructions handed to the docs agent.
 * Saves through the BFF to PUT /api/instructions on the pipeline server.
 */
export function InstructionsEditor({
  initial,
  updatedAt,
}: {
  initial: string;
  updatedAt: string | null;
}) {
  const [value, setValue] = useState(initial);
  const [savedValue, setSavedValue] = useState(initial);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const dirty = value !== savedValue;

  async function save() {
    if (!dirty || state === "saving") return;
    setState("saving");
    try {
      const res = await fetch("/api/docxy/instructions", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ instructions: value }),
      });
      if (!res.ok) throw new Error(String(res.status));
      setSavedValue(value);
      setState("saved");
    } catch {
      setState("error");
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
          {state === "error" && <span className="text-danger">Could not save. Is the API up?</span>}
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
