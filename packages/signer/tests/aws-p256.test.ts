// The P-256 KMS signer and the STS web-identity provider against fakes.
import crypto from "node:crypto";
import { describe, expect, test } from "bun:test";
import type { SafeFetch } from "@turntable/net";
import { signDigest } from "./p256-prehash";
import {
  AwsKmsP256Signer,
  AwsSignerError,
  PAYLOAD_TYPE,
  publicKeyFromSpki,
  signEnvelope,
  verifyEnvelope,
  webIdentityCredentials,
} from "../src";

const pair = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const spki = pair.publicKey.export({ type: "spki", format: "der" }) as Buffer;
const pin = publicKeyFromSpki(spki);
const ARN = "arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789012";
const ROLE = "arn:aws:iam::123456789012:role/turntable-release";
const creds = { accessKeyId: "ASIAFAKE", secretAccessKey: "s".repeat(40), sessionToken: "tk" };

const kind = async (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => "none",
    (e: unknown) => (e instanceof AwsSignerError ? e.kind : "other"),
  );

function kmsFake(over: { status?: number; type?: string; spki?: Buffer } = {}) {
  const seen: { target: string; body: Record<string, string> }[] = [];
  const impl: SafeFetch = async (_u, init) => {
    const target = new Headers(init?.headers).get("x-amz-target")!;
    const body = JSON.parse(init!.body as string) as Record<string, string>;
    seen.push({ target, body });
    if (over.status && target.endsWith("Sign")) {
      return new Response(JSON.stringify({ __type: over.type, message: "acct 123456789012" }), {
        status: over.status,
      });
    }
    if (target.endsWith("GetPublicKey")) {
      return Response.json({
        KeySpec: "ECC_NIST_P256",
        PublicKey: (over.spki ?? spki).toString("base64"),
      });
    }
    // KMS signs the digest it is given, DER encoded.
    return Response.json({
      Signature: signDigest(pair.privateKey, Buffer.from(body.Message!, "base64")).toString(
        "base64",
      ),
    });
  };
  return { seen, impl };
}

const signer = (f: SafeFetch, pinnedKeyId = pin.keyid) =>
  new AwsKmsP256Signer({
    region: "us-east-1",
    credentials: async () => creds,
    pinnedKeyId,
    fetch: f,
    now: () => Date.parse("2026-11-22T10:20:30Z"),
  });

describe("AwsKmsP256Signer", () => {
  test("signs the SHA-256 digest (DIGEST, ECDSA_SHA_256) and the envelope verifies", async () => {
    // The fake signs the digest as if it were the message hash: emulate KMS with prehash.
    const seen: Record<string, string>[] = [];
    const impl: SafeFetch = async (_u, init) => {
      const target = new Headers(init?.headers).get("x-amz-target")!;
      const body = JSON.parse(init!.body as string) as Record<string, string>;
      seen.push(body);
      if (target.endsWith("GetPublicKey"))
        return Response.json({ KeySpec: "ECC_NIST_P256", PublicKey: spki.toString("base64") });
      expect(body.MessageType).toBe("DIGEST");
      expect(body.SigningAlgorithm).toBe("ECDSA_SHA_256");
      expect(Buffer.from(body.Message!, "base64")).toHaveLength(32);
      // Sign the digest directly: DER ECDSA over the given 32 bytes.
      const s = signDigest(pair.privateKey, Buffer.from(body.Message!, "base64"));
      return Response.json({ Signature: s.toString("base64") });
    };
    const env = await signEnvelope(PAYLOAD_TYPE, Buffer.from("{}"), signer(impl), ARN);
    expect(env.signatures[0]!.keyid).toBe(pin.keyid);
    expect(verifyEnvelope(env, pin.publicKeyPem).ok).toBe(true);
  });

  test("GetPublicKey is asked once per key", async () => {
    const f = kmsFake();
    const s = signer(f.impl);
    await s.publicKey(ARN);
    await s.publicKey(ARN);
    expect(f.seen.filter((c) => c.target.endsWith("GetPublicKey"))).toHaveLength(1);
  });

  test("a key that is not the pinned one is refused before anything is signed", async () => {
    const other = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const f = kmsFake({ spki: other.publicKey.export({ type: "spki", format: "der" }) as Buffer });
    expect(await kind(signer(f.impl).sign(Buffer.from("m"), ARN))).toBe("key_mismatch");
    expect(f.seen.some((c) => c.target.endsWith("Sign"))).toBe(false);
  });

  test("errors are classified and carry no response body", async () => {
    const t = signer(kmsFake({ status: 400, type: "ThrottlingException" }).impl);
    expect(await kind(t.sign(Buffer.from("m"), ARN))).toBe("kms_throttled");
    const d = signer(kmsFake({ status: 400, type: "AccessDeniedException" }).impl);
    expect(await kind(d.sign(Buffer.from("m"), ARN))).toBe("kms_denied");
    const e = await d.sign(Buffer.from("m"), ARN).catch((x: Error) => x);
    expect((e as Error).message).not.toContain("123456789012");
    const n = signer(async () => {
      throw new Error("boom");
    });
    expect(await kind(n.sign(Buffer.from("m"), ARN))).toBe("network");
  });

  test("a key ARN in another region is refused", async () => {
    const f = kmsFake();
    const bad = ARN.replace("us-east-1", "eu-west-1");
    expect(await kind(signer(f.impl).sign(Buffer.from("m"), bad))).toBe("kms_denied");
    expect(f.seen).toHaveLength(0);
  });
});

describe("webIdentityCredentials", () => {
  const sts = (expiresAtMs: () => number, status = 200) => {
    const calls: URLSearchParams[] = [];
    const impl: SafeFetch = async (url, init) => {
      expect(String(url)).toBe("https://sts.us-east-1.amazonaws.com/");
      expect(new Headers(init?.headers).get("authorization")).toBeNull();
      calls.push(new URLSearchParams(init!.body as string));
      if (status !== 200) {
        return new Response("<Error><Code>AccessDenied</Code><Message>acct</Message></Error>", {
          status,
        });
      }
      return Response.json({
        AssumeRoleWithWebIdentityResponse: {
          AssumeRoleWithWebIdentityResult: {
            Credentials: {
              AccessKeyId: "ASIAX",
              SecretAccessKey: "sk",
              SessionToken: "st",
              Expiration: expiresAtMs() / 1000,
            },
          },
        },
      });
    };
    return { calls, impl };
  };

  test("assumes the role with the token, caches, and refreshes one minute before expiry", async () => {
    let now = 1_000_000;
    const f = sts(() => now + 900_000);
    let n = 0;
    const get = webIdentityCredentials({
      region: "us-east-1",
      roleArn: ROLE,
      token: async () => `jwt${++n}`,
      fetch: f.impl,
      now: () => now,
    });
    expect((await get()).sessionToken).toBe("st");
    await get();
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.get("DurationSeconds")).toBe("900");
    expect(f.calls[0]!.get("RoleArn")).toBe(ROLE);
    now += 839_000;
    await get();
    expect(f.calls).toHaveLength(1);
    now += 2_000; // inside the last minute
    await get();
    expect(f.calls).toHaveLength(2);
    expect(f.calls[1]!.get("WebIdentityToken")).toBe("jwt2");
  });

  test("a refusal is sts_denied and keeps no body", async () => {
    const get = webIdentityCredentials({
      region: "us-east-1",
      roleArn: ROLE,
      token: async () => "jwt",
      fetch: sts(() => 0, 403).impl,
    });
    const e = await get().catch((x: unknown) => x);
    expect((e as AwsSignerError).kind).toBe("sts_denied");
    expect((e as Error).message).not.toContain("acct");
  });
});
