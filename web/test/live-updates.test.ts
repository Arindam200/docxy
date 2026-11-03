import assert from "node:assert/strict";
import { test } from "node:test";
import { BUSY_MS, GAP_MS, concernsPage, refreshOnOpen } from "../src/lib/live-updates";

const project = { repoPath: "/data/checkouts/acme/api", repository: "acme/api" };
const run = (id: string, repoPath: string) => JSON.stringify({ id, repoPath, status: "running" });

test("another project's run does not re-render a project page", () => {
  assert.equal(concernsPage("run", run("r1", "/data/checkouts/acme/web"), project), false);
  assert.equal(concernsPage("run", run("r1", project.repoPath), project), true);
});

test("a run page re-renders for its own run only", () => {
  const scope = { ...project, runId: "r1" };
  assert.equal(concernsPage("run", run("r1", project.repoPath), scope), true);
  // Same project, different run: nothing on this page changes.
  assert.equal(concernsPage("run", run("r2", project.repoPath), scope), false);
});

test("a push to another repository is ignored, whatever its case", () => {
  const push = (repository: string) => JSON.stringify({ delivery: "d", commit: "c", repository });
  assert.equal(concernsPage("webhook", push("acme/web"), project), false);
  assert.equal(concernsPage("webhook", push("ACME/Api"), project), true);
});

test("the organization page hears everything", () => {
  assert.equal(concernsPage("run", run("r1", "/anywhere"), {}), true);
  assert.equal(concernsPage("webhook", JSON.stringify({ repository: "acme/web" }), {}), true);
});

test("events that name no project count as possibly this one's", () => {
  // Queue depth and skipped deliveries carry no repository at all, so nothing
  // proves they belong elsewhere.
  assert.equal(concernsPage("queue", JSON.stringify({ depth: 1 }), project), true);
  assert.equal(concernsPage("skipped", JSON.stringify({ commit: "c" }), project), true);
});

test("a body that will not parse refreshes, which is the safe direction", () => {
  assert.equal(concernsPage("run", "not json", { ...project, runId: "r1" }), true);
  assert.equal(concernsPage("webhook", "not json", project), true);
});

test("the scheduled reconnect on a quiet feed does not refresh", () => {
  // The proxy closes every stream before a minute is up; a page nobody's runs
  // touched should not re-render each time it does.
  assert.equal(refreshOnOpen(800, undefined), false);
  assert.equal(refreshOnOpen(800, BUSY_MS + 1), false);
});

test("the first connection after a fresh render does not refresh", () => {
  assert.equal(refreshOnOpen(300, undefined), false);
});

test("a long gap refreshes, because anything could have happened in it", () => {
  // A hidden tab coming back, or a Retry after the badge went offline.
  assert.equal(refreshOnOpen(GAP_MS + 1, undefined), true);
  assert.equal(refreshOnOpen(10 * 60_000, BUSY_MS * 2), true);
});

test("a short gap in a busy feed refreshes, in case the last event fell into it", () => {
  assert.equal(refreshOnOpen(800, 30_000), true);
  // A page drawn with a run in flight counts as busy from the start.
  assert.equal(refreshOnOpen(300, 300), true);
});
