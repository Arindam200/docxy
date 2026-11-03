/**
 * Seats: how many people an organization's plan lets in, and whether there is
 * room for one more.
 *
 * Free of database imports for the same reason `members.ts` is: these are the
 * decisions, and a rule that has to open a connection to answer "is a fourth
 * person allowed on a three-seat plan" is a rule nobody tests. The counting
 * lives in `billing/seats.ts`.
 *
 * The rule comes from guides/TEAM-PRICING-PLAN.md: a pending invitation holds a
 * seat, and active members plus pending invitations must not exceed what the
 * organization bought. Reserving at invitation time is what stops five people
 * being invited to a one-seat plan and the first one to click getting in.
 */

/** One organization's seats, and what is already sitting in them. */
export interface SeatUsage {
  /** The plan's display name, for the sentence a refusal is read as. */
  planName: string;
  /** Seats the organization's plan includes, purchased add-ons included. */
  seats: number;
  members: number;
  /** Invitations still pending and not yet expired. Each one holds a seat. */
  pendingInvitations: number;
  /** Whether this plan sells more seats, or needs a different plan to get them. */
  expandable: boolean;
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function remedy(usage: SeatUsage): string {
  return usage.expandable
    ? "ask the billing owner to add seats"
    : "ask the billing owner to move this organization to the Team plan";
}

/**
 * Why another invitation cannot be sent, or null when there is a free seat.
 *
 * The invitation about to be sent needs a seat of its own, so the question is
 * whether members and reservations together have left one over - not whether
 * they have already gone past the limit.
 */
export function inviteSeatRefusal(usage: SeatUsage): string | null {
  if (usage.members + usage.pendingInvitations < usage.seats) return null;
  return (
    `This organization's ${usage.planName} plan includes ${count(usage.seats, "seat", "seats")}, ` +
    `and ${count(usage.members, "member", "members")} and ` +
    `${count(usage.pendingInvitations, "pending invitation", "pending invitations")} already fill ` +
    `${usage.seats === 1 ? "it" : "them"}. Cancel an invitation, remove someone, or ${remedy(usage)}.`
  );
}

/**
 * Why an invitation cannot be accepted, or null when there is a seat to take.
 *
 * Other pending invitations are not counted here. They are reservations, and
 * the one being accepted is among them, so counting them would refuse every
 * acceptance on a full plan - including the one each reservation was made for.
 * What can still be short is the members alone: a plan that lost seats since
 * the invitation was sent, a downgrade from Team for instance, has fewer seats
 * than it reserved.
 */
export function acceptSeatRefusal(usage: SeatUsage): string | null {
  if (usage.members < usage.seats) return null;
  return (
    `This organization's ${usage.planName} plan includes ${count(usage.seats, "seat", "seats")}, ` +
    `and its ${count(usage.members, "member", "members")} already ` +
    `${usage.members === 1 ? "fills" : "fill"} ${usage.seats === 1 ? "it" : "them"}. ` +
    "Ask whoever invited you to free a seat or add one, then accept again."
  );
}

/**
 * Whether an invitation that has just been written still fits, given how many
 * pending invitations were written before it.
 *
 * The check before writing and the write are separate statements, so two
 * invitations sent at the same instant could both see the last free seat. This
 * is the second look, after both are written: invitations hold seats in the
 * order they were created, so of two that raced, the earlier fits and the
 * later does not - and both requests, looking at the same rows, agree on which
 * is which.
 */
export function invitationFits(usage: Pick<SeatUsage, "seats" | "members">, ahead: number): boolean {
  return usage.members + ahead + 1 <= usage.seats;
}
