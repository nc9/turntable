import { beforeEach, expect, test } from "bun:test";
import { z } from "zod";
import { type Db, getOrgById, listAudit, revokeApiToken } from "../src/db";
import { AGENT_ROLES, MEMBER_ROLES } from "../src/db/schema";
import {
  createRegistry,
  defineOp,
  dispatch,
  type DispatchEnv,
  generateToken,
  hashToken,
  registry,
  ROLE_RANK,
  roleSatisfies,
  type Role,
} from "../src/ops";
import { ALL_ROLES } from "../src/ops/roles";
import { mintToken, seedWorld, type Tenant } from "./ops-helpers";

let db: Db;
let a: Tenant;
let b: Tenant;
let env: DispatchEnv;
const NOW = 1_800_000_000_000;

beforeEach(async () => {
  ({ db, a, b } = await seedWorld());
  env = { registry, db, now: () => NOW };
});

const call = (token: string, op: string, input: unknown = {}) =>
  dispatch(env, { kind: "bearer", token }, op, input);

test("every role has an explicit rank, and the ladder is what the docs say", () => {
  for (const role of ALL_ROLES) expect(ROLE_RANK[role]).toBeGreaterThan(0);
  expect(new Set(ALL_ROLES).size).toBe(AGENT_ROLES.length + MEMBER_ROLES.length);
  // every pair is defined and consistent with the ranks
  for (const held of ALL_ROLES) {
    for (const need of ALL_ROLES) {
      expect(roleSatisfies(held, need)).toBe(ROLE_RANK[held] >= ROLE_RANK[need]);
    }
  }
  const pairs: [Role, Role, boolean][] = [
    ["reader", "viewer", true],
    ["operator", "member", true],
    ["member", "operator", true],
    ["release_operator", "operator", true],
    ["operator", "release_operator", false],
    ["release_operator", "admin", false],
    ["admin", "release_operator", true],
    ["reader", "operator", false],
    ["viewer", "member", false],
    ["owner", "admin", true],
  ];
  for (const [held, need, ok] of pairs) expect(roleSatisfies(held, need)).toBe(ok);
  // no token role reaches admin: tokens can never manage tokens
  for (const role of AGENT_ROLES) expect(roleSatisfies(role, "admin")).toBe(false);
});

test("tokens: only a hash is stored, and bad tokens all look the same", async () => {
  const { secret, id } = await mintToken(db, a.scope, "reader");
  const ok = await call(secret, "list_runs");
  expect(ok.ok).toBe(true);

  const row = (await db.orm.select().from((await import("../src/db")).schema.apiTokens)).find(
    (r) => r.id === id,
  )!;
  expect(row.tokenHash).toBe(hashToken(secret));
  expect(JSON.stringify(row)).not.toContain(secret);

  const bads = [
    generateToken(), // well-formed but unknown
    "nope",
    "",
    `${secret.slice(0, -1)}x`,
  ];
  const messages = new Set<string>();
  for (const bad of bads) {
    const res = await call(bad, "list_runs");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("unauthenticated");
      messages.add(res.error.message);
    }
  }
  // revoked and expired are indistinguishable from unknown
  await revokeApiToken(db, a.scope, id, NOW);
  const revoked = await call(secret, "list_runs");
  if (!revoked.ok) messages.add(revoked.error.message);
  const expired = await mintToken(db, a.scope, "reader", { expiresAt: NOW - 1 });
  const exp = await call(expired.secret, "list_runs");
  if (!exp.ok) messages.add(exp.error.message);
  expect(revoked.ok).toBe(false);
  expect(exp.ok).toBe(false);
  expect(messages.size).toBe(1);
});

test("cross-tenant denial: org A's token cannot reach org B by slug, id or project", async () => {
  const { secret } = await mintToken(db, a.scope, "operator");
  const idInputs: [string, Record<string, unknown>][] = [
    ["get_run", { run_id: b.runId }],
    ["job_log", { job_id: b.jobId }],
    ["cancel", { run_id: b.runId }],
    ["checks_for_sha", { sha: "a".repeat(40) }],
    ["list_runs", {}],
  ];
  for (const [op, input] of idInputs) {
    // B's ids from A's token: not found (or empty), never B's data
    const res = await call(secret, op, input);
    if (op === "list_runs") {
      expect(res.ok && (res.output as { runs: { id: string }[] }).runs.map((r) => r.id)).toEqual([
        a.runId,
      ]);
    } else if (op === "checks_for_sha") {
      expect(res.ok && (res.output as { runs: { id: string }[] }).runs.map((r) => r.id)).toEqual([
        a.runId,
      ]);
    } else {
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe("not_found");
    }
    // naming B's org or project is the same error as naming one that does not exist
    const named = await call(secret, op, { ...input, org: b.slug });
    const ghost = await call(secret, op, { ...input, org: "no-such-org" });
    expect(named.ok).toBe(false);
    expect(ghost.ok).toBe(false);
    if (!named.ok && !ghost.ok) {
      expect(named.error.code).toBe("not_found");
      expect(named.error.message).toBe(ghost.error.message);
    }
  }
  // B's data is untouched
  expect(
    (await db.orm.select().from((await import("../src/db")).schema.jobs))
      .filter((j) => j.orgId === b.orgId)
      .map((j) => j.state),
  ).toEqual(["queued"]);
});

test("a project-scoped token is pinned to its project", async () => {
  // a second project in org A
  const { createProject, createRun } = await import("../src/db");
  const other = await createProject(db, { orgId: a.orgId }, { slug: "other", name: "Other" });
  const otherRun = await createRun(
    db,
    { orgId: a.orgId, projectId: other.id },
    { workflowPath: "w.yml", event: "push", ref: "main" },
  );
  const orgWide = await mintToken(db, { orgId: a.orgId }, "reader");
  const pinned = await mintToken(db, a.scope, "reader");

  const wide = await call(orgWide.secret, "list_runs");
  expect(wide.ok && (wide.output as { runs: unknown[] }).runs).toHaveLength(2);
  const narrowed = await call(orgWide.secret, "list_runs", { project: "other" });
  expect(
    narrowed.ok && (narrowed.output as { runs: { id: string }[] }).runs.map((r) => r.id),
  ).toEqual([otherRun.id]);

  const mine = await call(pinned.secret, "list_runs");
  expect(mine.ok && (mine.output as { runs: { id: string }[] }).runs.map((r) => r.id)).toEqual([
    a.runId,
  ]);
  const outside = await call(pinned.secret, "list_runs", { project: "other" });
  expect(!outside.ok && outside.error.code).toBe("not_found");
  const direct = await call(pinned.secret, "get_run", { run_id: otherRun.id });
  expect(!direct.ok && direct.error.code).toBe("not_found");
});

test("role denial: a reader cannot cancel, and the attempt is audited", async () => {
  const reader = await mintToken(db, a.scope, "reader");
  const res = await call(reader.secret, "cancel", { run_id: a.runId });
  expect(!res.ok && res.error.code).toBe("forbidden");
  const audit = await listAudit(db, { orgId: a.orgId });
  expect(audit.map((r) => [r.op, r.outcome, r.principalKind])).toEqual([
    ["cancel", "error:forbidden", "token"],
  ]);
  // an operator can
  const operator = await mintToken(db, a.scope, "operator");
  expect((await call(operator.secret, "cancel", { run_id: a.runId })).ok).toBe(true);
  // a reader still reads
  expect((await call(reader.secret, "get_run", { run_id: a.runId })).ok).toBe(true);
});

test("a reader token cannot create tokens, a non-admin member cannot, a member admin can", async () => {
  const reader = await mintToken(db, a.scope, "reader");
  const res = await call(reader.secret, "create_api_token", { name: "x", role: "reader" });
  expect(!res.ok && res.error.code).toBe("forbidden");
  const member = await dispatch(
    env,
    { kind: "principal", principal: { kind: "member", id: "m1", orgId: a.orgId, role: "member" } },
    "create_api_token",
    { name: "x", role: "reader" },
  );
  expect(!member.ok && member.error.code).toBe("forbidden");

  const made = await dispatch(env, { kind: "principal", principal: a.admin }, "create_api_token", {
    name: "ci-bot",
    role: "operator",
    project: "app",
    expires_in_days: 30,
  });
  expect(made.ok).toBe(true);
  if (!made.ok) return;
  const out = made.output as { token: string; project_id: string; expires_at: string; org: string };
  expect(out.project_id).toBe(a.projectId);
  expect(out.org).toBe("org-a");
  expect(out.expires_at).toBe(new Date(NOW + 30 * 86_400_000).toISOString());
  // the new token works, at its scope and role, and only its hash was stored
  const use = await call(out.token, "list_runs");
  expect(use.ok).toBe(true);
  const cancelOk = await call(out.token, "cancel", { run_id: a.runId });
  expect(cancelOk.ok).toBe(true);
  const rows = await db.orm.select().from((await import("../src/db")).schema.apiTokens);
  expect(rows.some((r) => JSON.stringify(r).includes(out.token))).toBe(false);
  // audit has the write, without the secret
  const audit = await listAudit(db, { orgId: a.orgId });
  const row = audit.find((r) => r.op === "create_api_token" && r.outcome === "ok")!;
  expect(row.principalKind).toBe("member");
  expect(row.input).not.toContain(out.token);
  // an admin of org A cannot mint into org B
  const cross = await dispatch(env, { kind: "principal", principal: a.admin }, "create_api_token", {
    name: "x",
    role: "reader",
    org: "org-b",
  });
  expect(!cross.ok && cross.error.code).toBe("not_found");
});

test("signature ops are refused for every principal and token, and absent from the token adapters", async () => {
  const approve = defineOp({
    name: "placeholder_release_approval",
    summary: "Placeholder human approval for tests.",
    description: "Test-only placeholder for a human, signed release approval; never shipped.",
    input: z.object({ release: z.string() }),
    output: z.object({ approved: z.boolean() }),
    effect: "write",
    auth: { type: "signature", minRole: "owner" },
    untrustedOutput: false,
    scope: "org",
    http: { method: "POST", path: "/placeholder-approvals" },
    async handler() {
      throw new Error("must never run");
    },
  });
  const testRegistry = createRegistry([...registry.ops, approve]);
  const testEnv: DispatchEnv = { registry: testRegistry, db, now: () => NOW };
  const token = await mintToken(db, a.scope, "release_operator");

  const viaToken = await dispatch(
    testEnv,
    { kind: "bearer", token: token.secret },
    "placeholder_release_approval",
    { release: "1" },
  );
  expect(!viaToken.ok && viaToken.error.code).toBe("signature_required");
  const viaOwner = await dispatch(
    testEnv,
    { kind: "principal", principal: { kind: "member", id: "o", orgId: a.orgId, role: "owner" } },
    "placeholder_release_approval",
    { release: "1" },
  );
  expect(!viaOwner.ok && viaOwner.error.code).toBe("signature_required");

  // adapters
  expect(testRegistry.tokenOps().map((o) => o.name)).not.toContain("placeholder_release_approval");
  const { mcpTools } = await import("../src/ops/mcp");
  const { buildOpenApi } = await import("../src/ops/openapi");
  const { createRestApi } = await import("../src/ops/rest");
  expect(mcpTools(testRegistry).map((t) => t.name)).not.toContain("placeholder_release_approval");
  expect(JSON.stringify(buildOpenApi(testRegistry, "x"))).not.toContain(
    "placeholder_release_approval",
  );
  const res = await createRestApi(testEnv)(
    new Request("http://x/api/v1/placeholder-approvals", {
      method: "POST",
      headers: { authorization: `Bearer ${token.secret}` },
      body: JSON.stringify({ release: "1" }),
    }),
  );
  // A signature op that takes no signed statement (a placeholder, sign_release) has no REST route.
  expect(res?.status).toBe(404);
  // The signed path is the only one that reaches a signature op, and only with a valid statement.
  const unsigned = await dispatch(testEnv, { kind: "signed" }, "placeholder_release_approval", {
    release: "1",
  });
  expect(!unsigned.ok && unsigned.error.code).toBe("invalid_input");
  // Token ops refuse a signed credential.
  const wrongWay = await dispatch(testEnv, { kind: "signed" }, "list_runs", {});
  expect(!wrongWay.ok && wrongWay.error.code).toBe("forbidden");
  // #664: the shipped approve_approval_policy (a signed approver statement) is refused for tokens,
  // owners and sessions alike; only a signed credential reaches it, and the token adapters omit it.
  const apTok = await mintToken(db, a.scope, "release_operator");
  const apViaToken = await dispatch(
    env,
    { kind: "bearer", token: apTok.secret },
    "approve_approval_policy",
    { statement: {}, signature: {} },
  );
  expect(!apViaToken.ok && apViaToken.error.code).toBe("signature_required");
  const apViaOwner = await dispatch(
    env,
    { kind: "principal", principal: { kind: "member", id: "o", orgId: a.orgId, role: "owner" } },
    "approve_approval_policy",
    { statement: {}, signature: {} },
  );
  expect(!apViaOwner.ok && apViaOwner.error.code).toBe("signature_required");
  expect(registry.tokenOps().map((o) => o.name)).not.toContain("approve_approval_policy");
  expect(mcpTools(registry).map((t) => t.name)).not.toContain("approve_approval_policy");
  // The shipped registry's signature ops: the human approvals, and sign_release (a refusal).
  expect(
    registry.ops
      .filter((o) => o.auth.type === "signature")
      .map((o) => o.name)
      .toSorted(),
  ).toEqual([
    "approve_approval_policy",
    "approve_enrolment",
    "approve_environment",
    "approve_key_policy",
    "approve_release",
    "sign_release",
  ]);
});

test("input is strict and validated; output is validated and stripped", async () => {
  const { secret } = await mintToken(db, a.scope, "reader");
  const typo = await call(secret, "list_runs", { brnach: "main" });
  expect(!typo.ok && typo.error.code).toBe("invalid_input");
  const bad = await call(secret, "list_runs", { limit: 1000 });
  expect(!bad.ok && bad.error.code).toBe("invalid_input");
  const notObject = await call(secret, "list_runs", [1]);
  expect(!notObject.ok && notObject.error.code).toBe("invalid_input");
  const badCursor = await call(secret, "list_runs", { cursor: "garbage" });
  expect(!badCursor.ok && badCursor.error.code).toBe("invalid_input");

  const leaky = defineOp({
    name: "leaky",
    summary: "Returns more than its schema declares.",
    description: "Test op whose handler returns an undeclared field; the dispatcher must strip it.",
    input: z.object({}),
    output: z.object({ ok: z.boolean() }),
    effect: "read",
    auth: { type: "token", minRole: "reader" },
    untrustedOutput: false,
    scope: "org",
    http: { method: "GET", path: "/leaky" },
    handler: async () => ({ ok: true, hidden: "do-not-leak" }) as { ok: boolean },
  });
  const broken = defineOp({
    name: "broken",
    summary: "Returns the wrong shape.",
    description: "Test op whose handler violates its output schema; the call must fail closed.",
    input: z.object({}),
    output: z.object({ ok: z.boolean() }),
    effect: "read",
    auth: { type: "token", minRole: "reader" },
    untrustedOutput: false,
    scope: "org",
    http: { method: "GET", path: "/broken" },
    handler: async () => ({ ok: "yes-secret-value" }) as unknown as { ok: boolean },
  });
  const e2: DispatchEnv = { registry: createRegistry([leaky, broken]), db, now: () => NOW };
  const stripped = await dispatch(e2, { kind: "bearer", token: secret }, "leaky", {});
  expect(stripped.ok && stripped.output).toEqual({ ok: true });
  const bro = await dispatch(e2, { kind: "bearer", token: secret }, "broken", {});
  expect(!bro.ok && bro.error.code).toBe("internal");
  expect(JSON.stringify(bro)).not.toContain("yes-secret-value");
});

test("a failing write rolls back and is audited; a project op needs a project", async () => {
  const boom = defineOp({
    name: "boom",
    summary: "Writes then fails.",
    description: "Test op that writes a row and then throws; the write must roll back.",
    input: z.object({}),
    output: z.object({}),
    effect: "write",
    auth: { type: "token", minRole: "operator" },
    untrustedOutput: false,
    scope: "project",
    http: { method: "POST", path: "/boom" },
    async handler(ctx) {
      const { createRun } = await import("../src/db");
      await createRun(ctx.db, ctx.scope as Required<typeof ctx.scope>, {
        workflowPath: "x",
        event: "e",
        ref: "r",
      });
      throw new Error("after write");
    },
  });
  const e3: DispatchEnv = { registry: createRegistry([boom]), db, now: () => NOW };
  const org = await mintToken(db, { orgId: a.orgId }, "operator");
  const noProject = await dispatch(e3, { kind: "bearer", token: org.secret }, "boom", {});
  expect(!noProject.ok && noProject.error.code).toBe("invalid_input");

  const before = (await (await import("../src/db")).listRuns(db, a.scope)).length;
  const res = await dispatch(e3, { kind: "bearer", token: org.secret }, "boom", { project: "app" });
  expect(!res.ok && res.error.code).toBe("internal");
  expect((await (await import("../src/db")).listRuns(db, a.scope)).length).toBe(before);
  const audit = await listAudit(db, { orgId: a.orgId });
  expect(audit.some((r) => r.op === "boom" && r.outcome === "error:internal")).toBe(true);
  void getOrgById;
});

test("an op's auditDetail can never un-redact a secret or omitted input field", async () => {
  const value = `v-${crypto.randomUUID()}`;
  const make = (name: string, outside: boolean, field: "secretInputFields" | "logOmitFields") =>
    defineOp({
      name,
      summary: "Echoes a colliding detail key.",
      description: "Test op whose auditDetail reuses the name of a redacted input field.",
      input: z.object({ token: z.string() }),
      output: z.object({}),
      effect: "write",
      auth: { type: "token", minRole: "operator" },
      untrustedOutput: false,
      scope: "org",
      http: { method: "POST", path: `/${name}` },
      [field]: ["token"],
      ...(outside ? { outsideTransaction: true } : {}),
      auditDetail: () => ({ token: value, extra: "kept" }),
      async handler() {
        return {};
      },
    });
  const ops = [
    make("leak_secret_tx", false, "secretInputFields"),
    make("leak_secret_out", true, "secretInputFields"),
    make("leak_omit_tx", false, "logOmitFields"),
    make("leak_omit_out", true, "logOmitFields"),
  ];
  const e = { registry: createRegistry(ops), db, now: () => NOW };
  const { secret } = await mintToken(db, { orgId: a.orgId }, "operator");
  const warn = console.warn;
  const warnings: string[] = [];
  console.warn = (m: string) => void warnings.push(m);
  try {
    for (const op of ops) {
      const res = await dispatch(e, { kind: "bearer", token: secret }, op.name, {
        token: "input-secret",
      });
      expect(res.ok).toBe(true);
    }
  } finally {
    console.warn = warn;
  }
  const rows = await listAudit(db, { orgId: a.orgId });
  const text = JSON.stringify(rows);
  expect(text).not.toContain(value);
  expect(text).not.toContain("input-secret");
  for (const op of ops) {
    const row = rows.find((r) => r.op === op.name)!;
    const input = JSON.parse(row.input as string);
    expect(input.token).toBe(op.name.includes("secret") ? "[redacted]" : "[omitted]");
    expect(input.extra).toBe("kept");
  }
  expect(warnings.length).toBe(4);
  expect(warnings.join("\n")).toContain('"token"');
  expect(warnings.join("\n")).not.toContain(value);
});

test("an auditDetail key naming an optional secret field is dropped even when the input omits it", async () => {
  const value = `v-${crypto.randomUUID()}`;
  const make = (name: string, outside: boolean) =>
    defineOp({
      name,
      summary: "Echoes an optional secret field the input left out.",
      description: "Test op whose optional token is absent from the input but named by its detail.",
      input: z.object({ token: z.string().optional() }),
      output: z.object({}),
      effect: "write",
      auth: { type: "token", minRole: "operator" },
      untrustedOutput: false,
      scope: "org",
      http: { method: "POST", path: `/${name}` },
      secretInputFields: ["token"],
      ...(outside ? { outsideTransaction: true } : {}),
      auditDetail: () => ({ token: value, extra: "kept" }),
      async handler() {
        return {};
      },
    });
  const ops = [make("leak_optional_tx", false), make("leak_optional_out", true)];
  const e = { registry: createRegistry(ops), db, now: () => NOW };
  const { secret } = await mintToken(db, { orgId: a.orgId }, "operator");
  const warn = console.warn;
  const warnings: string[] = [];
  console.warn = (m: string) => void warnings.push(m);
  try {
    for (const op of ops) {
      const res = await dispatch(e, { kind: "bearer", token: secret }, op.name, {});
      expect(res.ok).toBe(true);
    }
  } finally {
    console.warn = warn;
  }
  const rows = await listAudit(db, { orgId: a.orgId });
  expect(JSON.stringify(rows)).not.toContain(value);
  for (const op of ops) {
    const input = JSON.parse(rows.find((r) => r.op === op.name)!.input as string);
    expect("token" in input).toBe(false);
    expect(input.extra).toBe("kept");
  }
  expect(warnings.length).toBe(2);
  expect(warnings.join("\n")).not.toContain(value);
});

test("sign_release is a signature op: no token of any role can reach it, over any adapter", async () => {
  const input = { run_id: a.runId, artifacts: ["x.bin"], environment: "production" };
  for (const role of ["reader", "operator", "release_operator"] as const) {
    const { secret } = await mintToken(db, a.scope, role);
    const res = await call(secret, "sign_release", input);
    expect(!res.ok && res.error.code).toBe("signature_required");
  }
  // An in-process member principal is refused too: it carries no signature either.
  const viaMember = await dispatch(
    env,
    { kind: "principal", principal: a.admin },
    "sign_release",
    input,
  );
  expect(!viaMember.ok && viaMember.error.code).toBe("signature_required");
  expect(registry.tokenOps().map((o) => o.name)).not.toContain("sign_release");
  expect(registry.documentedOps().map((o) => o.name)).not.toContain("sign_release");
  const { mcpTools } = await import("../src/ops/mcp");
  expect(mcpTools(registry).map((t) => t.name)).not.toContain("sign_release");
  const { buildOpenApi } = await import("../src/ops/openapi");
  expect(JSON.stringify(buildOpenApi(registry, "x"))).not.toContain("sign_release");
  const { createRestApi } = await import("../src/ops/rest");
  const { secret } = await mintToken(db, a.scope, "release_operator");
  const rest = await createRestApi(env)(
    new Request(`http://x/api/v1/runs/${a.runId}/sign`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}` },
      body: JSON.stringify(input),
    }),
  );
  expect(rest?.status).toBe(404);
});
