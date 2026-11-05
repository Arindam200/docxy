import assert from "node:assert/strict";
import { test } from "node:test";
import { acceptSeatRefusal, invitationFits, inviteSeatRefusal, type SeatUsage } from "../src/lib/seats";

function usage(seats: number, members: number, pendingInvitations: number, expandable = false): SeatUsage {
  return { planName: expandable ? "Team" : "Pro", seats, members, pendingInvitations, expandable };
}

test("an invitation needs a seat nobody holds yet", () => {
  // A one-seat plan with its one member: nobody else can be invited. This is
  // the case that used to allow twenty invitations.
  assert.notEqual(inviteSeatRefusal(usage(1, 1, 0)), null);
  // Five seats, three members, one pending: one seat is left.
  assert.equal(inviteSeatRefusal(usage(5, 3, 1, true)), null);
  // ...and it is taken once another invitation is pending.
  assert.notEqual(inviteSeatRefusal(usage(5, 3, 2, true)), null);
});

test("pending invitations hold seats, so they count against new ones", () => {
  assert.notEqual(inviteSeatRefusal(usage(5, 1, 4, true)), null);
  assert.equal(inviteSeatRefusal(usage(5, 1, 3, true)), null);
});

test("an organization already over its seats cannot invite", () => {
  // A downgrade from Team leaves more people than the new plan includes.
  assert.notEqual(inviteSeatRefusal(usage(1, 4, 2)), null);
});

test("the refusal names the plan and the limit, and the way out", () => {
  const pro = inviteSeatRefusal(usage(1, 1, 0))!;
  assert.match(pro, /Pro plan includes 1 seat\b/);
  assert.match(pro, /1 member and 0 pending invitations/);
  assert.match(pro, /Team plan/);
  const team = inviteSeatRefusal(usage(5, 4, 1, true))!;
  assert.match(team, /Team plan includes 5 seats/);
  assert.match(team, /add seats/);
});

test("accepting turns a reservation into a member, so only members count", () => {
  // Every seat reserved, one of those reservations being accepted: allowed.
  assert.equal(acceptSeatRefusal(usage(5, 3, 2, true)), null);
  assert.equal(acceptSeatRefusal(usage(5, 4, 1, true)), null);
  // Every seat filled by members already: refused, whatever was reserved.
  const full = acceptSeatRefusal(usage(5, 5, 1, true))!;
  assert.match(full, /Team plan includes 5 seats/);
  assert.notEqual(acceptSeatRefusal(usage(1, 1, 3)), null);
});

test("of two invitations that raced for the last seat, the earlier keeps it", () => {
  // Three seats, two members: one seat left, and two invitations written at once.
  const usage = { seats: 3, members: 2 };
  assert.equal(invitationFits(usage, 0), true, "the first one written fits");
  assert.equal(invitationFits(usage, 1), false, "the second one written does not");
});

test("an invitation behind others still fits while seats remain", () => {
  assert.equal(invitationFits({ seats: 5, members: 1 }, 3), true);
  assert.equal(invitationFits({ seats: 5, members: 1 }, 4), false);
});
