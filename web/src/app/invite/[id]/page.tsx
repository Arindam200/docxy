import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";

import { AuthShell } from "@/components/auth/AuthShell";
import { AcceptInvitation } from "@/components/invite/AcceptInvitation";
import { getSessionUser } from "@/lib/auth";
import { authReady } from "@/lib/env";
import { getInvitation } from "@/lib/members-store";
import { viewable } from "@/lib/members";

export const metadata: Metadata = {
  title: "You have been invited · Docxy",
};

export const dynamic = "force-dynamic";

/** What each dead end says, and what it leaves the reader able to do. */
const PROBLEM = {
  expired: "This invitation has expired. Invitations last a week; ask whoever sent it for a new one.",
  accepted: "This invitation has already been accepted. Sign in and it will be waiting for you.",
  rejected: "This invitation was declined. Ask whoever sent it for a new one if that was a mistake.",
  canceled: "This invitation was cancelled by the organization, so it can no longer be used.",
  unknown: "This invitation is no longer valid.",
} satisfies Record<string, string>;

/**
 * The page an invitation email links to.
 *
 * Written for somebody who has never seen this product: the ordinary recipient
 * has no account, which is the entire reason invitations are addressed to an
 * email rather than to a user. So it renders signed out, says who invited them
 * and to what, and sends them to sign up carrying this URL - arriving back here
 * afterwards with a session, at which point the same page offers the buttons.
 */
export default async function InvitePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const detail = authReady() ? await getInvitation(id) : null;
  const user = authReady() ? await getSessionUser(await headers()).catch(() => null) : null;

  if (!detail) {
    return (
      <Shell title="Invitation not found" lede="This link does not match an invitation. It may have been mistyped, or the organization may have removed it.">
        <Back />
      </Shell>
    );
  }

  if (detail.problem) {
    return (
      <Shell title={`Invitation to ${detail.organizationName}`} lede={PROBLEM[detail.problem]}>
        <Back />
      </Shell>
    );
  }

  const next = `/invite/${encodeURIComponent(id)}`;

  // Signed out. The address is withheld - it belongs to whoever was invited,
  // and this reader has not yet shown they are that person.
  if (!user) {
    return (
      <Shell
        title={`Join ${detail.organizationName}`}
        lede={`${detail.inviterName} invited you to join ${detail.organizationName} on Docxy as ${detail.role === "admin" ? "an admin" : "a member"}. Sign in with the address the invitation was sent to, or create an account with it.`}
      >
        <div className="space-y-3">
          <Link
            href={`/signup?next=${encodeURIComponent(next)}`}
            className="focus-ring flex w-full items-center justify-center rounded-md bg-accent-deep py-3 text-sm font-medium text-white transition-colors hover:bg-accent"
          >
            Create an account
          </Link>
          <Link
            href={`/login?next=${encodeURIComponent(next)}`}
            className="focus-ring flex w-full items-center justify-center rounded-md border border-rule py-3 text-sm font-medium transition-colors hover:bg-surface-2"
          >
            I already have one
          </Link>
        </div>
      </Shell>
    );
  }

  // Signed in as somebody else. Naming the signed-in address is safe - it is
  // the reader's own - while the invited one still is not.
  if (!viewable(detail, user.email)) {
    return (
      <Shell
        title="This invitation is for a different address"
        lede={`You are signed in as ${user.email}, and this invitation was sent to another address. Sign out and back in with the one that received the email.`}
      >
        <Link
          href={`/login?next=${encodeURIComponent(next)}`}
          className="focus-ring flex w-full items-center justify-center rounded-md border border-rule py-3 text-sm font-medium transition-colors hover:bg-surface-2"
        >
          Use a different account
        </Link>
      </Shell>
    );
  }

  return (
    <Shell
      title={`Join ${detail.organizationName}`}
      lede={`${detail.inviterName} invited you to join as ${detail.role === "admin" ? "an admin" : "a member"}. Everyone in an organization can see its repositories, runs, and drafted documentation.`}
    >
      <AcceptInvitation
        invitationId={detail.id}
        organizationId={detail.organizationId}
        organizationName={detail.organizationName}
      />
    </Shell>
  );
}

function Shell({ title, lede, children }: { title: string; lede: string; children: React.ReactNode }) {
  return (
    <AuthShell
      eyebrow="Invitation"
      title={title}
      lede={lede}
      alt={<>Docxy keeps documentation and release notes up to date as your team ships.</>}
    >
      {children}
    </AuthShell>
  );
}

function Back() {
  return (
    <Link
      href="/"
      className="focus-ring flex w-full items-center justify-center rounded-md border border-rule py-3 text-sm font-medium transition-colors hover:bg-surface-2"
    >
      Back to Docxy
    </Link>
  );
}
