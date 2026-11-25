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
const MAX_SIG = 4096;

/**
 * The manifest shape a pinned client checks (a pinned client's): `{ version, signing_key_id,
 * binaries: { "<platform-arch>": { filename, sha256 } } }`. A fixed shape, not a configurable one.
 */
export interface ManifestCheck {
  shape: "binaries-map";
}

/** Files of the manifest's artifact that are not binaries and need no signature of their own. */
const MANIFEST_COMPANIONS: readonly string[] = ["SHA256SUMS"];

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
  /** Optional manifest check: the signed file is a JSON manifest of signed binaries. */
  manifest?: ManifestCheck;
}

/** The id a client pins: first 16 hex characters of SHA-256 over the key's SPKI DER. */
export function cosignKeyId(key: KeyObject | string): string {
  const k = typeof key === "string" ? createPublicKey(key) : key;
  const der = k.export({ type: "spki", format: "der" });
  return createHash("sha256").update(der).digest("hex").slice(0, 16);
}

/** The full SHA-256 over the key's SPKI DER (hex): the fingerprint the audit trail records. */
export function cosignFingerprint(key: KeyObject | string): string {
  const k = typeof key === "string" ? createPublicKey(key) : key;
  return createHash("sha256")
    .update(k.export({ type: "spki", format: "der" }))
    .digest("hex");
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
    need(
      (o.manifest as Record<string, unknown>).shape === "binaries-map",
      'manifest.shape must be "binaries-map"',
    );
    key.manifest = { shape: "binaries-map" };
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

/** One carried co-signature: over the key's `signs` file, or (with `file`) over a manifest's binary. */
export interface CosignInput {
  name: string;
  file?: string;
  signature_b64: string;
}

export type CosignStatus = "verified" | "missing" | "invalid" | "unexpected";

export interface CosignReport {
  name: string;
  /** The binary this report is about, for a manifest's per-binary signature. */
  file?: string;
  status: CosignStatus;
  /** Public-key fingerprint (never key material). Absent for an unknown name. */
  key_id?: string;
  reason?: string;
}

export interface VerifiedCosign {
  /** The key name, plus `/<file>` for a binary's signature: unique per run. */
  name: string;
  keyId: string;
  /** The file in the release whose bytes were signed. */
  signs: string;
  /** The release asset name the signature is published under. */
  outputName: string;
  /** The signature bytes as published. */
  signature: Uint8Array;
  signatureSha256: string;
}

export type CosignOutcome =
  | { ok: true; reports: CosignReport[]; verified: VerifiedCosign[] }
  | { ok: false; reason: string; detail: string; reports: CosignReport[] };

/** What verification reads of the release: its files (unpacked from the artifacts) by path. */
export interface CosignFiles {
  /** The EXACT bytes of a file, as the lane re-hashed them for the approved manifest. */
  read(file: string): Promise<Uint8Array | undefined>;
  /** The artifact a file came from. */
  artifactOf(file: string): string | undefined;
  /** Every file of an artifact. */
  filesOf(artifact: string): string[];
}

const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const stripV = (v: string): string => v.replace(/^v/, "");

/**
 * Verifies the carried co-signatures against the configured keys. Every configured key needs
 * one over its `signs` file; a key with a manifest check needs one more over each binary the
 * manifest lists (and no other). An unknown name, a repeat or a stray one is refused. `digests` is
 * the lane's own digest map by file path; `tag` is the release tag the manifest's version must match.
 */
export async function verifyCosignatures(
  keys: readonly CosignKey[],
  carried: readonly CosignInput[],
  files: CosignFiles,
  digests: Readonly<Record<string, string>>,
  tag: string,
): Promise<CosignOutcome> {
  const reports: CosignReport[] = [];
  const verified: VerifiedCosign[] = [];
  const byName = new Map(keys.map((k) => [k.name, k]));
  const given = new Map<string, CosignInput>();
  const used = new Set<string>();
  let firstFail: { reason: string; detail: string } | undefined;
  const fail = (reason: string, detail: string): void => {
    firstFail ??= { reason, detail };
  };
  const refKey = (c: { name: string; file?: string | undefined }): string =>
    c.file === undefined ? c.name : `${c.name}/${c.file}`;
  for (const c of carried) {
    const bad = (reason: string, detail: string, status: CosignStatus): void => {
      reports.push({
        name: c.name,
        ...(c.file === undefined ? {} : { file: c.file }),
        status,
        reason,
      });
      fail(reason, detail);
    };
    const k = byName.get(c.name);
    if (!k) bad("cosign_unexpected", `${c.name} is not a configured co-signing key`, "unexpected");
    else if (c.file !== undefined && !k.manifest)
      bad("cosign_unexpected", `${c.name} signs one file, not a manifest's binaries`, "unexpected");
    else if (given.has(refKey(c)))
      bad("cosign_duplicate", `${refKey(c)} is given twice`, "invalid");
    else given.set(refKey(c), c);
  }
  const decode = (c: CosignInput): Uint8Array | undefined =>
    c.signature_b64.length > MAX_SIG || !B64.test(c.signature_b64)
      ? undefined
      : new Uint8Array(Buffer.from(c.signature_b64, "base64"));

  for (const k of keys) {
    const keyId = cosignKeyId(k.public_key_pem);
    const pub = createPublicKey(k.public_key_pem);
    const fmt = FORMATS[k.format]!;
    const bad = (reason: string, detail: string, file?: string): void => {
      reports.push({
        name: k.name,
        ...(file === undefined ? {} : { file }),
        status: "invalid",
        key_id: keyId,
        reason,
      });
      fail(reason, `${k.name}: ${detail}`);
    };
    /** Checks one signature over one file's exact bytes; returns the verified record or undefined. */
    const check = async (
      c: CosignInput | undefined,
      file: string,
      outputName: string,
      reportFile?: string,
    ): Promise<VerifiedCosign | undefined> => {
      if (!c) {
        reports.push({
          name: k.name,
          ...(reportFile === undefined ? {} : { file: reportFile }),
          status: "missing",
          key_id: keyId,
          reason: "cosign_missing",
        });
        fail("cosign_missing", `${k.name} must co-sign ${file}`);
        return undefined;
      }
      used.add(refKey(c));
      const sig = decode(c);
      if (!sig) {
        bad("cosign_bad_encoding", "signature_b64 is not base64", reportFile);
        return undefined;
      }
      const signed = await files.read(file);
      if (!signed || !(file in digests)) {
        bad("cosign_artifact_missing", `${file} is not a file of this release`, reportFile);
        return undefined;
      }
      // The bytes checked are the bytes whose digest the approved manifest binds.
      if (createHash("sha256").update(signed).digest("hex") !== digests[file]) {
        bad("cosign_artifact_differs", `${file} differs from the approved digest`, reportFile);
        return undefined;
      }
      const res = fmt.verify(pub, signed, sig);
      if (!res.ok) {
        bad(
          res.reason,
          `the signature over ${file} does not verify under the configured key`,
          reportFile,
        );
        return undefined;
      }
      reports.push({
        name: k.name,
        ...(reportFile === undefined ? {} : { file: reportFile }),
        status: "verified",
        key_id: keyId,
      });
      return {
        name: reportFile === undefined ? k.name : `${k.name}/${reportFile}`,
        keyId,
        signs: file,
        outputName,
        signature: sig,
        signatureSha256: createHash("sha256").update(sig).digest("hex"),
      };
    };

    const head = await check(given.get(k.name), k.signs, k.output_name);
    if (!head) continue;
    verified.push(head);
    if (!k.manifest) continue;

    // The manifest: the exact bytes just verified, read as the fixed shape.
    const parsed = parseManifest(await files.read(k.signs), keyId, tag);
    if (typeof parsed === "string") {
      bad("cosign_manifest_check", parsed);
      continue;
    }
    const listed = new Set<string>();
    const outputs = new Set<string>([k.output_name]);
    for (const [platform, e] of Object.entries(parsed.binaries)) {
      if (listed.has(e.filename)) {
        bad("cosign_manifest_check", `${platform}: ${e.filename} is listed twice`);
        continue;
      }
      listed.add(e.filename);
      if (!(e.filename in digests) || !(await files.read(e.filename))) {
        bad("cosign_manifest_check", `${platform}: ${e.filename} is not a file of this release`);
        continue;
      }
      if (e.sha256 !== digests[e.filename]) {
        bad(
          "cosign_manifest_check",
          `${platform}: the manifest's sha256 for ${e.filename} differs from the bytes the lane publishes`,
        );
        continue;
      }
      const out = `${e.filename}.sig`;
      if (!OUTPUT_NAME.test(out) || out in digests || outputs.has(out)) {
        bad("cosign_manifest_check", `${platform}: ${out} is not a usable signature asset name`);
        continue;
      }
      outputs.add(out);
      const v = await check(given.get(`${k.name}/${e.filename}`), e.filename, out, e.filename);
      if (v) verified.push(v);
    }
    // No unsigned binary beside the signed ones: every other file of the manifest's artifact
    // must be the manifest itself or a known companion.
    const art = files.artifactOf(k.signs);
    for (const f of art === undefined ? [] : files.filesOf(art)) {
      if (f === k.signs || listed.has(f) || MANIFEST_COMPANIONS.includes(f)) continue;
      bad("cosign_manifest_check", `${f} is in ${art} but not listed in the manifest (unsigned)`);
    }
  }
  // A signature that matched no file the lane checked.
  for (const [ref, c] of given) {
    if (used.has(ref) || !byName.has(c.name)) continue;
    reports.push({
      name: c.name,
      ...(c.file === undefined ? {} : { file: c.file }),
      status: "unexpected",
      reason: "cosign_unexpected",
    });
    fail("cosign_unexpected", `${ref} signs a file the manifest does not list`);
  }
  if (firstFail) return { ok: false, ...firstFail, reports };
  return { ok: true, reports, verified };
}

/** The fixed manifest shape; returns the problem as a string, or the parsed manifest. */
function parseManifest(
  bytes: Uint8Array | undefined,
  keyId: string,
  tag: string,
): { binaries: Record<string, { filename: string; sha256: string }> } | string {
  let doc: unknown;
  try {
    doc = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return "the signed file is not a JSON manifest";
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc))
    return "the manifest is not a JSON object";
  const o = doc as Record<string, unknown>;
  if (o.signing_key_id !== keyId)
    return `the manifest's signing_key_id is not the configured key's id ${keyId}`;
  if (typeof o.version !== "string" || stripV(o.version) !== stripV(tag))
    return `the manifest's version does not match the tag ${tag}`;
  const b = o.binaries;
  if (typeof b !== "object" || b === null || Array.isArray(b) || Object.keys(b).length === 0)
    return "the manifest's binaries is not a non-empty map";
  const out: Record<string, { filename: string; sha256: string }> = {};
  for (const [platform, e] of Object.entries(b)) {
    const x = e as { filename?: unknown; sha256?: unknown } | null;
    if (
      typeof x !== "object" ||
      x === null ||
      typeof x.filename !== "string" ||
      typeof x.sha256 !== "string"
    )
      return `${platform}: an entry needs a filename and a sha256`;
    if (!HEX64.test(x.sha256)) return `${platform}: sha256 must be 64 lowercase hex characters`;
    out[platform] = { filename: x.filename, sha256: x.sha256 };
  }
  return { binaries: out };
}
