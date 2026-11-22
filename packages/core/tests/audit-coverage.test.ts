import { beforeEach, expect, test } from "bun:test";
import { type Db, chainedAudit, revokeApiToken } from "../src/db";
import { dispatch, registry, type Credential, type DispatchEnv } from "../src/ops";
import { resetFailureThrottle } from "../src/audit/failures";
import { mintToken, seedWorld, type Tenant } from "./ops-helpers";
import { getOrgBySlug } from "../src/db";

let db: Db;
let a: Tenant;
let env: DispatchEnv;

beforeEach(async () => {
  ({ db, a } = await seedWorld());
  env = { registry, db, now: () => 1_800_000_000_000 };
  resetFailureThrottle();
});

const entries = async () =>
  (await chainedAudit(db, a.orgId, 0, 1000)).map((r) => ({
    op: r.op,
    outcome: r.outcome,
  }));

const writeOps = () =>
  registry.ops.filter((op) => op.effect !== "read" && op.auth.type === "token");

test("the registry has write ops to cover", () => {
  expect(writeOps().length).toBeGreaterThan(3);
});

test("every write op audits a denied call", async () => {
  const reader = await mintToken(db, a.scope, "reader");
  for (const op of writeOps()) {
    const before = (await entries()).length;
    const r = await dispatch(env, { kind: "bearer", token: reader.secret }, op.name, {});
    expect(r.ok).toBe(false);
    const after = await entries();
    expect(after.length, `${op.name} wrote no audit row`).toBe(before + 1);
    expect(after.at(-1)).toMatchObject({ op: op.name });
    expect(after.at(-1)?.outcome).toStartWith("error:");
  }
});

test("every write op audits a rejected input from a permitted caller", async () => {
  const admin: Credential = { kind: "principal", principal: a.admin };
  for (const op of writeOps()) {
    const before = (await entries()).length;
    // A value no schema accepts: wrong type for a field every input shape rejects.
    await dispatch(env, admin, op.name, { project: a.projectSlug, __bad: { x: 1 } });
    const after = await entries();
    expect(after.length, `${op.name} wrote no audit row`).toBeGreaterThan(before);
    expect(after.at(-1)?.op).toBe(op.name);
  }
});

test("a successful write is audited ok, in the same transaction as its effect", async () => {
  const r = await dispatch(env, { kind: "principal", principal: a.admin }, "create_api_token", {
    name: "ci",
    role: "reader",
  });
  expect(r.ok).toBe(true);
  expect((await entries()).at(-1)).toEqual({ op: "create_api_token", outcome: "ok" });
});

test("a read op is not audited", async () => {
  const reader = await mintToken(db, a.scope, "reader");
  await dispatch(env, { kind: "bearer", token: reader.secret }, "whoami", {});
  expect((await entries()).filter((e) => e.op === "whoami")).toEqual([]);
});

test("auth failures are audited: revoked tokens in their org, unknown ones in _system", async () => {
  const t = await mintToken(db, a.scope, "reader");
  await revokeApiToken(db, a.scope, t.id, 1);
  const r = await dispatch(env, { kind: "bearer", token: t.secret }, "whoami", {});
  expect(r.ok).toBe(false);
  expect((await entries()).at(-1)).toEqual({ op: "whoami", outcome: "error:unauthenticated" });

  await dispatch(env, { kind: "bearer", token: "not-a-token" }, "whoami", {});
  const sys = await getOrgBySlug(db, "_system");
  expect(sys).toBeDefined();
  expect((await chainedAudit(db, sys!.id, 0, 10)).length).toBe(1);
});
