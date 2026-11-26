// The solo-aware default approval policy (#663): a one-person org approves its own release, a
// second owner or admin moves the org to two people with the author excluded (audited), going back
// to one person never relaxes it, and an explicit policy entry beats both defaults.
import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createApprovalVerifier } from "../src/approvals/verifier";
import { generateEd25519, signEd25519 } from "../src/approvals/keys";
import {
  addMember,
  createAttempt,
  createOrg,
  createPolledRun,
  createProject,
  createUser,
  type Db,
  getEnvPolicy,
  insertApprover,
  listAudit,
  openDatabase,
  setEnvPolicy,
  type Scope,
} from "../src/db";
import * as s from "../src/db/schema";
import { completeSignIn, createMemberInvite } from "../src/db/repos/web-auth";
import { dispatch, type DispatchEnv, registry } from "../src/ops";
import { mintToken } from "./ops-helpers";

const WF_HASH = "ab".repeat(32);
const SHA = "c".repeat(40);

let db: Db;
let orgId: string;
let scope: Required<Scope>;
let env: DispatchEnv;
let operatorTok: string;

const member = async (role: "owner" | "admin" | "member") => {
  const u = await createUser(db, { displayName: `${role}-${Math.random()}` });
  await addMember(db, { orgId }, { userId: u.id, role });
  return u.id;
};
const unmember = (userId: string) =>
  db.orm.delete(s.orgMembers).where(eq(s.orgMembers.userId, userId));

async function releaseRun(actor: string) {
  const planned = {
    key: "publish",
    id: "publish",
    name: "publish",
    needs: [],
    needsIds: [],
    environment: "production",
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
      sha: SHA,
      actor,
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
  return runId;
}

/** A fresh key for `login` approves the run's production environment (release shares the default). */
async function approveAs(login: string, runId: string) {
  const k = generateEd25519();
  const a = await insertApprover(
    db,
    orgId,
    {
      person: login,
      forgeLogin: login,
      kind: "ed25519",
      publicKey: k.publicSpki,
      alg: "EdDSA",
      createdBy: "test",
    },
    Date.now(),
  );
  const c = await dispatch(env, { kind: "bearer", token: operatorTok }, "approval_challenge", {
    run_id: runId,
    environment: "production",
    approver: a.id,
    project: "web",
  });
  if (!c.ok) return `${c.error.code}: ${c.error.message}`;
  const out = c.output as { statement: unknown; canonical: string };
  const r = await dispatch(env, { kind: "signed" }, "approve_environment", {
    statement: out.statement,
    signature: { kind: "ed25519", signature: signEd25519(k.privatePem, out.canonical) },
  });
  return r.ok
    ? (r.output as { approvals: number; required: number })
    : `${r.error.code}: ${r.error.message}`;
}

const strictMarks = async () =>
  (await listAudit(db, scope)).filter((x) => x.op === "approval_default.strict");

beforeEach(async () => {
  db = openDatabase(":memory:");
  const org = await createOrg(db, { slug: "acme", name: "Acme" });
  const project = await createProject(db, { orgId: org.id }, { slug: "web", name: "Web" });
  orgId = org.id;
  scope = { orgId, projectId: project.id };
  env = { registry, db };
  operatorTok = (await mintToken(db, { orgId }, "operator")).secret;
});

describe("solo-aware default", () => {
  test("one owner, no policy row: the owner approves their own release alone", async () => {
    await member("owner");
    expect(await getEnvPolicy(db, orgId, "release")).toMatchObject({
      required: 1,
      allowAuthorApproval: true,
      source: "default",
    });
    const run = await releaseRun("octo");
    const r = await approveAs("octo", run);
    expect(r).toMatchObject({ approvals: 1, required: 1 });
    expect(await strictMarks()).toHaveLength(0);
  });

  test("a second owner or admin: two distinct people, author excluded, switch audited once", async () => {
    await member("owner");
    expect(await getEnvPolicy(db, orgId, "production")).toMatchObject({ required: 1 });
    await member("admin");
    for (const environment of ["release", "production"]) {
      expect(await getEnvPolicy(db, orgId, environment)).toMatchObject({
        required: 2,
        allowAuthorApproval: false,
      });
    }
    const run = await releaseRun("octo");
    expect(await approveAs("octo", run)).toContain("author");
    expect(await approveAs("other", run)).toMatchObject({ approvals: 1, required: 2 });
    const marks = await strictMarks();
    expect(marks).toHaveLength(1);
    expect(marks[0]).toMatchObject({ principalKind: "system", outcome: "ok" });
    expect(JSON.parse(marks[0]!.input)).toMatchObject({ eligible: 2, from: "solo", to: "strict" });
  });

  test("a plain member does not count as eligible", async () => {
    await member("owner");
    await member("member");
    expect(await getEnvPolicy(db, orgId, "release")).toMatchObject({ required: 1 });
  });

  test("going back to one person keeps the default at two", async () => {
    await member("owner");
    const second = await member("admin");
    expect(await getEnvPolicy(db, orgId, "release")).toMatchObject({ required: 2 });
    await unmember(second);
    expect(await getEnvPolicy(db, orgId, "release")).toMatchObject({
      required: 2,
      allowAuthorApproval: false,
    });
    expect(await strictMarks()).toHaveLength(1);
  });

  test("an explicit policy row wins over both defaults, and is never lowered by them", async () => {
    const owner = await member("owner");
    const set = (required: number, author: boolean) =>
      setEnvPolicy(db, orgId, {
        environment: "release",
        required,
        allowAuthorApproval: author,
        by: "test",
        now: Date.now(),
      });
    // solo org, explicit strict row: the solo default does not lower it
    await set(3, false);
    expect(await getEnvPolicy(db, orgId, "release")).toMatchObject({
      required: 3,
      allowAuthorApproval: false,
      source: "configured",
    });
    // strict org, explicit solo row: the strict default does not raise it
    await member("admin");
    await set(1, true);
    expect(await getEnvPolicy(db, orgId, "release")).toMatchObject({
      required: 1,
      allowAuthorApproval: true,
      source: "configured",
    });
    await unmember(owner);
    expect(await getEnvPolicy(db, orgId, "release")).toMatchObject({ required: 1 });
  });

  test("an org with nobody eligible stays on the strict default", async () => {
    expect(await getEnvPolicy(db, orgId, "release")).toMatchObject({ required: 2 });
  });

  test("other environments stay ungated in a solo org", async () => {
    await member("owner");
    expect(await getEnvPolicy(db, orgId, "docs")).toMatchObject({ required: 1, gated: false });
  });
});

describe("the ratchet is written with the membership", () => {
  test("a second admin added and removed with no read in between: the org is strict", async () => {
    await member("owner");
    const second = await member("admin");
    await unmember(second);
    expect(await strictMarks()).toHaveLength(1);
    expect(await getEnvPolicy(db, orgId, "release")).toMatchObject({
      required: 2,
      allowAuthorApproval: false,
    });
  });

  test("an accepted invite writes it too", async () => {
    await member("owner");
    const now = Date.now();
    await createMemberInvite(
      db,
      { orgId },
      {
        githubLogin: "newadmin",
        githubUserId: "9001",
        role: "admin",
        createdBy: "test",
        now,
        expiresAt: now + 60_000,
        canReplace: () => true,
      },
    );
    await completeSignIn(db, {
      githubUserId: "9001",
      login: "newadmin",
      now,
      sessionHash: "h".repeat(64),
      absoluteMs: 60_000,
    });
    expect(await strictMarks()).toHaveLength(1);
  });

  test("a read writes nothing, inside a transaction or not", async () => {
    await member("owner");
    await member("member");
    await db.transaction(async (tx) => {
      expect(await getEnvPolicy(tx, orgId, "release")).toMatchObject({ required: 1 });
      // two eligible people appear in this transaction by raw SQL: the read computes strict
      // but writes no marker and no audit row
      const u = await createUser(tx, { displayName: "raw" });
      await tx.orm.insert(s.orgMembers).values({ orgId, userId: u.id, role: "admin" });
      expect(await getEnvPolicy(tx, orgId, "release")).toMatchObject({ required: 2 });
    });
    expect(await strictMarks()).toHaveLength(0);
  });

  test("a membership added inside a caller's transaction ratchets with it", async () => {
    await member("owner");
    await db.transaction(async (tx) => {
      const u = await createUser(tx, { displayName: "in-tx" });
      await addMember(tx, { orgId }, { userId: u.id, role: "admin" });
      expect(await getEnvPolicy(tx, orgId, "release")).toMatchObject({ required: 2 });
    });
    expect(await strictMarks()).toHaveLength(1);
  });
});

describe("in-flight approvals", () => {
  // Nothing snapshots `required` at request time: the challenge binds the statement, and both the
  // approve op and the publish-time verifier read the live policy, so the ratchet only raises it.
  test("a solo-mode approval does not satisfy the publish check once the org is strict", async () => {
    await member("owner");
    const run = await releaseRun("octo");
    expect(await approveAs("octo", run)).toMatchObject({ approvals: 1, required: 1 });
    const verifier = createApprovalVerifier(db);
    const subject = {
      orgId,
      projectId: scope.projectId,
      runId: run,
      headSha: SHA,
      workflowHash: WF_HASH,
    };
    expect(await verifier.verify(subject, "production")).toMatchObject({ approved: true });
    await member("admin");
    const after = await verifier.verify(subject, "production");
    expect(after).toMatchObject({ approved: false, required: 2 });
  });

  test("a request made in solo mode is judged by the current mode when approved", async () => {
    await member("owner");
    const run = await releaseRun("octo");
    await member("admin");
    expect(await approveAs("other", run)).toMatchObject({ approvals: 1, required: 2 });
  });
});
