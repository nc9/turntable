// ed25519 approver keys: offline signing keys held off the machine. The public half is stored as
// SPKI DER (base64), the same form as WebAuthn keys. The private half never reaches the server;
// these helpers also back the `longshore approvals` CLI that creates and uses a key.
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** Accepts a PEM public key, base64 SPKI DER, or a raw 32-byte key in base64 or hex. */
export function parseEd25519PublicKey(text: string): string {
  const t = text.trim();
  let der: Buffer;
  if (t.startsWith("-----BEGIN")) {
    der = createPublicKey(t).export({ type: "spki", format: "der" });
  } else {
    const raw = /^[0-9a-fA-F]{64}$/.test(t) ? Buffer.from(t, "hex") : Buffer.from(t, "base64");
    der = raw.length === 32 ? Buffer.concat([ED25519_SPKI_PREFIX, raw]) : raw;
    // Re-export so only a well-formed ed25519 key gets through.
    der = createPublicKey({ key: der, format: "der", type: "spki" }).export({
      type: "spki",
      format: "der",
    });
  }
  const key = createPublicKey({ key: der, format: "der", type: "spki" });
  if (key.asymmetricKeyType !== "ed25519") throw new Error("not an ed25519 public key");
  return der.toString("base64");
}

export function generateEd25519(): { privatePem: string; publicSpki: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privatePem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicSpki: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
  };
}

/** Signs the canonical statement text. Returns base64url. */
export function signEd25519(privatePem: string, message: string): string {
  const key = createPrivateKey(privatePem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("not an ed25519 private key");
  return sign(null, Buffer.from(message, "utf8"), key).toString("base64url");
}

export function verifyEd25519(
  spkiBase64: string,
  message: string,
  signatureB64url: string,
): boolean {
  try {
    const key = createPublicKey({
      key: Buffer.from(spkiBase64, "base64"),
      format: "der",
      type: "spki",
    });
    return verify(
      null,
      Buffer.from(message, "utf8"),
      key,
      Buffer.from(signatureB64url, "base64url"),
    );
  } catch {
    return false;
  }
}
