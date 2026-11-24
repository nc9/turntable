// Instance op instance_start_installation_claim (#442): the operator starts the org claim for a
// tenant whose own tokens cannot. Same state, nonce, expiry and OAuth ownership check as the org
// op, REST and tti_ only, audited in the system chain and the org's own, with an event to the org.
import { afterAll, describe, expect, test } from "bun:test";
import { systemOrgId } from "../src/audit/failures";
import {
  createOrg,
  type Db,
  getInstallation,
  getInstallationClaim,
  listAudit,
  listEvents,
  openDatabase,
} from "../src/db";
import { openPostgres } from "../src/db/pg";
import { testDb } from "../src/db/dialect";
import {
  CLAIM_COOKIE,
  CLAIM_PATH,
  CLAIM_TTL_MS,
  InstallationClaims,
  createClaimHandler,
} from "../src/github/claim";
import { dispatch, type DispatchEnv, registry } from "../src/ops";
import { createInstanceTokenFromCli } from "../src/ops/instance-token-cli";
import { mcpTools } from "../src/ops/mcp";
import { fakeFacts, fakeUserVerifier, inst, ownerOf100, repo, setup } from "./github-helpers";
import { mintToken } from "./ops-helpers";

const pgTarget = (): Parameters<typeof openPostgres>[0] => {
  const t = testDb();
  return t && t !== "pglite"
    ? { url: t, schema: `lstest_instclaim_${process.pid}` }
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

describe.each(dialects)("instance_start_installation_claim (%s)", (_n, open) => {
  async function harness() {
    const s = await setup("42", open);
    opened.push(s.db);
    const tenant = await createOrg(s.db, { slug: "tenant-b", name: "Tenant B" });
    const f = fakeFacts();
    f.installations.set("100", inst("100"));
    f.repos.set("100", [repo("1", "api")]);
    let now = 1_700_000_000_000;
    const claims = new InstallationClaims({ db: s.db, store: s.store, now: () => now });
    const users = new Map([
      ["code-b", ownerOf100],
      ["code-x", { ...ownerOf100, id: "50", login: "someone-else" }],
    ]);
    const handler = createClaimHandler({
      claims,
      facts: f.facts,
      user: fakeUserVerifier(users),
      log: () => {},
    });
    const env: DispatchEnv = {
      registry,
      db: s.db,
      claims,
      allowInstance: true,
      instanceOrgCap: 4,
      now: () => now,
    };
    const tti = (await createInstanceTokenFromCli(s.db, { name: "ops" })).secret;
    const start = (input: Record<string, unknown>) =>
      dispatch(env, { kind: "bearer", token: tti }, "instance_start_installation_claim", {
        target_org: "tenant-b",
        github_login: "owner-b",
        reason: "tenant has no release_operator token",
        ...input,
      });
    const stateOf = (url: string): string => new URL(url, "http://x").searchParams.get("state")!;
    const payloadOf = (state: string): { o: string; p: string; n: string } =>
      JSON.parse(Buffer.from(state.split(".")[1] ?? "", "base64url").toString());
    const callback = async (q: Record<string, string>): Promise<Response> =>
      (await handler.handle(
        new Request(`http://x${CLAIM_PATH}?${new URLSearchParams(q)}`, {
          headers: { cookie: `${CLAIM_COOKIE}=${payloadOf(q.state!).n}` },
        }),
      ))!;
    return {
      ...s,
      tenant,
      env,
      tti,
      start,
      stateOf,
      payloadOf,
      callback,
      advance: (ms: number) => (now += ms),
    };
  }

  test("happy path: the state binds the TARGET org, by the instance principal, for that login", async () => {
    const h = await harness();
    const r = await h.start({});
    expect(r.ok).toBe(true);
    const out = (r as { output: { url: string; expires_at: number } }).output;
    expect(out.url).toContain("/api/v1/github/claim?state=");
    expect(out.expires_at).toBe(1_700_000_000_000 + CLAIM_TTL_MS);
    const state = h.stateOf(out.url);
    const p = h.payloadOf(state);
    expect(p.o).toBe(h.tenant.id);
    expect(p.p.startsWith("instance:")).toBe(true);
    expect(await getInstallationClaim(h.db, p.n)).toMatchObject({
      orgId: h.tenant.id,
      expectedLogin: "owner-b",
      installationId: null,
      usedAt: null,
    });
    // the named GitHub user completes it, and the installation lands in the target org
    const done = await h.callback({
      installation_id: "100",
      setup_action: "install",
      state,
      code: "code-b",
    });
    expect(done.status).toBe(200);
    expect((await getInstallation(h.db, "100"))?.orgId).toBe(h.tenant.id);
  });

  test("a wrong login completing it is refused and binds nothing", async () => {
    const h = await harness();
    const state = h.stateOf(((await h.start({})) as { output: { url: string } }).output.url);
    const q = { installation_id: "100", setup_action: "install", state };
    expect((await h.callback({ ...q, code: "code-x" })).status).toBe(403);
    expect(await getInstallation(h.db, "100")).toBeUndefined();
  });

  test("expired is refused", async () => {
    const h = await harness();
    const state = h.stateOf(((await h.start({})) as { output: { url: string } }).output.url);
    h.advance(CLAIM_TTL_MS + 1);
    const res = await h.callback({
      installation_id: "100",
      setup_action: "install",
      state,
      code: "code-b",
    });
    expect(res.status).toBe(400);
    expect(await getInstallation(h.db, "100")).toBeUndefined();
  });

  test("an installation_id pin: a different installation is refused, the pinned one is claimed", async () => {
    const h = await harness();
    const r = await h.start({ installation_id: "100" });
    expect(r.ok).toBe(true);
    const state = h.stateOf((r as { output: { url: string } }).output.url);
    expect(await getInstallationClaim(h.db, h.payloadOf(state).n)).toMatchObject({
      installationId: "100",
    });
    const mismatch = await h.callback({
      installation_id: "200",
      setup_action: "update",
      state,
      code: "code-b",
    });
    expect(mismatch.status).toBe(400);
    expect(await getInstallation(h.db, "200")).toBeUndefined();
    expect(await getInstallation(h.db, "100")).toBeUndefined();
    const ok = await h.callback({
      installation_id: "100",
      setup_action: "install",
      state,
      code: "code-b",
    });
    expect(ok.status).toBe(200);
    expect((await getInstallation(h.db, "100"))?.orgId).toBe(h.tenant.id);
  });

  test("a non-tti token is refused, whatever its role", async () => {
    const h = await harness();
    for (const role of ["operator", "release_operator"] as const) {
      const t = (await mintToken(h.db, { orgId: h.tenant.id }, role)).secret;
      const r = await dispatch(
        h.env,
        { kind: "bearer", token: t },
        "instance_start_installation_claim",
        {
          target_org: "tenant-b",
          github_login: "owner-b",
          reason: "x",
        },
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("forbidden");
    }
    // and the instance adapter flag is off: a tti_ token is not even a credential
    const off = await dispatch(
      { ...h.env, allowInstance: false },
      { kind: "bearer", token: h.tti },
      "instance_start_installation_claim",
      { target_org: "tenant-b", github_login: "owner-b", reason: "x" },
    );
    expect(off.ok).toBe(false);
  });

  test("not an MCP tool", async () => {
    const h = await harness();
    expect(registry.mcpOps().map((o) => o.name)).not.toContain("instance_start_installation_claim");
    expect(mcpTools(registry).map((t) => t.name)).not.toContain(
      "instance_start_installation_claim",
    );
    void h;
  });

  test("the system org, an unknown org and a missing login or reason are refused", async () => {
    const h = await harness();
    const sys = await h.start({ target_org: "system" });
    expect(!sys.ok && sys.error.code).toBe("not_found");
    const none = await h.start({ target_org: "no-such-org" });
    expect(!none.ok && none.error.code).toBe("not_found");
    expect((await h.start({ github_login: undefined })).ok).toBe(false);
    expect((await h.start({ reason: undefined })).ok).toBe(false);
    expect((await h.start({ github_login: "bad login!" })).ok).toBe(false);
  });

  test("both audit entries and the org event exist", async () => {
    const h = await harness();
    expect((await h.start({ installation_id: "100" })).ok).toBe(true);
    const mine = (rows: Awaited<ReturnType<typeof listAudit>>) =>
      rows.filter((r) => r.op === "instance_start_installation_claim");
    const sys = mine(await listAudit(h.db, { orgId: await systemOrgId(h.db) }));
    expect(sys).toHaveLength(1);
    expect(sys[0]).toMatchObject({ principalKind: "instance", outcome: "ok" });
    const own = mine(await listAudit(h.db, { orgId: h.tenant.id }));
    expect(own).toHaveLength(1);
    expect(JSON.parse(own[0]!.input)).toMatchObject({
      target_org: "tenant-b",
      github_login: "owner-b",
      installation_pinned: true,
      reason: "tenant has no release_operator token",
    });
    const events = await listEvents(
      h.db,
      { orgId: h.tenant.id },
      { after: 0, limit: 20, types: ["org.installation_claim_started_by_instance"] },
    );
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]!.payload)).toMatchObject({
      github_login: "owner-b",
      reason: "tenant has no release_operator token",
      installation_pinned: true,
    });
  });
});
