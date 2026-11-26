// A transient infrastructure failure is retried once (#517): a NEW attempt on a fresh sandbox, at
// most one per job, never for a refusal, a test failure, a cancel or a non-transient kind. Scheduler
// level, against the provider double; each case runs on SQLite and on Postgres (pglite).
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { FakeWorld } from "@turntable/provider-sdk/testing";
import type { Provider } from "@turntable/provider-sdk";
import { type InfraKind, retryableAfterSteps } from "@turntable/act-runner";
import {
  claimNextAttempt,
  createAttempt,
  createJob,
  createOrg,
  createProject,
  createRun,
  type Db,
  getJob,
  listAttempts,
  listAudit,
  listEvents,
  markDrainCut,
  openDatabase,
  requeueLostAttemptOnce,
  type Scope,
} from "../src/db";
import { testDb } from "../src/db/dialect";
import { openPostgres } from "../src/db/pg";
import { DrainState, Scheduler, type AttemptOutcome, type AttemptRunner } from "../src/scheduler";
import { infraRetryLine } from "../src/checks/mapping";

setDefaultTimeout(30_000);

const world = new FakeWorld();
const opened: Db[] = [];
afterAll(() => {
  world.dispose();
  for (const d of opened) d.close();
});

const dialects: [string, () => Db][] = [
  ["sqlite", () => openDatabase(":memory:")],
  [
    "postgres",
    () => {
      const t = testDb();
      return openPostgres(
        t && t !== "pglite"
          ? { url: t, schema: `lstest_infra_retry_${process.pid}` }
          : { pglite: true },
        { fresh: true },
      );
    },
  ],
];

async function setup(open: () => Db) {
  const db = open();
  opened.push(db);
  const org = await createOrg(db, { slug: "org-a", name: "org-a" });
  const project = await createProject(db, { orgId: org.id }, { slug: "app", name: "app" });
  const scope: Required<Scope> = { orgId: org.id, projectId: project.id };
  const run = await createRun(db, scope, {
    workflowPath: "w.yml",
    event: "push",
    ref: "main",
    sha: "a".repeat(40),
  });
  const job = (await createJob(db, scope, { runId: run.id, jobKey: "build", name: "build" }))!;
  const first = (await createAttempt(db, scope, { jobId: job.id, provider: "fake" }))!;
  // A provider that records each sandbox it makes and releases.
  const real = world.provider();
  const made: string[] = [];
  const released: string[] = [];
  const provider: Provider = Object.assign(Object.create(real) as Provider, {
    create: async (spec: Parameters<Provider["create"]>[0]) => {
      const sb = await real.create(spec);
      made.push(sb.id);
      return sb;
    },
    destroy: async (id: string) => {
      await real.destroy(id);
      released.push(id);
    },
  });
  /** Each attempt makes a sandbox, releases it (as executeJob does), then returns the next scripted outcome. */
  const script = (outcomes: AttemptOutcome[], klass = "trusted_pr"): AttemptRunner => {
    let n = 0;
    return async (ctx) => {
      await ctx.store.setTrustClass(klass).catch(() => undefined); // write-once: first attempt only
      const sb = await ctx.provider.create({
        name: `tt-${n}`,
        labels: {},
        image: "img",
        ttlSeconds: 60,
        network: { egress: "none" },
      });
      await ctx.provider.destroy(sb.id);
      return outcomes[Math.min(n++, outcomes.length - 1)]!;
    };
  };
  const sched = (runner: AttemptRunner, drain = new DrainState()) =>
    new Scheduler({
      db,
      runner,
      providers: () => provider,
      globalCap: 5,
      perOrgCap: 5,
      drain,
      infraRetryBackoffMs: 0,
    });
  const drive = async (s: Scheduler): Promise<void> => {
    for (let i = 0; i < 10; i++) {
      const n = await s.tick();
      await s.idle();
      if (n === 0) break;
    }
  };
  return { db, scope, run, job, first, made, released, script, sched, drive };
}

const transient = (kind: InfraKind, reason: string): AttemptOutcome => ({
  state: "infra_error",
  infraKind: kind,
  reason,
});

for (const [name, open] of dialects) {
  describe(`infra retry (${name})`, () => {
    test("a GitHub rate limit requeues the attempt after the reset delay, for every class (#621)", async () => {
      for (const klass of ["protected", "release", "trusted_pr"]) {
        const t = await setup(open);
        const s = t.sched(
          t.script(
            [
              {
                ...transient("github_rate_limited", "rate limited (HTTP 403)"),
                retryAfterMs: 120,
              },
              { state: "success", reason: "ok" },
            ],
            klass,
          ),
        );
        const started = Date.now();
        await t.drive(s);
        const attempts = await listAttempts(t.db, t.scope, t.job.id);
        // Not failed: the first attempt is kept as infra_error, the retry ran and passed.
        expect(attempts.map((a) => a.state)).toEqual(["infra_error", "success"]);
        expect(attempts[0]!.infraKind).toBe("github_rate_limited");
        // The retry waited for the reset, not immediately.
        expect(Date.now() - started).toBeGreaterThanOrEqual(100);
        expect((await getJob(t.db, t.scope, t.job.id))!.state).toBe("success");
      }
    });

    test("an unknown infra error retries once, then fails with both reasons (#670)", async () => {
      const t = await setup(open);
      const s = t.sched(
        t.script([
          transient("unknown", "provider exploded"),
          transient("unknown", "provider exploded again"),
        ]),
      );
      await t.drive(s);
      const attempts = await listAttempts(t.db, t.scope, t.job.id);
      expect(attempts).toHaveLength(2);
      expect(attempts.map((a) => a.infraKind)).toEqual(["unknown", "unknown"]);
      expect(attempts[1]!.errorClass).toContain("provider exploded again");
      expect(attempts[1]!.errorClass).toContain("provider exploded");
      expect((await getJob(t.db, t.scope, t.job.id))?.state).toBe("infra_error");
    });

    test("an unknown infra error retries once, and a later success passes (#670)", async () => {
      const t = await setup(open);
      const s = t.sched(
        t.script([transient("unknown", "odd"), { state: "success", reason: "ok" }]),
      );
      await t.drive(s);
      expect((await listAttempts(t.db, t.scope, t.job.id)).map((a) => a.state)).toEqual([
        "infra_error",
        "success",
      ]);
    });

    test("an unknown infra error is not retried for a release job (steps may have run) (#670)", async () => {
      const t = await setup(open);
      const s = t.sched(t.script([transient("unknown", "odd")], "release"));
      await t.drive(s);
      expect(await listAttempts(t.db, t.scope, t.job.id)).toHaveLength(1);
    });

    test("a thrown runner error is recorded as kind unknown and retried once (#670)", async () => {
      const t = await setup(open);
      let n = 0;
      const s = t.sched(async (ctx) => {
        await ctx.store.setTrustClass("trusted_pr").catch(() => undefined);
        if (n++ === 0) throw new Error("kaboom");
        return { state: "success", reason: "ok" };
      });
      await t.drive(s);
      const attempts = await listAttempts(t.db, t.scope, t.job.id);
      expect(attempts.map((a) => a.state)).toEqual(["infra_error", "success"]);
      expect(attempts[0]!.infraKind).toBe("unknown");
    });

    test("a transient kind on the first attempt makes one new attempt on a fresh sandbox; the first is released and kept", async () => {
      const t = await setup(open);
      const s = t.sched(
        t.script([
          transient("docker_daemon_unavailable", "the sandbox has no working Docker daemon"),
          { state: "success", reason: "ok" },
        ]),
      );
      await t.drive(s);
      const attempts = await listAttempts(t.db, t.scope, t.job.id);
      expect(attempts.map((a) => a.state)).toEqual(["infra_error", "success"]);
      expect(attempts[0]!.errorClass).toBe("the sandbox has no working Docker daemon");
      expect(attempts[0]!.infraKind).toBe("docker_daemon_unavailable");
      expect(attempts[1]!.rerunReason).toBeNull(); // uses none of the commit's reruns
      expect(new Set(t.made).size).toBe(2);
      expect(t.released.toSorted()).toEqual(t.made.toSorted());
      expect((await getJob(t.db, t.scope, t.job.id))?.state).toBe("success");
      const ev = await listEvents(t.db, t.scope, {
        after: 0,
        limit: 100,
        types: ["attempt.infra_retry"],
      });
      expect(ev).toHaveLength(1);
      expect(JSON.parse(ev[0]!.payload as string)).toMatchObject({
        kind: "docker_daemon_unavailable",
        attempt_id: attempts[0]!.id,
      });
      const audit = await listAudit(t.db, t.scope);
      expect(audit.filter((x) => x.op === "attempt.infra_retry")).toHaveLength(1);
    });

    test("a second infra failure ends infra_error with both reasons and no third attempt", async () => {
      const t = await setup(open);
      const s = t.sched(
        t.script([
          transient("sandbox_create_failed", "create failed: quota"),
          transient("sandbox_lost", "act process lost"),
        ]),
      );
      await t.drive(s);
      const attempts = await listAttempts(t.db, t.scope, t.job.id);
      expect(attempts).toHaveLength(2);
      expect(attempts[0]!.errorClass).toBe("create failed: quota");
      expect(attempts[1]!.errorClass).toContain("act process lost");
      expect(attempts[1]!.errorClass).toContain("create failed: quota");
      expect((await getJob(t.db, t.scope, t.job.id))?.state).toBe("infra_error");
      expect(t.made).toHaveLength(2);
    });

    for (const [label, outcome] of [
      ["a refusal", { state: "failure", reason: "unsupported: needs Docker" }],
      ["a test failure", { state: "failure", exitCode: 1, reason: "job failed: test" }],
      ["a cancel", { state: "cancelled", reason: "cancelled by user" }],
      ["a non-transient kind", transient("other", "act exited 3 without a job result")],
      [
        "checkout_auth_failed (a refused checkout)",
        transient("checkout_auth_failed", "the checkout was refused by GitHub (HTTP 401)"),
      ],
      ["an infra error with no kind", { state: "infra_error", reason: "no run has no sha" }],
    ] as [string, AttemptOutcome][]) {
      test(`${label} is never retried`, async () => {
        const t = await setup(open);
        await t.drive(t.sched(t.script([outcome])));
        expect(await listAttempts(t.db, t.scope, t.job.id)).toHaveLength(1);
        expect(t.made).toHaveLength(1);
        const ev = await listEvents(t.db, t.scope, {
          after: 0,
          limit: 100,
          types: ["attempt.infra_retry"],
        });
        expect(ev).toHaveLength(0);
      });
    }

    for (const klass of ["protected", "release"]) {
      test(`sandbox_lost on a ${klass} job is not retried`, async () => {
        const t = await setup(open);
        await t.drive(t.sched(t.script([transient("sandbox_lost", "act process lost")], klass)));
        const attempts = await listAttempts(t.db, t.scope, t.job.id);
        expect(attempts).toHaveLength(1);
        expect(attempts[0]!.state).toBe("infra_error");
        expect(attempts[0]!.errorClass).toBe("act process lost");
        expect((await getJob(t.db, t.scope, t.job.id))?.state).toBe("infra_error");
        expect(t.made).toHaveLength(1);
      });
    }

    test("sandbox_lost on a trusted_pr job is retried once", async () => {
      const t = await setup(open);
      await t.drive(
        t.sched(
          t.script(
            [transient("sandbox_lost", "act process lost"), { state: "success", reason: "ok" }],
            "trusted_pr",
          ),
        ),
      );
      const attempts = await listAttempts(t.db, t.scope, t.job.id);
      expect(attempts.map((a) => a.state)).toEqual(["infra_error", "success"]);
    });

    test("sandbox_create_failed on a release job is retried once (it happens before any step)", async () => {
      const t = await setup(open);
      await t.drive(
        t.sched(
          t.script(
            [
              transient("sandbox_create_failed", "create failed"),
              { state: "success", reason: "ok" },
            ],
            "release",
          ),
        ),
      );
      const attempts = await listAttempts(t.db, t.scope, t.job.id);
      expect(attempts.map((a) => a.state)).toEqual(["infra_error", "success"]);
    });

    test("a cancel during the backoff skips the retry", async () => {
      const t = await setup(open);
      const s = new Scheduler({
        db: t.db,
        runner: t.script([transient("sandbox_lost", "act process lost")]),
        providers: () => world.provider(),
        globalCap: 5,
        perOrgCap: 5,
        drain: new DrainState(),
        infraRetryBackoffMs: 60_000,
      });
      expect(await s.tick()).toBe(1);
      await Bun.sleep(50);
      const [a] = await listAttempts(t.db, t.scope, t.job.id);
      s.abort([a!.id]);
      await s.idle();
      expect(await listAttempts(t.db, t.scope, t.job.id)).toHaveLength(1);
    });

    test("the drain-cut requeue still works and does not use the infra retry; the infra retry still gets its one", async () => {
      const t = await setup(open);
      // attempt 1: cut by a drain, then requeued as before (#448)
      const claim = (await claimNextAttempt(t.db, {
        owner: "w1",
        leaseMs: 30_000,
        now: 1,
        globalCap: 5,
        perOrgCap: 5,
      }))!;
      expect(claim.attempt.id).toBe(t.first.id);
      expect(await markDrainCut(t.db, t.scope, claim.attempt.id, "w1")).toBe(true);
      expect(
        await requeueLostAttemptOnce(t.db, t.scope, {
          attemptId: claim.attempt.id,
          owner: "w1",
          errorClass: "controller_lost (test)",
          now: 1,
          requireExpired: false,
          retryableAfterSteps,
        }),
      ).toBe("requeued");
      // attempt 2 fails transiently, attempt 3 (the infra retry) fails too: that is the end
      await t.drive(
        t.sched(
          t.script([
            transient("sandbox_lost", "act process lost"),
            transient("sandbox_lost", "act process lost again"),
          ]),
        ),
      );
      const attempts = await listAttempts(t.db, t.scope, t.job.id);
      expect(attempts).toHaveLength(3);
      expect(attempts[0]!.errorClass).toBe("controller_lost (test)");
      expect(attempts[0]!.infraKind).toBeNull();
      expect(attempts[2]!.errorClass).toContain("act process lost again");
      expect((await getJob(t.db, t.scope, t.job.id))?.state).toBe("infra_error");
    });
  });
}

describe("the check summary line for a retry", () => {
  test("is fixed words from the closed kind table; an unknown kind adds nothing", () => {
    expect(infraRetryLine("sandbox_lost")).toContain("the sandbox was lost");
    expect(infraRetryLine("sandbox_lost")).toContain("second attempt");
    expect(infraRetryLine("[x](http://evil) @someone")).toBeUndefined();
    expect(infraRetryLine(null)).toBeUndefined();
  });
});
