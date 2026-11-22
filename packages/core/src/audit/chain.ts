// The audit chain (issue #48). Each org has its own append-only chain: every entry carries a
// sequence number, the hash of the entry before it, and its own hash over canonical JSON, so any
// edit, deletion or reordering of stored rows changes a hash somewhere. Signed checkpoints (see
// checkpoint.ts) pin the chain's head with a key the database does not hold.
import { createHash } from "node:crypto";

/** The `prev_hash` of the first entry of every org's chain. */
export const GENESIS_HASH = "0".repeat(64);

/** JSON with sorted keys and no whitespace: the same value always serialises the same way. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(",")}}`;
}

/** The fields of an entry that its hash covers. */
export interface ChainFields {
  id: string;
  orgId: string;
  projectId: string | null;
  seq: number;
  principalKind: string;
  principalId: string;
  op: string;
  effect: string;
  outcome: string;
  /** The stored (already truncated) input text. */
  input: string;
  createdAt: number;
}

export function entryHash(prevHash: string, f: ChainFields): string {
  return createHash("sha256")
    .update(`${prevHash}\n${canonicalJson({ v: 1, ...f })}`)
    .digest("hex");
}
