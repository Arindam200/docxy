import assert from "node:assert/strict";
import { test } from "node:test";
import { NextRequest } from "next/server";
import { administersAccount, authorizeInstaller, type InstallerVerdict } from "../src/lib/github-app";
import { githubInstallationHandlers } from "../src/lib/github-installation";
import type { OrganizationRole } from "../src/lib/members";
import { safeNext } from "../src/lib/redirect";

process.env.BETTER_AUTH_SECRET = "test-only-signing-key-for-installation-flow";
process.env.GITHUB_APP_SLUG = "test-app";
process.env.GITHUB_APP_CLIENT_ID = "test-client";
process.env.GITHUB_APP_CLIENT_SECRET = "test-secret";

function fixture() {
  const bindings: unknown[] = [];
  let organization: string | null = "org-one";
  let user: { id: string } | null = { id: "user-one" };
  let verdict: InstallerVerdict = { kind: "administers", accountLogin: "acme" };
  let role: OrganizationRole | null = "owner";
  let failure: Error | null = null;
  let authorizations = 0;
  const asked: string[] = [];
  const handlers = githubInstallationHandlers({
    getUser: async () => user,
    getOrganization: async () => organization,
    getRole: async () => role,
    authorize: async (_code, installationId) => { authorizations++; asked.push(installationId); return verdict; },
    bind: async (binding) => { if (failure) throw failure; bindings.push(binding); },
  });
  function request(path: string, cookie?: string) {
    return new NextRequest(`http://localhost:3000/api/github/${path}`, { headers: cookie ? { cookie } : {} });
  }
  async function start() {
    const response = await handlers.install(request("install"));
    return { cookie: response.headers.get("set-cookie")!.split(";")[0], state: location(response).searchParams.get("state")! };
  }
  return { handlers, request, start, bindings, asked, setOrg: (v: string | null) => { organization = v; }, setUser: (v: { id: string } | null) => { user = v; }, setVerdict: (v: InstallerVerdict) => { verdict = v; }, setRole: (v: OrganizationRole | null) => { role = v; }, setFailure: (v: Error) => { failure = v; }, authorized: () => authorizations };
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
  // The account the App is installed on (an organization here), not the
  // person who installed it: the pipeline scopes repositories by owner.
  assert.deepEqual(f.bindings, [{ installationId: "123", organizationId: "org-one", accountLogin: "acme" }]);
  // GitHub is asked about the installation being bound, not about any other.
  assert.deepEqual(f.asked, ["123"]);
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
  const f = fixture(); const flow = await f.start(); f.setVerdict({ kind: "unverified" });
  assert.equal(error(await f.handlers.callback(f.request(`callback?installation_id=123&code=valid&state=${flow.state}`, flow.cookie))), "install_forbidden");
  assert.equal(f.bindings.length, 0);
});

test("seeing an installation is not administering it", async () => {
  // A read-only collaborator on one repository can see the organization's
  // installation in /user/installations. That must not let them claim it.
  const f = fixture(); const flow = await f.start(); f.setVerdict({ kind: "not-admin" });
  assert.equal(error(await f.handlers.callback(f.request(`callback?installation_id=123&code=valid&state=${flow.state}`, flow.cookie))), "install_forbidden");
  assert.equal(f.bindings.length, 0);
});

test("a membership GitHub will not disclose is refused, with its own explanation", async () => {
  const f = fixture(); const flow = await f.start(); f.setVerdict({ kind: "membership-hidden" });
  assert.equal(error(await f.handlers.callback(f.request(`callback?installation_id=123&code=valid&state=${flow.state}`, flow.cookie))), "install_membership_hidden");
  assert.equal(f.bindings.length, 0);
});

test("only owners and admins of the Docxy organization may bind an installation", async () => {
  const f = fixture(); const flow = await f.start();
  for (const role of ["member", null] as const) {
    f.setRole(role);
    assert.equal(error(await f.handlers.install(f.request("install"))), "install_role", String(role));
    assert.equal(error(await f.handlers.callback(f.request("installed?installation_id=123"))), "install_role", String(role));
    assert.equal(error(await f.handlers.callback(f.request(`callback?installation_id=123&code=valid&state=${flow.state}`, flow.cookie))), "install_role", String(role));
  }
  assert.equal(f.authorized(), 0);
  assert.equal(f.bindings.length, 0);
  f.setRole("admin");
  assert.equal(location(await f.handlers.install(f.request("install"))).hostname, "github.com");
});

test("a signed-out return from GitHub resumes the install after sign-in", async () => {
  const f = fixture(); f.setUser(null);
  const response = await f.handlers.callback(f.request("installed?installation_id=123&setup_action=install"));
  assert.equal(location(response).pathname, "/login");
  const next = location(response).searchParams.get("next")!;
  assert.equal(next, "/api/github/installed?installation_id=123");
  // The login page passes `next` through safeNext; it has to survive intact.
  assert.equal(safeNext(next), next);
  // Only the id travels. Resuming starts OAuth afresh rather than trusting it.
  f.setUser({ id: "user-one" });
  const resumed = await f.handlers.callback(f.request(next.replace("/api/github/", "")));
  assert.equal(location(resumed).pathname, "/login/oauth/authorize");
  assert.equal(f.bindings.length, 0);
});

test("a signed-out return with nothing to resume goes to the dashboard after sign-in", async () => {
  const f = fixture(); f.setUser(null);
  for (const query of ["installation_id=abc", "installation_id=123&setup_action=request", "error=access_denied", ""]) {
    const response = await f.handlers.callback(f.request(`installed?${query}`));
    assert.equal(location(response).searchParams.get("next"), "/dashboard", query);
  }
});

test("administering an account: the person themselves, or an active organization owner", () => {
  const person = { id: 7, login: "ada", type: "User" };
  const org = { id: 9, login: "acme", type: "Organization" };
  assert.equal(administersAccount(person, 7, null), true);
  // Compared by id: a login can be renamed and then claimed by somebody else.
  assert.equal(administersAccount(person, 8, null), false);
  assert.equal(administersAccount(org, 7, { role: "admin", state: "active" }), true);
  assert.equal(administersAccount(org, 7, { role: "admin", state: "pending" }), false);
  assert.equal(administersAccount(org, 7, { role: "member", state: "active" }), false);
  assert.equal(administersAccount(org, 7, null), false);
  assert.equal(administersAccount({ id: 9, login: "big", type: "Enterprise" }, 7, { role: "admin", state: "active" }), false);
});

/** GitHub, as far as `authorizeInstaller` talks to it. */
function fakeGitHub(account: { id: number; login: string; type: string }, membership: Response) {
  const original = globalThis.fetch;
  const requested: string[] = [];
  globalThis.fetch = async (input: RequestInfo | URL) => {
    const url = String(input);
    requested.push(url);
    if (url.endsWith("/login/oauth/access_token")) return Response.json({ access_token: "token" });
    if (url.endsWith("/user")) return Response.json({ id: 7, login: "ada" });
    if (url.includes("/user/installations")) {
      return Response.json({ installations: [{ id: 99, account: { id: 1, login: "other", type: "User" } }, { id: 123, account }] });
    }
    if (url.includes("/user/memberships/orgs/")) return membership;
    return new Response("not found", { status: 404 });
  };
  return { requested, restore: () => { globalThis.fetch = original; } };
}

test("authorizeInstaller asks GitHub who administers the installation's account", async () => {
  const acme = { id: 9, login: "acme", type: "Organization" };
  const cases: Array<[string, { id: number; login: string; type: string }, Response, InstallerVerdict]> = [
    ["organization owner", acme, Response.json({ role: "admin", state: "active" }), { kind: "administers", accountLogin: "acme" }],
    ["read-only collaborator", acme, Response.json({ role: "member", state: "active" }), { kind: "not-admin" }],
    ["outside collaborator", acme, new Response("", { status: 404 }), { kind: "not-admin" }],
    ["membership not readable", acme, new Response("", { status: 403 }), { kind: "membership-hidden" }],
    ["GitHub failing", acme, new Response("", { status: 502 }), { kind: "unverified" }],
    ["their own account", { id: 7, login: "ada", type: "User" }, new Response("", { status: 500 }), { kind: "administers", accountLogin: "ada" }],
    ["somebody else's account", { id: 8, login: "bob", type: "User" }, new Response("", { status: 500 }), { kind: "not-admin" }],
  ];
  for (const [name, account, membership, expected] of cases) {
    const github = fakeGitHub(account, membership);
    try {
      assert.deepEqual(await authorizeInstaller("code", "123"), expected, name);
      // A personal account is never looked up as an organization.
      assert.equal(github.requested.some((url) => url.includes("/memberships/")), account.type === "Organization", name);
    } finally { github.restore(); }
  }
  const github = fakeGitHub(acme, Response.json({ role: "admin", state: "active" }));
  try {
    // An installation the person cannot reach at all is not theirs to bind.
    assert.deepEqual(await authorizeInstaller("code", "456"), { kind: "unverified" });
  } finally { github.restore(); }
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

test("an install made before the account had an organization survives onboarding", async () => {
  const f = fixture();
  f.setOrg(null);
  const parked = await f.handlers.callback(f.request("installed?installation_id=123&setup_action=install"));
  assert.equal(location(parked).pathname, "/onboarding");
  assert.equal(location(parked).searchParams.get("installation_id"), "123");
  assert.equal(f.bindings.length, 0);

  // Onboarding creates the organization and hands the id to the install step,
  // which goes to verification for that installation instead of a new install.
  f.setOrg("org-one");
  const resumed = await f.handlers.install(f.request("install?organizationId=org-one&installation_id=123"));
  assert.equal(location(resumed).pathname, "/login/oauth/authorize");
  const cookie = resumed.headers.get("set-cookie")!.split(";")[0];
  const state = location(resumed).searchParams.get("state")!;
  const bound = await f.handlers.callback(f.request(`callback?code=valid&state=${state}`, cookie));
  assert.equal(location(bound).searchParams.get("github"), "installed");
  assert.deepEqual(f.asked, ["123"], "the carried id is still verified with GitHub");
  assert.equal(f.bindings.length, 1);
});

test("onboarding is not handed anything but an installation id", async () => {
  const f = fixture();
  f.setOrg(null);
  for (const query of ["installation_id=12x", "installation_id=123&setup_action=request", "installation_id=123&error=access_denied"]) {
    const response = await f.handlers.callback(f.request(`installed?${query}`));
    assert.equal(location(response).pathname, "/onboarding");
    assert.equal(location(response).search, "", query);
  }
  f.setOrg("org-one");
  const plain = await f.handlers.install(f.request("install?installation_id=..%2Fevil"));
  assert.equal(location(plain).pathname, "/apps/test-app/installations/new");
});
