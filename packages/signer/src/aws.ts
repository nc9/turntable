// AWS KMS as a signing backend, over REST through the guarded outbound client. Requests are
// signed with SigV4 using TEMPORARY credentials the caller provides (from the org's OIDC issuer
// through STS, never a static key). The key must be an Ed25519 key (ECC_NIST_EDWARDS25519,
// algorithm ED25519_SHA_512); the private key never leaves KMS.
import { type SafeFetch, safeFetch } from "@turntable/net";
import { publicKeyFromSpki } from "./keys";
import { type AwsCredentials, signV4 } from "./sigv4";
import { type PublicKey, type Signer, SignerError } from "./types";

export interface AwsKmsOptions {
  region: string;
  /** Fresh temporary credentials, for example from AssumeRoleWithWebIdentity. Called per request. */
  credentials(): Promise<AwsCredentials>;
  fetch?: SafeFetch;
  /** Test seam. Default `https://kms.<region>.amazonaws.com`. */
  endpoint?: string;
  now?: () => number;
}

const KEY_ID =
  /^(arn:aws[a-z-]*:kms:[a-z0-9-]+:\d{12}:(key\/[0-9a-f-]{36}|alias\/[\w/-]{1,250})|[0-9a-f-]{36}|alias\/[\w/-]{1,250})$/;
/** SigV4 for a JSON POST to `/`. Exported for the request-shape tests. */
export function sigV4(o: {
  region: string;
  host: string;
  target: string;
  body: string;
  credentials: AwsCredentials;
  amzDate: string;
}): Record<string, string> {
  return signV4({
    method: "POST",
    headers: {
      "content-type": "application/x-amz-json-1.1",
      host: o.host,
      "x-amz-target": o.target,
    },
    body: o.body,
    region: o.region,
    service: "kms",
    credentials: o.credentials,
    amzDate: o.amzDate,
  });
}

export class AwsKmsSigner implements Signer {
  readonly #o: AwsKmsOptions;

  constructor(o: AwsKmsOptions) {
    if (!/^[a-z0-9-]{4,30}$/.test(o.region)) throw new SignerError("bad region");
    this.#o = o;
  }

  async #call(target: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const endpoint = this.#o.endpoint ?? `https://kms.${this.#o.region}.amazonaws.com`;
    const text = JSON.stringify(body);
    const amzDate = new Date((this.#o.now ?? Date.now)())
      .toISOString()
      .replaceAll(/[-:]|\.\d{3}/g, "");
    const headers = sigV4({
      region: this.#o.region,
      host: new URL(endpoint).host,
      target,
      body: text,
      credentials: await this.#o.credentials(),
      amzDate,
    });
    const res = await (this.#o.fetch ?? safeFetch)(`${endpoint}/`, {
      method: "POST",
      headers,
      body: text,
      redirect: "manual",
      maxBytes: 1_000_000,
      timeoutMs: 30_000,
    });
    // The body of an error is not echoed: it can carry account detail.
    if (!res.ok)
      throw new SignerError(`KMS ${target.split(".").at(-1)} failed: HTTP ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  }

  #keyId(keyRef: string): string {
    if (!KEY_ID.test(keyRef)) throw new SignerError("not a KMS key id, ARN or alias");
    return keyRef;
  }

  async publicKey(keyRef: string): Promise<PublicKey> {
    const out = await this.#call("TrentService.GetPublicKey", { KeyId: this.#keyId(keyRef) });
    if (typeof out.PublicKey !== "string") throw new SignerError("KMS returned no public key");
    return publicKeyFromSpki(Buffer.from(out.PublicKey, "base64"));
  }

  async sign(message: Uint8Array, keyRef: string): Promise<Uint8Array> {
    const out = await this.#call("TrentService.Sign", {
      KeyId: this.#keyId(keyRef),
      Message: Buffer.from(message).toString("base64"),
      MessageType: "RAW",
      SigningAlgorithm: "ED25519_SHA_512",
    });
    if (typeof out.Signature !== "string") throw new SignerError("KMS returned no signature");
    return new Uint8Array(Buffer.from(out.Signature, "base64"));
  }
}
