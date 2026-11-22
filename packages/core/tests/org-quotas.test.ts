import { beforeEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendLog,
  claimNextAttempt,
  createAttempt,
  createJob,
  createOrg,
  createRun,
  getOrgBySlug,
  openDatabase,
  type Db,
  getOrgQuotas,
  listEvents,
  quotaStatuses,
  quotaUsage,
  recordArtifact,
  setOrgQuotas,
} from "../src/db";
import * as s from "../src/db/schema";
import { dispatch, registry } from "../src/ops";
import { parseLimit, quotasCommand } from "../src/quotas/cli";
import { mcpTools } from "../src/ops/mcp";
import { mintToken, seedWorld, type Tenant } from "./ops-helpers";

let db: Db;
let a: Tenant;
let b: Tenant;
const NOW = 1_800_000_000_000;
const MIN = 60_000;

beforeEach(async () => {
  ({ db, a, b } = await seedWorld());
  // seedWorld leaves one queued-or-running attempt per tenant: start from a clean slate.
  await db.run(async (h) => {
    await h.orm.run(
      sql`update job_attempts set state = 'success', started_at = null, finished_at = null`,
    );
    await h.orm.run(sql`update jobs set state = 'success'`);
  });
});

/** A queued job (a run of its own) for the tenant. */
async function queued(t: Tenant, tag: string) {
  const run = await createRun(db, t.scope, {
    workflowPath: ".github/workflows/ci.yml",
    event: "push",
    ref: "refs/heads/main",
    sha: tag.padEnd(40, "0").slice(0, 40),
    repo: "acme/web",
  });
  const job = (await createJob(db, t.scope, { runId: run.id, jobKey: "j", name: "j" }))!;
  const attempt = (await createAttempt(db, t.scope, { jobId: job.id, provider: "test" }))!;
  return { run, job, attempt };
}
/** A finished attempt that used `minutes` of sandbox time ending `agoMs` before NOW. */
async function usedMinutes(t: Tenant, minutes: number, agoMs = 0) {
  const x = await queued(t, `u${minutes}${agoMs}`);
  await db.run(async (h) => {
    await h.orm
      .update(s.jobAttempts)
      .set({ state: "success", startedAt: NOW - agoMs - minutes * MIN, finishedAt: NOW - agoMs })
      .where(eq(s.jobAttempts.id, x.attempt.id));
    await h.orm.update(s.jobs).set({ state: "success" }).where(eq(s.jobs.id, x.job.id));
  });
}
const claim = (perOrgCap = 5) =>
  claimNextAttempt(db, { owner: "w", leaseMs: 10_000, now: NOW, globalCap: 50, perOrgCap });
const set = (t: Tenant, patch: Parameters<typeof setOrgQuotas>[2]) =>
  setOrgQuotas(db, t.orgId, patch, "test", NOW);
const statuses = async (t: Tenant) =>
  quotaStatuses(await getOrgQuotas(db, t.orgId), await quotaUsage(db, t.orgId, NOW));

describe("quota enforcement at claim", () => {
  test("a stored concurrency limit lowers the instance cap for that org only, and never raises it", async () => {
    await set(a, { maxConcurrent: 1 });
    await queued(a, "a1");
    await queued(a, "a2");
    await queued(b, "b1");
    await queued(b, "b2");
    const got: string[] = [];
    for (let i = 0; i < 6; i++) {
      const c = await claim(3);
      if (c) got.push(c.scope.orgId);
    }
    // a is held to 1 running, b to the instance cap of 3 (it has only 2 queued).
    expect(got.filter((o) => o === a.orgId)).toHaveLength(1);
    expect(got.filter((o) => o === b.orgId)).toHaveLength(2);
  });

  test("a row that says more than the instance cap is clamped to the cap", async () => {
    await set(a, { maxConcurrent: 50 });
    for (let i = 0; i < 4; i++) await queued(a, `c${i}`);
    const got: string[] = [];
    for (let i = 0; i < 6; i++) {
      const c = await claim(2);
      if (c) got.push(c.scope.orgId);
    }
    expect(got).toHaveLength(2);
  });

  test("sandbox minutes: past the daily limit new claims are held with a clear reason, and others are not", async () => {
    await set(a, { maxSandboxMinutesPerDay: 60 });
    await usedMinutes(a, 59);
    await queued(a, "a1");
    expect((await claim())?.scope.orgId).toBe(a.orgId); // 59 of 60: still claimable
    await usedMinutes(a, 2, 30 * MIN);
    await queued(a, "a2");
    expect(await claim()).toBeUndefined(); // over the limit now
    const st = (await statuses(a)).find((x) => x.metric === "sandbox_minutes")!;
    expect(st.held).toContain("sandbox minutes in the last 24 hours reached its limit");
    // Another org is unaffected; usage older than a day does not count.
    await queued(b, "b1");
    expect((await claim())?.scope.orgId).toBe(b.orgId);
    await set(a, { maxSandboxMinutesPerDay: 10_000 });
    expect((await claim())?.scope.orgId).toBe(a.orgId);
  });

  test("usage older than 24 hours does not count; a running attempt counts to now", async () => {
    await usedMinutes(a, 30, 25 * 60 * MIN);
    expect((await quotaUsage(db, a.orgId, NOW)).sandboxMinutesLastDay).toBe(0);
    const x = await queued(a, "run");
    await db.run(async (h) => {
      await h.orm
        .update(s.jobAttempts)
        .set({ state: "running", startedAt: NOW - 45 * MIN })
        .where(eq(s.jobAttempts.id, x.attempt.id));
    });
    expect((await quotaUsage(db, a.orgId, NOW)).sandboxMinutesLastDay).toBe(45);
  });

  test("runs per hour: new runs wait, a run that already started finishes its jobs", async () => {
    await set(a, { maxRunsPerHour: 1 });
    const first = await queued(a, "r1");
    const second = await queued(a, "r2");
    const c1 = await claim();
    expect(c1?.attempt.id).toBe(first.attempt.id);
    await db.run(async (h) => {
      await h.orm
        .update(s.jobAttempts)
        .set({ startedAt: NOW, state: "success", finishedAt: NOW })
        .where(eq(s.jobAttempts.id, first.attempt.id));
      await h.orm.update(s.jobs).set({ state: "success" }).where(eq(s.jobs.id, first.job.id));
    });
    // The second run is held; a second job of the first run is not.
    expect(await claim()).toBeUndefined();
    const sibling = (await createJob(db, a.scope, {
      runId: first.run.id,
      jobKey: "k",
      name: "k",
    }))!;
    const sibAttempt = (await createAttempt(db, a.scope, { jobId: sibling.id, provider: "test" }))!;
    expect((await claim())?.attempt.id).toBe(sibAttempt.id);
    expect(second.attempt.id).not.toBe(sibAttempt.id);
  });

  test("log bytes and artifact bytes hold new claims once the limit is reached", async () => {
    await set(a, { maxLogBytes: 100 });
    const x = await queued(a, "logs");
    await appendLog(db, a.scope, x.attempt.id, 0, new Uint8Array(150));
    await queued(a, "after");
    expect(await claim()).toBeUndefined();
    expect((await statuses(a)).find((st) => st.metric === "log_bytes")).toMatchObject({
      used: 150,
      limit: 100,
      percent: 150,
    });
    await set(a, { maxLogBytes: null, maxStoredBytes: 10 });
    expect((await claim())?.scope.orgId).toBe(a.orgId);
    const y = await queued(a, "art");
    await recordArtifact(db, a.scope, {
      runId: y.run.id,
      attemptId: y.attempt.id,
      name: "big",
      sha256: "a".repeat(64),
      size: 50,
    });
    await queued(a, "later");
    expect(await claim()).toBeUndefined();
    expect((await statuses(a)).find((st) => st.metric === "stored_bytes")?.held).toContain(
      "stored artifact and cache bytes",
    );
    // Cache entries count toward the same figure.
    await db.run(async (h) => {
      await h.orm.insert(s.cacheEntries).values({
        orgId: a.orgId,
        projectId: a.projectId,
        klass: "protected",
        refScope: "-",
        key: "k",
        version: "v",
        size: 7,
        complete: 1,
        createdAt: NOW,
        usedAt: NOW,
      });
    });
    expect((await quotaUsage(db, a.orgId, NOW)).storedBytes).toBe(57);
  });
});

describe("notices", () => {
  test("80% and 100% each fire once per window, as events, and re-arm for the next window", async () => {
    await set(a, { maxSandboxMinutesPerDay: 100 });
    await usedMinutes(a, 85);
    await queued(a, "q");
    await claim();
    await claim();
    let ev = (await listEvents(db, { orgId: a.orgId }, { after: 0, limit: 100 })).filter((e) =>
      e.payload.includes("quota_"),
    );
    expect(ev.map((e) => JSON.parse(e.payload).error_class)).toEqual(["quota_warning"]);
    await usedMinutes(a, 20, 10 * MIN);
    await queued(a, "q2");
    await claim();
    await claim();
    ev = (await listEvents(db, { orgId: a.orgId }, { after: 0, limit: 100 })).filter((e) =>
      e.payload.includes("quota_"),
    );
    expect(ev.map((e) => JSON.parse(e.payload).error_class)).toEqual([
      "quota_warning",
      "quota_reached",
    ]);
    expect(JSON.parse(ev[1]!.payload)).toMatchObject({ metric: "sandbox_minutes", limit: 100 });
    // Only a's events, never b's.
    expect(
      (await listEvents(db, { orgId: b.orgId }, { after: 0, limit: 100 })).filter((e) =>
        e.payload.includes("quota_"),
      ),
    ).toEqual([]);
  });
});

describe("who can read and set quotas", () => {
  test("an org-level reader reads them; a project-scoped token or a named project is refused; the other org sees none of it", async () => {
    await set(a, { maxConcurrent: 3 });
    const reader = (await mintToken(db, { orgId: a.orgId }, "reader")).secret;
    const projectTok = (await mintToken(db, a.scope, "reader")).secret;
    const env = { registry, db, now: () => NOW };
    const call = (tok: string, name: string, input: unknown) =>
      dispatch(env, { kind: "bearer", token: tok }, name, input);
    const got = await call(reader, "get_quotas", {});
    expect(got.ok && (got.output as any).limits.max_concurrent).toBe(3);
    expect(
      got.ok && (got.output as any).usage.find((u: any) => u.metric === "concurrent"),
    ).toMatchObject({
      limit: 3,
    });
    const scoped = await call(projectTok, "get_quotas", {});
    expect(!scoped.ok && scoped.error.code).toBe("forbidden");
    expect(!scoped.ok && scoped.error.message).toContain("org-level token");
    const named = await call(reader, "get_quotas", { project: a.projectSlug });
    expect(!named.ok && named.error.code).toBe("forbidden");
    const other = (await mintToken(db, { orgId: b.orgId }, "reader")).secret;
    const theirs = await call(other, "get_quotas", {});
    expect(theirs.ok && (theirs.output as any).limits.max_concurrent).toBeNull();
  });

  test("there is no operation that sets quotas: not for an operator token, not over MCP, not over REST", async () => {
    expect(registry.ops.map((o) => o.name)).not.toContain("set_quotas");
    const op = (await mintToken(db, { orgId: a.orgId }, "operator")).secret;
    const env = { registry, db, now: () => NOW };
    const r = await dispatch(env, { kind: "bearer", token: op }, "set_quotas", {
      max_concurrent: 99,
    });
    expect(r.ok).toBe(false);
    expect(await getOrgQuotas(db, a.orgId)).toMatchObject({ maxConcurrent: null });
    const names = mcpTools(registry).map((t) => t.name);
    expect(names).toContain("get_quotas");
    expect(names).not.toContain("set_quotas");
  });
});

describe("the host command sets them", () => {
  test("longshore quotas set changes only the named limits, none removes one, and show prints usage", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ls-quotas-host-"));
    try {
      const file = openDatabase(join(dir, "longshore.db"));
      await createOrg(file, { slug: "acme", name: "Acme" });
      file.close();
      const logs: string[] = [];
      const log = console.log;
      const err = console.error;
      console.log = (m: string) => void logs.push(String(m));
      console.error = (m: string) => void logs.push(String(m));
      try {
        const base = ["--org", "acme", "--data-dir", dir];
        expect(
          await quotasCommand(["set", ...base, "--max-concurrent", "3", "--max-log-bytes", "100"]),
        ).toBe(0);
        expect(logs.join("\n")).toContain("of 3");
        logs.length = 0;
        expect(await quotasCommand(["set", ...base, "--max-log-bytes", "none"])).toBe(0);
        expect(await quotasCommand(["show", ...base])).toBe(0);
        const text = logs.join("\n");
        expect(text).toContain("concurrent");
        expect(text).toContain("of 3");
        expect(text).toContain("log_bytes");
        expect(await quotasCommand(["set", ...base])).toBe(1); // names nothing
        expect(await quotasCommand(["set", ...base, "--max-concurrent=-1"])).toBe(1);
        expect(
          await quotasCommand(["set", "--org", "nope", "--data-dir", dir, "--max-concurrent", "1"]),
        ).toBe(1);
        expect(await quotasCommand(["frob"])).toBe(2);
      } finally {
        console.log = log;
        console.error = err;
      }
      const check = openDatabase(join(dir, "longshore.db"));
      const org = (await getOrgBySlug(check, "acme"))!;
      expect(await getOrgQuotas(check, org.id)).toMatchObject({
        maxConcurrent: 3,
        maxLogBytes: null,
      });
      check.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("limits are whole numbers or none", () => {
    expect(parseLimit("x", "5")).toBe(5);
    expect(parseLimit("x", "none")).toBeNull();
    for (const bad of ["-1", "1.5", "abc", "", "1e3"])
      expect(() => parseLimit("x", bad), bad).toThrow();
  });
});
