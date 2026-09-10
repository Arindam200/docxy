import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveOrganization } from "../src/lib/onboarding";
import { repositoryStatus } from "../src/lib/repositories";

const orgs = [{ id: "org-one" }, { id: "org-two" }];

test("a session naming an organization the account is in is left alone", () => {
  assert.deepEqual(resolveOrganization(orgs, "org-two"), {
    kind: "ready",
    activeOrganizationId: "org-two",
  });
});

test("no memberships is the only case that offers to create one", () => {
  assert.deepEqual(resolveOrganization([], null), { kind: "create" });
  // Even with a session id left over from an organization that is gone: there
  // is nothing to activate, so the form is the honest answer.
  assert.deepEqual(resolveOrganization([], "org-deleted"), { kind: "create" });
});

test("memberships the session does not name are repaired, not re-onboarded", () => {
  // Signed in before joining: the id is stamped on at session creation, so it
  // is still null. Offering to create a second organization here was the bug.
  assert.deepEqual(resolveOrganization(orgs, null), {
    kind: "activate",
    organizationId: "org-one",
  });
  // Left or deleted since: the id resolves to nothing. Sending this account to
  // the dashboard, which sends it back, was the loop.
  assert.deepEqual(resolveOrganization(orgs, "org-gone"), {
    kind: "activate",
    organizationId: "org-one",
  });
});

test("a repository is monitored only when a project connects it", () => {
  assert.equal(repositoryStatus({ allowed: true, connected: true }), "monitored");
  // The ordinary case after an "All repositories" install: access, no project.
  assert.equal(repositoryStatus({ allowed: false, connected: false }), "available");
  // Connected but refused can only be DOCXY_ALLOWED_REPOS, and telling somebody
  // to connect a project they already connected would help nobody.
  assert.equal(repositoryStatus({ allowed: false, connected: true }), "excluded");
});
