"use client";

import { useToast } from "./Toast";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { LuBuilding2, LuMail, LuTrash2, LuUserPlus } from "react-icons/lu";

import { organization } from "@/lib/auth-client";
import { timeAgo } from "@/lib/format";
import {
  canRemoveMember,
  type OrganizationRole,
  type PendingInvitation,
  type TeamMember,
} from "@/lib/members";
import { Select } from "./Select";

const ROLE_LABEL = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
} satisfies Record<OrganizationRole, string>;

const ROLE_TONE = {
  owner: "border-accent/30 bg-accent/10 text-accent",
  admin: "border-rule bg-surface-2 text-foreground",
  member: "border-rule bg-surface-2 text-muted",
} satisfies Record<OrganizationRole, string>;

/**
 * The roles an invitation may be sent for. Ownership is deliberately absent:
 * an owner is made by creating the organization or by a transfer, not by an
 * email somebody can accept a week later.
 */
type InvitableRole = "member" | "admin";

const INVITABLE = [
  { value: "member", label: "Member - can see everything, changes nothing" },
  { value: "admin", label: "Admin - can also invite and remove people" },
] as const satisfies ReadonlyArray<{ value: InvitableRole; label: string }>;

/** `Select` hands back a plain string; narrowed rather than asserted. */
function asInvitable(value: string): InvitableRole {
  return value === "admin" ? "admin" : "member";
}

const FIELD =
  "focus-ring w-full border border-rule bg-surface px-3 py-2 text-sm text-foreground placeholder:text-muted/60";

export function MembersPanel({
  members,
  invitations,
  viewerId,
  viewerRole,
  canManage,
  canSendEmail,
}: {
  members: TeamMember[];
  invitations: PendingInvitation[];
  viewerId: string;
  viewerRole: OrganizationRole;
  canManage: boolean;
  canSendEmail: boolean;
}) {
  const router = useRouter();
  const notify = useToast();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<InvitableRole>("member");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  function reportError(message: string) {
    setError(message);
    notify(message, "error");
  }
  const [sent, setSent] = useState<string | null>(null);
  /** The row currently being acted on, so only its own button shows progress. */
  const [busyId, setBusyId] = useState<string | null>(null);

  async function invite(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const address = email.trim();
    if (!address) return;

    setPending(true);
    setError(null);
    setSent(null);

    // Already here, or already asked. Better Auth refuses both, but its message
    // is about a constraint rather than about the person.
    if (members.some((entry) => entry.email.toLowerCase() === address.toLowerCase())) {
      setPending(false);
      reportError(`${address} is already in this organization.`);
      return;
    }
    if (invitations.some((entry) => entry.email.toLowerCase() === address.toLowerCase())) {
      setPending(false);
      reportError(`${address} already has an invitation waiting.`);
      return;
    }

    try {
      const result = await organization.inviteMember({ email: address, role });
      if (result.error) {
        reportError(result.error.message ?? "The invitation could not be sent.");
        return;
      }
      setEmail("");
      setSent(address);
      notify(`Invitation sent to ${address}.`);
      router.refresh();
    } catch {
      reportError("The invitation could not be sent. Try again in a moment.");
    } finally {
      setPending(false);
    }
  }

  async function cancel(id: string, address: string) {
    setBusyId(id);
    setError(null);
    setSent(null);
    try {
      const result = await organization.cancelInvitation({ invitationId: id });
      if (result.error) {
        reportError(result.error.message ?? `Could not cancel the invitation to ${address}.`);
        return;
      }
      notify(`Invitation to ${address} cancelled.`);
      router.refresh();
    } catch {
      reportError(`Could not cancel the invitation to ${address}. Please try again.`);
    } finally {
      setBusyId(null);
    }
  }

  async function remove(entry: TeamMember) {
    setBusyId(entry.id);
    setError(null);
    setSent(null);
    try {
      // Addressed by user id: `removeMember` takes the member's user, and the
      // server re-checks the caller's rank before doing anything.
      const result = await organization.removeMember({ memberIdOrEmail: entry.userId });
      if (result.error) {
        reportError(result.error.message ?? `Could not remove ${entry.name}.`);
        return;
      }
      notify(`${entry.name || entry.email} removed from the organization.`);
      router.refresh();
    } catch {
      reportError(`Could not remove ${entry.name || entry.email}. Please try again.`);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-6">
      {canManage && (
        <section className="border border-rule bg-surface p-5">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <LuUserPlus size={15} aria-hidden /> Invite someone
          </h2>
          <p className="mt-1.5 text-xs leading-relaxed text-muted">
            They get an email with a link. It expires in a week, and they join only by
            following it, so an address typed wrongly reaches nobody.
          </p>

          {!canSendEmail ? (
            <p role="alert" className="mt-4 border border-danger/30 bg-danger/5 px-3 py-2 text-xs leading-relaxed text-danger">
              This deployment has no email provider configured, so an invitation cannot be
              delivered. Set RESEND_API_KEY and EMAIL_DOMAIN to turn invitations on.
            </p>
          ) : (
            <form onSubmit={invite} className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-start">
              <label className="min-w-0 flex-1">
                <span className="sr-only">Email address to invite</span>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="teammate@example.com"
                  autoComplete="off"
                  spellCheck={false}
                  className={FIELD}
                />
              </label>
              <Select label="Role for the invitation" value={role} onChange={(value) => setRole(asInvitable(value))} options={INVITABLE} />
              <button
                type="submit"
                disabled={pending}
                className="focus-ring shrink-0 border border-accent-deep bg-accent-deep px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-deep/85 disabled:opacity-60"
              >
                {pending ? "Sending…" : "Send invitation"}
              </button>
            </form>
          )}

          {error && (
            <p role="alert" className="mt-3 text-xs text-danger">
              {error}
            </p>
          )}
          {sent && (
            <p className="mt-3 text-xs text-ok">
              Invitation sent to {sent}. It appears below until they accept it.
            </p>
          )}
        </section>
      )}

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">
          {members.length} {members.length === 1 ? "member" : "members"}
        </h2>
        <div className="overflow-x-auto border border-rule bg-surface">
          <table className="w-full min-w-[560px] text-left text-sm">
            <caption className="sr-only">People in this organization</caption>
            <thead className="border-b border-rule bg-surface-2 text-xs text-muted">
              <tr>
                <th scope="col" className="px-4 py-3 font-medium">Person</th>
                <th scope="col" className="px-4 py-3 font-medium">Role</th>
                <th scope="col" className="px-4 py-3 font-medium">Joined</th>
                <th scope="col" className="px-4 py-3 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-rule">
              {members.map((entry) => {
                const isSelf = entry.userId === viewerId;
                const removable = canRemoveMember(viewerRole, entry.role, isSelf);
                return (
                  <tr key={entry.id} className="transition-colors hover:bg-surface-2">
                    <th scope="row" className="px-4 py-3 font-medium">
                      <span className="flex items-center gap-2.5">
                        <Avatar member={entry} />
                        <span className="min-w-0">
                          <span className="block truncate">
                            {entry.name || entry.email}
                            {isSelf && <span className="ml-1.5 text-xs font-normal text-muted">(you)</span>}
                          </span>
                          <span className="block truncate text-xs font-normal text-muted">{entry.email}</span>
                        </span>
                      </span>
                    </th>
                    <td className="px-4 py-3">
                      <span className={`inline-flex whitespace-nowrap border px-2 py-0.5 text-xs ${ROLE_TONE[entry.role]}`}>
                        {ROLE_LABEL[entry.role]}
                      </span>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-xs text-muted">{timeAgo(entry.joinedAt)}</td>
                    <td className="px-4 py-3 text-right text-xs">
                      {removable ? (
                        <button
                          type="button"
                          disabled={busyId === entry.id}
                          onClick={() => remove(entry)}
                          className="focus-ring inline-flex items-center gap-1.5 text-muted transition-colors hover:text-danger disabled:opacity-50"
                        >
                          <LuTrash2 size={13} aria-hidden />
                          {busyId === entry.id ? "Removing…" : "Remove"}
                        </button>
                      ) : (
                        <span className="text-muted">-</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {invitations.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">
            {invitations.length} pending {invitations.length === 1 ? "invitation" : "invitations"}
          </h2>
          <div className="overflow-x-auto border border-rule bg-surface">
            <table className="w-full min-w-[560px] text-left text-sm">
              <caption className="sr-only">Invitations sent and not yet accepted</caption>
              <thead className="border-b border-rule bg-surface-2 text-xs text-muted">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">Invited</th>
                  <th scope="col" className="px-4 py-3 font-medium">Role</th>
                  <th scope="col" className="px-4 py-3 font-medium">Expires</th>
                  <th scope="col" className="px-4 py-3 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-rule">
                {invitations.map((entry) => (
                  <tr key={entry.id} className="transition-colors hover:bg-surface-2">
                    <th scope="row" className="px-4 py-3 font-medium">
                      <span className="flex items-center gap-2.5">
                        <span className="flex h-7 w-7 shrink-0 items-center justify-center border border-rule bg-surface-2 text-muted">
                          <LuMail size={13} aria-hidden />
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate">{entry.email}</span>
                          <span className="block truncate text-xs font-normal text-muted">
                            Invited by {entry.invitedByName}
                          </span>
                        </span>
                      </span>
                    </th>
                    <td className="px-4 py-3">
                      <span className={`inline-flex whitespace-nowrap border px-2 py-0.5 text-xs ${ROLE_TONE[entry.role]}`}>
                        {ROLE_LABEL[entry.role]}
                      </span>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-xs text-muted">{timeAgo(entry.expiresAt)}</td>
                    <td className="px-4 py-3 text-right text-xs">
                      {canManage ? (
                        <button
                          type="button"
                          disabled={busyId === entry.id}
                          onClick={() => cancel(entry.id, entry.email)}
                          className="focus-ring inline-flex items-center gap-1.5 text-muted transition-colors hover:text-danger disabled:opacity-50"
                        >
                          <LuTrash2 size={13} aria-hidden />
                          {busyId === entry.id ? "Cancelling…" : "Cancel"}
                        </button>
                      ) : (
                        <span className="text-muted">-</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {!canManage && (
        <p className="text-xs leading-relaxed text-muted">
          Only owners and admins can invite or remove people. Ask one of them if somebody
          needs access.
        </p>
      )}
    </div>
  );
}

function Avatar({ member }: { member: TeamMember }) {
  if (member.image) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={member.image}
        alt=""
        referrerPolicy="no-referrer"
        className="h-7 w-7 shrink-0 border border-rule object-cover"
      />
    );
  }
  return (
    <span className="flex h-7 w-7 shrink-0 items-center justify-center border border-rule bg-surface-2 text-muted">
      <LuBuilding2 size={13} aria-hidden />
    </span>
  );
}
