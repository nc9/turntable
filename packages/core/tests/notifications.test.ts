// Per-user notifications (#611): rules fire once, coalesce, honour prefs, and never cross orgs.
import { afterAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import type { WebSessions } from "../src/auth/web-sessions";
import {
  addMember,
  appendEvent,
  createJob,
  createOrg,
  createProject,
  createRun,
  createUser,
  type Db,
  openDatabase,
  schema,
  setRunStatus,
} from "../src/db";
import { testDb } from "../src/db/dialect";
import { openPostgres } from "../src/db/pg";
import { NotificationEngine, prefEnabled, safeTitle } from "../src/notifications/rules";
import { dispatch, registry, type Credential } from "../src/ops";

const pgTarget = (): Parameters<typeof openPostgres>[0] => {
  const t = testDb();
  return t && t !== "pglite" ? { url: t, schema: `lstest_notif_${process.pid}` } : { pglite: true };
};
const opened: Db[] = [];
afterAll(() => {
  for (const db of opened) db.close();
});
const dialects: [string, () => Db][] = [
  ["sqlite", () => openDatabase(":memory:")],
  ["postgres", () => openPostgres(pgTarget(), { fresh: true })],
];
const TRUST = (klass: string) => JSON.stringify({ class: klass, workflowHash: "w" });

describe("safeTitle", () => {
  test("escapes markup, keeps the first line, truncates", () => {
    expect(safeTitle("<img src=x onerror=alert(1)>\nsecond")).toBe(
      "&lt;img src=x onerror=alert(1)&gt;",
    );
    expect(safeTitle("a".repeat(500)).length).toBeLessThanOrEqual(80);
    expect(safeTitle("x\u0007y‮z")).not.toContain("\u0007");
  });
  test("prefs: project beats org beats all beats default", () => {
    const row = (orgId: string, projectId: string, enabled: boolean) =>
      ({ userId: "u", orgId, projectId, kind: "run_failed", enabled, updatedAt: 0 }) as const;
    expect(prefEnabled([], "run_failed", "o", "p")).toBe(true);
    expect(prefEnabled([row("", "", false)], "run_failed", "o", "p")).toBe(false);
    expect(prefEnabled([row("", "", false), row("o", "", true)], "run_failed", "o", "p")).toBe(
      true,
    );
    expect(prefEnabled([row("o", "", true), row("o", "p", false)], "run_failed", "o", "p")).toBe(
      false,
    );
    expect(prefEnabled([], "dogfood_red", "o", null)).toBe(false);
  });
});

describe.each(dialects)("notifications (%s)", (_n, open) => {
  async function world() {
    const db = open();
    opened.push(db);
    const mk = async (slug: string) => {
      const org = await createOrg(db, { slug, name: slug });
      const project = await createProject(db, { orgId: org.id }, { slug: "app", name: "App" });
      return { id: org.id, projectId: project.id, scope: { orgId: org.id, projectId: project.id } };
    };
    const alpha = await mk("alpha");
    const beta = await mk("beta");
    const person = async (name: string, login: string, id: string, orgs: (typeof alpha)[]) => {
      const user = await createUser(db, { displayName: name });
      for (const o of orgs) await addMember(db, o.scope, { userId: user.id, role: "member" });
      await db.run((h) =>
        h.orm.insert(schema.githubIdentities).values({ githubUserId: id, userId: user.id, login }),
      );
      const cookie = `cookie-${name}`;
      return { user, cookie, web: { kind: "session", cookie } as Credential };
    };
    const pat = await person("pat", "pat", "1", [alpha]);
    const sam = await person("sam", "sam", "2", [beta]);
    const sessions = {
      resolve: async (c: string) =>
        c === pat.cookie
          ? { userId: pat.user.id, hash: "h1" }
          : c === sam.cookie
            ? { userId: sam.user.id, hash: "h2" }
            : undefined,
    } as unknown as WebSessions;
    const env = { db, registry, sessions };
    const engine = new NotificationEngine({ db });
    await engine.tick(); // a fresh engine starts at the tip
    const call = async (cred: Credential, op: string, input: Record<string, unknown> = {}) => {
      const r = await dispatch(env, cred, op, input);
      if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
      return r.output as Record<string, any>;
    };
    const failedRun = async (
      o: typeof alpha,
      over: { event?: string; ref?: string; klass?: string; actor?: string; msg?: string } = {},
    ) => {
      const run = await createRun(db, o.scope, {
        workflowPath: ".github/workflows/ci.yml",
        event: over.event ?? "push",
        ref: over.ref ?? "refs/heads/main",
        sha: "a".repeat(40),
        actor: over.actor ?? "someone",
        commitMessage: over.msg ?? "fix <b>thing</b>",
        trust: TRUST(over.klass ?? "protected"),
      });
      await createJob(db, o.scope, { runId: run.id, jobKey: "b", name: "b" });
      await setRunStatus(db, o.scope, run.id, "running");
      await setRunStatus(db, o.scope, run.id, "failure");
      return run;
    };
    return { db, alpha, beta, pat, sam, env, engine, call, failedRun };
  }

  test("a default-branch failure notifies org members once, and only them", async () => {
    const w = await world();
    const run = await w.failedRun(w.alpha, { msg: "<script>x</script>" });
    expect(await w.engine.tick()).toBe(1);
    expect(await w.engine.tick()).toBe(0); // the cursor moved: once
    const mine = await w.call(w.pat.web, "my_notifications", {});
    expect(mine.notifications).toHaveLength(1);
    expect(mine.notifications[0]).toMatchObject({
      kind: "run_failed",
      org: "alpha",
      run_id: run.id,
      project: "app",
    });
    expect(mine.notifications[0].title).toBe("&lt;script&gt;x&lt;/script&gt;");
    expect(mine.unread_count).toBe(1);
    // Another org's failure never reaches a person who is not a member.
    expect((await w.call(w.sam.web, "my_notifications", {})).notifications).toHaveLength(0);
  });

  test("a PR run reaches only its author; a feature branch push reaches no one", async () => {
    const w = await world();
    await w.failedRun(w.alpha, {
      event: "pull_request",
      ref: "refs/pull/3/merge",
      klass: "trusted_pr",
      actor: "someone",
    });
    await w.failedRun(w.alpha, { klass: "trusted_pr", ref: "refs/heads/feat" });
    expect(await w.engine.tick()).toBe(0);
    await w.failedRun(w.alpha, {
      event: "pull_request",
      ref: "refs/pull/4/merge",
      klass: "trusted_pr",
      actor: "PAT",
    });
    expect(await w.engine.tick()).toBe(1);
    expect((await w.call(w.pat.web, "my_notifications", {})).notifications).toHaveLength(1);
  });

  test("infra errors coalesce per project per 30 minutes", async () => {
    const w = await world();
    for (let i = 0; i < 5; i++)
      await appendEvent(w.db, w.alpha.scope, { type: "infra.error", payload: {} });
    await w.engine.tick();
    const out = await w.call(w.pat.web, "my_notifications", { kinds: ["infra_errors"] });
    expect(out.notifications).toHaveLength(1);
    expect(out.notifications[0].count).toBe(5);
  });

  test("work held: quota reached notifies once per window", async () => {
    const w = await world();
    for (let i = 0; i < 3; i++)
      await appendEvent(
        w.db,
        { orgId: w.alpha.id },
        { type: "quota.reached", payload: { metric: "runs_per_hour" } },
      );
    await w.engine.tick();
    const out = await w.call(w.pat.web, "my_notifications", { kinds: ["work_held"] });
    expect(out.notifications).toHaveLength(1);
  });

  test("prefs filter at creation; the choice is scoped to the person", async () => {
    const w = await world();
    await w.call(w.pat.web, "set_notification_prefs", {
      org: "alpha",
      kind: "run_failed",
      enabled: false,
    });
    await w.failedRun(w.alpha);
    await w.engine.tick();
    expect((await w.call(w.pat.web, "my_notifications", {})).notifications).toHaveLength(0);
    const prefs = await w.call(w.pat.web, "get_notification_prefs", { org: "alpha" });
    expect(prefs.prefs).toEqual([{ kind: "run_failed", org: null, project: null, enabled: false }]);
    expect((await w.call(w.sam.web, "get_notification_prefs", { org: "beta" })).prefs).toEqual([]);
    // Naming an org the person is not in reads as not found.
    await expect(
      w.call(w.pat.web, "set_notification_prefs", {
        org: "alpha",
        kind: "run_failed",
        enabled: true,
        scope_org: "beta",
      }),
    ).rejects.toThrow(/not_found/);
  });

  test("ack marks only the caller's own rows; membership is read on every call", async () => {
    const w = await world();
    await w.failedRun(w.alpha);
    await w.failedRun(w.alpha);
    await w.engine.tick();
    const list = await w.call(w.pat.web, "my_notifications", { limit: 1 });
    expect(list.next_cursor).not.toBeNull();
    const page2 = await w.call(w.pat.web, "my_notifications", {
      limit: 1,
      cursor: list.next_cursor,
    });
    expect(page2.notifications).toHaveLength(1);
    // Someone else's ack of those ids changes nothing.
    const other = await w.call(w.sam.web, "notifications_ack", {
      org: "beta",
      ids: [list.notifications[0].id],
    });
    expect(other.acked).toBe(0);
    const mine = await w.call(w.pat.web, "notifications_ack", {
      org: "alpha",
      ids: [list.notifications[0].id],
    });
    expect(mine.acked).toBe(1);
    expect(
      (await w.call(w.pat.web, "my_notifications", { unread: true })).notifications,
    ).toHaveLength(1);
    // Leaving the org takes the rows out of every read, at once.
    await w.db.run((h) =>
      h.orm
        .delete(schema.orgMembers)
        .where(
          and(eq(schema.orgMembers.orgId, w.alpha.id), eq(schema.orgMembers.userId, w.pat.user.id)),
        ),
    );
    const gone = await w.call(w.pat.web, "my_notifications", {});
    expect(gone.notifications).toHaveLength(0);
    expect(gone.unread_count).toBe(0);
  });

  test("approval_waiting reaches only people the approval inbox would list the run for", async () => {
    const w = await world();
    const run = await w.failedRun(w.alpha);
    await appendEvent(w.db, w.alpha.scope, { type: "approval.required", runId: run.id });
    await w.engine.tick();
    // Nobody here holds an approver key, so #546's eligibility lists nobody.
    const out = await w.call(w.pat.web, "my_notifications", { kinds: ["approval_waiting"] });
    expect(out.notifications).toHaveLength(0);
  });

  test("an org token has no inbox", async () => {
    const w = await world();
    const { mintToken } = await import("./ops-helpers");
    const token = await mintToken(w.db, w.alpha.scope, "reader");
    const r = await dispatch(
      w.env,
      { kind: "bearer", token: token.secret },
      "my_notifications",
      {},
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("forbidden");
  });
});
