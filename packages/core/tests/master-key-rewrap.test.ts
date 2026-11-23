import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scrubbedEnv } from "@turntable/provider-sdk";
import { eq } from "drizzle-orm";
import { AuditAnchor } from "../src/audit/anchor";
import { openDatabase, type Db } from "../src/db";
import { DIALECT } from "../src/db/dialect";
import { listAudit, putSecretRecord } from "../src/db/repos";
import * as s from "../src/db/schema";
import { open, seal, secretAad, vaultAad } from "../src/secrets/crypto";
import {
  MasterKeyConfigError,
  parseMasterKeyValue,
  takeMasterKeys,
} from "../src/secrets/master-key";
import { RewrapError, rewrapMasterKey } from "../src/secrets/rewrap";
import { SecretStore } from "../src/secrets/store";
import { SecretVault } from "../src/secrets/vault";
import { WebhookService, webhookSecretAad } from "../src/webhooks/service";
import { seedWorld, type Tenant } from "./ops-helpers";

const tmp = mkdtempSync(join(tmpdir(), "tt-rewrap-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const fresh = (): string => {
  const d = join(tmp, `t${n++}`);
  mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
};

const VALUE = ["rewrap", "fixture", "value", "4471"].join("-");

describe("reading the key from the environment", () => {
  test("base64, base64url and hex decode to the same 32 bytes", () => {
    const k = randomBytes(32);
    for (const v of [k.toString("base64"), k.toString("base64url"), k.toString("hex")]) {
      expect(parseMasterKeyValue("TURNTABLE_MASTER_KEY", v).equals(k)).toBe(true);
    }
  });

  test("a wrong length or alphabet is refused, and the message never holds the value", () => {
    const bad = randomBytes(31).toString("base64");
    let msg = "";
    try {
      parseMasterKeyValue("TURNTABLE_MASTER_KEY", bad);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain("32 bytes");
    expect(msg).not.toContain(bad);
    expect(() => parseMasterKeyValue("TURNTABLE_MASTER_KEY", "not a key!")).toThrow(
      MasterKeyConfigError,
    );
  });

  test("the key is read, deleted from the environment, and a file still works", () => {
    const k = randomBytes(32);
    const env: Record<string, string | undefined> = {
      TURNTABLE_MASTER_KEY: k.toString("base64"),
      TURNTABLE_MASTER_KEY_PREVIOUS: randomBytes(32).toString("hex"),
    };
    const got = takeMasterKeys(env);
    expect(got?.source).toBe("env");
    expect(got?.key.equals(k)).toBe(true);
    expect(got?.previous?.length).toBe(32);
    expect(env.TURNTABLE_MASTER_KEY).toBeUndefined();
    expect(env.TURNTABLE_MASTER_KEY_PREVIOUS).toBeUndefined();

    const f = join(fresh(), "master.key");
    writeFileSync(f, k, { mode: 0o600 });
    const fromFile = takeMasterKeys({ TURNTABLE_MASTER_KEY_FILE: f });
    expect(fromFile?.source).toBe("file");
    expect(fromFile?.key.equals(k)).toBe(true);
    expect(takeMasterKeys({})).toBeUndefined();
  });

  test("both the variable and the file is an error, and the variable is gone anyway", () => {
    const env: Record<string, string | undefined> = {
      TURNTABLE_MASTER_KEY: randomBytes(32).toString("base64"),
      TURNTABLE_MASTER_KEY_FILE: "/nonexistent/master.key",
    };
    expect(() => takeMasterKeys(env)).toThrow(/both set/);
    expect(env.TURNTABLE_MASTER_KEY).toBeUndefined();
  });

  test("a previous key without a current one, or two previous keys, is an error; the same key twice is no rotation", () => {
    const k = randomBytes(32).toString("base64");
    expect(() => takeMasterKeys({ TURNTABLE_MASTER_KEY_PREVIOUS: k })).toThrow(
      MasterKeyConfigError,
    );
    expect(() =>
      takeMasterKeys({
        TURNTABLE_MASTER_KEY: k,
        TURNTABLE_MASTER_KEY_PREVIOUS: k,
        TURNTABLE_MASTER_KEY_PREVIOUS_FILE: "/x",
      }),
    ).toThrow(MasterKeyConfigError);
    expect(
      takeMasterKeys({ TURNTABLE_MASTER_KEY: k, TURNTABLE_MASTER_KEY_PREVIOUS: k })?.previous,
    ).toBeUndefined();
  });
});

describe("the key never reaches a child process", () => {
  const probe = ["-e", 'console.log(process.env.TURNTABLE_MASTER_KEY ?? "absent")'];
  const run = async (env: Record<string, string | undefined>): Promise<string> => {
    const p = Bun.spawn([process.execPath, ...probe], {
      env: env as Record<string, string>,
      stdout: "pipe",
      stderr: "ignore",
    });
    const out = await new Response(p.stdout).text();
    await p.exited;
    return out.trim();
  };

  test("a real child spawned the way the server spawns them sees no master key", async () => {
    const was = process.env.TURNTABLE_MASTER_KEY;
    process.env.TURNTABLE_MASTER_KEY = randomBytes(32).toString("base64");
    try {
      // The production helper: an allowlist, so the variable is not in it even before the delete.
      expect(await run(scrubbedEnv())).toBe("absent");
      takeMasterKeys(process.env);
      expect(process.env.TURNTABLE_MASTER_KEY).toBeUndefined();
      // And a child that inherits the whole environment cannot find it either.
      expect(await run({ ...process.env })).toBe("absent");
      expect(await run(scrubbedEnv())).toBe("absent");
    } finally {
      if (was === undefined) delete process.env.TURNTABLE_MASTER_KEY;
      else process.env.TURNTABLE_MASTER_KEY = was;
    }
  });

  test("scrubbedEnv refuses to be told to pass the key", () => {
    expect(() => scrubbedEnv({}, ["TURNTABLE_MASTER_KEY"])).toThrow(/refusing/);
    expect(() => scrubbedEnv({ TURNTABLE_MASTER_KEY: "x" })).toThrow(/refusing/);
  });
});

describe("re-wrapping every sealed row", () => {
  const oldKey = randomBytes(32);
  const newKey = randomBytes(32);
  let db: Db;
  let a: Tenant;
  let b: Tenant;
  let anchorDir: string;

  beforeEach(async () => {
    ({ db, a, b } = await seedWorld());
    anchorDir = join(fresh(), "audit-state");
    const store = new SecretStore(db, oldKey);
    for (const t of [a, b]) {
      await store.set(t.orgId, "github/app/private-key", `${VALUE}-${t.orgId}`);
      // An OIDC signing key lives in the `secrets` table, in its own key domain.
      const oidcName = "oidc/key/kid1";
      await putSecretRecord(
        db,
        { orgId: t.orgId },
        oidcName,
        seal(oldKey, VALUE, secretAad(t.orgId, oidcName), "oidc", t.orgId),
      );
      await new SecretVault({ db, masterKey: oldKey }).set(
        t.orgId,
        "test",
        { name: "DEPLOY_KEY", projectId: t.projectId },
        `${VALUE}-vault-${t.orgId}`,
      );
      await new WebhookService({ db, masterKey: oldKey }).ensureSecret(t.orgId);
      new AuditAnchor(anchorDir, oldKey).write(t.orgId, {
        keyId: "k1",
        lastSeq: 7,
        lastHash: "h".repeat(64),
      });
    }
  });

  const run = (opts: Partial<Parameters<typeof rewrapMasterKey>[0]> = {}) =>
    rewrapMasterKey({
      db,
      next: newKey,
      previous: oldKey,
      anchorDir,
      auditOrgId: a.orgId,
      ...opts,
    });

  /** Every sealed value, opened with `key`; undefined for a row it cannot open. */
  async function openAll(key: Buffer): Promise<(string | undefined)[]> {
    const tryOpen = (f: () => string): string | undefined => {
      try {
        return f();
      } catch {
        return undefined;
      }
    };
    const out: (string | undefined)[] = [];
    for (const r of await db.orm.select().from(s.secrets)) {
      const oidc = r.name.startsWith("oidc/key/");
      out.push(
        tryOpen(() =>
          open(key, r.ciphertext, secretAad(r.orgId, r.name), oidc ? "oidc" : "system", r.orgId),
        ),
      );
    }
    for (const r of await db.orm.select().from(s.vaultSecretVersions)) {
      const [sec] = await db.orm
        .select()
        .from(s.vaultSecrets)
        .where(eq(s.vaultSecrets.id, r.secretId));
      out.push(
        tryOpen(() =>
          open(
            key,
            r.ciphertext,
            vaultAad(r.orgId, r.secretId, r.version, sec!.name),
            "job",
            r.orgId,
          ),
        ),
      );
    }
    for (const r of await db.orm.select().from(s.outboundSecrets)) {
      out.push(
        tryOpen(() =>
          open(key, r.sealed, webhookSecretAad(r.orgId, r.version), "webhook", r.orgId),
        ),
      );
    }
    for (const t of [a, b]) {
      try {
        out.push(new AuditAnchor(anchorDir, key).read(t.orgId)?.lastHash);
      } catch {
        out.push(undefined);
      }
    }
    return out;
  }

  const rawRows = async () => ({
    secrets: await db.orm.select().from(s.secrets),
    vault: await db.orm.select().from(s.vaultSecretVersions),
    hooks: await db.orm.select().from(s.outboundSecrets),
    anchors: readdirSync(anchorDir).map((f) => readFileSync(join(anchorDir, f), "utf8")),
  });

  test("every table moves to the new key, with the same values, and the counts are audited", async () => {
    const before = await openAll(oldKey);
    expect(before.every((v) => v !== undefined)).toBe(true);
    expect((await openAll(newKey)).every((v) => v === undefined)).toBe(true);

    const r = await run();
    expect(r.rewrapped).toEqual({
      secrets: 4,
      vault_secret_versions: 2,
      outbound_secrets: 2,
      audit_anchor_files: 2,
    });

    expect(await openAll(newKey)).toEqual(before);
    expect((await openAll(oldKey)).every((v) => v === undefined)).toBe(true);
    // The store reads through the new key now.
    expect(await new SecretStore(db, newKey).get(a.orgId, "github/app/private-key")).toBe(
      `${VALUE}-${a.orgId}`,
    );

    const entry = (await listAudit(db, { orgId: a.orgId })).find(
      (e) => e.op === "master_key_rewrap",
    );
    expect(entry).toBeDefined();
    expect(entry!.principalKind).toBe("system");
    expect(JSON.parse(String(entry!.input))).toEqual({
      secrets: 4,
      vault_secret_versions: 2,
      outbound_secrets: 2,
      audit_anchor_files: 2,
    });
    // No key and no value in the chain.
    expect(String(entry!.input)).not.toContain(VALUE);
  });

  test("it is idempotent: a second run changes nothing and audits nothing", async () => {
    await run();
    const after1 = await rawRows();
    const audits = (await listAudit(db, { orgId: a.orgId })).length;
    const r = await run();
    expect(r.rewrapped).toEqual({
      secrets: 0,
      vault_secret_versions: 0,
      outbound_secrets: 0,
      audit_anchor_files: 0,
    });
    expect(r.alreadyCurrent.secrets).toBe(4);
    expect(await rawRows()).toEqual(after1);
    expect((await listAudit(db, { orgId: a.orgId })).length).toBe(audits);
  });

  test("a partly done rotation is finished: rows under the new key are skipped, the rest move", async () => {
    // One org's secrets were already moved by an earlier, interrupted run.
    const name = "github/app/private-key";
    const sealed = seal(newKey, VALUE, secretAad(a.orgId, name), "system", a.orgId);
    await putSecretRecord(db, { orgId: a.orgId }, name, sealed);
    const r = await run();
    expect(r.alreadyCurrent.secrets).toBe(1);
    expect(r.rewrapped.secrets).toBe(3);
    expect((await openAll(newKey)).every((v) => v !== undefined)).toBe(true);
  });

  test("a row under neither key fails the whole run and nothing changes", async () => {
    // A webhook secret sealed under a third key: the last table planned.
    const stray = randomBytes(32);
    const [row] = await db.orm.select().from(s.outboundSecrets).limit(1);
    await db.orm
      .update(s.outboundSecrets)
      .set({
        sealed: seal(
          stray,
          VALUE,
          webhookSecretAad(row!.orgId, row!.version),
          "webhook",
          row!.orgId,
        ),
      })
      .where(eq(s.outboundSecrets.orgId, row!.orgId));
    const before = await rawRows();
    let err: unknown;
    try {
      await run();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(RewrapError);
    expect(String((err as Error).message)).toContain("outbound_secrets");
    expect(String((err as Error).message)).not.toContain(VALUE);
    expect(await rawRows()).toEqual(before);
    expect(
      (await listAudit(db, { orgId: a.orgId })).some((e) => e.op === "master_key_rewrap"),
    ).toBe(false);
  });

  test("the wrong previous key fails and nothing changes", async () => {
    const before = await rawRows();
    await expect(run({ previous: randomBytes(32) })).rejects.toBeInstanceOf(RewrapError);
    expect(await rawRows()).toEqual(before);
  });

  test("an audit anchor file under neither key stops the run before the database is touched", async () => {
    new AuditAnchor(anchorDir, randomBytes(32)).write(a.orgId, {
      keyId: "k1",
      lastSeq: 1,
      lastHash: "h".repeat(64),
    });
    const before = await rawRows();
    await expect(run()).rejects.toBeInstanceOf(RewrapError);
    expect(await rawRows()).toEqual(before);
  });

  test("a failure after the rows are written (the audit entry) rolls every table back", async () => {
    const before = await rawRows();
    // An org that does not exist: the audit append fails once the updates are done.
    await expect(run({ auditOrgId: "no-such-org" })).rejects.toThrow();
    expect(await rawRows()).toEqual(before);
    expect((await openAll(oldKey)).every((v) => v !== undefined)).toBe(true);
  });
});

/** The real server, started with the key in its environment. SQLite only: it opens its own file. */
const sqliteOnly = DIALECT === "sqlite" ? describe : describe.skip;
sqliteOnly("serve with the key in the environment", () => {
  const MAIN = join(import.meta.dir, "../src/main.ts");
  async function boot(
    data: string,
    env: Record<string, string>,
  ): Promise<{ listening: boolean; out: string }> {
    const p = Bun.spawn(["bun", "run", MAIN, "serve", "--port", "0", "--data-dir", data], {
      env: { PATH: process.env.PATH ?? "", HOME: tmp, ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    let out = "";
    const read = async (st: ReadableStream<Uint8Array>) => {
      for await (const c of st) out += new TextDecoder().decode(c);
    };
    void read(p.stdout);
    void read(p.stderr);
    const deadline = Date.now() + 20_000;
    let listening = false;
    while (Date.now() < deadline && p.exitCode === null) {
      if (/listening on http/.test(out)) {
        listening = true;
        break;
      }
      await Bun.sleep(50);
    }
    p.kill();
    await p.exited;
    return { listening, out };
  }

  test("a key in TURNTABLE_MASTER_KEY starts the server, and with the file too it refuses", async () => {
    const data = fresh();
    const key = randomBytes(32);
    const ok = await boot(data, { TURNTABLE_MASTER_KEY: key.toString("base64") });
    expect(ok.listening).toBe(true);
    expect(ok.out).not.toContain(key.toString("base64"));
    const f = join(fresh(), "master.key");
    writeFileSync(f, key, { mode: 0o600 });
    const both = await boot(data, {
      TURNTABLE_MASTER_KEY: key.toString("base64"),
      TURNTABLE_MASTER_KEY_FILE: f,
    });
    expect(both.listening).toBe(false);
    expect(both.out).toContain("both set");
    expect(both.out).not.toContain(key.toString("base64"));
  }, 60_000);

  test("booting with the new key and the old one as previous re-wraps, then needs only the new key", async () => {
    const data = fresh();
    const oldK = randomBytes(32);
    const newK = randomBytes(32);
    const db = openDatabase(join(data, "turntable.db"));
    const { createOrg } = await import("../src/db");
    const org = await createOrg(db, { slug: "acme", name: "Acme" });
    await new SecretStore(db, oldK).set(org.id, "github/app/private-key", VALUE);
    db.close();

    const first = await boot(data, {
      TURNTABLE_MASTER_KEY: newK.toString("base64"),
      TURNTABLE_MASTER_KEY_PREVIOUS: oldK.toString("base64"),
    });
    expect(first.listening).toBe(true);
    expect(first.out).toMatch(/re-sealed 1 secrets/);
    expect(first.out).not.toContain(oldK.toString("base64"));
    expect(first.out).not.toContain(newK.toString("base64"));

    const again = await boot(data, { TURNTABLE_MASTER_KEY: newK.toString("base64") });
    expect(again.listening).toBe(true);
    const check = openDatabase(join(data, "turntable.db"));
    try {
      expect(await new SecretStore(check, newK).get(org.id, "github/app/private-key")).toBe(VALUE);
    } finally {
      check.close();
    }

    // A wrong previous key stops the boot and changes nothing.
    const bad = await boot(data, {
      TURNTABLE_MASTER_KEY: randomBytes(32).toString("base64"),
      TURNTABLE_MASTER_KEY_PREVIOUS: randomBytes(32).toString("base64"),
    });
    expect(bad.listening).toBe(false);
    const check2 = openDatabase(join(data, "turntable.db"));
    try {
      expect(await new SecretStore(check2, newK).get(org.id, "github/app/private-key")).toBe(VALUE);
    } finally {
      check2.close();
    }
  }, 90_000);
});
