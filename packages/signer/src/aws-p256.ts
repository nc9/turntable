// AWS KMS as a signing backend for an ECC_NIST_P256 key: `kms:Sign` with ECDSA_SHA_256 over the
// SHA-256 digest of the message (MessageType DIGEST), `kms:GetPublicKey` once per key (cached).
// Requests are SigV4-signed with TEMPORARY credentials the caller provides (see
// `webIdentityCredentials`), never a static key. The private key never leaves KMS.
//
// The public key KMS returns must be the one pinned for the key: a swapped or re-created key
// with the same ARN is refused (`key_mismatch`) before anything is signed.
import crypto from "node:crypto";
import { type SafeFetch, safeFetch } from "@turntable/net";
import { publicKeyFromSpki } from "./keys";
import { amzDateOf, type AwsCredentials, signV4 } from "./sigv4";
import { AwsSignerError, type PublicKey, type Signer } from "./types";

export interface AwsKmsP256Options {
  region: string;
  /** Fresh temporary credentials. Called per request; the provider caches. */
  credentials(): Promise<AwsCredentials>;
  /** The key's keyid (hex sha256 of its SPKI DER) as configured. A different key is refused. */
  pinnedKeyId: string;
  fetch?: SafeFetch;
  /** Test seam. Default `https://kms.<region>.amazonaws.com`. */
  endpoint?: string;
  now?: () => number;
}

const REGION = /^[a-z]{2}(-[a-z]+)+-\d$/;
const KEY_ARN = /^arn:aws:kms:([a-z0-9-]+):\d{12}:key\/[0-9a-f-]{36}$/;
const THROTTLE = new Set([
  "ThrottlingException",
  "Throttling",
  "TooManyRequestsException",
  "LimitExceededException",
  "RequestLimitExceeded",
]);

export class AwsKmsP256Signer implements Signer {
  readonly #o: AwsKmsP256Options;
  readonly #keys = new Map<string, Promise<PublicKey>>();

  constructor(o: AwsKmsP256Options) {
    if (!REGION.test(o.region)) throw new AwsSignerError("kms_denied", "bad region");
    if (!/^[0-9a-f]{64}$/.test(o.pinnedKeyId)) {
      throw new AwsSignerError("key_mismatch", "the pinned key fingerprint is not a sha256 hex");
    }
    this.#o = o;
  }

  async #call(target: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const op = target.split(".").at(-1);
    const endpoint = this.#o.endpoint ?? `https://kms.${this.#o.region}.amazonaws.com`;
    const text = JSON.stringify(body);
    const headers = signV4({
      method: "POST",
      headers: {
        "content-type": "application/x-amz-json-1.1",
        host: new URL(endpoint).host,
        "x-amz-target": target,
      },
      body: text,
      region: this.#o.region,
      service: "kms",
      credentials: await this.#o.credentials(),
      amzDate: amzDateOf((this.#o.now ?? Date.now)()),
    });
    let res: Response;
    try {
      res = await (this.#o.fetch ?? safeFetch)(`${endpoint}/`, {
        method: "POST",
        headers,
        body: text,
        redirect: "manual",
        maxBytes: 1_000_000,
        timeoutMs: 30_000,
      });
    } catch {
      throw new AwsSignerError("network", `KMS ${op}: the request failed`);
    }
    if (!res.ok) {
      // Only the error type is kept: the message can carry account detail.
      const raw = await res.text().catch(() => "");
      let type = "unknown";
      try {
        const t = (JSON.parse(raw) as { __type?: unknown }).__type;
        if (typeof t === "string")
          type = (t.split("#").at(-1) ?? "").replaceAll(/[^A-Za-z]/g, "").slice(0, 64);
      } catch {
        // not JSON
      }
      if (res.status >= 500)
        throw new AwsSignerError("network", `KMS ${op} failed: HTTP ${res.status}`);
      const kind = res.status === 429 || THROTTLE.has(type) ? "kms_throttled" : "kms_denied";
      throw new AwsSignerError(kind, `KMS ${op} failed: HTTP ${res.status} ${type}`);
    }
    try {
      return (await res.json()) as Record<string, unknown>;
    } catch {
      throw new AwsSignerError("network", `KMS ${op}: unreadable response`);
    }
  }

  #arn(keyRef: string): string {
    const m = KEY_ARN.exec(keyRef);
    // The key lives in the region this signer talks to: a request never leaves it.
    if (!m || m[1] !== this.#o.region) {
      throw new AwsSignerError("kms_denied", "not a KMS key ARN in the configured region");
    }
    return keyRef;
  }

  publicKey(keyRef: string): Promise<PublicKey> {
    const arn = this.#arn(keyRef);
    let p = this.#keys.get(arn);
    if (!p) {
      p = this.#fetchKey(arn);
      this.#keys.set(arn, p);
      // A failure is not cached: the next call asks again.
      p.catch(() => this.#keys.delete(arn));
    }
    return p;
  }

  async #fetchKey(arn: string): Promise<PublicKey> {
    const out = await this.#call("TrentService.GetPublicKey", { KeyId: arn });
    if (out.KeySpec !== "ECC_NIST_P256" || typeof out.PublicKey !== "string") {
      throw new AwsSignerError("key_mismatch", "the KMS key is not an ECC_NIST_P256 key");
    }
    let key: PublicKey;
    try {
      key = publicKeyFromSpki(Buffer.from(out.PublicKey, "base64"));
    } catch {
      throw new AwsSignerError("key_mismatch", "KMS returned an unusable public key");
    }
    if (key.keyid !== this.#o.pinnedKeyId) {
      throw new AwsSignerError("key_mismatch", "the KMS public key is not the pinned key");
    }
    return key;
  }

  async sign(message: Uint8Array, keyRef: string): Promise<Uint8Array> {
    const arn = this.#arn(keyRef);
    // Nothing is signed under a key that is not the pinned one.
    await this.publicKey(arn);
    const digest = crypto.createHash("sha256").update(message).digest();
    const out = await this.#call("TrentService.Sign", {
      KeyId: arn,
      Message: digest.toString("base64"),
      MessageType: "DIGEST",
      SigningAlgorithm: "ECDSA_SHA_256",
    });
    if (typeof out.Signature !== "string") {
      throw new AwsSignerError("kms_denied", "KMS returned no signature");
    }
    // KMS returns the DER form, which is what the envelope carries.
    return new Uint8Array(Buffer.from(out.Signature, "base64"));
  }
}
