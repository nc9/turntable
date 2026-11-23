// Anchor export body v2 (#398): the body names its key and is verified under that key alone; a
// keyless v1 body is accepted only at or before the org's v2 cutover. Covers the verifier, the CLI
// reader and `instance_audit_verify`. Runs on SQLite, and on pglite via TURNTABLE_TEST_DB.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditAnchor } from "../src/audit/anchor";
import { getAnchorCutover } from "../src/audit/anchor-cutover";
import { ANCHOR_KEYS, createAnchorExporter, toAnchor } from "../src/audit/anchor-export";
import {
  createCheckpoint,
  initAuditKey,
  keyFromPrivatePem,
  signCheckpoint,
  type AuditKey,
} from "../src/audit/checkpoint";
import { readAnchorFile } from "../src/audit/cli";
import { verifyAnchors, verifyAudit } from "../src/audit/verify";
import { appendAudit, listCheckpoints, type Db } from "../src/db";
import { dispatch, registry, type DispatchEnv } from "../src/ops";
import { createInstanceTokenFromCli } from "../src/ops/instance-token-cli";
import { SecretStore } from "../src/secrets/store";
import { settingsRegistry } from "../src/settings/definitions";
import { createSettingsRuntime } from "../src/settings/resolve";
import { seedWorld, type Tenant } from "./ops-helpers";

const tmp = mkdtempSync(join(tmpdir(), "tt-anchor-v2-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let db: Db;
let a: Tenant;
let store: SecretStore;
let key: AuditKey;
let other: AuditKey;
let env: DispatchEnv;
let secret: string;
let seqs: number[];

const append = async (n: number): Promise<void> => {
  for (let i = 0; i < n; i++) {
    await appendAudit(
      db,
      { orgId: a.orgId },
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

const SINK = "https://anchors.example.test/hook";
type Sent = { body: string };

beforeEach(async () => {
  ({ db, a } = await seedWorld());
  const masterKey = randomBytes(32);
  store = new SecretStore(db, masterKey);
  const anchor = new AuditAnchor(join(tmp, randomBytes(4).toString("hex")), masterKey);
  key = await initAuditKey(db, store, anchor, a.orgId);
  other = keyFromPrivatePem(
    generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  );
  await append(3);
  await createCheckpoint(db, store, anchor, a.orgId);
  await append(3);
  await createCheckpoint(db, store, anchor, a.orgId);
  seqs = (await listCheckpoints(db, a.orgId)).map((c) => c.seq);
  env = { registry, db, allowInstance: true, auditStore: store };
  secret = (await createInstanceTokenFromCli(db, { name: "ops laptop" })).secret;
});

const v2 = async (): Promise<Record<string, unknown>[]> =>
  (await listCheckpoints(db, a.orgId)).map((c) => ({ ...toAnchor(c) }));
const v1 = (bodies: Record<string, unknown>[]): Record<string, unknown>[] =>
  bodies.map(({ key_id: _k, ...rest }) => ({ ...rest, version: 1 }));

const file = (bodies: unknown[]): string => {
  const f = join(tmp, `${randomBytes(4).toString("hex")}.jsonl`);
  writeFileSync(f, `${bodies.map((b) => JSON.stringify(b)).join("\n")}\n`);
  return f;
};

const keys = (...ks: AuditKey[]) => new Map(ks.map((k) => [k.keyId, k.publicKeyPem]));
const cli = async (bodies: unknown[], ks = keys(key)): Promise<string[]> =>
  (await verifyAudit(db, a.orgId, ks, { keyPinned: true, anchors: readAnchorFile(file(bodies)) }))
    .problems;
const op = async (anchors: unknown[]) => {
  const r = await dispatch(env, { kind: "bearer", token: secret }, "instance_audit_verify", {
    anchors,
  });
  expect(r.ok).toBe(true);
  return (r.ok ? r.output : undefined) as {
    orgs: { result: string; reasons: string[] }[];
  };
};

/** A v2 body for the first checkpoint, re-signed by `k` (the key id it names is `k`'s). */
const signedBy = async (k: AuditKey, named = k.keyId): Promise<Record<string, unknown>> => {
  const [first] = await v2();
  const cp = signCheckpoint(k, {
    orgId: a.orgId,
    seq: first!.sequence as number,
    hash: first!.head_hash as string,
    signedAt: first!.time as number,
  });
  return { ...first!, key_id: named, signature: cp.signature };
};

describe("the v2 body", () => {
  test("carries key_id and exactly ANCHOR_KEYS", async () => {
    const [first] = await v2();
    expect(first).toMatchObject({ version: 2, key_id: key.keyId });
    expect(Object.keys(first!).sort()).toEqual([...ANCHOR_KEYS].sort());
  });

  test("the exporter sends v2 and records the cutover once, at the first export", async () => {
    const sent: Sent[] = [];
    const fetch = (async (_u: string, init: { body: string }) => {
      sent.push({ body: init.body });
      return { ok: true, status: 200 };
    }) as never;
    const ex = () =>
      createAnchorExporter({
        db,
        settings: createSettingsRuntime(settingsRegistry, {
          TURNTABLE_AUDIT_ANCHOR_SINK_URL: SINK,
        }),
        fetch,
      });
    expect(await getAnchorCutover(db, a.orgId)).toBeUndefined();
    await ex().flush();
    const first = await getAnchorCutover(db, a.orgId);
    expect(first).toMatchObject({ seq: seqs.at(-1) });
    expect(JSON.parse(sent[0]!.body)).toMatchObject({ version: 2, key_id: key.keyId });
    await ex().flush();
    expect(await getAnchorCutover(db, a.orgId)).toEqual(first);
  });
});

describe("verification under the named key only", () => {
  test("a v2 body verifies under its own key (CLI and op)", async () => {
    expect(await cli(await v2())).toEqual([]);
    expect((await op(await v2())).orgs[0]).toMatchObject({ result: "ok", reasons: [] });
  });

  test("a v2 body signed by another trusted key is refused", async () => {
    const body = await signedBy(other, key.keyId);
    // Both keys are trusted, the signature is valid under `other`, but the body names `key`.
    expect(await verifyAnchors(db, a.orgId, keys(key, other), [readOne(body)])).toBe("mismatch");
    expect((await cli([body], keys(key, other))).join("\n")).toContain("no valid signature");
    expect((await op([body])).orgs[0]).toMatchObject({ result: "mismatch" });
    // Naming the signer instead is refused as untrusted when only `key` is trusted.
    const named = await signedBy(other);
    expect((await cli([named])).join("\n")).toContain("not trusted");
    expect((await op([named])).orgs[0]).toMatchObject({
      result: "mismatch",
      reasons: ["unknown_key"],
    });
    // And accepted when `other` is trusted too: the key is the named one.
    expect(await verifyAnchors(db, a.orgId, keys(key, other), [readOne(named)])).not.toBe(
      "mismatch",
    );
  });

  test("an unknown key_id is refused with a classified reason", async () => {
    const [first] = await v2();
    const body = { ...first!, key_id: "0000000000000000" };
    expect((await cli([body])).join("\n")).toContain("not trusted");
    expect((await op([body])).orgs[0]).toMatchObject({
      result: "mismatch",
      reasons: ["unknown_key"],
    });
  });

  test("tampering with key_id breaks verification", async () => {
    const [first] = await v2();
    const body = { ...first!, key_id: other.keyId };
    expect((await cli([body], keys(key, other))).join("\n")).toContain("no valid signature");
    expect(await verifyAnchors(db, a.orgId, keys(key, other), [readOne(body)])).toBe("mismatch");
    expect((await op([body])).orgs[0]?.result).toBe("mismatch");
  });

  test("a v2 body without key_id is rejected, not read as v1", async () => {
    const [first] = await v2();
    const { key_id: _k, ...stripped } = first!;
    expect(() => readAnchorFile(file([stripped]))).toThrow(/key_id/);
    const r = await dispatch(env, { kind: "bearer", token: secret }, "instance_audit_verify", {
      anchors: [stripped],
    });
    expect(r.ok).toBe(false);
  });
});

describe("the keyless v1 body and the cutover", () => {
  test("accepted before any v2 export (no cutover recorded)", async () => {
    expect(await cli(v1(await v2()))).toEqual([]);
    expect((await op(v1(await v2()))).orgs[0]?.result).toBe("ok");
  });

  test("a v1 at or before the cutover is accepted, one after it is refused", async () => {
    const all = await v2();
    // The recorded cutover is the first checkpoint's sequence.
    const { recordAnchorCutover } = await import("../src/audit/anchor-cutover");
    await recordAnchorCutover(db, a.orgId, { seq: seqs[0]!, time: 1 }, 1);
    const [first, second] = v1(all);
    expect(await cli([first])).toEqual([]);
    expect((await op([first])).orgs[0]).toMatchObject({ result: "ok", reasons: [] });
    const late = await cli([second]);
    expect(late.join("\n")).toContain("keyless v1 body after the v2 cutover");
    expect((await op([second])).orgs[0]).toMatchObject({
      result: "mismatch",
      reasons: ["keyless_after_cutover"],
    });
  });

  test("with no recorded cutover, a v1 after a v2 in the same set is refused", async () => {
    const [first, second] = await v2();
    const mixed = [first!, ...v1([second!])];
    expect((await cli(mixed)).join("\n")).toContain("after the v2 cutover");
    expect((await op(mixed)).orgs[0]?.reasons).toEqual(["keyless_after_cutover"]);
  });
});

function readOne(body: Record<string, unknown>) {
  const [an] = readAnchorFile(file([body]));
  return an!;
}
