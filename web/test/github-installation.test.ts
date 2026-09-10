import assert from "node:assert/strict";
import { test } from "node:test";
import { NextRequest } from "next/server";
import { githubInstallationHandlers } from "../src/lib/github-installation";

process.env.BETTER_AUTH_SECRET = "test-only-signing-key-for-installation-flow";
process.env.GITHUB_APP_SLUG = "test-app";
process.env.GITHUB_APP_CLIENT_ID = "test-client";
process.env.GITHUB_APP_CLIENT_SECRET = "test-secret";

function fixture() {
  const bindings: unknown[] = [];
  let organization: string | null = "org-one";
  let user: { id: string } | null = { id: "user-one" };
  let ids = ["123"];
  let failure: Error | null = null;
  let authorizations = 0;
  const handlers = githubInstallationHandlers({
    getUser: async () => user,
    getOrganization: async () => organization,
    authorize: async () => { authorizations++; return { login: "installer", installationIds: ids }; },
    bind: async (binding) => { if (failure) throw failure; bindings.push(binding); },
  });
  function request(path: string, cookie?: string) {
    return new NextRequest(`http://localhost:3000/api/github/${path}`, { headers: cookie ? { cookie } : {} });
  }
  async function start() {
    const response = await handlers.install(request("install"));
    return { cookie: response.headers.get("set-cookie")!.split(";")[0], state: location(response).searchParams.get("state")! };
  }
  return { handlers, request, start, bindings, setOrg: (v: string | null) => { organization = v; }, setUser: (v: { id: string } | null) => { user = v; }, setIds: (v: string[]) => { ids = v; }, setFailure: (v: Error) => { failure = v; }, authorized: () => authorizations };
}
function location(response: Response) { return new URL(response.headers.get("location")!); }
function error(response: Response) { return location(response).searchParams.get("error"); }

test("install uses random state and a scoped HttpOnly cookie", async () => {
  const f = fixture();
  const response = await f.handlers.install(f.request("install"));
  assert.equal(location(response).hostname, "github.com");
  assert.notEqual(location(response).searchParams.get("state"), "org-one");
  assert.match(response.headers.get("set-cookie")!, /HttpOnly/i);
  assert.match(response.headers.get("set-cookie")!, /SameSite=lax/i);
  assert.match(response.headers.get("set-cookie")!, /Path=\/api\/github/);
});

test("combined install and OAuth callback binds verified installation", async () => {
  const f = fixture(); const flow = await f.start();
  const response = await f.handlers.callback(f.request(`callback?installation_id=123&code=valid&state=${flow.state}`, flow.cookie));
  assert.equal(location(response).pathname, "/dashboard/repositories");
  assert.deepEqual(f.bindings, [{ installationId: "123", organizationId: "org-one", accountLogin: "installer" }]);
  assert.match(response.headers.get("set-cookie")!, /Max-Age=0/);
});

for (const route of ["callback", "installed"]) {
  test(`${route} without code completes separate OAuth even when GitHub omits installation_id`, async () => {
    const f = fixture(); const flow = await f.start();
    const first = await f.handlers.callback(f.request(`${route}?installation_id=123&state=${flow.state}`, flow.cookie));
    assert.equal(location(first).pathname, "/login/oauth/authorize");
    assert.equal(f.bindings.length, 0);
    const callback = location(first).searchParams.get("redirect_uri")!;
    assert.equal(callback, "http://localhost:3000/api/github/callback");
    const nextState = location(first).searchParams.get("state")!;
    assert.notEqual(nextState, flow.state);
    const cookie = first.headers.get("set-cookie")!.split(";")[0];
    const result = await f.handlers.callback(f.request(`callback?code=valid&state=${nextState}`, cookie));
    assert.equal(location(result).searchParams.get("github"), "installed");
    assert.equal(f.bindings.length, 1);
  });
}

test("GitHub-initiated setup starts verification but never binds by id alone", async () => {
  const f = fixture();
  const response = await f.handlers.callback(f.request("installed?installation_id=123"));
  assert.equal(location(response).pathname, "/login/oauth/authorize");
  assert.equal(f.bindings.length, 0);
});

for (const scenario of ["wrong-state", "missing-state", "wrong-user", "changed-organization", "tampered-cookie", "expired-cookie"]) {
  test(`rejects ${scenario} before code exchange`, async () => {
    const f = fixture(); const flow = await f.start();
    let state = flow.state; let cookie = flow.cookie;
    if (scenario === "wrong-state") state = "attacker";
    if (scenario === "missing-state") state = "";
    if (scenario === "wrong-user") f.setUser({ id: "other-user" });
    if (scenario === "changed-organization") f.setOrg("org-two");
    if (scenario === "tampered-cookie") cookie += "tampered";
    const originalNow = Date.now;
    if (scenario === "expired-cookie") Date.now = () => originalNow() + 11 * 60 * 1000;
    try {
      const response = await f.handlers.callback(f.request(`callback?installation_id=123&code=valid&state=${state}`, cookie));
      assert.equal(error(response), "install_expired");
      assert.equal(f.bindings.length, 0);
      assert.equal(f.authorized(), 0);
    } finally { Date.now = originalNow; }
  });
}

test("rejects a code callback without browser state", async () => {
  const f = fixture();
  assert.equal(error(await f.handlers.callback(f.request("callback?installation_id=123&code=valid&state=org-one"))), "install_expired");
  assert.equal(f.authorized(), 0);
});

test("rejects installations not confirmed by GitHub", async () => {
  const f = fixture(); const flow = await f.start(); f.setIds(["456"]);
  assert.equal(error(await f.handlers.callback(f.request(`callback?installation_id=123&code=valid&state=${flow.state}`, flow.cookie))), "install_forbidden");
  assert.equal(f.bindings.length, 0);
});

test("rejects installation substitution during OAuth", async () => {
  const f = fixture();
  const response = await f.handlers.callback(f.request("installed?installation_id=123"));
  const state = location(response).searchParams.get("state")!;
  const cookie = response.headers.get("set-cookie")!.split(";")[0];
  assert.equal(error(await f.handlers.callback(f.request(`callback?installation_id=456&code=valid&state=${state}`, cookie))), "install_forbidden");
  assert.equal(f.authorized(), 0);
});

test("missing OAuth config fails before sending user to install again", async () => {
  const f = fixture(); const secret = process.env.GITHUB_APP_CLIENT_SECRET;
  delete process.env.GITHUB_APP_CLIENT_SECRET;
  try {
    assert.equal(error(await f.handlers.install(f.request("install"))), "install_unverifiable");
    assert.equal(error(await f.handlers.callback(f.request("installed?installation_id=123"))), "install_unverifiable");
  } finally { process.env.GITHUB_APP_CLIENT_SECRET = secret; }
});

test("signed out or missing organization cannot bind", async () => {
  const f = fixture(); f.setUser(null);
  assert.equal(location(await f.handlers.callback(f.request("callback?installation_id=123"))).pathname, "/login");
  f.setUser({ id: "user-one" }); f.setOrg(null);
  assert.equal(location(await f.handlers.install(f.request("install?organizationId=untrusted"))).pathname, "/onboarding");
});

test("cancellation and pending owner approval do not bind", async () => {
  const f = fixture();
  assert.equal(error(await f.handlers.callback(f.request("callback?error=access_denied"))), "install_cancelled");
  assert.equal(location(await f.handlers.callback(f.request("installed?setup_action=request"))).searchParams.get("github"), "requested");
  assert.equal(f.bindings.length, 0);
});

test("binding conflict remains distinct from a transport error", async () => {
  const f = fixture(); const flow = await f.start();
  f.setFailure(new Error("already bound"));
  assert.equal(error(await f.handlers.callback(f.request(`callback?installation_id=123&code=valid&state=${flow.state}`, flow.cookie))), "install_owned");
});
