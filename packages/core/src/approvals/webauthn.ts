// WebAuthn, server side, with node:crypto: registration with attestation "none" and assertion
// verification for ES256 and EdDSA keys. We do not validate attestation statements: an approver
// key is trusted because an existing quorum enrolled it, not because a vendor certified it.
// Every check that matters is here: the challenge, the origin, the relying party id hash, the
// user-presence and user-verification flags, the signature over authData and the client data
// hash, and a sign counter that must not go backwards.
import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";
import { decodeCbor, type Cbor } from "./cbor";

export type RelyingParty = { rpId: string; origins: readonly string[] };

export class WebAuthnError extends Error {}

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

const sha256 = (b: Uint8Array | string): Buffer => createHash("sha256").update(b).digest();

function parseClientData(
  raw: Uint8Array,
  expect: { type: "webauthn.create" | "webauthn.get"; challenge: string; rp: RelyingParty },
): void {
  let c: { type?: unknown; challenge?: unknown; origin?: unknown; crossOrigin?: unknown };
  try {
    c = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)) as typeof c;
  } catch {
    throw new WebAuthnError("client data is not JSON");
  }
  if (c.type !== expect.type) throw new WebAuthnError("wrong ceremony type");
  if (c.challenge !== expect.challenge) throw new WebAuthnError("challenge mismatch");
  if (typeof c.origin !== "string" || !expect.rp.origins.includes(c.origin))
    throw new WebAuthnError("origin is not allowed");
  if (c.crossOrigin === true) throw new WebAuthnError("cross-origin ceremonies are refused");
}

type AuthData = {
  rpIdHash: Buffer;
  flags: number;
  signCount: number;
  attested?: { credentialId: Buffer; coseKey: Cbor };
};

function parseAuthData(b: Uint8Array, wantAttested: boolean): AuthData {
  if (b.length < 37) throw new WebAuthnError("authenticator data is too short");
  const buf = Buffer.from(b);
  const out: AuthData = {
    rpIdHash: buf.subarray(0, 32),
    flags: buf[32]!,
    signCount: buf.readUInt32BE(33),
  };
  if (wantAttested) {
    if ((out.flags & FLAG_AT) === 0) throw new WebAuthnError("no attested credential data");
    if (buf.length < 55) throw new WebAuthnError("attested credential data is too short");
    const idLen = buf.readUInt16BE(53);
    if (idLen < 16 || idLen > 1023 || buf.length < 55 + idLen)
      throw new WebAuthnError("bad credential id length");
    const credentialId = buf.subarray(55, 55 + idLen);
    let coseKey: Cbor;
    try {
      coseKey = decodeCbor(buf.subarray(55 + idLen)).value;
    } catch {
      throw new WebAuthnError("bad credential public key");
    }
    out.attested = { credentialId, coseKey };
  }
  return out;
}

function checkRpAndFlags(a: AuthData, rp: RelyingParty): void {
  if (!a.rpIdHash.equals(sha256(rp.rpId))) throw new WebAuthnError("relying party id mismatch");
  if ((a.flags & FLAG_UP) === 0) throw new WebAuthnError("user presence is required");
  // An approval is a decision by a person: the authenticator must have verified them (PIN or
  // biometric), not just seen a touch.
  if ((a.flags & FLAG_UV) === 0) throw new WebAuthnError("user verification is required");
}

/** COSE key to SPKI DER (base64) and the algorithm name. ES256 (P-256) and EdDSA (Ed25519). */
export function coseToSpki(cose: Cbor): { spki: string; alg: "ES256" | "EdDSA" } {
  if (!(cose instanceof Map)) throw new WebAuthnError("public key is not a COSE map");
  const get = (k: number) => cose.get(k);
  const bytes = (v: Cbor | undefined): Buffer => {
    if (!(v instanceof Uint8Array)) throw new WebAuthnError("bad COSE key coordinate");
    return Buffer.from(v);
  };
  const kty = get(1);
  const alg = get(3);
  const crv = get(-1);
  let key: KeyObject;
  let name: "ES256" | "EdDSA";
  if (kty === 2 && alg === -7 && crv === 1) {
    const x = bytes(get(-2));
    const y = bytes(get(-3));
    if (x.length !== 32 || y.length !== 32) throw new WebAuthnError("bad P-256 coordinates");
    key = createPublicKey({
      key: { kty: "EC", crv: "P-256", x: x.toString("base64url"), y: y.toString("base64url") },
      format: "jwk",
    });
    name = "ES256";
  } else if (kty === 1 && alg === -8 && crv === 6) {
    const x = bytes(get(-2));
    if (x.length !== 32) throw new WebAuthnError("bad Ed25519 key");
    key = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: x.toString("base64url") },
      format: "jwk",
    });
    name = "EdDSA";
  } else {
    throw new WebAuthnError("unsupported key type (use ES256 or EdDSA)");
  }
  return { spki: key.export({ type: "spki", format: "der" }).toString("base64"), alg: name };
}

export type RegistrationInput = {
  clientDataJSON: string; // base64url
  attestationObject: string; // base64url
};

/** Verifies a `navigator.credentials.create` result with attestation "none". */
export function verifyRegistration(
  input: RegistrationInput,
  expect: { challenge: string; rp: RelyingParty },
): { credentialId: string; publicKey: string; alg: "ES256" | "EdDSA"; signCount: number } {
  parseClientData(Buffer.from(input.clientDataJSON, "base64url"), {
    type: "webauthn.create",
    ...expect,
  });
  let att: Cbor;
  try {
    att = decodeCbor(Buffer.from(input.attestationObject, "base64url")).value;
  } catch {
    throw new WebAuthnError("bad attestation object");
  }
  if (!(att instanceof Map)) throw new WebAuthnError("bad attestation object");
  if (att.get("fmt") !== "none") throw new WebAuthnError('only attestation "none" is accepted');
  const authData = att.get("authData");
  if (!(authData instanceof Uint8Array)) throw new WebAuthnError("no authenticator data");
  const a = parseAuthData(authData, true);
  checkRpAndFlags(a, expect.rp);
  const { spki, alg } = coseToSpki(a.attested!.coseKey);
  return {
    credentialId: a.attested!.credentialId.toString("base64url"),
    publicKey: spki,
    alg,
    signCount: a.signCount,
  };
}

export type AssertionInput = {
  credentialId: string; // base64url
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
};

/** Verifies a `navigator.credentials.get` result against a stored key. Returns the new counter. */
export function verifyAssertion(
  input: AssertionInput,
  key: { publicKey: string; alg: string; signCount: number },
  expect: { challenge: string; rp: RelyingParty },
): { signCount: number } {
  const clientData = Buffer.from(input.clientDataJSON, "base64url");
  parseClientData(clientData, { type: "webauthn.get", ...expect });
  const authData = Buffer.from(input.authenticatorData, "base64url");
  const a = parseAuthData(authData, false);
  checkRpAndFlags(a, expect.rp);
  const pub = createPublicKey({
    key: Buffer.from(key.publicKey, "base64"),
    format: "der",
    type: "spki",
  });
  const signed = Buffer.concat([authData, sha256(clientData)]);
  const sig = Buffer.from(input.signature, "base64url");
  let ok = false;
  try {
    ok =
      key.alg === "ES256"
        ? verify("sha256", signed, pub, sig)
        : key.alg === "EdDSA"
          ? verify(null, signed, pub, sig)
          : false;
  } catch {
    ok = false;
  }
  if (!ok) throw new WebAuthnError("signature does not verify");
  // A counter that does not advance means a cloned authenticator, unless the device has none.
  if ((a.signCount !== 0 || key.signCount !== 0) && a.signCount <= key.signCount)
    throw new WebAuthnError("sign counter did not advance");
  return { signCount: a.signCount };
}
