// Sandbox time is counted from the provider's create to its confirmed destroy, per org and UTC
// day, exactly. The same numbers back the usage operation and any quota.
import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  createAttempt,
  createJob,
  createProject,
  createRun,
  type Db,
  getAttempt,
  recordExec,
  sandboxSeconds,
  sandboxUsage,
  updateAttempt,
} from "../src/db";
import * as s from "../src/db/schema";
import { dispatch, registry } from "../src/ops";
import { mintToken, seedWorld, type Tenant } from "./ops-helpers";

const DAY = 86_400_000;
/** 2026-11-20T00:00:00Z */
const D0 = Date.UTC(2026, 10, 20);
const at = (day: number, hh: number, mm = 0, ss = 0): number =>
  D0 + day * DAY + ((hh * 60 + mm) * 60 + ss) * 1000;
const NOW = at(2, 12);

let db: Db;
let a: Tenant;
let b: Tenant;
beforeEach(async () => {
  ({ db, a, b } = await seedWorld());
});

/** A new attempt (of the tenant's job) with its sandbox life set, and optionally its finish. */
async function life(
  t: Tenant,
  created: number | null,
  destroyed: number | null,
  finished?: number | null,
): Promise<string> {
  const att = (await createAttempt(db, t.scope, { jobId: t.jobId, provider: "test" }))!;
  if (created !== null || destroyed !== null) {
    await updateAttempt(db, t.scope, att.id, {
      ...(created === null ? {} : { sandboxCreatedAt: created }),
      ...(destroyed === null ? {} : { sandboxDestroyedAt: destroyed }),
    });
  }
  if (finished !== undefined) {
    await db.orm
      .update(s.jobAttempts)
      .set({ finishedAt: finished })
      .where(eq(s.jobAttempts.id, att.id));
  }
  return att.id;
}

const win = (fromDay: number, toDay: number, now = NOW) => ({
  from: at(fromDay, 0),
  to: at(toDay, 0),
  now,
});

describe("what is counted", () => {
  test("create to confirmed destroy, to the millisecond, in minutes and seconds", async () => {
    await life(a, at(0, 10, 0, 0) + 250, at(0, 10, 7, 30) + 750);
    const [d] = await sandboxUsage(db, a.scope, win(0, 1));
    expect(d).toEqual({
      day: "2026-11-20",
      seconds: 450.5,
      minutes: 7.508,
      attempts: 1,
      estimated: 0,
    });
  });

  test("time waiting for capacity is not counted: the attempt's own duration is not the sandbox's", async () => {
    const id = await life(a, at(0, 10, 30), at(0, 10, 40));
    // the attempt started at 10:00 and waited half an hour for a sandbox
    await db.orm
      .update(s.jobAttempts)
      .set({ startedAt: at(0, 10, 0), finishedAt: at(0, 10, 41) })
      .where(eq(s.jobAttempts.id, id));
    const [d] = await sandboxUsage(db, a.scope, win(0, 1));
    expect(d!.seconds).toBe(600);
  });

  test("a sandbox that spans midnight is split between the days", async () => {
    await life(a, at(0, 23, 50), at(1, 0, 20));
    const days = await sandboxUsage(db, a.scope, win(0, 2));
    expect(days.map((d) => [d.day, d.seconds, d.minutes, d.attempts])).toEqual([
      ["2026-11-20", 600, 10, 1],
      ["2026-11-21", 1200, 20, 1],
    ]);
  });

  test("days with nothing are listed with zero", async () => {
    const days = await sandboxUsage(db, a.scope, win(0, 3));
    expect(days.map((d) => d.seconds)).toEqual([0, 0, 0]);
  });

  test("without a confirmed destroy the end is the attempt's finish (an estimate); a running one ends now", async () => {
    await life(a, at(0, 8, 0), null, at(0, 8, 30)); // finished, destroy never confirmed
    await life(a, at(2, 11, 0), null); // still running at NOW (12:00)
    const days = await sandboxUsage(db, a.scope, win(0, 3));
    expect(days[0]).toMatchObject({ seconds: 1800, attempts: 1, estimated: 1 });
    expect(days[2]).toMatchObject({ seconds: 3600, attempts: 1, estimated: 1 });
  });

  test("an attempt that never created a sandbox counts for nothing", async () => {
    await life(a, null, null, at(0, 9));
    const [d] = await sandboxUsage(db, a.scope, win(0, 1));
    expect(d).toMatchObject({ seconds: 0, attempts: 0 });
  });

  test("a window clips: what falls outside it is not counted", async () => {
    await life(a, at(0, 22, 0), at(1, 2, 0)); // 4 hours across midnight
    const from = at(1, 0);
    const t = await sandboxSeconds(db, a.scope, { from, to: at(1, 1), now: NOW });
    expect(t.seconds).toBe(3600);
    expect(
      (await sandboxSeconds(db, a.scope, { from: at(1, 2), to: at(1, 5), now: NOW })).seconds,
    ).toBe(0);
    expect(
      (await sandboxSeconds(db, a.scope, { from: at(0, 0), to: at(2, 0), now: NOW })).seconds,
    ).toBe(14_400);
  });

  test("the total over a window equals the sum of its days", async () => {
    await life(a, at(0, 23, 0), at(1, 1, 0));
    await life(a, at(1, 5, 0), at(1, 5, 45));
    const days = await sandboxUsage(db, a.scope, win(0, 2));
    const total = await sandboxSeconds(db, a.scope, win(0, 2));
    expect(total.seconds).toBe(days.reduce((n, d) => n + d.seconds, 0));
    expect(total.seconds).toBe(3600 + 3600 + 2700);
  });
});

describe("whose time", () => {
  test("another org's sandboxes are never counted", async () => {
    await life(a, at(0, 10), at(0, 11));
    await life(b, at(0, 10), at(0, 12));
    expect((await sandboxUsage(db, a.scope, win(0, 1)))[0]!.seconds).toBe(3600);
    expect((await sandboxUsage(db, b.scope, win(0, 1)))[0]!.seconds).toBe(7200);
  });

  test("an org-level scope counts every project; a project scope only its own", async () => {
    const proj = await createAttempt(db, a.scope, { jobId: a.jobId, provider: "test" });
    await updateAttempt(db, a.scope, proj!.id, {
      sandboxCreatedAt: at(0, 9),
      sandboxDestroyedAt: at(0, 9, 10),
    });
    const orgWide = await sandboxSeconds(db, { orgId: a.orgId }, win(0, 1));
    expect(orgWide.seconds).toBe(600);
    expect((await sandboxSeconds(db, a.scope, win(0, 1))).seconds).toBe(600);
    expect((await sandboxSeconds(db, b.scope, win(0, 1))).seconds).toBe(0);
  });
});

describe("recording", () => {
  test("a worker may record the create and the destroy only for an attempt it holds", async () => {
    // the seeded attempt is queued: nobody holds it, so a fenced write is refused
    expect(
      await recordExec(db, a.scope, a.attemptId, "someone", {
        sandboxId: "sb",
        sandboxCreatedAt: 5,
      }),
    ).toBe(false);
    expect((await getAttempt(db, a.scope, a.attemptId))!.sandboxCreatedAt).toBeNull();
  });

  test("a finished attempt's event carries both times when known, and null when not", async () => {
    const id = await life(a, at(0, 10), at(0, 10, 5));
    await updateAttempt(db, a.scope, id, { state: "running" });
    await updateAttempt(db, a.scope, id, { state: "success", exitCode: 0 });
    const id2 = await life(a, null, null);
    await updateAttempt(db, a.scope, id2, { state: "running" });
    await updateAttempt(db, a.scope, id2, { state: "infra_error", errorClass: "x" });
    const events = (await db.orm.select().from(s.events)).filter(
      (e) => e.type === "job.state_changed" && JSON.parse(e.payload ?? "{}").level === "attempt",
    );
    const done = events.find((e) => e.attemptId === id && JSON.parse(e.payload!).to === "success")!;
    expect(JSON.parse(done.payload!)).toMatchObject({
      sandbox_created_at: new Date(at(0, 10)).toISOString(),
      sandbox_destroyed_at: new Date(at(0, 10, 5)).toISOString(),
    });
    const lost = events.find(
      (e) => e.attemptId === id2 && JSON.parse(e.payload!).to === "infra_error",
    )!;
    expect(JSON.parse(lost.payload!)).toMatchObject({
      sandbox_created_at: null,
      sandbox_destroyed_at: null,
    });
  });
});

describe("the operation", () => {
  test("sandbox_usage: a reader sees their own org's days, the total and the estimates", async () => {
    await life(a, at(2, 9), at(2, 9, 30)); // today (NOW is day 2, 12:00)
    await life(a, at(1, 23, 30), at(2, 0, 30)); // across yesterday and today
    await life(b, at(2, 9), at(2, 11));
    const tok = (await mintToken(db, a.scope, "reader")).secret;
    const r = await dispatch(
      { registry, db, now: () => NOW },
      { kind: "bearer", token: tok },
      "sandbox_usage",
      {
        days: 3,
      },
    );
    expect(r.ok).toBe(true);
    const out = (r as { output: any }).output;
    expect(out.days.map((d: any) => d.day)).toEqual(["2026-11-20", "2026-11-21", "2026-11-22"]);
    expect(out.days.map((d: any) => d.sandbox_seconds)).toEqual([0, 1800, 1800 + 1800]);
    expect(out.days[2]).toMatchObject({ sandbox_minutes: 60, attempts: 2, estimated_attempts: 0 });
    expect(out.total_seconds).toBe(5400);
    expect(out.total_minutes).toBe(90);
  });

  test("the default is seven days, the bounds are enforced, and it is a read-only MCP tool", async () => {
    const tok = (await mintToken(db, a.scope, "reader")).secret;
    const env = { registry, db, now: () => NOW };
    const r = await dispatch(env, { kind: "bearer", token: tok }, "sandbox_usage", {});
    expect((r as { output: any }).output.days).toHaveLength(7);
    for (const days of [0, 93, 1.5]) {
      const bad = await dispatch(env, { kind: "bearer", token: tok }, "sandbox_usage", { days });
      expect(bad.ok).toBe(false);
    }
    expect(registry.get("sandbox_usage")).toMatchObject({ effect: "read", mcp: true });
  });
});

describe("an attempt with no recorded create time", () => {
  test("is counted from when it started, per day and for a limit, and marked estimated", async () => {
    const id = await life(a, null, null, at(0, 10, 30));
    await db.orm
      .update(s.jobAttempts)
      .set({ startedAt: at(0, 10, 0) })
      .where(eq(s.jobAttempts.id, id));
    const [d] = await sandboxUsage(db, a.scope, win(0, 1));
    expect(d).toMatchObject({ seconds: 1800, attempts: 1, estimated: 1 });
    // The same fallback for a limit, which also adds the provider TTL for the missing destroy.
    const lim = await sandboxSeconds(db, a.scope, {
      from: at(0, 0),
      to: at(1, 0),
      now: at(1, 0),
      graceMs: 30 * 60_000,
    });
    expect(lim).toEqual({ seconds: 3600, estimated: 1 });
  });

  test("one that never started and has no sandbox is not counted", async () => {
    await life(a, null, null);
    const [d] = await sandboxUsage(db, a.scope, win(0, 1));
    expect(d).toMatchObject({ seconds: 0, attempts: 0, estimated: 0 });
  });
});

describe("group_by project", () => {
  /** A second project in tenant a, with its own job, so its attempts are a different project's. */
  async function secondProject(): Promise<Tenant> {
    const project = await createProject(db, { orgId: a.orgId }, { slug: "site", name: "Site" });
    const scope = { orgId: a.orgId, projectId: project.id };
    const run = await createRun(db, scope, {
      workflowPath: ".github/workflows/ci.yml",
      event: "push",
      ref: "refs/heads/main",
      sha: "b".repeat(40),
    });
    const job = (await createJob(db, scope, { runId: run.id, jobKey: "build", name: "build" }))!;
    return {
      ...a,
      projectId: project.id,
      projectSlug: "site",
      runId: run.id,
      jobId: job.id,
      scope,
    };
  }
  const env = () => ({ registry, db, now: () => NOW });
  const call = (tok: string, input: Record<string, unknown>) =>
    dispatch(env(), { kind: "bearer", token: tok }, "sandbox_usage", input);

  test("the projects add up to the org total, day by day", async () => {
    const p2 = await secondProject();
    await life(a, at(2, 9), at(2, 9, 30)); // app, 1800 s today
    await life(p2, at(2, 10), at(2, 10, 20)); // site, 1200 s today
    await life(p2, at(1, 23, 30), at(2, 0, 30)); // site, across yesterday and today
    await life(p2, at(2, 11), null); // site, no confirmed destroy: estimated (finish unset, so now)
    await life(b, at(2, 9), at(2, 11)); // another org, never counted
    const tok = (await mintToken(db, { orgId: a.orgId }, "reader")).secret;
    const r = await call(tok, { days: 3, group_by: "project" });
    const out = (r as { output: any }).output;
    expect(out.projects.map((p: any) => p.project_slug)).toEqual(["app", "site"]);
    for (let i = 0; i < out.days.length; i++) {
      const sum = out.projects.reduce((n: number, p: any) => n + p.days[i].sandbox_seconds, 0);
      expect(sum).toBe(out.days[i].sandbox_seconds);
      const att = out.projects.reduce((n: number, p: any) => n + p.days[i].attempts, 0);
      expect(att).toBe(out.days[i].attempts);
      const est = out.projects.reduce((n: number, p: any) => n + p.days[i].estimated_attempts, 0);
      expect(est).toBe(out.days[i].estimated_attempts);
    }
    expect(out.projects.reduce((n: number, p: any) => n + p.total_seconds, 0)).toBe(
      out.total_seconds,
    );
    const site = out.projects.find((p: any) => p.project_slug === "site");
    expect(site.days[2].estimated_attempts).toBe(1);
    expect(site.project_name).toBe("Site");
  });

  test("without group_by there is no projects key", async () => {
    await life(a, at(2, 9), at(2, 9, 30));
    const tok = (await mintToken(db, { orgId: a.orgId }, "reader")).secret;
    const out = ((await call(tok, { days: 1 })) as { output: any }).output;
    expect("projects" in out).toBe(false);
  });

  test("a project token sees only its own project, and another org's token sees nothing of it", async () => {
    const p2 = await secondProject();
    await life(a, at(2, 9), at(2, 9, 30));
    await life(p2, at(2, 10), at(2, 10, 20));
    const own = (await mintToken(db, p2.scope, "reader")).secret;
    const out = ((await call(own, { days: 1, group_by: "project" })) as { output: any }).output;
    expect(out.projects.map((p: any) => p.project_slug)).toEqual(["site"]);
    expect(out.total_seconds).toBe(1200);
    const other = (await mintToken(db, { orgId: b.orgId }, "reader")).secret;
    const o = ((await call(other, { days: 1, group_by: "project" })) as { output: any }).output;
    expect(o.projects).toEqual([]);
    expect(o.total_seconds).toBe(0);
  });

  test("an unknown group_by is refused", async () => {
    const tok = (await mintToken(db, { orgId: a.orgId }, "reader")).secret;
    expect((await call(tok, { group_by: "org" })).ok).toBe(false);
  });
});

describe("the grace for an unconfirmed destroy follows the attempt's recorded TTL", () => {
  const limit = (graceMs: number) => ({
    from: at(0, 0),
    to: at(1, 0),
    now: at(1, 0),
    graceMs,
  });
  const FALLBACK = 30 * 60_000;

  test("a 600 s TTL counts the finish plus 600 s", async () => {
    const id = await life(a, at(0, 10), null, at(0, 10, 20));
    await updateAttempt(db, a.scope, id, { sandboxTtlSeconds: 600 });
    expect((await getAttempt(db, a.scope, id))!.sandboxTtlSeconds).toBe(600);
    expect(await sandboxSeconds(db, a.scope, limit(FALLBACK))).toEqual({
      seconds: 30 * 60,
      estimated: 1,
    });
  });

  test("a null TTL uses the fallback constant", async () => {
    await life(a, at(0, 10), null, at(0, 10, 20));
    expect((await sandboxSeconds(db, a.scope, limit(FALLBACK))).seconds).toBe(50 * 60);
  });

  test("a confirmed destroy uses the destroy time, whatever the TTL", async () => {
    const id = await life(a, at(0, 10), at(0, 10, 25), at(0, 10, 20));
    await updateAttempt(db, a.scope, id, { sandboxTtlSeconds: 600 });
    expect(await sandboxSeconds(db, a.scope, limit(FALLBACK))).toEqual({
      seconds: 25 * 60,
      estimated: 0,
    });
  });

  test("a short TTL also drops the attempt from a window its grace no longer reaches", async () => {
    const id = await life(a, at(0, 10), null, at(0, 10, 20));
    await updateAttempt(db, a.scope, id, { sandboxTtlSeconds: 600 });
    // From 10:35: the finish plus 600 s ended at 10:30, plus the 30 min fallback would still reach.
    const w = { from: at(0, 10, 35), to: at(1, 0), now: at(1, 0), graceMs: FALLBACK };
    expect((await sandboxSeconds(db, a.scope, w)).seconds).toBe(0);
  });

  test("the usage page (no grace) ignores the TTL", async () => {
    const id = await life(a, at(0, 10), null, at(0, 10, 20));
    await updateAttempt(db, a.scope, id, { sandboxTtlSeconds: 600 });
    expect((await sandboxSeconds(db, a.scope, win(0, 1))).seconds).toBe(20 * 60);
  });
});
