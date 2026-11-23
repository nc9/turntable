// The `aws-kms` backend: the release lane signs with a P-256 KMS key it reaches through an OIDC
// web identity, with no long-lived cloud key anywhere. Per sign: a release-lane token from the
// org's issuer (sub `turntable:release:<org>/<project>`, never a job), `AssumeRoleWithWebIdentity`
// into the configured role, then `kms:Sign` over the digest. Credentials are cached in memory
// (the signer package) and never logged or audited; the audit records the key ARN and digest.
import crypto from "node:crypto";
import {
  type AwsCredentials,
  AwsKmsP256Signer,
  AwsSignerError,
  type Signer,
  webIdentityCredentials,
} from "@turntable/signer";
import type { SafeFetch } from "@turntable/net";
import type { Db } from "../db";
import { appendAudit, getOrgById, type Scope } from "../db/repos";
import type { ReleaseMintResult } from "../oidc/issuer";
import { ambientSettings } from "../settings/ambient";
import { resolveSetting, type SettingsRuntime } from "../settings/resolve";
import { type AwsKmsKeyEntry, type AwsKmsKeyMap, awsKmsKeyMap } from "./aws-kms-setting";

export interface ReleaseTokenSource {
  mintRelease(req: {
    orgId: string;
    projectId: string;
    audience: unknown;
  }): Promise<ReleaseMintResult>;
}

export interface AwsKmsBackendOptions {
  db: Db;
  tokens: ReleaseTokenSource;
  settings?: SettingsRuntime;
  fetch?: SafeFetch;
  /** Test seams. */
  stsEndpoint?: string;
  kmsEndpoint?: string;
  now?: () => number;
}

interface Bound {
  signer: AwsKmsP256Signer;
  credentials: () => Promise<AwsCredentials>;
}

export class AwsKmsBackend {
  readonly #o: AwsKmsBackendOptions;
  readonly #bound = new Map<string, Bound>();

  constructor(o: AwsKmsBackendOptions) {
    this.#o = o;
  }

  async #entry(scope: Required<Scope>, keyRef: string): Promise<AwsKmsKeyEntry> {
    const org = await getOrgById(this.#o.db, scope.orgId);
    const r = await resolveSetting(
      this.#o.settings ?? ambientSettings(),
      this.#o.db,
      "aws_kms_keys",
      { orgId: scope.orgId, ...(org ? { orgSlug: org.slug } : {}) },
    );
    const entry = (awsKmsKeyMap.parse(r.value) as AwsKmsKeyMap)[keyRef];
    if (!entry) throw new AwsSignerError("kms_denied", "the key has no aws_kms_keys entry");
    return entry;
  }

  async #bind(scope: Required<Scope>, keyRef: string): Promise<Bound> {
    const e = await this.#entry(scope, keyRef);
    // A changed entry is a different binding: the old credentials are not reused.
    const id = JSON.stringify([scope.orgId, scope.projectId, keyRef, e]);
    let b = this.#bound.get(id);
    if (!b) {
      const credentials = webIdentityCredentials({
        region: e.region,
        roleArn: e.role_arn,
        durationSeconds: 900,
        token: async () => {
          const t = await this.#o.tokens.mintRelease({ ...scope, audience: e.audience });
          if (!t.ok) throw new AwsSignerError("sts_denied", `no release token: ${t.reason}`);
          return t.token;
        },
        ...(this.#o.fetch ? { fetch: this.#o.fetch } : {}),
        ...(this.#o.stsEndpoint ? { endpoint: this.#o.stsEndpoint } : {}),
        ...(this.#o.now ? { now: this.#o.now } : {}),
      });
      b = {
        credentials,
        signer: new AwsKmsP256Signer({
          region: e.region,
          credentials,
          pinnedKeyId: e.public_key_fingerprint,
          ...(this.#o.fetch ? { fetch: this.#o.fetch } : {}),
          ...(this.#o.kmsEndpoint ? { endpoint: this.#o.kmsEndpoint } : {}),
          ...(this.#o.now ? { now: this.#o.now } : {}),
        }),
      };
      this.#bound.set(id, b);
    }
    return b;
  }

  #audit(scope: Required<Scope>, outcome: string, input: Record<string, unknown>): Promise<void> {
    return appendAudit(this.#o.db, scope, {
      principalKind: "system",
      principalId: "signing-service",
      op: "kms_sign",
      effect: "use",
      outcome,
      input,
    });
  }

  /** The signer for one project's run: the token's subject names this org and project. */
  forScope(scope: Required<Scope>): Signer {
    return {
      publicKey: async (keyRef) => (await this.#bind(scope, keyRef)).signer.publicKey(keyRef),
      sign: async (message, keyRef) => {
        const digest = crypto.createHash("sha256").update(message).digest("hex");
        try {
          const sig = await (await this.#bind(scope, keyRef)).signer.sign(message, keyRef);
          await this.#audit(scope, "ok", { keyArn: keyRef, digest });
          return sig;
        } catch (e) {
          const kind = e instanceof AwsSignerError ? e.kind : "network";
          await this.#audit(scope, `error:${kind}`, { keyArn: keyRef, digest });
          throw e;
        }
      },
    };
  }
}
