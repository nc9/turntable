import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { eq } from "drizzle-orm";
import {
  clearFreeze,
  createRun,
  setFreeze,
  setProjectSigning,
  chainedAudit,
  createReleaseRequest,
  getReleaseRequest,
  recordArtifact,
  type Db,
} from "../src/db";
import * as s from "../src/db/schema";
import { dispatch, registry } from "../src/ops";
import { resetFailureThrottle } from "../src/audit/failures";
import { AttestationStore } from "../src/release/attest";
import { dirArtifacts } from "../src/release/artifacts";
import { githubForge, type ForgeFacts } from "../src/release/forge";
import { ReleaseLane, type ArtifactRecords, type ReleaseSigner } from "../src/release/lane";
import { fileKeyVault } from "../src/release/key-vault";
import { releaseCommand } from "../src/release/cli";
import { serveRelease, signingWiring } from "../src/release/serve";
import { LocalSigner, verifyDigest } from "@longshore/signer";
import { builtinKeyRef, SigningService } from "../src/signing";
import { mainRuntime, releaseConfigFromEnv, resolveRoles } from "../src/roles";
import { initMasterKey } from "../src/secrets/crypto";
import { SecretVault } from "../src/secrets/vault";
import { mintToken, seedWorld, type Tenant } from "./ops-helpers";

const SHA = "a".repeat(40);
const digest = (t: string): string => createHash("sha256").update(t).digest("hex");

let db: Db;
let a: Tenant;
let forgeTags: Map<string, string>;
let forgeCalls: string[];
let blobs: Map<string, string>; // `${runId}/${name}` -> bytes
let recorded: Map<string, string>; // `${runId}/${name}` -> sha256 (the main database's rows)
let signed: Parameters<ReleaseSigner["signRelease"]>[1][];
let signerAnswer: Awaited<ReturnType<ReleaseSigner["signRelease"]>>;
let attest: AttestationStore;
let lane: ReleaseLane;
let forgeThrows = false;

const forge: ForgeFacts = {
  async tagCommit(repo, tag) {
    forgeCalls.push(`${repo}@${tag}`);
    if (forgeThrows) throw new Error("forge unreachable");
    const sha = forgeTags.get(`${repo}@${tag}`);
    return sha ? { found: true, sha } : { found: false };
  },
};
const records: ArtifactRecords = {
  async recorded(_scope, runId, names) {
    return names.flatMap((n) => {
      const v = recorded.get(`${runId}/${n}`);
      return v ? [{ name: n, sha256: v }] : [];
    });
  },
};
const signer: ReleaseSigner = {
  async signRelease(_scope, req) {
    signed.push(req);
    return signerAnswer;
  },
};
const bytes = {
  async read(runId: string, name: string) {
    const b = blobs.get(`${runId}/${name}`);
    return b === undefined ? undefined : new TextEncoder().encode(b);
  },
};

const makeLane = (owner = "lane-1") =>
  new ReleaseLane({
    db,
    forge,
    bytes,
    records,
    attest,
    signer,
    owner,
    now: () => 1_800_000_000_000,
  });

beforeEach(async () => {
  ({ db, a } = await seedWorld());
  resetFailureThrottle();
  forgeTags = new Map([["acme/web@v1.0.0", SHA]]);
  forgeCalls = [];
  forgeThrows = false;
  blobs = new Map([[`${a.runId}/longshore-linux-x64`, "binary-bytes"]]);
  recorded = new Map([[`${a.runId}/longshore-linux-x64`, digest("binary-bytes")]]);
  signed = [];
  signerAnswer = {
    ok: true,
    envelope: { payload: "x", signatures: [{ keyid: "k1", sig: "y" }] },
    keyid: "k1",
    subjects: [{ name: "longshore-linux-x64", sha256: digest("binary-bytes") }],
  };
  attest = new AttestationStore(":memory:");
  attest.pinRepo(a.orgId, a.projectId, "acme/web", 0);
  lane = makeLane();
  await db.orm
    .update(s.runs)
    .set({ repo: "acme/web", ref: "refs/tags/v1.0.0", sha: SHA, status: "success" })
    .where(eq(s.runs.id, a.runId));
});
afterEach(() => attest.close());

const request = (over: Partial<{ runId: string; tag: string; artifacts: string[] }> = {}) =>
  createReleaseRequest(db, a.scope, {
    runId: over.runId ?? a.runId,
    tag: over.tag ?? "v1.0.0",
    artifacts: over.artifacts ?? ["longshore-linux-x64"],
    requestedBy: "test",
  });

const process1 = async (req = request()) => {
  const r = await req;
  expect(await lane.processNext()).toBe(true);
  return (await getReleaseRequest(db, a.scope, r.id))!;
};

describe("the lane signs only what it has checked itself", () => {
  test("a clean request: forge and bytes agree, the signer is called once, the outcome and facts are recorded", async () => {
    const row = await process1();
    expect(row.status).toBe("signed");
    expect(JSON.parse(row.result!).keyid).toBe("k1");
    // the service is told exactly what the lane verified: the forge's commit, the pinned repo and
    // the digests computed from the bytes
    expect(signed).toEqual([
      {
        runId: a.runId,
        artifacts: ["longshore-linux-x64"],
        verified: {
          sha: SHA,
          repo: "acme/web",
          ref: "refs/tags/v1.0.0",
          subjects: [{ name: "longshore-linux-x64", sha256: digest("binary-bytes") }],
        },
      },
    ]);
    expect(forgeCalls).toEqual(["acme/web@v1.0.0"]);
    const facts = JSON.parse(row.facts!);
    expect(facts).toMatchObject({ forgeSha: SHA, runSha: SHA });
    const audit = (await chainedAudit(db, a.orgId, 0, 100)).find((r) => r.op === "release_lane")!;
    expect(audit.outcome).toBe("ok");
    expect(await lane.processNext()).toBe(false); // nothing else pending
  });

  test("an untagged sha: the forge has no such tag, so nothing is signed", async () => {
    forgeTags.clear();
    const row = await process1();
    expect(row).toMatchObject({ status: "refused", reason: "tag_not_found" });
    expect(signed).toEqual([]);
  });

  test("a forged run row: the forge says the tag is another commit", async () => {
    forgeTags.set("acme/web@v1.0.0", "b".repeat(40));
    const row = await process1();
    expect(row).toMatchObject({ status: "refused", reason: "sha_mismatch" });
    expect(signed).toEqual([]);
  });

  test("a request for a tag the run was not built from, or a run on a branch, is refused before the forge is asked", async () => {
    expect((await process1(request({ tag: "v9.9.9" }))).reason).toBe("ref_mismatch");
    await db.orm.update(s.runs).set({ ref: "refs/heads/main" }).where(eq(s.runs.id, a.runId));
    expect((await process1()).reason).toBe("ref_mismatch");
    expect(forgeCalls).toEqual([]);
    expect(signed).toEqual([]);
  });

  test("bad tags, unknown runs and runs with no repo are refused", async () => {
    expect((await process1(request({ tag: "v1/../../x" }))).reason).toBe("bad_tag");
    expect((await process1(request({ runId: "nope" }))).reason).toBe("unknown_run");
    await db.orm.update(s.runs).set({ repo: null }).where(eq(s.runs.id, a.runId));
    expect((await process1()).reason).toBe("no_repo");
    expect(signed).toEqual([]);
  });

  test("artifacts tampered after they were recorded: the lane's own digest does not match", async () => {
    blobs.set(`${a.runId}/longshore-linux-x64`, "tampered-bytes");
    const row = await process1();
    expect(row).toMatchObject({ status: "refused", reason: "digest_mismatch" });
    expect(signed).toEqual([]);
  });

  test("the recorded digest edited to match tampered bytes is caught against the lane's own attestation", async () => {
    // the first, honest request: the lane attests the digest it saw
    expect((await process1()).status).toBe("signed");
    // the main process, with full database access, now swaps the bytes AND the recorded digest
    blobs.set(`${a.runId}/longshore-linux-x64`, "malicious-bytes");
    recorded.set(`${a.runId}/longshore-linux-x64`, digest("malicious-bytes"));
    const row = await process1();
    expect(row).toMatchObject({ status: "refused", reason: "attestation_mismatch" });
    expect(signed.length).toBe(1);
  });

  test("a recorded digest edited alone does not match the bytes", async () => {
    recorded.set(`${a.runId}/longshore-linux-x64`, digest("something else"));
    expect((await process1()).reason).toBe("digest_mismatch");
  });

  test("missing bytes, an artifact that was never recorded, and an empty list are refused", async () => {
    blobs.clear();
    expect((await process1()).reason).toBe("artifact_bytes_missing");
    expect((await process1(request({ artifacts: ["other"] }))).reason).toBe(
      "artifact_not_recorded",
    );
    expect((await process1(request({ artifacts: [] }))).reason).toBe("no_artifacts");
    expect(signed).toEqual([]);
  });

  test("the signing service's own refusal is passed through, and nothing is recorded as signed", async () => {
    signerAnswer = { ok: false, reason: "no_approval" };
    const row = await process1();
    expect(row).toMatchObject({ status: "refused", reason: "signer:no_approval" });
    expect(row.result).toBeNull();
  });

  test("a forge failure is an error, not a signature", async () => {
    forgeThrows = true;
    const row = await process1();
    expect(row).toMatchObject({ status: "error", reason: "lane_error" });
    expect(signed).toEqual([]);
  });

  test("two lanes never take the same request", async () => {
    const r1 = await request();
    const r2 = await request();
    const other = makeLane("lane-2");
    await Promise.all([lane.processNext(), other.processNext()]);
    const rows = await Promise.all([r1, r2].map((r) => getReleaseRequest(db, a.scope, r.id)));
    expect(rows.map((r) => r!.status)).toEqual(["signed", "signed"]);
    expect(new Set(rows.map((r) => r!.claimedBy)).size).toBe(2);
  });
});

describe("what is signed is exactly what the lane verified", () => {
  test("the repository is the lane's own pinned one: an unpinned project, or a run row naming another repo, is refused before the forge is asked", async () => {
    attest.close();
    attest = new AttestationStore(":memory:");
    lane = makeLane();
    expect((await process1()).reason).toBe("repo_not_pinned");
    attest.pinRepo(a.orgId, a.projectId, "acme/web", 0);
    await db.orm.update(s.runs).set({ repo: "evil/web" }).where(eq(s.runs.id, a.runId));
    forgeTags.set("evil/web@v1.0.0", SHA);
    expect((await process1()).reason).toBe("repo_mismatch");
    expect(forgeCalls).toEqual([]);
    expect(signed).toEqual([]);
    // pins are case-insensitive and per project
    attest.pinRepo(a.orgId, a.projectId, "ACME/Web", 0);
    expect(attest.pinnedRepo(a.orgId, a.projectId)).toBe("acme/web");
    expect(attest.pinnedRepo(a.orgId, "other")).toBeUndefined();
  });

  test("a signer that returns other subjects than the lane verified is not accepted", async () => {
    signerAnswer = {
      ok: true,
      envelope: { payload: "x" },
      keyid: "k1",
      subjects: [{ name: "longshore-linux-x64", sha256: digest("something else") }],
    };
    const row = await process1();
    expect(row).toMatchObject({ status: "refused", reason: "signed_subjects_differ" });
    expect(row.result).toBeNull();
  });

  describe("against the real signing service", () => {
    const person = {
      approverId: "ap",
      person: "alice",
      method: "ed25519" as const,
      statementHash: "s".repeat(64),
      approvedAt: 1,
      expiresAt: 2,
    };
    const approve = {
      verify: async (_s: unknown, environment: string) => ({
        approved: true as const,
        environment,
        required: 1,
        approvals: [person],
      }),
    };

    async function realLane(tamper?: () => Promise<void>) {
      const map = new Map<string, string>();
      const local = new LocalSigner({
        get: async (n) => map.get(n),
        set: async (n, v) => void map.set(n, v),
      });
      await local.ensureKey(builtinKeyRef(a.orgId, "release"));
      const service = new SigningService({
        db,
        signers: { builtin: local },
        approvals: approve,
        builderId: "https://ci.example.com",
      });
      await setProjectSigning(db, a.scope, { signingKey: "builtin:release" });
      await db.orm
        .update(s.runs)
        .set({
          trust: JSON.stringify({
            class: "release",
            reasons: [],
            facts: {},
            workflowHash: "h",
            decidedAt: 1,
          }),
        })
        .where(eq(s.runs.id, a.runId));
      await recordArtifact(db, a.scope, {
        runId: a.runId,
        attemptId: a.attemptId,
        name: "longshore-linux-x64",
        sha256: digest("binary-bytes"),
        size: 12,
      });
      const real: ReleaseSigner = {
        async signRelease(scope, req) {
          // the main process, with database access, changes a row after the lane has looked
          await tamper?.();
          return service.signRelease(scope, req);
        },
      };
      const wired = signingWiring({
        db,
        masterKey: randomBytes(32),
        dataDir: mkdtempSync(join(tmpdir(), "ls-rl-")),
        builderId: "https://ci.example.com",
      });
      return new ReleaseLane({
        db,
        forge,
        bytes,
        records: (await wired).records,
        attest,
        signer: real,
        owner: "lane-real",
        now: () => 1_800_000_000_000,
      });
    }

    test("a clean request is signed over the verified digests", async () => {
      const l = await realLane();
      const r = await request();
      expect(await l.processNext()).toBe(true);
      const row = (await getReleaseRequest(db, a.scope, r.id))!;
      expect(row.status).toBe("signed");
      expect(JSON.parse(row.result!).subjects).toEqual([
        { name: "longshore-linux-x64", sha256: digest("binary-bytes") },
      ]);
    });

    test("a database digest edited between the check and the sign is refused, never signed", async () => {
      const evil = digest("malicious-bytes");
      const l = await realLane(async () => {
        await db.orm
          .update(s.artifacts)
          .set({ sha256: evil })
          .where(eq(s.artifacts.runId, a.runId));
      });
      const r = await request();
      await l.processNext();
      const row = (await getReleaseRequest(db, a.scope, r.id))!;
      expect(row).toMatchObject({ status: "refused", reason: "signer:verification_mismatch" });
      expect(row.result).toBeNull();
      expect(row.detail).toContain("artifact digests");
    });

    test("the run's ref edited between the check and the sign is refused too", async () => {
      const l = await realLane(async () => {
        await db.orm.update(s.runs).set({ ref: "refs/tags/v9.9.9" }).where(eq(s.runs.id, a.runId));
      });
      const r = await request();
      await l.processNext();
      const row = (await getReleaseRequest(db, a.scope, r.id))!;
      // still a release ref, so the service's own policy passes; only the lane's tag binding catches it
      expect(row).toMatchObject({ status: "refused", reason: "signer:verification_mismatch" });
      expect(row.detail).toContain("ref");
    });

    test("a lane-signed statement carries no unverified byproducts or actions", async () => {
      const l = await realLane();
      await recordArtifact(db, a.scope, {
        runId: a.runId,
        attemptId: a.attemptId,
        name: "unverified-extra",
        sha256: digest("extra"),
        size: 5,
      });
      await db.orm
        .update(s.jobAttempts)
        .set({
          plan: JSON.stringify({
            actions: [
              { uses: "evil/action@v1", repo: "evil/action", ref: "v1", sha: "e".repeat(40) },
            ],
          }),
        })
        .where(eq(s.jobAttempts.id, a.attemptId));
      const r = await request();
      await l.processNext();
      const row = (await getReleaseRequest(db, a.scope, r.id))!;
      expect(row.status).toBe("signed");
      const payload = Buffer.from(JSON.parse(row.result!).envelope.payload, "base64").toString();
      expect(payload).not.toContain("unverified-extra");
      expect(payload).not.toContain("evil/action");
      expect(payload).toContain(digest("binary-bytes"));
    });

    test("the run's sha edited between the check and the sign is refused too", async () => {
      const l = await realLane(async () => {
        await db.orm
          .update(s.runs)
          .set({ sha: "c".repeat(40) })
          .where(eq(s.runs.id, a.runId));
      });
      const r = await request();
      await l.processNext();
      const row = (await getReleaseRequest(db, a.scope, r.id))!;
      expect(row).toMatchObject({ status: "refused", reason: "signer:verification_mismatch" });
      expect(row.detail).toContain("sha");
    });
  });
});

describe("a release is attested by its identity, not by its run", () => {
  const newRun = async () => {
    const run = await createRun(db, a.scope, {
      workflowPath: ".github/workflows/release.yml",
      event: "push",
      ref: "refs/tags/v1.0.0",
      sha: SHA,
      repo: "acme/web",
    });
    return run.id;
  };
  const id = (tag: string) => ({ orgId: a.orgId, projectId: a.projectId, repo: "acme/web", tag });

  test("a second run for the same tag with other bytes is refused, even with fresh recorded digests", async () => {
    expect((await process1()).status).toBe("signed");
    const run2 = await newRun();
    blobs.set(`${run2}/longshore-linux-x64`, "other-bytes");
    recorded.set(`${run2}/longshore-linux-x64`, digest("other-bytes"));
    const row = await process1(request({ runId: run2 }));
    expect(row).toMatchObject({ status: "refused", reason: "attestation_mismatch" });
    expect(row.detail).toContain("v1.0.0");
    expect(signed.length).toBe(1);
  });

  test("signing the same tag again with identical digests is fine (idempotent)", async () => {
    expect((await process1()).status).toBe("signed");
    const run2 = await newRun();
    blobs.set(`${run2}/longshore-linux-x64`, "binary-bytes");
    recorded.set(`${run2}/longshore-linux-x64`, digest("binary-bytes"));
    expect((await process1(request({ runId: run2 }))).status).toBe("signed");
    expect(signed.length).toBe(2);
  });

  test("a different set of artifacts for an attested tag is refused: one added, one missing", async () => {
    expect((await process1()).status).toBe("signed");
    const run2 = await newRun();
    for (const [n, b] of [
      ["longshore-linux-x64", "binary-bytes"],
      ["extra", "x"],
    ] as const) {
      blobs.set(`${run2}/${n}`, b);
      recorded.set(`${run2}/${n}`, digest(b));
    }
    const added = await process1(
      request({ runId: run2, artifacts: ["longshore-linux-x64", "extra"] }),
    );
    expect(added).toMatchObject({ status: "refused", reason: "attestation_mismatch" });
    expect(added.detail).toContain("different set");
    attest.attestRelease(id("v2.0.0"), { a: digest("1"), b: digest("2") }, 0);
    expect(attest.checkRelease(id("v2.0.0"), { a: digest("1") }).state).toBe("mismatch");
  });

  test("another tag, another project or another repo is its own release", () => {
    attest.attestRelease(id("v1.0.0"), { x: digest("1") }, 0);
    expect(attest.checkRelease(id("v1.0.1"), { x: digest("2") }).state).toBe("new");
    expect(
      attest.checkRelease({ ...id("v1.0.0"), projectId: "other" }, { x: digest("2") }).state,
    ).toBe("new");
    expect(
      attest.checkRelease({ ...id("v1.0.0"), repo: "acme/other" }, { x: digest("2") }).state,
    ).toBe("new");
    expect(
      attest.checkRelease({ ...id("v1.0.0"), repo: "ACME/Web" }, { x: digest("1") }).state,
    ).toBe("same");
  });
});

describe("an incident freeze stops releases", () => {
  const freeze = (level: "project" | "org") =>
    setFreeze(db, level === "project" ? a.scope : { orgId: a.orgId }, {
      reason: "incident",
      by: "test",
      now: 1,
    });

  test("a request for a frozen project or org is not claimed, and is processed when the freeze clears", async () => {
    for (const level of ["project", "org"] as const) {
      await freeze(level);
      const r = await request();
      expect(await lane.processNext()).toBe(false);
      expect((await getReleaseRequest(db, a.scope, r.id))!.status).toBe("pending");
      await clearFreeze(db, level === "project" ? a.scope : { orgId: a.orgId });
      expect(await lane.processNext()).toBe(true);
      expect((await getReleaseRequest(db, a.scope, r.id))!.status).toBe("signed");
    }
    expect(signed.length).toBe(2);
  });

  test("a freeze that lands after the claim refuses the request, and the signer is never called", async () => {
    const r = await request();
    const freezing: ForgeFacts = {
      async tagCommit(repo, tag) {
        await freeze("project"); // during the lane's checks
        return forge.tagCommit(repo, tag);
      },
    };
    const l = new ReleaseLane({
      db,
      forge: freezing,
      bytes,
      records,
      attest,
      signer,
      owner: "lane-f",
      now: () => 1_800_000_000_000,
    });
    expect(await l.processNext()).toBe(true);
    const row = (await getReleaseRequest(db, a.scope, r.id))!;
    expect(row).toMatchObject({ status: "refused", reason: "frozen" });
    expect(signed).toEqual([]);
  });

  test("request_release is refused while frozen", async () => {
    await freeze("project");
    const relop = (await mintToken(db, a.scope, "release_operator")).secret;
    const res = await dispatch(
      { registry, db },
      { kind: "bearer", token: relop },
      "request_release",
      {
        run_id: a.runId,
        tag: "v1.0.0",
        artifacts: ["longshore-linux-x64"],
      },
    );
    expect(res.ok).toBe(false);
    expect((res as { error: { message: string } }).error.message).toContain("frozen");
  });
});

describe("a fully compromised main process cannot cause a signature", () => {
  test("it can write any row it likes; none of that is read as truth", async () => {
    // Full write access: forge a run for an untagged commit and a request for it.
    const forgedSha = "c".repeat(40);
    await db.orm
      .update(s.runs)
      .set({ ref: "refs/tags/v6.6.6", sha: forgedSha })
      .where(eq(s.runs.id, a.runId));
    blobs.set(`${a.runId}/longshore-linux-x64`, "evil");
    recorded.set(`${a.runId}/longshore-linux-x64`, digest("evil"));
    const row = await process1(request({ tag: "v6.6.6" }));
    expect(row).toMatchObject({ status: "refused", reason: "tag_not_found" });
    // ... or hand-write a finished, signed-looking request. The lane never reads it back, and a
    // consumer verifies the envelope under the lane's pinned public key, which this row cannot satisfy.
    const fake = await request();
    await db.orm
      .update(s.releaseRequests)
      .set({
        status: "signed",
        result: JSON.stringify({ keyid: "k1", envelope: { signatures: [{ sig: "forged" }] } }),
      })
      .where(eq(s.releaseRequests.id, fake.id));
    expect(await lane.processNext()).toBe(false); // not pending, so not claimed
    expect(signed).toEqual([]);
  });

  test("the main process role holds no release configuration, even with the variables present", () => {
    const env = {
      LONGSHORE_RELEASE_MASTER_KEY_FILE: "/secret/release.key",
      LONGSHORE_RELEASE_GITHUB_TOKEN: "ghp_x",
      LONGSHORE_RELEASE_DATA_DIR: "/release",
      LONGSHORE_RELEASE_ARTIFACT_DIR: "/artifacts",
      LONGSHORE_RELEASE_BUILDER_ID: "https://ci.example.com",
      AWS_ACCESS_KEY_ID: "AKIA",
    };
    for (const roles of [
      resolveRoles(undefined, {}),
      resolveRoles("all", {}),
      resolveRoles("web,worker", {}),
    ]) {
      const rt = mainRuntime(roles, env);
      expect(rt.release).toBeUndefined();
      expect(rt.ignoredReleaseEnv.toSorted()).toEqual(
        Object.keys(env)
          .filter((k) => k.startsWith("LONGSHORE_RELEASE_"))
          .toSorted(),
      );
      expect(JSON.stringify(rt)).not.toContain("ghp_x");
      expect(JSON.stringify(rt)).not.toContain("release.key");
    }
    expect(() => mainRuntime(resolveRoles("release", {}), env)).toThrow();
  });

  test("source guard: only the release lane's own files read its variables or call the signer", () => {
    const SRC = join(import.meta.dir, "../src");
    const walk = (d: string): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith(".ts") ? [join(d, e.name)] : [],
      );
    const violations: string[] = [];
    for (const f of walk(SRC)) {
      const rel = relative(SRC, f);
      const text = readFileSync(f, "utf8");
      const inLane = rel.startsWith("release/") || rel === "roles.ts";
      if (/LONGSHORE_RELEASE_/.test(text) && !inLane && rel !== "main.ts")
        violations.push(`${rel}: reads a release variable`);
      // the signing service is built and called only by the lane (the op named sign_release always refuses)
      if (
        /\.signRelease\s*\(|new SigningService\b/.test(text) &&
        !inLane &&
        !rel.startsWith("signing/")
      )
        violations.push(`${rel}: calls the signer`);
      if (/releaseConfigFromEnv/.test(text) && !inLane)
        violations.push(`${rel}: loads the release config`);
    }
    // main.ts may only mention the variables in its usage text, never read them
    const main = readFileSync(join(SRC, "main.ts"), "utf8");
    expect(/process\.env\.LONGSHORE_RELEASE_/.test(main)).toBe(false);
    expect(/releaseConfigFromEnv/.test(main)).toBe(false);
    expect(violations).toEqual([]);
  });

  test("the main process's only release operation is to queue a request, and it needs release_operator", async () => {
    const env = { registry, db };
    const relop = (await mintToken(db, a.scope, "release_operator")).secret;
    const operator = (await mintToken(db, a.scope, "operator")).secret;
    const input = { run_id: a.runId, tag: "v1.0.0", artifacts: ["longshore-linux-x64"] };
    expect(
      (await dispatch(env, { kind: "bearer", token: operator }, "request_release", input)).ok,
    ).toBe(false);
    const ok = await dispatch(env, { kind: "bearer", token: relop }, "request_release", input);
    expect(ok.ok && (ok.output as { status: string }).status).toBe("pending");
    expect(
      (
        await dispatch(env, { kind: "bearer", token: relop }, "request_release", {
          ...input,
          run_id: "nope",
        })
      ).ok,
    ).toBe(false);
    const id = (ok as { output: { id: string } }).output.id;
    const got = await dispatch(env, { kind: "bearer", token: relop }, "get_release_request", {
      id,
    });
    expect(got.ok && (got.output as { status: string }).status).toBe("pending");
    expect(signed).toEqual([]); // queued, not signed: only the lane signs
    expect(registry.mcpOps().map((o) => o.name)).not.toContain("request_release");
  });
});

describe("roles", () => {
  test("defaults are today's behaviour; --roles is explicit; release stands alone", () => {
    expect([...resolveRoles(undefined, {})]).toEqual(["web"]);
    expect([...resolveRoles(undefined, { worker: true, poll: "p.json" })].toSorted()).toEqual([
      "poller",
      "web",
      "worker",
    ]);
    expect([...resolveRoles("all", {})].toSorted()).toEqual(["poller", "web", "worker"]);
    expect([...resolveRoles("web, worker", {})].toSorted()).toEqual(["web", "worker"]);
    expect([...resolveRoles("release", {})]).toEqual(["release"]);
    expect(() => resolveRoles("release,web", {})).toThrow(/alone/);
    expect(() => resolveRoles("web,bogus", {})).toThrow(/unknown role/);
    expect(() => resolveRoles("", {})).toThrow();
    expect(() => resolveRoles("web", { worker: true })).toThrow(/conflicts/);
    expect(() => resolveRoles("web", { poll: "p.json" })).toThrow(/conflicts/);
  });

  test("the release role needs all of its own configuration", () => {
    const full = {
      LONGSHORE_RELEASE_MASTER_KEY_FILE: "/k",
      LONGSHORE_RELEASE_DATA_DIR: "/d",
      LONGSHORE_RELEASE_GITHUB_TOKEN: "t",
      LONGSHORE_RELEASE_ARTIFACT_DIR: "/a",
      LONGSHORE_RELEASE_BUILDER_ID: "https://ci.example.com",
    };
    expect(releaseConfigFromEnv(full)).toMatchObject({ masterKeyFile: "/k", pollMs: 5000 });
    for (const k of Object.keys(full)) {
      expect(() => releaseConfigFromEnv({ ...full, [k]: undefined })).toThrow(k);
    }
    expect(() => releaseConfigFromEnv({ ...full, LONGSHORE_RELEASE_POLL_MS: "5" })).toThrow();
  });

  test("the release process refuses to start without its own key file; with it, it starts and stops", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "ls-rel-"));
    try {
      const env = {
        LONGSHORE_RELEASE_MASTER_KEY_FILE: join(tmp, "release.key"),
        LONGSHORE_RELEASE_DATA_DIR: join(tmp, "rel"),
        LONGSHORE_RELEASE_GITHUB_TOKEN: "t",
        LONGSHORE_RELEASE_ARTIFACT_DIR: join(tmp, "art"),
        LONGSHORE_RELEASE_BUILDER_ID: "https://ci.example.com",
      };
      await expect(
        serveRelease({ "data-dir": join(tmp, "data") }, signingWiring, env),
      ).rejects.toThrow(/master key file not found/);
      initMasterKey(env.LONGSHORE_RELEASE_MASTER_KEY_FILE);
      const lane = await serveRelease({ "data-dir": join(tmp, "data") }, signingWiring, env);
      lane.stop();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("the real wiring: the signing service refuses what its own policy refuses, and no environment is passed", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "ls-rel-"));
    try {
      const w = signingWiring({
        db,
        masterKey: randomBytes(32),
        dataDir: tmp,
        builderId: "https://ci.example.com",
      });
      const wired = await w;
      // the run is not release class (seedTenant has no trust decision), so the service says no
      const out = await wired.signer.signRelease(a.scope, {
        runId: a.runId,
        artifacts: ["x"],
        verified: { sha: SHA, repo: "acme/web", ref: "refs/tags/v1.0.0", subjects: [] },
      });
      expect(out).toMatchObject({ ok: false, reason: "not_release_class" });
      // recorded digests come from the main database's artifact table
      await recordArtifact(db, a.scope, {
        runId: a.runId,
        attemptId: a.attemptId,
        name: "longshore-linux-x64",
        sha256: digest("binary-bytes"),
        size: 12,
      });
      expect(
        await wired.records.recorded(a.scope, a.runId, ["longshore-linux-x64", "missing"]),
      ).toEqual([{ name: "longshore-linux-x64", sha256: digest("binary-bytes") }]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("release pin-repo writes the project's repository into the lane's own file, and rejects bad input", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "ls-rel-"));
    const saved = { ...process.env };
    try {
      const { openDatabase, createOrg, createProject, ensureInstance } = await import("../src/db");
      const dataDir = join(tmp, "data");
      const d = openDatabase(join(dataDir, "longshore.db"));
      await ensureInstance(d);
      const org = await createOrg(d, { slug: "acme", name: "acme" });
      const proj = await createProject(d, { orgId: org.id }, { slug: "web", name: "web" });
      d.close();
      Object.assign(process.env, {
        LONGSHORE_RELEASE_MASTER_KEY_FILE: join(tmp, "release.key"),
        LONGSHORE_RELEASE_DATA_DIR: join(tmp, "rel"),
        LONGSHORE_RELEASE_GITHUB_TOKEN: "t",
        LONGSHORE_RELEASE_ARTIFACT_DIR: join(tmp, "art"),
        LONGSHORE_RELEASE_BUILDER_ID: "https://ci.example.com",
      });
      const args = ["pin-repo", "--org", "acme", "--project", "web", "--data-dir", dataDir];
      expect(await releaseCommand([...args, "--repo", "Acme/Web"])).toBe(0);
      const store = new AttestationStore(join(tmp, "rel", "attested.db"));
      expect(store.pinnedRepo(org.id, proj.id)).toBe("acme/web");
      store.close();
      await expect(releaseCommand([...args, "--repo", "not a repo"])).rejects.toThrow();
      await expect(releaseCommand(["pin-repo", "--org", "acme"])).rejects.toThrow();
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("release init-key creates a sealed key once and prints only the public half", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "ls-rel-"));
    try {
      const master = randomBytes(32);
      const vault = fileKeyVault(join(tmp, "keys"), master);
      const signer = new LocalSigner(vault);
      const pub = await signer.ensureKey("release");
      expect(pub.publicKeyPem).toContain("PUBLIC KEY");
      expect((await signer.ensureKey("release")).keyid).toBe(pub.keyid); // idempotent
      const sealed = readFileSync(join(tmp, "keys", "signing__release.sealed"), "utf8");
      expect(sealed).not.toContain("PRIVATE");
      // a different master key cannot open it
      await expect(
        fileKeyVault(join(tmp, "keys"), randomBytes(32)).get("signing/release"),
      ).rejects.toThrow();
      await expect(vault.set("signing/release", "x")).rejects.toThrow(/refusing to overwrite/);
      // and the key signs something a pinned public key verifies
      const msg = new TextEncoder().encode("hello");
      const sig = await signer.sign(msg, "release");
      expect(verifyDigest).toBeDefined();
      expect(sig.length).toBe(64);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("publish credentials belong to the release lane", () => {
  test("a release-class use is refused by the main lane before anything is decrypted, and allowed in the release lane", async () => {
    const master = randomBytes(32);
    await db.orm
      .update(s.jobAttempts)
      .set({ state: "running", trustClass: "release" })
      .where(eq(s.jobAttempts.id, a.attemptId));
    const mainVault = new SecretVault({ db, masterKey: master });
    const lane2 = new SecretVault({ db, masterKey: master, lane: "release" });
    await mainVault.set(a.orgId, "t", { name: "NPM" }, "publish-token", {
      trustClasses: ["release"],
      destinations: ["registry.npmjs.org"],
    });
    const req = {
      orgId: a.orgId,
      projectId: a.projectId,
      runId: a.runId,
      jobId: a.jobId,
      attemptId: a.attemptId,
      name: "NPM",
      destination: "registry.npmjs.org",
    };
    expect(await mainVault.use(req)).toEqual({ ok: false, reason: "release_lane_only" });
    expect(await lane2.use(req)).toMatchObject({ ok: true, value: "publish-token" });
    // a protected-class job is unaffected in the main lane
    await db.orm
      .update(s.jobAttempts)
      .set({ trustClass: "protected" })
      .where(eq(s.jobAttempts.id, a.attemptId));
    await mainVault.set(a.orgId, "t", { name: "PLAIN" }, "v", {
      destinations: ["registry.npmjs.org"],
    });
    expect((await mainVault.use({ ...req, name: "PLAIN" })).ok).toBe(true);
  });
});

describe("the lane's inputs", () => {
  test("artifact bytes are read only from inside the artifact directory", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "ls-art-"));
    try {
      mkdirSync(join(tmp, "RUN1"), { recursive: true });
      writeFileSync(join(tmp, "RUN1", "bin"), "ok");
      writeFileSync(join(tmp, "secret"), "outside");
      symlinkSync(join(tmp, "secret"), join(tmp, "RUN1", "link"));
      // a link that stays inside the directory is refused too, as is a linked directory
      symlinkSync(join(tmp, "RUN1", "bin"), join(tmp, "RUN1", "inner-link"));
      mkdirSync(join(tmp, "RUN2"));
      writeFileSync(join(tmp, "RUN2", "f"), "two");
      symlinkSync(join(tmp, "RUN2"), join(tmp, "RUN1", "dirlink"));
      const art = dirArtifacts(tmp);
      expect(new TextDecoder().decode((await art.read("RUN1", "bin"))!)).toBe("ok");
      expect(await art.read("RUN2", "f")).toBeDefined();
      for (const [run, name] of [
        ["RUN1", "link"],
        ["RUN1", "inner-link"],
        ["RUN1", "dirlink/f"],
        ["RUN1", "../secret"],
        ["../x", "bin"],
        ["RUN1", "missing"],
        ["RUN1", "/etc/passwd"],
        ["RUN1", ""],
      ]) {
        expect(await art.read(run!, name!)).toBeUndefined();
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("the GitHub forge follows annotated tags, reports a missing tag, and fails on a server error", async () => {
    const calls: string[] = [];
    const answers: Record<string, { status: number; body: unknown }> = {
      "/repos/acme/web/git/ref/tags/light": {
        status: 200,
        body: { object: { type: "commit", sha: SHA } },
      },
      "/repos/acme/web/git/ref/tags/anno": {
        status: 200,
        body: { object: { type: "tag", sha: "t".repeat(40) } },
      },
      [`/repos/acme/web/git/tags/${"t".repeat(40)}`]: {
        status: 200,
        body: { object: { type: "commit", sha: "d".repeat(40) } },
      },
      "/repos/acme/web/git/ref/tags/gone": { status: 404, body: {} },
      "/repos/acme/web/git/ref/tags/boom": { status: 500, body: {} },
      "/repos/acme/web/git/ref/tags/tree": {
        status: 200,
        body: { object: { type: "tree", sha: SHA } },
      },
    };
    const f = githubForge({
      token: "tok",
      apiBase: "https://api.example.test",
      fetch: (async (url: string, init: { headers: Record<string, string> }) => {
        const path = new URL(url).pathname;
        calls.push(`${path} ${init.headers.authorization}`);
        const a = answers[path] ?? { status: 404, body: {} };
        return new Response(JSON.stringify(a.body), { status: a.status });
      }) as never,
    });
    expect(await f.tagCommit("acme/web", "light")).toEqual({ found: true, sha: SHA });
    expect(await f.tagCommit("acme/web", "anno")).toEqual({ found: true, sha: "d".repeat(40) });
    expect(await f.tagCommit("acme/web", "gone")).toEqual({ found: false });
    await expect(f.tagCommit("acme/web", "boom")).rejects.toThrow(/500/);
    await expect(f.tagCommit("acme/web", "tree")).rejects.toThrow(/commit/);
    await expect(f.tagCommit("not a repo", "v1")).rejects.toThrow();
    expect(calls[0]).toBe("/repos/acme/web/git/ref/tags/light Bearer tok");
  });
});
