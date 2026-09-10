"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import type { DashboardUser } from "@/lib/user";

export function ProfileSettings({ user }: { user: DashboardUser }) {
  const router = useRouter();
  const [name, setName] = useState(user.name);
  const [savedName, setSavedName] = useState(user.name);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const pending = state === "saving";

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextName = name.trim();
    if (pending || !nextName || nextName === savedName) return;
    setState("saving");
    try {
      const { error } = await authClient.updateUser({ name: nextName });
      if (error) {
        setState("error");
        return;
      }
      setName(nextName);
      setSavedName(nextName);
      setState("saved");
      router.refresh();
    } catch {
      setState("error");
    }
  }

  return (
    <form onSubmit={save} className="border border-rule bg-surface p-5 space-y-5">
      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <label htmlFor="profile-name" className="block text-sm font-medium">Name</label>
          <input
            id="profile-name"
            name="name"
            autoComplete="name"
            required
            maxLength={200}
            disabled={pending}
            value={name}
            onChange={(event) => { setName(event.target.value); setState("idle"); }}
            className="focus-ring mt-2 w-full border border-rule bg-background px-3 py-2 text-sm disabled:opacity-60"
          />
        </div>
        <div>
          <label htmlFor="profile-email" className="block text-sm font-medium">Email</label>
          <input
            id="profile-email"
            type="email"
            value={user.email}
            readOnly
            aria-describedby="profile-email-help"
            className="focus-ring mt-2 w-full border border-rule bg-surface-2 px-3 py-2 text-sm text-muted"
          />
          <p id="profile-email-help" className="mt-2 text-xs text-muted">Your sign-in email. Email changes are not supported yet.</p>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p role="status" className={`text-xs ${state === "error" ? "text-danger" : "text-muted"}`}>
          {state === "saved" ? "Profile saved." : state === "error" ? "Could not save your profile. Please try again." : pending ? "Saving…" : "Your name is visible to other organization members."}
        </p>
        <button
          type="submit"
          disabled={pending || !name.trim() || name.trim() === savedName}
          className="focus-ring rounded-md bg-accent-deep px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-accent disabled:opacity-40 disabled:pointer-events-none"
        >
          {pending ? "Saving…" : "Save profile"}
        </button>
      </div>
    </form>
  );
}
