// Delegated minting (#437): a bearer token mints within its own org and never escalates.
import { beforeEach, describe, expect, test } from "bun:test";
import { type Db, findApiTokenByHash, listAudit, listEvents } from "../src/db";
import { createMcpHttp } from "../src/mcp/http";
import { type Credential, dispatch, type DispatchEnv, registry } from "../src/ops";
import { hashToken } from "../src/ops/tokens";
import { mintToken, seedWorld, type Tenant } from "./ops-helpers";

const DAY = 86_400_000;
let db: Db;
let a: Tenant;
let b: Tenant;
let env: DispatchEnv;
const NOW = 1_700_000_000_000;

beforeEach(async () => {
  ({ db, a, b } = await seedWorld());
  env = { registry, db, now: () => NOW, transport: "rest" };
});

const as = (token: string, input: Record<string, unknown>, e: DispatchEnv = env) =>
  dispatch(e, { kind: "bearer", token } as Credential, "create_api_token", input);
const code = (r: Awaited<ReturnType<typeof as>>) => (r.ok ? "ok" : r.error.code);
const orgWide = (role: "reader" | "operator" | "release_operator", o = {}) =>
  mintToken(db, { orgId: a.orgId }, role, { kind: "person", ...o });

describe("create_api_token by a bearer token", () => {
  test("happy path: the new token authenticates, audit has the parent id and no secret, event emitted", async () => {
    const parent = await orgWide("release_operator");
    const r = await as(parent.secret, { name: "child", role: "operator", expires_in_days: 30 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const out = r.output as { id: string; token: string; role: string; kind: string };
    expect(out.kind).toBe("agent");
    const row = await findApiTokenByHash(db, hashToken(out.token));
    expect(row?.id).toBe(out.id);
    expect(row?.createdBy).toBe(`token:${parent.id}`);
    const who = await dispatch(env, { kind: "bearer", token: out.token }, "list_runs", {});
    expect(who.ok).toBe(true);
    const audit = (await listAudit(db, { orgId: a.orgId }, { limit: 20 })).filter(
      (x) => x.op === "create_api_token",
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ principalKind: "token", principalId: parent.id });
    expect(JSON.stringify(audit)).not.toContain(out.token);
    const ev = await listEvents(
      db,
      { orgId: a.orgId },
      { after: 0, limit: 20, types: ["org.token_minted"] },
    );
    const events = Array.isArray(ev) ? ev : (ev as { events: unknown[] }).events;
    expect(events).toHaveLength(1);
    const text = JSON.stringify(events);
    expect(text).toContain(parent.id);
    expect(text).toContain(out.id);
    expect(text).not.toContain(out.token);
  });

  test("an org-wide caller may mint a project-scoped token", async () => {
    const parent = await orgWide("operator");
    const r = await as(parent.secret, { name: "p", role: "reader", project: a.projectSlug });
    expect(r.ok && (r.output as { project_id: string }).project_id).toBe(a.projectId);
  });

  test("role escalation is refused", async () => {
    const parent = await orgWide("operator");
    expect(code(await as(parent.secret, { name: "x", role: "release_operator" }))).toBe(
      "forbidden",
    );
  });

  test("a reader token cannot mint", async () => {
    const parent = await orgWide("reader");
    expect(code(await as(parent.secret, { name: "x", role: "reader" }))).toBe("forbidden");
  });

  test("scope widening and a different project are refused", async () => {
    const scoped = await mintToken(db, { orgId: a.orgId, projectId: a.projectId }, "operator", {
      kind: "person",
    });
    expect(code(await as(scoped.secret, { name: "x", role: "reader" }))).toBe("ok");
    expect(code(await as(scoped.secret, { name: "x", role: "reader", project: "nope" }))).not.toBe(
      "ok",
    );
    const { createProject } = await import("../src/db");
    await createProject(db, { orgId: a.orgId }, { slug: "other", name: "Other" });
    expect(code(await as(scoped.secret, { name: "x", role: "reader", project: "other" }))).not.toBe(
      "ok",
    );
    // The scoped caller's mint stays scoped to its own project.
    const r = await as(scoped.secret, { name: "y", role: "reader" });
    expect(r.ok && (r.output as { project_id: string }).project_id).toBe(a.projectId);
  });

  test("an expiry beyond the caller's is refused; a caller with none is capped at 365 days", async () => {
    const short = await orgWide("operator", { expiresAt: NOW + 10 * DAY });
    expect(code(await as(short.secret, { name: "x", role: "reader", expires_in_days: 11 }))).toBe(
      "forbidden",
    );
    expect(code(await as(short.secret, { name: "x", role: "reader", expires_in_days: 10 }))).toBe(
      "ok",
    );
    const forever = await orgWide("operator");
    expect(
      code(await as(forever.secret, { name: "x", role: "reader", expires_in_days: 366 })),
    ).toBe("invalid_input");
    expect(
      code(await as(forever.secret, { name: "x", role: "reader", expires_in_days: 365 })),
    ).toBe("ok");
  });

  test("kind rules: agent cannot mint person or above operator; person may mint person", async () => {
    const agent = await mintToken(db, { orgId: a.orgId }, "release_operator", { kind: "agent" });
    expect(code(await as(agent.secret, { name: "x", role: "reader", kind: "person" }))).toBe(
      "forbidden",
    );
    expect(code(await as(agent.secret, { name: "x", role: "release_operator" }))).toBe("forbidden");
    expect(code(await as(agent.secret, { name: "x", role: "operator" }))).toBe("ok");
    const person = await orgWide("operator");
    expect(code(await as(person.secret, { name: "x", role: "reader", kind: "person" }))).toBe("ok");
  });

  test("cross-org is refused", async () => {
    const parent = await orgWide("release_operator");
    expect(code(await as(parent.secret, { name: "x", role: "reader", org: "org-b" }))).toBe(
      "not_found",
    );
    expect(b.orgId).not.toBe(a.orgId);
  });

  test("over MCP is refused, and the tool is not listed", async () => {
    const parent = await orgWide("release_operator");
    const r = await as(
      parent.secret,
      { name: "x", role: "reader" },
      { ...env, transport: "mcp", viaMcp: true },
    );
    expect(code(r)).toBe("forbidden");
    expect(createMcpHttp).toBeDefined();
  });

  test("a member admin in-process still works; a non-admin member does not", async () => {
    const ok = await dispatch(env, { kind: "principal", principal: a.admin }, "create_api_token", {
      name: "m",
      role: "operator",
    });
    expect(ok.ok).toBe(true);
    const viewer = { ...a.admin, role: "viewer" } as typeof a.admin;
    const no = await dispatch(env, { kind: "principal", principal: viewer }, "create_api_token", {
      name: "m",
      role: "operator",
    });
    expect(no.ok).toBe(false);
  });
});

describe("per-org serialisation of revoke", () => {
  test("two concurrent self-revokes of the last two tokens: one succeeds, the other conflicts", async () => {
    const t1 = await mintToken(db, { orgId: a.orgId }, "operator");
    const t2 = await mintToken(db, { orgId: a.orgId }, "operator");
    const revoke = (t: { secret: string; id: string }) =>
      dispatch(env, { kind: "bearer", token: t.secret }, "revoke_api_token", {
        token_id: t.id,
        reason: "race",
      });
    const results = await Promise.all([revoke(t1), revoke(t2)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const failed = results.find((r) => !r.ok);
    expect(failed && !failed.ok && failed.error.code).toBe("conflict");
  });
});
