import assert from "node:assert/strict";
import { test } from "node:test";
import { managersOnly, writeAllowed } from "../src/lib/proxy-access";

test("reads are open to every member", () => {
  for (const path of ["/api/projects", "/api/instructions", "/api/runs/abc", "/api/installations"]) {
    assert.equal(managersOnly("GET", path), false, path);
    assert.equal(managersOnly("HEAD", path), false, path);
    assert.equal(writeAllowed("GET", path, "member"), true, path);
  }
});

test("starting a run and publishing one stay open to members", () => {
  for (const path of ["/api/projects/p-1/runs", "/api/runs", "/api/runs/r-1/publish"]) {
    assert.equal(managersOnly("POST", path), false, path);
    assert.equal(writeAllowed("POST", path, "member"), true, path);
  }
});

test("organization-shaping writes need an owner or admin", () => {
  const writes: Array<[string, string]> = [
    ["POST", "/api/projects"],
    ["DELETE", "/api/projects/p-1"],
    ["PUT", "/api/projects/p-1"],
    ["PUT", "/api/instructions"],
    ["POST", "/api/installations"],
  ];
  for (const [method, path] of writes) {
    assert.equal(writeAllowed(method, path, "member"), false, `${method} ${path}`);
    assert.equal(writeAllowed(method, path, null), false, `${method} ${path}`);
    assert.equal(writeAllowed(method, path, "admin"), true, `${method} ${path}`);
    assert.equal(writeAllowed(method, path, "owner"), true, `${method} ${path}`);
  }
});

test("a write nobody listed is for managers until somebody decides otherwise", () => {
  // A new upstream endpoint that slipped through open is the mistake this
  // rule exists to stop, so the default is closed.
  assert.equal(managersOnly("POST", "/api/projects/p-1/settings"), true);
  assert.equal(managersOnly("DELETE", "/api/runs/r-1"), true);
  // Only POST runs a project; another method on the same path does not.
  assert.equal(managersOnly("DELETE", "/api/projects/p-1/runs"), true);
  // The member paths match whole segments, not prefixes.
  assert.equal(managersOnly("POST", "/api/runs/r-1/publish/extra"), true);
  assert.equal(managersOnly("POST", "/api/projects/p-1/runs/x"), true);
});
