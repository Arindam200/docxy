import assert from "node:assert/strict";
import { test } from "node:test";
import { composioHandlers } from "../src/lib/composio-handlers";
import { composioUserId, type IntegrationAccount, type IntegrationScope } from "../src/lib/composio-contract";

function fixture() {
  let scope: IntegrationScope | null = { organizationId: "org-one", canManage: true };
  let configured = true;
  let failure = false;
  let url = "https://connect.composio.dev/link/test";
  const connects: string[][] = [];
  const deletes: string[] = [];
  const reads: string[] = [];
  const accounts: IntegrationAccount[] = [{ id: "ca-one", toolkit: "slack", status: "ACTIVE", active: true }];
  const handler = composioHandlers({
    configured: () => configured,
    appUrl: () => "https://docxy.test",
    scope: async () => scope,
    list: async (org) => { reads.push(org); return accounts; },
    connect: async (org, toolkit, callback) => {
      connects.push([org, toolkit, callback]);
      if (failure) throw new Error("secret-provider-response");
      return url;
    },
    disconnect: async (id) => { deletes.push(id); },
  });
  function request(fields: Record<string, string> = {}, origin = "https://docxy.test") {
    const body = new FormData();
    for (const [key, value] of Object.entries({ organizationId: "org-one", toolkit: "slack", action: "connect", ...fields })) {
      body.set(key, value);
    }
    return new Request("https://internal-host/api/integrations/composio", { method: "POST", headers: { origin }, body });
  }
  return { handler, request, connects, deletes, reads,
    setScope: (value: IntegrationScope | null) => { scope = value; },
    disable: () => { configured = false; },
    fail: () => { failure = true; },
    setUrl: (value: string) => { url = value; },
  };
}

test("connection is scoped to the authenticated organization with a configured callback origin", async () => {
  const f = fixture();
  const response = await f.handler.POST(f.request({ userId: "attacker", callbackUrl: "https://evil.test" }));
  assert.equal(response.status, 200);
  assert.deepEqual(f.connects, [["org-one", "slack", "https://docxy.test/dashboard/integrations"]]);
  assert.deepEqual(await response.json(), { redirectUrl: "https://connect.composio.dev/link/test" });
  assert.equal(response.headers.get("cache-control"), "no-store");
});

for (const scenario of ["signed-out", "member", "removed", "wrong-origin", "missing-origin", "changed-org", "missing-key", "unknown-toolkit", "unknown-action"]) {
  test(`rejects ${scenario} before contacting Composio`, async () => {
    const f = fixture();
    let status = 403;
    let origin = "https://docxy.test";
    const fields: Record<string, string> = {};
    if (scenario === "signed-out" || scenario === "removed") { f.setScope(null); status = 401; }
    if (scenario === "member") f.setScope({ organizationId: "org-one", canManage: false });
    if (scenario === "wrong-origin") origin = "https://evil.test";
    if (scenario === "missing-origin") origin = "";
    if (scenario === "changed-org") { fields.organizationId = "org-two"; status = 409; }
    if (scenario === "missing-key") { f.disable(); status = 503; }
    if (scenario === "unknown-toolkit") { fields.toolkit = "github"; status = 400; }
    if (scenario === "unknown-action") { fields.action = "execute"; status = 400; }
    assert.equal((await f.handler.POST(f.request(fields, origin))).status, status);
    assert.equal(f.connects.length + f.deletes.length + f.reads.length, 0);
  });
}

test("disconnect checks account ownership and toolkit before deleting", async () => {
  const f = fixture();
  for (const fields of [{ accountId: "ca-other-org", toolkit: "slack" }, { accountId: "ca-one", toolkit: "notion" }]) {
    assert.equal((await f.handler.POST(f.request({ action: "disconnect", ...fields }))).status, 404);
  }
  assert.deepEqual(f.deletes, []);
  assert.equal((await f.handler.POST(f.request({ action: "disconnect", accountId: "ca-one" }))).status, 200);
  assert.deepEqual(f.deletes, ["ca-one"]);
  assert.deepEqual(f.reads, ["org-one", "org-one", "org-one"]);
});

test("provider failures do not disclose raw errors", async () => {
  const f = fixture(); f.fail();
  const response = await f.handler.POST(f.request());
  assert.equal(response.status, 502);
  assert.doesNotMatch(await response.text(), /secret-provider-response/);
});

test("rejects connection links outside the hosted Composio flow", async () => {
  for (const url of ["https://evil.test/", "http://connect.composio.dev/", "javascript:alert(1)"]) {
    const f = fixture(); f.setUrl(url);
    assert.equal((await f.handler.POST(f.request())).status, 502);
  }
});

test("stable Composio identity cannot fall back to a shared demo user", () => {
  assert.equal(composioUserId("org-one"), "docxy:org:org-one");
  assert.notEqual(composioUserId("org-one"), composioUserId("org-two"));
  assert.throws(() => composioUserId(""));
});
