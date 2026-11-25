// #598: the quota's sandbox minutes and `instance_run_summary` use one function, and count only
// real sandbox time. Runs on SQLite and, with TURNTABLE_TEST_DB=pglite, on Postgres.
import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { claimNextAttempt, createAttempt, type Db, openDatabase, setOrgQuotas } from "../src/db";
import * as s from "../src/db/schema";
import { dispatch, registry, type DispatchEnv } from "../src/ops";
import { createInstanceTokenFromCli } from "../src/ops/instance-token-cli";
import { mintToken, seedTenant, type Tenant } from "./ops-helpers";

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.parse("2026-06-10T12:00:00Z");

let db: Db;
let a: Tenant;
let env: DispatchEnv;
let instanceSecret: string;
let reader: string;

beforeEach(async () => {
  db = openDatabase(":memory:");
  a = await seedTenant(db, "org-a");
  env = { registry, db, allowInstance: true, instanceOrgCap: 4, now: () => NOW };
  instanceSecret = (await createInstanceTokenFromCli(db, { name: "ops" })).secret;
  reader = (await mintToken(db, { orgId: a.orgId }, "reader")).secret;
  // seedTenant leaves one attempt with no sandbox: drop it so each test counts only its own.
  await db.orm.delete(s.jobAttempts).where(eq(s.jobAttempts.id, a.attemptId));
});

type Shape = Partial<typeof s.jobAttempts.$inferInsert>;
async function attempt(patch: Shape): Promise<void> {
  const att = (await createAttempt(db, a.scope, { jobId: a.jobId, provider: "test" }))!;
  await db.orm
    .update(s.jobAttempts)
    .set({ state: "failure", ...patch })
    .where(eq(s.jobAttempts.id, att.id));
}

async function quotaMinutes(): Promise<{ used: number; estimated: boolean; held: string | null }> {
  const r = await dispatch(env, { kind: "bearer", token: reader }, "get_quotas", {});
  expect(r.ok).toBe(true);
  const out = (r.ok ? r.output : undefined) as {
    usage: { metric: string; used: number; estimated: boolean; held: string | null }[];
  };
  return out.usage.find((u) => u.metric === "sandbox_minutes")!;
}
async function summaryMinutes(): Promise<number> {
  const r = await dispatch(env, { kind: "bearer", token: instanceSecret }, "instance_run_summary", {
    since: "24h",
  });
  expect(r.ok).toBe(true);
  const out = (r.ok ? r.output : undefined) as { orgs: { org: string; sandbox_minutes: number }[] };
  return out.orgs.find((o) => o.org === "org-a")?.sandbox_minutes ?? 0;
}

describe("one sandbox-minutes figure for quotas and instance_run_summary (#598)", () => {
  test("each attempt shape contributes the same minutes to both", async () => {
    // No sandbox: started and finished, never created one.
    await attempt({ startedAt: NOW - 3 * HOUR, finishedAt: NOW - 2 * HOUR });
    // Created, then failed with no destroy recorded: to the finish, 10 minutes.
    await attempt({
      startedAt: NOW - 2 * HOUR - MIN,
      sandboxCreatedAt: NOW - 2 * HOUR,
      finishedAt: NOW - 2 * HOUR + 10 * MIN,
      sandboxTtlSeconds: 1800,
    });
    // Destroyed: 5 minutes.
    await attempt({
      startedAt: NOW - 100 * MIN,
      sandboxCreatedAt: NOW - 100 * MIN,
      sandboxDestroyedAt: NOW - 95 * MIN,
      finishedAt: NOW - 95 * MIN,
    });
    // Running: to now, 20 minutes (the only estimate).
    await attempt({
      state: "running",
      startedAt: NOW - 20 * MIN,
      sandboxCreatedAt: NOW - 20 * MIN,
    });
    // Spanning the window edge: 25 h to 23 h ago, only the last hour is inside.
    await attempt({
      startedAt: NOW - 25 * HOUR,
      sandboxCreatedAt: NOW - 25 * HOUR,
      sandboxDestroyedAt: NOW - 23 * HOUR,
      finishedAt: NOW - 23 * HOUR,
    });
    const q = await quotaMinutes();
    expect(q.used).toBe(95);
    expect(q.estimated).toBe(true);
    expect(await summaryMinutes()).toBe(95);
  });

  test("a finished attempt with no destroy is not an estimate and never counts to now", async () => {
    await attempt({
      startedAt: NOW - 5 * HOUR,
      sandboxCreatedAt: NOW - 5 * HOUR,
      finishedAt: NOW - 5 * HOUR + 3 * MIN,
    });
    expect(await quotaMinutes()).toMatchObject({ used: 3, estimated: false });
    expect(await summaryMinutes()).toBe(3);
  });

  test("an unfinished attempt that is not running, and a TTL shorter than the span", async () => {
    await attempt({
      state: "infra_error",
      startedAt: NOW - 4 * HOUR,
      sandboxCreatedAt: NOW - 4 * HOUR,
    });
    await attempt({
      startedAt: NOW - 3 * HOUR,
      sandboxCreatedAt: NOW - 3 * HOUR,
      finishedAt: NOW - HOUR,
      sandboxTtlSeconds: 600,
    });
    expect((await quotaMinutes()).used).toBe(10);
    expect(await summaryMinutes()).toBe(10);
  });

  test("the incident shape: many fast-failing attempts do not reach the limit", async () => {
    await setOrgQuotas(db, a.orgId, { maxSandboxMinutesPerDay: 600 }, "test", NOW);
    // 300 attempts that died at checkout seconds after a sandbox was created, no destroy recorded.
    for (let i = 0; i < 300; i++) {
      const t = NOW - 3 * HOUR + i * 20_000;
      await attempt({
        state: "infra_error",
        startedAt: t - 1000,
        sandboxCreatedAt: t,
        finishedAt: t + 5000,
        sandboxTtlSeconds: 1800,
      });
    }
    // 200 more that never created a sandbox.
    for (let i = 0; i < 200; i++) {
      const t = NOW - 2 * HOUR + i * 20_000;
      await attempt({ state: "infra_error", startedAt: t, finishedAt: t + 2000 });
    }
    const q = await quotaMinutes();
    expect(q.used).toBe(25); // 300 x 5 s
    expect(q.held).toBeNull();
    expect(await summaryMinutes()).toBe(25);
    // A queued job is still claimable for the org.
    const claim = () =>
      claimNextAttempt(db, { owner: "w", leaseMs: 10_000, now: NOW, globalCap: 50, perOrgCap: 5 });
    await createAttempt(db, a.scope, { jobId: a.jobId, provider: "test" });
    expect((await claim())?.scope.orgId).toBe(a.orgId);
  });

  test("the hold triggers on real usage", async () => {
    await setOrgQuotas(db, a.orgId, { maxSandboxMinutesPerDay: 60 }, "test", NOW);
    await attempt({
      startedAt: NOW - 3 * HOUR,
      sandboxCreatedAt: NOW - 3 * HOUR,
      sandboxDestroyedAt: NOW - 3 * HOUR + 40 * MIN,
      finishedAt: NOW - 3 * HOUR + 40 * MIN,
    });
    expect((await quotaMinutes()).held).toBeNull();
    await attempt({
      state: "running",
      startedAt: NOW - 25 * MIN,
      sandboxCreatedAt: NOW - 25 * MIN,
    });
    const q = await quotaMinutes();
    expect(q.used).toBe(65);
    expect(q.held).toContain("sandbox minutes in the last 24 hours reached its limit");
  });
});
