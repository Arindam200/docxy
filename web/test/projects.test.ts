import assert from "node:assert/strict";
import { test } from "node:test";
import { projectRuns } from "../src/lib/projects";
import type { RunSummary } from "../src/lib/docxy";

test("project activity includes only the exact checkout and sorts newest first", () => {
  const make = (id: string, repoPath: string, startedAt: string): RunSummary => ({ id, repoPath, startedAt, status: "done", commit: { sha: id, shortSha: id, subject: "Test run" } });
  const runs = [make("older", "/checkouts/team__repo", "2026-09-01"), make("other", "/checkouts/other__repo", "2026-09-09"), make("newer", "/checkouts/team__repo", "2026-09-08"), make("nested", "/checkouts/team__repo/nested", "2026-09-09")];
  assert.deepEqual(projectRuns({ key: "/checkouts/team__repo" }, runs).map((run) => run.id), ["newer", "older"]);
  assert.equal(runs[0].id, "older");
  assert.deepEqual(projectRuns({ key: "/unknown" }, runs), []);
});
