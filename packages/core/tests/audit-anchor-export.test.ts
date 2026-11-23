import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHmac, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, gt } from "drizzle-orm";
import { AuditAnchor } from "../src/audit/anchor";
import { createAnchorExporter } from "../src/audit/anchor-export";
import {
  checkpointDue,
  checkpointSignatureValid,
  createCheckpoint,
  initAuditKey,
  loadAuditKey,
} from "../src/audit/checkpoint";
import { auditCommand, readAnchorFile } from "../src/audit/cli";
import { verifyAudit } from "../src/audit/verify";
import {
  appendAudit,
  chainedAudit,
  createOrg,
  ensureInstance,
  getOrgBySlug,
  listCheckpoints,
  openDatabase,
  type Db,
} from "../src/db";
import * as s from "../src/db/schema";
import { checkAuditStateDir } from "../src/doctor/checks";
import type { DoctorInputs } from "../src/doctor/types";
import { auditStateDir } from "../src/secrets/master-key";
import { SecretStore } from "../src/secrets/store";
import { settingsRegistry } from "../src/settings/definitions";
import { createSettingsRuntime, resolveSetting } from "../src/settings/resolve";
import { seedWorld, type Tenant } from "./ops-helpers";

let db: Db;
let a: Tenant;
let store: SecretStore;
let masterKey: Buffer;
let tmp: string;
let anchor: AuditAnchor;

const add = (t: Tenant, n: number) =>
  appendAudit(db, t.scope, {
    principalKind: "member",
    principalId: "m1",
    op: "test_op",
    effect: "write",
    outcome: "ok",
    input: { n },
  });

beforeEach(async () => {
  ({ db, a } = await seedWorld());
  masterKey = randomBytes(32);
  store = new SecretStore(db, masterKey);
  tmp = mkdtempSync(join(tmpdir(), "tt-anchor-export-"));
  anchor = new AuditAnchor(join(tmp, "state"), masterKey);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const SINK = "https://anchors.example.test/hook";
const runtime = (env: Record<string, string> = { TURNTABLE_AUDIT_ANCHOR_SINK_URL: SINK }) =>
  createSettingsRuntime(settingsRegistry, env);

type Sent = { url: string; headers: Record<string, string>; body: string };
const fakeFetch = (sent: Sent[], status = 200) =>
  (async (url: string, init: { headers: Record<string, string>; body: string }) => {
    sent.push({ url, headers: init.headers, body: init.body });
    return { ok: status < 400, status };
  }) as never;

describe("the state directory", () => {
  test("TURNTABLE_AUDIT_STATE_DIR wins over the key file and the data dir", () => {
    const keys = { file: "/k/master.key" };
    expect(auditStateDir(keys, "/data", {})).toBe("/k/master.key.audit-state");
    expect(auditStateDir(undefined, "/data", {})).toBe("/data/audit-state");
    const env = { TURNTABLE_AUDIT_STATE_DIR: "/mnt/secrets/audit" };
    expect(auditStateDir(keys, "/data", env)).toBe("/mnt/secrets/audit");
    expect(auditStateDir(undefined, "/data", env)).toBe("/mnt/secrets/audit");
    expect(auditStateDir(keys, "/data", { TURNTABLE_AUDIT_STATE_DIR: "  " })).toBe(
      "/k/master.key.audit-state",
    );
  });

  test("the audit CLI keeps its sealed state there", async () => {
    const dataDir = join(tmp, "data");
    const stateDir = join(tmp, "off-volume");
    const keyFile = join(tmp, "m.key");
    writeFileSync(keyFile, masterKey, { mode: 0o600 });
    const d = openDatabase(join(dataDir, "turntable.db"));
    await ensureInstance(d);
    const org = await createOrg(d, { slug: "acme", name: "acme" });
    await appendAudit(
      d,
      { orgId: org.id },
      {
        principalKind: "member",
        principalId: "m",
        op: "x",
        effect: "write",
        outcome: "ok",
        input: {},
      },
    );
    d.close();
    process.env.TURNTABLE_AUDIT_STATE_DIR = stateDir;
    const log = console.log;
    console.log = () => {};
    try {
      const base = ["--data-dir", dataDir, "--master-key-file", keyFile, "--org", "acme"];
      expect(await auditCommand(["init-key", ...base, "--out", join(tmp, "pub.json")])).toBe(0);
    } finally {
      console.log = log;
      delete process.env.TURNTABLE_AUDIT_STATE_DIR;
    }
    expect(readdirSync(stateDir).some((f) => f.endsWith(".state"))).toBe(true);
    expect(existsSync(`${keyFile}.audit-state`)).toBe(false);
    expect(existsSync(join(dataDir, "audit-state"))).toBe(false);
  });
});

describe("doctor", () => {
  const inputs = (dir: string | undefined) =>
    ({ dataDir: "/srv/data", auditStateDir: dir }) as unknown as DoctorInputs;
  test("warns when the state is inside the data dir, passes outside, silent without a key", () => {
    expect(checkAuditStateDir(inputs(undefined))).toEqual([]);
    const inside = checkAuditStateDir(inputs("/srv/data/audit-state"));
    expect(inside[0]).toMatchObject({ status: "warn", id: "audit_state_dir" });
    expect(inside[0]!.fix).toContain("TURNTABLE_AUDIT_STATE_DIR");
    expect(checkAuditStateDir(inputs("/srv/data"))[0]).toMatchObject({ status: "warn" });
    expect(checkAuditStateDir(inputs("/srv/data-other/audit"))[0]).toMatchObject({
      status: "pass",
    });
    expect(checkAuditStateDir(inputs("/run/secrets/audit"))[0]).toMatchObject({ status: "pass" });
  });
});

describe("settings", () => {
  test("the sink url takes no credentials and the interval is bounded", async () => {
    const rt = runtime({});
    const def = rt.registry.settings.find((x) => x.key === "audit_anchor_sink_url")!;
    expect(def.type.safeParse("").success).toBe(true);
    expect(def.type.safeParse(SINK).success).toBe(true);
    expect(def.type.safeParse("https://user:pw@anchors.example.test/").success).toBe(false);
    expect(def.type.safeParse("ftp://anchors.example.test/").success).toBe(false);
    expect(def.type.safeParse("nonsense").success).toBe(false);
    expect((await resolveSetting(rt, db, "audit_anchor_export_minutes")).value).toBe(60);
    expect(def.instanceAdminOnly).toBe(true);
  });
});

describe("anchor export", () => {
  const setUp = async () => {
    const key = await initAuditKey(db, store, anchor, a.orgId);
    for (let i = 0; i < 3; i++) await add(a, i);
    return key;
  };

  test("a checkpoint sends the latest anchor, signed by the audit key and the HMAC secret", async () => {
    const key = await setUp();
    const sent: Sent[] = [];
    const ex = createAnchorExporter({
      db,
      settings: runtime(),
      secret: "hmac-secret-for-test",
      fetch: fakeFetch(sent),
    });
    const n = await checkpointDue(db, store, anchor, {
      everyEntries: 1,
      onCheckpoint: (orgId, cp) => ex.onCheckpoint(orgId, cp),
    });
    expect(n).toBe(1);
    await ex.flush();
    // one send for the checkpoint, one for the flush: the same anchor
    expect(sent.length).toBeGreaterThanOrEqual(1);
    const msg = sent[0]!;
    expect(msg.url).toBe(SINK);
    expect(msg.headers["x-longshore-signature"]).toBe(
      `sha256=${createHmac("sha256", "hmac-secret-for-test").update(msg.body).digest("hex")}`,
    );
    const body = JSON.parse(msg.body) as { org: string; lines: Record<string, unknown>[] };
    const org = await getOrgBySlug(db, body.org);
    expect(org?.id).toBe(a.orgId);
    const line = body.lines[0] as never as Parameters<typeof checkpointSignatureValid>[1];
    expect(line).toMatchObject({ type: "checkpoint", orgId: a.orgId, seq: 4, keyId: key.keyId });
    expect(checkpointSignatureValid(key.publicKeyPem, line)).toBe(true);
    const head = (await chainedAudit(db, a.orgId, 0, 10)).at(-1)!;
    expect(line.hash).toBe(head.hash as string);
  });

  test("a sink that is not set sends nothing; the export is audited once per new anchor", async () => {
    await setUp();
    const sent: Sent[] = [];
    const off = createAnchorExporter({ db, settings: runtime({}), fetch: fakeFetch(sent) });
    await createCheckpoint(db, store, anchor, a.orgId);
    await off.flush();
    expect(sent).toEqual([]);

    const on = createAnchorExporter({ db, settings: runtime(), fetch: fakeFetch(sent) });
    await on.flush();
    await on.flush();
    expect(sent.length).toBe(2);
    const rows = await db.run((h) =>
      h.orm
        .select()
        .from(s.auditLog)
        .where(and(eq(s.auditLog.op, "audit_anchor_export"), gt(s.auditLog.createdAt, 0))),
    );
    const mine = rows.filter((r) => r.input.includes(`"seq":4`));
    expect(mine.length).toBe(1);
    expect(mine[0]!.outcome).toBe("ok");
    expect(mine[0]!.input).toContain("anchors.example.test/hook");
  });

  test("a failing sink is audited once per streak and does not throw", async () => {
    await setUp();
    await createCheckpoint(db, store, anchor, a.orgId);
    const sent: Sent[] = [];
    const logs: string[] = [];
    const ex = createAnchorExporter({
      db,
      settings: runtime(),
      fetch: fakeFetch(sent, 500),
      log: (m) => logs.push(m),
    });
    await ex.flush();
    await ex.flush();
    expect(sent.length).toBe(2);
    expect(logs.length).toBe(2);
    const rows = await db.run((h) =>
      h.orm.select().from(s.auditLog).where(eq(s.auditLog.op, "audit_anchor_export")),
    );
    expect(rows.filter((r) => r.outcome === "failed").length).toBe(1);
  });
});

describe("verify against exported anchors", () => {
  test("a chain rolled back behind an exported anchor fails", async () => {
    const key = await initAuditKey(db, store, anchor, a.orgId);
    const keys = new Map([[key.keyId, key.publicKeyPem]]);
    for (let i = 0; i < 3; i++) await add(a, i);
    await createCheckpoint(db, store, anchor, a.orgId);
    const sent: Sent[] = [];
    await createAnchorExporter({ db, settings: runtime(), fetch: fakeFetch(sent) }).flush();
    const file = join(tmp, "anchors.jsonl");
    writeFileSync(file, `${sent.map((x) => x.body).join("\n")}\n`);
    const anchors = readAnchorFile(file);
    expect(anchors.length).toBe(1);
    expect(anchors[0]).toMatchObject({ orgId: a.orgId, seq: 4 });

    const ok = await verifyAudit(db, a.orgId, keys, { keyPinned: true, anchors });
    expect(ok).toMatchObject({ ok: true, anchored: true });

    // The volume is restored from before the last entries and their checkpoint.
    await db.orm
      .delete(s.auditCheckpoints)
      .where(and(eq(s.auditCheckpoints.orgId, a.orgId), gt(s.auditCheckpoints.seq, 0)));
    await db.orm
      .delete(s.auditLog)
      .where(and(eq(s.auditLog.orgId, a.orgId), gt(s.auditLog.seq, 1)));
    expect((await listCheckpoints(db, a.orgId)).length).toBe(0);
    const bad = await verifyAudit(db, a.orgId, keys, { keyPinned: true, anchors });
    expect(bad.ok).toBe(false);
    expect(bad.problems.join("\n")).toContain("rolled back");
    expect(await loadAuditKey(store, a.orgId)).toBeDefined();
  });

  test("the file reader takes sink bodies, export lines and a single pretty-printed document", () => {
    const cp = {
      type: "checkpoint",
      orgId: "O1",
      seq: 2,
      hash: "h",
      signedAt: 1,
      keyId: "k",
      signature: "s",
    };
    const f1 = join(tmp, "one.json");
    writeFileSync(f1, JSON.stringify({ org: "o", lines: [cp] }, null, 2));
    expect(readAnchorFile(f1).length).toBe(1);
    const f2 = join(tmp, "two.jsonl");
    writeFileSync(f2, `${JSON.stringify(cp)}\n${JSON.stringify({ type: "entry", orgId: "O1" })}\n`);
    expect(readAnchorFile(f2).length).toBe(1);
  });
});
