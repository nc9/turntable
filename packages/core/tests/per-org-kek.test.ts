import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditAnchor } from "../src/audit/anchor";
import { getSecretRecord, putSecretRecord, type Db } from "../src/db";
import { setVaultCiphertext } from "../src/db/repos";
import { OidcKeyStore } from "../src/oidc/keys";
import {
  domainKey,
  open,
  recordVersion,
  seal,
  SecretDecryptError,
  secretAad,
  vaultAad,
} from "../src/secrets/crypto";
import { SecretStore } from "../src/secrets/store";
import { SecretVault } from "../src/secrets/vault";
import { seedWorld, type Tenant } from "./ops-helpers";

const master = randomBytes(32);
let db: Db;
let a: Tenant;
let b: Tenant;
let dir: string;
beforeEach(async () => {
  ({ db, a, b } = await seedWorld());
  dir = mkdtempSync(join(tmpdir(), "ls-kek-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.LONGSHORE_REQUIRE_ORG_KEYS;
});

describe("the key-encryption key is per org", () => {
  test("each org derives its own key, different from the domain key and from every other org", () => {
    const ka = domainKey(master, "job", "org-a");
    const kb = domainKey(master, "job", "org-b");
    expect(ka.equals(kb)).toBe(false);
    expect(ka.equals(domainKey(master, "job"))).toBe(false);
    expect(ka.equals(domainKey(master, "oidc", "org-a"))).toBe(false);
    expect(ka.equals(domainKey(master, "job", "org-a"))).toBe(true);
    // org ids are length-prefixed: ("a", ...) never collides with another split of the same text
    expect(domainKey(master, "job", "ab").equals(domainKey(master, "job", "a"))).toBe(false);
  });

  test("a per-org record opens for its org only, even when the AAD is exactly right", () => {
    const aad = secretAad("shared", "name"); // the same AAD, as an attacker who forged it would present
    const rec = seal(master, "value", aad, "system", "org-a");
    expect(recordVersion(rec)).toBe("v3");
    expect(open(master, rec, aad, "system", "org-a")).toBe("value");
    expect(() => open(master, rec, aad, "system", "org-b")).toThrow(SecretDecryptError);
    expect(() => open(master, rec, aad, "system")).toThrow(SecretDecryptError);
    expect(() => open(master, rec, aad, "job", "org-a")).toThrow(SecretDecryptError);
  });

  test("an older per-domain record still opens, until LONGSHORE_REQUIRE_ORG_KEYS=1", () => {
    const aad = secretAad("org-a", "n");
    const old = seal(master, "value", aad, "system");
    expect(recordVersion(old)).toBe("v2");
    expect(open(master, old, aad, "system", "org-a")).toBe("value");
    process.env.LONGSHORE_REQUIRE_ORG_KEYS = "1";
    expect(() => open(master, old, aad, "system", "org-a")).toThrow(SecretDecryptError);
    // a record with no org (the release lane's own keys) is unaffected
    expect(open(master, old, aad, "system")).toBe("value");
  });
});

describe("what is sealed per org, and the re-seal", () => {
  test("the secret store writes v3 and reseal converts v2, leaving the value and other orgs alone", async () => {
    const store = new SecretStore(db, master);
    await store.set(a.orgId, "new", "n1");
    expect(recordVersion((await getSecretRecord(db, { orgId: a.orgId }, "new"))!)).toBe("v3");
    await putSecretRecord(
      db,
      { orgId: a.orgId },
      "old",
      seal(master, "o1", secretAad(a.orgId, "old"), "system"),
    );
    await putSecretRecord(
      db,
      { orgId: b.orgId },
      "old",
      seal(master, "o2", secretAad(b.orgId, "old"), "system"),
    );
    expect(await store.reseal(a.orgId)).toBe(1);
    expect(recordVersion((await getSecretRecord(db, { orgId: a.orgId }, "old"))!)).toBe("v3");
    expect(await store.get(a.orgId, "old")).toBe("o1");
    expect(await store.get(a.orgId, "new")).toBe("n1");
    expect(await store.reseal(a.orgId)).toBe(0); // idempotent
    // org B's record was not touched, and still opens
    expect(recordVersion((await getSecretRecord(db, { orgId: b.orgId }, "old"))!)).toBe("v2");
    expect(await store.get(b.orgId, "old")).toBe("o2");
    // a v3 record moved to another org, even renamed to match, does not open there
    const moved = (await getSecretRecord(db, { orgId: a.orgId }, "old"))!;
    await putSecretRecord(db, { orgId: b.orgId }, "stolen", moved);
    await expect(store.get(b.orgId, "stolen")).rejects.toThrow(SecretDecryptError);
  });

  test("the vault seals new versions per org, and reseal converts older ones; use still works", async () => {
    const vault = new SecretVault({ db, masterKey: master });
    const { secret } = await vault.set(
      a.orgId,
      "t",
      { name: "TOKEN", projectId: null, environment: null, refPattern: null },
      "the-value",
      { destinations: ["x.example.com"] },
    );
    const { listVaultCiphertexts } = await import("../src/db/repos");
    const [row] = await listVaultCiphertexts(db, a.orgId);
    expect(recordVersion(row!.ciphertext)).toBe("v3");
    // an older record: the same value sealed per domain only
    const aad = vaultAad(a.orgId, row!.secretId, row!.version, "TOKEN");
    await setVaultCiphertext(
      db,
      a.orgId,
      row!.secretId,
      row!.version,
      seal(master, "the-value", aad, "job"),
    );
    expect(recordVersion((await listVaultCiphertexts(db, a.orgId))[0]!.ciphertext)).toBe("v2");
    expect(await vault.reseal(a.orgId)).toBe(1);
    expect(recordVersion((await listVaultCiphertexts(db, a.orgId))[0]!.ciphertext)).toBe("v3");
    expect(await vault.reseal(a.orgId)).toBe(0);
    expect(secret.name).toBe("TOKEN");
    // opening as another org fails even with A's exact AAD
    const sealed = (await listVaultCiphertexts(db, a.orgId))[0]!.ciphertext;
    expect(() => open(master, sealed, aad, "job", b.orgId)).toThrow(SecretDecryptError);
  });

  test("OIDC signing keys are sealed per org", async () => {
    await new OidcKeyStore(db, master).current(a.orgId);
    const { listSecretNames } = await import("../src/db/repos");
    const names = (await listSecretNames(db, { orgId: a.orgId })).filter((n) =>
      n.startsWith("oidc/"),
    );
    expect(names.length).toBeGreaterThan(0);
    for (const n of names) {
      expect(recordVersion((await getSecretRecord(db, { orgId: a.orgId }, n))!)).toBe("v3");
    }
  });

  test("the audit anchor state is sealed per org and reseal converts an older file", () => {
    const anchor = new AuditAnchor(dir, master);
    anchor.write(a.orgId, { keyId: "k1", lastSeq: 3, lastHash: "h" }, 5);
    const file = join(dir, `${a.orgId}.state`);
    expect(recordVersion(readFileSync(file, "utf8"))).toBe("v3");
    expect(anchor.read(a.orgId)).toMatchObject({ keyId: "k1", lastSeq: 3 });
    expect(anchor.reseal(a.orgId)).toBe(false); // already per-org
    // an older state file: sealed per domain, with the same AAD
    const body = seal(
      master,
      JSON.stringify({ v: 1, keyId: "k2", lastSeq: 9, lastHash: "g", updatedAt: 7 }),
      Buffer.from(`longshore:audit-anchor:${b.orgId}`, "utf8"),
    );
    writeFileSync(join(dir, `${b.orgId}.state`), body);
    expect(anchor.read(b.orgId)).toMatchObject({ keyId: "k2", lastSeq: 9 });
    expect(anchor.reseal(b.orgId)).toBe(true);
    expect(recordVersion(readFileSync(join(dir, `${b.orgId}.state`), "utf8"))).toBe("v3");
    expect(anchor.read(b.orgId)).toMatchObject({ keyId: "k2", lastSeq: 9, updatedAt: 7 });
  });
});
