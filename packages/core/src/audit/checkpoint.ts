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
  listCheckpoints,
  orgsWithAudit,
  orgsWithSecretName,
  putCheckpoint,
  type AuditCheckpoint,
} from "../db/repos";
import type { SecretStore } from "../secrets/store";
import { AuditAnchor, type AnchorState } from "./anchor";
import { canonicalJson, GENESIS_HASH } from "./chain";
import { verifySegment } from "./segment";
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

/** The signing key, the sealed anchor state or the chain failed a check; nothing was signed. */
export class AuditRefusal extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.reason = reason;
  }
}

/** Records the refusal in the org's own chain (throttled) so it is seen, then throws it. */
async function refuse(
  db: Db,
  orgId: string,
  reason: string,
  message: string,
  opts: { inSystemChain?: boolean } = {},
): Promise<never> {
  await auditFailure(db, {
    // A truncated chain is not a place to write an alert: it would extend what was cut. The
    // alert goes in the system chain, naming the org.
    orgId: opts.inSystemChain ? undefined : orgId,
    principalKind: "system",
    principalId: "audit",
    source: orgId,
    kind: `checkpoint_refused:${reason}`,
    op: "audit_checkpoint",
    outcome: `error:${reason}`,
    detail: { message, ...(opts.inSystemChain ? { org_id: orgId } : {}) },
  });
  throw new AuditRefusal(reason, message);
}

/** Why an org cannot be set up: it already has a key, a state file or checkpoints. */
export class AuditAlreadyInitialised extends Error {
  constructor(orgId: string, why: string) {
    super(`audit signing for org ${orgId} is already set up (${why})`);
  }
}

/**
 * The explicit, operator-run step that creates an org's signing key. It also writes the sealed
 * anchor state (the "a key existed" marker and the last signed position). The checkpointer never
 * does this: a key that goes missing is an alert, never a reason to make a new one.
 */
export async function initAuditKey(
  db: Db,
  store: SecretStore,
  anchor: AuditAnchor,
  orgId: string,
): Promise<AuditKey> {
  if (await loadAuditKey(store, orgId)) throw new AuditAlreadyInitialised(orgId, "a key exists");
  if (anchor.read(orgId)) throw new AuditAlreadyInitialised(orgId, "a state file exists");
  if (await latestCheckpoint(db, orgId)) {
    throw new AuditAlreadyInitialised(orgId, "checkpoints exist");
  }
  const { privateKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const key = keyFromPrivatePem(pem);
  // State first: if the process dies between the two, the marker says a key existed and the
  // missing key is refused loudly, rather than a key existing with no marker.
  anchor.write(orgId, { keyId: key.keyId, lastSeq: 0, lastHash: GENESIS_HASH });
  await store.set(orgId, AUDIT_KEY_SECRET, pem);
  return key;
}

/**
 * For an org that signed checkpoints before the anchor existed: writes the anchor state from
 * what the database holds now, after the whole chain and its checkpoints verify under the
 * key in the store. This trusts the database as it is today, once, on the operator's say-so;
 * pin the public key and keep the export off the server for anything stronger.
 */
export async function adoptAuditKey(
  db: Db,
  store: SecretStore,
  anchor: AuditAnchor,
  orgId: string,
): Promise<AnchorState> {
  const key = await loadAuditKey(store, orgId);
  if (!key) throw new AuditKeyMissing(orgId);
  if (anchor.read(orgId)) throw new AuditAlreadyInitialised(orgId, "a state file exists");
  const cps = await listCheckpoints(db, orgId);
  for (const c of cps) {
    if (c.keyId !== key.keyId || !checkpointSignatureValid(key.publicKeyPem, c)) {
      throw new AuditRefusal(
        "checkpoint_invalid",
        `checkpoint ${c.seq} does not verify under the store's key`,
      );
    }
  }
  const last = cps.at(-1);
  // The whole chain from the start, and every checkpoint against it.
  const seg = await verifySegment(
    db,
    orgId,
    { seq: 0, hash: GENESIS_HASH },
    cps.map((c) => ({ seq: c.seq, hash: c.hash })),
  );
  if (!seg.ok) throw new AuditRefusal("chain_invalid", seg.problem ?? "the chain does not verify");
  anchor.write(orgId, {
    keyId: key.keyId,
    lastSeq: last?.seq ?? 0,
    lastHash: last?.hash ?? GENESIS_HASH,
  });
  return anchor.read(orgId) as AnchorState;
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

/**
 * Signs the current head of an org's chain, unless it is already covered. Refuses (with an alert
 * in the org's chain) unless every one of these holds:
 *  - the sealed anchor state exists and opens (an org that was never set up is skipped, quietly),
 *  - the signing key exists in the store and is the one the state names,
 *  - the checkpoints table did not go backwards (it holds at least what was last signed),
 *  - the stored latest checkpoint carries a valid signature and still matches the chain,
 *  - the chain from the last signed (seq, hash) to the head re-derives: links and hashes.
 * Only then is the head signed; the checkpoint is stored, then the anchor state advances.
 */
export async function createCheckpoint(
  db: Db,
  store: SecretStore,
  anchor: AuditAnchor,
  orgId: string,
  now: () => number = Date.now,
): Promise<AuditCheckpoint | undefined> {
  let state: AnchorState | undefined;
  try {
    state = anchor.read(orgId);
  } catch (e) {
    return await refuse(db, orgId, "state_corrupt", (e as Error).message);
  }
  const key = await loadAuditKey(store, orgId);
  if (!state) {
    if (key) {
      return await refuse(
        db,
        orgId,
        "state_missing",
        "a signing key exists but its sealed state file is gone; if the chain is known good, run `longshore audit adopt --org <slug>`",
      );
    }
    return undefined; // never set up: nothing to refuse, nothing to sign
  }
  if (!key) {
    return await refuse(db, orgId, "key_missing", new AuditKeyMissing(orgId).message);
  }
  if (key.keyId !== state.keyId) {
    return await refuse(
      db,
      orgId,
      "key_replaced",
      "the signing key is not the one this org was set up with",
    );
  }
  const head = await auditHead(db, orgId);
  // The sealed state says what was signed. A chain that is gone, or that ends before it, was
  // truncated: say so, and do not carry on as if there were nothing to sign.
  if (state.lastSeq > 0 && (!head || head.seq === null || head.seq < state.lastSeq)) {
    return await refuse(
      db,
      orgId,
      "chain_invalid",
      `the chain ${head?.seq ? `ends at ${head.seq}` : "is empty"}, before the last signed entry ${state.lastSeq}: it was truncated`,
      { inSystemChain: true },
    );
  }
  if (!head || head.seq === null || head.hash === null) return undefined;
  const last = await latestCheckpoint(db, orgId);
  if ((last?.seq ?? 0) < state.lastSeq) {
    return await refuse(
      db,
      orgId,
      "checkpoints_backwards",
      `the checkpoints table ends at ${last?.seq ?? 0}, before the last signed entry ${state.lastSeq}`,
    );
  }
  const expect: { seq: number; hash: string }[] = [];
  if (last) {
    if (last.keyId !== key.keyId || !checkpointSignatureValid(key.publicKeyPem, last)) {
      return await refuse(
        db,
        orgId,
        "checkpoint_invalid",
        `checkpoint ${last.seq} has no valid signature`,
      );
    }
    if (last.seq === state.lastSeq && last.hash !== state.lastHash) {
      return await refuse(
        db,
        orgId,
        "checkpoint_mismatch",
        `checkpoint ${last.seq} differs from what was signed`,
      );
    }
    expect.push({ seq: last.seq, hash: last.hash });
  }
  const seg = await verifySegment(db, orgId, { seq: state.lastSeq, hash: state.lastHash }, expect);
  if (!seg.ok) {
    return await refuse(db, orgId, "chain_invalid", seg.problem ?? "the chain does not verify");
  }
  if (head.seq <= Math.max(last?.seq ?? 0, state.lastSeq)) {
    // Covered. A checkpoint ahead of the state (a crash between the two writes) is caught up.
    if (last && last.seq > state.lastSeq) {
      anchor.write(orgId, { keyId: key.keyId, lastSeq: last.seq, lastHash: last.hash }, now());
    }
    return undefined;
  }
  const cp = signCheckpoint(key, { orgId, seq: head.seq, hash: head.hash, signedAt: now() });
  await putCheckpoint(db, cp);
  anchor.write(orgId, { keyId: key.keyId, lastSeq: cp.seq, lastHash: cp.hash }, now());
  return cp;
}

export interface CheckpointPolicy {
  everyEntries?: number;
  everyMs?: number;
}

/**
 * Every org the checkpointer must look at: those with audit rows, those with a sealed state file
 * and those holding a signing key. An org whose rows were all deleted still has the last two.
 */
export async function auditedOrgIds(db: Db, anchor: AuditAnchor): Promise<string[]> {
  const ids = new Set(await orgsWithAudit(db));
  for (const id of anchor.orgIds()) ids.add(id);
  for (const id of await orgsWithSecretName(db, AUDIT_KEY_SECRET)) ids.add(id);
  return [...ids];
}

/** One pass over every org: checkpoint those that are due. Returns how many were signed. */
export async function checkpointDue(
  db: Db,
  store: SecretStore,
  anchor: AuditAnchor,
  policy: CheckpointPolicy = {},
  now: () => number = Date.now,
): Promise<number> {
  const everyEntries = policy.everyEntries ?? CHECKPOINT_EVERY_ENTRIES;
  const everyMs = policy.everyMs ?? CHECKPOINT_EVERY_MS;
  let signed = 0;
  for (const orgId of await auditedOrgIds(db, anchor)) {
    const head = await auditHead(db, orgId);
    let state: AnchorState | undefined;
    try {
      state = anchor.read(orgId);
    } catch {
      state = undefined; // createCheckpoint refuses a corrupt state, with an alert
    }
    const truncated =
      state !== undefined &&
      state.lastSeq > 0 &&
      (!head || head.seq === null || head.seq < state.lastSeq);
    const last = await latestCheckpoint(db, orgId);
    const behind = (head?.seq ?? 0) - (last?.seq ?? 0);
    const age = last ? now() - last.signedAt : Number.POSITIVE_INFINITY;
    // A truncation or an unreadable state is checked every pass, never waited out.
    const due = truncated || (behind > 0 && (behind >= everyEntries || age >= everyMs));
    if (!due) continue;
    try {
      if (await createCheckpoint(db, store, anchor, orgId, now)) signed += 1;
    } catch (e) {
      // One org's refusal (already alerted) must not stop the others.
      if (!(e instanceof AuditRefusal)) throw e;
    }
  }
  return signed;
}

/** Runs checkpointDue on an interval. Returns a stop function. */
export function startCheckpointer(
  db: Db,
  store: SecretStore,
  anchor: AuditAnchor,
  opts: CheckpointPolicy & { intervalMs?: number; log?: (m: string) => void } = {},
): () => void {
  const log = opts.log ?? ((m: string) => console.warn(m));
  const timer = setInterval(() => {
    void flushAggregates(db).catch(() => {});
    checkpointDue(db, store, anchor, opts).catch((e: unknown) =>
      log(`audit checkpoint failed: ${String(e)}`),
    );
  }, opts.intervalMs ?? 30_000);
  return () => clearInterval(timer);
}
