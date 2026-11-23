// The `aws-kms` backend end to end against a local fake STS and KMS: the release lane's OIDC
// token, AssumeRoleWithWebIdentity, kms:Sign over the digest, and what is audited.
import crypto from "node:crypto";
import { beforeEach, describe, expect, test } from "bun:test";
import type { SafeFetch } from "@turntable/net";
import { PAYLOAD_TYPE, publicKeyFromSpki, signEnvelope, verifyEnvelope } from "@turntable/signer";
import { signDigest } from "../../signer/tests/p256-prehash";
import { resetFailureThrottle } from "../src/audit/failures";
import { listAudit, setFreeze, type Db } from "../src/db";
import { OidcIssuer } from "../src/oidc/issuer";
import { settingsRegistry } from "../src/settings/definitions";
import { createSettingsRuntime } from "../src/settings/resolve";
import { AwsKmsBackend } from "../src/signing";
import { seedWorld, type Tenant } from "./ops-helpers";

const ARN = "arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789012";
const ROLE = "arn:aws:iam::123456789012:role/turntable-release";
const pair = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const spki = pair.publicKey.export({ type: "spki", format: "der" }) as Buffer;
const pin = publicKeyFromSpki(spki);
const SECRET_KEY = "fake-secret-access-key-".padEnd(40, "z");
const SESSION = "fake-session-token-value";

const MASTER = crypto.randomBytes(32);
let db: Db;
let a: Tenant;
let now: number;
let sts: { status: number; code: string };
let kms: { status: number; type: string; spki: Buffer };
let tokens: string[];
let stsCalls: number;

const jwt = (t: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(t.split(".")[1]!, "base64url").toString("utf8"));

const fetchImpl: SafeFetch = async (url, init) => {
  const u = new URL(String(url));
  if (u.host === "sts.us-east-1.amazonaws.com") {
    stsCalls++;
    tokens.push(new URLSearchParams(init!.body as string).get("WebIdentityToken")!);
    if (sts.status !== 200) {
      return new Response(`<Error><Code>${sts.code}</Code></Error>`, { status: sts.status });
    }
    return Response.json({
      AssumeRoleWithWebIdentityResponse: {
        AssumeRoleWithWebIdentityResult: {
          Credentials: {
            AccessKeyId: "ASIAFAKE",
            SecretAccessKey: SECRET_KEY,
            SessionToken: SESSION,
            Expiration: (now + 900_000) / 1000,
          },
        },
      },
    });
  }
  expect(u.host).toBe("kms.us-east-1.amazonaws.com");
  const target = new Headers(init?.headers).get("x-amz-target")!;
  if (target.endsWith("GetPublicKey")) {
    return Response.json({ KeySpec: "ECC_NIST_P256", PublicKey: kms.spki.toString("base64") });
  }
  if (kms.status !== 200) {
    return new Response(JSON.stringify({ __type: kms.type }), { status: kms.status });
  }
  const body = JSON.parse(init!.body as string) as { Message: string };
  return Response.json({
    Signature: signDigest(pair.privateKey, Buffer.from(body.Message, "base64")).toString("base64"),
  });
};

function backend(config: unknown = defaultConfig()) {
  const issuer = new OidcIssuer({
    db,
    masterKey: MASTER,
    baseUrl: "https://ci.example.test/oidc",
    now: () => now,
  });
  return new AwsKmsBackend({
    db,
    tokens: issuer,
    settings: createSettingsRuntime(settingsRegistry, {
      TURNTABLE_AWS_KMS_KEYS: JSON.stringify(config),
    }),
    fetch: fetchImpl,
    now: () => now,
  });
}
const defaultConfig = () => ({
  [ARN]: { role_arn: ROLE, region: "us-east-1", public_key_fingerprint: pin.keyid },
});
const audit = async () =>
  (await listAudit(db, a.scope)).filter((x) => x.op === "kms_sign" || x.op === "oidc_mint_release");

beforeEach(async () => {
  ({ db, a } = await seedWorld());
  now = 1_800_000_000_000;
  sts = { status: 200, code: "" };
  kms = { status: 200, type: "", spki };
  tokens = [];
  stsCalls = 0;
  resetFailureThrottle();
});

describe("aws-kms backend", () => {
  test("a signature verifies under GetPublicKey's key, in an envelope", async () => {
    const signer = backend().forScope(a.scope);
    const env = await signEnvelope(PAYLOAD_TYPE, Buffer.from('{"x":1}'), signer, ARN);
    expect(verifyEnvelope(env, pin.publicKeyPem)).toMatchObject({ ok: true, keyid: pin.keyid });
  });

  test("the token is the release lane's: sub names the project, never a job, five minutes at most", async () => {
    await backend().forScope(a.scope).sign(Buffer.from("m"), ARN);
    const c = jwt(tokens[0]!);
    expect(c.sub).toBe(`turntable:release:${a.slug}/${a.projectSlug}`);
    expect(c.aud).toBe("sts.amazonaws.com");
    expect((c.exp as number) - (c.iat as number)).toBeLessThanOrEqual(300);
    for (const k of ["job", "job_id", "attempt_id", "run_id"]) expect(c).not.toHaveProperty(k);
    expect(String(c.sub)).not.toContain(":job");
  });

  test("credentials are cached and refreshed one minute before expiry", async () => {
    const s = backend().forScope(a.scope);
    await s.sign(Buffer.from("1"), ARN);
    await s.sign(Buffer.from("2"), ARN);
    expect(stsCalls).toBe(1);
    now += 15 * 60_000 - 30_000;
    await s.sign(Buffer.from("3"), ARN);
    expect(stsCalls).toBe(2);
  });

  test("STS refusal, KMS throttling and a different key are classified and audited", async () => {
    sts = { status: 403, code: "AccessDenied" };
    await expect(backend().forScope(a.scope).sign(Buffer.from("m"), ARN)).rejects.toMatchObject({
      kind: "sts_denied",
    });
    sts = { status: 200, code: "" };
    kms = { status: 400, type: "ThrottlingException", spki };
    await expect(backend().forScope(a.scope).sign(Buffer.from("m"), ARN)).rejects.toMatchObject({
      kind: "kms_throttled",
    });
    kms = {
      status: 200,
      type: "",
      spki: crypto
        .generateKeyPairSync("ec", { namedCurve: "prime256v1" })
        .publicKey.export({ type: "spki", format: "der" }) as Buffer,
    };
    await expect(backend().forScope(a.scope).sign(Buffer.from("m"), ARN)).rejects.toMatchObject({
      kind: "key_mismatch",
    });
    const outcomes = (await audit()).filter((x) => x.op === "kms_sign").map((x) => x.outcome);
    expect(outcomes.sort()).toEqual([
      "error:key_mismatch",
      "error:kms_throttled",
      "error:sts_denied",
    ]);
  });

  test("nothing secret reaches the audit or an error: the audit has the key ARN and digest", async () => {
    const message = Buffer.from("the message");
    await backend().forScope(a.scope).sign(message, ARN);
    sts = { status: 403, code: "AccessDenied" };
    const err = await backend()
      .forScope(a.scope)
      .sign(message, ARN)
      .catch((e: Error) => e);
    const rows = await audit();
    const text = JSON.stringify(rows) + (err as Error).message;
    for (const secret of [SECRET_KEY, SESSION, ...tokens]) expect(text).not.toContain(secret);
    const ok = rows.find((x) => x.op === "kms_sign" && x.outcome === "ok")!;
    expect(JSON.stringify(ok)).toContain(ARN);
    expect(JSON.stringify(ok)).toContain(crypto.createHash("sha256").update(message).digest("hex"));
  });

  test("a key with no entry is refused, and an incident freeze stops the token", async () => {
    await expect(backend({}).forScope(a.scope).sign(Buffer.from("m"), ARN)).rejects.toMatchObject({
      kind: "kms_denied",
    });
    await setFreeze(db, a.scope, { by: "test", reason: "test", now });
    await expect(backend().forScope(a.scope).sign(Buffer.from("m"), ARN)).rejects.toMatchObject({
      kind: "sts_denied",
    });
    expect(stsCalls).toBe(0);
  });

  test("the setting refuses a key ARN in another region than its entry", () => {
    const rt = createSettingsRuntime(settingsRegistry, {
      TURNTABLE_AWS_KMS_KEYS: JSON.stringify({
        [ARN]: { role_arn: ROLE, region: "eu-west-1", public_key_fingerprint: pin.keyid },
      }),
    });
    const def = rt.registry.get("aws_kms_keys")!;
    expect(def.type.safeParse(JSON.parse(rt.env.TURNTABLE_AWS_KMS_KEYS!)).success).toBe(false);
  });
});
