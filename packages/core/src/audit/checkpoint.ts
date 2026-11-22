// Signed checkpoints. A checkpoint is an ed25519 signature over (org, seq, hash) of the chain's
// head. The private key lives in the encrypted secret store, which has a different master key
// than the database, so someone who can rewrite audit rows cannot also forge a checkpoint over
// the rewritten chain. `audit verify` then proves the chain still matches what was signed.
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from "node:crypto";
import type { Db } from "../db";
import {
  auditHead,
  latestCheckpoint,
  orgsWithAudit,
  putCheckpoint,
  type AuditCheckpoint,
} from "../db/repos";
import type { SecretStore } from "../secrets/store";
import { canonicalJson } from "./chain";
import { auditFailure, flushAggregates } from "./failures";

export const AUDIT_KEY_SECRET = "audit/signing-key";

/** A checkpoint after this many new entries, or this long after the last one, whichever is first. */
export const CHECKPOINT_EVERY_ENTRIES = 100;
export const CHECKPOINT_EVERY_MS = 10 * 60_000;

export interface AuditKey {
  privateKeyPem: string;
  publicKeyPem: string;
  keyId: string;
}

const keyIdOf = (publicKeyPem: string): string =>
  createHash("sha256")
    .update(createPublicKey(publicKeyPem).export({ type: "spki", format: "der" }))
    .digest("hex")
    .slice(0, 16);

export function keyFromPrivatePem(privateKeyPem: string): AuditKey {
  const publicKeyPem = createPublicKey(createPrivateKey(privateKeyPem))
    .export({ type: "spki", format: "pem" })
    .toString();
  return { privateKeyPem, publicKeyPem, keyId: keyIdOf(publicKeyPem) };
}

/** The signing key is gone from the store although the org has signed checkpoints. */
export class AuditKeyMissing extends Error {
  constructor(orgId: string) {
    super(
      `audit signing key for org ${orgId} is missing from the secret store but checkpoints exist; ` +
        "refusing to generate a new one (it could re-sign a rewritten chain). Restore the key, or " +
        "verify against a pinned public key and decide whether the chain can still be trusted.",
    );
  }
}

/** The org's signing key from the secret store, or undefined when there is none. */
export async function loadAuditKey(
  store: SecretStore,
  orgId: string,
): Promise<AuditKey | undefined> {
  const pem = await store.get(orgId, AUDIT_KEY_SECRET);
  return pem ? keyFromPrivatePem(pem) : undefined;
}

/**
 * The org's signing key. Generated only while the org has never signed a checkpoint. Once one
 * exists, a missing key is an error and an audit alert, never a reason to make a new one: a new
 * key would let someone who deleted the old one re-sign a rewritten chain.
 */
export async function ensureAuditKey(db: Db, store: SecretStore, orgId: string): Promise<AuditKey> {
  const existing = await loadAuditKey(store, orgId);
  if (existing) return existing;
  if (await latestCheckpoint(db, orgId)) {
    await auditFailure(db, {
      orgId,
      principalKind: "system",
      principalId: "audit",
      source: orgId,
      kind: "key_missing",
      op: "audit_signing_key",
      outcome: "error:key_missing",
    });
    throw new AuditKeyMissing(orgId);
  }
  const { privateKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  await store.set(orgId, AUDIT_KEY_SECRET, pem);
  return keyFromPrivatePem(pem);
}

/** What an operator keeps outside the server to anchor verification. */
export interface PublicKeyFile {
  v: 1;
  orgId: string;
  org: string;
  keyId: string;
  publicKey: string;
}

export const publicKeyFile = (orgId: string, org: string, key: AuditKey): PublicKeyFile => ({
  v: 1,
  orgId,
  org,
  keyId: key.keyId,
  publicKey: key.publicKeyPem,
});

/** Parses and checks a key file: the key id must really be the id of the key it carries. */
export function parsePublicKeyFile(text: string): PublicKeyFile {
  const f = JSON.parse(text) as Partial<PublicKeyFile>;
  if (f.v !== 1 || !f.orgId || !f.keyId || !f.publicKey) throw new Error("not an audit key file");
  if (keyIdOf(f.publicKey) !== f.keyId) throw new Error("key file: key id does not match the key");
  return f as PublicKeyFile;
}

/** The bytes that are signed. */
const payload = (c: { orgId: string; seq: number; hash: string; signedAt: number }): Buffer =>
  Buffer.from(
    canonicalJson({ v: 1, orgId: c.orgId, seq: c.seq, hash: c.hash, signedAt: c.signedAt }),
    "utf8",
  );

export function signCheckpoint(
  key: AuditKey,
  c: { orgId: string; seq: number; hash: string; signedAt: number },
): AuditCheckpoint {
  const signature = sign(null, payload(c), createPrivateKey(key.privateKeyPem)).toString(
    "base64url",
  );
  return { ...c, keyId: key.keyId, signature };
}

export function checkpointSignatureValid(publicKeyPem: string, c: AuditCheckpoint): boolean {
  try {
    return verify(
      null,
      payload(c),
      createPublicKey(publicKeyPem),
      Buffer.from(c.signature, "base64url"),
    );
  } catch {
    return false;
  }
}

/** Signs the current head of an org's chain unless it is already covered. Returns the checkpoint. */
export async function createCheckpoint(
  db: Db,
  store: SecretStore,
  orgId: string,
  now: () => number = Date.now,
): Promise<AuditCheckpoint | undefined> {
  // First use writes the key, which is itself audited; do that before reading the head so the
  // checkpoint covers it.
  const key = await ensureAuditKey(db, store, orgId);
  const head = await auditHead(db, orgId);
  if (!head || head.seq === null || head.hash === null) return undefined;
  const last = await latestCheckpoint(db, orgId);
  if (last && last.seq >= head.seq) return undefined;
  const cp = signCheckpoint(key, { orgId, seq: head.seq, hash: head.hash, signedAt: now() });
  await putCheckpoint(db, cp);
  return cp;
}

export interface CheckpointPolicy {
  everyEntries?: number;
  everyMs?: number;
}

/** One pass over every org: checkpoint those that are due. Returns how many were signed. */
export async function checkpointDue(
  db: Db,
  store: SecretStore,
  policy: CheckpointPolicy = {},
  now: () => number = Date.now,
): Promise<number> {
  const everyEntries = policy.everyEntries ?? CHECKPOINT_EVERY_ENTRIES;
  const everyMs = policy.everyMs ?? CHECKPOINT_EVERY_MS;
  let signed = 0;
  for (const orgId of await orgsWithAudit(db)) {
    const head = await auditHead(db, orgId);
    if (!head || head.seq === null) continue;
    const last = await latestCheckpoint(db, orgId);
    const behind = head.seq - (last?.seq ?? 0);
    if (behind <= 0) continue;
    const age = last ? now() - last.signedAt : Number.POSITIVE_INFINITY;
    if (behind >= everyEntries || age >= everyMs) {
      if (await createCheckpoint(db, store, orgId, now)) signed += 1;
    }
  }
  return signed;
}

/** Runs checkpointDue on an interval. Returns a stop function. */
export function startCheckpointer(
  db: Db,
  store: SecretStore,
  opts: CheckpointPolicy & { intervalMs?: number; log?: (m: string) => void } = {},
): () => void {
  const log = opts.log ?? ((m: string) => console.warn(m));
  const timer = setInterval(() => {
    void flushAggregates(db).catch(() => {});
    checkpointDue(db, store, opts).catch((e: unknown) =>
      log(`audit checkpoint failed: ${String(e)}`),
    );
  }, opts.intervalMs ?? 30_000);
  return () => clearInterval(timer);
}
