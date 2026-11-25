// Onboarding lane A2, the claim side: a popup claim, the page it ends on, the live-feed event,
// get_installation_claim, replay and expiry, and the COOP header of the onboarding route. A fake
// GitHub stands behind the user verifier and the installation facts.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebSessions } from "../src/auth/web-sessions";
import {
  addMember,
  createOrg,
  createUser,
  type Db,
  listEvents,
  listProjects,
  openDatabase,
  schema,
} from "../src/db";
import { testDb } from "../src/db/dialect";
import { openPostgres } from "../src/db/pg";
import {
  CLAIM_PATH,
  claimCookieName,
  createClaimHandler,
  InstallationClaims,
} from "../src/github/claim";
import { dispatch, type DispatchEnv, registry } from "../src/ops";
import { notInstallationOwnerMessage } from "../src/github/claim";
import { handleRequest } from "../src/server";
import { registerUiAssets } from "../src/ui-assets";
import { fakeFacts, fakeUserVerifier, inst, ownerOf100, repo, setup } from "./github-helpers";
import { mintToken } from "./ops-helpers";

const ORIGIN = "https://ci.example.test";

const pgTarget = (): Parameters<typeof openPostgres>[0] => {
  const t = testDb();
  return t && t !== "pglite"
    ? { url: t, schema: `lstest_onbclaim_${process.pid}` }
    : { pglite: true };
};
const opened: Db[] = [];
const dialects: [string, () => Db][] = [
  ["sqlite", () => openDatabase(":memory:")],
  ["postgres", () => openPostgres(pgTarget(), { fresh: true })],
];
afterAll(() => {
  for (const db of opened) db.close();
  registerUiAssets(null);
});

describe.each(dialects)("onboarding claim popup (%s)", (_n, open) => {
  async function harness() {
    const s = await setup("42", open);
    opened.push(s.db);
    const tenant = await createOrg(s.db, { slug: "tenant", name: "Tenant" });
    const other = await createOrg(s.db, { slug: "other", name: "Other" });
    const f = fakeFacts();
    f.installations.set("100", inst("100"));
    f.repos.set("100", [repo("1", "api")]);
    let now = 1_700_000_000_000;
    const claims = new InstallationClaims({
      db: s.db,
      store: s.store,
      publicUrl: ORIGIN,
      now: () => now,
    });
    const users = new Map([
      ["code-owner", ownerOf100],
      [
        "code-member",
        // can reach the installation but does not own acme: access is not ownership
        { id: "55", login: "just-a-member", installations: ownerOf100.installations, adminOf: [] },
      ],
    ]);
    const handler = createClaimHandler({
      claims,
      facts: f.facts,
      user: fakeUserVerifier(users),
      log: () => {},
    });
    // Sessions: a cookie maps to a user holding a role in one org.
    const live: Record<string, { userId: string; hash: string }> = {};
    const mkSession = async (
      org: { id: string },
      role: "owner" | "admin" | "member",
      n: string,
    ) => {
      const u = await createUser(s.db, { displayName: n });
      await s.db.run((h) =>
        h.orm
          .insert(schema.githubIdentities)
          .values({ githubUserId: `gh-${n}`, userId: u.id, login: n }),
      );
      await addMember(s.db, { orgId: org.id }, { userId: u.id, role });
      const cookie = `cookie-${n}-aaaaaaaaaaaaaaaaaaaaaaaa`;
      live[cookie] = { userId: u.id, hash: `hash-${n}` };
      return cookie;
    };
    const env: DispatchEnv = {
      registry,
      db: s.db,
      claims,
      sessions: { resolve: async (c: string) => live[c] } as unknown as WebSessions,
      now: () => now,
    };
    const as = (cookie: string, op: string, input: Record<string, unknown> = {}) =>
      dispatch(env, { kind: "session", cookie }, op, input);
    const callback = async (q: Record<string, string>): Promise<Response> => {
      const nonce = q.nonce ?? "";
      const { nonce: _drop, ...rest } = q;
      return (await handler.handle(
        new Request(`http://x${CLAIM_PATH}?${new URLSearchParams(rest)}`, {
          headers: nonce ? { cookie: `${claimCookieName(nonce)}=${nonce}` } : {},
        }),
      ))!;
    };
    const stateOf = (url: string) => new URL(url, "http://x").searchParams.get("state")!;
    return {
      ...s,
      tenant,
      other,
      f,
      claims,
      env,
      as,
      mkSession,
      callback,
      stateOf,
      advance: (ms: number) => (now += ms),
    };
  }

  test("an owner or admin session may start a claim; a member may not; claim_id comes back", async () => {
    const h = await harness();
    const owner = await h.mkSession(h.tenant, "owner", "olive");
    const admin = await h.mkSession(h.tenant, "admin", "adam");
    const member = await h.mkSession(h.tenant, "member", "mia");
    for (const c of [owner, admin]) {
      const r = await h.as(c, "start_installation_claim", { popup: true });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const out = r.output as { url: string; claim_id: string; expires_at: number };
        expect(out.claim_id.startsWith("popup.")).toBe(true);
        expect(out.url).toContain("/api/v1/github/claim?state=");
      }
    }
    const plain = await h.as(owner, "start_installation_claim", {});
    expect(plain.ok && (plain.output as { claim_id: string }).claim_id.startsWith("popup.")).toBe(
      false,
    );
    const refused = await h.as(member, "start_installation_claim", { popup: true });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe("forbidden");
  });

  test("the popup callback posts to the instance origin only, closes, keeps the strict CSP, and emits the event", async () => {
    const h = await harness();
    const owner = await h.mkSession(h.tenant, "owner", "olive");
    const r = await h.as(owner, "start_installation_claim", { popup: true });
    if (!r.ok) throw new Error("start failed");
    const { url, claim_id } = r.output as { url: string; claim_id: string };
    const state = h.stateOf(url);
    const res = await h.callback({
      installation_id: "100",
      setup_action: "install",
      state,
      code: "code-owner",
      nonce: claim_id,
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    // the exact origin, never a wildcard
    expect(html).toContain(`postMessage(`);
    expect(html).toContain(JSON.stringify(ORIGIN));
    expect(html).not.toContain('"*"');
    expect(html).not.toContain("'*'");
    expect(html).toContain("window.close()");
    expect(html).toContain(`"type":"turntable.claim"`);
    expect(html).toContain(`"claim_id":${JSON.stringify(claim_id)}`);
    expect(html).toContain(`"state":"completed"`);
    // strict CSP: nothing but the one nonce'd script
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toContain("default-src 'none'");
    const nonce = /<script nonce="([^"]+)">/.exec(html)?.[1];
    expect(nonce).toBeDefined();
    expect(csp).toContain(`script-src 'nonce-${nonce}'`);
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");
    expect((html.match(/<script/g) ?? []).length).toBe(1);
    // the org's live feed hears it
    const ev = await listEvents(h.db, { orgId: h.tenant.id }, { after: 0, limit: 50 });
    const got = ev.filter((e) => e.type === "installation_claim.updated");
    expect(got.map((e) => JSON.parse(e.payload as string))).toEqual([
      { claim_id, state: "completed" },
    ]);
    // another org's feed does not
    expect(
      (await listEvents(h.db, { orgId: h.other.id }, { after: 0, limit: 50 })).filter(
        (e) => e.type === "installation_claim.updated",
      ),
    ).toEqual([]);
  });

  test("a claim that is not a popup ends on the plain page: no script, no postMessage", async () => {
    const h = await harness();
    const owner = await h.mkSession(h.tenant, "owner", "olive");
    const r = await h.as(owner, "start_installation_claim", {});
    if (!r.ok) throw new Error("start failed");
    const { url, claim_id } = r.output as { url: string; claim_id: string };
    const res = await h.callback({
      installation_id: "100",
      setup_action: "install",
      state: h.stateOf(url),
      code: "code-owner",
      nonce: claim_id,
    });
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain("<script");
    expect(res.headers.get("content-security-policy")).not.toContain("script-src");
  });

  test("get_installation_claim: pending, refused with a reason, then completed; another org's claim is not found", async () => {
    const h = await harness();
    const owner = await h.mkSession(h.tenant, "owner", "olive");
    const otherOwner = await h.mkSession(h.other, "owner", "otto");
    const r = await h.as(owner, "start_installation_claim", { popup: true });
    if (!r.ok) throw new Error("start failed");
    const { url, claim_id } = r.output as { url: string; claim_id: string };
    const state = h.stateOf(url);
    const get = (c: string, id = claim_id) => h.as(c, "get_installation_claim", { claim_id: id });
    expect((await get(owner)).ok && (await get(owner))).toMatchObject({
      output: { state: "pending" },
    });
    // a GitHub member who does not own the account is refused; the popup says so and stays open
    const bad = await h.callback({
      installation_id: "100",
      setup_action: "install",
      state,
      code: "code-member",
      nonce: claim_id,
    });
    expect(bad.status).toBe(403);
    const badHtml = await bad.text();
    expect(badHtml).toContain(`"state":"refused"`);
    expect(badHtml).not.toContain("window.close()");
    expect(badHtml).not.toContain('"*"');
    const refused = await get(owner);
    expect(refused.ok && refused.output).toMatchObject({
      state: "refused",
      reason: notInstallationOwnerMessage("acme"),
    });
    const feed = await listEvents(h.db, { orgId: h.tenant.id }, { after: 0, limit: 50 });
    expect(
      feed
        .filter((e) => e.type === "installation_claim.updated")
        .map((e) => JSON.parse(e.payload as string).state),
    ).toEqual(["refused"]);
    // the refusal did not spend the claim: the real owner can still finish it
    const ok = await h.callback({
      installation_id: "100",
      setup_action: "install",
      state,
      code: "code-owner",
      nonce: claim_id,
    });
    expect(ok.status).toBe(200);
    const done = await get(owner);
    expect(done.ok && done.output).toMatchObject({
      state: "completed",
      installation_id: "100",
      account_login: "acme",
    });
    // org `other` cannot read tenant's claim, and gets the same answer as for a missing one
    const foreign = await get(otherOwner);
    const missing = await get(otherOwner, "nope");
    expect(foreign.ok).toBe(false);
    expect(missing.ok).toBe(false);
    if (!foreign.ok && !missing.ok) {
      expect(foreign.error.code).toBe("not_found");
      expect(foreign.error.message).toBe(missing.error.message);
    }
    // a token at release_operator reads it; a reader token does not
    const rel = await mintToken(h.db, { orgId: h.tenant.id }, "release_operator");
    const rd = await mintToken(h.db, { orgId: h.tenant.id }, "reader");
    const viaToken = await dispatch(
      h.env,
      { kind: "bearer", token: rel.secret },
      "get_installation_claim",
      { claim_id },
    );
    expect(viaToken.ok && viaToken.output).toMatchObject({ state: "completed" });
    const viaReader = await dispatch(
      h.env,
      { kind: "bearer", token: rd.secret },
      "get_installation_claim",
      { claim_id },
    );
    expect(viaReader.ok).toBe(false);
  });

  test("the ownership refusal is one shared string: the popup path and bind_installation render it identically", () => {
    // bind_installation asserts this same function in onboarding-account.test.ts, so both paths match.
    expect(notInstallationOwnerMessage("acme")).toBe("you must be an owner of acme on GitHub");
  });

  test("a replayed state is refused, and an expired one too (the claim reads expired)", async () => {
    const h = await harness();
    const owner = await h.mkSession(h.tenant, "owner", "olive");
    const first = await h.as(owner, "start_installation_claim", { popup: true });
    if (!first.ok) throw new Error("start failed");
    const a = first.output as { url: string; claim_id: string };
    const q = {
      installation_id: "100",
      setup_action: "install",
      state: h.stateOf(a.url),
      code: "code-owner",
      nonce: a.claim_id,
    };
    expect((await h.callback(q)).status).toBe(200);
    expect((await h.callback(q)).status).toBe(400); // replay
    const second = await h.as(owner, "start_installation_claim", { popup: true });
    if (!second.ok) throw new Error("start failed");
    const b = second.output as { url: string; claim_id: string };
    h.advance(16 * 60_000);
    const late = await h.callback({ ...q, state: h.stateOf(b.url), nonce: b.claim_id });
    expect(late.status).toBe(400);
    const st = await h.as(owner, "get_installation_claim", { claim_id: b.claim_id });
    expect(st.ok && st.output).toMatchObject({ state: "expired" });
  });

  test("a popup claim and a plain claim create no project", async () => {
    const popup = await harness();
    const o1 = await popup.mkSession(popup.tenant, "owner", "olive");
    const r1 = await popup.as(o1, "start_installation_claim", { popup: true });
    if (!r1.ok) throw new Error("start failed");
    const a = r1.output as { url: string; claim_id: string };
    await popup.callback({
      installation_id: "100",
      setup_action: "install",
      state: popup.stateOf(a.url),
      code: "code-owner",
      nonce: a.claim_id,
    });
    // The claim records the installation and makes no project: a repo is added on purpose (#577).
    expect(await listProjects(popup.db, { orgId: popup.tenant.id })).toEqual([]);

    const plain = await harness();
    const o2 = await plain.mkSession(plain.tenant, "owner", "olive");
    const r2 = await plain.as(o2, "start_installation_claim", {});
    if (!r2.ok) throw new Error("start failed");
    const b = r2.output as { url: string; claim_id: string };
    await plain.callback({
      installation_id: "100",
      setup_action: "install",
      state: plain.stateOf(b.url),
      code: "code-owner",
      nonce: b.claim_id,
    });
    expect(await listProjects(plain.db, { orgId: plain.tenant.id })).toEqual([]);
  });
});

describe("the onboarding route", () => {
  test("is served with Cross-Origin-Opener-Policy: same-origin-allow-popups; other routes are not", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tt-ui-"));
    const index = join(dir, "index.html");
    writeFileSync(index, "<!doctype html><title>x</title>");
    registerUiAssets({ "/index.html": index });
    for (const path of ["/onboarding", "/onboarding/", "/onboarding/repos"]) {
      const res = await handleRequest(new Request(`${ORIGIN}${path}`));
      expect(res.status).toBe(200);
      expect(res.headers.get("cross-origin-opener-policy")).toBe("same-origin-allow-popups");
      // the page keeps the strict UI CSP
      expect(res.headers.get("content-security-policy")).toContain("script-src 'self'");
    }
    for (const path of ["/", "/runs", "/onboardingx"]) {
      const res = await handleRequest(new Request(`${ORIGIN}${path}`));
      expect(res.headers.get("cross-origin-opener-policy")).toBeNull();
    }
    registerUiAssets(null);
  });
});
