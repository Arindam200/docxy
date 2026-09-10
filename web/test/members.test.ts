import assert from "node:assert/strict";
import { test } from "node:test";
import {
  asRole,
  byRankThenName,
  canManageMembers,
  canRemoveMember,
  invitationProblem,
  viewable,
  type InvitationDetail,
} from "../src/lib/members";

test("an unrecognised role reads as the least privileged one", () => {
  assert.equal(asRole("owner"), "owner");
  assert.equal(asRole("admin"), "admin");
  assert.equal(asRole("member"), "member");
  // The column is free text. A value from a future plugin version, or written
  // by hand, must never be mistaken for privilege.
  assert.equal(asRole("superuser"), "member");
  assert.equal(asRole(null), "member");
  assert.equal(asRole(undefined), "member");
});

test("only owners and admins manage the team", () => {
  assert.equal(canManageMembers("owner"), true);
  assert.equal(canManageMembers("admin"), true);
  assert.equal(canManageMembers("member"), false);
});

test("removal follows rank, and never reaches an owner", () => {
  assert.equal(canRemoveMember("owner", "admin", false), true);
  assert.equal(canRemoveMember("owner", "member", false), true);
  assert.equal(canRemoveMember("admin", "member", false), true);

  // An admin cannot remove a peer, which would let two admins race to eject
  // each other.
  assert.equal(canRemoveMember("admin", "admin", false), false);
  // Nor an owner, in either direction: ownership transfer is a different act.
  assert.equal(canRemoveMember("admin", "owner", false), false);
  assert.equal(canRemoveMember("owner", "owner", false), false);
  // A plain member manages nobody.
  assert.equal(canRemoveMember("member", "member", false), false);
});

test("removing yourself is never offered, whatever your rank", () => {
  // Leaving is a separate action with its own confirmation. Offering Remove on
  // your own row is how an owner strands an organization by accident.
  assert.equal(canRemoveMember("owner", "owner", true), false);
  assert.equal(canRemoveMember("admin", "admin", true), false);
  assert.equal(canRemoveMember("member", "member", true), false);
});

const invite: InvitationDetail = {
  id: "inv-1",
  organizationId: "org-1",
  organizationName: "Acme",
  organizationSlug: "acme",
  inviterName: "A teammate",
  role: "member",
  email: "Invited@Example.com",
  expiresAt: new Date().toISOString(),
  problem: null,
};

test("the invited address is shown only to the person who was invited", () => {
  // Case-insensitively: the address was typed by a human into a form.
  assert.equal(viewable(invite, "invited@example.com"), true);
  assert.equal(viewable(invite, "INVITED@EXAMPLE.COM"), true);
  // Somebody else holding the link sees the organization, never the address.
  assert.equal(viewable(invite, "someone@else.com"), false);
  assert.equal(viewable(invite, null), false);
});

test("expiry beats status, because nothing sweeps a stale row", () => {
  const past = new Date(Date.now() - 60_000);
  const future = new Date(Date.now() + 60_000);

  assert.equal(invitationProblem("pending", future), null);
  // Still "pending" in the column, but no longer acceptable. Offering Accept
  // here is offering a button the server refuses a moment later.
  assert.equal(invitationProblem("pending", past), "expired");

  // A settled invitation stays settled whatever the clock says.
  assert.equal(invitationProblem("accepted", future), "accepted");
  assert.equal(invitationProblem("rejected", future), "rejected");
  assert.equal(invitationProblem("canceled", future), "canceled");
  // A status this build does not know is not treated as acceptable.
  assert.equal(invitationProblem("something-new", future), "unknown");
});

test("the roster reads owners first, then by display name", () => {
  const people = [
    { role: "member" as const, name: "Zoe", email: "z@x.com" },
    { role: "owner" as const, name: "Yusuf", email: "y@x.com" },
    { role: "member" as const, name: "Ada", email: "a@x.com" },
    { role: "admin" as const, name: "Wren", email: "w@x.com" },
  ];
  assert.deepEqual(byRankThenName(people).map((p) => p.name), ["Yusuf", "Wren", "Ada", "Zoe"]);
  // Somebody invited but never named sorts by the address instead of sinking
  // to the bottom as an empty string.
  const unnamed = [
    { role: "member" as const, name: "", email: "beth@x.com" },
    { role: "member" as const, name: "Ada", email: "a@x.com" },
  ];
  assert.deepEqual(byRankThenName(unnamed).map((p) => p.email), ["a@x.com", "beth@x.com"]);
  // The input is not reordered in place.
  assert.equal(people[0].name, "Zoe");
});
