import assert from "node:assert/strict";
import { test } from "node:test";
import { needsDocsPercent, queuedNotice, skipLabel, undocumented } from "../src/lib/skips";
import type { RunSummary, SkippedCommit } from "../src/lib/docxy";

const skip = (id: string, sha: string, at: string, kind: SkippedCommit["kind"] = "triage"): SkippedCommit => ({
  id,
  projectId: "p1",
  commit: { sha, shortSha: sha.slice(0, 7), subject: "Tidy the tests" },
  kind,
  reason: "Jev rated this test-only commit 4% likely to need documentation.",
  at,
});
const run = (sha: string): RunSummary => ({ id: `run-${sha}`, repoPath: "/checkouts/team__repo", startedAt: "2026-09-10", status: "running", commit: { sha, shortSha: sha.slice(0, 7), subject: "Tidy the tests" } });

test("every kind the contract names has its own badge", () => {
  assert.equal(skipLabel("triage"), "Triage");
  assert.equal(skipLabel("allowance"), "Allowance");
  assert.equal(skipLabel("automatic-runs"), "Automatic runs");
  assert.equal(skipLabel("access"), "Access");
});

test("a kind from a newer server shows as itself rather than as nothing", () => {
  assert.equal(skipLabel("maintenance"), "maintenance");
  // Not a key of the map either, however it looks to `in`.
  assert.equal(skipLabel("toString"), "toString");
});

test("the needs-docs figure is triage's own, rounded as the reason sentence rounds it", () => {
  const triaged = { ...skip("s1", "aaaaaaaa1", "2026-09-09"), triage: { needsDocs: 0.044, surface: "test-only", surfaceConfidence: 0.97, model: "jev-1" } };
  assert.equal(needsDocsPercent(triaged), "4%");
  assert.equal(needsDocsPercent({ ...triaged, triage: { ...triaged.triage, needsDocs: 0.125 } }), "13%");
  // Triage never saw these, so there is no figure to show.
  assert.equal(needsDocsPercent(skip("s2", "bbbbbbbb2", "2026-09-09", "allowance")), undefined);
  // A triage skip from a server that did not record the answer.
  assert.equal(needsDocsPercent(skip("s3", "cccccccc3", "2026-09-09")), undefined);
});

test("a skipped commit that has since run is no longer listed", () => {
  const skipped = [skip("s1", "aaaaaaaa1", "2026-09-09"), skip("s2", "bbbbbbbb2", "2026-09-08")];
  assert.deepEqual(undocumented(skipped, [run("aaaaaaaa1")]).map((entry) => entry.id), ["s2"]);
  assert.deepEqual(undocumented(skipped, []).map((entry) => entry.id), ["s1", "s2"]);
});

test("a redelivered push is one row, the newest decision, and rows read newest first", () => {
  const skipped = [
    skip("older", "aaaaaaaa1", "2026-09-01", "triage"),
    skip("other", "bbbbbbbb2", "2026-09-05"),
    skip("newer", "aaaaaaaa1", "2026-09-09", "allowance"),
  ];
  assert.deepEqual(undocumented(skipped, []).map((entry) => entry.id), ["newer", "other"]);
  // The input is left as it came.
  assert.equal(skipped[0].id, "older");
});

test("the toast mentions a queue position only when the run is waiting in one", () => {
  assert.equal(queuedNotice("abc1234", { queued: false, depth: 0 }), "Queued abc1234. Its run is starting now.");
  assert.equal(queuedNotice("abc1234", { queued: true, depth: 2 }), "Queued abc1234, position 2 in the queue.");
  // Already in hand: queued, with nothing waiting to be a position behind.
  assert.equal(queuedNotice("abc1234", { queued: true, depth: 0 }), "Queued abc1234.");
});
