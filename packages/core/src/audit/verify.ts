import type { Db } from "../db";
import { chainedAudit, listCheckpoints, type AuditCheckpoint, type AuditRow } from "../db/repos";
import { entryHash, GENESIS_HASH, type ChainFields } from "./chain";
import { getAnchorCutover } from "./anchor-cutover";
import { CHECKPOINT_EVERY_MS, checkpointSignatureValid } from "./checkpoint";

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

export interface ChainWalk {
  problems: string[];
  /** Entry hash by position. */
  hashes: Map<number, string>;
  entries: number;
  headSeq: number;
}

/** Walks an org's chain: consecutive positions, links and recomputed hashes. */
export async function walkChain(db: Db, orgId: string): Promise<ChainWalk> {
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
  return { problems, hashes, entries, headSeq: expectedSeq - 1 };
}

/**
 * How one signed anchor stands against a chain: `ok`; `rolled_back` when it is validly signed but
 * covers a position past the chain's head; `bad_signature` when no key vouches for it; `mismatch`
 * when the entry at its position has another hash.
 */
export type AnchorStanding = "ok" | "rolled_back" | "bad_signature" | "mismatch";

/**
 * The public keys an anchor may be signed under: only the one named by its key id (a v2 export
 * body), and none when that key is not trusted for the org. A keyless v1 body names none, so every
 * trusted key may vouch for it; `anchorRefusal` limits that to anchors before the v2 cutover.
 */
export function anchorCandidates(
  an: AnchorCheckpoint,
  publicKeys: ReadonlyMap<string, string>,
): string[] {
  if (an.keyId === "") return [...publicKeys.values()];
  const key = publicKeys.get(an.keyId);
  return key === undefined ? [] : [key];
}

/** Why an anchor is refused before its signature is looked at. */
export type AnchorRefusal = "unknown_key" | "keyless_after_cutover";

/**
 * A v2 anchor whose key id is not a trusted key of the org is refused, and so is a keyless v1
 * anchor past the org's v2 cutover (`cutoverSeq`, undefined when it never exported a v2 body).
 */
export function anchorRefusal(
  an: AnchorCheckpoint,
  publicKeys: ReadonlyMap<string, string>,
  cutoverSeq: number | undefined,
): AnchorRefusal | undefined {
  if (an.keyId === "") {
    return cutoverSeq !== undefined && an.seq > cutoverSeq ? "keyless_after_cutover" : undefined;
  }
  return publicKeys.has(an.keyId) ? undefined : "unknown_key";
}

/**
 * The v2 cutover to hold anchors to: the recorded one and the lowest v2 anchor in the set,
 * whichever is earlier, so a verifier with no database row still refuses a keyless body that
 * follows a keyed one.
 */
export async function anchorCutoverSeq(
  db: Db,
  orgId: string,
  anchors: readonly AnchorCheckpoint[],
): Promise<number | undefined> {
  const seqs = anchors.filter((a) => a.orgId === orgId && a.keyId !== "").map((a) => a.seq);
  const recorded = (await getAnchorCutover(db, orgId))?.seq;
  if (recorded !== undefined) seqs.push(recorded);
  return seqs.length === 0 ? undefined : Math.min(...seqs);
}

export function anchorStanding(
  an: AnchorCheckpoint,
  hashes: ReadonlyMap<number, string>,
  headSeq: number,
  keys: readonly string[] | string | undefined,
): AnchorStanding {
  const list = typeof keys === "string" ? [keys] : (keys ?? []);
  const sigOk = list.some((k) => checkpointSignatureValid(k, an as AuditCheckpoint));
  if (!sigOk) return "bad_signature";
  const at = hashes.get(an.seq);
  if (at === undefined) return an.seq > headSeq ? "rolled_back" : "mismatch";
  return at === an.hash ? "ok" : "mismatch";
}

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
  const { problems, hashes, entries, headSeq } = await walkChain(db, orgId);

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
  // Without a public key pinned outside this database, nothing here is vouched for. The only
  // evidence about when a key came to exist, or who made it, is rows an attacker who can rewrite
  // the database can also write, so no row is ever allowed to settle it: with checkpoints
  // present and no pinned key, verification fails, whatever the chain says about its own key.
  if (!opts.keyPinned && cps.length > 0) {
    problems.push(
      "unanchored: the checkpoints are not vouched for without a public key pinned outside this database (--pubkey)",
    );
  }
  const anchors = (opts.anchors ?? []).filter((a) => a.orgId === orgId);
  const cutoverSeq = await anchorCutoverSeq(db, orgId, anchors);
  for (const an of anchors) {
    const refusal = anchorRefusal(an, publicKeys, cutoverSeq);
    if (refusal === "unknown_key") {
      problems.push(
        `anchor checkpoint ${an.seq} names key ${an.keyId}, which is not trusted for this org`,
      );
    } else if (refusal === "keyless_after_cutover") {
      problems.push(
        `anchor checkpoint ${an.seq} is a keyless v1 body after the v2 cutover (entry ${cutoverSeq})`,
      );
    }
    const standing =
      refusal === undefined
        ? anchorStanding(an, hashes, headSeq, anchorCandidates(an, publicKeys))
        : "bad_signature";
    if (standing === "bad_signature" && refusal === undefined)
      problems.push(`anchor checkpoint ${an.seq} has no valid signature under a trusted key`);
    // A bad signature does not hide a position problem: both are reported.
    const at = hashes.get(an.seq);
    if (at === undefined) {
      problems.push(
        `anchor checkpoint ${an.seq} covers an entry the chain no longer has: the chain ends at ${headSeq}, behind the exported anchor (rolled back or truncated)`,
      );
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

export type AnchorVerdict = "ok" | "rolled_back" | "mismatch";

/**
 * Checks an org's chain against exported anchors, with no pinned key file: the chain must be
 * intact, every anchor must carry a valid signature under the key it names in `publicKeys` (any of
 * them for a keyless v1 anchor, which is refused past the org's v2 cutover), and each must match the
 * entry at its position. A valid anchor past the head is a rollback; anything else wrong is a
 * mismatch, which wins over a rollback.
 */
export async function verifyAnchors(
  db: Db,
  orgId: string,
  publicKeys: ReadonlyMap<string, string>,
  anchors: readonly AnchorCheckpoint[],
): Promise<AnchorVerdict> {
  const walk = await walkChain(db, orgId);
  if (walk.problems.length > 0) return "mismatch";
  const mine = anchors.filter((a) => a.orgId === orgId);
  const cutoverSeq = await anchorCutoverSeq(db, orgId, mine);
  let rolledBack = false;
  for (const an of anchors) {
    if (anchorRefusal(an, publicKeys, cutoverSeq) !== undefined) return "mismatch";
    const st = anchorStanding(an, walk.hashes, walk.headSeq, anchorCandidates(an, publicKeys));
    if (st === "rolled_back") rolledBack = true;
    else if (st !== "ok") return "mismatch";
  }
  return rolledBack ? "rolled_back" : "ok";
}
