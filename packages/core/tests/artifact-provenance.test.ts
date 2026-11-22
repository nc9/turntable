import { beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { decideConsumption } from "../src/artifacts/consume";
import {
  ArtifactConflict,
  createAttempt,
  createJob,
  createRun,
  type Db,
  listRunArtifacts,
  recordArtifact,
  resolveArtifactConsumption,
} from "../src/db";
import { eq } from "drizzle-orm";
import * as s from "../src/db/schema";
import { dispatch, registry } from "../src/ops";
import { mintToken, seedWorld, type Tenant } from "./ops-helpers";

let db: Db;
let a: Tenant;
let b: Tenant;
const CLASSES = ["untrusted_pr", "trusted_pr", "protected", "release"] as const;

beforeEach(async () => {
  ({ db, a, b } = await seedWorld());
});

async function runOf(
  t: Tenant,
  klass: string | null,
  sha = "a".repeat(40),
  attemptClass?: string | null,
) {
  const run = await createRun(db, t.scope, {
    workflowPath: ".github/workflows/ci.yml",
    event: "push",
    ref: "refs/heads/main",
    sha,
    repo: "acme/web",
    ...(klass
      ? {
          trust: JSON.stringify({
            class: klass,
            reasons: [],
            facts: {},
            workflowHash: "h",
            decidedAt: 1,
          }),
        }
      : {}),
  });
  const job = (await createJob(db, t.scope, { runId: run.id, jobKey: "build", name: "build" }))!;
  const attempt = (await createAttempt(db, t.scope, { jobId: job.id, provider: "test" }))!;
  // The class the attempt ran as: the run's unless the test says otherwise.
  const ran = attemptClass === undefined ? klass : attemptClass;
  if (ran)
    await db.run(async (h) => {
      await h.orm
        .update(s.jobAttempts)
        .set({ trustClass: ran })
        .where(eq(s.jobAttempts.id, attempt.id));
    });
  return { run, attemptId: attempt.id };
}
const rec = (
  t: Tenant,
  r: { run: { id: string }; attemptId: string },
  name: string,
  bytes?: Uint8Array,
) =>
  recordArtifact(db, t.scope, {
    runId: r.run.id,
    attemptId: r.attemptId,
    name,
    sha256: createHash("sha256")
      .update(bytes ?? name)
      .digest("hex"),
    size: 1,
    ...(bytes ? { bytes } : {}),
  });

describe("provenance", () => {
  test("every artifact records the producing run's class, sha and how its digest was obtained, from the control plane", async () => {
    for (const k of CLASSES) {
      const r = await runOf(a, k, k.length.toString().repeat(40));
      const row = await rec(a, r, `out-${k}`);
      expect(row).toMatchObject({
        klass: k,
        runSha: k.length.toString().repeat(40),
        digestSource: "reported",
      });
    }
    // A run with no stored decision is the lowest class: fail closed.
    const none = await runOf(a, null, "b".repeat(40));
    expect((await rec(a, none, "x")).klass).toBe("untrusted_pr");
    // The attempt's own class caps it: a release run whose attempt ran as trusted_pr, or whose
    // attempt has no recorded class, produces a lower-class artifact.
    const lowAttempt = await runOf(a, "release", "d".repeat(40), "trusted_pr");
    expect((await rec(a, lowAttempt, "from-low-attempt")).klass).toBe("trusted_pr");
    const noClass = await runOf(a, "release", "e".repeat(40), null);
    expect((await rec(a, noClass, "from-undecided-attempt")).klass).toBe("untrusted_pr");
    // And an attempt above its run cannot raise it.
    const highAttempt = await runOf(a, "trusted_pr", "f".repeat(40), "release");
    expect((await rec(a, highAttempt, "x")).klass).toBe("trusted_pr");
    // A caller cannot name a class: the input has no such field, and a re-record keeps the first.
    const r = await runOf(a, "protected", "c".repeat(40));
    const first = await rec(a, r, "same");
    expect((await rec(a, r, "same")).id).toBe(first.id);
  });

  test("when the control plane has the bytes it hashes them: a mismatch is refused, a match is `computed`", async () => {
    const r = await runOf(a, "release");
    const bytes = new TextEncoder().encode("binary");
    expect((await rec(a, r, "bin", bytes)).digestSource).toBe("computed");
    await expect(
      recordArtifact(db, a.scope, {
        runId: r.run.id,
        attemptId: r.attemptId,
        name: "bad",
        sha256: "e".repeat(64),
        size: 1,
        bytes,
      }),
    ).rejects.toBeInstanceOf(ArtifactConflict);
  });
});

describe("consumption by class", () => {
  test("the decision table: same or higher is allowed, lower needs an explicit request and is quarantined, release takes only release", () => {
    for (const consumer of CLASSES) {
      for (const producer of CLASSES) {
        const ci = CLASSES.indexOf(consumer);
        const pi = CLASSES.indexOf(producer);
        const implicit = decideConsumption({ consumer, producer, explicit: false });
        const explicit = decideConsumption({ consumer, producer, explicit: true });
        if (pi >= ci) {
          expect(implicit.decision, `${consumer}<-${producer}`).toBe("allow");
          expect(explicit.decision).toBe("allow");
        } else if (consumer === "release") {
          // Never, however it asks.
          expect(implicit.decision).toBe("deny");
          expect(explicit.decision).toBe("deny");
        } else {
          expect(implicit.decision, `${consumer}<-${producer}`).toBe("deny");
          expect(explicit.decision).toBe("quarantine");
        }
      }
    }
    // Unknown classes are the lowest, on either side.
    expect(
      decideConsumption({ consumer: "release", producer: "weird", explicit: true }).decision,
    ).toBe("deny");
    expect(
      decideConsumption({ consumer: undefined, producer: "release", explicit: false }).decision,
    ).toBe("allow");
  });

  test("resolved against recorded provenance: a release run is denied every lower-class artifact, even when asked", async () => {
    const lower = await runOf(a, "untrusted_pr", "1".repeat(40));
    const trusted = await runOf(a, "trusted_pr", "2".repeat(40));
    const prot = await runOf(a, "protected", "3".repeat(40));
    const relProducer = await runOf(a, "release", "4".repeat(40));
    for (const [r, n] of [
      [lower, "u"],
      [trusted, "t"],
      [prot, "p"],
      [relProducer, "r"],
    ] as const)
      await rec(a, r, n);
    const consumer = await runOf(a, "release", "5".repeat(40));
    const src = (r: { run: { id: string } }, name: string) => ({ runId: r.run.id, name });
    const all = [src(lower, "u"), src(trusted, "t"), src(prot, "p"), src(relProducer, "r")];
    const res = await resolveArtifactConsumption(db, a.scope, consumer.run.id, all, all);
    expect(res.map((x) => x.decision.decision)).toEqual(["deny", "deny", "deny", "allow"]);
    // A protected consumer: lower classes only when named, then as quarantine.
    const prodConsumer = await runOf(a, "protected", "6".repeat(40));
    const none = await resolveArtifactConsumption(db, a.scope, prodConsumer.run.id, all);
    expect(none.map((x) => x.decision.decision)).toEqual(["deny", "deny", "allow", "allow"]);
    const asked = await resolveArtifactConsumption(db, a.scope, prodConsumer.run.id, all, [
      src(lower, "u"),
    ]);
    expect(asked.map((x) => x.decision.decision)).toEqual(["quarantine", "deny", "allow", "allow"]);
    // A consumer with no stored class is the lowest.
    const bare = await runOf(a, null, "7".repeat(40));
    const bareRes = await resolveArtifactConsumption(db, a.scope, bare.run.id, all);
    expect(bareRes.map((x) => x.decision.decision)).toEqual(["allow", "allow", "allow", "allow"]);
  });

  test("a consumer can be a class by name: 'may a release build take this?'", async () => {
    const low = await runOf(a, "trusted_pr", "aa".repeat(20));
    const rel = await runOf(a, "release", "bb".repeat(20));
    await rec(a, low, "pr");
    await rec(a, rel, "rel");
    const src = (r: { run: { id: string } }, name: string) => ({ runId: r.run.id, name });
    const both = [src(low, "pr"), src(rel, "rel")];
    const asRelease = await resolveArtifactConsumption(
      db,
      a.scope,
      { klass: "release" },
      both,
      both,
    );
    expect(asRelease.map((x) => x.decision.decision)).toEqual(["deny", "allow"]);
    const asProtected = await resolveArtifactConsumption(db, a.scope, { klass: "protected" }, both);
    expect(asProtected.map((x) => x.decision.decision)).toEqual(["deny", "allow"]);
    const asked = await resolveArtifactConsumption(db, a.scope, { klass: "protected" }, both, [
      both[0]!,
    ]);
    expect(asked.map((x) => x.decision.decision)).toEqual(["quarantine", "allow"]);
    // An unknown class name is the lowest.
    const odd = await resolveArtifactConsumption(db, a.scope, { klass: "weird" }, both);
    expect(odd.map((x) => x.decision.decision)).toEqual(["allow", "allow"]);
  });

  test("tenant scoped: another org's run and artifacts are 'no such' for the caller", async () => {
    const mine = await runOf(a, "protected", "8".repeat(40));
    const theirs = await runOf(b, "release", "9".repeat(40));
    await rec(b, theirs, "secret");
    const res = await resolveArtifactConsumption(db, a.scope, mine.run.id, [
      { runId: theirs.run.id, name: "secret" },
    ]);
    expect(res[0]!.decision.decision).toBe("deny");
    expect(res[0]!.artifact).toBeUndefined();
    // And a consumer run of another tenant is not found either.
    const other = await resolveArtifactConsumption(db, a.scope, theirs.run.id, []);
    expect(other).toEqual([]);
    const denied = await resolveArtifactConsumption(db, a.scope, theirs.run.id, [
      { runId: mine.run.id, name: "x" },
    ]);
    expect(denied[0]!.decision).toEqual({ decision: "deny", reason: "no such consumer run" });
    expect((await listRunArtifacts(db, a.scope, theirs.run.id)).length).toBe(0);
  });
});

describe("ops", () => {
  test("get_artifacts shows provenance and check_artifact_consumption decides, both tenant scoped", async () => {
    const prod = await runOf(a, "untrusted_pr", "a1".repeat(20));
    await rec(a, prod, "pr-build");
    const consumer = await runOf(a, "release", "b1".repeat(20));
    const tok = (await mintToken(db, a.scope, "reader")).secret;
    const env = { registry, db };
    const call = (op: string, input: unknown) =>
      dispatch(env, { kind: "bearer", token: tok }, op, input);
    const list = await call("get_artifacts", { run_id: prod.run.id, project: a.projectSlug });
    expect(list.ok && (list.output as any).artifacts[0]).toMatchObject({
      name: "pr-build",
      trust_class: "untrusted_pr",
      digest_source: "reported",
    });
    const chk = await call("check_artifact_consumption", {
      consumer_run_id: consumer.run.id,
      sources: [{ run_id: prod.run.id, name: "pr-build" }],
      quarantine: [{ run_id: prod.run.id, name: "pr-build" }],
      project: a.projectSlug,
    });
    expect(chk.ok && (chk.output as any).results[0]).toMatchObject({
      decision: "deny",
      trust_class: "untrusted_pr",
    });
    // By class, and exactly one of run and class.
    const byClass = await call("check_artifact_consumption", {
      consumer_class: "release",
      sources: [{ run_id: prod.run.id, name: "pr-build" }],
      project: a.projectSlug,
    });
    expect(byClass.ok && (byClass.output as any).results[0].decision).toBe("deny");
    const neither = await call("check_artifact_consumption", {
      sources: [{ run_id: prod.run.id, name: "pr-build" }],
      project: a.projectSlug,
    });
    expect(!neither.ok && neither.error.code).toBe("invalid_input");
    const both = await call("check_artifact_consumption", {
      consumer_class: "release",
      consumer_run_id: consumer.run.id,
      sources: [{ run_id: prod.run.id, name: "pr-build" }],
      project: a.projectSlug,
    });
    expect(!both.ok && both.error.code).toBe("invalid_input");
  });
});
