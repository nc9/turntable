// Re-derives a stretch of an org's chain before anything is signed over it.
import type { Db } from "../db";
import { chainedAudit, type AuditRow } from "../db/repos";
import { entryHash, GENESIS_HASH, type ChainFields } from "./chain";

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

export interface SegmentResult {
  ok: boolean;
  problem?: string;
  headSeq: number;
  headHash: string;
}

/**
 * Walks the chain from `from` (a trusted position, 0 for the start) to the head: the entry at
 * `from.seq` must still carry `from.hash`, every later entry must link to the one before it with
 * a hash that recomputes, and every position in `expect` must hold the hash given. Never writes.
 */
export async function verifySegment(
  db: Db,
  orgId: string,
  from: { seq: number; hash: string },
  expect: readonly { seq: number; hash: string }[] = [],
): Promise<SegmentResult> {
  const want = new Map(expect.map((e) => [e.seq, e.hash]));
  let prev = from.seq === 0 ? GENESIS_HASH : "";
  let next = from.seq === 0 ? 1 : from.seq;
  let headSeq = from.seq;
  let headHash = from.seq === 0 ? GENESIS_HASH : from.hash;
  const fail = (problem: string): SegmentResult => ({ ok: false, problem, headSeq, headHash });
  for (let after = from.seq === 0 ? 0 : from.seq - 1; ;) {
    const page = await chainedAudit(db, orgId, after, PAGE);
    if (page.length === 0) break;
    for (const r of page) {
      const seq = r.seq as number;
      if (seq !== next) return fail(`entry ${next} is missing (next is ${seq})`);
      if (seq === from.seq) {
        if (r.hash !== from.hash) return fail(`entry ${seq} no longer matches what was signed`);
      } else if (r.prevHash !== prev) {
        return fail(`entry ${seq} does not link to the entry before it`);
      }
      if (r.hash !== entryHash(r.prevHash as string, fieldsOf(r))) {
        return fail(`entry ${seq} was modified`);
      }
      const w = want.get(seq);
      if (w !== undefined && w !== r.hash)
        return fail(`entry ${seq} does not match its checkpoint`);
      want.delete(seq);
      prev = r.hash as string;
      headSeq = seq;
      headHash = prev;
      next = seq + 1;
      after = seq;
    }
  }
  if (from.seq > 0 && headSeq < from.seq) {
    return fail(`the chain ends at ${headSeq}, before the last signed entry ${from.seq}`);
  }
  if (want.size > 0)
    return fail(`checkpoint ${[...want.keys()][0]} covers an entry that is missing`);
  return { ok: true, headSeq, headHash };
}
