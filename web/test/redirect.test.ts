import assert from "node:assert/strict";
import { test } from "node:test";
import { safeNext } from "../src/lib/redirect";

test("plain in-app paths are kept, with their query and hash", () => {
  assert.equal(safeNext("/dashboard/projects?tab=runs#latest"), "/dashboard/projects?tab=runs#latest");
  assert.equal(safeNext("/dashboard/a/../b"), "/dashboard/b");
});

test("protocol-relative and absolute targets fall back", () => {
  for (const value of ["//evil.com", "/\\evil.com", "https://evil.com", "evil.com", "", undefined]) {
    assert.equal(safeNext(value), "/dashboard", String(value));
  }
});

test("dot segments that resolve to a protocol-relative path fall back", () => {
  // Each passes the first-character test and resolves to `//evil.com`, which a
  // redirect reads as a host.
  for (const value of ["/.//evil.com", "/a/..//evil.com", "/%2e//evil.com", "/./\\evil.com"]) {
    assert.equal(safeNext(value), "/dashboard", value);
  }
});
