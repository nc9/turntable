// Verifying an artifact against a provenance envelope and a public key. This is what a consumer
// runs: it trusts only the key it is given.
import crypto from "node:crypto";
import { type DsseEnvelope, verifyEnvelope } from "./dsse";
import { PAYLOAD_TYPE, PREDICATE_TYPE, type Statement } from "./provenance";

export type ArtifactVerdict =
  | { ok: true; statement: Statement; keyid: string; subject: string; sha256: string }
  | {
      ok: false;
      reason:
        | "malformed"
        | "no_signature_for_key"
        | "bad_signature"
        | "wrong_payload_type"
        | "not_a_statement"
        | "wrong_predicate_type"
        | "artifact_not_a_subject";
    };

export function sha256Hex(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

/** `name`, when given, must also match the subject's name. */
export function verifyArtifact(o: {
  artifact: Uint8Array;
  envelope: unknown;
  publicKeyPem: string;
  name?: string | undefined;
}): ArtifactVerdict {
  return verifyDigest({ sha256: sha256Hex(o.artifact), ...o });
}

/** The same check for an artifact whose digest was computed elsewhere (a large file, streamed). */
export function verifyDigest(o: {
  sha256: string;
  envelope: unknown;
  publicKeyPem: string;
  name?: string | undefined;
}): ArtifactVerdict {
  const v = verifyEnvelope(o.envelope, o.publicKeyPem);
  if (!v.ok) return v;
  if ((o.envelope as DsseEnvelope).payloadType !== PAYLOAD_TYPE) {
    return { ok: false, reason: "wrong_payload_type" };
  }
  let statement: Statement;
  try {
    statement = JSON.parse(v.payload.toString("utf8")) as Statement;
  } catch {
    return { ok: false, reason: "not_a_statement" };
  }
  if (statement === null || typeof statement !== "object" || !Array.isArray(statement.subject)) {
    return { ok: false, reason: "not_a_statement" };
  }
  if (statement.predicateType !== PREDICATE_TYPE)
    return { ok: false, reason: "wrong_predicate_type" };
  const digest = o.sha256;
  const hit = statement.subject.find(
    (s) => s?.digest?.sha256 === digest && (o.name === undefined || s.name === o.name),
  );
  if (!hit) return { ok: false, reason: "artifact_not_a_subject" };
  return { ok: true, statement, keyid: v.keyid, subject: hit.name, sha256: digest };
}
