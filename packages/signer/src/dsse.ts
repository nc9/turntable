// DSSE (https://github.com/secure-systems-lab/dsse): the signature covers the payload type and
// the payload together, so neither can be swapped without breaking it.
import crypto from "node:crypto";
import { publicKeyFromPem } from "./keys";
import { type Signer, SignerError } from "./types";

export interface DsseEnvelope {
  /** base64 of the payload. */
  payload: string;
  payloadType: string;
  signatures: { keyid: string; sig: string }[];
}

/** DSSEv1 pre-authentication encoding. */
export function pae(payloadType: string, payload: Uint8Array): Buffer {
  const type = Buffer.from(payloadType);
  return Buffer.concat([
    Buffer.from(`DSSEv1 ${type.length} `),
    type,
    Buffer.from(` ${payload.length} `),
    Buffer.from(payload),
  ]);
}

export async function signEnvelope(
  payloadType: string,
  payload: Uint8Array,
  signer: Signer,
  keyRef: string,
): Promise<DsseEnvelope> {
  const key = await signer.publicKey(keyRef);
  const sig = await signer.sign(pae(payloadType, payload), keyRef);
  // A misconfigured key or a broken backend is found here, not by whoever verifies it later.
  if (!verifyRaw(key.publicKeyPem, pae(payloadType, payload), sig)) {
    throw new SignerError("the backend's signature does not verify under its own public key");
  }
  return {
    payload: Buffer.from(payload).toString("base64"),
    payloadType,
    signatures: [{ keyid: key.keyid, sig: Buffer.from(sig).toString("base64") }],
  };
}

function verifyRaw(publicKeyPem: string, message: Uint8Array, sig: Uint8Array): boolean {
  try {
    return crypto.verify(
      null,
      Buffer.from(message),
      crypto.createPublicKey(publicKeyPem),
      Buffer.from(sig),
    );
  } catch {
    return false;
  }
}

export type VerifyResult =
  | { ok: true; payload: Buffer; keyid: string }
  | { ok: false; reason: "malformed" | "no_signature_for_key" | "bad_signature" };

/** Verifies an envelope against ONE trusted public key (SPKI PEM). */
export function verifyEnvelope(envelope: unknown, publicKeyPem: string): VerifyResult {
  const e = envelope as Partial<DsseEnvelope> | null;
  if (
    e === null ||
    typeof e !== "object" ||
    typeof e.payload !== "string" ||
    typeof e.payloadType !== "string" ||
    !Array.isArray(e.signatures)
  ) {
    return { ok: false, reason: "malformed" };
  }
  let key;
  try {
    key = publicKeyFromPem(publicKeyPem);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const payload = Buffer.from(e.payload, "base64");
  const message = pae(e.payloadType, payload);
  const mine = e.signatures.filter((s) => s && s.keyid === key.keyid && typeof s.sig === "string");
  if (mine.length === 0) return { ok: false, reason: "no_signature_for_key" };
  for (const s of mine) {
    if (verifyRaw(key.publicKeyPem, message, Buffer.from(s.sig, "base64"))) {
      return { ok: true, payload, keyid: key.keyid };
    }
  }
  return { ok: false, reason: "bad_signature" };
}
