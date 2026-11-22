import type { Db } from "../db";
import { chainedAudit, listCheckpoints, type AuditRow } from "../db/repos";
import { entryHash, GENESIS_HASH, type ChainFields } from "./chain";
import { checkpointSignatureValid } from "./checkpoint";

export interface VerifyReport {
  orgId: string;
  ok: boolean;
  entries: number;
  checkpoints: number;
  headSeq: number;
  lastCheckpointSeq: number;
  /** Entries after the last checkpoint: intact, but not yet pinned by a signature. */
  unsignedTail: number;
  problems: string[];
}

const PAGE = 500;

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
): Promise<VerifyReport> {
  const problems: string[] = [];
  const hashes = new Map<number, string>();
  let prev = GENESIS_HASH;
  let expectedSeq = 1;
  let entries = 0;
  let broken = false;
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
    problems,
  };
}
