"use client";

import { useEffect, useRef, useState } from "react";
import { LuBuilding2, LuX } from "react-icons/lu";
import { CreateOrganization } from "@/components/onboarding/CreateOrganization";

export function CreateOrganizationDialog({ onDismiss, onCreated }: {
  onDismiss: () => void;
  onCreated: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    dialog?.querySelector<HTMLInputElement>("input[name=name]")?.focus();
    return () => dialog?.close();
  }, []);

  function dismiss() {
    ref.current?.close();
    onDismiss();
  }

  function created() {
    ref.current?.close();
    onCreated();
  }

  return (
    <dialog
      ref={ref}
      aria-labelledby="create-organization-title"
      aria-describedby="create-organization-description"
      aria-modal="true"
      onCancel={(event) => { event.preventDefault(); if (!pending) dismiss(); }}
      onClick={(event) => {
        if (pending || event.target !== event.currentTarget) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dismiss();
      }}
      className="fixed inset-x-0 bottom-auto top-[12vh] m-0 mx-auto max-h-[80vh] w-[calc(100%-2rem)] max-w-md overflow-y-auto rounded-xl border border-rule bg-background p-6 text-foreground shadow-2xl backdrop:bg-black/40 backdrop:backdrop-blur-sm"
    >
      <div className="mb-5 flex items-start justify-between gap-4">
        <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent/10 text-accent"><LuBuilding2 size={20} aria-hidden /></span>
        <button type="button" aria-label="Close create organization" onClick={dismiss} disabled={pending} className="focus-ring rounded-md p-1.5 text-muted transition-colors hover:bg-surface-2 hover:text-foreground disabled:opacity-40"><LuX size={18} aria-hidden /></button>
      </div>
      <h2 id="create-organization-title" className="text-xl font-semibold tracking-tight">Create organization</h2>
      <p id="create-organization-description" className="mb-6 mt-2 text-sm leading-relaxed text-muted">A separate space for your projects and teammates. You can switch organizations anytime.</p>
      <CreateOrganization connectGithub={false} onCreated={created} onPendingChange={setPending} />
      <button type="button" onClick={dismiss} disabled={pending} className="focus-ring mt-3 w-full rounded-md border border-rule px-4 py-2.5 text-sm font-medium transition-colors hover:bg-surface disabled:opacity-40">Cancel</button>
    </dialog>
  );
}
