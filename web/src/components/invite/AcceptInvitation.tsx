"use client";

import { useState } from "react";
import { LuArrowRight } from "react-icons/lu";

import { organization } from "@/lib/auth-client";

/**
 * Accept or decline, for the person the invitation was actually addressed to.
 *
 * On success this leaves through /api/organization/activate rather than pushing
 * straight to the dashboard. Joining an organization does not make the session
 * point at it, and the dashboard reads everything from that pointer - so going
 * direct would land somebody in whichever organization they were already in,
 * which looks exactly like the invitation not having worked. The activate route
 * re-checks membership before switching, so naming the new organization here is
 * a request rather than a claim.
 */
export function AcceptInvitation({
  invitationId,
  organizationId,
  organizationName,
}: {
  invitationId: string;
  organizationId: string;
  organizationName: string;
}) {
  const [pending, setPending] = useState<"accept" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function accept() {
    setPending("accept");
    setError(null);
    try {
      const result = await organization.acceptInvitation({ invitationId });
      if (result.error) {
        setPending(null);
        setError(result.error.message ?? "The invitation could not be accepted.");
        return;
      }
      const next = encodeURIComponent("/dashboard");
      window.location.href = `/api/organization/activate?organizationId=${encodeURIComponent(organizationId)}&next=${next}`;
    } catch {
      setPending(null);
      setError("The invitation could not be accepted. Try again in a moment.");
    }
  }

  async function decline() {
    setPending("reject");
    setError(null);
    try {
      const result = await organization.rejectInvitation({ invitationId });
      if (result.error) {
        setPending(null);
        setError(result.error.message ?? "The invitation could not be declined.");
        return;
      }
      window.location.href = "/dashboard";
    } catch {
      setPending(null);
      setError("The invitation could not be declined. Try again in a moment.");
    }
  }

  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={accept}
        disabled={pending !== null}
        className="focus-ring flex w-full items-center justify-center gap-2 rounded-md bg-accent-deep py-3 text-sm font-medium text-white transition-colors hover:bg-accent disabled:opacity-60"
      >
        {pending === "accept" ? "Joining…" : `Join ${organizationName}`}
        {pending === null && <LuArrowRight size={15} aria-hidden />}
      </button>
      <button
        type="button"
        onClick={decline}
        disabled={pending !== null}
        className="focus-ring flex w-full items-center justify-center rounded-md border border-rule py-3 text-sm font-medium transition-colors hover:bg-surface-2 disabled:opacity-60"
      >
        {pending === "reject" ? "Declining…" : "Decline"}
      </button>

      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
