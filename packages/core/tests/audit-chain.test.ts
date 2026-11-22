import { beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson, entryHash, GENESIS_HASH } from "../src/audit/chain";
import {
  AUDIT_KEY_SECRET,
  checkpointDue,
  createCheckpoint,
  ensureAuditKey,
} from "../src/audit/checkpoint";
import { exportOrg, jsonlSink, webhookSink, type AuditSink } from "../src/audit/export";
import {
  auditFailure,
  FAILURE_LIMIT,
  FAILURE_WINDOW_MS,
  resetFailureThrottle,
} from "../src/audit/failures";
import { verifyAudit } from "../src/audit/verify";
import { type Db, appendAudit, chainedAudit, listCheckpoints, getOrgBySlug } from "../src/db";
import * as s from "../src/db/schema";
import { SecretStore } from "../src/secrets/store";
import { seedWorld, type Tenant } from "./ops-helpers";
import { and, eq, gte } from "drizzle-orm";

let db: Db;
let a: Tenant;
let b: Tenant;
let store: SecretStore;

const add = (t: Tenant, op = "test_op", outcome = "ok") =>
  appendAudit(db, t.scope, {
    principalKind: "member",
    principalId: "m1",
    op,
    effect: "write",
    outcome,
    input: { n: op },
  });

const keysOf = async (t: Tenant) => {
  const k = await ensureAuditKey(store, t.orgId);
  return new Map([[k.keyId, k.publicKeyPem]]);
};

beforeEach(async () => {
  ({ db, a, b } = await seedWorld());
  store = new SecretStore(db, randomBytes(32));
  resetFailureThrottle();
});

describe("chain", () => {
  test("canonical json sorts keys and skips undefined", () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: undefined }] })).toBe('{"a":[2,{"d":1}],"b":1}');
  });

  test("entries link, per org, from genesis", async () => {
    await add(a);
    await add(a);
    await add(b);
    const rows = await chainedAudit(db, a.orgId, 0, 10);
    expect(rows.map((r) => r.seq)).toEqual([1, 2]);
    expect(rows[0]?.prevHash).toBe(GENESIS_HASH);
    expect(rows[1]?.prevHash).toBe(rows[0]?.hash as string);
    expect((await chainedAudit(db, b.orgId, 0, 10)).length).toBe(1);
    expect(entryHash(GENESIS_HASH, { ...rows[0]!, seq: 1 } as never)).toBeString();
  });

  test("concurrent appends never share a position", async () => {
    await Promise.all(Array.from({ length: 20 }, () => add(a)));
    const rows = await chainedAudit(db, a.orgId, 0, 50);
    expect(rows.map((r) => r.seq)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect((await verifyAudit(db, a.orgId, await keysOf(a))).ok).toBe(true);
  });
});

describe("verify", () => {
  test("clean chain with a checkpoint verifies", async () => {
    for (let i = 0; i < 5; i++) await add(a);
    await createCheckpoint(db, store, a.orgId);
    const r = await verifyAudit(db, a.orgId, await keysOf(a));
    expect(r).toMatchObject({ ok: true, entries: 6, checkpoints: 1, headSeq: 6, unsignedTail: 0 });
  });

  test("tail after the last checkpoint is reported, not failed", async () => {
    for (let i = 0; i < 3; i++) await add(a);
    await createCheckpoint(db, store, a.orgId);
    await add(a);
    const r = await verifyAudit(db, a.orgId, await keysOf(a));
    expect(r.ok).toBe(true);
    expect(r.unsignedTail).toBe(1);
  });

  test("an edited field breaks the chain", async () => {
    for (let i = 0; i < 4; i++) await add(a);
    await db.orm
      .update(s.auditLog)
      .set({ outcome: "error:forbidden" })
      .where(and(eq(s.auditLog.orgId, a.orgId), eq(s.auditLog.seq, 2)));
    const r = await verifyAudit(db, a.orgId, await keysOf(a));
    expect(r.ok).toBe(false);
    expect(r.problems.join("\n")).toMatch(/2/);
  });

  test("a deleted middle entry is detected", async () => {
    for (let i = 0; i < 4; i++) await add(a);
    await db.orm
      .delete(s.auditLog)
      .where(and(eq(s.auditLog.orgId, a.orgId), eq(s.auditLog.seq, 2)));
    expect((await verifyAudit(db, a.orgId, await keysOf(a))).ok).toBe(false);
  });

  test("truncating entries a checkpoint covers is detected", async () => {
    for (let i = 0; i < 5; i++) await add(a);
    await createCheckpoint(db, store, a.orgId);
    await db.orm
      .delete(s.auditLog)
      .where(and(eq(s.auditLog.orgId, a.orgId), gte(s.auditLog.seq, 5)));
    expect((await verifyAudit(db, a.orgId, await keysOf(a))).ok).toBe(false);
  });

  test("a rewritten tail with recomputed hashes fails the checkpoint", async () => {
    for (let i = 0; i < 3; i++) await add(a);
    await createCheckpoint(db, store, a.orgId);
    const [row] = await chainedAudit(db, a.orgId, 2, 1);
    const tampered = { ...row!, outcome: "ok-but-rewritten" };
    const { hash: _h, prevHash: _p, ...rest } = tampered;
    await db.orm
      .update(s.auditLog)
      .set({ outcome: tampered.outcome, hash: entryHash(row!.prevHash as string, rest as never) })
      .where(eq(s.auditLog.id, row!.id));
    const r = await verifyAudit(db, a.orgId, await keysOf(a));
    expect(r.ok).toBe(false);
  });

  test("a forged checkpoint signature and an unknown key both fail", async () => {
    for (let i = 0; i < 2; i++) await add(a);
    const cp = (await createCheckpoint(db, store, a.orgId))!;
    const good = await keysOf(a);
    await db.orm
      .update(s.auditCheckpoints)
      .set({ signature: Buffer.alloc(64).toString("base64") })
      .where(and(eq(s.auditCheckpoints.orgId, a.orgId), eq(s.auditCheckpoints.seq, cp.seq)));
    expect((await verifyAudit(db, a.orgId, good)).ok).toBe(false);
    expect((await verifyAudit(db, a.orgId, new Map())).ok).toBe(false);
  });

  test("orgs are independent", async () => {
    await add(a);
    await add(b);
    await db.orm.delete(s.auditLog).where(eq(s.auditLog.orgId, a.orgId));
    expect((await verifyAudit(db, b.orgId, await keysOf(b))).ok).toBe(true);
  });
});

describe("checkpoints", () => {
  test("the key lives in the secret store, per org", async () => {
    const k1 = await ensureAuditKey(store, a.orgId);
    expect((await ensureAuditKey(store, a.orgId)).keyId).toBe(k1.keyId);
    expect((await ensureAuditKey(store, b.orgId)).keyId).not.toBe(k1.keyId);
    expect(await store.get(a.orgId, AUDIT_KEY_SECRET)).toContain("PRIVATE KEY");
  });

  test("due by entry count or by age, never twice for the same head", async () => {
    let now = 1_000_000;
    for (let i = 0; i < 3; i++) await add(a);
    expect(await checkpointDue(db, store, { everyEntries: 5, everyMs: 60_000 }, () => now)).toBe(1); // no checkpoint yet: age is infinite
    expect(await checkpointDue(db, store, { everyEntries: 5, everyMs: 60_000 }, () => now)).toBe(0);
    await add(a);
    expect(await checkpointDue(db, store, { everyEntries: 5, everyMs: 60_000 }, () => now)).toBe(0);
    now += 61_000;
    expect(await checkpointDue(db, store, { everyEntries: 5, everyMs: 60_000 }, () => now)).toBe(1);
    for (let i = 0; i < 5; i++) await add(a);
    expect(await checkpointDue(db, store, { everyEntries: 5, everyMs: 60_000 }, () => now)).toBe(1);
    expect((await listCheckpoints(db, a.orgId)).map((c) => c.seq)).toEqual([4, 5, 10]);
  });
});

describe("export", () => {
  const memory = () => {
    const batches: unknown[][] = [];
    let fail = false;
    const sink: AuditSink = {
      name: "memory",
      async write(_org, lines) {
        if (fail) throw new Error("down");
        batches.push([...lines]);
      },
    };
    return { sink, batches, setFail: (f: boolean) => (fail = f) };
  };

  test("cursor advances only on success; retry resends the same batch; no duplicates after", async () => {
    for (let i = 0; i < 3; i++) await add(a);
    const m = memory();
    const org = { id: a.orgId, slug: a.slug };
    m.setFail(true);
    await expect(exportOrg(db, m.sink, org)).rejects.toThrow("down");
    m.setFail(false);
    expect(await exportOrg(db, m.sink, org)).toBe(3);
    expect(await exportOrg(db, m.sink, org)).toBe(0);
    await add(a);
    expect(await exportOrg(db, m.sink, org)).toBe(1);
    expect(m.batches.flat().length).toBe(4);
  });

  test("checkpoints go out once, after the entries they cover", async () => {
    for (let i = 0; i < 2; i++) await add(a);
    const m = memory();
    const org = { id: a.orgId, slug: a.slug };
    await exportOrg(db, m.sink, org);
    await createCheckpoint(db, store, a.orgId);
    await exportOrg(db, m.sink, org);
    await exportOrg(db, m.sink, org);
    const kinds = m.batches.flat().map((l) => (l as { type: string }).type);
    expect(kinds.filter((k) => k === "checkpoint").length).toBe(1);
  });

  test("jsonl sink writes owner-only files and rotates by size", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ls-audit-"));
    try {
      for (let i = 0; i < 6; i++) await add(a);
      let t = 1;
      const sink = jsonlSink(dir, { maxBytes: 600, now: () => t++ });
      const org = { id: a.orgId, slug: a.slug };
      await exportOrg(db, sink, org, { batch: 2 });
      const files = readdirSync(dir);
      expect(files.length).toBeGreaterThan(1);
      const lines = files
        .flatMap((f) => readFileSync(join(dir, f), "utf8").trim().split("\n"))
        .map((l) => JSON.parse(l) as { seq: number });
      expect(lines.map((l) => l.seq).sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5, 6]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("webhook sink signs the body and fails on a non-2xx", async () => {
    await add(a);
    const seen: { body: string; sig: string }[] = [];
    let status = 200;
    const fake = (async (_u: string, init: { body: string; headers: Record<string, string> }) => {
      seen.push({ body: init.body, sig: init.headers["x-longshore-signature"] ?? "" });
      return new Response("", { status });
    }) as never;
    const sink = webhookSink("https://audit.example.com/in", { secret: "k", fetch: fake });
    const org = { id: a.orgId, slug: a.slug };
    status = 500;
    await expect(exportOrg(db, sink, org)).rejects.toThrow("500");
    status = 200;
    expect(await exportOrg(db, sink, org)).toBe(1);
    expect(seen.at(-1)?.sig).toMatch(/^sha256=[0-9a-f]{64}$/);
    const { createHmac } = await import("node:crypto");
    expect(seen.at(-1)?.sig).toBe(
      `sha256=${createHmac("sha256", "k").update(seen.at(-1)!.body).digest("hex")}`,
    );
  });
});

describe("failure auditing", () => {
  const fail = (orgId: string | undefined, now: () => number) =>
    auditFailure(
      db,
      {
        orgId,
        principalKind: "token",
        principalId: "x",
        op: "o",
        outcome: "error:unauthenticated",
      },
      now,
    );

  test("unattributable failures land in the _system org", async () => {
    await fail(undefined, () => 1);
    const sys = await getOrgBySlug(db, "_system");
    expect(sys).toBeDefined();
    expect((await chainedAudit(db, sys!.id, 0, 10)).length).toBe(1);
  });

  test("throttled per chain per window, then resumes", async () => {
    for (let i = 0; i < FAILURE_LIMIT + 20; i++) await fail(a.orgId, () => 1000);
    expect((await chainedAudit(db, a.orgId, 0, 500)).length).toBe(FAILURE_LIMIT);
    await fail(a.orgId, () => 1000 + FAILURE_WINDOW_MS + 1);
    expect((await chainedAudit(db, a.orgId, 0, 500)).length).toBe(FAILURE_LIMIT + 1);
    await fail(b.orgId, () => 1000);
    expect((await chainedAudit(db, b.orgId, 0, 500)).length).toBe(1);
  });
});
