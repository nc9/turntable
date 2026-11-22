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

/** The org's signing key from the secret store, generated on first use. */
export async function ensureAuditKey(store: SecretStore, orgId: string): Promise<AuditKey> {
  const existing = await store.get(orgId, AUDIT_KEY_SECRET);
  if (existing) return keyFromPrivatePem(existing);
  const { privateKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  await store.set(orgId, AUDIT_KEY_SECRET, pem);
  return keyFromPrivatePem(pem);
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
  const key = await ensureAuditKey(store, orgId);
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
    checkpointDue(db, store, opts).catch((e: unknown) =>
      log(`audit checkpoint failed: ${String(e)}`),
    );
  }, opts.intervalMs ?? 30_000);
  return () => clearInterval(timer);
}
