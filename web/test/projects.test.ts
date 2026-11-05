import assert from "node:assert/strict";
import { test } from "node:test";
import { projectRuns, projectStats, rollUp } from "../src/lib/projects";
import type { RunSummary } from "../src/lib/docxy";

test("project activity includes only the exact checkout and sorts newest first", () => {
  const make = (id: string, repoPath: string, startedAt: string): RunSummary => ({ id, repoPath, startedAt, status: "done", commit: { sha: id, shortSha: id, subject: "Test run" } });
  const runs = [make("older", "/checkouts/team__repo", "2026-09-01"), make("other", "/checkouts/other__repo", "2026-09-09"), make("newer", "/checkouts/team__repo", "2026-09-08"), make("nested", "/checkouts/team__repo/nested", "2026-09-09")];
  assert.deepEqual(projectRuns({ key: "/checkouts/team__repo" }, runs).map((run) => run.id), ["newer", "older"]);
  assert.equal(runs[0].id, "older");
  assert.deepEqual(projectRuns({ key: "/unknown" }, runs), []);
});

const run = (id: string, repoPath: string, startedAt: string, status: RunSummary["status"] = "done"): RunSummary => ({ id, repoPath, startedAt, status, commit: { sha: id, shortSha: id, subject: "Test run" } });
const busy = { id: "busy", key: "/checkouts/team__busy" };
const quiet = { id: "quiet", key: "/checkouts/team__quiet" };

test("cards use the API's rollups even where the organization-wide listing disagrees", () => {
  // The bug the rollups fix: the quiet project fell out of the shared window,
  // so the listing alone says it never ran.
  const listing = [run("b1", busy.key, "2026-09-09", "failed")];
  const latest = run("q1", quiet.key, "2026-08-01");
  const rollups = {
    rollups: [
      { projectId: "quiet", runs: 12, latest, successRate: 0.75, needsAttention: 3 },
      { projectId: "busy", runs: 50, latest: listing[0], successRate: 0.5, needsAttention: 25 },
    ],
  };
  const [busyStats, quietStats] = projectStats([busy, quiet], rollups, listing).map((entry) => entry.stats);
  assert.equal(quietStats.runs, 12);
  assert.equal(quietStats.latest?.id, "q1");
  assert.equal(quietStats.needsAttention, 3);
  assert.equal(busyStats.runs, 50);
});

test("without rollups, cards fall back to rolling up the listing as before", () => {
  const listing = [run("b2", busy.key, "2026-09-09", "failed"), run("b1", busy.key, "2026-09-08")];
  const entries = projectStats([busy, quiet], null, listing);
  assert.deepEqual(entries.map((entry) => entry.project), [busy, quiet]);
  assert.deepEqual(entries[0].stats, rollUp(projectRuns(busy, listing)));
  assert.equal(entries[0].stats.latest?.id, "b2");
  assert.equal(entries[0].stats.successRate, 0.5);
  assert.equal(entries[0].stats.needsAttention, 1);
  assert.deepEqual(entries[1].stats, { runs: 0, latest: undefined, successRate: undefined, costUsd: undefined, needsAttention: 0 });
});

test("a project the rollups leave out has not run, whatever the listing says", () => {
  // One source per render: half a grid from each window would sort in an
  // order neither agrees with.
  const listing = [run("q1", quiet.key, "2026-09-09")];
  const rollups = { rollups: [{ projectId: "busy", runs: 1, needsAttention: 0 }] };
  const [, quietStats] = projectStats([busy, quiet], rollups, listing).map((entry) => entry.stats);
  assert.equal(quietStats.runs, 0);
  assert.equal(quietStats.latest, undefined);
});
