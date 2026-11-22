// The per-org approval key policy (#152). `any` (the default) accepts any WebAuthn key with user
// verification and offline ed25519 keys. `hardware` accepts only WebAuthn keys whose attestation
// chained to a pinned vendor root at enrolment and whose AAGUID is on the org's allowlist. A key
// that does not satisfy the policy is not deleted: it just stops counting.
import { createHash } from "node:crypto";
import { AAGUID_PRESETS } from "./vendor-roots";

export type KeyPolicyMode = "any" | "hardware";

export type KeyPolicy = {
  /** Monotonic change counter, stored with the policy (0 when never set). */
  generation?: number;
  mode: KeyPolicyMode;
  presets: string[];
  aaguids: string[];
};

export const DEFAULT_KEY_POLICY: KeyPolicy = { mode: "any", presets: [], aaguids: [] };

export const PRESET_NAMES: readonly string[] = Object.keys(AAGUID_PRESETS);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const normalizeAaguid = (a: string): string | null => {
  const v = a.trim().toLowerCase();
  return UUID.test(v) ? v : null;
};

/** The effective AAGUID allowlist: presets expanded, plus custom entries. */
export function allowedAaguids(p: KeyPolicy): Set<string> {
  const out = new Set(p.aaguids);
  for (const name of p.presets) for (const a of AAGUID_PRESETS[name] ?? []) out.add(a);
  return out;
}

export type KeyFacts = {
  kind: string;
  attested?: boolean | null | undefined;
  aaguid?: string | null | undefined;
};

/** Why a key does not satisfy the policy, or null when it does. */
export function keyPolicyViolation(p: KeyPolicy, k: KeyFacts): string | null {
  if (p.mode === "any") return null;
  if (k.kind !== "webauthn") return "an offline key cannot satisfy the hardware policy";
  if (!k.attested) return "the key has no verified hardware attestation";
  if (!k.aaguid || !allowedAaguids(p).has(k.aaguid))
    return "the key's AAGUID is not on the allowlist";
  return null;
}

export class KeyPolicyError extends Error {
  readonly code: "invalid_input" | "conflict";
  constructor(code: "invalid_input" | "conflict", message: string) {
    super(message);
    this.code = code;
  }
}

/** Validates and normalises a requested policy. */
export function parseKeyPolicy(input: {
  mode: KeyPolicyMode;
  presets?: string[] | undefined;
  aaguids?: string[] | undefined;
}): KeyPolicy {
  const presets = [...new Set(input.presets ?? [])];
  const bad = presets.find((p) => !PRESET_NAMES.includes(p));
  if (bad)
    throw new KeyPolicyError(
      "invalid_input",
      `unknown preset ${bad} (known: ${PRESET_NAMES.join(", ")})`,
    );
  const aaguids: string[] = [];
  for (const a of input.aaguids ?? []) {
    const n = normalizeAaguid(a);
    if (!n) throw new KeyPolicyError("invalid_input", `${a} is not an AAGUID (a UUID)`);
    if (!aaguids.includes(n)) aaguids.push(n);
  }
  if (input.mode === "hardware" && presets.length === 0 && aaguids.length === 0)
    throw new KeyPolicyError("invalid_input", "hardware needs a preset or at least one AAGUID");
  return { mode: input.mode, presets, aaguids };
}

export const sortedPolicy = (p: KeyPolicy): KeyPolicy => ({
  mode: p.mode,
  presets: [...new Set(p.presets)].toSorted(),
  aaguids: [...new Set(p.aaguids)].toSorted(),
});

/** sha256 hex over the effective allowlist the policy expands to. */
export const allowlistHash = (p: KeyPolicy): string =>
  createHash("sha256")
    .update([...allowedAaguids(p)].toSorted().join("\n"), "utf8")
    .digest("hex");

export const samePolicy = (a: KeyPolicy, b: KeyPolicy): boolean =>
  JSON.stringify(sortedPolicy(a)) === JSON.stringify(sortedPolicy(b));
