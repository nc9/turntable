import { beforeEach, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import {
  AwsKmsSigner,
  LocalSigner,
  PAYLOAD_TYPE,
  type KeyVault,
  type Signer,
  verifyArtifact,
  verifyEnvelope,
  sha256Hex,
} from "@longshore/signer";
import {
  ArtifactConflict,
  ArtifactScopeError,
  createProject,
  createAttempt,
  createJob,
  createRun,
  type Db,
  getProjectSigning,
  getSecretRecord,
  listAudit,
  listRunArtifacts,
  recordArtifact,
  setProjectSigning,
  setRunStatus,
} from "../src/db";
import * as s from "../src/db/schema";
import {
  type ApprovalVerifier,
  denyAllApprovals,
  parseKeyRef,
  secretStoreVault,
  SigningService,
} from "../src/signing";
import { eq } from "drizzle-orm";
import { SecretStore } from "../src/secrets/store";
import { seedWorld, type Tenant } from "./ops-helpers";

const BINARY = Buffer.from("the release binary");
const SHA = "a".repeat(40);

let db: Db;
let a: Tenant;
let b: Tenant;
let vault: KeyVault;
let local: LocalSigner;
let signCalls: number;
let spy: Signer;
const person = (name: string) => ({
  approverId: `ap-${name}`,
  person: name,
  method: "ed25519" as const,
  statementHash: "s".repeat(64),
  approvedAt: 1,
  expiresAt: 2,
});
const approve: ApprovalVerifier = {
  verify: async (_s, environment) => ({
    approved: true,
    environment,
    required: 2,
    approvals: [person("alice"), person("bob")],
  }),
};

beforeEach(async () => {
  ({ db, a, b } = await seedWorld());
  const map = new Map<string, string>();
  vault = { get: async (n) => map.get(n), set: async (n, v) => void map.set(n, v) };
  local = new LocalSigner(vault);
  await local.ensureKey("release");
  signCalls = 0;
  spy = {
    publicKey: (r) => local.publicKey(r),
    sign: async (m, r) => {
      signCalls++;
      return local.sign(m, r);
    },
  };
  await setProjectSigning(db, a.scope, { signingKey: "builtin:release" });
});

/** A finished release run with a stored plan and a recorded artifact. */
async function releaseRun(
  over: { klass?: string; ref?: string; status?: "success" | "failure"; record?: boolean } = {},
) {
  const run = await createRun(db, a.scope, {
    workflowPath: ".github/workflows/release.yml",
    event: "push",
    ref: over.ref ?? "refs/tags/v1.2.3",
    sha: SHA,
    repo: "acme/web",
    trust: JSON.stringify({
      class: over.klass ?? "release",
      reasons: [],
      facts: {},
      workflowHash: "h",
      decidedAt: 1,
    }),
  });
  const job = (await createJob(db, a.scope, { runId: run.id, jobKey: "build", name: "build" }))!;
  const attempt = (await createAttempt(db, a.scope, { jobId: job.id, provider: "test" }))!;
  await db.orm
    .update(s.jobAttempts)
    .set({
      plan: JSON.stringify({
        actions: [
          {
            uses: "actions/checkout@v4",
            repo: "actions/checkout",
            ref: "v4",
            sha: "c".repeat(40),
            kind: "checkout",
          },
          {
            uses: "oven-sh/setup-bun@v2",
            repo: "oven-sh/setup-bun",
            ref: "v2",
            sha: "b".repeat(40),
            kind: "remote",
          },
        ],
      }),
    })
    .where(eq(s.jobAttempts.id, attempt.id));
  await setRunStatus(db, a.scope, run.id, "running");
  await setRunStatus(db, a.scope, run.id, over.status ?? "success");
  if (over.record !== false) {
    await recordArtifact(db, a.scope, {
      runId: run.id,
      attemptId: attempt.id,
      name: "longshore-linux-x64",
      sha256: sha256Hex(BINARY),
      size: BINARY.length,
    });
    await recordArtifact(db, a.scope, {
      runId: run.id,
      attemptId: attempt.id,
      name: "sbom.json",
      sha256: "d".repeat(64),
      size: 10,
    });
  }
  return Object.assign(run, { attemptId: attempt.id });
}

const service = (
  approvals: ApprovalVerifier = approve,
  signers: ConstructorParameters<typeof SigningService>[0]["signers"] = { builtin: spy },
) => new SigningService({ db, signers, approvals, builderId: "https://ci.example.test/longshore" });
const req = (runId: string, artifacts = ["longshore-linux-x64"]) => ({
  runId,
  artifacts,
  environment: "production",
});
const denials = async (): Promise<string[]> =>
  (await listAudit(db, a.scope)).filter((x) => x.op === "sign_release").map((x) => x.outcome);

describe("what is signed", () => {
  test("a release run's recorded artifact is signed, with provenance from what the server stored", async () => {
    const run = await releaseRun();
    const out = await service().signRelease(a.scope, req(run.id));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const key = await local.publicKey("release");
    const v = verifyArtifact({
      artifact: BINARY,
      envelope: out.envelope,
      publicKeyPem: key.publicKeyPem,
    });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const p = v.statement.predicate;
    expect(v.statement.subject).toEqual([
      { name: "longshore-linux-x64", digest: { sha256: sha256Hex(BINARY) } },
    ]);
    expect(p.buildDefinition.externalParameters).toMatchObject({
      workflow: ".github/workflows/release.yml",
      ref: "refs/tags/v1.2.3",
      sha: SHA,
      event: "push",
    });
    expect(
      p.buildDefinition.resolvedDependencies.map((d) => [d.name, d.digest.gitCommit.slice(0, 1)]),
    ).toEqual([
      ["source", "a"],
      ["actions/checkout@v4", "c"],
      ["oven-sh/setup-bun@v2", "b"],
    ]);
    expect(p.runDetails.builder.id).toBe("https://ci.example.test/longshore");
    expect(p.runDetails.metadata.invocationId).toBe(run.id);
    // The recorded artifact that was not asked for is a byproduct.
    expect(p.runDetails.byproducts).toEqual([
      { name: "sbom.json", digest: { sha256: "d".repeat(64) } },
    ]);
    expect(signCalls).toBe(1);
  });

  test("the signature is audited with the key id and digests, never key material", async () => {
    const run = await releaseRun();
    const out = await service().signRelease(a.scope, req(run.id));
    const rows = (await listAudit(db, a.scope)).filter((x) => x.op === "sign_release");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).toBe("ok");
    expect(rows[0]!.input).toContain(sha256Hex(BINARY));
    expect(rows[0]!.input).toContain(out.ok ? out.keyid : "?");
    expect(rows[0]!.input).not.toContain("PRIVATE");
    expect(rows[0]!.principalId).toBe("signing-service");
  });

  test("a caller supplies a run and names, never a digest: an unrecorded name is refused", async () => {
    const run = await releaseRun();
    const out = await service().signRelease(
      a.scope,
      req(run.id, ["longshore-linux-x64", "not-recorded"]),
    );
    expect(out).toEqual({ ok: false, reason: "artifact_not_recorded", detail: "not-recorded" });
    expect(signCalls).toBe(0);
    const none = await releaseRun({ record: false });
    expect(await service().signRelease(a.scope, req(none.id))).toMatchObject({
      ok: false,
      reason: "artifact_not_recorded",
    });
    expect(await service().signRelease(a.scope, req(none.id, []))).toMatchObject({
      ok: false,
      reason: "no_artifacts",
    });
  });
});

describe("policy refusals (nothing reaches the signer)", () => {
  test.each([
    ["wrong class: a trusted pull request", { klass: "trusted_pr" }, "not_release_class"],
    ["wrong class: a protected branch run", { klass: "protected" }, "not_release_class"],
    [
      "wrong ref: a branch, whatever the class",
      { ref: "refs/heads/main" },
      "ref_not_a_release_ref",
    ],
    ["wrong ref: a tag outside the pattern", { ref: "refs/tags/nightly" }, "ref_not_a_release_ref"],
    ["a run that did not succeed", { status: "failure" as const }, "run_not_successful"],
  ])("%s", async (_name, over, reason) => {
    const run = await releaseRun(over);
    const out = await service().signRelease(a.scope, req(run.id));
    expect(out).toMatchObject({ ok: false, reason });
    expect(signCalls).toBe(0);
    expect(await denials()).toContain(`denied:${reason}`);
  });

  test("no approval: the default verifier denies, so nothing is signed", async () => {
    const run = await releaseRun();
    expect(await service(denyAllApprovals).signRelease(a.scope, req(run.id))).toMatchObject({
      ok: false,
      reason: "no_approval",
    });
    expect(signCalls).toBe(0);
  });

  test("the approval is asked for exactly this org, project, run, sha, workflow hash and environment", async () => {
    const run = await releaseRun();
    const asked: unknown[] = [];
    const out = await service({
      verify: async (subject, env) => {
        asked.push({ ...subject, env });
        return {
          approved: false,
          environment: env,
          required: 2,
          have: 1,
          reason: "insufficient_approvals",
        };
      },
    }).signRelease(a.scope, req(run.id));
    expect(out).toMatchObject({ ok: false, reason: "no_approval" });
    expect(asked).toEqual([
      {
        orgId: a.orgId,
        projectId: a.projectId,
        runId: run.id,
        headSha: SHA,
        workflowHash: "h",
        env: "production",
      },
    ]);
    expect(signCalls).toBe(0);
  });

  test("a run whose trust decision has no workflow hash is refused, and the verifier is not asked", async () => {
    const run = await releaseRun();
    await db.orm
      .update(s.runs)
      .set({ trust: JSON.stringify({ class: "release" }) })
      .where(eq(s.runs.id, run.id));
    let asked = 0;
    const out = await service({
      verify: async (subject, env) => {
        asked++;
        return approve.verify(subject, env);
      },
    }).signRelease(a.scope, req(run.id));
    // Its class cannot be read from an incomplete decision, so it is not a release run at all.
    expect(out).toMatchObject({ ok: false, reason: "not_release_class" });
    expect(asked).toBe(0);
    expect(signCalls).toBe(0);
  });

  test("the approvers' names are in the audit record", async () => {
    const run = await releaseRun();
    await service().signRelease(a.scope, req(run.id));
    const rows = (await listAudit(db, a.scope)).filter((x) => x.op === "sign_release");
    expect(rows[0]!.input).toContain("alice");
    expect(rows[0]!.input).toContain("bob");
  });

  test("a project with no signing key, and a key naming a backend the instance lacks, cannot sign", async () => {
    const run = await releaseRun();
    await setProjectSigning(db, a.scope, { signingKey: null });
    expect(await service().signRelease(a.scope, req(run.id))).toMatchObject({
      ok: false,
      reason: "no_signing_key",
    });
    await setProjectSigning(db, a.scope, {
      signingKey: "gcp-kms:projects/p/locations/l/keyRings/r/cryptoKeys/k/cryptoKeyVersions/1",
    });
    expect(await service().signRelease(a.scope, req(run.id))).toMatchObject({
      ok: false,
      reason: "no_backend",
    });
    expect(signCalls).toBe(0);
  });

  test("a run of another org or project is not found", async () => {
    const run = await releaseRun();
    expect(await service().signRelease(b.scope, req(run.id))).toEqual({
      ok: false,
      reason: "unknown_run",
    });
    expect(await service().signRelease(a.scope, req("01NOSUCHRUN"))).toEqual({
      ok: false,
      reason: "unknown_run",
    });
    expect(signCalls).toBe(0);
  });

  test("a project's release refs are its own setting, and the default is the v-tag pattern", async () => {
    const run = await releaseRun({ ref: "refs/heads/release/1.2" });
    expect(await service().signRelease(a.scope, req(run.id))).toMatchObject({
      ok: false,
      reason: "ref_not_a_release_ref",
    });
    await setProjectSigning(db, a.scope, { releaseRefs: ["refs/heads/release/*"] });
    expect((await service().signRelease(a.scope, req(run.id))).ok).toBe(true);
    expect((await getProjectSigning(db, a.scope)).releaseRefs).toEqual(["refs/heads/release/*"]);
    await setProjectSigning(db, a.scope, { releaseRefs: null });
    expect((await getProjectSigning(db, a.scope)).releaseRefs).toEqual(["refs/tags/v*"]);
  });

  test("a refusal is audited with its reason", async () => {
    const run = await releaseRun({ klass: "trusted_pr" });
    await service().signRelease(a.scope, req(run.id));
    expect(await denials()).toEqual(["denied:not_release_class"]);
  });
});

describe("backends", () => {
  test("a key reference names its backend", () => {
    expect(parseKeyRef("builtin:release")).toEqual({ backend: "builtin", keyRef: "release" });
    expect(parseKeyRef("aws-kms:arn:aws:kms:us-east-1:123456789012:key/x")).toEqual({
      backend: "aws-kms",
      keyRef: "arn:aws:kms:us-east-1:123456789012:key/x",
    });
    for (const bad of ["release", ":x", "vault:x", "builtin:", ""])
      expect(parseKeyRef(bad)).toBeUndefined();
  });

  test("a KMS-backed project signs through the KMS request path, and the envelope verifies", async () => {
    const pair = crypto.generateKeyPairSync("ed25519");
    const calls: string[] = [];
    const aws = new AwsKmsSigner({
      region: "us-east-1",
      credentials: async () => ({
        accessKeyId: "ASIATESTKEY12345678",
        secretAccessKey: "x".repeat(40),
        sessionToken: "tok",
      }),
      fetch: async (_url, init) => {
        const target = new Headers(init?.headers).get("x-amz-target")!;
        calls.push(target);
        if (target.endsWith("GetPublicKey")) {
          return Response.json({
            PublicKey: (pair.publicKey.export({ type: "spki", format: "der" }) as Buffer).toString(
              "base64",
            ),
          });
        }
        const body = JSON.parse(init!.body as string) as { Message: string };
        return Response.json({
          Signature: crypto
            .sign(null, Buffer.from(body.Message, "base64"), pair.privateKey)
            .toString("base64"),
        });
      },
    });
    const key = "arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789012";
    await setProjectSigning(db, a.scope, { signingKey: `aws-kms:${key}` });
    const run = await releaseRun();
    const out = await service(approve, { "aws-kms": aws }).signRelease(a.scope, req(run.id));
    expect(out.ok).toBe(true);
    expect(calls).toEqual(
      ["TrentService.GetPublicKey", "TrentService.Sign", "TrentService.GetPublicKey"].filter(
        (c, i) => i < calls.length,
      ),
    );
    if (out.ok) {
      const pem = pair.publicKey.export({ type: "spki", format: "pem" }) as string;
      expect(verifyEnvelope(out.envelope, pem).ok).toBe(true);
      expect(out.envelope.payloadType).toBe(PAYLOAD_TYPE);
    }
  });
});

describe("the built-in key", () => {
  test("it is sealed in the secret store: the stored record holds no readable private key", async () => {
    const store = new SecretStore(db, crypto.randomBytes(32));
    const signer = new LocalSigner(secretStoreVault(store, a.orgId));
    const key = await signer.ensureKey("release2");
    expect(await store.has(a.orgId, "signing/release2")).toBe(true);
    const record = await getSecretRecord(db, { orgId: a.orgId }, "signing/release2");
    expect(JSON.stringify(record)).not.toContain("PRIVATE KEY");
    // Another org cannot read it, and it signs only for the org that owns it.
    expect(await store.has(b.orgId, "signing/release2")).toBe(false);
    const sig = await signer.sign(Buffer.from("m"), "release2");
    const pub = crypto.createPublicKey(key.publicKeyPem);
    expect(crypto.verify(null, Buffer.from("m"), pub, Buffer.from(sig))).toBe(true);
  });
});

describe("the artifact store", () => {
  test("a name is recorded once per run: the same digest is idempotent, another digest is refused", async () => {
    const run = await releaseRun({ record: false });
    const attemptId = run.attemptId;
    const first = await recordArtifact(db, a.scope, {
      runId: run.id,
      attemptId,
      name: "x.bin",
      sha256: "e".repeat(64),
      size: 1,
    });
    const again = await recordArtifact(db, a.scope, {
      runId: run.id,
      attemptId,
      name: "x.bin",
      sha256: "e".repeat(64),
      size: 1,
    });
    expect(again.id).toBe(first.id);
    await expect(
      recordArtifact(db, a.scope, {
        runId: run.id,
        attemptId,
        name: "x.bin",
        sha256: "f".repeat(64),
        size: 1,
      }),
    ).rejects.toBeInstanceOf(ArtifactConflict);
    expect((await listRunArtifacts(db, a.scope, run.id)).map((x) => x.sha256)).toEqual([
      "e".repeat(64),
    ]);
  });

  test("a digest or a name that is not well formed is refused", async () => {
    const run = await releaseRun({ record: false });
    for (const sha of ["short", "E".repeat(64), "g".repeat(64)]) {
      await expect(
        recordArtifact(db, a.scope, {
          runId: run.id,
          attemptId: "x",
          name: "ok",
          sha256: sha,
          size: 1,
        }),
      ).rejects.toThrow();
    }
    for (const name of ["", "../x", "a b", "x".repeat(300)]) {
      await expect(
        recordArtifact(db, a.scope, {
          runId: run.id,
          attemptId: "x",
          name,
          sha256: "e".repeat(64),
          size: 1,
        }),
      ).rejects.toThrow();
    }
  });

  test("an attempt or run from another org, another project, or another run is refused", async () => {
    const run = await releaseRun({ record: false });
    const other = await releaseRun({ record: false });
    const rec = (scope: Required<typeof a.scope>, runId: string, attemptId: string) =>
      recordArtifact(db, scope, {
        runId,
        attemptId,
        name: "x.bin",
        sha256: "e".repeat(64),
        size: 1,
      });
    // Another org's attempt id, under this org's run.
    await expect(rec(a.scope, run.id, b.attemptId)).rejects.toBeInstanceOf(ArtifactScopeError);
    // This org's run, recorded from another org's scope.
    await expect(rec(b.scope, run.id, run.attemptId)).rejects.toBeInstanceOf(ArtifactScopeError);
    // Another project of the same org: the run and attempt exist, but not in that project.
    const p2 = await createProject(db, { orgId: a.orgId }, { slug: "second", name: "Second" });
    const scope2 = { orgId: a.orgId, projectId: p2.id };
    await expect(rec(scope2, run.id, run.attemptId)).rejects.toBeInstanceOf(ArtifactScopeError);
    // An attempt of a different run of the same project.
    await expect(rec(a.scope, run.id, other.attemptId)).rejects.toBeInstanceOf(ArtifactScopeError);
    // Nothing was recorded by any of them.
    expect(await listRunArtifacts(db, a.scope, run.id)).toEqual([]);
    expect(await rec(a.scope, run.id, run.attemptId)).toMatchObject({ name: "x.bin" });
  });

  test("the database itself refuses a row that points across tenants", async () => {
    const run = await releaseRun({ record: false });
    const row = {
      id: "01X",
      projectId: a.projectId,
      runId: run.id,
      attemptId: b.attemptId,
      name: "n",
      sha256: "e".repeat(64),
      size: 1,
    };
    // Skipping the repo: another org's attempt id under this org's own run and project.
    const insert = async (values: typeof row & { orgId: string }): Promise<void> => {
      await db.orm.insert(s.artifacts).values(values);
    };
    await expect(insert({ ...row, orgId: a.orgId })).rejects.toThrow();
    // And a run id from another org.
    await expect(
      insert({ ...row, id: "01Y", orgId: a.orgId, runId: b.runId, attemptId: run.attemptId }),
    ).rejects.toThrow();
  });

  test("the store has no way to change or remove a recorded artifact", async () => {
    const repos = await import("../src/db/repos/artifacts");
    expect(
      Object.keys(repos).filter(
        (k) => /update|delete|remove|set(?!ProjectSigning)/i.test(k) && k !== "setProjectSigning",
      ),
    ).toEqual([]);
  });
});
