"use client";

import { useToast } from "@/components/dashboard/Toast";
import { useState } from "react";
import { LuArrowRight } from "react-icons/lu";

import { organization } from "@/lib/auth-client";

/**
 * The first thing a new account does: name the organization everything else
 * will belong to.
 *
 * One field, because one field is the whole decision. The slug is derived
 * rather than asked for - a second input that can fail validation, in front of
 * somebody who has not seen the product yet, buys nothing a suffix cannot fix.
 *
 * On success this hands off to GitHub rather than to the dashboard. An
 * organization with no repositories has nothing to show, so landing there would
 * be landing on an empty state; installing the App is the step that makes the
 * dashboard worth arriving at.
 *
 * The hand-off goes through /api/github/install, not to github.com. That route
 * is what mints the signed, single-use state cookie the callback verifies, and
 * jumping over it left the browser arriving back from GitHub with a `code` and
 * no flow to match it against - which the callback correctly refuses as
 * `install_expired`. Onboarding ended on an error page reached by doing exactly
 * what the button said. It is also the only place that notices the App is not
 * configured at all, instead of sending somebody to a 404 on github.com.
 */

const FIELD =
  "focus-ring w-full rounded-md border border-rule bg-surface px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted";

/**
 * A URL-safe slug, with a short random suffix.
 *
 * The suffix is not decoration: slugs are unique across every organization, and
 * "Acme" is a name several people will choose. Colliding would fail the create
 * call with a message about a slug the person never typed and cannot see.
 */
function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  const suffix = Math.random().toString(36).slice(2, 6);
  return `${base || "org"}-${suffix}`;
}

export function CreateOrganization({ connectGithub = true, onCreated, onPendingChange }: {
  connectGithub?: boolean;
  onCreated?: () => void;
  onPendingChange?: (pending: boolean) => void;
}) {
  const notify = useToast();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  function reportError(message: string) { setError(message); notify(message, "error"); }
  const [createdId, setCreatedId] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = String(new FormData(event.currentTarget).get("name") ?? "").trim();
    if (pending) return;
    if (!name) {
      reportError("Enter an organization name.");
      return;
    }

    setPending(true);
    onPendingChange?.(true);
    setError(null);

    try {
      // If activation fails, retry opening the organization already created
      // instead of creating a second organization with the same name.
      let organizationId = createdId;
      if (!organizationId) {
        const created = await organization.create({ name, slug: slugify(name) });
        if (created.error || !created.data) {
          reportError(created.error?.message ?? "Could not create the organization. Please try again.");
          return;
        }
        organizationId = created.data.id;
        setCreatedId(organizationId);
      }

      const activated = await organization.setActive({ organizationId });
      if (activated.error) {
        reportError("Your organization was created. Try again to open it.");
        return;
      }

      notify(`${name} organization created.`);
      if (onCreated) {
        onCreated();
        return;
      }

      // Reload the dashboard shell so the new membership and active name are
      // reflected immediately. Additional organizations need no GitHub setup.
      window.location.href = connectGithub
        ? `/api/github/install?organizationId=${encodeURIComponent(organizationId)}`
        : "/dashboard";
    } catch {
      reportError("Could not finish setting up your organization. Please try again.");
    } finally {
      setPending(false);
      onPendingChange?.(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      <div>
        <label htmlFor="name" className="mb-1.5 block text-sm font-medium text-foreground">
          Organization name
        </label>
        <input
          id="name"
          name="name"
          type="text"
          required
          autoFocus
          maxLength={64}
          readOnly={createdId !== null}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? "organization-error" : undefined}
          placeholder="Acme Engineering"
          className={FIELD}
        />
        <p className="mt-2 text-xs leading-relaxed text-muted">
          Your repositories, runs, and teammates all live here. You can rename it later, and
          invite people once you are in.
        </p>
      </div>

      {error && (
        <p id="organization-error" role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="focus-ring inline-flex w-full items-center justify-center gap-2 rounded-md bg-accent-deep py-3 text-sm font-medium text-white transition-colors hover:bg-accent disabled:opacity-60"
      >
        {pending ? (createdId ? "Opening…" : "Creating…") : createdId ? "Open organization" : connectGithub ? "Create and connect GitHub" : "Create organization"}
        {!pending && <LuArrowRight size={15} aria-hidden />}
      </button>
    </form>
  );
}
