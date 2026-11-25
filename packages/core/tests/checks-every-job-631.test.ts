// #631: every job that reaches a final state posts exactly one check with its conclusion, however
// fast it finishes, and a retried or raced post updates the check instead of duplicating it.
import { beforeEach, describe, expect, test } from "bun:test";
import { createAttempt, createJob, createRun, type Db, setProjectChecksMode } from "../src/db";
import { CheckReporter, type TokenMinter } from "../src/checks/reporter";
import { CheckRunsError, type CheckRunBody, type CheckRunsApi } from "../src/checks/client";
import { Scheduler } from "../src/scheduler";
import { setupChecksWorld } from "./checks-helpers";

type Opts = { createDelayMs?: number; failCreates?: number };
function fakeApi(o: Opts = {}) {
  const runs = new Map<string, CheckRunBody>();
  const calls: string[] = [];
  let next = 700;
  let failLeft = o.failCreates ?? 0;
  const api: CheckRunsApi = {
    async create(_t, _repo, body) {
      calls.push(`create:${body.name}`);
      if (o.createDelayMs) await new Promise((r) => setTimeout(r, o.createDelayMs));
      if (failLeft > 0) {
        failLeft--;
        throw new CheckRunsError(503, "create check run");
      }
      const id = String(next++);
      runs.set(id, { ...body });
      return id;
    },
    async update(_t, _repo, id, body) {
      calls.push(`update:${runs.get(id)?.name}`);
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
  await setProjectChecksMode(db, world.scope, "live");
});

const plan = (id: string, needs: string[] = [], over: Record<string, unknown> = {}) => ({
  key: id,
  id,
  name: id,
  needs,
  needsIds: needs,
  continueOnError: false,
  outputs: {},
  failFast: true,
  ...over,
});

async function makeWorkflow() {
  const run = await createRun(db, world.scope, {
    workflowPath: ".github/workflows/ci.yml",
    event: "push",
    ref: "refs/heads/main",
    sha: world.sha,
    repo: "acme/web",
  });
  const add = async (key: string, needs: string[] = [], over: Record<string, unknown> = {}) => {
    const job = (await createJob(db, world.scope, {
      runId: run.id,
      jobKey: key,
      name: key,
      needs,
      planned: plan(key, needs, over),
    }))!;
    await createAttempt(db, world.scope, { jobId: job.id, provider: "fake" });
  };
  const gate = (k: string) => `needs.changes.outputs.${k} == 'true'`;
  await add("changes", [], { outputs: { fmt: "x", typecheck: "x", lint: "x" } });
  for (const k of ["fmt", "typecheck", "lint"]) await add(k, ["changes"], { ifExpr: gate(k) });
  await add("test", ["changes", "fmt", "typecheck", "lint"]);
  await add("docs", ["changes"], { ifExpr: "false" });
  await add("postgres", ["changes"], { ifExpr: "false" });
  await add("ci-ok", ["changes", "fmt", "typecheck", "lint", "test", "docs", "postgres"], {
    ifExpr: "always()",
  });
  return run;
}

async function drive(reporter: CheckReporter, delayMs = 0) {
  const sched = new Scheduler({
    db,
    providers: () => ({}) as never,
    runner: async (ctx) => {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      return ctx.job.jobKey === "changes"
        ? {
            state: "success",
            exitCode: 0,
            reason: "ok",
            outputs: { fmt: "true", typecheck: "true", lint: "true" },
          }
        : { state: "success", exitCode: 0, reason: "ok" };
    },
    observer: reporter,
    pollMs: 10,
  });
  // Several claim passes, as production does between finishes.
  for (let i = 0; i < 8; i++) {
    await sched.tick();
    await sched.idle();
  }
  await sched.tick();
  await sched.idle();
  await reporter.idle();
}

const EXPECT: Record<string, string> = {
  changes: "success",
  fmt: "success",
  typecheck: "success",
  lint: "success",
  test: "success",
  docs: "skipped",
  postgres: "skipped",
  "ci-ok": "success",
};

function assertAll(runs: Map<string, CheckRunBody>) {
  const got: Record<string, string[]> = {};
  for (const b of runs.values()) (got[b.name!] ??= []).push(`${b.status}/${b.conclusion}`);
  for (const [job, conclusion] of Object.entries(EXPECT))
    expect(got[`turntable / ${job}`]).toEqual([`completed/${conclusion}`]);
  expect(runs.size).toBe(Object.keys(EXPECT).length);
}

describe("#631 every job posts one check", () => {
  test("the workflow shape of the issue: one completed check per job", async () => {
    const { api, runs } = fakeApi();
    await makeWorkflow();
    await drive(new CheckReporter({ db, auth, api, sleep: async () => {} }));
    assertAll(runs);
  });

  test("jobs that finish before the first create returns still post their own check", async () => {
    const { api, runs } = fakeApi({ createDelayMs: 25 });
    await makeWorkflow();
    await drive(new CheckReporter({ db, auth, api, sleep: async () => {} }));
    assertAll(runs);
  });

  test("a create that fails then retries makes one check, completed", async () => {
    const { api, runs } = fakeApi({ failCreates: 3 });
    await makeWorkflow();
    await drive(new CheckReporter({ db, auth, api, sleep: async () => {} }));
    assertAll(runs);
  });

  test("slow jobs: started checks are updated, not duplicated", async () => {
    const { api, runs, calls } = fakeApi();
    await makeWorkflow();
    await drive(new CheckReporter({ db, auth, api, sleep: async () => {} }), 20);
    assertAll(runs);
    expect(calls.filter((c) => c === "create:turntable / test").length).toBe(1);
  });
});
