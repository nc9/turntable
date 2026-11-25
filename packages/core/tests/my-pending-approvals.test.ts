// `my_pending_approvals` (#545): the inbox of one signed-in person. Only items they can act on,
// across their orgs, with no repository text in the output.
import { beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { generateEd25519 } from "../src/approvals/keys";
import type { WebSessions } from "../src/auth/web-sessions";
import {
  addMember,
  createJob,
  createRun,
  createUser,
  type Db,
  insertApprover,
  insertEnrolment,
  schema,
  setProjectSandboxSettings,
} from "../src/db";
import { dispatch, type DispatchEnv, registry } from "../src/ops";
import { approvalLink } from "../src/approvals/pending";
import { mintToken, rawExec, seedWorld, type Tenant } from "./ops-helpers";

const MARK = "MARK-7f3a91c2";
const clock = 1_800_000_000_000;
let db: Db;
let a: Tenant;
let b: Tenant;
let env: DispatchEnv;
const cookies: Record<string, { userId: string; hash: string }> = {};
let seq = 0;

async function person(name: string, ghId: string, orgs: { t: Tenant; key: boolean }[]) {
  const user = await createUser(db, { displayName: name });
  await db.run((h) =>
    h.orm
      .insert(schema.githubIdentities)
      .values({ githubUserId: ghId, userId: user.id, login: name }),
  );
  for (const { t, key } of orgs) {
    await addMember(db, { orgId: t.orgId }, { userId: user.id, role: "member" });
    if (key) {
      const k = generateEd25519();
      await insertApprover(
        db,
        t.orgId,
        {
          person: name,
          forgeLogin: name.toLowerCase(),
          githubUserId: ghId,
          kind: "ed25519",
          publicKey: k.publicSpki,
          alg: "EdDSA",
          createdBy: "test",
        },
        clock,
      );
    }
  }
  const cookie = `cookie-${name}-aaaaaaaaaaaaaaaaaaaaaaaa`;
  cookies[cookie] = { userId: user.id, hash: `hash-${name}` };
  return cookie;
}

async function gatedRun(
  t: Tenant,
  o: { actor: string; environment?: string; kind?: "environment" | "untrusted_author" },
) {
  seq += 1;
  const run = await createRun(db, t.scope, {
    workflowPath: `.github/workflows/${MARK}.yml`,
    event: "pull_request",
    ref: "refs/pull/7/head",
    sha: createHash("sha1").update(`pa-${seq}`).digest("hex"),
    actor: o.actor,
    workflowName: `${MARK} workflow`,
    commitMessage: `${MARK} title`,
    headBranch: `${MARK}-branch`,
    trust: JSON.stringify({
      class: "untrusted_pr",
      workflowHash: createHash("sha256").update(`wf-${seq}`).digest("hex"),
    }),
  });
  const job = (await createJob(db, t.scope, {
    runId: run.id,
    jobKey: "build",
    name: `${MARK} job`,
    approvalKind: o.kind ?? "environment",
    planned:
      o.kind === "untrusted_author"
        ? { key: "build" }
        : { key: "build", environment: o.environment ?? "staging" },
  }))!;
  await db.run((h) =>
    rawExec(h.orm, sql`update jobs set state = 'awaiting_approval' where id = ${job.id}`),
  );
  return run.id;
}

const as = (cookie: string, org = "org-a") =>
  dispatch(env, { kind: "session", cookie }, "my_pending_approvals", { org });
const items = async (cookie: string, org?: string) => {
  const r = await as(cookie, org);
  if (!r.ok) throw new Error(r.error.message);
  return (r.output as { items: Record<string, any>[] }).items;
};

beforeEach(async () => {
  ({ db, a, b } = await seedWorld());
  env = {
    registry,
    db,
    now: () => clock + 1000,
    sessions: { resolve: async (c: string) => cookies[c] } as unknown as WebSessions,
  };
});

describe("my_pending_approvals", () => {
  test("returns only what this person can act on, across their orgs", async () => {
    const alice = await person("Alice", "1001", [
      { t: a, key: true },
      { t: b, key: true },
    ]);
    const bob = await person("Bob", "1002", [{ t: a, key: true }]);
    const carol = await person("Carol", "1003", [{ t: a, key: false }]);
    const inA = await gatedRun(a, { actor: "mallory" });
    const inB = await gatedRun(b, { actor: "mallory", environment: "qa" });
    // Alice authored this one: the author rule bars her, so it is Bob's alone.
    const hers = await gatedRun(a, { actor: "alice", environment: "dev" });

    const ali = await items(alice);
    expect(ali.map((i) => [i.org, i.kind, i.environment]).toSorted()).toEqual([
      ["org-a", "environment_approval", "staging"],
      ["org-b", "environment_approval", "qa"],
    ]);
    expect(ali.some((i) => i.id.startsWith(hers))).toBe(false);
    const bobItems = await items(bob);
    expect(bobItems.map((i) => i.environment).toSorted()).toEqual(["dev", "staging"]);
    expect(bobItems.every((i) => i.org === "org-a")).toBe(true); // another org's item absent
    expect(await items(carol)).toEqual([]); // no key bound to her GitHub id
    const staging = ali.find((i) => i.environment === "staging")!;
    expect(staging.id).toBe(`${inA}:staging`);
    expect(staging.link).toBe(approvalLink.environment("org-a", a.projectSlug, inA, "staging"));
    expect(ali.find((i) => i.org === "org-b")!.id).toBe(`${inB}:qa`);
  });

  test("a key bound to someone else's GitHub id does not make the item theirs", async () => {
    const dave = await person("Dave", "1004", [{ t: a, key: false }]);
    // A key with Dave's login but another numeric id.
    const k = generateEd25519();
    await insertApprover(
      db,
      a.orgId,
      {
        person: "Dave",
        forgeLogin: "dave",
        githubUserId: "9999",
        kind: "ed25519",
        publicKey: k.publicSpki,
        alg: "EdDSA",
        createdBy: "t",
      },
      clock,
    );
    await gatedRun(a, { actor: "mallory" });
    expect(await items(dave)).toEqual([]);
  });

  test("enrolments: not an expired one", async () => {
    const alice = await person("Alice", "1001", [{ t: a, key: true }]);
    const mk = (person: string, login: string, ghId: string, expiresAt: number) =>
      insertEnrolment(
        db,
        a.orgId,
        {
          person,
          forgeLogin: login,
          githubUserId: ghId,
          kind: "ed25519",
          publicKey: generateEd25519().publicSpki,
          alg: "EdDSA",
          requestedBy: "t",
          expiresAt,
        },
        clock,
      );
    const live = await mk("Erin", "erin", "2001", clock + 86_400_000);
    await mk("Frank", "frank", "2002", clock - 1); // expired
    const got = await items(alice);
    expect(got.map((i) => [i.kind, i.id])).toEqual([["enrolment_approval", live.id]]);
    expect(got[0]!.expires_at).toBe(live.expiresAt);
    expect(got[0]!.link).toBe("/org-a/-/approvers");
  });

  test("a run held for an untrusted author shows only under the human policy", async () => {
    const alice = await person("Alice", "1001", [{ t: a, key: true }]);
    await db.run((h) => h.orm.update(schema.orgMembers).set({ role: "owner" }));
    const runId = await gatedRun(a, { actor: "mallory", kind: "untrusted_author" });
    expect(await items(alice)).toEqual([]); // default policy: no_agents
    await setProjectSandboxSettings(db, a.scope, { untrustedRunApproval: "human" });
    const got = await items(alice);
    expect(got.map((i) => [i.kind, i.id])).toEqual([["untrusted_run_approval", runId]]);
    expect(got[0]!.link).toBe(approvalLink.run("org-a", a.projectSlug, runId));
  });

  test("no repository text reaches the output", async () => {
    const alice = await person("Alice", "1001", [{ t: a, key: true }]);
    await gatedRun(a, { actor: "mallory" });
    const raw = JSON.stringify(await items(alice));
    expect(raw.length).toBeGreaterThan(10);
    expect(raw).not.toContain(MARK);
    for (const i of await items(alice))
      expect(
        Object.keys(i).every((k) =>
          [
            "id",
            "kind",
            "org",
            "project",
            "environment",
            "created_at",
            "expires_at",
            "link",
          ].includes(k),
        ),
      ).toBe(true);
  });

  test("every token is refused, agent or person; an unknown session is unauthenticated", async () => {
    for (const kind of ["agent", "person"] as const) {
      const tok = (await mintToken(db, { orgId: a.orgId }, "release_operator", { kind })).secret;
      const r = await dispatch(env, { kind: "bearer", token: tok }, "my_pending_approvals", {});
      expect(r.ok ? "ok" : r.error.code).toBe("forbidden");
    }
    const r = await dispatch(
      env,
      { kind: "session", cookie: "nope-nope-nope-nope-nope-nope" },
      "my_pending_approvals",
      {},
    );
    expect(r.ok).toBe(false);
  });
});
