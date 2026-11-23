// instance_audit_verify (#393): the chain of an org checked against exported anchors with no
// shell. ok, rolled back, mismatch, a forged signature, refusal for org tokens and MCP, the cap.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, gt } from "drizzle-orm";
import { AuditAnchor } from "../src/audit/anchor";
import { createCheckpoint, initAuditKey } from "../src/audit/checkpoint";
import { systemOrgId } from "../src/audit/failures";
import { appendAudit, type Db, listAudit } from "../src/db";
import * as s from "../src/db/schema";
import { createInstanceTokenFromCli } from "../src/ops/instance-token-cli";
import { mcpTools } from "../src/ops/mcp";
import { dispatch, type DispatchEnv, registry } from "../src/ops";
import { SecretStore } from "../src/secrets/store";
import { AUDIT_VERIFY_MAX_ANCHORS } from "../src/ops/definitions/instance";
import { mintToken, seedWorld, type Tenant } from "./ops-helpers";

const tmp = mkdtempSync(join(tmpdir(), "tt-audit-verify-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let db: Db;
let a: Tenant;
let env: DispatchEnv;
let secret: string;
let store: SecretStore;
let signed: Record<string, unknown>[];

const append = async (orgId: string, n: number): Promise<void> => {
  for (let i = 0; i < n; i++) {
    await appendAudit(
      db,
      { orgId },
      {
        principalKind: "member",
        principalId: "m",
        op: "x",
        effect: "write",
        outcome: "ok",
        input: { i },
      },
    );
  }
};

beforeEach(async () => {
  ({ db, a } = await seedWorld());
  const masterKey = randomBytes(32);
  store = new SecretStore(db, masterKey);
  const anchor = new AuditAnchor(join(tmp, randomBytes(4).toString("hex")), masterKey);
  await initAuditKey(db, store, anchor, a.orgId);
  await append(a.orgId, 3);
  const first = await createCheckpoint(db, store, anchor, a.orgId);
  await append(a.orgId, 3);
  const second = await createCheckpoint(db, store, anchor, a.orgId);
  signed = [first, second].map((c) => ({
    version: 1,
    org_id: c!.orgId,
    sequence: c!.seq,
    head_hash: c!.hash,
    time: c!.signedAt,
    signature: c!.signature,
  }));
  env = { registry, db, allowInstance: true, auditStore: store };
  secret = (await createInstanceTokenFromCli(db, { name: "ops laptop" })).secret;
});

const verify = (anchors: unknown[], e: DispatchEnv = env) =>
  dispatch(e, { kind: "bearer", token: secret }, "instance_audit_verify", { anchors });

const resultOf = async (anchors: unknown[]): Promise<string | undefined> => {
  const r = await verify(anchors);
  expect(r.ok).toBe(true);
  return r.ok ? (r.output as { orgs: { result: string }[] }).orgs[0]?.result : undefined;
};

describe("instance_audit_verify", () => {
  test("ok: the chain matches every anchor", async () => {
    const r = await verify(signed);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const out = r.output as { orgs: { org_id: string; result: string; anchors: number }[] };
      expect(out.orgs).toEqual([
        expect.objectContaining({ org_id: a.orgId, result: "ok", anchors: 2 }),
      ]);
    }
  });

  test("rolled back: the chain ends behind a signed anchor", async () => {
    await db.orm
      .delete(s.auditLog)
      .where(and(eq(s.auditLog.orgId, a.orgId), gt(s.auditLog.seq, 4)));
    expect(await resultOf(signed)).toBe("rolled_back");
  });

  test("mismatch: a modified entry", async () => {
    await db.orm
      .update(s.auditLog)
      .set({ outcome: "tampered" })
      .where(and(eq(s.auditLog.orgId, a.orgId), eq(s.auditLog.seq, 2)));
    expect(await resultOf(signed)).toBe("mismatch");
  });

  test("mismatch: an anchor hash that disagrees with the chain", async () => {
    const bad = signed.map((x) => ({ ...x, head_hash: "0".repeat(64) }));
    expect(await resultOf(bad)).toBe("mismatch");
  });

  test("a forged signature is a mismatch, and an unknown org is too", async () => {
    const [first] = signed;
    const sig = String(first!.signature);
    const forged = { ...first!, signature: `${sig[0] === "A" ? "B" : "A"}${sig.slice(1)}` };
    expect(await resultOf([forged])).toBe("mismatch");
    const unknown = await verify([{ ...first!, org_id: "nosuchorg" }]);
    expect(unknown.ok && (unknown.output as { orgs: { result: string }[] }).orgs[0]?.result).toBe(
      "mismatch",
    );
  });

  test("the answer is a fixed sentence and the call is audited as a read in the system chain", async () => {
    const r = await verify(signed);
    expect(r.ok && JSON.stringify(r.output)).toContain("Every anchor matches the chain");
    const rows = await listAudit(db, { orgId: await systemOrgId(db) }, { limit: 100 });
    const mine = rows.filter((x) => x.op === "instance_audit_verify");
    expect(mine.length).toBe(1);
    expect(mine[0]?.effect).toBe("read");
  });

  test("refused for org tokens of every role and on MCP", async () => {
    for (const role of s.AGENT_ROLES) {
      const t = (await mintToken(db, { orgId: a.orgId }, role)).secret;
      const r = await dispatch(env, { kind: "bearer", token: t }, "instance_audit_verify", {
        anchors: signed,
      });
      expect(r.ok, role).toBe(false);
      if (!r.ok) expect(r.error.code, role).toBe("forbidden");
    }
    const op = registry.ops.find((o) => o.name === "instance_audit_verify")!;
    expect(op.mcp).toBe(false);
    expect(op.effect).toBe("read");
    expect(mcpTools(registry).map((t) => t.name)).not.toContain("instance_audit_verify");
    const plain = await dispatch(
      { registry, db, auditStore: store },
      { kind: "bearer", token: secret },
      "instance_audit_verify",
      { anchors: signed },
    );
    expect(!plain.ok && plain.error.code).toBe("unauthenticated");
  });

  test("the input is capped, and empty input is refused", async () => {
    const one = signed[0]!;
    const over = Array.from({ length: AUDIT_VERIFY_MAX_ANCHORS + 1 }, () => one);
    const r = await verify(over);
    expect(!r.ok && r.error.code).toBe("invalid_input");
    const none = await verify([]);
    expect(!none.ok && none.error.code).toBe("invalid_input");
    const atCap = await verify(Array.from({ length: AUDIT_VERIFY_MAX_ANCHORS }, () => one));
    expect(atCap.ok).toBe(true);
  });

  test("without a secret store it is unavailable", async () => {
    const r = await verify(signed, { registry, db, allowInstance: true });
    expect(!r.ok && r.error.code).toBe("unavailable");
  });
});
