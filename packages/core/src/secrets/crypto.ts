// Envelope encryption for the built-in secret store.
//
// Each record gets its own random 256-bit data key (DEK). The value is sealed with AES-256-GCM
// under the DEK, and the DEK is sealed with AES-256-GCM under the master key. Both seals bind
// the same AAD (org id and secret name), so a record cannot be replayed under another name or
// org, and any flipped bit, wrong AAD or wrong master key makes `open` throw. Fail closed.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const VERSION = "v1";
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

/** Seals `plaintext`. The result is one string: `v1.<wrap iv>.<wrapped dek>.<wrap tag>.<iv>.<ct>.<tag>`. */
export function seal(masterKey: Buffer, plaintext: string, aad: Buffer): string {
  assertKey(masterKey);
  const dek = randomBytes(KEY_BYTES);
  try {
    const wrapped = gcmSeal(masterKey, dek, aad);
    const body = gcmSeal(dek, Buffer.from(plaintext, "utf8"), aad);
    return [
      VERSION,
      b64(wrapped.iv),
      b64(wrapped.ct),
      b64(wrapped.tag),
      b64(body.iv),
      b64(body.ct),
      b64(body.tag),
    ].join(".");
  } finally {
    dek.fill(0);
  }
}

/** Opens a sealed record. Throws SecretDecryptError for anything wrong, with no detail. */
export function open(masterKey: Buffer, record: string, aad: Buffer): string {
  assertKey(masterKey);
  const parts = record.split(".");
  if (parts.length !== 7 || parts[0] !== VERSION) throw new SecretDecryptError();
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
    dek = gcmOpen(masterKey, unb64(wIv), unb64(wCt), unb64(wTag), aad);
    if (dek.length !== KEY_BYTES) throw new SecretDecryptError();
    return gcmOpen(dek, unb64(iv), unb64(ct), unb64(tag), aad).toString("utf8");
  } catch {
    throw new SecretDecryptError();
  } finally {
    dek?.fill(0);
  }
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
