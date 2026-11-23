import { describe, expect, test } from "bun:test";
import { createOrg, getInstallation, listAudit, listProjects, listRepos, type Db } from "../src/db";
import {
  CLAIM_PATH,
  CLAIM_TTL_MS,
  ClaimError,
  InstallationClaims,
  CLAIM_COOKIE,
  CLAIM_START_PATH,
  CSRF_COOKIE,
  createClaimHandler,
  githubUserVerifier,
} from "../src/github/claim";
import { syncInstallation } from "../src/github/installations";
import { clientAddress, parseTrustedProxies } from "../src/github/trusted-proxies";
import { WEBHOOK_PATH, createWebhookHandler } from "../src/github/webhook";
import { Poller, MIN_NUDGE_GAP_MS } from "../src/poll/poller";
import { pollConfigSchema, parsePollConfig, readPollToken } from "../src/poll/config";
import {
  ENV_POLL_SOURCE,
  ENV_PROVIDER_SOURCE,
  resolvePollConfig,
  resolveProviderConfig,
  serveDefaults,
} from "../src/serve-config";
import { dispatch, registry } from "../src/ops";
import { mintToken } from "./ops-helpers";
import {
  WEBHOOK_SECRET,
  fakeFacts,
  fakeUserVerifier,
  inst,
  ownerOf100,
  repo,
  setup,
  sign,
  type FakeClaimUser,
} from "./github-helpers";
import { makeGithub } from "./github-stub";

describe("trusted proxies", () => {
  test("a list of addresses and ranges parses; garbage is an error, not a silent hole", () => {
    const t = parseTrustedProxies("10.0.0.0/8, 192.0.2.7, 2001:db8::/32, ::ffff:198.51.100.1");
    expect(t.empty).toBe(false);
    for (const ok of ["10.9.8.7", "192.0.2.7", "2001:db8:1::1", "198.51.100.1"])
      expect(t.isTrusted(ok)).toBe(true);
    for (const no of ["11.0.0.1", "192.0.2.8", "2001:db9::1", "not-an-ip", ""])
      expect(t.isTrusted(no)).toBe(false);
    expect(parseTrustedProxies(undefined).empty).toBe(true);
    for (const bad of ["10.0.0.0/33", "10.0.0.0/x", "300.1.1.1", "10.0.0.1/8/9", "hello"]) {
      expect(() => parseTrustedProxies(bad)).toThrow(/TURNTABLE_TRUSTED_PROXIES/);
    }
  });

  const h = (xff?: string) => new Headers(xff ? { "x-forwarded-for": xff } : {});
  const trusted = parseTrustedProxies("10.0.0.0/8");

  test("no trusted proxy, or an untrusted peer: the socket peer, whatever the header says", () => {
    expect(clientAddress(h("1.2.3.4"), "203.0.113.9", parseTrustedProxies(undefined))).toBe(
      "203.0.113.9",
    );
    expect(clientAddress(h("1.2.3.4"), "203.0.113.9", trusted)).toBe("203.0.113.9");
    expect(clientAddress(h("1.2.3.4"), undefined, trusted)).toBe("unknown");
  });

  test("a trusted peer: the right-most hop that is not itself a trusted proxy", () => {
    expect(clientAddress(h("198.51.100.1"), "10.0.0.2", trusted)).toBe("198.51.100.1");
    // a spoofed left entry is ignored: the client is the first untrusted hop from the right
    expect(clientAddress(h("6.6.6.6, 198.51.100.1, 10.0.0.9"), "10.0.0.2", trusted)).toBe(
      "198.51.100.1",
    );
    // every hop trusted, no header, or an unusable hop: fall back to the peer
    expect(clientAddress(h("10.1.1.1, 10.2.2.2"), "10.0.0.2", trusted)).toBe("10.0.0.2");
    expect(clientAddress(h(), "10.0.0.2", trusted)).toBe("10.0.0.2");
    expect(clientAddress(h("garbage, 10.0.0.9"), "10.0.0.2", trusted)).toBe("10.0.0.2");
  });

  async function limiterHarness(trustedProxies?: string) {
    const s = await setup();
    const f = fakeFacts();
    const handler = createWebhookHandler({
      db: s.db,
      store: s.store,
      facts: f.facts,
      maxFailures: 2,
      log: () => {},
      ...(trustedProxies ? { trustedProxies: parseTrustedProxies(trustedProxies) } : {}),
    });
    const bad = (xff: string, peer: string) =>
      handler.handle(
        new Request(`http://x${WEBHOOK_PATH}`, {
          method: "POST",
          headers: {
            "x-github-event": "ping",
            "x-github-delivery": crypto.randomUUID(),
            "x-hub-signature-256": sign("wrong", "{}"),
            "x-forwarded-for": xff,
          },
          body: "{}",
        }),
        peer,
      );
    return { bad };
  }

  test("webhook limiter: a spoofed X-Forwarded-For does not buy a fresh bucket from an untrusted peer", async () => {
    const { bad } = await limiterHarness();
    const statuses: number[] = [];
    for (const xff of ["1.1.1.1", "2.2.2.2", "3.3.3.3", "4.4.4.4"]) {
      statuses.push((await bad(xff, "203.0.113.9"))!.status);
    }
    expect(statuses).toEqual([401, 401, 429, 429]);
  });

  test("webhook limiter: behind a trusted proxy each real client has its own bucket", async () => {
    const { bad } = await limiterHarness("10.0.0.0/8");
    const a = [] as number[];
    for (let i = 0; i < 3; i++) a.push((await bad("198.51.100.1", "10.0.0.2"))!.status);
    expect(a).toEqual([401, 401, 429]);
    // a different client behind the same proxy is not locked out by it
    expect((await bad("198.51.100.2", "10.0.0.2"))!.status).toBe(401);
  });
});

describe("the installation claim flow", () => {
  async function harness() {
    const s = await setup();
    const tenantB = await createOrg(s.db, { slug: "tenant-b", name: "Tenant B" });
    const f = fakeFacts();
    f.installations.set("100", inst("100"));
    f.repos.set("100", [repo("1", "api")]);
    let now = 1_700_000_000_000;
    const claims = new InstallationClaims({ db: s.db, store: s.store, now: () => now });
    const users = new Map<string, FakeClaimUser>([["code-b", ownerOf100]]);
    const inner = fakeUserVerifier(users);
    const exchanges: string[] = [];
    const user = {
      verify: (code: string) => {
        exchanges.push(code);
        return inner.verify(code);
      },
    };
    const handler = createClaimHandler({ claims, facts: f.facts, user, log: () => {} });
    const stateOf = (url: string): string => new URL(url, "http://x").searchParams.get("state")!;
    const nonceOf = (state: string): string => {
      try {
        return JSON.parse(Buffer.from(state.split(".")[1] ?? "", "base64url").toString())
          .n as string;
      } catch {
        return "none";
      }
    };
    // The browser that confirmed on Turntable carries the cookie; pass cookie=null for one without.
    const callback = async (
      q: Record<string, string>,
      cookie?: string | null,
    ): Promise<Response> => {
      const nonce = cookie === undefined ? (q.state ? nonceOf(q.state) : "") : cookie;
      return (await handler.handle(
        new Request(`http://x${CLAIM_PATH}?${new URLSearchParams(q)}`, {
          headers: nonce ? { cookie: `${CLAIM_COOKIE}=${nonce}` } : {},
        }),
      ))!;
    };
    // Opens the confirmation page and returns what a browser would hold, then submits it.
    const open = async (url: string) => {
      const res = (await handler.handle(new Request(`http://x${url}`)))!;
      const html = res.status === 200 ? await res.clone().text() : "";
      const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";
      const token = /ls_claim_csrf=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1] ?? "";
      return { res, csrf, token };
    };
    const submit = async (
      state: string,
      o: { csrf?: string; token?: string; headers?: Record<string, string> } = {},
    ): Promise<Response> =>
      (await handler.handle(
        new Request(`http://x${CLAIM_START_PATH}`, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            ...(o.token ? { cookie: `${CSRF_COOKIE}=${o.token}` } : {}),
            ...(o.headers ?? { "sec-fetch-site": "same-origin" }),
          },
          body: new URLSearchParams({ state, csrf: o.csrf ?? "" }),
        }),
      ))!;
    return {
      ...s,
      open,
      submit,
      tenantB,
      f,
      claims,
      users,
      exchanges,
      handler,
      nonceOf,
      stateOf,
      callback,
      advance: (ms: number) => (now += ms),
    };
  }

  test("start gives a Turntable confirmation link; confirming sets the binding cookie and goes to GitHub; the happy path binds the installation to the claiming org", async () => {
    const h = await harness();
    const { url } = await h.claims.start(h.tenantB.id, "token:t1");
    expect(url.startsWith(`${CLAIM_START_PATH}?state=`)).toBe(true);
    const state = h.stateOf(url);
    // the page names the org that will receive the installation, and asks for a click
    const { res: page, csrf, token } = await h.open(url);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("tenant-b");
    expect(html).toContain('method="post"');
    expect(page.headers.get("content-security-policy")).toContain(
      "form-action 'self' https://github.com",
    );
    const csrfCookie = page.headers.get("set-cookie")!;
    for (const attr of ["HttpOnly", "Secure", "SameSite=Strict"])
      expect(csrfCookie).toContain(attr);
    // the click: cookie + redirect to GitHub
    const go = await h.submit(state, { csrf, token });
    expect(go.status).toBe(303);
    expect(
      go.headers
        .get("location")!
        .startsWith("https://github.com/apps/turntable-test/installations/new?state="),
    ).toBe(true);
    const cookie = go.headers.getSetCookie().find((c) => c.startsWith(`${CLAIM_COOKIE}=`))!;
    expect(cookie).toContain(`${CLAIM_COOKIE}=${h.nonceOf(state)}`);
    for (const attr of ["HttpOnly", "Secure", "SameSite=Lax", "Max-Age=900"]) {
      expect(cookie).toContain(attr);
    }
    const res = await h.callback({
      installation_id: "100",
      setup_action: "install",
      state,
      code: "code-b",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    // both cookies are cleared once the callback has used them
    const cleared = res.headers.getSetCookie();
    expect(cleared.some((c) => c.startsWith(`${CLAIM_COOKIE}=;`) && c.includes("Max-Age=0"))).toBe(
      true,
    );
    expect(cleared.some((c) => c.startsWith(`${CSRF_COOKIE}=;`) && c.includes("Max-Age=0"))).toBe(
      true,
    );
    const row = await getInstallation(h.db, "100");
    expect(row?.orgId).toBe(h.tenantB.id); // the claiming org, not the org that owns the App
    expect((await listProjects(h.db, { orgId: h.tenantB.id })).length).toBe(1);
    expect(await listProjects(h.db, { orgId: h.org.id })).toEqual([]);
    expect((await listRepos(h.db, { orgId: h.tenantB.id })).length).toBe(1);
    // the audit row says who claimed it on GitHub
    const rows = await listAudit(h.db, { orgId: h.tenantB.id });
    const claimRow = rows.find((r) => r.op === "claim_installation");
    expect(claimRow?.outcome).toBe("ok");
    expect(JSON.parse(claimRow!.input)).toMatchObject({
      github_user_id: "9",
      github_login: "owner-b",
      installation_id: "100",
      started_by: "token:t1",
    });
  });

  test("the confirmation page refuses a bad or used state and a POST without one", async () => {
    const h = await harness();
    const bad = await h.handler.handle(new Request(`http://x${CLAIM_START_PATH}?state=garbage`));
    expect(bad?.status).toBe(400);
    const post = await h.submit("garbage");
    expect(post.status).toBe(400);
    expect(post.headers.get("set-cookie")).toBeNull();
    // used state: the page is gone
    const { url } = await h.claims.start(h.tenantB.id, "token:t1");
    const state = h.stateOf(url);
    await h.callback({ installation_id: "100", setup_action: "install", state, code: "code-b" });
    expect((await h.handler.handle(new Request(`http://x${url}`)))?.status).toBe(400);
  });

  test("CSRF on the confirm POST: a cross-site POST is refused and sets no cookie", async () => {
    const h = await harness();
    const { url } = await h.claims.start(h.tenantB.id, "token:t1");
    const state = h.stateOf(url);
    const { csrf, token } = await h.open(url);
    const refusedHeaders = [
      { "sec-fetch-site": "cross-site" },
      { "sec-fetch-site": "same-site" },
      { "sec-fetch-site": "none" },
      { origin: "https://evil.example" },
      {}, // neither header: refuse
    ];
    for (const headers of refusedHeaders) {
      const r = await h.submit(state, { csrf, token, headers });
      expect(r.status).toBe(403);
      expect(r.headers.get("set-cookie")).toBeNull();
    }
    // an Origin equal to the instance origin is accepted when Sec-Fetch-Site is absent
    expect((await h.submit(state, { csrf, token, headers: { origin: "http://x" } })).status).toBe(
      303,
    );
  });

  test("CSRF on the confirm POST: a missing, forged or mismatched token is refused", async () => {
    const h = await harness();
    const a = await h.claims.start(h.tenantB.id, "token:t1");
    const b = await h.claims.start(h.tenantB.id, "token:t1");
    const sa = h.stateOf(a.url);
    const sb = h.stateOf(b.url);
    const pa = await h.open(a.url);
    const pb = await h.open(b.url);
    const same = { "sec-fetch-site": "same-origin" };
    expect((await h.submit(sa, { csrf: pa.csrf, headers: same })).status).toBe(403); // no cookie
    expect((await h.submit(sa, { token: pa.token, headers: same })).status).toBe(403); // no form value
    expect((await h.submit(sa, { csrf: "forged", token: pa.token, headers: same })).status).toBe(
      403,
    );
    // a token and mac minted for another claim's nonce do not work here
    expect((await h.submit(sa, { csrf: pb.csrf, token: pb.token, headers: same })).status).toBe(
      403,
    );
    expect((await h.submit(sa, { csrf: pa.csrf, token: pb.token, headers: same })).status).toBe(
      403,
    );
    expect((await h.submit(sa, { csrf: pa.csrf, token: pa.token, headers: same })).status).toBe(
      303,
    );
    expect(sb).not.toBe(sa);
  });

  test("CSRF: the callback needs the cookie of the browser that confirmed, and the right one", async () => {
    const h = await harness();
    const state = h.stateOf((await h.claims.start(h.tenantB.id, "token:t1")).url);
    const q = { installation_id: "100", setup_action: "install", state, code: "code-b" };
    expect((await h.callback(q, null)).status).toBe(403); // no cookie: a forwarded link
    expect((await h.callback(q, "someone-elses-nonce")).status).toBe(403);
    expect(await getInstallation(h.db, "100")).toBeUndefined();
    // refusals are audited, and did not burn the link
    const rows = await listAudit(h.db, { orgId: h.tenantB.id });
    expect(rows.some((r) => r.op === "claim_installation" && r.outcome.startsWith("error"))).toBe(
      true,
    );
    expect((await h.callback(q)).status).toBe(200);
  });

  test("takeover: access is not ownership. A plain org member, a pending admin and a different user are refused; the org admin and the personal account owner are accepted", async () => {
    const h = await harness();
    const acct = (login: string, type: string, id = "7") => [
      { id: "100", accountId: id, accountLogin: login, accountType: type },
    ];
    // a member sees the org's installation but is not an admin of it
    h.users.set("member", {
      id: "20",
      login: "member",
      installations: acct("acme", "Organization"),
      adminOf: [],
    });
    h.users.set("admin", {
      id: "21",
      login: "admin",
      installations: acct("acme", "Organization"),
      adminOf: ["acme"],
    });
    // a personal account: only the user it belongs to (account id == user id)
    h.users.set("stranger", {
      id: "30",
      login: "stranger",
      installations: acct("alice", "User", "31"),
      adminOf: ["alice"],
    });
    h.users.set("alice", {
      id: "31",
      login: "alice",
      installations: acct("alice", "User", "31"),
      adminOf: [],
    });
    const attempt = async (code: string, install = "100") => {
      const state = h.stateOf((await h.claims.start(h.tenantB.id, "token:t1")).url);
      return h.callback({ installation_id: install, setup_action: "install", state, code });
    };
    expect((await attempt("member")).status).toBe(403);
    expect((await attempt("stranger")).status).toBe(403);
    expect(await getInstallation(h.db, "100")).toBeUndefined();
    h.f.installations.set(
      "100",
      inst("100", "42", { account: { login: "alice", id: "31", type: "User" } }),
    );
    expect((await attempt("alice")).status).toBe(200);
    expect((await getInstallation(h.db, "100"))?.orgId).toBe(h.tenantB.id);
    // the org admin on a fresh installation
    h.f.installations.set("101", inst("101"));
    h.f.repos.set("101", [repo("5", "x")]);
    h.users.get("admin")!.installations = [
      { id: "101", accountId: "7", accountLogin: "acme", accountType: "Organization" },
    ];
    expect((await attempt("admin", "101")).status).toBe(200);
    const denied = (await listAudit(h.db, { orgId: h.tenantB.id })).filter((r) =>
      r.outcome.startsWith("error"),
    );
    expect(denied.length).toBe(2);
    expect(JSON.parse(denied[0]!.input)).toMatchObject({ github_login: expect.any(String) });
  });

  test("an expected GitHub login restricts who may complete the claim", async () => {
    const h = await harness();
    h.users.set("other", { ...ownerOf100, id: "50", login: "someone-else" });
    const { url } = await h.claims.start(h.tenantB.id, "token:t1", { expectedLogin: "Owner-B" });
    const state = h.stateOf(url);
    const q = { installation_id: "100", setup_action: "install", state };
    expect((await h.callback({ ...q, code: "other" })).status).toBe(403);
    expect(await getInstallation(h.db, "100")).toBeUndefined();
    expect((await h.callback({ ...q, code: "code-b" })).status).toBe(200); // case-insensitive match
  });

  describe("claiming an existing installation from its configure page", () => {
    // What GitHub's "Redirect on update" sends: no state, the cookie from the confirmation page.
    const configure = async (h: Awaited<ReturnType<typeof harness>>, installationId?: string) => {
      const { url } = await h.claims.start(h.tenantB.id, "token:t1", {
        ...(installationId ? { installationId } : {}),
      });
      const state = h.stateOf(url);
      const { csrf, token } = await h.open(url);
      const go = await h.submit(state, { csrf, token });
      return { state, go, nonce: h.nonceOf(state) };
    };
    const upd = { installation_id: "100", setup_action: "update", code: "code-b" };

    test("the confirm page sends the user to the installation's configure page", async () => {
      const h = await harness();
      const { go } = await configure(h, "100");
      expect(go.status).toBe(303);
      expect(go.headers.get("location")).toBe(
        "https://github.com/organizations/acme/settings/installations/100",
      );
      h.f.installations.set(
        "101",
        inst("101", "42", { account: { login: "alice", id: "31", type: "User" } }),
      );
      expect((await configure(h, "101")).go.headers.get("location")).toBe(
        "https://github.com/settings/installations/101",
      );
      // an installation the App does not have is refused at the confirm page
      expect((await configure(h, "999")).go.status).toBe(404);
    });

    test("update with every proof claims the installation and its repos", async () => {
      const h = await harness();
      const { nonce } = await configure(h, "100");
      const res = await h.callback(upd, nonce);
      expect(res.status).toBe(200);
      expect((await getInstallation(h.db, "100"))?.orgId).toBe(h.tenantB.id);
      expect((await listRepos(h.db, { orgId: h.tenantB.id })).length).toBe(1);
      const ok = (await listAudit(h.db, { orgId: h.tenantB.id })).find(
        (r) => r.op === "claim_installation",
      );
      expect(ok?.outcome).toBe("ok");
    });

    test("a victim's live claim cannot be completed with another installation's redirect", async () => {
      const h = await harness();
      h.f.installations.set(
        "200",
        inst("200", "42", { account: { login: "mallory", id: "66", type: "User" } }),
      );
      h.users.set("code-m", {
        id: "66",
        login: "mallory",
        installations: [
          { id: "200", accountId: "66", accountLogin: "mallory", accountType: "User" },
        ],
        adminOf: [],
      });
      const { nonce } = await configure(h, "100"); // pinned to A = 100
      const res = await h.callback(
        { installation_id: "200", setup_action: "update", code: "code-m" },
        nonce,
      );
      expect(res.status).toBe(400);
      expect(await res.text()).not.toContain("200");
      expect(h.exchanges).toEqual([]); // no GitHub token exchange
      expect(await getInstallation(h.db, "200")).toBeUndefined();
      // the claim is unspent and unbound: the real owner can still finish it
      expect((await h.callback(upd, nonce)).status).toBe(200);
      expect((await getInstallation(h.db, "100"))?.orgId).toBe(h.tenantB.id);
      expect(await getInstallation(h.db, "200")).toBeUndefined();
    });

    test("a claim started without an installation id is refused on the update path", async () => {
      const h = await harness();
      const { nonce } = await configure(h);
      expect((await h.callback(upd, nonce)).status).toBe(400);
      expect(h.exchanges).toEqual([]);
      expect(await getInstallation(h.db, "100")).toBeUndefined();
    });

    test("refused without the cookie, with a wrong cookie, and on a reused nonce", async () => {
      const h = await harness();
      const { nonce } = await configure(h, "100");
      expect((await h.callback(upd, null)).status).toBe(400); // no state and no cookie
      expect((await h.callback(upd, "not-the-nonce")).status).toBe(400);
      expect(await getInstallation(h.db, "100")).toBeUndefined();
      // an install (not update) without a state is still refused
      expect((await h.callback({ ...upd, setup_action: "install" }, nonce)).status).toBe(400);
      expect((await h.callback(upd, nonce)).status).toBe(200);
      expect((await h.callback(upd, nonce)).status).toBe(400);
    });

    test("refused after the claim expired", async () => {
      const h = await harness();
      const { nonce } = await configure(h, "100");
      h.advance(CLAIM_TTL_MS + 1);
      expect((await h.callback(upd, nonce)).status).toBe(400);
    });

    test("refused for an org member who is not an admin, and for a user without access", async () => {
      const h = await harness();
      h.users.set("member", { ...ownerOf100, adminOf: [] });
      const { nonce } = await configure(h, "100");
      expect((await h.callback({ ...upd, code: "member" }, nonce)).status).toBe(403);
      // the pin is 100: another installation id is refused before any owner check
      expect((await h.callback({ ...upd, installation_id: "200" }, nonce)).status).toBe(400);
      expect(await getInstallation(h.db, "100")).toBeUndefined();
      // the refusals did not burn the claim
      expect((await h.callback(upd, nonce)).status).toBe(200);
    });

    test("an installation held by another org is never moved", async () => {
      const h = await harness();
      const first = await configure(h, "100");
      expect((await h.callback(upd, first.nonce)).status).toBe(200);
      const other = await createOrg(h.db, { slug: "tenant-c", name: "Tenant C" });
      const { url } = await h.claims.start(other.id, "token:t2", { installationId: "100" });
      const { csrf, token } = await h.open(url);
      await h.submit(h.stateOf(url), { csrf, token });
      const res = await h.callback(upd, h.nonceOf(h.stateOf(url)));
      expect(res.status).toBe(409);
      expect((await getInstallation(h.db, "100"))?.orgId).toBe(h.tenantB.id);
    });
  });

  test("a state is single use", async () => {
    const h = await harness();
    const state = h.stateOf((await h.claims.start(h.tenantB.id, "token:t1")).url);
    const q = { installation_id: "100", setup_action: "install", state, code: "code-b" };
    expect((await h.callback(q)).status).toBe(200);
    expect((await h.callback(q)).status).toBe(400);
  });

  test("the state alone is not enough: the user must control that installation", async () => {
    const h = await harness();
    const state = h.stateOf((await h.claims.start(h.tenantB.id, "token:t1")).url);
    h.f.installations.set("200", inst("200"));
    // someone edits installation_id to one they do not own: the code proves 100 only
    const res = await h.callback({
      installation_id: "200",
      setup_action: "install",
      state,
      code: "code-b",
    });
    expect(res.status).toBe(403);
    expect(await getInstallation(h.db, "200")).toBeUndefined();
    // and the failed attempt did not burn the link
    expect(
      (await h.callback({ installation_id: "100", setup_action: "install", state, code: "code-b" }))
        .status,
    ).toBe(200);
  });

  test("no code, a bad code, a forged, expired or malformed state, a bad id: all refused", async () => {
    const h = await harness();
    const { url } = await h.claims.start(h.tenantB.id, "token:t1");
    const state = h.stateOf(url);
    const base = { installation_id: "100", setup_action: "install" };
    expect((await h.callback({ ...base, state })).status).toBe(400);
    expect((await h.callback({ ...base, state, code: "wrong" })).status).toBe(403);
    const [v, body, sig] = state.split(".") as [string, string, string];
    const other = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), o: h.org.id }),
    ).toString("base64url");
    expect(
      (await h.callback({ ...base, state: `${v}.${other}.${sig}`, code: "code-b" })).status,
    ).toBe(400);
    expect((await h.callback({ ...base, state: "garbage", code: "code-b" })).status).toBe(400);
    expect(
      (await h.callback({ ...base, installation_id: "1; drop", state, code: "code-b" })).status,
    ).toBe(400);
    h.advance(16 * 60_000);
    expect((await h.callback({ ...base, state, code: "code-b" })).status).toBe(400);
    expect(await getInstallation(h.db, "100")).toBeUndefined();
  });

  test("an installation another org already holds is not taken", async () => {
    const h = await harness();
    const first = h.stateOf((await h.claims.start(h.org.id, "token:t0")).url);
    expect(
      (
        await h.callback({
          installation_id: "100",
          setup_action: "install",
          state: first,
          code: "code-b",
        })
      ).status,
    ).toBe(200);
    const second = h.stateOf((await h.claims.start(h.tenantB.id, "token:t1")).url);
    const res = await h.callback({
      installation_id: "100",
      setup_action: "install",
      state: second,
      code: "code-b",
    });
    expect(res.status).toBe(409);
    expect((await getInstallation(h.db, "100"))?.orgId).toBe(h.org.id);
  });

  test("an installation from another App, or one GitHub does not know, is refused", async () => {
    const h = await harness();
    h.f.installations.set("100", inst("100", "99"));
    const s1 = h.stateOf((await h.claims.start(h.tenantB.id, "token:t1")).url);
    expect(
      (
        await h.callback({
          installation_id: "100",
          setup_action: "install",
          state: s1,
          code: "code-b",
        })
      ).status,
    ).toBe(409);
    h.f.installations.delete("100");
    const s2 = h.stateOf((await h.claims.start(h.tenantB.id, "token:t1")).url);
    expect(
      (
        await h.callback({
          installation_id: "100",
          setup_action: "install",
          state: s2,
          code: "code-b",
        })
      ).status,
    ).toBe(404);
  });

  test("setup_action=request (awaiting an org owner's approval) binds nothing", async () => {
    const h = await harness();
    const res = await h.callback({ setup_action: "request", state: "x" });
    expect(res.status).toBe(202);
    expect(await getInstallation(h.db, "100")).toBeUndefined();
    expect((await h.callback({})).status).toBe(202);
  });

  test("claim mode in the webhook: an unclaimed installation is ignored, a claimed one syncs to its own org", async () => {
    const h = await harness();
    const handler = createWebhookHandler({
      db: h.db,
      store: h.store,
      facts: h.f.facts,
      claimMode: true,
      log: () => {},
    });
    const post = async (guid: string) => {
      const body = JSON.stringify({ action: "created", installation: { id: 100 } });
      await handler.handle(
        new Request(`http://x${WEBHOOK_PATH}`, {
          method: "POST",
          headers: {
            "x-github-event": "installation",
            "x-github-delivery": guid,
            "x-hub-signature-256": sign(WEBHOOK_SECRET, body),
          },
          body,
        }),
      );
      await handler.drain();
    };
    await post("00000000-aaaa-0000-0000-000000000001");
    expect(await getInstallation(h.db, "100")).toBeUndefined(); // unclaimed: nothing mapped to the App's org
    expect(await listProjects(h.db, { orgId: h.org.id })).toEqual([]);
    const state = h.stateOf((await h.claims.start(h.tenantB.id, "token:t1")).url);
    await h.callback({ installation_id: "100", setup_action: "install", state, code: "code-b" });
    h.f.repos.set("100", [repo("1", "api"), repo("2", "web")]);
    await post("00000000-aaaa-0000-0000-000000000002");
    expect((await listProjects(h.db, { orgId: h.tenantB.id })).length).toBe(2);
    expect(await listProjects(h.db, { orgId: h.org.id })).toEqual([]);
  });

  test("single-tenant sync is unchanged: it maps to the org that owns the App", async () => {
    const h = await harness();
    const r = await syncInstallation(h.db, h.f.facts, "100");
    expect(r.outcome).toBe("synced");
    expect((await getInstallation(h.db, "100"))?.orgId).toBe(h.org.id);
    // claim mode without a claim: left alone
    h.f.installations.set("300", inst("300"));
    expect((await syncInstallation(h.db, h.f.facts, "300", { claimMode: true })).outcome).toBe(
      "unclaimed",
    );
  });

  test("the op: release_operator only, not an MCP tool, unavailable without the flow", async () => {
    const h = await harness();
    const env = { registry, db: h.db, claims: h.claims };
    const scope = { orgId: h.tenantB.id };
    const relop = (await mintToken(h.db, scope, "release_operator")).secret;
    const operator = (await mintToken(h.db, scope, "operator")).secret;
    const ok = await dispatch(
      env,
      { kind: "bearer", token: relop },
      "start_installation_claim",
      {},
    );
    expect(ok.ok && (ok.output as { url: string }).url).toContain("/api/v1/github/claim?state=");
    expect(
      (await dispatch(env, { kind: "bearer", token: operator }, "start_installation_claim", {})).ok,
    ).toBe(false);
    const none = await dispatch(
      { registry, db: h.db },
      { kind: "bearer", token: relop },
      "start_installation_claim",
      {},
    );
    expect(none.ok).toBe(false);
    expect(registry.mcpOps().map((o) => o.name)).not.toContain("start_installation_claim");
    expect(ClaimError).toBeDefined();
    // a project-scoped token is refused, even with the role
    const { createProject } = await import("../src/db");
    const proj = await createProject(h.db, scope, { slug: "p", name: "P" });
    const scoped = (
      await mintToken(h.db, { orgId: h.tenantB.id, projectId: proj.id }, "release_operator")
    ).secret;
    const refused = await dispatch(
      env,
      { kind: "bearer", token: scoped },
      "start_installation_claim",
      {},
    );
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.error.code).toBe("forbidden");
    // the optional GitHub login is validated
    expect(
      (
        await dispatch(env, { kind: "bearer", token: relop }, "start_installation_claim", {
          github_login: "bad login!",
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await dispatch(env, { kind: "bearer", token: relop }, "start_installation_claim", {
          github_login: "alice",
        })
      ).ok,
    ).toBe(true);
  });

  test("the OAuth exchange goes through the guarded client and keeps the client secret out of errors", async () => {
    const h = await harness();
    const { SECRET_CLIENT } = await import("../src/github/app-auth");
    await h.store.set(h.org.id, SECRET_CLIENT, "client-secret-value");
    const seen: { url: string; body?: string; auth?: string }[] = [];
    const fetchStub = (async (
      url: string,
      init?: { body?: string; headers?: Record<string, string> },
    ) => {
      seen.push({
        url,
        ...(init?.body ? { body: init.body } : {}),
        ...(init?.headers?.authorization ? { auth: init.headers.authorization } : {}),
      });
      if (url.endsWith("/login/oauth/access_token"))
        return Response.json({ access_token: "user-tok" });
      if (url.endsWith("/user")) return Response.json({ id: 9, login: "owner-b" });
      if (url.includes("/user/memberships/orgs/acme"))
        return Response.json({ role: "admin", state: "active" });
      if (url.includes("/user/memberships/orgs/pending"))
        return Response.json({ role: "admin", state: "pending" });
      if (url.includes("/user/memberships/orgs/"))
        return Response.json({ message: "Not Found" }, { status: 404 });
      return Response.json({
        installations: [
          { id: 100, app_id: 42, account: { id: 7, login: "acme", type: "Organization" } },
          { id: 5, app_id: 77, account: { id: 8, login: "x", type: "User" } },
        ],
      });
    }) as never;
    const v = githubUserVerifier({ db: h.db, store: h.store, fetch: fetchStub });
    const u = await v.verify("c1");
    expect(u.id).toBe("9");
    expect(u.login).toBe("owner-b");
    // another App's installation is not ours
    expect(u.installations).toEqual([
      { id: "100", accountId: "7", accountLogin: "acme", accountType: "Organization" },
    ]);
    expect(JSON.parse(seen[0]!.body!)).toMatchObject({ client_id: "Iv1.abc", code: "c1" });
    expect(seen[1]!.auth).toBe("Bearer user-tok");
    // role=admin and state=active, read with the user's token, and nothing else counts
    expect(await u.isOrgAdmin("acme")).toBe(true);
    expect(await u.isOrgAdmin("pending")).toBe(false);
    expect(await u.isOrgAdmin("other")).toBe(false);
    expect(await u.isOrgAdmin("../etc")).toBe(false);
    const bad = githubUserVerifier({
      db: h.db,
      store: h.store,
      fetch: (async () => Response.json({ error: "bad_verification_code" })) as never,
    });
    const err = await bad.verify("c1").catch((e) => e);
    expect(String(err.message)).not.toContain("client-secret-value");
  });
});

describe("a webhook wakes the poller for the repo it names", () => {
  test("push and pull_request wake it with the name only; other events, bad names and bad signatures do not", async () => {
    const s = await setup();
    const woken: string[] = [];
    const handler = createWebhookHandler({
      db: s.db,
      store: s.store,
      facts: fakeFacts().facts,
      log: () => {},
      onRepoEvent: (repo, ev) => void woken.push(`${ev}:${repo}`),
    });
    const post = (event: string, payload: unknown, sig?: string) => {
      const body = JSON.stringify(payload);
      return handler.handle(
        new Request(`http://x${WEBHOOK_PATH}`, {
          method: "POST",
          headers: {
            "x-github-event": event,
            "x-github-delivery": crypto.randomUUID(),
            "x-hub-signature-256": sig ?? sign(WEBHOOK_SECRET, body),
          },
          body,
        }),
      );
    };
    expect((await post("push", { repository: { full_name: "acme/web" } }))!.status).toBe(202);
    expect(
      (await post("pull_request", { action: "opened", repository: { full_name: "acme/web" } }))!
        .status,
    ).toBe(202);
    await post("issues", { repository: { full_name: "acme/web" } });
    await post("push", { repository: { full_name: "../../etc/passwd" } });
    await post("push", { repository: { full_name: 7 } });
    await post("push", { repository: { full_name: "acme/web" } }, sign("wrong", "x"));
    expect(woken).toEqual(["push:acme/web", "pull_request:acme/web"]);
  });

  test("Poller.nudge: only configured repos, coalesced, spaced, and not while backing off", async () => {
    const gh = makeGithub();
    gh.state.files.set(
      "*",
      "name: ci\non:\n  push:\n    branches: [main]\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n",
    );
    let broken = false;
    const fetchStub = (async (url: string, init?: RequestInit) => {
      if (broken) throw new Error("network down");
      return gh.fetch(url, init);
    }) as never;
    const config = pollConfigSchema.parse({
      allowUnauthenticated: true,
      repos: [
        {
          repo: "acme/web",
          workflow: ".github/workflows/ci.yml",
          defaultBranch: "main",
          intervalSeconds: 3600,
        },
      ],
    });
    const db = (await setup()).db;
    const poller = new Poller({ db, config, fetch: fetchStub, log: () => {} });
    expect(poller.nudge("acme/web")).toBe(false); // not started
    poller.start();
    await Bun.sleep(100);
    const afterStart = gh.state.calls.length;
    expect(poller.nudge("other/repo")).toBe(false);
    expect(poller.nudge("ACME/Web")).toBe(true); // names match case-insensitively
    expect(poller.nudge("acme/web")).toBe(true); // coalesced into the same pending poll
    await Bun.sleep(MIN_NUDGE_GAP_MS + 500);
    const afterNudge = gh.state.calls.length;
    expect(afterNudge).toBeGreaterThan(afterStart);
    // a repo that is backing off after errors is not woken early
    broken = true;
    poller.nudge("acme/web");
    await Bun.sleep(MIN_NUDGE_GAP_MS + 500);
    expect(poller.nudge("acme/web")).toBe(false);
    poller.stop();
  }, 30_000);
});

describe("the whole server configured from the environment", () => {
  test("every serve option has a variable, with sane defaults; flags win (they are parseArgs defaults)", () => {
    const d = serveDefaults({
      PORT: "9000",
      TURNTABLE_HOST: "0.0.0.0",
      TURNTABLE_DATA_DIR: "/data",
      TURNTABLE_WORKER: "1",
      TURNTABLE_PROVIDER: "daytona",
      TURNTABLE_PROVIDER_CONFIG_JSON: '{"apiKeyEnv":"DAYTONA_API_KEY"}',
      TURNTABLE_POLL_JSON: "{}",
      TURNTABLE_GLOBAL_CAP: "3",
      TURNTABLE_ORG_CAP: "1",
      TURNTABLE_LEASE_SECONDS: "45",
      TURNTABLE_IMAGE: "ghcr.io/x/y:1",
      TURNTABLE_HOSTED: "1",
      TURNTABLE_ISOLATION_OVERRIDE: "reason",
    });
    expect(d).toMatchObject({
      port: "9000",
      host: "0.0.0.0",
      dataDir: "/data",
      worker: true,
      provider: "daytona",
      providerConfig: ENV_PROVIDER_SOURCE,
      poll: ENV_POLL_SOURCE,
      globalCap: "3",
      orgCap: "1",
      leaseSeconds: "45",
      image: "ghcr.io/x/y:1",
      hosted: true,
      isolationOverride: "reason",
    });
    expect(serveDefaults({})).toMatchObject({
      port: "8080",
      worker: false,
      provider: "docker",
      hosted: false,
      globalCap: "4",
      poll: undefined,
    });
    // a file path wins over the JSON variable
    expect(
      serveDefaults({ TURNTABLE_POLL: "/etc/poll.json", TURNTABLE_POLL_JSON: "{}" }).poll,
    ).toBe("/etc/poll.json");
  });

  const pollJson = JSON.stringify({
    tokenEnv: "GH_POLL_TOKEN",
    provider: "daytona",
    repos: [
      {
        repo: "acme/web",
        org: "acme",
        project: "web",
        workflow: ".github/workflows/ci.yml",
        defaultBranch: "main",
        prMode: "approval",
      },
    ],
  });

  test("the poll config can be JSON in a variable, with the token in another; the config never carries the token", () => {
    const cfg = resolvePollConfig(ENV_POLL_SOURCE, {
      TURNTABLE_POLL_JSON: pollJson,
      GH_POLL_TOKEN: " tok ",
    });
    expect(cfg?.repos[0]?.repo).toBe("acme/web");
    expect(readPollToken(cfg!, { GH_POLL_TOKEN: " tok " })).toBe("tok");
    expect(() => readPollToken(cfg!, {})).toThrow(/GH_POLL_TOKEN/);
    expect(() => resolvePollConfig(ENV_POLL_SOURCE, {})).toThrow(/TURNTABLE_POLL_JSON is not set/);
    expect(() => parsePollConfig("{not json", "x")).toThrow(/cannot read poll config/);
    // a token pasted inline, both sources, or neither: refused
    for (const bad of [
      { token: "ghp_x", repos: JSON.parse(pollJson).repos },
      { tokenEnv: "A", tokenFile: "/f", repos: JSON.parse(pollJson).repos },
      { repos: JSON.parse(pollJson).repos },
      { tokenEnv: "lower-case", repos: JSON.parse(pollJson).repos },
    ]) {
      expect(() => parsePollConfig(JSON.stringify(bad), "x")).toThrow(/invalid poll config/);
    }
  });

  test("the provider config can be JSON in a variable", () => {
    const cfg = resolveProviderConfig(ENV_PROVIDER_SOURCE, {
      TURNTABLE_PROVIDER_CONFIG_JSON: '{"apiKeyEnv":"DAYTONA_API_KEY","maxLive":3}',
    });
    expect(cfg).toEqual({ apiKeyEnv: "DAYTONA_API_KEY", maxLive: 3 });
    expect(() => resolveProviderConfig(ENV_PROVIDER_SOURCE, {})).toThrow(/not set/);
    expect(() =>
      resolveProviderConfig(ENV_PROVIDER_SOURCE, { TURNTABLE_PROVIDER_CONFIG_JSON: "[1]" }),
    ).toThrow(/JSON object/);
    expect(resolveProviderConfig(undefined)).toEqual({});
  });
});

export type { Db };
