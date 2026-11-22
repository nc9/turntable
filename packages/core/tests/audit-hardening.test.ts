import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, gte } from "drizzle-orm";
import { AuditAnchor } from "../src/audit/anchor";
import { entryHash } from "../src/audit/chain";
import {
  AUDIT_KEY_SECRET,
  AuditAlreadyInitialised,
  AuditRefusal,
  adoptAuditKey,
  checkpointDue,
  createCheckpoint,
  initAuditKey,
  keyFromPrivatePem,
  loadAuditKey,
  signCheckpoint,
} from "../src/audit/checkpoint";
import { resetFailureThrottle } from "../src/audit/failures";
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
import { SecretStore } from "../src/secrets/store";
import { seedWorld, type Tenant } from "./ops-helpers";

let db: Db;
let a: Tenant;
let b: Tenant;
let store: SecretStore;
let masterKey: Buffer;
let dir: string;
let anchor: AuditAnchor;

const add = (t: Tenant, n = 1) =>
  Array.from({ length: n }).reduce<Promise<void>>(
    (p, _, i) =>
      p.then(() =>
        appendAudit(db, t.scope, {
          principalKind: "member",
          principalId: "m",
          op: "x",
          effect: "write",
          outcome: "ok",
          input: { i },
        }),
      ),
    Promise.resolve(),
  );

const sign = (t: Tenant) => createCheckpoint(db, store, anchor, t.orgId);
const refusal = async (t: Tenant): Promise<string> => {
  try {
    await sign(t);
  } catch (e) {
    if (e instanceof AuditRefusal) return e.reason;
    throw e;
  }
  return "signed";
};
const alerts = async (t: Tenant) =>
  (await chainedAudit(db, t.orgId, 0, 1000)).filter((r) => r.op === "audit_checkpoint");

beforeEach(async () => {
  ({ db, a, b } = await seedWorld());
  masterKey = randomBytes(32);
  store = new SecretStore(db, masterKey);
  dir = mkdtempSync(join(tmpdir(), "ls-harden-"));
  anchor = new AuditAnchor(dir, masterKey);
  resetFailureThrottle();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("explicit key creation", () => {
  test("the checkpointer never creates a key, a state file or a checkpoint for an org that was not set up", async () => {
    await add(a, 5);
    expect(await sign(a)).toBeUndefined();
    expect(await checkpointDue(db, store, anchor, { everyEntries: 1 })).toBe(0);
    expect(await loadAuditKey(store, a.orgId)).toBeUndefined();
    expect(anchor.read(a.orgId)).toBeUndefined();
    expect(await listCheckpoints(db, a.orgId)).toEqual([]);
  });

  test("init-key creates the key and the sealed state, once", async () => {
    await add(a, 2);
    const k = await initAuditKey(db, store, anchor, a.orgId);
    expect(anchor.read(a.orgId)).toMatchObject({ keyId: k.keyId, lastSeq: 0 });
    await expect(initAuditKey(db, store, anchor, a.orgId)).rejects.toBeInstanceOf(
      AuditAlreadyInitialised,
    );
    expect((await sign(a))?.seq).toBeGreaterThan(0);
    expect(anchor.read(a.orgId)?.lastSeq).toBe((await listCheckpoints(db, a.orgId)).at(-1)?.seq);
  });

  test("init-key refuses an org that already has checkpoints or a leftover state file", async () => {
    await initAuditKey(db, store, anchor, a.orgId);
    await add(a, 2);
    await sign(a);
    await store.delete(a.orgId, AUDIT_KEY_SECRET);
    anchor = new AuditAnchor(mkdtempSync(join(tmpdir(), "ls-harden2-")), masterKey);
    await expect(initAuditKey(db, store, anchor, a.orgId)).rejects.toThrow(/checkpoints exist/);
  });

  test("the state is sealed: a file edited or sealed with another key does not open", async () => {
    await initAuditKey(db, store, anchor, a.orgId);
    const file = join(dir, readdirSync(dir)[0]!);
    expect(() => new AuditAnchor(dir, randomBytes(32)).read(a.orgId)).toThrow(/cannot be opened/);
    writeFileSync(file, `${await Bun.file(file).text()}x`);
    expect(() => anchor.read(a.orgId)).toThrow(/cannot be opened/);
  });
});

describe("the key-existed marker", () => {
  test("a deleted key is refused with an alert, and never regenerated", async () => {
    await initAuditKey(db, store, anchor, a.orgId);
    await add(a, 3);
    await sign(a);
    await store.delete(a.orgId, AUDIT_KEY_SECRET);
    await add(a, 2);
    expect(await refusal(a)).toBe("key_missing");
    expect(await loadAuditKey(store, a.orgId)).toBeUndefined();
    expect((await alerts(a)).at(-1)?.outcome).toBe("error:key_missing");
  });

  test("a deleted key before the first checkpoint is refused too (the marker, not the table, says it existed)", async () => {
    await initAuditKey(db, store, anchor, a.orgId);
    await store.delete(a.orgId, AUDIT_KEY_SECRET);
    await add(a, 2);
    expect(await refusal(a)).toBe("key_missing");
  });

  test("a deleted state file with the key present is refused", async () => {
    await initAuditKey(db, store, anchor, a.orgId);
    await add(a, 2);
    rmSync(join(dir, readdirSync(dir)[0]!));
    expect(await refusal(a)).toBe("state_missing");
  });

  test("a corrupt state file is refused", async () => {
    await initAuditKey(db, store, anchor, a.orgId);
    await add(a, 2);
    writeFileSync(join(dir, readdirSync(dir)[0]!), "not sealed");
    expect(await refusal(a)).toBe("state_corrupt");
  });

  test("a different key in the store than the one the org was set up with is refused", async () => {
    await initAuditKey(db, store, anchor, a.orgId);
    await add(a, 2);
    const evil = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" });
    await store.set(a.orgId, AUDIT_KEY_SECRET, evil.toString());
    expect(await refusal(a)).toBe("key_replaced");
  });

  test("one org's refusal does not stop the others", async () => {
    await initAuditKey(db, store, anchor, a.orgId);
    await initAuditKey(db, store, anchor, b.orgId);
    await add(a, 3);
    await add(b, 3);
    await store.delete(a.orgId, AUDIT_KEY_SECRET);
    expect(await checkpointDue(db, store, anchor, { everyEntries: 1 })).toBe(1);
    expect((await listCheckpoints(db, b.orgId)).length).toBe(1);
    expect((await listCheckpoints(db, a.orgId)).length).toBe(0);
  });
});

describe("verify before sign", () => {
  const setup = async () => {
    await add(a, 3);
    await initAuditKey(db, store, anchor, a.orgId);
    await sign(a);
    await add(a, 4);
  };
  const entryAt = async (seq: number) => (await chainedAudit(db, a.orgId, seq - 1, 1))[0]!;

  test("an entry edited since the last checkpoint is not signed over", async () => {
    await setup();
    const last = (await listCheckpoints(db, a.orgId)).at(-1)!;
    const target = await entryAt(last.seq + 2);
    await db.orm.update(s.auditLog).set({ outcome: "edited" }).where(eq(s.auditLog.id, target.id));
    expect(await refusal(a)).toBe("chain_invalid");
    expect((await listCheckpoints(db, a.orgId)).length).toBe(1);
  });

  test("an edit with every later hash recomputed still breaks the link to the signed entry", async () => {
    await setup();
    const last = (await listCheckpoints(db, a.orgId)).at(-1)!;
    const rows = await chainedAudit(db, a.orgId, last.seq - 1, 100);
    let prev = rows[0]!.prevHash as string;
    for (const r of rows) {
      const outcome = r.seq === last.seq ? "rewritten" : r.outcome;
      const { hash: _h, prevHash: _p, ...rest } = { ...r, outcome };
      const hash = entryHash(prev, rest as never);
      await db.orm
        .update(s.auditLog)
        .set({ outcome, prevHash: prev, hash })
        .where(eq(s.auditLog.id, r.id));
      prev = hash;
    }
    expect(await refusal(a)).toBe("chain_invalid");
  });

  test("a deleted entry in the segment is not signed over", async () => {
    await setup();
    const last = (await listCheckpoints(db, a.orgId)).at(-1)!;
    await db.orm
      .delete(s.auditLog)
      .where(and(eq(s.auditLog.orgId, a.orgId), eq(s.auditLog.seq, last.seq + 2)));
    expect(await refusal(a)).toBe("chain_invalid");
  });

  test("a stored checkpoint with a bad signature stops signing", async () => {
    await setup();
    await db.orm
      .update(s.auditCheckpoints)
      .set({ signature: Buffer.alloc(64).toString("base64url") })
      .where(eq(s.auditCheckpoints.orgId, a.orgId));
    expect(await refusal(a)).toBe("checkpoint_invalid");
  });

  test("a clean segment signs, and refusals leave an alert in the org's chain", async () => {
    await setup();
    expect((await sign(a))?.seq).toBeGreaterThan(3);
    expect(await alerts(a)).toEqual([]);
    await add(a, 2);
    const target = await entryAt((await listCheckpoints(db, a.orgId)).at(-1)!.seq + 1);
    await db.orm.update(s.auditLog).set({ outcome: "edited" }).where(eq(s.auditLog.id, target.id));
    await refusal(a);
    expect((await alerts(a)).at(-1)?.outcome).toBe("error:chain_invalid");
  });
});

describe("the last signed position is kept outside the database", () => {
  const setup = async () => {
    await add(a, 3);
    await initAuditKey(db, store, anchor, a.orgId);
    await sign(a);
    await add(a, 3);
    await sign(a);
    await add(a, 2);
  };

  test("a checkpoints table rolled back is refused", async () => {
    await setup();
    const cps = await listCheckpoints(db, a.orgId);
    await db.orm
      .delete(s.auditCheckpoints)
      .where(and(eq(s.auditCheckpoints.orgId, a.orgId), gte(s.auditCheckpoints.seq, cps[1]!.seq)));
    expect(await refusal(a)).toBe("checkpoints_backwards");
  });

  test("all checkpoints deleted is refused, even though the chain itself is intact", async () => {
    await setup();
    await db.orm.delete(s.auditCheckpoints).where(eq(s.auditCheckpoints.orgId, a.orgId));
    expect(await refusal(a)).toBe("checkpoints_backwards");
  });

  test("a chain that no longer extends what was signed is refused", async () => {
    await setup();
    const last = (await listCheckpoints(db, a.orgId)).at(-1)!;
    // History after the signed entry replaced by a different, internally consistent tail.
    const tail = await chainedAudit(db, a.orgId, last.seq - 1, 100);
    await db.orm
      .delete(s.auditLog)
      .where(and(eq(s.auditLog.orgId, a.orgId), gte(s.auditLog.seq, last.seq)));
    let prev = tail[0]!.prevHash as string;
    for (const r of tail) {
      const fields = { ...r, input: `{"forged":${r.seq}}` };
      const { hash: _h, prevHash: _p, ...rest } = fields;
      const hash = entryHash(prev, rest as never);
      await db.orm.insert(s.auditLog).values({ ...fields, prevHash: prev, hash });
      prev = hash;
    }
    expect(await refusal(a)).toBe("chain_invalid");
  });

  test("a chain cut back behind the last signed entry is refused", async () => {
    await setup();
    const last = (await listCheckpoints(db, a.orgId)).at(-1)!;
    await db.orm
      .delete(s.auditLog)
      .where(and(eq(s.auditLog.orgId, a.orgId), gte(s.auditLog.seq, last.seq - 1)));
    expect(await refusal(a)).toBe("chain_invalid");
  });

  test("a crash between the checkpoint write and the state write is caught up, not refused", async () => {
    await add(a, 3);
    const key = await initAuditKey(db, store, anchor, a.orgId);
    const head = (await chainedAudit(db, a.orgId, 0, 100)).at(-1)!;
    await putCheckpoint(
      db,
      signCheckpoint(key, {
        orgId: a.orgId,
        seq: head.seq!,
        hash: head.hash!,
        signedAt: Date.now(),
      }),
    );
    expect(anchor.read(a.orgId)?.lastSeq).toBe(0);
    expect(await sign(a)).toBeUndefined();
    expect(anchor.read(a.orgId)?.lastSeq).toBe(head.seq!);
  });

  test("the state moves forward with each checkpoint", async () => {
    await setup();
    const last = (await listCheckpoints(db, a.orgId)).at(-1)!;
    expect(anchor.read(a.orgId)).toMatchObject({ lastSeq: last.seq, lastHash: last.hash });
  });
});

describe("verify without a pinned key never vouches for the chain", () => {
  test("with checkpoints and no pinned key it fails, however the chain describes its own key", async () => {
    await add(a, 3);
    const key = await initAuditKey(db, store, anchor, a.orgId);
    await sign(a);
    const keys = new Map([[key.keyId, key.publicKeyPem]]);
    const loose = await verifyAudit(db, a.orgId, keys);
    expect(loose.ok).toBe(false);
    expect(loose.keyPinned).toBe(false);
    expect(loose.problems.join("\n")).toMatch(/unanchored.*--pubkey/);
    expect((await verifyAudit(db, a.orgId, keys, { keyPinned: true })).ok).toBe(true);
  });

  test("a forged key-creation row at the head of the chain does not make unpinned verify pass", async () => {
    // The attacker writes the row the secret store would write for the key, first in the chain.
    await appendAudit(db, a.scope, {
      principalKind: "system",
      principalId: "secret-store",
      op: "secret_set",
      effect: "write",
      outcome: "ok",
      input: { name: AUDIT_KEY_SECRET },
    });
    await add(a, 3);
    const { privateKey } = generateKeyPairSync("ed25519");
    const key = keyFromPrivatePem(privateKey.export({ type: "pkcs8", format: "pem" }).toString());
    const head = (await chainedAudit(db, a.orgId, 0, 100)).at(-1)!;
    await putCheckpoint(
      db,
      signCheckpoint(key, {
        orgId: a.orgId,
        seq: head.seq!,
        hash: head.hash!,
        signedAt: Date.now(),
      }),
    );
    const r = await verifyAudit(db, a.orgId, new Map([[key.keyId, key.publicKeyPem]]));
    expect(r.ok).toBe(false);
    expect(r.keyPinned).toBe(false);
  });

  test("an org whose own first entry is the key also needs the pinned key", async () => {
    const key = await initAuditKey(db, store, anchor, a.orgId);
    await add(a, 3);
    await sign(a);
    const keys = new Map([[key.keyId, key.publicKeyPem]]);
    expect((await verifyAudit(db, a.orgId, keys)).ok).toBe(false);
    expect((await verifyAudit(db, a.orgId, keys, { keyPinned: true })).ok).toBe(true);
  });

  test("with no checkpoints at all there is nothing to vouch for and it is not reported as pinned", async () => {
    await add(a, 3);
    const r = await verifyAudit(db, a.orgId, new Map());
    expect(r.keyPinned).toBe(false);
    expect(r.anchored).toBe(false);
  });
});

describe("adopting an org that signed before the anchor existed", () => {
  const legacy = async () => {
    await add(a, 3);
    const { privateKey } = generateKeyPairSync("ed25519");
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    await store.set(a.orgId, AUDIT_KEY_SECRET, pem);
    const key = keyFromPrivatePem(pem);
    const head = (await chainedAudit(db, a.orgId, 0, 100)).at(-1)!;
    await putCheckpoint(
      db,
      signCheckpoint(key, {
        orgId: a.orgId,
        seq: head.seq!,
        hash: head.hash!,
        signedAt: Date.now(),
      }),
    );
    return key;
  };

  test("without state it is refused; adopt verifies, writes the state, and signing resumes", async () => {
    await legacy();
    await add(a, 2);
    expect(await refusal(a)).toBe("state_missing");
    const st = await adoptAuditKey(db, store, anchor, a.orgId);
    expect(st.lastSeq).toBe((await listCheckpoints(db, a.orgId)).at(-1)!.seq);
    expect((await sign(a))?.seq).toBeGreaterThan(st.lastSeq);
  });

  test("adopt refuses a chain that does not verify, and a state that already exists", async () => {
    await legacy();
    const row = (await chainedAudit(db, a.orgId, 0, 1))[0]!;
    await db.orm.update(s.auditLog).set({ outcome: "edited" }).where(eq(s.auditLog.id, row.id));
    await expect(adoptAuditKey(db, store, anchor, a.orgId)).rejects.toBeInstanceOf(AuditRefusal);
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
  });
});

describe("a truncated chain is never silently skipped", () => {
  const setup = async () => {
    await add(a, 3);
    await initAuditKey(db, store, anchor, a.orgId);
    await sign(a);
    await add(a, 4);
    await sign(a);
  };
  const systemAlerts = async () => {
    const sys = await getOrgBySlug(db, "_system");
    return sys
      ? (await chainedAudit(db, sys.id, 0, 100)).filter((r) => r.op === "audit_checkpoint")
      : [];
  };

  test("every audit row deleted: the checkpointer refuses and alerts in the system chain", async () => {
    await setup();
    await db.orm.delete(s.auditLog).where(eq(s.auditLog.orgId, a.orgId));
    expect(await refusal(a)).toBe("chain_invalid");
    const alert = (await systemAlerts()).at(-1)!;
    expect(alert.outcome).toBe("error:chain_invalid");
    expect(JSON.parse(alert.input)).toMatchObject({ org_id: a.orgId });
    // nothing was written into the truncated org's own chain
    expect(await chainedAudit(db, a.orgId, 0, 10)).toEqual([]);
  });

  test("rows below the last signed entry deleted: refused and alerted", async () => {
    await setup();
    const last = (await listCheckpoints(db, a.orgId)).at(-1)!;
    await db.orm
      .delete(s.auditLog)
      .where(and(eq(s.auditLog.orgId, a.orgId), gte(s.auditLog.seq, last.seq - 2)));
    expect(await refusal(a)).toBe("chain_invalid");
    expect((await systemAlerts()).length).toBeGreaterThan(0);
  });

  test("checkpointDue still looks at an org whose rows are all gone, and keeps going with the others", async () => {
    await setup();
    await initAuditKey(db, store, anchor, b.orgId);
    await add(b, 3);
    await db.orm.delete(s.auditLog).where(eq(s.auditLog.orgId, a.orgId));
    // the org is no longer in orgsWithAudit, yet the pass checks it and still signs the other
    expect(await checkpointDue(db, store, anchor, { everyEntries: 1 })).toBe(1);
    expect((await systemAlerts()).at(-1)?.outcome).toBe("error:chain_invalid");
    expect((await listCheckpoints(db, b.orgId)).length).toBe(1);
  });

  test("it is checked on every pass, not only when a checkpoint would be due", async () => {
    await setup();
    await db.orm.delete(s.auditLog).where(eq(s.auditLog.orgId, a.orgId));
    await checkpointDue(db, store, anchor, { everyEntries: 1_000_000, everyMs: 1e12 });
    const first = (await systemAlerts()).length;
    expect(first).toBeGreaterThan(0);
  });

  test("a freshly set-up org (its first row is the key) signs normally, with no alert", async () => {
    await initAuditKey(db, store, anchor, b.orgId);
    expect(await checkpointDue(db, store, anchor, { everyEntries: 1 })).toBe(1);
    expect(await systemAlerts()).toEqual([]);
  });
});
