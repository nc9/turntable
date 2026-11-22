// Google Cloud KMS as a signing backend, over REST through the guarded outbound client, with an
// OAuth access token the caller provides (from the org's OIDC issuer through workload identity
// federation, never a static key). The key version must be EC_SIGN_ED25519; the private key never
// leaves KMS.
import { type SafeFetch, safeFetch } from "@longshore/net";
import { publicKeyFromPem } from "./keys";
import { type PublicKey, type Signer, SignerError } from "./types";

export interface GcpKmsOptions {
  /** A short-lived access token. Called per request. */
  accessToken(): Promise<string>;
  fetch?: SafeFetch;
  /** Test seam. Default `https://cloudkms.googleapis.com`. */
  endpoint?: string;
}

const KEY_VERSION =
  /^projects\/[a-z][a-z0-9-]{4,60}\/locations\/[a-z0-9-]{1,40}\/keyRings\/[A-Za-z0-9_-]{1,63}\/cryptoKeys\/[A-Za-z0-9_-]{1,63}\/cryptoKeyVersions\/\d{1,6}$/;

export class GcpKmsSigner implements Signer {
  readonly #o: GcpKmsOptions;

  constructor(o: GcpKmsOptions) {
    this.#o = o;
  }

  async #call(
    method: "GET" | "POST",
    keyRef: string,
    suffix: string,
    body?: unknown,
  ): Promise<Record<string, unknown>> {
    if (!KEY_VERSION.test(keyRef)) throw new SignerError("not a Cloud KMS key version name");
    const res = await (this.#o.fetch ?? safeFetch)(
      `${this.#o.endpoint ?? "https://cloudkms.googleapis.com"}/v1/${keyRef}${suffix}`,
      {
        method,
        headers: {
          authorization: `Bearer ${await this.#o.accessToken()}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "manual",
        maxBytes: 1_000_000,
        timeoutMs: 30_000,
      },
    );
    if (!res.ok) throw new SignerError(`Cloud KMS ${suffix.slice(1)} failed: HTTP ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  }

  async publicKey(keyRef: string): Promise<PublicKey> {
    const out = await this.#call("GET", keyRef, "/publicKey");
    if (out.algorithm !== "EC_SIGN_ED25519")
      throw new SignerError("the key version is not EC_SIGN_ED25519");
    if (typeof out.pem !== "string") throw new SignerError("Cloud KMS returned no public key");
    return publicKeyFromPem(out.pem);
  }

  async sign(message: Uint8Array, keyRef: string): Promise<Uint8Array> {
    const out = await this.#call("POST", keyRef, ":asymmetricSign", {
      data: Buffer.from(message).toString("base64"),
    });
    if (typeof out.signature !== "string") throw new SignerError("Cloud KMS returned no signature");
    return new Uint8Array(Buffer.from(out.signature, "base64"));
  }
}
