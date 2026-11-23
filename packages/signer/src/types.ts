// What a signing backend is. The service signs bytes it built itself (a DSSE encoding of a
// statement whose subjects are digests from the artifact store) and never hands a backend
// anything a caller supplied. Keys are never exported: a backend can sign and name its public
// key, and nothing else.

export interface PublicKey {
  /** Stable id: hex sha256 of the SubjectPublicKeyInfo DER. */
  keyid: string;
  /** SPKI PEM: Ed25519, or P-256 for a KMS key. */
  publicKeyPem: string;
}

export interface Signer {
  /** The public half of a key reference. */
  publicKey(keyRef: string): Promise<PublicKey>;
  /**
   * Signs `message` with the key `keyRef` names. Ed25519 signs the message directly; a P-256 key
   * signs its SHA-256 and returns the DER ECDSA signature (what `crypto.verify` and cosign take).
   */
  sign(message: Uint8Array, keyRef: string): Promise<Uint8Array>;
}

/** Where the built-in backend keeps its sealed key material (the system secret domain). */
export interface KeyVault {
  get(name: string): Promise<string | undefined>;
  set(name: string, value: string): Promise<void>;
}

export class SignerError extends Error {}

export interface Artifact {
  name: string;
  /** Lower-case hex sha256. */
  sha256: string;
}

/** Why an AWS call failed, never carrying a response body, a credential or a token. */
export type AwsFailure = "sts_denied" | "kms_denied" | "kms_throttled" | "key_mismatch" | "network";

export class AwsSignerError extends SignerError {
  readonly kind: AwsFailure;
  constructor(kind: AwsFailure, message: string) {
    super(message);
    this.kind = kind;
  }
}
