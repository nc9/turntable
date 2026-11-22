import { afterAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureLocalTenant, openDatabase, putSecretRecord } from "../src/db";
import {
  SecretDecryptError,
  initMasterKey,
  loadMasterKey,
  open,
  seal,
  secretAad,
} from "../src/secrets/crypto";
import { SecretStore } from "../src/secrets/store";

const tmp = mkdtempSync(join(tmpdir(), "ls-secrets-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const key = randomBytes(32);
const aad = secretAad("org1", "github-app/private-key");

describe("envelope encryption", () => {
  test("round trip; every seal is different; the record never holds the value", () => {
    const a = seal(key, "s3cr3t-value", aad);
    const b = seal(key, "s3cr3t-value", aad);
    expect(a).not.toBe(b);
    expect(a).not.toContain("s3cr3t-value");
    expect(open(key, a, aad)).toBe("s3cr3t-value");
  });

  test("a flipped bit in any part of the record is detected", () => {
    const rec = seal(key, "value", aad);
    const parts = rec.split(".");
    for (let i = 1; i < parts.length; i += 1) {
      const bad = [...parts];
      const buf = Buffer.from(bad[i] as string, "base64url");
      buf[0] = (buf[0] ?? 0) ^ 1;
      bad[i] = buf.toString("base64url");
      expect(() => open(key, bad.join("."), aad)).toThrow(SecretDecryptError);
    }
    expect(() => open(key, `v9.${parts.slice(1).join(".")}`, aad)).toThrow(SecretDecryptError);
    expect(() => open(key, "garbage", aad)).toThrow(SecretDecryptError);
  });

  test("wrong AAD (another name or org) and wrong master key fail closed, without detail", () => {
    const rec = seal(key, "value", aad);
    for (const bad of [
      secretAad("org1", "other-name"),
      secretAad("org2", "github-app/private-key"),
    ]) {
      expect(() => open(key, rec, bad)).toThrow(SecretDecryptError);
    }
    expect(() => open(randomBytes(32), rec, aad)).toThrow(SecretDecryptError);
    try {
      open(randomBytes(32), rec, aad);
    } catch (e) {
      expect((e as Error).message).toBe("secret could not be decrypted");
    }
  });

  test("the AAD cannot be confused across the org/name boundary", () => {
    expect(secretAad("a", "bc").equals(secretAad("ab", "c"))).toBe(false);
  });

  test("a master key of the wrong size is refused", () => {
    expect(() => seal(randomBytes(16), "v", aad)).toThrow(/32 bytes/);
  });
});

describe("master key file", () => {
  test("keys init creates a 32-byte 0600 file and refuses to overwrite", () => {
    const f = join(tmp, "sub", "master.key");
    initMasterKey(f);
    expect(statSync(f).size).toBe(32);
    expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(loadMasterKey(f)).toHaveLength(32);
    expect(() => initMasterKey(f)).toThrow(/refusing to overwrite/);
  });

  test("a missing or wrong-size file fails", () => {
    expect(() => loadMasterKey(join(tmp, "nope"))).toThrow(/not found/);
    const f = join(tmp, "short.key");
    writeFileSync(f, "tiny");
    expect(() => loadMasterKey(f)).toThrow(/exactly 32 bytes/);
  });
});

describe("SecretStore", () => {
  test("set, get, has, list (names only), delete", async () => {
    const db = openDatabase(":memory:");
    const { orgId } = await ensureLocalTenant(db);
    const store = new SecretStore(db, key);
    await store.set(orgId, "a/one", "value-one");
    await store.set(orgId, "a/two", "value-two");
    await store.set(orgId, "a/one", "value-one-v2");
    expect(await store.get(orgId, "a/one")).toBe("value-one-v2");
    expect(await store.has(orgId, "a/two")).toBe(true);
    const names = await store.list(orgId);
    expect(names).toEqual(["a/one", "a/two"]);
    expect(JSON.stringify(names)).not.toContain("value");
    expect(await store.delete(orgId, "a/one")).toBe(true);
    expect(await store.get(orgId, "a/one")).toBeUndefined();
  });

  test("an org cannot read another org's secret, and a row moved to another name fails", async () => {
    const db = openDatabase(":memory:");
    const { orgId } = await ensureLocalTenant(db);
    const store = new SecretStore(db, key);
    await store.set(orgId, "name-a", "value-a");
    expect(await store.get("other-org", "name-a")).toBeUndefined();
    // Copy name-a's sealed record under name-b: the AAD no longer matches.
    const rec = seal(key, "value-a", secretAad(orgId, "name-a"));
    await putSecretRecord(db, { orgId }, "name-b", rec);
    await expect(store.get(orgId, "name-b")).rejects.toBeInstanceOf(SecretDecryptError);
  });

  test("a store with the wrong master key fails closed", async () => {
    const db = openDatabase(":memory:");
    const { orgId } = await ensureLocalTenant(db);
    await new SecretStore(db, key).set(orgId, "x", "value");
    await expect(new SecretStore(db, randomBytes(32)).get(orgId, "x")).rejects.toBeInstanceOf(
      SecretDecryptError,
    );
  });

  test("bad names are refused", async () => {
    const db = openDatabase(":memory:");
    const { orgId } = await ensureLocalTenant(db);
    await expect(new SecretStore(db, key).set(orgId, "has space", "v")).rejects.toThrow(
      /invalid secret name/,
    );
  });
});
