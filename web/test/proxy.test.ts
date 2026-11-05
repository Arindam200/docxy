import assert from "node:assert/strict";
import { test } from "node:test";
import { NextRequest } from "next/server";
import { GET, POST } from "../src/app/api/docxy/[...path]/route";

// Auth off, so the path check is the only thing between the request and the
// upstream fetch - which is exactly the check under test. Read per request.
process.env.DOCXY_REQUIRE_AUTH = "0";

function upstreamCalls(): string[] {
  const calls: string[] = [];
  globalThis.fetch = async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
  };
  return calls;
}

test("an encoded path never reaches upstream, where it would decode to a scoped route", async () => {
  const calls = upstreamCalls();
  for (const path of ["/api/docxy/%72uns", "/api/docxy/%6cogs", "/api/docxy/run%73/x/publish", "/api/docxy/%69nstallations"]) {
    const response = await GET(new NextRequest(`https://docxy.app${path}?organizationId=VICTIM`));
    assert.equal(response.status, 400, path);
  }
  const write = await POST(
    new NextRequest("https://docxy.app/api/docxy/%69nstallations?organizationId=MINE", {
      method: "POST",
      body: JSON.stringify({ installationId: 1 }),
    }),
  );
  assert.equal(write.status, 400);
  assert.deepEqual(calls, []);
});

test("an ordinary path is still forwarded", async () => {
  const calls = upstreamCalls();
  const response = await GET(new NextRequest("https://docxy.app/api/docxy/config"));
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /\/api\/config$/);
});
