// Lane-verified co-signatures (#544). Some clients accept a release only if a file is signed by a
// key pinned in the client. The lane cannot hold that key, so the key's owner signs the exact
// bytes off-instance and the request carries the signature. The RELEASE LANE verifies it, under
// public keys from its own file, before anything is signed or published. The main process only
// carries opaque base64 strings and never reads this configuration (the source guard in
// release-lane.test.ts keeps it that way); no private key ever reaches the lane.
import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";

export class CosignConfigError extends Error {}

export const COSIGN_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const ARTIFACT_NAME = /^[A-Za-z0-9][A-Za-z0-9._/+-]{0,199}$/;
const OUTPUT_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,199}$/;
const FIELD = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const MAX_SIG = 4096;

/** What a pinned client checks about a signed JSON manifest listing the release's artifacts. */
export interface ManifestCheck {
  /** The manifest field holding the co-signing key's id. */
  key_id_field: string;
  /** The manifest field holding the list of `{ name, sha256 }` entries (default `artifacts`). */
  artifacts_field: string;
}

export interface CosignKey {
  name: string;
  /** Public material only. */
  public_key_pem: string;
  /** The artifact in the release whose exact bytes the key signed. */
  signs: string;
  /** The release asset name the signature is published under. */
  output_name: string;
  /** A format id from FORMATS. */
  format: string;
  /** Optional `manifest-lists-artifacts` check, for a signed JSON manifest. */
  manifest?: ManifestCheck;
}

/** The id a client pins: first 16 hex characters of SHA-256 over the key's SPKI DER. */
export function cosignKeyId(key: KeyObject | string): string {
  const k = typeof key === "string" ? createPublicKey(key) : key;
  const der = k.export({ type: "spki", format: "der" });
  return createHash("sha256").update(der).digest("hex").slice(0, 16);
}

// ---- formats: the plug point ----

export type FormatResult = { ok: true } | { ok: false; reason: string };

export interface CosignFormat {
  id: string;
  /** Checks a public key is usable for this format (throws CosignConfigError otherwise). */
  checkKey(key: KeyObject): void;
  /** Verifies `signature` (raw bytes as published) over the exact `bytes` of the signed file. */
  verify(key: KeyObject, bytes: Uint8Array, signature: Uint8Array): FormatResult;
}

/** Parses an ASN.1 DER INTEGER body into minimal unsigned magnitude, or undefined if not minimal. */
function minimalPositiveInt(body: Uint8Array): Uint8Array | undefined {
  if (body.length === 0) return undefined;
  const b0 = body[0]!;
  if (b0 & 0x80) return undefined; // negative
  if (b0 === 0 && (body.length === 1 || !(body[1]! & 0x80))) {
    // a lone zero is not a valid ECDSA component; a leading zero is only for a set high bit
    return undefined;
  }
  return body;
}

/**
 * Strict, minimal DER for `ECDSA-Sig-Value ::= SEQUENCE { r INTEGER, s INTEGER }`: definite
 * short-form lengths where they fit, positive minimal integers, no trailing bytes. Anything a
 * strict client would reject is rejected here.
 */
export function isMinimalEcdsaDer(sig: Uint8Array, componentMax = 32): boolean {
  if (sig.length < 8 || sig.length > 2 + 2 + 2 * (componentMax + 1) + 2) return false;
  let i = 0;
  if (sig[i++] !== 0x30) return false;
  const total = sig[i++]!;
  if (total & 0x80) return false; // long form is never needed for P-256
  if (total !== sig.length - 2) return false;
  for (let n = 0; n < 2; n++) {
    if (sig[i++] !== 0x02) return false;
    const len = sig[i++];
    if (len === undefined || len & 0x80 || len === 0 || i + len > sig.length) return false;
    const body = sig.subarray(i, i + len);
    const mag = minimalPositiveInt(body);
    if (!mag) return false;
    if (mag.length > componentMax + 1) return false;
    i += len;
  }
  return i === sig.length;
}

/** `detached-der-p256-sha256`: ECDSA P-256 over SHA-256 of the exact bytes, minimal DER. */
const detachedDerP256: CosignFormat = {
  id: "detached-der-p256-sha256",
  checkKey(key) {
    const d = key.asymmetricKeyDetails;
    if (key.type !== "public" || key.asymmetricKeyType !== "ec" || d?.namedCurve !== "prime256v1")
      throw new CosignConfigError("detached-der-p256-sha256 needs an ECDSA P-256 public key");
  },
  verify(key, bytes, signature) {
    if (!isMinimalEcdsaDer(signature)) return { ok: false, reason: "signature_not_minimal_der" };
    let ok = false;
    try {
      ok = verify("sha256", bytes, { key, dsaEncoding: "der" }, signature);
    } catch {
      ok = false;
    }
    return ok ? { ok: true } : { ok: false, reason: "signature_invalid" };
  },
};

export const FORMATS: Readonly<Record<string, CosignFormat>> = {
  [detachedDerP256.id]: detachedDerP256,
};

// ---- configuration ----

const need = (cond: boolean, why: string): void => {
  if (!cond) throw new CosignConfigError(why);
};

/** Checks one co-signing key declaration from the CLI or from the lane's file; throws on anything off. */
export function parseCosignKey(raw: unknown): CosignKey {
  need(typeof raw === "object" && raw !== null && !Array.isArray(raw), "a cosign key is an object");
  const o = raw as Record<string, unknown>;
  const key: CosignKey = {
    name: String(o.name ?? ""),
    public_key_pem: String(o.public_key_pem ?? "").trim(),
    signs: String(o.signs ?? ""),
    output_name: String(o.output_name ?? ""),
    format: String(o.format ?? ""),
  };
  need(
    COSIGN_NAME.test(key.name),
    "name must be a short lower-case name (letters, digits, dashes)",
  );
  need(
    ARTIFACT_NAME.test(key.signs) && !key.signs.split("/").includes(".."),
    "signs must be an artifact name in the release",
  );
  need(
    OUTPUT_NAME.test(key.output_name),
    "output_name must be a plain release asset name (no slash)",
  );
  const fmt = FORMATS[key.format];
  need(fmt !== undefined, `format must be one of: ${Object.keys(FORMATS).join(", ")}`);
  need(!key.public_key_pem.includes("PRIVATE"), "only a public key may be configured");
  let pub: KeyObject;
  try {
    pub = createPublicKey(key.public_key_pem);
  } catch {
    throw new CosignConfigError("public_key_pem is not a PEM public key");
  }
  fmt!.checkKey(pub);
  if (o.manifest !== undefined && o.manifest !== null) {
    need(typeof o.manifest === "object" && !Array.isArray(o.manifest), "manifest is an object");
    const m = o.manifest as Record<string, unknown>;
    const mc: ManifestCheck = {
      key_id_field: String(m.key_id_field ?? ""),
      artifacts_field: String(m.artifacts_field ?? "artifacts"),
    };
    need(FIELD.test(mc.key_id_field), "manifest.key_id_field must be a plain field name");
    need(FIELD.test(mc.artifacts_field), "manifest.artifacts_field must be a plain field name");
    key.manifest = mc;
  }
  return key;
}

/** Validates the whole set: names, signed artifacts and output names are each unique. */
export function checkCosignSet(keys: readonly CosignKey[]): void {
  const seen = (xs: string[], what: string): void =>
    need(new Set(xs).size === xs.length, `${what} must be unique across co-signing keys`);
  seen(
    keys.map((k) => k.name),
    "name",
  );
  seen(
    keys.map((k) => k.signs),
    "signs",
  );
  seen(
    keys.map((k) => k.output_name),
    "output_name",
  );
}

// ---- verification ----

export interface CosignInput {
  name: string;
  signature_b64: string;
}

export type CosignStatus = "verified" | "missing" | "invalid" | "unexpected";

export interface CosignReport {
  name: string;
  status: CosignStatus;
  /** Public-key fingerprint (never key material). Absent for an unknown name. */
  key_id?: string;
  reason?: string;
}

export interface VerifiedCosign {
  name: string;
  keyId: string;
  signs: string;
  outputName: string;
  /** The signature bytes as published. */
  signature: Uint8Array;
  signatureSha256: string;
}

export type CosignOutcome =
  | { ok: true; reports: CosignReport[]; verified: VerifiedCosign[] }
  | { ok: false; reason: string; detail: string; reports: CosignReport[] };

const B64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Verifies the carried co-signatures against the configured keys. Every configured key needs
 * one; an unknown name or a repeat is refused. `bytesOf` returns the EXACT bytes of an artifact
 * as the lane re-hashed them for the approved manifest; `digests` is the lane's own digest map.
 */
export async function verifyCosignatures(
  keys: readonly CosignKey[],
  carried: readonly CosignInput[],
  bytesOf: (artifact: string) => Promise<Uint8Array | undefined>,
  digests: Readonly<Record<string, string>>,
): Promise<CosignOutcome> {
  const reports: CosignReport[] = [];
  const verified: VerifiedCosign[] = [];
  const byName = new Map(keys.map((k) => [k.name, k]));
  const given = new Map<string, CosignInput>();
  let firstFail: { reason: string; detail: string } | undefined;
  const fail = (reason: string, detail: string): void => {
    firstFail ??= { reason, detail };
  };
  for (const c of carried) {
    if (!byName.has(c.name)) {
      reports.push({ name: c.name, status: "unexpected", reason: "cosign_unexpected" });
      fail("cosign_unexpected", `${c.name} is not a configured co-signing key`);
    } else if (given.has(c.name)) {
      reports.push({ name: c.name, status: "invalid", reason: "cosign_duplicate" });
      fail("cosign_duplicate", `${c.name} is given twice`);
    } else given.set(c.name, c);
  }
  for (const k of keys) {
    const keyId = cosignKeyId(k.public_key_pem);
    const c = given.get(k.name);
    const bad = (reason: string, detail: string): void => {
      reports.push({ name: k.name, status: "invalid", key_id: keyId, reason });
      fail(reason, `${k.name}: ${detail}`);
    };
    if (!c) {
      reports.push({ name: k.name, status: "missing", key_id: keyId, reason: "cosign_missing" });
      fail("cosign_missing", `${k.name} must co-sign ${k.signs}`);
      continue;
    }
    if (c.signature_b64.length > MAX_SIG || !B64.test(c.signature_b64)) {
      bad("cosign_bad_encoding", "signature_b64 is not base64");
      continue;
    }
    const sig = new Uint8Array(Buffer.from(c.signature_b64, "base64"));
    const signed = await bytesOf(k.signs);
    if (!signed || !(k.signs in digests)) {
      bad("cosign_artifact_missing", `${k.signs} is not an artifact of this release`);
      continue;
    }
    // The bytes checked are the bytes whose digest the approved manifest binds.
    if (createHash("sha256").update(signed).digest("hex") !== digests[k.signs]) {
      bad("cosign_artifact_differs", `${k.signs} differs from the approved digest`);
      continue;
    }
    const res = FORMATS[k.format]!.verify(createPublicKey(k.public_key_pem), signed, sig);
    if (!res.ok) {
      bad(res.reason, `the signature over ${k.signs} does not verify under the configured key`);
      continue;
    }
    if (k.manifest) {
      const why = await checkManifest(k, keyId, signed, bytesOf, digests);
      if (why) {
        bad("cosign_manifest_check", why);
        continue;
      }
    }
    reports.push({ name: k.name, status: "verified", key_id: keyId });
    verified.push({
      name: k.name,
      keyId,
      signs: k.signs,
      outputName: k.output_name,
      signature: sig,
      signatureSha256: createHash("sha256").update(sig).digest("hex"),
    });
  }
  if (firstFail) return { ok: false, ...firstFail, reports };
  return { ok: true, reports, verified };
}

/** `manifest-lists-artifacts`: the key id and every listed artifact digest must match. */
async function checkManifest(
  k: CosignKey,
  keyId: string,
  manifestBytes: Uint8Array,
  bytesOf: (artifact: string) => Promise<Uint8Array | undefined>,
  digests: Readonly<Record<string, string>>,
): Promise<string | undefined> {
  const m = k.manifest!;
  let doc: unknown;
  try {
    doc = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes));
  } catch {
    return `${k.signs} is not a JSON manifest`;
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc))
    return `${k.signs} is not a JSON object`;
  const o = doc as Record<string, unknown>;
  if (o[m.key_id_field] !== keyId)
    return `the manifest's ${m.key_id_field} is not the configured key's id ${keyId}`;
  const list = o[m.artifacts_field];
  if (!Array.isArray(list)) return `the manifest has no ${m.artifacts_field} list`;
  for (const e of list) {
    const x = e as { name?: unknown; sha256?: unknown };
    if (typeof x?.name !== "string" || typeof x.sha256 !== "string")
      return "a manifest entry lacks a name or sha256";
    if (!(x.name in digests) || !(await bytesOf(x.name)))
      return `the manifest lists ${x.name}, which is not an artifact of this release`;
    if (x.sha256.toLowerCase() !== digests[x.name]) {
      return `the manifest's sha256 for ${x.name} differs from the bytes the lane publishes`;
    }
  }
  return undefined;
}
