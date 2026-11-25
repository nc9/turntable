// Parity between `my_pending_approvals` and the real approve paths (#545). The op mirrors the
// approving code's eligibility checks instead of sharing one predicate, so this test is the guard
// against drift: for each kind of item the op can list and for several principals, the item is in
// that principal's inbox if and only if the real approve op accepts that principal for it.
//
// "Would accept" is decided by driving the real ops in the test database, with no change to
// approval code: the challenge op the UI calls, a genuine ed25519 signature over its statement,
// then the approve op. The principal is accepted when both succeed. Each (kind, principal) pair
// gets a fresh world, because a signature that is accepted is recorded.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { generateEd25519, signEd25519 } from "../src/approvals/keys";
import type { WebSessions } from "../src/auth/web-sessions";
import {
  addMember,
  createAttempt,
  createOrg,
  createPolledRun,
  createProject,
  createUser,
  type Db,
  insertApprover,
  insertEnrolment,
  openDatabase,
  recordArtifact,
  revokeApprover,
  schema,
  setProjectSandboxSettings,
} from "../src/db";
import { dispatch, type DispatchEnv, type Principal, registry } from "../src/ops";
import { mintToken, rawExec } from "./ops-helpers";

const clock = 1_800_000_000_000;
const WF_HASH = "ab".repeat(32);
const SHA = "c".repeat(40);
const BIN = Buffer.from("the release binary");

type Who = "eligible" | "ineligible_approver" | "revoked_key" | "non_approver" | "other_org";
type Kind =
  | "release_approval"
  | "environment_approval"
  | "untrusted_run_approval"
  | "enrolment_approval"
  | "key_policy_approval";

// Per kind: who the op and the approve path must both accept (everyone else: neither).
const KINDS: { kind: Kind; accepted: Who[]; ineligibleBecause?: string }[] = [
  { kind: "release_approval", accepted: ["eligible"], ineligibleBecause: "author of the run" },
  { kind: "environment_approval", accepted: ["eligible"], ineligibleBecause: "author of the run" },
  {
    kind: "untrusted_run_approval",
    accepted: ["eligible"],
    ineligibleBecause: "role below the approve_run minimum",
  },
  {
    kind: "enrolment_approval",
    accepted: ["eligible"],
    ineligibleBecause: "the person whose key is being enrolled",
  },
  // Every enrolled approver may sign a key policy change that has quorum left to reach.
  { kind: "key_policy_approval", accepted: ["eligible", "ineligible_approver"] },
];
const WHOS: Who[] = ["eligible", "ineligible_approver", "revoked_key", "non_approver", "other_org"];

type Person = {
  userId: string;
  cookie: string;
  orgSlug: string;
  role: "owner" | "member";
  keyId: string | null;
  priv: string | null;
};

type World = {
  db: Db;
  env: DispatchEnv;
  orgId: string;
  token: string;
  people: Record<Who, Person>;
  // Drives the real approve path for one person. Resolves true when accepted.
  approve: (p: Person) => Promise<boolean>;
};

async function build(kind: Kind): Promise<World> {
  const db = openDatabase(":memory:");
  const org = await createOrg(db, { slug: "acme", name: "Acme" });
  const other = await createOrg(db, { slug: "other", name: "Other" });
  const project = await createProject(db, { orgId: org.id }, { slug: "app", name: "App" });
  const scope = { orgId: org.id, projectId: project.id };
  const cookies: Record<string, { userId: string; hash: string }> = {};
  let gh = 1000;

  const person = async (
    name: string,
    o: { orgId: string; slug: string; key: boolean; role?: "owner" | "member" },
  ): Promise<Person> => {
    gh += 1;
    const user = await createUser(db, { displayName: name });
    await db.run((h) =>
      h.orm
        .insert(schema.githubIdentities)
        .values({ githubUserId: String(gh), userId: user.id, login: name }),
    );
    const role = o.role ?? "owner";
    await addMember(db, { orgId: o.orgId }, { userId: user.id, role });
    let keyId: string | null = null;
    let priv: string | null = null;
    if (o.key) {
      const k = generateEd25519();
      const a = await insertApprover(
        db,
        o.orgId,
        {
          person: name,
          forgeLogin: name.toLowerCase(),
          githubUserId: String(gh),
          kind: "ed25519",
          publicKey: k.publicSpki,
          alg: "EdDSA",
          createdBy: "test",
        },
        clock,
      );
      keyId = a.id;
      priv = k.privatePem;
    }
    const cookie = `cookie-${name}-aaaaaaaaaaaaaaaaaaaaaaaa`;
    cookies[cookie] = { userId: user.id, hash: `hash-${name}` };
    return { userId: user.id, cookie, orgSlug: o.slug, role, keyId, priv };
  };

  const A = { orgId: org.id, slug: "acme" };
  const memberRole = kind === "untrusted_run_approval" ? "member" : "owner";
  const people: Record<Who, Person> = {
    eligible: await person("Eve", { ...A, key: true }),
    // Not allowed for a kind-specific reason (see KINDS); an enrolled approver all the same.
    ineligible_approver: await person(kind === "enrolment_approval" ? "Erin" : "Nina", {
      ...A,
      key: true,
      role: kind === "key_policy_approval" ? "owner" : memberRole,
    }),
    revoked_key: await person("Rex", { ...A, key: true }),
    non_approver: await person("Nora", { ...A, key: false }),
    other_org: await person("Olga", { orgId: other.id, slug: "other", key: true }),
  };
  // A third counted approver for the key policy case, who made the proposal.
  const proposer = kind === "key_policy_approval" ? await person("Sam", { ...A, key: true }) : null;
  await revokeApprover(db, org.id, people.revoked_key.keyId!, clock);

  const env: DispatchEnv = {
    registry,
    db,
    now: () => clock + 1000,
    sessions: { resolve: async (c: string) => cookies[c] } as unknown as WebSessions,
  };
  const token = (await mintToken(db, { orgId: org.id }, "release_operator")).secret;
  const call = (op: string, input: unknown) => dispatch(env, { kind: "bearer", token }, op, input);
  const must = async (op: string, input: unknown) => {
    const r = await call(op, input);
    if (!r.ok) throw new Error(`${op}: ${r.error.code} ${r.error.message}`);
    return r.output as any;
  };
  const sign = (priv: string, c: { canonical: string }) => ({
    kind: "ed25519",
    signature: signEd25519(priv, c.canonical),
  });
  const signed = (op: string, statement: unknown, signature: unknown) =>
    dispatch(env, { kind: "signed" }, op, { statement, signature });
  // The key id a person signs with: a person with no key, or whose key is revoked, still tries
  // (a made-up id for no key), so the real op decides.
  const keyOf = (p: Person) => p.keyId ?? "no-such-approver-id";
  const privOf = (p: Person) => p.priv ?? generateEd25519().privatePem;

  const runPlanned = (environment: string) => ({
    key: "deploy",
    id: "deploy",
    name: "deploy",
    needs: [],
    needsIds: [],
    environment,
    continueOnError: false,
    outputs: {},
    failFast: true,
  });
  const polled = async (o: {
    environment: string;
    ref: string;
    trust: string;
    actor: string;
    workflowPath: string;
  }) => {
    const res = await createPolledRun(db, scope, {
      repo: "acme/app",
      provider: "test",
      now: clock,
      run: {
        workflowPath: o.workflowPath,
        event: "push",
        ref: o.ref,
        sha: SHA,
        actor: o.actor,
        trust: JSON.stringify({ class: o.trust, workflowHash: WF_HASH }),
      },
      jobs: [{ key: "deploy", name: "deploy", needs: [], planned: runPlanned(o.environment) }],
    });
    return res!.run.id;
  };

  let approve: World["approve"];
  if (kind === "environment_approval") {
    const runId = await polled({
      environment: "production",
      ref: "refs/heads/main",
      trust: "protected",
      actor: "nina", // the author: Nina's own key is barred from approving it
      workflowPath: ".github/workflows/deploy.yml",
    });
    approve = async (p) => {
      const c = await call("approval_challenge", {
        run_id: runId,
        environment: "production",
        approver: keyOf(p),
        project: "app",
      });
      if (!c.ok) return false;
      const r = await signed(
        "approve_environment",
        (c.output as any).statement,
        sign(privOf(p), c.output as any),
      );
      return r.ok;
    };
  } else if (kind === "release_approval") {
    const runId = await polled({
      environment: "release",
      ref: "refs/tags/v1.2.3",
      trust: "release",
      actor: "nina",
      workflowPath: ".github/workflows/release.yml",
    });
    const job = (await db.orm.query.jobs.findFirst({
      where: (j, { eq: e }) => e(j.runId, runId),
    }))!;
    const attempt = (await createAttempt(db, scope, { jobId: job.id, provider: "test" }))!;
    await db.orm
      .update(schema.jobAttempts)
      .set({ trustClass: "release" })
      .where(eq(schema.jobAttempts.id, attempt.id));
    await recordArtifact(db, scope, {
      runId,
      attemptId: attempt.id,
      name: "app.tar.gz",
      sha256: createHash("sha256").update(BIN).digest("hex"),
      size: BIN.length,
    });
    approve = async (p) => {
      const c = await call("release_approval_challenge", {
        run_id: runId,
        approver: keyOf(p),
        project: "app",
      });
      if (!c.ok) return false;
      const r = await signed(
        "approve_release",
        (c.output as any).statement,
        sign(privOf(p), c.output as any),
      );
      return r.ok;
    };
  } else if (kind === "untrusted_run_approval") {
    await setProjectSandboxSettings(db, scope, { untrustedRunApproval: "human" });
    const run = await polled({
      environment: "unused",
      ref: "refs/pull/7/head",
      trust: "untrusted_pr",
      actor: "mallory",
      workflowPath: ".github/workflows/ci.yml",
    });
    await db.run((h) =>
      rawExec(
        h.orm,
        sql`update jobs set approval_kind = 'untrusted_author', state = 'awaiting_approval' where run_id = ${run}`,
      ),
    );
    approve = async (p) => {
      const c = await call("approve_run_challenge", { run_id: run, approver: keyOf(p) });
      if (!c.ok) return false;
      const principal: Principal = {
        kind: "member",
        id: p.userId,
        orgId: p.orgSlug === "acme" ? org.id : other.id,
        role: p.role,
      };
      const r = await dispatch(env, { kind: "principal", principal }, "approve_run", {
        run_id: run,
        head_sha: SHA,
        workflow_hash: WF_HASH,
        statement: (c.output as any).statement,
        signature: sign(privOf(p), c.output as any),
      });
      return r.ok;
    };
  } else if (kind === "enrolment_approval") {
    // Erin enrols a second key: she may not approve it, anyone else enrolled may.
    const e = await insertEnrolment(
      db,
      org.id,
      {
        person: "Erin",
        forgeLogin: "erin",
        githubUserId: "1002",
        kind: "ed25519",
        publicKey: generateEd25519().publicSpki,
        alg: "EdDSA",
        requestedBy: "test",
        expiresAt: clock + 86_400_000,
      },
      clock,
    );
    approve = async (p) => {
      const c = await call("enrolment_challenge", { enrolment_id: e.id, approver: keyOf(p) });
      if (!c.ok) return false;
      return (
        await signed(
          "approve_enrolment",
          (c.output as any).statement,
          sign(privOf(p), c.output as any),
        )
      ).ok;
    };
  } else {
    // A policy change with one live signature (Sam's) and a quorum of two not yet reached.
    const mk = (approver: string) =>
      must("key_policy_challenge", {
        mode: "any",
        aaguids: ["00000000-0000-0000-0000-000000000001"],
        approver,
      });
    const c = await mk(proposer!.keyId!);
    const first = await signed("approve_key_policy", c.statement, sign(proposer!.priv!, c));
    if (!first.ok) throw new Error(`proposal: ${first.error.message}`);
    approve = async (p) => {
      const ch = await call("key_policy_challenge", {
        mode: "any",
        aaguids: ["00000000-0000-0000-0000-000000000001"],
        approver: keyOf(p),
      });
      if (!ch.ok) return false;
      return (
        await signed(
          "approve_key_policy",
          (ch.output as any).statement,
          sign(privOf(p), ch.output as any),
        )
      ).ok;
    };
  }
  return { db, env, orgId: org.id, token, people, approve };
}

const inbox = async (w: World, p: Person, kind: Kind): Promise<number> => {
  const r = await dispatch(w.env, { kind: "session", cookie: p.cookie }, "my_pending_approvals", {
    org: p.orgSlug,
  });
  if (!r.ok) throw new Error(r.error.message);
  const items = (r.output as { items: { kind: string; org: string }[] }).items;
  return items.filter((i) => i.kind === kind && i.org === "acme").length;
};

describe("my_pending_approvals matches the real approve path", () => {
  for (const { kind, accepted } of KINDS) {
    for (const who of WHOS) {
      test(`${kind}: ${who}`, async () => {
        const w = await build(kind);
        const p = w.people[who];
        const listed = (await inbox(w, p, kind)) > 0;
        const wouldAccept = await w.approve(p);
        // Neither side is trivially empty: the eligible person is accepted and listed.
        expect(wouldAccept).toBe(accepted.includes(who));
        expect(listed).toBe(wouldAccept);
      });
    }
  }
});
