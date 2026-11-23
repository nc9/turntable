// The browser side of a passkey ceremony. These wrap `navigator.credentials` and turn its
// binary results into the base64url fields the API takes. A `CredentialsLike` is injected so the
// shaping is testable without a browser.
import type { WebAuthnSignature } from "@/api/types";

export type CredentialsLike = Pick<CredentialsContainer, "create" | "get">;

export function b64urlEncode(bytes: ArrayBuffer | Uint8Array): string {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of u) s += String.fromCharCode(b);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function b64urlDecode(text: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (text.length % 4)) % 4);
  const bin = atob(text.replaceAll("-", "+").replaceAll("_", "/") + pad);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export class CeremonyError extends Error {}

const TIMEOUT_MS = 120_000;

/** Whether this browser can do passkey ceremonies at all. */
export function webauthnAvailable(): boolean {
  return (
    typeof window !== "undefined" && "PublicKeyCredential" in window && !!navigator.credentials
  );
}

/**
 * Asks the authenticator to sign the challenge. The challenge is the hash of the statement the
 * server issued: the page shows that statement to the person first, and signs nothing else.
 */
export async function signWithPasskey(
  o: { challenge: string; rpId: string; passkeyId: string },
  credentials: CredentialsLike = navigator.credentials,
): Promise<WebAuthnSignature> {
  let cred: Credential | null;
  try {
    cred = await credentials.get({
      publicKey: {
        challenge: b64urlDecode(o.challenge),
        rpId: o.rpId,
        allowCredentials: [{ type: "public-key", id: b64urlDecode(o.passkeyId) }],
        // The server refuses an assertion without user verification, so ask for it.
        userVerification: "required",
        timeout: TIMEOUT_MS,
      },
    });
  } catch (e) {
    throw new CeremonyError(ceremonyMessage(e, "Signing was cancelled or the key was not found."));
  }
  const pk = cred as PublicKeyCredential | null;
  const res = pk?.response as AuthenticatorAssertionResponse | undefined;
  if (!pk || !res || !("signature" in res)) throw new CeremonyError("No signature was returned.");
  return {
    kind: "webauthn",
    credential_id: b64urlEncode(pk.rawId),
    client_data_json: b64urlEncode(res.clientDataJSON),
    authenticator_data: b64urlEncode(res.authenticatorData),
    signature: b64urlEncode(res.signature),
  };
}

/** Creates a new passkey for enrolment: attestation "none", user verification required. */
export async function createPasskey(
  o: { challenge: string; rpId: string; person: string; attestation?: "none" | "direct" },
  credentials: CredentialsLike = navigator.credentials,
): Promise<{ clientDataJson: string; attestationObject: string }> {
  let cred: Credential | null;
  try {
    cred = await credentials.create({
      publicKey: {
        challenge: b64urlDecode(o.challenge),
        rp: { id: o.rpId, name: "Turntable" },
        user: {
          id: crypto.getRandomValues(new Uint8Array(new ArrayBuffer(16))),
          name: o.person,
          displayName: o.person,
        },
        // ES256 and EdDSA are what the server verifies.
        pubKeyCredParams: [
          { type: "public-key", alg: -7 },
          { type: "public-key", alg: -8 },
        ],
        authenticatorSelection: { userVerification: "required", residentKey: "preferred" },
        // "direct" under the hardware key policy: the server checks the vendor attestation.
        attestation: o.attestation ?? "none",
        timeout: TIMEOUT_MS,
      },
    });
  } catch (e) {
    throw new CeremonyError(ceremonyMessage(e, "Registration was cancelled."));
  }
  const pk = cred as PublicKeyCredential | null;
  const res = pk?.response as AuthenticatorAttestationResponse | undefined;
  if (!pk || !res || !("attestationObject" in res))
    throw new CeremonyError("No credential was created.");
  return {
    clientDataJson: b64urlEncode(res.clientDataJSON),
    attestationObject: b64urlEncode(res.attestationObject),
  };
}

function ceremonyMessage(e: unknown, fallback: string): string {
  if (e instanceof DOMException) {
    if (e.name === "NotAllowedError") return "The request was cancelled or timed out.";
    if (e.name === "InvalidStateError") return "That key is already registered.";
    if (e.name === "SecurityError") return "This page's address is not allowed for that key.";
  }
  return fallback;
}
