// A job an operator splits across sandboxes has ONE forge check under the job's own name: made
// when the first shard starts, running while any shard runs, completed by the last one to finish
// with the fold of the shards, and a rerun of one shard gets a check of its own.
import { beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import {
  createAttempt,
  createJob,
  createRun,
  type Db,
  getAttemptCheckRunId,
  setProjectChecksMode,
} from "../src/db";
import type { Claim } from "../src/db/repos";
import { CheckReporter, type TokenMinter } from "../src/checks/reporter";
import type { CheckRunBody, CheckRunsApi } from "../src/checks/client";
import { rawExec } from "./ops-helpers";
import { setupChecksWorld } from "./checks-helpers";

const NAME = "CLI tests (rules, engine and the rest)";

function fakeApi() {
  const runs = new Map<string, CheckRunBody>();
  const calls: { op: string; id?: string }[] = [];
  let next = 500;
  const api: CheckRunsApi = {
    async create(_t, _repo, body) {
      const id = String(next++);
      calls.push({ op: "create", id });
      runs.set(id, { ...body });
      return id;
    },
    async update(_t, _repo, id, body) {
      calls.push({ op: "update", id });
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

/** A run with `n` shards of one job, as the planner makes them. */
async function shards(n: number) {
  const run = await createRun(db, world.scope, {
    workflowPath: ".github/workflows/ci.yml",
    event: "push",
    ref: "refs/heads/main",
    sha: world.sha,
    repo: "acme/web",
  });
  const out: Claim[] = [];
  for (let i = 0; i < n; i++) {
    const job = (await createJob(db, world.scope, {
      runId: run.id,
      jobKey: `tests[${i}]`,
      name: NAME,
      planned: {
        key: `tests[${i}]`,
        id: "tests",
        name: NAME,
        shard: { index: i, total: n, partition: [] },
      },
    }))!;
    const attempt = (await createAttempt(db, world.scope, { jobId: job.id, provider: "fake" }))!;
    out.push({ attempt, job, run, scope: world.scope });
  }
  return out;
}
const setState = (c: Claim, state: string) =>
  db.run((h) => rawExec(h.orm, sql`update jobs set state = ${state} where id = ${c.job.id}`));
const rep = (api: CheckRunsApi) =>
  new CheckReporter({ db, auth, api, publicUrl: "https://ci.example.com", sleep: async () => {} });
const done = (state: "success" | "failure" | "infra_error" | "cancelled") =>
  ({ state, exitCode: state === "success" ? 0 : 1, reason: state }) as never;

describe("one check for the shards of a job", () => {
  test("three shards: one check, named as the job, running until the last shard finishes, then the fold", async () => {
    const [a, b, c] = await shards(3);
    const { api, runs, calls } = fakeApi();
    const r = rep(api);
    for (const x of [a!, b!, c!]) {
      await setState(x, "running");
      r.started(x);
    }
    await r.idle();
    expect(calls.filter((x) => x.op === "create")).toHaveLength(1);
    expect(runs.size).toBe(1);
    const [id, body] = [...runs][0]!;
    expect(body).toMatchObject({ name: `turntable / ${NAME}`, status: "in_progress" });
    // every shard's attempt points at the one check
    for (const x of [a!, b!, c!])
      expect(await getAttemptCheckRunId(db, world.scope, x.attempt.id)).toBe(id);

    await setState(a!, "success");
    r.finished(a!, done("success"));
    await setState(b!, "success");
    r.finished(b!, done("success"));
    await r.idle();
    expect(runs.get(id)!.status).toBe("in_progress"); // one shard still running
    await setState(c!, "success");
    r.finished(c!, done("success"));
    await r.idle();
    const fin = runs.get(id)!;
    expect(fin).toMatchObject({ status: "completed", conclusion: "success" });
    expect(fin.output?.summary).toContain("shard 1 of 3: success");
    expect(fin.output?.summary).toContain("shard 3 of 3: success");
    expect(runs.size).toBe(1);
  });

  test("one failing shard fails the check, and the failing step is the failed shard's", async () => {
    const [a, b] = await shards(2);
    await world.addFailingLog(b!, "Audit engine tests");
    const { api, runs } = fakeApi();
    const r = rep(api);
    for (const x of [a!, b!]) {
      await setState(x, "running");
      r.started(x);
    }
    await setState(b!, "failure");
    r.finished(b!, done("failure"));
    await setState(a!, "success");
    r.finished(a!, done("success"));
    await r.idle();
    const fin = [...runs.values()][0]!;
    expect(fin).toMatchObject({ status: "completed", conclusion: "failure" });
    expect(fin.output?.summary).toContain("Audit engine tests");
    expect(runs.size).toBe(1);
  });

  test("an infrastructure error in one shard is an infrastructure failure of the job", async () => {
    const [a, b] = await shards(2);
    const { api, runs } = fakeApi();
    const r = rep(api);
    for (const x of [a!, b!]) {
      await setState(x, "running");
      r.started(x);
    }
    await setState(a!, "infra_error");
    r.finished(a!, done("infra_error"));
    await setState(b!, "success");
    r.finished(b!, done("success"));
    await r.idle();
    const fin = [...runs.values()][0]!;
    expect(fin.conclusion).toBe("failure");
    expect(fin.output?.title).toContain("infrastructure error");
  });

  test("shards that run one after another (a cap of 1) still make one check", async () => {
    const [a, b, c] = await shards(3);
    const { api, runs } = fakeApi();
    const r = rep(api);
    for (const x of [a!, b!, c!]) {
      await setState(x, "running");
      r.started(x);
      await r.idle();
      await setState(x, "success");
      r.finished(x, done("success"));
      await r.idle();
    }
    expect(runs.size).toBe(1);
    expect([...runs.values()][0]).toMatchObject({ status: "completed", conclusion: "success" });
  });

  test("a rerun of one shard, the others finished, gets a check of its own, completed with the fold", async () => {
    const [a, b] = await shards(2);
    const { api, runs } = fakeApi();
    const r = rep(api);
    for (const x of [a!, b!]) {
      await setState(x, "running");
      r.started(x);
    }
    await setState(a!, "infra_error");
    r.finished(a!, done("infra_error"));
    await setState(b!, "success");
    r.finished(b!, done("success"));
    await r.idle();
    expect(runs.size).toBe(1);
    // shard a is rerun: a second attempt, the job running again
    const again = (await createAttempt(db, world.scope, { jobId: a!.job.id, provider: "fake" }))!;
    const rerun: Claim = { ...a!, attempt: again };
    await setState(rerun, "running");
    r.started(rerun);
    await r.idle();
    expect(runs.size).toBe(2);
    await setState(rerun, "success");
    r.finished(rerun, done("success"));
    await r.idle();
    const latest = [...runs.values()].at(-1)!;
    expect(latest).toMatchObject({
      name: `turntable / ${NAME}`,
      status: "completed",
      conclusion: "success",
    });
    expect(latest.output?.summary).toContain("shard 2 of 2: success");
  });

  test("a job that is not split is reported exactly as before: one check per attempt", async () => {
    // Two workflows: a newer run of the same workflow on one sha supersedes the older (#648).
    const x = await world.claim();
    const y = await world.claim("test", ".github/workflows/other.yml");
    const { api, runs } = fakeApi();
    const r = rep(api);
    r.started(x);
    r.started(y);
    await r.idle();
    expect(runs.size).toBe(2);
  });
});
