import assert from "node:assert/strict";
import { test } from "node:test";
import { STALE_ORGANIZATION, staleWrite } from "../src/lib/organization-guard";

test("a write from a page drawn for another organization is stale", () => {
  // The tab was rendered for org-a; the session has since moved to org-b in
  // another tab. Writing anyway would land org-a's edit in org-b.
  assert.equal(staleWrite("PUT", "org-a", "org-b"), true);
  assert.equal(staleWrite("POST", "org-a", "org-b"), true);
  assert.equal(staleWrite("DELETE", "org-a", "org-b"), true);
});

test("a write from a page drawn for the session's organization goes through", () => {
  assert.equal(staleWrite("PUT", "org-a", "org-a"), false);
  assert.equal(staleWrite("POST", "org-a", "org-a"), false);
});

test("a write that names no organization is refused, not waved through", () => {
  // An optional check is one the next caller forgets to make.
  assert.equal(staleWrite("POST", null, "org-a"), true);
  assert.equal(staleWrite("PUT", "", "org-a"), true);
});

test("reads are never stale: they return the session's organization and render it", () => {
  assert.equal(staleWrite("GET", "org-a", "org-b"), false);
  assert.equal(staleWrite("HEAD", null, "org-b"), false);
});

test("the refusal says the same thing the integrations form does", () => {
  assert.equal(STALE_ORGANIZATION, "Your organization changed. Refresh this page and try again.");
});
