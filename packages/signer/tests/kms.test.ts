// The cloud backends against fakes: what each request looks like, that no static key is needed,
// and that a failure never echoes a response body.
import crypto from "node:crypto";
import { describe, expect, test } from "bun:test";
import type { SafeFetch } from "@turntable/net";
import {
  AwsKmsSigner,
  GcpKmsSigner,
  PAYLOAD_TYPE,
  signEnvelope,
  sigV4,
  verifyEnvelope,
} from "../src";

/** The error a promise rejects with. */
const rejection = (p: Promise<unknown>): Promise<Error> =>
  p.then(
    () => new Error("did not reject"),
    (e: unknown) => e as Error,
  );

const pair = crypto.generateKeyPairSync("ed25519");
const spki = pair.publicKey.export({ type: "spki", format: "der" }) as Buffer;
const spkiPem = pair.publicKey.export({ type: "spki", format: "pem" }) as string;

type Call = { url: string; method: string; headers: Headers; body: string };

function fake(handler: (c: Call) => Response) {
  const calls: Call[] = [];
  const impl: SafeFetch = async (input, init) => {
    const c = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : "",
    };
    calls.push(c);
    return handler(c);
  };
  return { calls, impl };
}

const creds = {
  accessKeyId: "ASIATESTKEY12345678",
  secretAccessKey: "test-secret-access-key-0123456789abcdef",
  sessionToken: "test-session-token",
};
const KEY = "arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789012";
const NOW = Date.parse("2026-11-22T10:20:30.000Z");

describe("AWS KMS", () => {
  const kms = (c: Call): Response => {
    const body = JSON.parse(c.body) as Record<string, string>;
    if (c.headers.get("x-amz-target") === "TrentService.GetPublicKey") {
      return Response.json({
        PublicKey: spki.toString("base64"),
        KeySpec: "ECC_NIST_EDWARDS25519",
      });
    }
    const sig = crypto.sign(null, Buffer.from(body.Message!, "base64"), pair.privateKey);
    return Response.json({ Signature: sig.toString("base64"), KeyId: body.KeyId });
  };

  test("Sign is an Ed25519 RAW request, signed with SigV4 under temporary credentials", async () => {
    const f = fake(kms);
    const signer = new AwsKmsSigner({
      region: "us-east-1",
      credentials: async () => creds,
      fetch: f.impl,
      now: () => NOW,
    });
    const sig = await signer.sign(Buffer.from("message"), KEY);
    expect(crypto.verify(null, Buffer.from("message"), pair.publicKey, Buffer.from(sig))).toBe(
      true,
    );
    const c = f.calls[0]!;
    expect(c.method).toBe("POST");
    expect(c.url).toBe("https://kms.us-east-1.amazonaws.com/");
    expect(c.headers.get("x-amz-target")).toBe("TrentService.Sign");
    expect(c.headers.get("content-type")).toBe("application/x-amz-json-1.1");
    expect(c.headers.get("x-amz-security-token")).toBe("test-session-token");
    expect(c.headers.get("x-amz-date")).toBe("20261122T102030Z");
    expect(JSON.parse(c.body)).toEqual({
      KeyId: KEY,
      Message: Buffer.from("message").toString("base64"),
      MessageType: "RAW",
      SigningAlgorithm: "ED25519_SHA_512",
    });
    const auth = c.headers.get("authorization")!;
    expect(auth).toMatch(
      /^AWS4-HMAC-SHA256 Credential=ASIATESTKEY12345678\/20261122\/us-east-1\/kms\/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-security-token;x-amz-target, Signature=[0-9a-f]{64}$/,
    );
    // The secret itself is never on the wire.
    expect(JSON.stringify([...c.headers.entries()]) + c.body).not.toContain(creds.secretAccessKey);
  });

  test("the SigV4 signature depends on the body, the date and the credentials", () => {
    const base = {
      region: "us-east-1",
      host: "kms.us-east-1.amazonaws.com",
      target: "TrentService.Sign",
      body: "{}",
      credentials: creds,
      amzDate: "20261122T102030Z",
    };
    const sig = (o: Partial<typeof base>) =>
      sigV4({ ...base, ...o }).authorization!.split("Signature=")[1];
    expect(sig({})).toBe(sig({}));
    expect(sig({ body: "{ }" })).not.toBe(sig({}));
    expect(sig({ amzDate: "20261122T102031Z" })).not.toBe(sig({}));
    expect(sig({ credentials: { ...creds, secretAccessKey: "x".repeat(40) } })).not.toBe(sig({}));
  });

  test("the public key comes from GetPublicKey, and a signature made through KMS verifies in an envelope", async () => {
    const f = fake(kms);
    const signer = new AwsKmsSigner({
      region: "us-east-1",
      credentials: async () => creds,
      fetch: f.impl,
    });
    const key = await signer.publicKey(KEY);
    expect(key.publicKeyPem).toBe(spkiPem);
    expect(f.calls[0]!.headers.get("x-amz-target")).toBe("TrentService.GetPublicKey");
    const env = await signEnvelope(PAYLOAD_TYPE, Buffer.from("{}"), signer, KEY);
    expect(verifyEnvelope(env, spkiPem).ok).toBe(true);
  });

  test("a bad key id or region is refused before any request; a failure does not echo the response", async () => {
    const f = fake(
      () =>
        new Response("AccessDenied for arn:aws:iam::123456789012:role/secret-role", {
          status: 403,
        }),
    );
    const signer = new AwsKmsSigner({
      region: "us-east-1",
      credentials: async () => creds,
      fetch: f.impl,
    });
    for (const bad of ["../x", "key id", "", "arn:aws:s3:::bucket"]) {
      await expect(signer.sign(Buffer.from("x"), bad)).rejects.toThrow("not a KMS key");
    }
    expect(f.calls).toHaveLength(0);
    expect(
      () => new AwsKmsSigner({ region: "evil.example/x", credentials: async () => creds }),
    ).toThrow();
    const err = await rejection(signer.sign(Buffer.from("x"), KEY));
    expect(err.message).toBe("KMS Sign failed: HTTP 403");
    expect(err.message).not.toContain("secret-role");
  });
});

describe("Cloud KMS", () => {
  const NAME = "projects/my-proj/locations/global/keyRings/rel/cryptoKeys/sign/cryptoKeyVersions/1";
  const gcp = (c: Call): Response => {
    if (c.method === "GET") return Response.json({ pem: spkiPem, algorithm: "EC_SIGN_ED25519" });
    const body = JSON.parse(c.body) as { data: string };
    return Response.json({
      signature: crypto
        .sign(null, Buffer.from(body.data, "base64"), pair.privateKey)
        .toString("base64"),
    });
  };

  test("asymmetricSign sends the data and a bearer token, and the signature verifies", async () => {
    const f = fake(gcp);
    const signer = new GcpKmsSigner({ accessToken: async () => "ya29.test-token", fetch: f.impl });
    const sig = await signer.sign(Buffer.from("message"), NAME);
    expect(crypto.verify(null, Buffer.from("message"), pair.publicKey, Buffer.from(sig))).toBe(
      true,
    );
    const c = f.calls[0]!;
    expect(c.method).toBe("POST");
    expect(c.url).toBe(`https://cloudkms.googleapis.com/v1/${NAME}:asymmetricSign`);
    expect(c.headers.get("authorization")).toBe("Bearer ya29.test-token");
    expect(JSON.parse(c.body)).toEqual({ data: Buffer.from("message").toString("base64") });
  });

  test("the public key must be an Ed25519 key version", async () => {
    const f = fake(() => Response.json({ pem: spkiPem, algorithm: "RSA_SIGN_PKCS1_2048_SHA256" }));
    const signer = new GcpKmsSigner({ accessToken: async () => "t", fetch: f.impl });
    await expect(signer.publicKey(NAME)).rejects.toThrow("EC_SIGN_ED25519");
    const ok = new GcpKmsSigner({ accessToken: async () => "t", fetch: fake(gcp).impl });
    expect((await ok.publicKey(NAME)).publicKeyPem).toBe(spkiPem);
  });

  test("a key name that is not a key version is refused before any request, and failures do not echo", async () => {
    const f = fake(
      () => new Response("PERMISSION_DENIED: service account svc@proj.iam", { status: 403 }),
    );
    const signer = new GcpKmsSigner({ accessToken: async () => "t", fetch: f.impl });
    for (const bad of ["../../x", `${NAME}/../2`, "projects/p/locations/l", ""]) {
      await expect(signer.sign(Buffer.from("x"), bad)).rejects.toThrow(
        "not a Cloud KMS key version",
      );
    }
    expect(f.calls).toHaveLength(0);
    const err = await rejection(signer.sign(Buffer.from("x"), NAME));
    expect(err.message).toBe("Cloud KMS asymmetricSign failed: HTTP 403");
    expect(err.message).not.toContain("svc@");
  });
});
