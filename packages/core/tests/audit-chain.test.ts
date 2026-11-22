import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditAnchor } from "../src/audit/anchor";
import { canonicalJson, entryHash, GENESIS_HASH } from "../src/audit/chain";
import {
  AUDIT_KEY_SECRET,
  AuditAlreadyInitialised,
  checkpointDue,
  createCheckpoint,
  initAuditKey,
  keyFromPrivatePem,
  loadAuditKey,
  parsePublicKeyFile,
  publicKeyFile,
  signCheckpoint,
} from "../src/audit/checkpoint";
import { exportOrg, jsonlSink, webhookSink, type AuditSink } from "../src/audit/export";
import {
  auditFailure,
  FAILURE_CHAIN_LIMIT,
  FAILURE_PER_SOURCE_LIMIT,
  FAILURE_WINDOW_MS,
  auditAggregate,
  flushAggregates,
  resetFailureThrottle,
} from "../src/audit/failures";
import { verifyAudit } from "../src/audit/verify";
import {
  type Db,
  appendAudit,
  chainedAudit,
  getOrgBySlug,
  listCheckpoints,
  putCheckpoint,
} from "../src/db";
import * as s from "../src/db/schema";
import { generateKeyPairSync } from "node:crypto";
import { SecretStore } from "../src/secrets/store";
import { seedWorld, type Tenant } from "./ops-helpers";
import { and, eq, gte } from "drizzle-orm";

/** Verification with the key pinned outside the database, as an operator would. */
const PINNED = { keyPinned: true } as const;

let db: Db;
let a: Tenant;
let b: Tenant;
let store: SecretStore;
let masterKey: Buffer;
let stateDir: string;
let anchor: AuditAnchor;

const add = (t: Tenant, op = "test_op", outcome = "ok") =>
  appendAudit(db, t.scope, {
    principalKind: "member",
    principalId: "m1",
    op,
    effect: "write",
    outcome,
    input: { n: op },
  });

/** The explicit operator step, idempotent for tests that need "a key exists". */
const initKey = async (t: Tenant) =>
  (await loadAuditKey(store, t.orgId)) ?? (await initAuditKey(db, store, anchor, t.orgId));

/** Sets the org up if needed (the operator step), then signs its head. */
const signHead = async (t: Tenant) => {
  await initKey(t);
  return createCheckpoint(db, store, anchor, t.orgId);
};

const keysOf = async (t: Tenant) => {
  const k = await initKey(t);
  return new Map([[k.keyId, k.publicKeyPem]]);
};

beforeEach(async () => {
  ({ db, a, b } = await seedWorld());
  masterKey = randomBytes(32);
  store = new SecretStore(db, masterKey);
  stateDir = mkdtempSync(join(tmpdir(), "ls-anchor-"));
  anchor = new AuditAnchor(stateDir, masterKey);
  resetFailureThrottle();
});
afterEach(() => rmSync(stateDir, { recursive: true, force: true }));

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
    expect((await verifyAudit(db, a.orgId, await keysOf(a), PINNED)).ok).toBe(true);
  });
});

describe("verify", () => {
  test("clean chain with a checkpoint verifies", async () => {
    for (let i = 0; i < 5; i++) await add(a);
    await signHead(a);
    const r = await verifyAudit(db, a.orgId, await keysOf(a), PINNED);
    expect(r).toMatchObject({ ok: true, entries: 6, checkpoints: 1, headSeq: 6, unsignedTail: 0 });
  });

  test("tail after the last checkpoint is reported, not failed", async () => {
    for (let i = 0; i < 3; i++) await add(a);
    await signHead(a);
    await add(a);
    const r = await verifyAudit(db, a.orgId, await keysOf(a), PINNED);
    expect(r.ok).toBe(true);
    expect(r.unsignedTail).toBe(1);
  });

  test("an edited field breaks the chain", async () => {
    for (let i = 0; i < 4; i++) await add(a);
    await db.orm
      .update(s.auditLog)
      .set({ outcome: "error:forbidden" })
      .where(and(eq(s.auditLog.orgId, a.orgId), eq(s.auditLog.seq, 2)));
    const r = await verifyAudit(db, a.orgId, await keysOf(a), PINNED);
    expect(r.ok).toBe(false);
    expect(r.problems.join("\n")).toMatch(/2/);
  });

  test("a deleted middle entry is detected", async () => {
    for (let i = 0; i < 4; i++) await add(a);
    await db.orm
      .delete(s.auditLog)
      .where(and(eq(s.auditLog.orgId, a.orgId), eq(s.auditLog.seq, 2)));
    expect((await verifyAudit(db, a.orgId, await keysOf(a), PINNED)).ok).toBe(false);
  });

  test("truncating entries a checkpoint covers is detected", async () => {
    for (let i = 0; i < 5; i++) await add(a);
    await signHead(a);
    await db.orm
      .delete(s.auditLog)
      .where(and(eq(s.auditLog.orgId, a.orgId), gte(s.auditLog.seq, 5)));
    expect((await verifyAudit(db, a.orgId, await keysOf(a), PINNED)).ok).toBe(false);
  });

  test("a rewritten tail with recomputed hashes fails the checkpoint", async () => {
    for (let i = 0; i < 3; i++) await add(a);
    await signHead(a);
    const [row] = await chainedAudit(db, a.orgId, 2, 1);
    const tampered = { ...row!, outcome: "ok-but-rewritten" };
    const { hash: _h, prevHash: _p, ...rest } = tampered;
    await db.orm
      .update(s.auditLog)
      .set({ outcome: tampered.outcome, hash: entryHash(row!.prevHash as string, rest as never) })
      .where(eq(s.auditLog.id, row!.id));
    const r = await verifyAudit(db, a.orgId, await keysOf(a), PINNED);
    expect(r.ok).toBe(false);
  });

  test("a forged checkpoint signature and an unknown key both fail", async () => {
    for (let i = 0; i < 2; i++) await add(a);
    const cp = (await signHead(a))!;
    const good = await keysOf(a);
    await db.orm
      .update(s.auditCheckpoints)
      .set({ signature: Buffer.alloc(64).toString("base64") })
      .where(and(eq(s.auditCheckpoints.orgId, a.orgId), eq(s.auditCheckpoints.seq, cp.seq)));
    expect((await verifyAudit(db, a.orgId, good, PINNED)).ok).toBe(false);
    expect((await verifyAudit(db, a.orgId, new Map(), PINNED)).ok).toBe(false);
  });

  test("orgs are independent", async () => {
    await add(a);
    await add(b);
    await db.orm.delete(s.auditLog).where(eq(s.auditLog.orgId, a.orgId));
    expect((await verifyAudit(db, b.orgId, await keysOf(b), PINNED)).ok).toBe(true);
  });
});

describe("checkpoints", () => {
  test("the key lives in the secret store, per org", async () => {
    const k1 = await initKey(a);
    expect((await initKey(a)).keyId).toBe(k1.keyId);
    expect((await initKey(b)).keyId).not.toBe(k1.keyId);
    expect(await store.get(a.orgId, AUDIT_KEY_SECRET)).toContain("PRIVATE KEY");
  });

  test("due by entry count or by age, never twice for the same head", async () => {
    let now = 1_000_000;
    for (let i = 0; i < 3; i++) await add(a);
    await initKey(a);
    expect(
      await checkpointDue(db, store, anchor, { everyEntries: 5, everyMs: 60_000 }, () => now),
    ).toBe(1); // no checkpoint yet: age is infinite
    expect(
      await checkpointDue(db, store, anchor, { everyEntries: 5, everyMs: 60_000 }, () => now),
    ).toBe(0);
    await add(a);
    expect(
      await checkpointDue(db, store, anchor, { everyEntries: 5, everyMs: 60_000 }, () => now),
    ).toBe(0);
    now += 61_000;
    expect(
      await checkpointDue(db, store, anchor, { everyEntries: 5, everyMs: 60_000 }, () => now),
    ).toBe(1);
    for (let i = 0; i < 5; i++) await add(a);
    expect(
      await checkpointDue(db, store, anchor, { everyEntries: 5, everyMs: 60_000 }, () => now),
    ).toBe(1);
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
    await signHead(a);
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
  const fail = (orgId: string | undefined, source: string, now: () => number, trackFirst = false) =>
    auditFailure(
      db,
      {
        orgId,
        principalKind: "token",
        principalId: source,
        source,
        trackFirst,
        op: "o",
        outcome: "error:unauthenticated",
      },
      now,
    );
  const count = async (orgId: string) => (await chainedAudit(db, orgId, 0, 1000)).length;

  test("unattributable failures land in the _system org", async () => {
    await fail(undefined, "x", () => 1);
    const sys = await getOrgBySlug(db, "_system");
    expect(sys).toBeDefined();
    expect(await count(sys!.id)).toBe(1);
  });

  test("one noisy source cannot suppress another source's failures", async () => {
    for (let i = 0; i < 100; i++) await fail(a.orgId, "noisy", () => 1000);
    expect(await count(a.orgId)).toBe(FAILURE_PER_SOURCE_LIMIT);
    await fail(a.orgId, "victim", () => 1000);
    expect(await count(a.orgId)).toBe(FAILURE_PER_SOURCE_LIMIT + 1);
    // the window rolls over, the noisy source is recorded again and says what it dropped
    await fail(a.orgId, "noisy", () => 1000 + FAILURE_WINDOW_MS + 1);
    const last = (await chainedAudit(db, a.orgId, 0, 1000)).at(-1);
    expect(JSON.parse(last!.input).dropped_since_last).toBe(100 - FAILURE_PER_SOURCE_LIMIT);
  });

  test("the first failure of each distinct token id is always recorded", async () => {
    // exhaust the chain ceiling with many untracked sources
    for (let i = 0; i < FAILURE_CHAIN_LIMIT + 50; i++) await fail(a.orgId, `s${i}`, () => 1000);
    expect(await count(a.orgId)).toBe(FAILURE_CHAIN_LIMIT);
    await fail(a.orgId, "token-1", () => 1000, true);
    await fail(a.orgId, "token-2", () => 1000, true);
    expect(await count(a.orgId)).toBe(FAILURE_CHAIN_LIMIT + 2);
    // only the first: a repeat is throttled like any other once the ceiling is hit
    await fail(a.orgId, "token-1", () => 1000, true);
    expect(await count(a.orgId)).toBe(FAILURE_CHAIN_LIMIT + 2);
    // other orgs are untouched
    await fail(b.orgId, "s0", () => 1000);
    expect(await count(b.orgId)).toBe(1);
  });

  test("limiter-throttled requests are recorded as one aggregate per window", async () => {
    for (let i = 0; i < 50; i++)
      await auditAggregate(db, a.orgId, "github_webhook_throttled", () => 1000 + i);
    expect(await count(a.orgId)).toBe(0);
    await flushAggregates(db, () => 1000 + FAILURE_WINDOW_MS + 1);
    const rows = await chainedAudit(db, a.orgId, 0, 10);
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ op: "github_webhook_throttled", outcome: "error:throttled" });
    expect(JSON.parse(rows[0]!.input).count).toBe(50);
  });
});

describe("key custody", () => {
  test("a missing key is never regenerated once checkpoints exist; it is an error and an alert", async () => {
    await add(a);
    const k = await initKey(a);
    await signHead(a);
    await store.delete(a.orgId, AUDIT_KEY_SECRET);
    await add(a);
    await expect(createCheckpoint(db, store, anchor, a.orgId)).rejects.toMatchObject({
      reason: "key_missing",
    });
    // and the operator step refuses too: the org is already set up, a new key is not the answer
    await expect(initAuditKey(db, store, anchor, a.orgId)).rejects.toBeInstanceOf(
      AuditAlreadyInitialised,
    );
    expect(await store.get(a.orgId, AUDIT_KEY_SECRET)).toBeUndefined();
    const alert = (await chainedAudit(db, a.orgId, 0, 100)).find(
      (r) => r.op === "audit_checkpoint",
    );
    expect(alert?.outcome).toBe("error:key_missing");
    expect(k.keyId).toHaveLength(16);
  });

  test("key file round trip, and a tampered key id is refused", async () => {
    const k = await initKey(a);
    const text = JSON.stringify(publicKeyFile(a.orgId, a.slug, k));
    expect(parsePublicKeyFile(text).keyId).toBe(k.keyId);
    expect(() => parsePublicKeyFile(text.replace(k.keyId, "0".repeat(16)))).toThrow();
  });

  test("a chain rewritten and re-signed with a regenerated key passes unpinned, fails pinned", async () => {
    for (let i = 0; i < 3; i++) await add(a);
    const original = await initKey(a);
    await signHead(a);
    const pinned = new Map([[original.keyId, original.publicKeyPem]]);
    // attacker: rewrite the last entry, recompute its hash, drop checkpoints, sign with a new key
    const [row] = await chainedAudit(db, a.orgId, 3, 1);
    const { hash: _h, prevHash: _p, ...rest } = row!;
    const forged = { ...rest, outcome: "forged" };
    const hash = entryHash(row!.prevHash as string, forged as never);
    await db.orm
      .update(s.auditLog)
      .set({ outcome: "forged", hash })
      .where(eq(s.auditLog.id, row!.id));
    await db.orm.delete(s.auditCheckpoints).where(eq(s.auditCheckpoints.orgId, a.orgId));
    const evil = keyFromPrivatePem(
      generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    );
    const head = (await chainedAudit(db, a.orgId, 0, 100)).at(-1)!;
    await putCheckpoint(
      db,
      signCheckpoint(evil, {
        orgId: a.orgId,
        seq: head.seq as number,
        hash: head.hash as string,
        signedAt: Date.now(),
      }),
    );
    const loose = await verifyAudit(db, a.orgId, new Map([[evil.keyId, evil.publicKeyPem]]));
    // the regenerated key postdates the chain, so without a pinned key this fails outright
    expect(loose.ok).toBe(false);
    expect(loose.keyPinned).toBe(false);
    expect(loose.problems.join("\n")).toMatch(/--pubkey/);
    const strict = await verifyAudit(db, a.orgId, pinned, { keyPinned: true });
    expect(strict.ok).toBe(false);
    expect(strict.problems.join("\n")).toMatch(/unknown key/);
  });
});

describe("anchors", () => {
  const anchorOf = async (t: Tenant) => (await listCheckpoints(db, t.orgId)).map((c) => ({ ...c }));

  test("a checkpoint list deleted from the database is caught by the anchor", async () => {
    for (let i = 0; i < 3; i++) await add(a);
    await signHead(a);
    const anchors = await anchorOf(a);
    const keys = await keysOf(a);
    await db.orm.delete(s.auditCheckpoints).where(eq(s.auditCheckpoints.orgId, a.orgId));
    expect((await verifyAudit(db, a.orgId, keys, PINNED)).ok).toBe(true); // alone, it cannot tell
    const r = await verifyAudit(db, a.orgId, keys, { ...PINNED, anchors });
    expect(r.ok).toBe(false);
    expect(r.problems.join("\n")).toMatch(/missing from the database/);
  });

  test("truncation behind an anchored checkpoint is caught even with its row deleted", async () => {
    for (let i = 0; i < 5; i++) await add(a);
    await signHead(a);
    const anchors = await anchorOf(a);
    const keys = await keysOf(a);
    await db.orm.delete(s.auditCheckpoints).where(eq(s.auditCheckpoints.orgId, a.orgId));
    await db.orm
      .delete(s.auditLog)
      .where(and(eq(s.auditLog.orgId, a.orgId), gte(s.auditLog.seq, 4)));
    const r = await verifyAudit(db, a.orgId, keys, { ...PINNED, anchors });
    expect(r.ok).toBe(false);
    expect(r.anchored).toBe(true);
  });

  test("a matching anchor passes and marks the report anchored", async () => {
    for (let i = 0; i < 3; i++) await add(a);
    await signHead(a);
    const r = await verifyAudit(db, a.orgId, await keysOf(a), {
      ...PINNED,
      anchors: await anchorOf(a),
    });
    expect(r).toMatchObject({ ok: true, anchored: true, keyPinned: true });
  });

  test("a forged anchor signature is refused", async () => {
    for (let i = 0; i < 2; i++) await add(a);
    await signHead(a);
    const [cp] = await anchorOf(a);
    const r = await verifyAudit(db, a.orgId, await keysOf(a), {
      anchors: [{ ...cp!, signature: Buffer.alloc(64).toString("base64url") }],
    });
    expect(r.ok).toBe(false);
  });

  test("old entries with no checkpoint after them fail", async () => {
    for (let i = 0; i < 2; i++) await add(a);
    const keys = await keysOf(a);
    const later = Date.now() + 60 * 60_000;
    const none = await verifyAudit(db, a.orgId, keys, { ...PINNED, now: later });
    expect(none.ok).toBe(false);
    expect(none.problems.join("\n")).toMatch(/no checkpoint/);
    expect((await verifyAudit(db, a.orgId, keys, PINNED)).ok).toBe(true); // recent: not yet due
    await signHead(a);
    expect((await verifyAudit(db, a.orgId, keys, { ...PINNED, now: later })).ok).toBe(true);
  });
});
