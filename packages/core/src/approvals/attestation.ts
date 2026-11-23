// WebAuthn "packed" attestation, server side, for the `hardware` approval key policy (#152). A
// packed statement with an x5c chain proves the credential was made by a device whose attestation
// certificate chains to a pinned vendor root. We check: the signature over authData and the client
// data hash with the leaf key, the leaf is not a CA, the AAGUID in the leaf (when present) is the
// one in authData, validity dates, and a chain to a pinned root. Self attestation (no x5c) proves
// nothing about the device, so it never counts as verified.
import { verify, X509Certificate } from "node:crypto";
import { type Cbor } from "./cbor";
import { basicConstraints, fidoAaguid, parseCertInfo } from "./x509-info";
import { VENDOR_INTERMEDIATES, VENDOR_ROOTS } from "./vendor-roots";

export class AttestationError extends Error {}

export type TrustAnchors = { roots: X509Certificate[]; intermediates: X509Certificate[] };

let bundled: TrustAnchors | undefined;
/** The pinned vendor roots and intermediates. */
export function bundledTrustAnchors(): TrustAnchors {
  bundled ??= {
    roots: VENDOR_ROOTS.map((r) => new X509Certificate(r.pem)),
    intermediates: VENDOR_INTERMEDIATES.map((r) => new X509Certificate(r.pem)),
  };
  return bundled;
}

export type AttestationResult = {
  fmt: "none" | "packed";
  /** Lower-case hyphenated UUID from authenticator data; null for `none`. */
  aaguid: string | null;
  /** True only when a pinned vendor chain signed the statement. */
  verified: boolean;
};

export const formatAaguid = (b: Uint8Array): string => {
  const h = Buffer.from(b).toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

const within = (c: X509Certificate, now: number): boolean =>
  Date.parse(c.validFrom) <= now && now <= Date.parse(c.validTo);

const issuedBy = (c: X509Certificate, issuer: X509Certificate): boolean => {
  try {
    return c.checkIssued(issuer) && c.verify(issuer.publicKey);
  } catch {
    return false;
  }
};

const caInfo = (c: X509Certificate): { ca: boolean; pathLen?: number } | null => {
  try {
    return basicConstraints(parseCertInfo(c.raw));
  } catch {
    return null;
  }
};

/**
 * Builds leaf -> ... -> root through `pool`. Every issuer must be a CA by its own basicConstraints
 * (read from the extension, not guessed) and must allow the number of CAs below it (pathLen).
 */
function chainsToRoot(
  leaf: X509Certificate,
  pool: X509Certificate[],
  anchors: TrustAnchors,
  now: number,
): boolean {
  let cur = leaf;
  // CAs already passed between the leaf and the issuer being considered.
  let below = 0;
  const allows = (c: X509Certificate): boolean => {
    const bc = caInfo(c);
    return !!bc && bc.ca && (bc.pathLen === undefined || below <= bc.pathLen);
  };
  for (let depth = 0; depth < 5; depth++) {
    if (!within(cur, now)) return false;
    const root = anchors.roots.find((r) => within(r, now) && allows(r) && issuedBy(cur, r));
    if (root) return true;
    const next = [...pool, ...anchors.intermediates].find(
      (p) => p !== cur && allows(p) && issuedBy(cur, p),
    );
    if (!next) return false;
    cur = next;
    below++;
  }
  return false;
}

/**
 * Verifies a registration's attestation statement. `fmt` none returns unverified. Throws when a
 * packed statement is malformed or its signature is wrong; returns verified=false when it is
 * well formed but does not chain to a pinned root (or is self attestation).
 */
export function verifyAttestation(
  att: Map<Cbor, Cbor>,
  authData: Uint8Array,
  clientDataHash: Buffer,
  o: { anchors?: TrustAnchors; now?: number } = {},
): AttestationResult {
  const fmt = att.get("fmt");
  if (fmt === "none") return { fmt: "none", aaguid: null, verified: false };
  if (fmt !== "packed")
    throw new AttestationError(`attestation format ${String(fmt)} is not supported`);
  const stmt = att.get("attStmt");
  if (!(stmt instanceof Map)) throw new AttestationError("bad attestation statement");
  if (stmt.has("ecdaaKeyId")) throw new AttestationError("ECDAA attestation is not supported");
  const sig = stmt.get("sig");
  const alg = stmt.get("alg");
  if (!(sig instanceof Uint8Array)) throw new AttestationError("attestation has no signature");
  const aaguid = formatAaguid(authData.subarray(37, 53));
  const x5c = stmt.get("x5c");
  if (x5c === undefined) {
    // Self attestation: signed by the credential key itself, which says nothing about the device.
    return { fmt: "packed", aaguid, verified: false };
  }
  if (
    !Array.isArray(x5c) ||
    x5c.length === 0 ||
    x5c.length > 5 ||
    !x5c.every((c) => c instanceof Uint8Array)
  )
    throw new AttestationError("bad attestation certificate chain");
  const certs = (x5c as Uint8Array[]).map((c) => {
    try {
      return new X509Certificate(Buffer.from(c));
    } catch {
      throw new AttestationError("attestation certificate is not valid DER");
    }
  });
  const leaf = certs[0]!;
  const signed = Buffer.concat([authData, clientDataHash]);
  let ok = false;
  try {
    ok =
      alg === -7
        ? verify("sha256", signed, leaf.publicKey, Buffer.from(sig))
        : alg === -8
          ? verify(null, signed, leaf.publicKey, Buffer.from(sig))
          : false;
  } catch {
    ok = false;
  }
  if (!ok) throw new AttestationError("attestation signature does not verify");
  // The packed-attestation requirements on the leaf (WebAuthn 8.2.1), read from its structure.
  let info;
  try {
    info = parseCertInfo(leaf.raw);
  } catch {
    throw new AttestationError("attestation certificate is malformed");
  }
  if (info.version !== 3)
    throw new AttestationError("the attestation certificate must be X.509 v3");
  const bc = basicConstraints(info);
  if (!bc || bc.ca) throw new AttestationError("the attestation certificate must not be a CA");
  if (!info.subjectOu.includes("Authenticator Attestation"))
    throw new AttestationError(
      'the attestation certificate subject must have OU="Authenticator Attestation"',
    );
  let certId: Buffer | null;
  try {
    certId = fidoAaguid(info);
  } catch (e) {
    throw new AttestationError(e instanceof Error ? e.message : "bad AAGUID extension");
  }
  if (certId !== null && !certId.equals(Buffer.from(authData.subarray(37, 53))))
    throw new AttestationError(
      "the attestation certificate's AAGUID does not match the credential",
    );
  // Without the AAGUID extension in the certificate, the AAGUID in authenticator data is only the
  // authenticator's own claim: it is not bound to the vendor chain, so nothing is verified.
  if (certId === null) return { fmt: "packed", aaguid, verified: false };
  const now = o.now ?? Date.now();
  const verified = chainsToRoot(leaf, certs.slice(1), o.anchors ?? bundledTrustAnchors(), now);
  return { fmt: "packed", aaguid, verified };
}
