import type { Db } from "../db";
import { chainedAudit, listCheckpoints, type AuditCheckpoint, type AuditRow } from "../db/repos";
import { entryHash, GENESIS_HASH, type ChainFields } from "./chain";
import { AUDIT_KEY_SECRET, CHECKPOINT_EVERY_MS, checkpointSignatureValid } from "./checkpoint";

export interface VerifyReport {
  orgId: string;
  ok: boolean;
  entries: number;
  checkpoints: number;
  headSeq: number;
  lastCheckpointSeq: number;
  /** Entries after the last checkpoint: intact, but not yet pinned by a signature. */
  unsignedTail: number;
  /** Checkpoints were checked against a public key the operator pinned outside the database. */
  keyPinned: boolean;
  /** Checkpoints were compared with an external copy (the export sink). */
  anchored: boolean;
  problems: string[];
}

export interface VerifyOptions {
  /** The keys came from the operator's own file, not from the store the server writes. */
  keyPinned?: boolean;
  /** Checkpoints taken from the export sink or a saved file: the source of truth. */
  anchors?: readonly AnchorCheckpoint[];
  now?: number;
  /** Entries this old with no checkpoint after them are a failure. Default: twice the interval. */
  maxUnsignedAgeMs?: number;
}

export interface AnchorCheckpoint {
  orgId: string;
  seq: number;
  hash: string;
  signedAt: number;
  keyId: string;
  signature: string;
}

const PAGE = 500;

/** The audit row the secret store writes when the signing key is set (by name only). */
const isKeyCreation = (input: string): boolean => {
  try {
    return (JSON.parse(input) as { name?: unknown }).name === AUDIT_KEY_SECRET;
  } catch {
    return false;
  }
};

const fieldsOf = (r: AuditRow): ChainFields => ({
  id: r.id,
  orgId: r.orgId,
  projectId: r.projectId,
  seq: r.seq as number,
  principalKind: r.principalKind,
  principalId: r.principalId,
  op: r.op,
  effect: r.effect,
  outcome: r.outcome,
  input: r.input,
  createdAt: r.createdAt,
});

/**
 * Walks an org's chain and checks it end to end:
 *  - positions are consecutive from 1 (no row removed or inserted),
 *  - every entry links to the one before and its hash recomputes,
 *  - every checkpoint matches the entry at its position and carries a valid signature,
 *  - nothing a checkpoint covers is missing (truncation).
 * `publicKeys` maps a key id to its public key PEM. Checkpoints signed by an unknown key fail.
 */
export async function verifyAudit(
  db: Db,
  orgId: string,
  publicKeys: ReadonlyMap<string, string>,
  opts: VerifyOptions = {},
): Promise<VerifyReport> {
  const problems: string[] = [];
  const hashes = new Map<number, string>();
  let prev = GENESIS_HASH;
  let expectedSeq = 1;
  let entries = 0;
  let broken = false;
  let keyCreatedAt: number | undefined;
  for (let after = 0; ;) {
    const page = await chainedAudit(db, orgId, after, PAGE);
    if (page.length === 0) break;
    for (const r of page) {
      entries += 1;
      const seq = r.seq as number;
      if (!broken) {
        if (seq !== expectedSeq) {
          problems.push(
            `entry ${expectedSeq} is missing (next is ${seq}): a row was removed or inserted`,
          );
          broken = true;
        } else if (r.prevHash !== prev) {
          problems.push(`entry ${seq} does not link to the entry before it`);
          broken = true;
        } else if (r.hash !== entryHash(r.prevHash as string, fieldsOf(r))) {
          problems.push(`entry ${seq} was modified (its hash does not match its contents)`);
          broken = true;
        }
      }
      if (keyCreatedAt === undefined && r.op === "secret_set" && isKeyCreation(r.input)) {
        keyCreatedAt = seq;
      }
      hashes.set(seq, r.hash as string);
      prev = r.hash as string;
      expectedSeq = seq + 1;
      after = seq;
    }
  }
  const headSeq = expectedSeq - 1;

  const cps = await listCheckpoints(db, orgId);
  for (const cp of cps) {
    const at = hashes.get(cp.seq);
    if (at === undefined) {
      problems.push(
        `checkpoint ${cp.seq} covers an entry that is missing (the chain was truncated)`,
      );
      continue;
    }
    if (at !== cp.hash)
      problems.push(`checkpoint ${cp.seq} does not match the entry at that position`);
    const key = publicKeys.get(cp.keyId);
    if (!key) problems.push(`checkpoint ${cp.seq} is signed by unknown key ${cp.keyId}`);
    else if (!checkpointSignatureValid(key, cp))
      problems.push(`checkpoint ${cp.seq} has an invalid signature`);
  }
  const lastCheckpointSeq = cps.at(-1)?.seq ?? 0;
  // A signing key that came into being after the chain began cannot vouch for what came before
  // it: whoever made it could have rewritten that stretch first. Only a public key pinned
  // outside this database settles that, so without one this is a failure, not a note.
  if (!opts.keyPinned && cps.length > 0) {
    if (keyCreatedAt === undefined) {
      problems.push(
        "the chain has checkpoints but no record of the signing key being created; pin the public key (--pubkey)",
      );
    } else if (keyCreatedAt > 1) {
      problems.push(
        `the signing key was created at entry ${keyCreatedAt}, after entries 1 to ${keyCreatedAt - 1}; ` +
          "without a pinned public key (--pubkey) those entries are not vouched for",
      );
    }
  }
  const anchors = (opts.anchors ?? []).filter((a) => a.orgId === orgId);
  for (const an of anchors) {
    const key = publicKeys.get(an.keyId);
    const sigOk =
      key !== undefined &&
      checkpointSignatureValid(key, { ...an, signature: an.signature } as AuditCheckpoint);
    if (!sigOk)
      problems.push(`anchor checkpoint ${an.seq} has no valid signature under a trusted key`);
    const at = hashes.get(an.seq);
    if (at === undefined) {
      problems.push(`anchor checkpoint ${an.seq} covers an entry the chain no longer has`);
    } else if (at !== an.hash) {
      problems.push(`anchor checkpoint ${an.seq} does not match the entry at that position`);
    }
    if (!cps.some((c) => c.seq === an.seq && c.hash === an.hash)) {
      problems.push(`checkpoint ${an.seq} from the anchor is missing from the database`);
    }
  }
  const anchorSeqs = new Set(anchors.map((a) => a.seq));
  if (anchorSeqs.size > cps.length) {
    problems.push(
      `the database has ${cps.length} checkpoints but the anchor shows ${anchorSeqs.size}`,
    );
  }
  // Checkpoints are due every few minutes. Old entries with nothing signed after them mean the
  // checkpoints were deleted or signing stopped.
  const maxAge = opts.maxUnsignedAgeMs ?? 2 * CHECKPOINT_EVERY_MS;
  if (headSeq > lastCheckpointSeq) {
    const [oldest] = await chainedAudit(db, orgId, lastCheckpointSeq, 1);
    const age = (opts.now ?? Date.now()) - (oldest?.createdAt ?? Number.POSITIVE_INFINITY);
    if (oldest && age > maxAge) {
      problems.push(
        `entry ${oldest.seq} is ${Math.round(age / 60_000)} minutes old and no checkpoint covers it` +
          (lastCheckpointSeq === 0 ? " (the org has no checkpoints)" : ""),
      );
    }
  }
  if (lastCheckpointSeq > headSeq) {
    problems.push(`the chain ends at ${headSeq} but a checkpoint covers ${lastCheckpointSeq}`);
  }
  return {
    orgId,
    ok: problems.length === 0,
    entries,
    checkpoints: cps.length,
    headSeq,
    lastCheckpointSeq,
    unsignedTail: Math.max(0, headSeq - lastCheckpointSeq),
    keyPinned: opts.keyPinned === true,
    anchored: anchors.length > 0,
    problems,
  };
}
