// Release approval statement v2 (#424): a human approves the digest of the artifacts the release
// lane will sign, and the signing service refuses any other set, or a second signature.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  createHash,
  createSign,
  generateKeyPairSync,
  randomBytes,
  type KeyObject,
} from "node:crypto";
import { eq } from "drizzle-orm";
import { LocalSigner, sha256Hex, type KeyVault } from "@turntable/signer";
import { canonicalJson } from "../src/audit/chain";
import { generateEd25519, signEd25519 } from "../src/approvals/keys";
import {
  ENV_STATEMENT_TYPE,
  RELEASE_STATEMENT_TYPE,
  statementHash,
} from "../src/approvals/statement";
import { createApprovalVerifier, type ReleaseApprovalVerifier } from "../src/approvals/verifier";
import { verifyRegistration, type RelyingParty } from "../src/approvals/webauthn";
import {
  createAttempt,
  createOrg,
  createPolledRun,
  createProject,
  createRun,
  type Db,
  insertApprover,
  listAudit,
  openDatabase,
  recordArtifact,
  setEnvPolicy,
  setKeyPolicy,
  setProjectSigning,
  setRunStatus,
  type Scope,
} from "../src/db";
import * as s from "../src/db/schema";
import { manifestSha256, manifestText, ManifestError } from "../src/release/manifest";
import { dispatch, type DispatchEnv, registry } from "../src/ops";
import { builtinKeyRef, SigningService } from "../src/signing";
import { mintToken } from "./ops-helpers";

// ---- a minimal software WebAuthn authenticator ----

const RP: RelyingParty = { rpId: "ci.example.com", origins: ["https://ci.example.com"] };
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest();
const head = (major: number, n: number): Buffer =>
  n < 24
    ? Buffer.from([(major << 5) | n])
    : n < 256
      ? Buffer.from([(major << 5) | 24, n])
      : Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
const cint = (n: number) => (n >= 0 ? head(0, n) : head(1, -1 - n));
const cbytes = (b: Buffer) => Buffer.concat([head(2, b.length), b]);
const ctext = (t: string) => Buffer.concat([head(3, Buffer.byteLength(t)), Buffer.from(t)]);
const cmap = (pairs: [Buffer, Buffer][]) => Buffer.concat([head(5, pairs.length), ...pairs.flat()]);

function softPasskey() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
  const credentialId = randomBytes(32);
  let counter = 0;
  return {
    credentialId,
    register(challenge: string) {
      const clientData = Buffer.from(
        JSON.stringify({ type: "webauthn.create", challenge, origin: RP.origins[0] }),
      );
      const cose = cmap([
        [cint(1), cint(2)],
        [cint(3), cint(-7)],
        [cint(-1), cint(1)],
        [cint(-2), cbytes(Buffer.from(jwk.x, "base64url"))],
        [cint(-3), cbytes(Buffer.from(jwk.y, "base64url"))],
      ]);
      const idLen = Buffer.alloc(2);
      idLen.writeUInt16BE(credentialId.length);
      const authData = Buffer.concat([
        sha(RP.rpId),
        Buffer.from([0x01 | 0x04 | 0x40]),
        Buffer.alloc(4),
        Buffer.alloc(16),
        idLen,
        credentialId,
        cose,
      ]);
      const att = cmap([
        [ctext("fmt"), ctext("none")],
        [ctext("attStmt"), cmap([])],
        [ctext("authData"), cbytes(authData)],
      ]);
      return {
        clientDataJSON: clientData.toString("base64url"),
        attestationObject: att.toString("base64url"),
      };
    },
    assert(challenge: string) {
      counter += 1;
      const clientData = Buffer.from(
        JSON.stringify({ type: "webauthn.get", challenge, origin: RP.origins[0] }),
      );
      const c = Buffer.alloc(4);
      c.writeUInt32BE(counter);
      const authData = Buffer.concat([sha(RP.rpId), Buffer.from([0x01 | 0x04]), c]);
      const sig = createSign("sha256")
        .update(Buffer.concat([authData, sha(clientData)]))
        .sign(privateKey as KeyObject);
      return {
        kind: "webauthn" as const,
        credential_id: credentialId.toString("base64url"),
        client_data_json: clientData.toString("base64url"),
        authenticator_data: authData.toString("base64url"),
        signature: sig.toString("base64url"),
      };
    },
  };
}

// ---- world ----

const WF_HASH = "ab".repeat(32);
const SHA = "c".repeat(40);
const BINARY = Buffer.from("the release binary");
const CHECKSUMS = Buffer.from("the checksums file");
const FILES = { "cli-linux": BINARY, SHA256SUMS: CHECKSUMS };
const NAMES = Object.keys(FILES);

let db: Db;
let orgId: string;
let scope: Required<Scope>;
let env: DispatchEnv;
let operatorTok: string;
let local: LocalSigner;
let service: SigningService;

type Person = { id: string; priv: string };
async function edApprover(person: string): Promise<Person> {
  const k = generateEd25519();
  const a = await insertApprover(
    db,
    orgId,
    {
      person,
      forgeLogin: `${person}-gh`,
      kind: "ed25519",
      publicKey: k.publicSpki,
      alg: "EdDSA",
      createdBy: "test",
    },
    Date.now(),
  );
  return { id: a.id, priv: k.privatePem };
}

/** A release run (tag, class release) whose one job waits on `environment`, with recorded artifacts. */
async function mkRun(
  o: { environment?: string; files?: Record<string, Buffer>; actor?: string; sha?: string } = {},
) {
  const environment = o.environment ?? "release";
  const planned = {
    key: "publish",
    id: "publish",
    name: "publish",
    needs: [],
    needsIds: [],
    environment,
    continueOnError: false,
    outputs: {},
    failFast: true,
  };
  const res = await createPolledRun(db, scope, {
    repo: "acme/web",
    provider: "test",
    run: {
      workflowPath: ".github/workflows/release.yml",
      event: "push",
      ref: "refs/tags/v1.2.3",
      sha: o.sha ?? SHA,
      actor: o.actor ?? "octo",
      trust: JSON.stringify({ class: "release", workflowHash: WF_HASH }),
    },
    jobs: [{ key: "publish", name: "publish", needs: [], planned }],
  });
  const runId = res!.run.id;
  const job = (await db.orm.query.jobs.findFirst({ where: (j, { eq: e }) => e(j.runId, runId) }))!;
  const attempt = (await createAttempt(db, scope, { jobId: job.id, provider: "test" }))!;
  await db.orm
    .update(s.jobAttempts)
    .set({ trustClass: "release" })
    .where(eq(s.jobAttempts.id, attempt.id));
  for (const [name, bytes] of Object.entries(o.files ?? FILES)) {
    await recordArtifact(db, scope, {
      runId,
      attemptId: attempt.id,
      name,
      sha256: sha256Hex(bytes),
      size: bytes.length,
    });
  }
  return { runId, jobId: job.id, attemptId: attempt.id };
}

async function ok<T = any>(op: string, input: unknown): Promise<T> {
  const r = await dispatch(env, { kind: "bearer", token: operatorTok }, op, input);
  if (!r.ok) throw new Error(`${op}: ${r.error.code} ${r.error.message}`);
  return r.output as T;
}
const challenge = (runId: string, approver: string, extra: Record<string, unknown> = {}) =>
  ok("release_approval_challenge", { run_id: runId, approver, project: "web", ...extra });
const approve = (statement: unknown, signature: unknown) =>
  dispatch(env, { kind: "signed" }, "approve_release", { statement, signature });
const edSign = (p: Person, c: { canonical: string }) => ({
  kind: "ed25519",
  signature: signEd25519(p.priv, c.canonical),
});

/** Approves with a fresh ed25519 key; returns the challenge it signed. */
async function approveAs(person: string, runId: string, extra: Record<string, unknown> = {}) {
  const p = await edApprover(person);
  const c = await challenge(runId, p.id, extra);
  const r = await approve(c.statement, edSign(p, c));
  if (!r.ok) throw new Error(`approve_release: ${r.error.code} ${r.error.message}`);
  return { p, c, out: r.output as { released_jobs: number; approvals: number } };
}

async function finish(runId: string) {
  await setRunStatus(db, scope, runId, "running");
  await setRunStatus(db, scope, runId, "success");
}
const sign = (runId: string, artifacts: string[] = NAMES) =>
  service.signRelease(scope, { runId, artifacts });
const denials = async () =>
  (await listAudit(db, scope)).filter((x) => x.op === "sign_release").map((x) => x.outcome);
const failure = async (p: ReturnType<typeof approve>) => {
  const r = await p;
  if (r.ok) throw new Error("expected a refusal");
  return `${r.error.code}: ${r.error.message}`;
};

beforeEach(async () => {
  db = openDatabase(":memory:");
  const org = await createOrg(db, { slug: "acme", name: "Acme" });
  const project = await createProject(db, { orgId: org.id }, { slug: "web", name: "Web" });
  orgId = org.id;
  scope = { orgId, projectId: project.id };
  // A real-minted token and the real clock: nothing here uses a fixed epoch.
  env = { registry, db, webauthn: RP };
  operatorTok = (await mintToken(db, { orgId }, "operator")).secret;
  await setProjectSigning(db, scope, { signingKey: "builtin:release", environment: "release" });
  for (const environment of ["release", "production"]) {
    await setEnvPolicy(db, orgId, {
      environment,
      required: 1,
      allowAuthorApproval: false,
      by: "test",
      now: Date.now(),
    });
  }
  const map = new Map<string, string>();
  const vault: KeyVault = { get: async (n) => map.get(n), set: async (n, v) => void map.set(n, v) };
  local = new LocalSigner(vault);
  await local.ensureKey(builtinKeyRef(orgId, "release"));
  service = new SigningService({
    db,
    signers: { builtin: local },
    approvals: createApprovalVerifier(db, { rp: RP }),
    builderId: "https://ci.example.test/turntable",
  });
});

afterEach(() => {});

// ---- the canonical digest ----

describe("manifest_sha256", () => {
  const a = { name: "cli-linux", sha256: "a".repeat(64), size: 10 };
  const b = { name: "SHA256SUMS", sha256: "b".repeat(64), size: 5 };

  test("is sha256 over a documented, sorted, line-per-artifact text", () => {
    const text = `turntable.release_manifest.v1\n${b.sha256} 5 SHA256SUMS\n${a.sha256} 10 cli-linux\n`;
    expect(manifestText([a, b])).toBe(text);
    expect(manifestSha256([a, b])).toBe(createHash("sha256").update(text).digest("hex"));
  });

  test("does not depend on the order, and changes with a name, a digest or a size", () => {
    expect(manifestSha256([a, b])).toBe(manifestSha256([b, a]));
    const base = manifestSha256([a, b]);
    expect(manifestSha256([{ ...a, name: "cli-linux2" }, b])).not.toBe(base);
    expect(manifestSha256([{ ...a, sha256: "c".repeat(64) }, b])).not.toBe(base);
    expect(manifestSha256([{ ...a, size: 11 }, b])).not.toBe(base);
    expect(manifestSha256([a])).not.toBe(base);
  });

  test("refuses an empty set, a duplicate name, a bad digest, a bad size and an ambiguous name", () => {
    expect(() => manifestSha256([])).toThrow(ManifestError);
    expect(() => manifestSha256([a, a])).toThrow(ManifestError);
    expect(() => manifestSha256([{ ...a, sha256: "xyz" }])).toThrow(ManifestError);
    expect(() => manifestSha256([{ ...a, size: -1 }])).toThrow(ManifestError);
    expect(() => manifestSha256([{ ...a, size: 1.5 }])).toThrow(ManifestError);
    expect(() => manifestSha256([{ ...a, name: "two words" }])).toThrow(ManifestError);
    expect(() => manifestSha256([{ ...a, name: "line\nbreak" }])).toThrow(ManifestError);
  });
});

// ---- the flow ----

describe("approve, then sign the same manifest", () => {
  test("the challenge names the digest of the recorded artifacts, computed by the server", async () => {
    const { runId } = await mkRun();
    const p = await edApprover("alice");
    const c = await challenge(runId, p.id);
    expect(c.statement.type).toBe(RELEASE_STATEMENT_TYPE);
    expect(c.statement.environment).toBe("release");
    expect(c.statement.manifest_sha256).toBe(c.manifest_sha256);
    expect(c.manifest_sha256).toBe(manifestSha256(c.artifacts));
    expect(c.artifacts.map((x: { name: string }) => x.name).toSorted()).toEqual(NAMES.toSorted());
  });

  test("an approved manifest is signed once, and the audit row names the digest", async () => {
    const { runId } = await mkRun();
    const { c, out } = await approveAs("alice", runId);
    expect(out).toMatchObject({ released_jobs: 1, approvals: 1 });
    await finish(runId);
    const signed = await sign(runId);
    expect(signed.ok).toBe(true);
    const audit = (await listAudit(db, scope)).find(
      (x) => x.op === "sign_release" && x.outcome === "ok",
    )!;
    expect(JSON.stringify(audit.input)).toContain(c.manifest_sha256);
  });

  test("replay: a second signature of the same approval is refused as spent", async () => {
    const { runId } = await mkRun();
    await approveAs("alice", runId);
    await finish(runId);
    expect((await sign(runId)).ok).toBe(true);
    const again = await sign(runId);
    expect(again).toMatchObject({ ok: false, reason: "approval_spent" });
    expect(await denials()).toContain("denied:approval_spent");
  });

  test("a verifier without spend refuses to sign, fail closed, and nothing is signed", async () => {
    const { runId } = await mkRun();
    await approveAs("alice", runId);
    await finish(runId);
    const real = createApprovalVerifier(db, { rp: RP });
    const noSpend = new SigningService({
      db,
      signers: { builtin: local },
      // The type forbids it; a cast stands in for a wiring that got past it.
      approvals: { verify: real.verify.bind(real) } as unknown as ReleaseApprovalVerifier,
      builderId: "https://ci.example.test/turntable",
    });
    const out = await noSpend.signRelease(scope, { runId, artifacts: NAMES });
    expect(out).toMatchObject({ ok: false, reason: "approval_unspendable" });
    expect(await denials()).toContain("denied:approval_unspendable");
    expect(await denials()).not.toContain("ok");
    // The approval was not consumed: the real service can still sign it once.
    expect((await sign(runId)).ok).toBe(true);
  });

  test("two racing signatures: exactly one wins", async () => {
    const { runId } = await mkRun();
    await approveAs("alice", runId);
    await finish(runId);
    const results = await Promise.all([sign(runId), sign(runId)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toMatchObject({ reason: "approval_spent" });
  });

  test("replaying the signed statement itself is refused", async () => {
    const { runId } = await mkRun();
    const { p, c } = await approveAs("alice", runId);
    const r = await approve(c.statement, edSign(p, c));
    expect(r.ok).toBe(false);
  });

  test("a release request for a subset is a different digest, so it is refused", async () => {
    const { runId } = await mkRun();
    await approveAs("alice", runId);
    await finish(runId);
    expect(await sign(runId, ["cli-linux"])).toMatchObject({
      ok: false,
      reason: "manifest_mismatch",
    });
  });

  test("an approval for exactly a subset signs that subset", async () => {
    const { runId } = await mkRun();
    await approveAs("alice", runId, { artifacts: ["cli-linux"] });
    await finish(runId);
    expect((await sign(runId, ["cli-linux"])).ok).toBe(true);
  });
});

describe("a changed artifact", () => {
  test("a digest that changed after the approval is refused with a classified reason", async () => {
    const { runId } = await mkRun();
    await approveAs("alice", runId);
    await finish(runId);
    await db.orm
      .update(s.artifacts)
      .set({ sha256: sha256Hex(Buffer.from("something else")) })
      .where(eq(s.artifacts.name, "cli-linux"));
    expect(await sign(runId)).toMatchObject({ ok: false, reason: "manifest_mismatch" });
    expect(await denials()).toContain("denied:manifest_mismatch");
  });

  test("a size that changed after the approval is refused too", async () => {
    const { runId } = await mkRun();
    await approveAs("alice", runId);
    await finish(runId);
    await db.orm.update(s.artifacts).set({ size: 999 }).where(eq(s.artifacts.name, "SHA256SUMS"));
    expect(await sign(runId)).toMatchObject({ ok: false, reason: "manifest_mismatch" });
  });

  test("an artifact added to the run after the approval is refused when requested", async () => {
    const { runId, attemptId } = await mkRun();
    await approveAs("alice", runId);
    await finish(runId);
    await recordArtifact(db, scope, {
      runId,
      attemptId,
      name: "extra.bin",
      sha256: sha256Hex(Buffer.from("extra")),
      size: 5,
    });
    expect(await sign(runId, [...NAMES, "extra.bin"])).toMatchObject({
      ok: false,
      reason: "manifest_mismatch",
    });
  });

  test("the challenge is refused while no artifact is recorded", async () => {
    const { runId } = await mkRun({ files: {} });
    const p = await edApprover("alice");
    const r = await dispatch(
      env,
      { kind: "bearer", token: operatorTok },
      "release_approval_challenge",
      {
        run_id: runId,
        approver: p.id,
        project: "web",
      },
    );
    expect(!r.ok && r.error.message).toContain("release_manifest_unknown");
  });
});

describe("expiry and binding", () => {
  test("an expired approval does not sign", async () => {
    const { runId } = await mkRun();
    await approveAs("alice", runId, { ttl_minutes: 5 });
    await finish(runId);
    await db.orm
      .update(s.approvalRecords)
      .set({ expiresAt: Date.now() - 1000 })
      .where(eq(s.approvalRecords.runId, runId));
    expect(await sign(runId)).toMatchObject({ ok: false, reason: "no_approval" });
  });

  test("a statement that has expired is not accepted", async () => {
    const { runId } = await mkRun();
    const p = await edApprover("alice");
    const c = await challenge(runId, p.id);
    const stale = { ...c.statement, expires_at: Date.now() - 1000 };
    const msg = await failure(
      approve(stale, { kind: "ed25519", signature: signEd25519(p.priv, canonicalOf(stale)) }),
    );
    expect(msg).toContain("expired");
  });

  test("another run's approval does not sign this run, even for identical bytes", async () => {
    const one = await mkRun();
    const two = await mkRun({ sha: "d".repeat(40) });
    await approveAs("alice", one.runId);
    await finish(two.runId);
    expect(await sign(two.runId)).toMatchObject({ ok: false, reason: "no_approval" });
  });

  test("a statement for another org or project is refused, even when properly signed", async () => {
    const { runId } = await mkRun();
    const p = await edApprover("alice");
    const c = await challenge(runId, p.id);
    for (const patch of [{ org: "other" }, { project: "other" }]) {
      const st = { ...c.statement, ...patch };
      const msg = await failure(
        approve(st, { kind: "ed25519", signature: signEd25519(p.priv, canonicalOf(st)) }),
      );
      expect(msg).toMatch(/not_found|another (org|project)|signature not accepted/);
    }
  });

  test("a statement naming a run of another org is not found", async () => {
    const other = await createOrg(db, { slug: "beta", name: "Beta" });
    const otherProject = await createProject(db, { orgId: other.id }, { slug: "web", name: "Web" });
    const p = await edApprover("alice");
    const { runId } = await mkRun();
    const c = await challenge(runId, p.id);
    const foreign = await createRun(
      db,
      { orgId: other.id, projectId: otherProject.id },
      {
        workflowPath: ".github/workflows/release.yml",
        event: "push",
        ref: "refs/tags/v1.2.3",
        sha: SHA,
        repo: "beta/web",
        trust: JSON.stringify({ class: "release", workflowHash: WF_HASH }),
      },
    );
    const st = { ...c.statement, run_id: foreign.id };
    const r = await approve(st, {
      kind: "ed25519",
      signature: signEd25519(p.priv, canonicalOf(st)),
    });
    expect(r.ok).toBe(false);
  });
});

describe("v1 stays for non-release environments", () => {
  test("a v1 challenge for the release environment is refused", async () => {
    const { runId } = await mkRun();
    const p = await edApprover("alice");
    const r = await dispatch(env, { kind: "bearer", token: operatorTok }, "approval_challenge", {
      run_id: runId,
      environment: "release",
      approver: p.id,
      project: "web",
    });
    expect(!r.ok && r.error.message).toContain("release_requires_v2");
  });

  test("a v1 statement for the release environment is refused even when signed and issued", async () => {
    const { runId } = await mkRun();
    const p = await edApprover("alice");
    const st = {
      type: ENV_STATEMENT_TYPE,
      org: "acme",
      project: "web",
      run_id: runId,
      head_sha: SHA,
      workflow_hash: WF_HASH,
      environment: "release",
      approver: p.id,
      expires_at: Date.now() + 3600_000,
      nonce: randomBytes(24).toString("base64url"),
    };
    const r = await dispatch(env, { kind: "signed" }, "approve_environment", {
      statement: st,
      signature: { kind: "ed25519", signature: signEd25519(p.priv, canonicalOf(st)) },
    });
    expect(!r.ok && r.error.message).toContain("release_requires_v2");
    // and the same through the token relay
    const relay = await dispatch(env, { kind: "bearer", token: operatorTok }, "submit_approval", {
      project: "web",
      statement: st,
      signature: { kind: "ed25519", signature: signEd25519(p.priv, canonicalOf(st)) },
    });
    expect(!relay.ok && relay.error.message).toContain("release_requires_v2");
  });

  test("a v1 approval never lets the signing service sign", async () => {
    // Even a v1 record that predates this change (inserted directly) counts for nothing.
    const { runId } = await mkRun();
    const p = await edApprover("alice");
    const st = {
      type: ENV_STATEMENT_TYPE,
      org: "acme",
      project: "web",
      run_id: runId,
      head_sha: SHA,
      workflow_hash: WF_HASH,
      environment: "release",
      approver: p.id,
      expires_at: Date.now() + 3600_000,
      nonce: randomBytes(24).toString("base64url"),
    };
    await db.orm.insert(s.approvalRecords).values({
      id: "legacy-1",
      orgId,
      projectId: scope.projectId,
      kind: "environment",
      runId,
      environment: "release",
      statementHash: statementHash(st as never),
      statement: canonicalOf(st),
      method: "ed25519",
      approverId: p.id,
      person: "alice",
      signature: JSON.stringify({
        kind: "ed25519",
        signature: signEd25519(p.priv, canonicalOf(st)),
      }),
      createdAt: Date.now(),
      expiresAt: st.expires_at,
    });
    await finish(runId);
    expect(await sign(runId)).toMatchObject({ ok: false, reason: "no_approval" });
  });

  test("a v1 approval of a non-release environment still works", async () => {
    const { runId } = await mkRun({ environment: "production" });
    const p = await edApprover("alice");
    const c = await ok("approval_challenge", {
      run_id: runId,
      environment: "production",
      approver: p.id,
      project: "web",
    });
    const r = await dispatch(env, { kind: "signed" }, "approve_environment", {
      statement: c.statement,
      signature: edSign(p, c),
    });
    expect(r.ok).toBe(true);
    expect(r.ok && (r.output as { released_jobs: number }).released_jobs).toBe(1);
  });

  test("a v2 statement for another environment is refused", async () => {
    const { runId } = await mkRun({ environment: "production" });
    const p = await edApprover("alice");
    // the release challenge needs a job waiting on the release environment
    await expect(challenge(runId, p.id)).rejects.toThrow("release environment");
  });
});

describe("both signature kinds, and the org key policy", () => {
  test("a passkey approval is bound to its server-issued challenge and signs once", async () => {
    const dev = softPasskey();
    const chal = randomBytes(32).toString("base64url");
    const reg = verifyRegistration(dev.register(chal), { challenge: chal, rp: RP });
    const a = await insertApprover(
      db,
      orgId,
      {
        person: "pat",
        forgeLogin: "pat-gh",
        kind: "webauthn",
        credentialId: reg.credentialId,
        publicKey: reg.publicKey,
        alg: reg.alg,
        createdBy: "test",
      },
      Date.now(),
    );
    const { runId } = await mkRun();
    const c = await challenge(runId, a.id);
    expect(c.passkey_id).toBe(dev.credentialId.toString("base64url"));
    const assertion = dev.assert(c.challenge);
    const r = await approve(c.statement, assertion);
    expect(r.ok).toBe(true);
    // the same assertion again: the challenge is spent
    expect((await approve(c.statement, dev.assert(c.challenge))).ok).toBe(false);
    await finish(runId);
    expect((await sign(runId)).ok).toBe(true);
    expect(await sign(runId)).toMatchObject({ ok: false, reason: "approval_spent" });
  });

  test("an assertion over another statement's challenge is refused", async () => {
    const dev = softPasskey();
    const chal = randomBytes(32).toString("base64url");
    const reg = verifyRegistration(dev.register(chal), { challenge: chal, rp: RP });
    const a = await insertApprover(
      db,
      orgId,
      {
        person: "pat",
        forgeLogin: "pat-gh",
        kind: "webauthn",
        credentialId: reg.credentialId,
        publicKey: reg.publicKey,
        alg: reg.alg,
        createdBy: "test",
      },
      Date.now(),
    );
    const one = await mkRun();
    const two = await mkRun({ sha: "d".repeat(40) });
    const c1 = await challenge(one.runId, a.id);
    const c2 = await challenge(two.runId, a.id);
    expect((await approve(c2.statement, dev.assert(c1.challenge))).ok).toBe(false);
  });

  test("a statement the server did not issue is refused, even properly signed", async () => {
    const { runId } = await mkRun();
    const p = await edApprover("alice");
    const c = await challenge(runId, p.id);
    // Same fields, another manifest digest and a fresh nonce: signed by the real key.
    const forged = {
      ...c.statement,
      manifest_sha256: "f".repeat(64),
      nonce: randomBytes(24).toString("base64url"),
    };
    const msg = await failure(
      approve(forged, { kind: "ed25519", signature: signEd25519(p.priv, canonicalOf(forged)) }),
    );
    expect(msg).toContain("challenge");
  });

  test("the org key policy is respected when approving", async () => {
    await setKeyPolicy(
      db,
      orgId,
      { mode: "hardware", presets: [], aaguids: [] },
      "test",
      Date.now(),
    );
    const { runId } = await mkRun();
    const p = await edApprover("alice");
    const c = await challenge(runId, p.id);
    const msg = await failure(approve(c.statement, edSign(p, c)));
    expect(msg).toContain("cannot approve");
  });

  test("a key that stops satisfying the policy after approving no longer lets the release sign", async () => {
    const { runId } = await mkRun();
    await approveAs("alice", runId);
    await finish(runId);
    await setKeyPolicy(
      db,
      orgId,
      { mode: "hardware", presets: [], aaguids: [] },
      "test",
      Date.now(),
    );
    expect(await sign(runId)).toMatchObject({ ok: false, reason: "no_approval" });
  });

  test("the quorum counts approvals of the SAME manifest only", async () => {
    await setEnvPolicy(db, orgId, {
      environment: "release",
      required: 2,
      allowAuthorApproval: false,
      by: "test",
      now: Date.now(),
    });
    const { runId, attemptId } = await mkRun();
    const first = await approveAs("alice", runId);
    expect(first.out.released_jobs).toBe(0);
    // an artifact appears: the next approver's statement is for another digest
    await recordArtifact(db, scope, {
      runId,
      attemptId,
      name: "late.bin",
      sha256: sha256Hex(Buffer.from("late")),
      size: 4,
    });
    const second = await approveAs("bob", runId);
    expect(second.out).toMatchObject({ approvals: 1, released_jobs: 0 });
    expect(second.c.manifest_sha256).not.toBe(first.c.manifest_sha256);
  });
});

// The exact text an ed25519 key signs for a statement object.
const canonicalOf = (o: Record<string, unknown>): string => canonicalJson(o);
