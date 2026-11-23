import { afterAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scrubbedEnv } from "@turntable/provider-sdk";
import { AuditAnchor } from "../src/audit/anchor";
import { open, vaultAad } from "../src/secrets/crypto";
import { anchorKeyMessage } from "../src/secrets/master-key";
import { rewrapMasterKey, RewrapError } from "../src/secrets/rewrap";
import { SecretVault } from "../src/secrets/vault";
import { fileKeyVault } from "../src/release/key-vault";
import { rewrapReleaseKey } from "../src/release/rewrap";
import { releaseConfigFromEnv, releaseMasterKey } from "../src/roles";
import * as s from "../src/db/schema";
import { seedWorld } from "./ops-helpers";

const tmp = mkdtempSync(join(tmpdir(), "tt-relkey-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const fresh = (): string => {
  const d = join(tmp, `t${n++}`);
  mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
};
const VALUE = ["release", "fixture", "value", "9913"].join("-");

const envWith = (
  extra: Record<string, string | undefined>,
): Record<string, string | undefined> => ({
  TURNTABLE_RELEASE_DATA_DIR: "/d",
  TURNTABLE_RELEASE_GITHUB_TOKEN: "t",
  TURNTABLE_RELEASE_ARTIFACT_DIR: "/a",
  TURNTABLE_RELEASE_BUILDER_ID: "https://ci.example.com",
  ...extra,
});

describe("the release key from the environment", () => {
  test("is read once, parsed and deleted from the environment", () => {
    const k = randomBytes(32);
    const prev = randomBytes(32);
    const env = envWith({
      TURNTABLE_RELEASE_MASTER_KEY: k.toString("base64"),
      TURNTABLE_RELEASE_MASTER_KEY_PREVIOUS: prev.toString("hex"),
    });
    const cfg = releaseConfigFromEnv(env);
    expect(env.TURNTABLE_RELEASE_MASTER_KEY).toBeUndefined();
    expect(env.TURNTABLE_RELEASE_MASTER_KEY_PREVIOUS).toBeUndefined();
    expect(cfg.masterKeyFile).toBeUndefined();
    expect(releaseMasterKey(cfg).equals(k)).toBe(true);
    expect(cfg.previousMasterKey?.equals(prev)).toBe(true);
    expect(JSON.stringify(cfg)).not.toContain(k.toString("base64"));
  });

  test("both the variable and the file is an error, and the variable is gone anyway", () => {
    const env = envWith({
      TURNTABLE_RELEASE_MASTER_KEY: randomBytes(32).toString("base64"),
      TURNTABLE_RELEASE_MASTER_KEY_FILE: "/k",
    });
    expect(() => releaseConfigFromEnv(env)).toThrow(/both set/);
    expect(env.TURNTABLE_RELEASE_MASTER_KEY).toBeUndefined();
  });

  test("a previous key alone, a bad value and no key at all are refused", () => {
    expect(() =>
      releaseConfigFromEnv(
        envWith({ TURNTABLE_RELEASE_MASTER_KEY_PREVIOUS: randomBytes(32).toString("hex") }),
      ),
    ).toThrow(/no current release key/);
    expect(() => releaseConfigFromEnv(envWith({ TURNTABLE_RELEASE_MASTER_KEY: "nope" }))).toThrow(
      /32 bytes/,
    );
    expect(() => releaseConfigFromEnv(envWith({}))).toThrow(/TURNTABLE_RELEASE_MASTER_KEY_FILE/);
  });

  test("a real child sees no release key, spawned like the server does or inheriting the scrubbed environment", async () => {
    const probe = [
      "-e",
      'console.log(process.env.TURNTABLE_RELEASE_MASTER_KEY ?? "absent", process.env.TURNTABLE_RELEASE_MASTER_KEY_PREVIOUS ?? "absent")',
    ];
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
    const saved = { ...process.env };
    process.env.TURNTABLE_RELEASE_MASTER_KEY = randomBytes(32).toString("base64");
    process.env.TURNTABLE_RELEASE_MASTER_KEY_PREVIOUS = randomBytes(32).toString("base64");
    try {
      expect(await run(scrubbedEnv())).toBe("absent absent");
      expect(() => scrubbedEnv({}, ["TURNTABLE_RELEASE_MASTER_KEY"])).toThrow(/refusing/);
      Object.assign(process.env, envWith({ TURNTABLE_RELEASE_DATA_DIR: "/d" }));
      releaseConfigFromEnv(process.env);
      expect(await run({ ...process.env })).toBe("absent absent");
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });
});

describe("re-wrapping the release lane's state", () => {
  const oldKey = randomBytes(32);
  const newKey = randomBytes(32);
  const mainKey = randomBytes(32);

  async function world() {
    const { db, a } = await seedWorld();
    const keys = join(fresh(), "keys");
    const release = new SecretVault({ db, masterKey: oldKey, lane: "release" });
    await release.set(a.orgId, "test", { name: "NPM_TOKEN", projectId: a.projectId }, VALUE, {
      trustClasses: ["release"],
    });
    // A main-key secret that also allows `release` (the default classes).
    await new SecretVault({ db, masterKey: mainKey }).set(
      a.orgId,
      "test",
      { name: "DEPLOY_KEY", projectId: a.projectId },
      `${VALUE}-main`,
    );
    const kv = fileKeyVault(keys, oldKey);
    await kv.set("builtin/org1/key", "signing-key-pem");
    await kv.set("plain", "other-key");
    return { db, a, keys };
  }

  const cipherOf = async (
    db: Awaited<ReturnType<typeof world>>["db"],
    name: string,
  ): Promise<{ row: typeof s.vaultSecretVersions.$inferSelect; secretName: string }> => {
    const secrets = await db.orm.select().from(s.vaultSecrets);
    const sec = secrets.find((x) => x.name === name)!;
    const vs = await db.orm.select().from(s.vaultSecretVersions);
    return { row: vs.find((v) => v.secretId === sec.id)!, secretName: name };
  };

  test("publish credentials and signing key files move to the new key; the main key's rows are left alone", async () => {
    const { db, a, keys } = await world();
    const before = await cipherOf(db, "DEPLOY_KEY");
    const r = await rewrapReleaseKey({
      db,
      next: newKey,
      previous: oldKey,
      keysDir: keys,
      auditOrgId: a.orgId,
    });
    expect(r).toMatchObject({ vault_secret_versions: 1, signing_key_files: 2 });
    expect(r.skipped).toHaveLength(1);
    const npm = await cipherOf(db, "NPM_TOKEN");
    expect(
      open(
        newKey,
        npm.row.ciphertext,
        vaultAad(npm.row.orgId, npm.row.secretId, npm.row.version, "NPM_TOKEN"),
        "job",
        npm.row.orgId,
      ),
    ).toBe(VALUE);
    expect((await cipherOf(db, "DEPLOY_KEY")).row.ciphertext).toBe(before.row.ciphertext);
    const kv = fileKeyVault(keys, newKey);
    expect(await kv.get("builtin/org1/key")).toBe("signing-key-pem");
    expect(await kv.get("plain")).toBe("other-key");
    expect(readdirSync(keys).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    // Idempotent: a second run (the previous key left set) changes nothing.
    const again = await rewrapReleaseKey({
      db,
      next: newKey,
      previous: oldKey,
      keysDir: keys,
      auditOrgId: a.orgId,
    });
    expect(again).toMatchObject({ vault_secret_versions: 0, signing_key_files: 0 });
    // And the main process's re-wrap leaves the lane's row alone too.
    const main = await rewrapMasterKey({
      db,
      next: randomBytes(32),
      previous: mainKey,
      auditOrgId: a.orgId,
    });
    expect(main.rewrapped.vault_secret_versions).toBe(1);
    expect(main.skipped).toHaveLength(1);
  });

  test("a signing key file under neither key stops the run before anything is written", async () => {
    const { db, a, keys } = await world();
    await fileKeyVault(keys, randomBytes(32)).set("stray", "x");
    const files = readdirSync(keys).map((f) => readFileSync(join(keys, f), "utf8"));
    const npm = (await cipherOf(db, "NPM_TOKEN")).row.ciphertext;
    await expect(
      rewrapReleaseKey({ db, next: newKey, previous: oldKey, keysDir: keys, auditOrgId: a.orgId }),
    ).rejects.toThrow(RewrapError);
    expect(readdirSync(keys).map((f) => readFileSync(join(keys, f), "utf8"))).toEqual(files);
    expect((await cipherOf(db, "NPM_TOKEN")).row.ciphertext).toBe(npm);
  });
});

describe("an audit anchor under another key", () => {
  test("is named with the fix, and a re-wrap with the previous key clears it", async () => {
    const dir = join(fresh(), "audit-state");
    const oldKey = randomBytes(32);
    const newKey = randomBytes(32);
    new AuditAnchor(dir, oldKey).write("01ORGAAAA", { keyId: "k", lastSeq: 3, lastHash: "h" });
    expect(new AuditAnchor(dir, oldKey).unreadable()).toEqual([]);
    const bad = new AuditAnchor(dir, newKey).unreadable();
    expect(bad).toEqual(["01ORGAAAA"]);
    const msg = anchorKeyMessage(bad[0]!);
    expect(msg).toContain("audit anchor for org 01ORGAAAA");
    expect(msg).toContain("previous");
    expect(msg).toContain("TURNTABLE_MASTER_KEY_PREVIOUS");
    expect(msg).toContain("restart");
    expect(msg).not.toContain(newKey.toString("base64"));
    const { db, a } = await seedWorld();
    await rewrapMasterKey({
      db,
      next: newKey,
      previous: oldKey,
      anchorDir: dir,
      auditOrgId: a.orgId,
    });
    expect(new AuditAnchor(dir, newKey).unreadable()).toEqual([]);
  });
});
