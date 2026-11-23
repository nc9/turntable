import crypto from "node:crypto";
import { SignerError, type PublicKey } from "./types";

/** `keyid` is the hex sha256 of the public key's SPKI DER: the same value for the same key everywhere. */
export function publicKeyFromSpki(spkiDer: Uint8Array): PublicKey {
  const key = crypto.createPublicKey({ key: Buffer.from(spkiDer), format: "der", type: "spki" });
  const curve = key.asymmetricKeyDetails?.namedCurve;
  const ok =
    key.asymmetricKeyType === "ed25519" ||
    (key.asymmetricKeyType === "ec" && (curve === "prime256v1" || curve === "P-256"));
  if (!ok) throw new SignerError("only Ed25519 and P-256 keys are supported");
  const der = key.export({ type: "spki", format: "der" }) as Buffer;
  return {
    keyid: crypto.createHash("sha256").update(der).digest("hex"),
    publicKeyPem: key.export({ type: "spki", format: "pem" }) as string,
  };
}

export function publicKeyFromPem(pem: string): PublicKey {
  const key = crypto.createPublicKey(pem);
  return publicKeyFromSpki(key.export({ type: "spki", format: "der" }) as Buffer);
}
