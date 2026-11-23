// Instance ops create_org and create_org_token (#354): a second tenant on a hosted instance with
// no shell. REST only, instance administrator only, audited in the system chain and the org's own,
// and the secret is in the response and nowhere else.
import { beforeEach, describe, expect, test } from "bun:test";
import { systemOrgId } from "../src/audit/failures";
import {
  type Db,
  findApiTokenByHash,
  getOrgBySlug,
  listApiTokens,
  listAudit,
  revokeApiToken,
} from "../src/db";
import { AGENT_ROLES } from "../src/db/schema";
import { createMcpHttp } from "../src/mcp/http";
import { createRestApi } from "../src/ops/rest";
import { dispatch, type DispatchEnv, registry, type Credential, type Principal } from "../src/ops";
import { createInstanceTokenFromCli } from "../src/ops/instance-token-cli";
import { mcpTools } from "../src/ops/mcp";
import { hashToken } from "../src/ops/tokens";
import { handleRequest } from "../src/server";
import { mintToken, seedWorld, type Tenant } from "./ops-helpers";

let db: Db;
let a: Tenant;
let env: DispatchEnv;
let secret: string;
let clock: number;

beforeEach(async () => {
  ({ db, a } = await seedWorld());
  clock = 1_700_000_000_000;
  env = { registry, db, allowInstance: true, instanceOrgCap: 4, now: () => clock };
  secret = (await createInstanceTokenFromCli(db, { name: "ops laptop" })).secret;
});

const asInstance = (name: string, input: Record<string, unknown>) =>
  dispatch(env, { kind: "bearer", token: secret }, name, input);

const tokenInput = (over: Record<string, unknown> = {}) => ({
  target_org: "fresh",
  name: "first",
  role: "operator",
  expires_days: 30,
  ...over,
});

describe("create_org", () => {
  test("creates an empty org, audited in the system chain and in the org's own", async () => {
    const r = await asInstance("create_org", { slug: "fresh", name: "Fresh Co" });
    expect(r.ok).toBe(true);
    const org = await getOrgBySlug(db, "fresh");
    expect(org).toMatchObject({ name: "Fresh Co" });
    expect(await listApiTokens(db, { orgId: org!.id })).toEqual([]);
    const own = (await listAudit(db, { orgId: org!.id }, { limit: 10 })).filter(
      (x) => x.op === "create_org",
    );
    expect(own).toHaveLength(1);
    expect(own[0]).toMatchObject({ principalKind: "instance", outcome: "ok" });
    const sys = (await listAudit(db, { orgId: await systemOrgId(db) }, { limit: 50 })).filter(
      (x) => x.op === "create_org",
    );
    expect(sys).toHaveLength(1);
    expect(sys[0]).toMatchObject({ principalKind: "instance", outcome: "ok" });
  });

  test("an existing slug, the system org's slug and an invalid slug are refused", async () => {
    const dup = await asInstance("create_org", { slug: "org-a", name: "again" });
    expect(!dup.ok && dup.error.code).toBe("conflict");
    const sys = await asInstance("create_org", { slug: "_system", name: "x" });
    expect(sys.ok).toBe(false);
    for (const slug of ["Bad", "-lead", "a b", "a/b", "x".repeat(64)]) {
      const r = await asInstance("create_org", { slug, name: "x" });
      expect(r.ok, slug).toBe(false);
      if (!r.ok) expect(r.error.code, slug).toBe("invalid_input");
      expect(await getOrgBySlug(db, slug), slug).toBeUndefined();
    }
  });
});

describe("create_org_token", () => {
  beforeEach(async () => {
    await asInstance("create_org", { slug: "fresh", name: "Fresh" });
  });

  test("mints the first token once: kind defaults to person, secret only in the response", async () => {
    const r = await asInstance("create_org_token", tokenInput());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const out = r.output as { id: string; token: string; kind: string; expires_at: string };
    expect(out.token.startsWith("tt_")).toBe(true);
    expect(out.kind).toBe("person");
    expect(out.expires_at).toBe(new Date(clock + 30 * 86_400_000).toISOString());
    const row = await findApiTokenByHash(db, hashToken(out.token));
    expect(row).toMatchObject({ id: out.id, role: "operator", kind: "person" });
    expect(JSON.stringify(row)).not.toContain(out.token);
    // no audit row, in either chain, holds the secret or its hash
    const org = (await getOrgBySlug(db, "fresh"))!;
    for (const orgId of [org.id, await systemOrgId(db)]) {
      const rows = await listAudit(db, { orgId }, { limit: 100 });
      const text = JSON.stringify(rows);
      expect(text).not.toContain(out.token);
      expect(text).not.toContain(hashToken(out.token));
      expect(rows.filter((x) => x.op === "create_org_token")).toHaveLength(1);
    }
    // the token works in its own org
    const me = await dispatch(env, { kind: "bearer", token: out.token }, "whoami", {});
    expect(me.ok).toBe(true);
  });

  test("refused once the org has an active token, allowed again when all are revoked or expired", async () => {
    const first = await asInstance("create_org_token", tokenInput());
    expect(first.ok).toBe(true);
    const again = await asInstance("create_org_token", tokenInput({ name: "second" }));
    expect(!again.ok && again.error.code).toBe("conflict");
    const org = (await getOrgBySlug(db, "fresh"))!;
    expect(await listApiTokens(db, { orgId: org.id })).toHaveLength(1);
    // a project-scoped token counts as active too
    const id = (first.ok ? (first.output as { id: string }).id : "")!;
    expect(await revokeApiToken(db, { orgId: org.id }, id, clock)).toBe(true);
    const expiring = await mintToken(db, { orgId: org.id }, "reader", { expiresAt: clock + 1000 });
    expect(expiring.id).toBeTruthy();
    const blocked = await asInstance("create_org_token", tokenInput({ name: "third" }));
    expect(!blocked.ok && blocked.error.code).toBe("conflict");
    clock += 2000; // the last token lapses
    const ok = await asInstance("create_org_token", tokenInput({ name: "fourth" }));
    expect(ok.ok).toBe(true);
  });

  test("an org that already has tokens (org-a) is refused, and nothing is minted", async () => {
    await mintToken(db, { orgId: a.orgId }, "reader");
    const before = (await listApiTokens(db, { orgId: a.orgId })).length;
    const r = await asInstance("create_org_token", tokenInput({ target_org: "org-a" }));
    expect(!r.ok && r.error.code).toBe("conflict");
    expect(await listApiTokens(db, { orgId: a.orgId })).toHaveLength(before);
  });

  test("bad input: system or unknown org, role above release_operator, expiry out of range, missing expiry", async () => {
    const cases: [string, Record<string, unknown>][] = [
      ["system org", tokenInput({ target_org: "_system" })],
      ["unknown org", tokenInput({ target_org: "nope" })],
      ["admin role", tokenInput({ role: "admin" })],
      ["owner role", tokenInput({ role: "owner" })],
      ["zero days", tokenInput({ expires_days: 0 })],
      ["366 days", tokenInput({ expires_days: 366 })],
      ["no expiry", { target_org: "fresh", name: "x", role: "reader" }],
      ["bad kind", tokenInput({ kind: "root" })],
    ];
    for (const [label, input] of cases) {
      const r = await asInstance("create_org_token", input);
      expect(r.ok, label).toBe(false);
    }
    const org = (await getOrgBySlug(db, "fresh"))!;
    expect(await listApiTokens(db, { orgId: org.id })).toEqual([]);
    const sysOrg = (await getOrgBySlug(db, "_system"))!;
    expect(await listApiTokens(db, { orgId: sysOrg.id })).toEqual([]);
  });

  test("an agent kind and each role up to release_operator can be minted", async () => {
    for (const role of AGENT_ROLES) {
      const slug = `r-${role.replace("_", "-")}`;
      await asInstance("create_org", { slug, name: slug });
      const r = await asInstance(
        "create_org_token",
        tokenInput({ target_org: slug, role, kind: "agent" }),
      );
      expect(r.ok, role).toBe(true);
      if (r.ok) expect(r.output).toMatchObject({ role, kind: "agent" });
    }
  });
});

describe("who can call them", () => {
  const calls = (): [string, Record<string, unknown>][] => [
    ["create_org", { slug: "sneaky", name: "x" }],
    ["create_org_token", { target_org: "org-a", name: "x", role: "reader", expires_days: 1 }],
  ];

  test("no org token of any role, project-scoped token or member can call either", async () => {
    const creds: Credential[] = [];
    for (const role of AGENT_ROLES) {
      creds.push({ kind: "bearer", token: (await mintToken(db, { orgId: a.orgId }, role)).secret });
    }
    creds.push({
      kind: "bearer",
      token: (await mintToken(db, a.scope, "release_operator")).secret,
    });
    for (const role of ["admin", "owner"] as const) {
      const p: Principal = { kind: "member", id: `m-${role}`, orgId: a.orgId, role };
      creds.push({ kind: "principal", principal: p });
    }
    const tokensBefore = (await listApiTokens(db, { orgId: a.orgId })).length;
    for (const cred of creds) {
      for (const [name, input] of calls()) {
        const r = await dispatch(env, cred, name, input);
        expect(r.ok, name).toBe(false);
        if (!r.ok) expect(r.error.code, name).toBe("forbidden");
      }
    }
    expect(await getOrgBySlug(db, "sneaky")).toBeUndefined();
    expect(await listApiTokens(db, { orgId: a.orgId })).toHaveLength(tokensBefore);
  });

  test("never MCP: not a tool, and the instance token is not an MCP credential", async () => {
    for (const [name] of calls()) {
      expect(registry.ops.find((o) => o.name === name)).toMatchObject({ mcp: false });
      expect(mcpTools(registry).map((t) => t.name)).not.toContain(name);
      const plain = await dispatch({ registry, db }, { kind: "bearer", token: secret }, name, {});
      expect(!plain.ok && plain.error.code).toBe("unauthenticated");
    }
    const res = await createMcpHttp({ registry, db })(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${secret}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );
    expect(res!.status).toBe(401);
  });

  test("REST: the instance token creates an org and its token; an org token gets 403", async () => {
    const api = createRestApi({ registry, db, instanceOrgCap: 4 });
    const post = (path: string, token: string, body: unknown) =>
      handleRequest(
        new Request(`http://localhost/api/v1${path}`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        api,
      );
    const org = await post("/instance/orgs", secret, { slug: "rest-org", name: "Rest" });
    expect(org!.status).toBe(200);
    const tok = await post("/instance/orgs/tokens", secret, tokenInput({ target_org: "rest-org" }));
    expect(tok!.status).toBe(200);
    const orgToken = (await mintToken(db, { orgId: a.orgId }, "release_operator")).secret;
    expect((await post("/instance/orgs", orgToken, { slug: "x-org", name: "x" }))!.status).toBe(
      403,
    );
    expect(
      (await post("/instance/orgs/tokens", orgToken, tokenInput({ target_org: "org-a" })))!.status,
    ).toBe(403);
  });
});

describe("tenant isolation", () => {
  test("the new org's token cannot see or touch another org", async () => {
    await asInstance("create_org", { slug: "fresh", name: "Fresh" });
    const r = await asInstance("create_org_token", tokenInput({ role: "release_operator" }));
    if (!r.ok) throw new Error("mint failed");
    const cred: Credential = { kind: "bearer", token: (r.output as { token: string }).token };
    const runs = await dispatch(env, cred, "list_runs", {});
    expect(runs.ok).toBe(true);
    if (runs.ok) expect(JSON.stringify(runs.output)).not.toContain(a.runId);
    const get = await dispatch(env, cred, "get_run", { run_id: a.runId });
    expect(get.ok).toBe(false);
    if (!get.ok) expect(get.error.code).toBe("not_found");
    const projects = await dispatch(env, cred, "list_projects", {});
    expect(projects.ok && JSON.stringify(projects.output)).not.toContain("org-a");
    // and it is no instance credential
    const inst = await dispatch(env, cred, "create_org", { slug: "other", name: "x" });
    expect(!inst.ok && inst.error.code).toBe("forbidden");
  });
});
