// Envelope encryption for the built-in secret store.
//
// Each record gets its own random 256-bit data key (DEK). The value is sealed with AES-256-GCM
// under the DEK, and the DEK is sealed with AES-256-GCM under the master key. Both seals bind
// the same AAD (org id and secret name), so a record cannot be replayed under another name or
// org, and any flipped bit, wrong AAD or wrong master key makes `open` throw. Fail closed.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const VERSION = "v1";
const VERSION_DOMAIN = "v2";
const VERSION_ORG = "v3";

/** Key domains: a record sealed for one domain cannot be opened as another. */
export type KeyDomain = "system" | "job" | "oidc" | "attempt" | "cache";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Never carries detail: telling a caller why decryption failed would help an attacker. */
export class SecretDecryptError extends Error {
  constructor() {
    super("secret could not be decrypted");
    this.name = "SecretDecryptError";
  }
}

/** AAD for a record. Length-prefixed so (org "a", name "bc") never equals (org "ab", name "c"). */
export function secretAad(orgId: string, name: string): Buffer {
  return Buffer.from(`longshore:${VERSION}:${orgId.length}:${orgId}:${name}`, "utf8");
}

function gcmSeal(
  key: Buffer,
  plaintext: Buffer,
  aad: Buffer,
): { iv: Buffer; ct: Buffer; tag: Buffer } {
  const iv = randomBytes(IV_BYTES);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(aad);
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  return { iv, ct, tag: c.getAuthTag() };
}

function gcmOpen(key: Buffer, iv: Buffer, ct: Buffer, tag: Buffer, aad: Buffer): Buffer {
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new SecretDecryptError();
  const d = createDecipheriv("aes-256-gcm", key, iv);
  d.setAAD(aad);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}

const b64 = (b: Buffer): string => b.toString("base64url");
const unb64 = (s: string): Buffer => Buffer.from(s, "base64url");

/**
 * The wrapping key for a domain: HKDF-SHA256 over the master key, domain in the info string. With
 * an org, the org id is in the info string too, so each org has its own key-encryption key: a
 * value sealed for org A is opened with A's key only, whatever AAD is presented, and the keys
 * for two orgs differ without any further secret.
 */
export function domainKey(masterKey: Buffer, domain: KeyDomain, orgId?: string): Buffer {
  assertKey(masterKey);
  const info =
    orgId === undefined
      ? `longshore:domain:${domain}`
      : `longshore:domain:${domain}:org:${orgId.length}:${orgId}`;
  return Buffer.from(hkdfSync("sha256", masterKey, Buffer.alloc(0), info, KEY_BYTES));
}

/** The record format: `v1` (master key wraps directly), `v2` (per domain), `v3` (per domain and org). */
export function recordVersion(record: string): "v1" | "v2" | "v3" | undefined {
  const v = record.slice(0, record.indexOf("."));
  return v === VERSION || v === VERSION_DOMAIN || v === VERSION_ORG ? v : undefined;
}

/**
 * When `LONGSHORE_REQUIRE_ORG_KEYS=1`, a record that is not per-org (v1, v2) is refused wherever
 * an org is known. Set it once `keys reseal` has run for every org: it stops a stale copy of an
 * old record from being accepted.
 */
const requireOrgKeys = (): boolean => process.env.LONGSHORE_REQUIRE_ORG_KEYS === "1";

const withDomain = (aad: Buffer, domain: KeyDomain, orgId?: string): Buffer =>
  Buffer.concat([
    aad,
    Buffer.from(`|domain:${domain}${orgId === undefined ? "" : `|org:${orgId}`}`, "utf8"),
  ]);

/**
 * Seals `plaintext` for a key domain. The wrapping key is derived for that domain and the domain
 * is bound into the AAD, so the record opens only as that domain. With `orgId` the wrapping key
 * is the org's own (format v3). The result is one string:
 * `v2.<wrap iv>.<wrapped dek>.<wrap tag>.<iv>.<ct>.<tag>` (or `v3.` with an org).
 */
export function seal(
  masterKey: Buffer,
  plaintext: string,
  aad: Buffer,
  domain: KeyDomain = "system",
  orgId?: string,
): string {
  return sealWith(
    domainKey(masterKey, domain, orgId),
    orgId === undefined ? VERSION_DOMAIN : VERSION_ORG,
    plaintext,
    withDomain(aad, domain, orgId),
  );
}

function sealWith(wrapKey: Buffer, version: string, plaintext: string, aad: Buffer): string {
  const dek = randomBytes(KEY_BYTES);
  try {
    const wrapped = gcmSeal(wrapKey, dek, aad);
    const body = gcmSeal(dek, Buffer.from(plaintext, "utf8"), aad);
    return [
      version,
      b64(wrapped.iv),
      b64(wrapped.ct),
      b64(wrapped.tag),
      b64(body.iv),
      b64(body.ct),
      b64(body.tag),
    ].join(".");
  } finally {
    dek.fill(0);
    wrapKey.fill(0);
  }
}

/** Seals in the legacy v1 format (master key wraps directly). Only for tests of old records. */
export function sealLegacyV1(masterKey: Buffer, plaintext: string, aad: Buffer): string {
  assertKey(masterKey);
  return sealWith(Buffer.from(masterKey), VERSION, plaintext, aad);
}

/** True for a record written before key domains existed. */
export const isLegacyRecord = (record: string): boolean => record.startsWith(`${VERSION}.`);

/**
 * Opens a sealed record for `domain`. Legacy v1 records (no domain) still open, for the system
 * store only; a vault record is v2 by construction. Throws SecretDecryptError for anything
 * wrong, with no detail.
 */
export function open(
  masterKey: Buffer,
  record: string,
  aad: Buffer,
  domain: KeyDomain = "system",
  orgId?: string,
): string {
  assertKey(masterKey);
  const parts = record.split(".");
  if (parts.length !== 7) throw new SecretDecryptError();
  const version = parts[0];
  let wrapKey: Buffer;
  let fullAad: Buffer;
  if (version === VERSION_ORG) {
    // A per-org record opens only for the org it names: asked with no org, or another, it fails.
    if (orgId === undefined) throw new SecretDecryptError();
    wrapKey = domainKey(masterKey, domain, orgId);
    fullAad = withDomain(aad, domain, orgId);
  } else if (version === VERSION_DOMAIN && !(orgId !== undefined && requireOrgKeys())) {
    wrapKey = domainKey(masterKey, domain);
    fullAad = withDomain(aad, domain);
  } else if (
    version === VERSION &&
    domain === "system" &&
    !(orgId !== undefined && requireOrgKeys())
  ) {
    wrapKey = Buffer.from(masterKey);
    fullAad = aad;
  } else {
    throw new SecretDecryptError();
  }
  const [, wIv, wCt, wTag, iv, ct, tag] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  let dek: Buffer | undefined;
  try {
    dek = gcmOpen(wrapKey, unb64(wIv), unb64(wCt), unb64(wTag), fullAad);
    if (dek.length !== KEY_BYTES) throw new SecretDecryptError();
    return gcmOpen(dek, unb64(iv), unb64(ct), unb64(tag), fullAad).toString("utf8");
  } catch {
    throw new SecretDecryptError();
  } finally {
    dek?.fill(0);
    wrapKey.fill(0);
  }
}

/**
 * AAD for a vault version: domain-independent fields, length-prefixed so no two tuples collide.
 * Binds the org, the secret id, the version number and the name.
 */
export function vaultAad(orgId: string, secretId: string, version: number, name: string): Buffer {
  const f = [orgId, secretId, String(version), name].map((x) => `${x.length}:${x}`).join("|");
  return Buffer.from(`longshore:vault:${f}`, "utf8");
}

function assertKey(key: Buffer): void {
  if (key.length !== KEY_BYTES) throw new Error(`master key must be ${KEY_BYTES} bytes`);
}

/** Reads the master key: a file of exactly 32 raw bytes. */
export function loadMasterKey(path: string): Buffer {
  if (!existsSync(path))
    throw new Error(`master key file not found: ${path} (run: longshore keys init)`);
  const key = readFileSync(path);
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `master key file ${path} must be exactly ${KEY_BYTES} bytes, got ${key.length}`,
    );
  }
  return key;
}

/** Creates a new random master key file (mode 0600). Refuses to overwrite an existing one. */
export function initMasterKey(path: string): void {
  if (existsSync(path)) throw new Error(`refusing to overwrite existing master key file ${path}`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, randomBytes(KEY_BYTES), { mode: 0o600, flag: "wx" });
  chmodSync(path, 0o600);
}
