// The shape of the `aws_kms_keys` setting: one map per org, keyed by KMS key ARN. Pure (no
// database), so the registry and the backend share it. Nothing here is a secret: an ARN, a role
// ARN, a region, an audience and the fingerprint (a public hash) of the key's public half.
import { z } from "zod";

export const DEFAULT_AWS_KMS_AUDIENCE = "sts.amazonaws.com";

const KEY_ARN = /^arn:aws:kms:([a-z]{2}(?:-[a-z]+)+-\d):\d{12}:key\/[0-9a-f-]{36}$/;

export const awsKmsKeyEntry = z.strictObject({
  /** The role `sts:AssumeRoleWithWebIdentity` assumes. Allowed only Sign and GetPublicKey on the key. */
  role_arn: z.string().regex(/^arn:aws:iam::\d{12}:role\/[\w+=,.@/-]{1,512}$/),
  region: z.string().regex(/^[a-z]{2}(-[a-z]+)+-\d$/),
  /** The `aud` of the OIDC token. The IAM provider's client id. */
  audience: z
    .string()
    .regex(/^[\x21-\x7e]{1,256}$/)
    .default(DEFAULT_AWS_KMS_AUDIENCE),
  /** Hex sha256 of the key's SPKI DER (the keyid its envelopes carry). Any other key is refused. */
  public_key_fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
});

export const awsKmsKeyMap = z.record(z.string(), awsKmsKeyEntry).superRefine((map, ctx) => {
  for (const [arn, e] of Object.entries(map)) {
    const m = KEY_ARN.exec(arn);
    if (!m) ctx.addIssue({ code: "custom", message: `not a KMS key ARN: ${arn}`, path: [arn] });
    else if (m[1] !== e.region) {
      ctx.addIssue({ code: "custom", message: "the key ARN is in another region", path: [arn] });
    }
  }
});

export type AwsKmsKeyMap = z.infer<typeof awsKmsKeyMap>;
export type AwsKmsKeyEntry = z.infer<typeof awsKmsKeyEntry>;

/** What a change repoints: a different role, audience, region or key pin is a different trust. */
export function awsKmsKeysLoosening(before: AwsKmsKeyMap, after: AwsKmsKeyMap): string[] {
  const out: string[] = [];
  for (const [arn, a] of Object.entries(after)) {
    const b = before[arn];
    if (!b) continue;
    for (const f of ["role_arn", "audience", "region", "public_key_fingerprint"] as const) {
      if (a[f] !== b[f]) out.push(`${arn}: ${f} changed`);
    }
  }
  return out;
}
