// A job that ends skipped without an attempt (a false `if:`, a failed or skipped need, every
// shard path-skipped) still gets one check run, so a required context is never left pending.
import { beforeEach, describe, expect, test } from "bun:test";
import {
  createAttempt,
  createJob,
  createRun,
  type Db,
  getAttemptCheckRunId,
  listAttempts,
  listJobs,
  setProjectChecksMode,
} from "../src/db";
import { CheckReporter, type TokenMinter } from "../src/checks/reporter";
import type { CheckRunBody, CheckRunsApi } from "../src/checks/client";
import { conclusionFor, NO_ATTEMPT_SKIP, skipReasonFor } from "../src/checks/mapping";
import { jobAttempts } from "../src/db/schema";
import { Scheduler } from "../src/scheduler";
import { setupChecksWorld } from "./checks-helpers";

function fakeApi() {
  const runs = new Map<string, CheckRunBody>();
  const calls: string[] = [];
  let next = 700;
  const api: CheckRunsApi = {
    async create(_t, _repo, body) {
      const id = String(next++);
      calls.push("create");
      runs.set(id, { ...body });
      return id;
    },
    async update(_t, _repo, id, body) {
      calls.push("update");
      runs.set(id, { ...runs.get(id), ...body });
    },
    async findByExternalId(_t, _repo, _sha, name, externalId) {
      for (const [id, b] of runs) if (b.external_id === externalId && b.name === name) return id;
      return undefined;
    },
  };
  return { api, runs, calls };
}
const auth: TokenMinter = { mint: async () => ({ token: "t" }) };

let db: Db;
let world: Awaited<ReturnType<typeof setupChecksWorld>>;
beforeEach(async () => {
  world = await setupChecksWorld();
  db = world.db;
});

const rep = (api: CheckRunsApi) =>
  new CheckReporter({ db, auth, api, publicUrl: "https://ci.example.com", sleep: async () => {} });

const plan = (id: string, over: Record<string, unknown> = {}) => ({
  key: id,
  id,
  name: id,
  needs: [],
  needsIds: [],
  continueOnError: false,
  outputs: {},
  failFast: true,
  ...over,
});

async function makeRun() {
  return createRun(db, world.scope, {
    workflowPath: ".github/workflows/ci.yml",
    event: "push",
    ref: "refs/heads/main",
    sha: world.sha,
    repo: "acme/web",
  });
}

async function addJob(
  runId: string,
  key: string,
  planned: Record<string, unknown>,
  needs: string[] = [],
) {
  const job = (await createJob(db, world.scope, {
    runId,
    jobKey: key,
    name: (planned.name as string | undefined) ?? key,
    needs,
    planned,
  }))!;
  await createAttempt(db, world.scope, { jobId: job.id, provider: "fake" });
  return job;
}

/** Runs the scheduler over the run, as production does, with the reporter as its observer. */
async function drive(reporter: CheckReporter, failing: string[]) {
  const sched = new Scheduler({
    db,
    providers: () => ({}) as never,
    runner: async (ctx) =>
      failing.includes(ctx.job.jobKey)
        ? { state: "failure", exitCode: 1, reason: "boom" }
        : { state: "success", exitCode: 0, reason: "ok" },
    observer: reporter,
    pollMs: 10,
  });
  await sched.tick();
  await sched.idle();
  await sched.tick(); // the claim pass that ends with nothing left fires the observer's tick
  await reporter.idle();
}

const byName = (runs: Map<string, CheckRunBody>, name: string) =>
  [...runs.values()].filter((b) => b.name === name);

describe("a skipped job with no attempt", () => {
  for (const mode of ["live", "shadow"] as const) {
    const prefix = mode === "live" ? "turntable" : "shadow";
    const conclusion = mode === "live" ? "skipped" : "neutral";

    test(`${mode}: an if: that is false, a failed need and a skipped need each get one check`, async () => {
      await setProjectChecksMode(db, world.scope, mode);
      const run = await makeRun();
      await addJob(run.id, "build", plan("build"));
      await addJob(run.id, "gated", plan("gated", { ifExpr: "github.ref == 'refs/heads/nope'" }));
      await addJob(run.id, "test", plan("test", { needs: ["build"], needsIds: ["build"] }), [
        "build",
      ]);
      await addJob(run.id, "deploy", plan("deploy", { needs: ["test"], needsIds: ["test"] }), [
        "test",
      ]);
      await addJob(
        run.id,
        "after-gated",
        plan("after-gated", { needs: ["gated"], needsIds: ["gated"] }),
        ["gated"],
      );
      const { api, runs } = fakeApi();
      await drive(rep(api), ["build"]);

      const check = (name: string) => {
        const found = byName(runs, `${prefix} / ${name}`);
        expect(found).toHaveLength(1);
        return found[0]!;
      };
      expect(check("build")).toMatchObject({
        status: "completed",
        conclusion: mode === "live" ? "failure" : "neutral",
      });
      expect(check("gated")).toMatchObject({ status: "completed", conclusion });
      expect(check("gated").output?.summary).toContain("the if: expression was false");
      expect(check("test")).toMatchObject({ status: "completed", conclusion });
      expect(check("test").output?.summary).toContain("needs build was failure");
      expect(check("deploy")).toMatchObject({ status: "completed", conclusion });
      expect(check("deploy").output?.summary).toContain("needs test was skipped");
      expect(check("after-gated").output?.summary).toContain("needs gated was skipped");
      expect(check("test").output?.summary).toContain("Open the run in Turntable");
      // the stored id is on each skipped attempt
      for (const j of await listJobs(db, world.scope, run.id)) {
        const [a] = await listAttempts(db, world.scope, j.id);
        expect(await getAttemptCheckRunId(db, world.scope, a!.id)).not.toBeNull();
      }
      expect(runs.size).toBe(5);
    });
  }

  test("re-reporting never posts a second check for the job", async () => {
    await setProjectChecksMode(db, world.scope, "live");
    const run = await makeRun();
    await addJob(run.id, "gated", plan("gated", { ifExpr: "false" }));
    const { api, runs, calls } = fakeApi();
    const r = rep(api);
    await drive(r, []);
    expect(runs.size).toBe(1);
    // a second reporter (a restart, another worker), and a sweep with the stored id forgotten
    const again = rep(api);
    await again.sweepSkipped();
    await drive(again, []);
    expect(runs.size).toBe(1);
    expect(calls.filter((c) => c === "create")).toHaveLength(1);
    const [a] = await listAttempts(
      db,
      world.scope,
      (await listJobs(db, world.scope, run.id))[0]!.id,
    );
    await db.run((h) =>
      h.orm.update(jobAttempts).set({ checkRunId: null, skipCheckClaimedAt: null }),
    );
    await rep(api).sweepSkipped();
    expect(runs.size).toBe(1);
    expect(await getAttemptCheckRunId(db, world.scope, a!.id)).not.toBeNull();
  });

  test("every shard path-skipped: one check for the job, with the changed-set source", async () => {
    await setProjectChecksMode(db, world.scope, "live");
    const run = await makeRun();
    const attempts: string[] = [];
    for (let i = 0; i < 2; i++) {
      const job = await addJob(
        run.id,
        `tests[${i}]`,
        plan("tests", {
          key: `tests[${i}]`,
          name: "Tests",
          shard: { index: i, total: 2, partition: [] },
          staticSkip: {
            reason: "no shard paths changed: none of 3 changed files match src/** (push event)",
          },
        }),
      );
      attempts.push(job.id);
    }
    const { api, runs } = fakeApi();
    await drive(rep(api), []);
    const found = byName(runs, "turntable / Tests");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ status: "completed", conclusion: "skipped" });
    expect(found[0]!.output?.summary).toContain("no shard's paths changed: push event");
    for (const id of attempts) {
      const [a] = await listAttempts(db, world.scope, id);
      expect(await getAttemptCheckRunId(db, world.scope, a!.id)).toBe([...runs.keys()][0]!);
    }
  });

  test("a skip resolved while a sweep is posting is not lost (the tick is not dropped)", async () => {
    await setProjectChecksMode(db, world.scope, "live");
    const run = await makeRun();
    await addJob(run.id, "first", plan("first", { ifExpr: "false" }));
    const { api, runs } = fakeApi();
    // The first sweep has listed `first` and is held inside its create call.
    let entered!: () => void;
    const inCreate = new Promise<void>((r) => (entered = r));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const create = api.create;
    let held = false;
    api.create = async (...a) => {
      if (!held) {
        held = true;
        entered();
        await gate;
      }
      return create(...a);
    };
    const reporter = rep(api);
    const sched = new Scheduler({
      db,
      providers: () => ({}) as never,
      runner: async () => ({ state: "success", exitCode: 0, reason: "ok" }),
      observer: reporter,
      pollMs: 10,
    });
    await sched.tick();
    await inCreate;
    // A second job is skipped by the cascade now; its tick arrives mid-sweep.
    await addJob(run.id, "second", plan("second", { ifExpr: "false" }));
    await sched.tick();
    release();
    await sched.idle();
    await reporter.idle();
    expect(byName(runs, "turntable / first")).toHaveLength(1);
    expect(byName(runs, "turntable / second")).toHaveLength(1);
    expect(runs.size).toBe(2);
  });

  test("checks off posts nothing", async () => {
    const run = await makeRun();
    await addJob(run.id, "gated", plan("gated", { ifExpr: "false" }));
    const { api, runs } = fakeApi();
    await drive(rep(api), []);
    expect(runs.size).toBe(0);
  });

  test("a required-check fixture: every planned job resolves its context, none left pending", async () => {
    await setProjectChecksMode(db, world.scope, "live");
    const run = await makeRun();
    await addJob(run.id, "build", plan("build"));
    await addJob(run.id, "e2e", plan("e2e", { ifExpr: "false" }));
    await addJob(run.id, "release", plan("release", { needs: ["e2e"], needsIds: ["e2e"] }), [
      "e2e",
    ]);
    const { api, runs } = fakeApi();
    await drive(rep(api), []);
    // Branch protection counts success, neutral and skipped as satisfied; pending blocks the PR.
    const required = ["build", "e2e", "release"].map((n) => `turntable / ${n}`);
    for (const name of required) {
      const [c] = byName(runs, name);
      expect(c?.status).toBe("completed");
      expect(["success", "neutral", "skipped"]).toContain(c?.conclusion!);
    }
  });
});

describe("mapping", () => {
  test("no attempt, skipped: skipped live, neutral in shadow", () => {
    expect(conclusionFor("live", NO_ATTEMPT_SKIP)).toBe("skipped");
    expect(conclusionFor("shadow", NO_ATTEMPT_SKIP)).toBe("neutral");
  });

  test("skip reasons are fixed sentences", () => {
    const needs = [{ name: "build", state: "failure" }];
    expect(skipReasonFor({ errorClass: "dependency:failure", needs })).toBe(
      "needs build was failure",
    );
    expect(skipReasonFor({ errorClass: "skipped: if: success() is false", needs })).toBe(
      "needs build was failure",
    );
    expect(skipReasonFor({ errorClass: "skipped: if: secrets.TOKEN != '' is false", needs })).toBe(
      "the if: expression was false",
    );
    expect(
      skipReasonFor({ errorClass: "skipped: no shard paths changed: none (merge group)", needs }),
    ).toBe("no shard's paths changed: merge group");
    expect(skipReasonFor({ errorClass: null, needs: [] })).toBe(
      "the job was skipped before it started",
    );
  });
});
