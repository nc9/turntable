// `my_activity_feed` (#559): runs across every org a person belongs to, never one they do not.
// Memberships are real rows; the web cookie path goes through a stub session resolver.
import { afterAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import type { WebSessions } from "../src/auth/web-sessions";
import {
  addMember,
  createJob,
  createOrg,
  createProject,
  createRun,
  createUser,
  type Db,
  openDatabase,
  schema,
  setRunStatus,
  upsertInstallation,
} from "../src/db";
import { testDb } from "../src/db/dialect";
import { openPostgres } from "../src/db/pg";
import { dispatch, registry, type Credential } from "../src/ops";
import { mintToken } from "./ops-helpers";

const HOSTILE = "<img src=x onerror=alert(1)> **bold** [x](javascript:alert(1))";
const AVATAR = "https://avatars.githubusercontent.com/u/583231?v=4";

const pgTarget = (): Parameters<typeof openPostgres>[0] => {
  const t = testDb();
  return t && t !== "pglite" ? { url: t, schema: `lstest_feed_${process.pid}` } : { pglite: true };
};
const opened: Db[] = [];
afterAll(() => {
  for (const db of opened) db.close();
});

const dialects: [string, () => Db][] = [
  ["sqlite", () => openDatabase(":memory:")],
  ["postgres", () => openPostgres(pgTarget(), { fresh: true })],
];

describe.each(dialects)("my_activity_feed (%s)", (_n, open) => {
  async function world() {
    const db = open();
    opened.push(db);
    const orgs = {} as Record<
      string,
      { id: string; projectId: string; scope: { orgId: string; projectId: string } }
    >;
    const runIds: Record<string, string[]> = {};
    for (const slug of ["alpha", "beta", "gamma"]) {
      const org = await createOrg(db, { slug, name: slug.toUpperCase() });
      const project = await createProject(db, { orgId: org.id }, { slug: "app", name: "App" });
      const scope = { orgId: org.id, projectId: project.id };
      orgs[slug] = { id: org.id, projectId: project.id, scope };
      runIds[slug] = [];
      for (let i = 0; i < 3; i += 1) {
        const run = await createRun(db, scope, {
          workflowPath: ".github/workflows/ci.yml",
          event: "push",
          ref: i === 2 ? "refs/tags/v1.0.0" : "refs/heads/main",
          sha: `${slug.charCodeAt(0).toString(16)}`.padEnd(40, "0"),
          workflowName: `${slug}-wf-${i}`,
          actor: `${slug}-actor`,
        });
        await createJob(db, scope, { runId: run.id, jobKey: "b", name: "b" });
        runIds[slug]!.push(run.id);
      }
    }
    // Person: a member of alpha and beta, NOT gamma.
    const user = await createUser(db, { displayName: "pat" });
    await addMember(db, orgs.alpha!.scope, { userId: user.id, role: "viewer" });
    await addMember(db, orgs.beta!.scope, { userId: user.id, role: "admin" });
    await db.run((h) =>
      h.orm.insert(schema.githubIdentities).values({
        githubUserId: "9001",
        userId: user.id,
        login: "pat",
        avatarUrl: AVATAR,
        avatarSyncedAt: 1,
      }),
    );
    const cookie = "cookie-for-pat";
    const sessions = {
      resolve: async (c: string) => (c === cookie ? { userId: user.id, hash: "h" } : undefined),
    } as unknown as WebSessions;
    const env = { db, registry, sessions };
    const web: Credential = { kind: "session", cookie };
    const feed = async (cred: Credential, input: Record<string, unknown> = {}) => {
      const r = await dispatch(env, cred, "my_activity_feed", input);
      if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
      return r.output as { runs: Record<string, any>[]; next_cursor: string | null };
    };
    return { db, orgs, runIds, user, web, feed, env };
  }

  test("a person in two orgs sees both and nothing from a third", async () => {
    const w = await world();
    const out = await w.feed(w.web, { limit: 100 });
    const seenOrgs = new Set(out.runs.map((r) => r.org));
    expect([...seenOrgs].toSorted()).toEqual(["alpha", "beta"]);
    expect(out.runs).toHaveLength(6);
    for (const id of w.runIds.gamma!) expect(out.runs.map((r) => r.run_id)).not.toContain(id);
    expect(JSON.stringify(out)).not.toContain("gamma");
    // Newest first.
    const ids = out.runs.map((r) => r.run_id);
    expect(ids).toEqual([...ids].toSorted().toReversed());
  });

  test("naming a third org is refused exactly like one that does not exist", async () => {
    const w = await world();
    const third = await dispatch(w.env, w.web, "my_activity_feed", { org: "gamma" });
    const none = await dispatch(w.env, w.web, "my_activity_feed", { org: "nope-nope" });
    expect(third.ok).toBe(false);
    expect(none.ok).toBe(false);
    if (!third.ok && !none.ok) {
      expect(third.error.code).toBe("not_found");
      expect(third.error.message).toBe(none.error.message);
    }
  });

  test("membership is read on every call: a new org appears, a removed one goes", async () => {
    const w = await world();
    expect((await w.feed(w.web, { limit: 100 })).runs).toHaveLength(6);
    await addMember(w.db, w.orgs.gamma!.scope, { userId: w.user.id, role: "viewer" });
    expect((await w.feed(w.web, { limit: 100 })).runs).toHaveLength(9);
    await w.db.run((h) =>
      h.orm
        .delete(schema.orgMembers)
        .where(
          and(
            eq(schema.orgMembers.orgId, w.orgs.alpha!.id),
            eq(schema.orgMembers.userId, w.user.id),
          ),
        ),
    );
    const out = await w.feed(w.web, { limit: 100 });
    expect(new Set(out.runs.map((r) => r.org))).toEqual(new Set(["beta", "gamma"]));
  });

  test("filters: org, project, status", async () => {
    const w = await world();
    const alpha = await w.feed(w.web, { org: "alpha", limit: 100 });
    expect(alpha.runs.every((r) => r.org === "alpha")).toBe(true);
    expect(alpha.runs).toHaveLength(3);
    expect((await w.feed(w.web, { project: "app", limit: 100 })).runs).toHaveLength(6);
    expect((await w.feed(w.web, { project: "other", limit: 100 })).runs).toHaveLength(0);

    const [r0, r1] = w.runIds.alpha!;
    await setRunStatus(w.db, w.orgs.alpha!.scope, r0!, "running");
    await setRunStatus(w.db, w.orgs.alpha!.scope, r1!, "failure");
    const running = await w.feed(w.web, { status: "running", limit: 100 });
    // Everything else is still queued, which counts as in progress; the failed one does not.
    expect(running.runs.map((r) => r.run_id)).not.toContain(r1);
    expect(running.runs.find((r) => r.run_id === r0)).toMatchObject({
      state: "running",
      conclusion: null,
    });
    const failed = await w.feed(w.web, { status: "failed", limit: 100 });
    expect(failed.runs).toHaveLength(1);
    expect(failed.runs[0]).toMatchObject({
      run_id: r1,
      state: "completed",
      conclusion: "failure",
    });
  });

  test("cursor pages without gaps or repeats", async () => {
    const w = await world();
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const out = await w.feed(w.web, { limit: 4, ...(cursor ? { cursor } : {}) });
      seen.push(...out.runs.map((r) => r.run_id));
      if (!out.next_cursor) break;
      cursor = out.next_cursor;
    }
    const all = (await w.feed(w.web, { limit: 100 })).runs.map((r) => r.run_id);
    expect(seen).toEqual(all);
    expect(new Set(seen).size).toBe(6);
    const bad = await dispatch(w.env, w.web, "my_activity_feed", { cursor: "not-a-cursor" });
    expect(bad.ok).toBe(false);
  });

  test("a row carries the fields, short ref names, and avatars only from the visible orgs", async () => {
    const w = await world();
    await upsertInstallation(
      w.db,
      { orgId: w.orgs.alpha!.id },
      {
        installationId: "11",
        appId: "1",
        accountLogin: "alpha-actor",
        accountId: "5",
        accountType: "Organization",
        repositorySelection: "all",
        status: "active",
        avatarUrl: AVATAR,
      },
    );
    const out = await w.feed(w.web, { org: "alpha", limit: 100 });
    const tag = out.runs.find((r) => r.ref_type === "tag")!;
    expect(tag.ref).toBe("v1.0.0");
    expect(out.runs.find((r) => r.ref_type === "branch")!.ref).toBe("main");
    expect(tag).toMatchObject({
      org: "alpha",
      project: "app",
      event: "push",
      org_avatar_url: AVATAR,
      actor_avatar_url: AVATAR,
      state: "queued",
      conclusion: null,
      finished_at: null,
    });
    expect(Object.keys(tag)).toEqual(
      expect.arrayContaining([
        "run_id",
        "org",
        "project",
        "workflow",
        "ref",
        "sha",
        "event",
        "actor",
        "actor_avatar_url",
        "state",
        "conclusion",
        "started_at",
        "finished_at",
      ]),
    );
    const beta = await w.feed(w.web, { org: "beta", limit: 100 });
    expect(beta.runs.every((r) => r.org_avatar_url === null)).toBe(true);
  });

  test("hostile forge text comes back as plain data, untouched", async () => {
    const w = await world();
    const run = await createRun(w.db, w.orgs.alpha!.scope, {
      workflowPath: ".github/workflows/x.yml",
      event: "push",
      ref: `refs/heads/${HOSTILE}`,
      sha: "f".repeat(40),
      workflowName: HOSTILE,
      commitMessage: HOSTILE,
    });
    const out = await w.feed(w.web, { limit: 1 });
    expect(out.runs[0]).toMatchObject({
      run_id: run.id,
      workflow: HOSTILE,
      ref: HOSTILE,
      commit_message: HOSTILE,
    });
  });

  test("a token gets its own org only (a token holds no memberships)", async () => {
    const w = await world();
    const t = await mintToken(w.db, { orgId: w.orgs.gamma!.id }, "reader");
    const out = await w.feed({ kind: "bearer", token: t.secret }, { limit: 100 });
    expect(new Set(out.runs.map((r) => r.org))).toEqual(new Set(["gamma"]));
    const other = await dispatch(w.env, { kind: "bearer", token: t.secret }, "my_activity_feed", {
      org: "alpha",
    });
    expect(other.ok).toBe(false);
  });

  test("a person with no memberships, and a signed-out caller, get nothing", async () => {
    const w = await world();
    const loner = await createUser(w.db, { displayName: "nobody" });
    const out = await w.feed({
      kind: "principal",
      principal: { kind: "session", id: loner.id, orgId: w.orgs.alpha!.id, role: "viewer" },
    });
    expect(out.runs).toEqual([]);
    const anon = await dispatch(
      w.env,
      { kind: "session", cookie: "wrong" },
      "my_activity_feed",
      {},
    );
    expect(anon.ok).toBe(false);
  });

  test("an account session cannot reach any other org op", async () => {
    const w = await world();
    const r = await dispatch(w.env, w.web, "list_runs", {});
    // A multi-org session without an org is still asked to name one, as before.
    expect(r.ok).toBe(false);
  });
});
