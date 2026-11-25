// Onboarding lane A2, the account side: the `account` principal and where it is accepted, the
// self-serve org settings and rate limit, the sealed user-to-server token, list_user_installations
// and bind_installation. A fake GitHub (a fetch stub) stands behind the OAuth exchange, the token
// refresh and the user endpoints; everything else is the real thing, on SQLite and Postgres.
import { afterAll, describe, expect, test } from "bun:test";
import { systemOrgId } from "../src/audit/failures";
import {
  createAuthHandler,
  githubIdentityVerifier,
  LOGIN_PATH,
  LOGOUT_PATH,
} from "../src/auth/github-login";
import { UserTokens, githubUserApi } from "../src/auth/user-tokens";
import { csrfToken, LOGIN_COOKIE, sessionHash, WebSessions } from "../src/auth/web-sessions";
import {
  addMember,
  createOrg,
  createUser,
  type Db,
  getInstallation,
  getOrgBySlug,
  getOrgQuotas,
  listAudit,
  listMembershipsOfUser,
  listProjects,
  openDatabase,
  schema,
  setProjectSandboxSettings,
  upsertInstallation,
} from "../src/db";
import { testDb } from "../src/db/dialect";
import { openPostgres } from "../src/db/pg";
import { SECRET_CLIENT } from "../src/github/app-auth";
import { notInstallationOwnerMessage } from "../src/github/claim";
import { dispatch, type DispatchEnv, ERROR_STATUS, registry } from "../src/ops";
import type { Principal } from "../src/ops/principal";
import { createInstanceTokenFromCli } from "../src/ops/instance-token-cli";
import { settingsRegistry } from "../src/settings/definitions";
import { createSettingsRuntime } from "../src/settings/resolve";
import { fakeFacts, inst, repo, setup } from "./github-helpers";
import { mintToken } from "./ops-helpers";

const ORIGIN = "https://ci.example.test";
const T0 = Date.now();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const FOREIGN_SLUG = "foreign-company-secretslug";

const pgTarget = (): Parameters<typeof openPostgres>[0] => {
  const t = testDb();
  return t && t !== "pglite"
    ? { url: t, schema: `lstest_onbacct_${process.pid}` }
    : { pglite: true };
};
const opened: Db[] = [];
const dialects: [string, () => Db][] = [
  ["sqlite", () => openDatabase(":memory:")],
  ["postgres", () => openPostgres(pgTarget(), { fresh: true })],
];
afterAll(() => {
  for (const db of opened) db.close();
});

type FakeUser = {
  id: string;
  login: string;
  /** What the token endpoint gives for this user's code. */
  access: string;
  refresh: string;
  expiresIn: number;
  installations: {
    id: number;
    app_id?: number;
    repository_selection?: string;
    account: { id: number; login: string; type: string };
  }[];
  adminOf: string[];
};

const cookieOf = (res: Response, name: string, prefix = false): string | undefined =>
  res.headers.getSetCookie().find((c) => c.startsWith(prefix ? name : `${name}=`));
const valueOf = (setCookie: string): string =>
  setCookie.split(";")[0]!.slice(setCookie.indexOf("=") + 1);

describe.each(dialects)("onboarding account (%s)", (_n, open) => {
  async function harness(envVars: Record<string, string> = {}) {
    const s = await setup("42", open);
    opened.push(s.db);
    await s.store.set(s.org.id, SECRET_CLIENT, "client-secret-value");
    const tenant = await createOrg(s.db, { slug: "tenant", name: "Tenant" });
    const foreign = await createOrg(s.db, { slug: FOREIGN_SLUG, name: "Foreign" });
    let now = T0;
    const facts = fakeFacts();

    // ---- the fake GitHub ----
    const users = new Map<string, FakeUser>(); // by code
    const liveAccess = new Map<string, FakeUser>(); // access token -> user
    const liveRefresh = new Map<string, FakeUser>(); // refresh token -> user
    const calls = { installations: 0, refresh: 0, memberships: 0, authHeaders: [] as string[] };
    let seq = 0;
    const issue = (u: FakeUser, expiresIn = u.expiresIn) => {
      seq += 1;
      const access = `${u.access}-${seq}`;
      const refresh = `${u.refresh}-${seq}`;
      liveAccess.set(access, u);
      liveRefresh.set(refresh, u);
      return {
        access_token: access,
        refresh_token: refresh,
        expires_in: expiresIn,
        refresh_token_expires_in: 15_811_200,
        token_type: "bearer",
      };
    };
    const failRefresh = { on: false };
    const fetchStub = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const auth = new Headers(init?.headers).get("authorization");
      if (auth) calls.authHeaders.push(auth);
      const json = (v: unknown, status = 200) =>
        new Response(JSON.stringify(v), {
          status,
          headers: { "content-type": "application/json" },
        });
      if (url.pathname === "/login/oauth/access_token") {
        const body = JSON.parse(String(init?.body)) as Record<string, string>;
        if (body.client_secret !== "client-secret-value") return json({ error: "bad" }, 401);
        if (body.grant_type === "refresh_token") {
          calls.refresh += 1;
          const u = liveRefresh.get(body.refresh_token!);
          if (!u || failRefresh.on) return json({ error: "bad_refresh_token" }, 200);
          liveRefresh.delete(body.refresh_token!); // GitHub rotates the refresh token
          return json(issue(u));
        }
        const u = users.get(body.code!);
        return u ? json(issue(u)) : json({ error: "bad_verification_code" }, 200);
      }
      const bearer = /^Bearer (.+)$/.exec(auth ?? "")?.[1];
      const u = bearer ? liveAccess.get(bearer) : undefined;
      if (!u) return json({ message: "Bad credentials" }, 401);
      if (url.pathname === "/user") return json({ id: Number(u.id), login: u.login });
      if (url.pathname === "/user/installations") {
        calls.installations += 1;
        return json({ total_count: u.installations.length, installations: u.installations });
      }
      const m = /^\/user\/memberships\/orgs\/(.+)$/.exec(url.pathname);
      if (m) {
        calls.memberships += 1;
        return u.adminOf.includes(decodeURIComponent(m[1]!))
          ? json({ role: "admin", state: "active" })
          : json({ role: "member", state: "active" });
      }
      return json({ message: "Not Found" }, 404);
    }) as unknown as typeof fetch;

    const settings = createSettingsRuntime(settingsRegistry, envVars);
    const sessions = new WebSessions({ db: s.db, publicUrl: ORIGIN, settings, now: () => now });
    const tokens = new UserTokens({
      db: s.db,
      store: s.store,
      sessions,
      fetch: fetchStub as never,
    });
    const userGithub = githubUserApi({ db: s.db, tokens, fetch: fetchStub as never });
    const logs: string[] = [];
    const handler = createAuthHandler({
      db: s.db,
      store: s.store,
      sessions,
      userTokens: tokens,
      settings,
      identity: githubIdentityVerifier({ db: s.db, store: s.store, fetch: fetchStub as never }),
      log: (l) => logs.push(l),
    });
    const env: DispatchEnv = {
      registry,
      db: s.db,
      sessions,
      userGithub,
      githubFacts: facts.facts,
      settings,
      allowInstance: true,
      now: () => now,
    };
    const addUser = (code: string, u: Partial<FakeUser> & { id: string; login: string }) => {
      const full: FakeUser = {
        access: `gho_marker_access_${u.login}`,
        refresh: `ghr_marker_refresh_${u.login}`,
        expiresIn: 8 * 3600,
        installations: [],
        adminOf: [],
        ...u,
      };
      users.set(code, full);
      return full;
    };
    /** A real sign-in through the handler: returns the session cookie value, or the refusal. */
    const signIn = async (code: string) => {
      const go = (await handler.handle(new Request(`${ORIGIN}${LOGIN_PATH}`)))!;
      const location = new URL(go.headers.get("location")!);
      const state = location.searchParams.get("state")!;
      const loginCookie = cookieOf(go, `${LOGIN_COOKIE}_`, true)!;
      const cb = (await handler.handle(
        new Request(
          `${ORIGIN}/auth/github/callback?state=${encodeURIComponent(state)}&code=${code}`,
          { headers: { cookie: `${loginCookie.split(";")[0]}` } },
        ),
      ))!;
      const session = cookieOf(cb, "__Host-tt_session");
      return { res: cb, cookie: session ? valueOf(session) : undefined };
    };
    const as = (cookie: string, op: string, input: Record<string, unknown> = {}) =>
      dispatch(env, { kind: "session", cookie }, op, input);
    const sealedRows = async () =>
      JSON.stringify(await s.db.run((h) => h.orm.select().from(schema.secrets)));
    return {
      ...s,
      tenant,
      foreign,
      facts,
      env,
      settings,
      sessions,
      tokens,
      handler,
      logs,
      users,
      addUser,
      signIn,
      as,
      calls,
      liveAccess,
      failRefresh,
      sealedRows,
      advance: (ms: number) => (now += ms),
      setNow: (t: number) => (now = t),
    };
  }

  // -------------------------------------------------------------------------------------------
  test("registry-wide: an account principal is refused by every op that does not declare account, and exactly three declare it", async () => {
    const h = await harness();
    const account: Principal = {
      kind: "account",
      githubUserId: "7",
      login: "someone",
      sessionHash: "h",
      id: "7",
      orgId: await systemOrgId(h.db),
    };
    expect(
      registry.ops
        .filter((o) => o.auth.type === "account")
        .map((o) => o.name)
        .toSorted(),
    ).toEqual(["list_my_orgs", "list_user_installations", "onboarding_create_org"]);
    // The one other door: a cross-org READ (#559) takes an account and reads only the orgs its
    // membership rows name. Nothing else may ever be marked crossOrg without this test noticing.
    expect(
      registry.ops
        .filter((o) => o.crossOrg)
        .map((o) => [o.name, o.effect])
        .toSorted(),
    ).toEqual([["my_activity_feed", "read"]]);
    for (const op of registry.ops) {
      const r = await dispatch(h.env, { kind: "principal", principal: account }, op.name, {});
      if (op.auth.type === "account" || op.crossOrg) continue;
      expect([op.name, r.ok]).toEqual([op.name, false]);
      if (!r.ok) expect([op.name, r.error.code]).toEqual([op.name, "forbidden"]);
    }
  });

  test("the account ops refuse every other principal and every MCP call", async () => {
    const h = await harness({ TURNTABLE_SELF_SERVE_ORGS: "any" });
    const names = ["list_my_orgs", "list_user_installations", "onboarding_create_org"];
    const input = (n: string) =>
      n === "onboarding_create_org" ? { slug: "x1", display_name: "X" } : {};
    for (const role of ["reader", "operator", "release_operator"] as const) {
      const t = await mintToken(h.db, { orgId: h.tenant.id }, role);
      for (const n of names) {
        const r = await dispatch(h.env, { kind: "bearer", token: t.secret }, n, input(n));
        expect([n, r.ok]).toEqual([n, false]);
        if (!r.ok) expect(r.error.code).toBe("forbidden");
      }
    }
    const tti = (await createInstanceTokenFromCli(h.db, { name: "ops" })).secret;
    for (const n of names) {
      const r = await dispatch(h.env, { kind: "bearer", token: tti }, n, input(n));
      expect(r.ok).toBe(false);
      for (const principal of [
        { kind: "member", id: "m", orgId: h.tenant.id, role: "owner" },
        { kind: "session", id: "u", orgId: h.tenant.id, role: "owner", sessionHash: "h" },
      ] as Principal[]) {
        const p = await dispatch(h.env, { kind: "principal", principal }, n, input(n));
        expect([n, principal.kind, p.ok]).toEqual([n, principal.kind, false]);
      }
    }
    // MCP: even a genuine account principal is refused when the call came over MCP
    const account: Principal = {
      kind: "account",
      githubUserId: "7",
      login: "someone",
      sessionHash: "h",
      id: "7",
      orgId: await systemOrgId(h.db),
    };
    for (const mcp of [{ viaMcp: true }, { transport: "mcp" as const }]) {
      for (const n of names) {
        const r = await dispatch(
          { ...h.env, ...mcp },
          { kind: "principal", principal: account },
          n,
          input(n),
        );
        expect([n, r.ok]).toEqual([n, false]);
        if (!r.ok) expect(r.error.code).toBe("forbidden");
      }
    }
    // and none is an MCP tool
    for (const n of names) expect(registry.get(n)!.mcp).toBe(false);
    expect(registry.mcpOps().map((o) => o.name)).not.toContain("bind_installation");
    // a session cookie that names an org is not an account call
    const alice = h.addUser("c-alice", { id: "1001", login: "alice" });
    expect(alice.login).toBe("alice");
    const si = await h.signIn("c-alice");
    expect(si.cookie).toBeDefined();
    const named = await h.as(si.cookie!, "list_my_orgs", { org: "tenant" });
    expect(named.ok).toBe(false);
  });

  // -------------------------------------------------------------------------------------------
  describe("self-serve org creation", () => {
    const create = (h: Awaited<ReturnType<typeof harness>>, cookie: string, slug = "acme-one") =>
      h.as(cookie, "onboarding_create_org", { slug, display_name: "Acme One" });

    test("off: refused for everyone, even a listed login, with the exact message; it also stops sign-in for an account with no org", async () => {
      const h = await harness({
        TURNTABLE_SELF_SERVE_ORGS: "off",
        TURNTABLE_SELF_SERVE_ORG_LOGINS: "alice",
      });
      h.addUser("c", { id: "1001", login: "alice" });
      const si = await h.signIn("c");
      expect(si.cookie).toBeUndefined();
      expect(si.res.status).toBe(403);
      // a member of some org signs in, and the op still refuses
      const u = await createUser(h.db, { displayName: "alice" });
      await h.db.run((q) =>
        q.orm
          .insert(schema.githubIdentities)
          .values({ githubUserId: "1001", userId: u.id, login: "alice" }),
      );
      await addMember(h.db, { orgId: h.tenant.id }, { userId: u.id, role: "viewer" });
      const again = await h.signIn("c");
      expect(again.cookie).toBeDefined();
      const r = await create(h, again.cookie!);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe("forbidden");
        expect(r.error.message).toBe(
          "self-serve org creation is not enabled for your account on this instance",
        );
      }
    });

    test("allowlist: in the list (case-insensitive) creates; out of the list is refused; the default is an empty allowlist", async () => {
      const h = await harness({ TURNTABLE_SELF_SERVE_ORG_LOGINS: "Alice, bob" });
      h.addUser("c-alice", { id: "1001", login: "alice" });
      h.addUser("c-carol", { id: "3003", login: "carol" });
      const a = await h.signIn("c-alice");
      expect(a.cookie).toBeDefined();
      const ok = await create(h, a.cookie!);
      expect(ok.ok && ok.output).toMatchObject({
        org: { slug: "acme-one", display_name: "Acme One" },
        role: "owner",
      });
      // carol is not on the list: no session at all (sign-in refuses an account with no org)
      expect((await h.signIn("c-carol")).cookie).toBeUndefined();
      // default setting (allowlist, empty): nobody
      const d = await harness();
      d.addUser("c-alice", { id: "1001", login: "alice" });
      expect((await d.signIn("c-alice")).cookie).toBeUndefined();
    });

    test("a signed-in account that is NOT allowed is refused by the op itself, with the exact message", async () => {
      // alice is a member of an org (so she may sign in) but is not on the allowlist
      const h = await harness({ TURNTABLE_SELF_SERVE_ORG_LOGINS: "somebody-else" });
      h.addUser("c-alice", { id: "1001", login: "alice" });
      const u = await createUser(h.db, { displayName: "alice" });
      await h.db.run((q) =>
        q.orm
          .insert(schema.githubIdentities)
          .values({ githubUserId: "1001", userId: u.id, login: "alice" }),
      );
      await addMember(h.db, { orgId: h.tenant.id }, { userId: u.id, role: "viewer" });
      const a = await h.signIn("c-alice");
      expect(a.cookie).toBeDefined();
      const r = await create(h, a.cookie!);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe("forbidden");
        expect(r.error.message).toBe(
          "self-serve org creation is not enabled for your account on this instance",
        );
      }
      expect(await getOrgBySlug(h.db, "acme-one")).toBeUndefined();
    });

    test("any: creates the org with default quotas and an owner; audited in the new org's chain; list_my_orgs shows it", async () => {
      const h = await harness({ TURNTABLE_SELF_SERVE_ORGS: "any" });
      h.addUser("c-zed", { id: "9009", login: "zed" });
      const z = await h.signIn("c-zed");
      expect(z.cookie).toBeDefined();
      expect(
        (await h.as(z.cookie!, "list_my_orgs")).ok && (await h.as(z.cookie!, "list_my_orgs")),
      ).toMatchObject({
        output: { orgs: [] },
      });
      const r = await create(h, z.cookie!, "zed-co");
      expect(r.ok).toBe(true);
      const org = (await getOrgBySlug(h.db, "zed-co"))!;
      // the instance default quotas: no org-specific row
      expect(await getOrgQuotas(h.db, org.id)).toMatchObject({ maxConcurrent: null });
      const chain = await listAudit(h.db, { orgId: org.id });
      const row = chain.find((e) => e.op === "onboarding_create_org");
      expect(row).toMatchObject({ principalKind: "account", principalId: "9009", outcome: "ok" });
      expect(JSON.parse(row!.input)).toMatchObject({ slug: "zed-co", github_login: "zed" });
      const mine = await h.as(z.cookie!, "list_my_orgs");
      expect(mine.ok && mine.output).toEqual({
        orgs: [{ slug: "zed-co", display_name: "Acme One", role: "owner" }],
      });
      // the session now also acts in the new org with the owner role
      const asOrg = await h.as(z.cookie!, "whoami", { org: "zed-co" });
      expect(asOrg.ok && asOrg.output).toMatchObject({
        kind: "session",
        role: "owner",
        org: "zed-co",
      });
      // a taken slug and a bad slug
      const taken = await create(h, z.cookie!, "zed-co");
      expect(taken.ok).toBe(false);
      const bad = await h.as(z.cookie!, "onboarding_create_org", {
        slug: "Bad Slug",
        display_name: "x",
      });
      expect(bad.ok).toBe(false);
      if (!bad.ok) expect(bad.error.code).toBe("invalid_input");
    });

    test("the 4th create in 24 hours is refused, a refused call is not counted, and another user is not affected", async () => {
      const h = await harness({ TURNTABLE_SELF_SERVE_ORGS: "any" });
      h.addUser("c-zed", { id: "9009", login: "zed" });
      h.addUser("c-yan", { id: "8008", login: "yan" });
      const z = (await h.signIn("c-zed")).cookie!;
      const y = (await h.signIn("c-yan")).cookie!;
      for (const n of ["z1", "z2", "z3"]) expect((await create(h, z, n)).ok).toBe(true);
      // a refusal for another reason (a taken slug) does not use up the allowance
      const dup = await create(h, z, "z1");
      expect(dup.ok).toBe(false);
      const fourth = await create(h, z, "z4");
      expect(fourth.ok).toBe(false);
      if (!fourth.ok) expect(fourth.error.code).toBe("rate_limited");
      expect(await getOrgBySlug(h.db, "z4")).toBeUndefined();
      expect((await create(h, y, "y1")).ok).toBe(true);
    });

    test("the allowlist stored in the database works, and the environment locks it", async () => {
      const h = await harness();
      const tti = (await createInstanceTokenFromCli(h.db, { name: "ops" })).secret;
      const set = await dispatch(h.env, { kind: "bearer", token: tti }, "instance_set_setting", {
        key: "self_serve_org_logins",
        value: ["alice"],
      });
      expect(set.ok).toBe(true);
      h.addUser("c-alice", { id: "1001", login: "ALICE" });
      expect((await h.signIn("c-alice")).cookie).toBeDefined();
      const tooMany = await dispatch(
        h.env,
        { kind: "bearer", token: tti },
        "instance_set_setting",
        {
          key: "self_serve_org_logins",
          value: Array.from({ length: 201 }, (_, i) => `u${i}`),
        },
      );
      expect(tooMany.ok).toBe(false);
      const locked = {
        ...h.env,
        settings: createSettingsRuntime(settingsRegistry, { TURNTABLE_SELF_SERVE_ORGS: "off" }),
      };
      const refused = await dispatch(
        locked,
        { kind: "bearer", token: tti },
        "instance_set_setting",
        {
          key: "self_serve_orgs",
          value: "any",
        },
      );
      expect(refused.ok).toBe(false);
    });
  });

  // -------------------------------------------------------------------------------------------
  describe("the user-to-server token", () => {
    const MARKER = "gho_marker_access_alice";
    const allText = async (h: Awaited<ReturnType<typeof harness>>) => {
      const orgs = [h.org, h.tenant, h.foreign, { id: await systemOrgId(h.db) }];
      const audits = (
        await Promise.all(orgs.map((o) => listAudit(h.db, { orgId: o.id }, { limit: 500 })))
      ).flat();
      const events = await h.db.run((q) => q.orm.select().from(schema.events));
      const sessions = await h.db.run((q) => q.orm.select().from(schema.webSessions));
      return JSON.stringify({
        audits,
        events,
        sessions,
        sealed: await h.sealedRows(),
        logs: h.logs,
      });
    };

    async function aliceHarness(envVars: Record<string, string> = {}) {
      const h = await harness(envVars);
      const alice = h.addUser("c-alice", {
        id: "1001",
        login: "alice",
        installations: [
          {
            id: 100,
            app_id: 42,
            repository_selection: "selected",
            account: { id: 7, login: "acme", type: "Organization" },
          },
        ],
        adminOf: ["acme"],
      });
      const u = await createUser(h.db, { displayName: "alice" });
      await h.db.run((q) =>
        q.orm
          .insert(schema.githubIdentities)
          .values({ githubUserId: "1001", userId: u.id, login: "alice" }),
      );
      await addMember(h.db, { orgId: h.tenant.id }, { userId: u.id, role: "owner" });
      return { h, alice, userId: u.id };
    }

    test("sealed at rest: the database rows hold no plain token, and the token is usable", async () => {
      const { h } = await aliceHarness();
      const logSpy: string[] = [];
      const orig = { log: console.log, warn: console.warn, error: console.error };
      for (const k of ["log", "warn", "error"] as const) {
        console[k] = (...a: unknown[]) => void logSpy.push(a.map(String).join(" "));
      }
      try {
        const si = await h.signIn("c-alice");
        expect(si.cookie).toBeDefined();
        const hash = sessionHash(si.cookie!);
        // a sealed record exists for this session
        const rows = JSON.parse(await h.sealedRows()) as { name: string }[];
        expect(rows.some((r) => r.name === `web-session/${hash}/github-user-token`)).toBe(true);
        const everything = await allText(h);
        expect(everything).not.toContain(MARKER);
        expect(everything).not.toContain("ghr_marker_refresh_alice");
        // and it works: list_user_installations calls GitHub with it
        const r = await h.as(si.cookie!, "list_user_installations");
        expect(r.ok).toBe(true);
        expect(h.calls.authHeaders.some((a) => a.includes(MARKER))).toBe(true);
        // marker test: no op output, log line or console line carries a token
        expect(JSON.stringify(r.ok ? r.output : r.error)).not.toContain("gho_");
        for (const op of ["list_my_orgs", "whoami"]) {
          const o = await h.as(si.cookie!, op, op === "whoami" ? { org: "tenant" } : {});
          expect(JSON.stringify(o.ok ? o.output : o.error)).not.toContain("gho_");
        }
        expect(logSpy.join("\n")).not.toContain("gho_");
        expect(logSpy.join("\n")).not.toContain("ghr_");
        expect(h.logs.join("\n")).not.toContain("gho_");
        expect(await allText(h)).not.toContain("gho_marker");
      } finally {
        Object.assign(console, orig);
      }
    });

    test("sealing audits github_user_token.sealed (session hash and GitHub user id only), never secret_set", async () => {
      const { h } = await aliceHarness();
      const si = await h.signIn("c-alice");
      const hash = sessionHash(si.cookie!);
      const chain = await listAudit(h.db, { orgId: h.org.id }, { limit: 500 });
      const sealed = chain.filter((e) => e.op === "github_user_token.sealed");
      expect(sealed.length).toBe(1);
      const body = JSON.stringify(sealed[0]);
      expect(body).toContain(hash);
      expect(body).toContain("1001");
      expect(body).not.toContain("gho_marker");
      expect(body).not.toContain("ghr_marker");
      expect(chain.some((e) => e.op === "secret_set" && JSON.stringify(e).includes(hash))).toBe(
        false,
      );
    });

    test("deleted on sign-out, and the session cannot reach GitHub afterwards", async () => {
      const { h } = await aliceHarness();
      const si = await h.signIn("c-alice");
      const cookie = si.cookie!;
      const name = `web-session/${sessionHash(cookie)}/github-user-token`;
      expect(await h.store.has(h.org.id, name)).toBe(true);
      const out = (await h.handler.handle(
        new Request(`${ORIGIN}${LOGOUT_PATH}`, {
          method: "POST",
          headers: {
            origin: ORIGIN,
            cookie: `__Host-tt_session=${cookie}`,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({ csrf: csrfToken(cookie) }),
        }),
      ))!;
      expect(out.status).toBe(303);
      expect(await h.store.has(h.org.id, name)).toBe(false);
      const chain = await listAudit(h.db, { orgId: h.org.id }, { limit: 500 });
      const gone = chain.filter((e) => e.op === "github_user_token.deleted");
      expect(gone.length).toBe(1);
      expect(JSON.stringify(gone[0])).toContain(sessionHash(cookie));
      expect(JSON.stringify(gone[0])).toContain("1001");
      expect(JSON.stringify(gone[0])).not.toContain("gho_marker");
      expect(chain.some((e) => e.op === "secret_delete" && JSON.stringify(e).includes(name))).toBe(
        false,
      );
      expect((await h.as(cookie, "list_user_installations")).ok).toBe(false);
    });

    test("deleted when the session expires (swept at the next sign-in) and idle sessions too", async () => {
      const { h } = await aliceHarness();
      const si = await h.signIn("c-alice");
      const name = `web-session/${sessionHash(si.cookie!)}/github-user-token`;
      h.advance(8 * DAY); // past the 7 day absolute lifetime
      expect(await h.store.has(h.org.id, name)).toBe(true); // nothing has looked yet
      expect((await h.as(si.cookie!, "list_user_installations")).ok).toBe(false); // the session is gone
      h.addUser("c-bob", { id: "2002", login: "bob" });
      const u = await createUser(h.db, { displayName: "bob" });
      await h.db.run((q) =>
        q.orm
          .insert(schema.githubIdentities)
          .values({ githubUserId: "2002", userId: u.id, login: "bob" }),
      );
      await addMember(h.db, { orgId: h.tenant.id }, { userId: u.id, role: "viewer" });
      expect((await h.signIn("c-bob")).cookie).toBeDefined(); // a sign-in sweeps
      expect(await h.store.has(h.org.id, name)).toBe(false);
    });

    test("refreshed with GitHub's refresh token when it has expired; the rotated refresh token is stored", async () => {
      const { h, alice } = await aliceHarness();
      alice.expiresIn = 3600;
      const si = await h.signIn("c-alice");
      const first = await h.as(si.cookie!, "list_user_installations");
      expect(first.ok).toBe(true);
      expect(h.calls.refresh).toBe(0);
      h.advance(2 * HOUR); // the access token (1 h) has expired; the session (12 h idle) has not
      const second = await h.as(si.cookie!, "list_user_installations");
      expect(second.ok).toBe(true);
      expect(h.calls.refresh).toBe(1);
      // the call after the refresh used the NEW access token, which the fake only knows after refresh
      const used = h.calls.authHeaders.at(-1)!;
      expect(used).not.toContain("alice-1");
      // the new token is good for an hour: no second refresh
      await h.as(si.cookie!, "list_user_installations");
      expect(h.calls.refresh).toBe(1);
      // a second expiry refreshes again with the rotated refresh token (the old one is spent)
      h.advance(2 * HOUR);
      expect((await h.as(si.cookie!, "list_user_installations")).ok).toBe(true);
      expect(h.calls.refresh).toBe(2);
      expect(await allText(h)).not.toContain("gho_marker");
    });

    test("a refresh GitHub refuses drops the GitHub token: the token is deleted and the op says to reconnect, never 401", async () => {
      const { h, alice } = await aliceHarness();
      alice.expiresIn = 3600;
      const si = await h.signIn("c-alice");
      const name = `web-session/${sessionHash(si.cookie!)}/github-user-token`;
      h.advance(2 * HOUR);
      h.failRefresh.on = true;
      const r = await h.as(si.cookie!, "list_user_installations");
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe("github_user_token_missing");
        expect(r.error.message).toContain("reconnect GitHub");
      }
      expect(await h.store.has(h.org.id, name)).toBe(false);
    });

    test("a valid session with no sealed GitHub token gets github_user_token_missing (409, not 401) from both ops; a bad cookie is still 401", async () => {
      const { h } = await aliceHarness();
      h.facts.installations.set("100", inst("100"));
      h.facts.repos.set("100", [repo("1", "api")]);
      const si = await h.signIn("c-alice");
      // a session made before the token was sealed: the same session, with no token behind it
      await h.tokens.remove(sessionHash(si.cookie!));
      expect(ERROR_STATUS.github_user_token_missing).toBe(409);
      const list = await h.as(si.cookie!, "list_user_installations");
      const bind = await h.as(si.cookie!, "bind_installation", {
        installation_id: "100",
        org: "tenant",
      });
      for (const r of [list, bind]) {
        expect(r.ok).toBe(false);
        if (!r.ok) {
          expect(r.error.code).toBe("github_user_token_missing");
          expect(r.error.status).toBe(409);
        }
      }
      // the session itself is still good
      expect((await h.as(si.cookie!, "list_my_orgs")).ok).toBe(true);
      const bad = await h.as("not-a-session-cookie", "list_user_installations");
      expect(bad.ok).toBe(false);
      if (!bad.ok) expect(bad.error.code).toBe("unauthenticated");
    });
  });

  // -------------------------------------------------------------------------------------------
  describe("list_user_installations", () => {
    test("maps the schema, filters other Apps, never names another org, and asks GitHub on every call", async () => {
      const h = await harness();
      const alice = h.addUser("c-alice", {
        id: "1001",
        login: "alice",
        adminOf: ["acme"],
        installations: [
          {
            id: 100,
            app_id: 42,
            repository_selection: "all",
            account: { id: 7, login: "acme", type: "Organization" },
          },
          {
            id: 101,
            app_id: 42,
            repository_selection: "selected",
            account: { id: 1001, login: "alice", type: "User" },
          },
          {
            id: 102,
            app_id: 42,
            repository_selection: "selected",
            account: { id: 8, login: "foreign-gh", type: "Organization" },
          },
          {
            id: 103,
            app_id: 42,
            repository_selection: "selected",
            account: { id: 9, login: "mine-gh", type: "Organization" },
          },
          {
            id: 104,
            app_id: 999,
            repository_selection: "selected",
            account: { id: 10, login: "other-app", type: "Organization" },
          },
        ],
      });
      const u = await createUser(h.db, { displayName: "alice" });
      await h.db.run((q) =>
        q.orm
          .insert(schema.githubIdentities)
          .values({ githubUserId: "1001", userId: u.id, login: "alice" }),
      );
      await addMember(h.db, { orgId: h.tenant.id }, { userId: u.id, role: "viewer" });
      // 102 is bound to an org alice does not belong to; 103 to hers
      for (const [id, org, login] of [
        ["102", h.foreign.id, "foreign-gh"],
        ["103", h.tenant.id, "mine-gh"],
      ] as const) {
        await upsertInstallation(
          h.db,
          { orgId: org },
          {
            installationId: id,
            appId: "42",
            accountLogin: login,
            accountId: id,
            accountType: "Organization",
            repositorySelection: "selected",
            status: "active",
          },
        );
      }
      const si = await h.signIn("c-alice");
      const r = await h.as(si.cookie!, "list_user_installations");
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.output).toEqual({
        installations: [
          {
            installation_id: "100",
            account_login: "acme",
            account_type: "Organization",
            repository_selection: "all",
            bound: "none",
          },
          {
            installation_id: "101",
            account_login: "alice",
            account_type: "User",
            repository_selection: "selected",
            bound: "none",
          },
          {
            installation_id: "102",
            account_login: "foreign-gh",
            account_type: "Organization",
            repository_selection: "selected",
            bound: "other_org",
          },
          {
            installation_id: "103",
            account_login: "mine-gh",
            account_type: "Organization",
            repository_selection: "selected",
            bound: "this_org",
          },
        ],
      });
      // no slug of another org anywhere in the answer
      expect(JSON.stringify(r.output)).not.toContain(FOREIGN_SLUG);
      expect(JSON.stringify(r.output)).not.toContain("tenant");
      // fresh on every call: the fake's list changes and the very next call sees it
      const before = h.calls.installations;
      alice.installations = alice.installations.slice(0, 1);
      const r2 = await h.as(si.cookie!, "list_user_installations");
      expect(h.calls.installations).toBe(before + 1);
      expect(r2.ok && (r2.output as { installations: unknown[] }).installations.length).toBe(1);
    });
  });

  // -------------------------------------------------------------------------------------------
  describe("bind_installation", () => {
    async function binder(role: "owner" | "admin" | "viewer" | "member" = "admin") {
      const h = await harness();
      h.facts.installations.set("100", inst("100"));
      h.facts.repos.set("100", [repo("1", "api"), repo("2", "web")]);
      const alice = h.addUser("c-alice", {
        id: "1001",
        login: "alice",
        adminOf: ["acme"],
        installations: [
          {
            id: 100,
            app_id: 42,
            repository_selection: "selected",
            account: { id: 7, login: "acme", type: "Organization" },
          },
        ],
      });
      const u = await createUser(h.db, { displayName: "alice" });
      await h.db.run((q) =>
        q.orm
          .insert(schema.githubIdentities)
          .values({ githubUserId: "1001", userId: u.id, login: "alice" }),
      );
      await addMember(h.db, { orgId: h.tenant.id }, { userId: u.id, role });
      const si = await h.signIn("c-alice");
      const bind = (id = "100", cookie = si.cookie!) =>
        h.as(cookie, "bind_installation", { installation_id: id, org: "tenant" });
      return { h, alice, cookie: si.cookie!, bind, userId: u.id };
    }

    test("an installation absent from /user/installations is not found", async () => {
      const { h, bind } = await binder();
      const r = await bind("555");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("not_found");
      expect(await listProjects(h.db, { orgId: h.tenant.id })).toEqual([]);
    });

    test("an installation bound to another Turntable org is refused with the exact message and no slug", async () => {
      const { h, bind } = await binder();
      await upsertInstallation(
        h.db,
        { orgId: h.foreign.id },
        {
          installationId: "100",
          appId: "42",
          accountLogin: "acme",
          accountId: "7",
          accountType: "Organization",
          repositorySelection: "selected",
          status: "active",
        },
      );
      const r = await bind();
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.message).toBe(
          "this GitHub account is already connected to a different Turntable org; ask its owner",
        );
        expect(JSON.stringify(r.error)).not.toContain(FOREIGN_SLUG);
      }
      expect(await listProjects(h.db, { orgId: h.tenant.id })).toEqual([]);
      // the refusal is audited in the caller's own chain, without the other org
      const chain = await listAudit(h.db, { orgId: h.tenant.id });
      const row = chain.find((e) => e.op === "bind_installation");
      expect(row?.outcome).toBe("error:conflict");
      expect(JSON.stringify(chain)).not.toContain(FOREIGN_SLUG);
    });

    test("fresh each time: the list GitHub gives changes between two binds and the second sees it", async () => {
      const { h, alice, bind } = await binder();
      const held = alice.installations;
      alice.installations = []; // GitHub no longer lets this user reach it
      const first = await bind();
      expect(first.ok).toBe(false);
      if (!first.ok) expect(first.error.code).toBe("not_found");
      alice.installations = held;
      const second = await bind();
      expect(second.ok).toBe(true);
      expect(h.calls.installations).toBeGreaterThanOrEqual(2);
      // and a revoked access is seen too: bind once more after GitHub forgot the user
      alice.installations = [];
      const third = await bind();
      expect(third.ok).toBe(false);
    });

    test("access is not ownership: a member of the GitHub org who is not its admin is refused; a user account needs the same id", async () => {
      const { h, alice, bind } = await binder();
      alice.adminOf = []; // alice sees the installation but is only a member of acme
      const member = await bind();
      expect(member.ok).toBe(false);
      if (!member.ok) {
        expect(member.error.code).toBe("forbidden");
        expect(member.error.message).toBe(notInstallationOwnerMessage("acme"));
      }
      expect(await getInstallationRow(h, "100")).toBeUndefined();
      // a personal-account installation of someone else, visible to alice, is not hers
      h.facts.installations.set(
        "101",
        inst("101", "42", { account: { login: "bob", id: "2002", type: "User" } }),
      );
      alice.installations = [
        {
          id: 101,
          app_id: 42,
          repository_selection: "selected",
          account: { id: 2002, login: "bob", type: "User" },
        },
      ];
      const notHers = await bind("101");
      expect(notHers.ok).toBe(false);
      alice.installations = [
        {
          id: 101,
          app_id: 42,
          repository_selection: "selected",
          account: { id: 1001, login: "alice", type: "User" },
        },
      ];
      h.facts.installations.set(
        "101",
        inst("101", "42", { account: { login: "alice", id: "1001", type: "User" } }),
      );
      h.facts.repos.set("101", [repo("9", "dotfiles", "alice")]);
      expect((await bind("101")).ok).toBe(true);
    });

    test("only projects this bind creates start paused; existing projects keep every setting through a re-bind", async () => {
      const { h, bind } = await binder();
      const first = await bind();
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      expect(
        (first.output as { projects: { created: boolean }[] }).projects.map((p) => p.created),
      ).toEqual([true, true]);
      const rows = await listProjects(h.db, { orgId: h.tenant.id });
      expect(rows.map((p) => p.maxConcurrent)).toEqual([0, 0]);
      // the owner tunes one project and un-pauses it; another keeps its pause
      const api = rows.find((p) => p.slug === "api")!;
      await setProjectSandboxSettings(
        h.db,
        { orgId: h.tenant.id, projectId: api.id },
        {
          maxConcurrent: 7,
          sandboxSnapshot: "tuned-snapshot",
        },
      );
      const snapshot = await listProjects(h.db, { orgId: h.tenant.id });
      expect(snapshot.find((p) => p.slug === "api")).toMatchObject({
        maxConcurrent: 7,
        sandboxSnapshot: "tuned-snapshot",
      });
      // GitHub grants a third repo; bind again
      h.facts.repos.set("100", [repo("1", "api"), repo("2", "web"), repo("3", "docs")]);
      const again = await bind();
      expect(again.ok).toBe(true);
      if (!again.ok) return;
      const out = again.output as { projects: { slug: string; created: boolean }[] };
      expect(out.projects.map((p) => [p.slug, p.created]).toSorted()).toEqual([
        ["api", false],
        ["docs", true],
        ["web", false],
      ]);
      const after = await listProjects(h.db, { orgId: h.tenant.id });
      for (const before of snapshot) {
        expect(after.find((p) => p.id === before.id)).toEqual(before); // every column unchanged
      }
      expect(after.find((p) => p.slug === "docs")!.maxConcurrent).toBe(0);
    });

    test("only a signed-in owner or admin session can bind: a token, a member session and a viewer are refused", async () => {
      const { h, bind } = await binder("viewer");
      const viewer = await bind();
      expect(viewer.ok).toBe(false);
      for (const role of ["reader", "operator", "release_operator"] as const) {
        const t = await mintToken(h.db, { orgId: h.tenant.id }, role);
        const r = await dispatch(h.env, { kind: "bearer", token: t.secret }, "bind_installation", {
          installation_id: "100",
        });
        expect(r.ok).toBe(false);
      }
      const { h: h2, bind: bind2 } = await binder("admin");
      const tok = await mintToken(h2.db, { orgId: h2.tenant.id }, "release_operator");
      const viaToken = await dispatch(
        h2.env,
        { kind: "bearer", token: tok.secret },
        "bind_installation",
        { installation_id: "100" },
      );
      expect(viaToken.ok).toBe(false);
      const viaMcp = await dispatch(
        { ...h2.env, viaMcp: true },
        {
          kind: "principal",
          principal: { kind: "member", id: "m", orgId: h2.tenant.id, role: "owner" },
        },
        "bind_installation",
        { installation_id: "100" },
      );
      expect(viaMcp.ok).toBe(false);
      expect((await bind2()).ok).toBe(true);
    });

    test("is audited with the installation, its GitHub account and who bound it", async () => {
      const { h, bind, userId } = await binder("owner");
      expect((await bind()).ok).toBe(true);
      const chain = await listAudit(h.db, { orgId: h.tenant.id });
      const row = chain.find((e) => e.op === "bind_installation" && e.outcome === "ok");
      expect(row).toMatchObject({ principalKind: "session", principalId: userId });
      expect(JSON.parse(row!.input)).toMatchObject({
        installation_id: "100",
        account_login: "acme",
        created_projects: 2,
      });
      expect(await listMembershipsOfUser(h.db, userId)).toHaveLength(1);
    });
  });
});

const getInstallationRow = (h: { db: Db }, id: string) => getInstallation(h.db, id);
