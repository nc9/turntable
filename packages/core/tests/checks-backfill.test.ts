// Turning checks on (off to shadow or live, shadow to live) posts the latest run's current job
// states, with the event path's external ids, once (#630).
import { afterAll, describe, expect, test } from "bun:test";
import {
  createAttempt,
  createJob,
  createRun,
  type Db,
  getAttemptCheckRunId,
  listAttempts,
  listAudit,
  openDatabase,
  setProjectChecksMode,
  transitionJob,
  updateAttempt,
} from "../src/db";
import { openPostgres } from "../src/db/pg";
import { CheckReporter, type TokenMinter } from "../src/checks/reporter";
import type { CheckRunBody, CheckRunsApi } from "../src/checks/client";
import { setupChecksWorld } from "./checks-helpers";

const opened: Db[] = [];
afterAll(() => {
  for (const db of opened) db.close();
});
const dialects: [string, () => Db][] = [
  ["sqlite", () => openDatabase(":memory:")],
  ["postgres", () => openPostgres({ pglite: true }, { fresh: true })],
];

function fakeApi() {
  const runs = new Map<string, CheckRunBody>();
  let next = 100;
  const api: CheckRunsApi = {
    async create(_t, _repo, body) {
      const id = String(next++);
      runs.set(id, { ...body });
      return id;
    },
    async update(_t, _repo, id, body) {
      runs.set(id, { ...runs.get(id), ...body });
    },
    async findByExternalId(_t, _repo, _sha, name, externalId) {
      for (const [id, b] of runs) if (b.external_id === externalId && b.name === name) return id;
      return undefined;
    },
  };
  return { api, runs };
}
const auth: TokenMinter = { mint: async () => ({ token: "t" }) };

for (const [dialect, open] of dialects) {
  describe(`checks backfill on a mode flip (${dialect})`, () => {
    async function world() {
      const w = await setupChecksWorld(() => {
        const db = open();
        opened.push(db);
        return db;
      });
      const rep = (api: CheckRunsApi) =>
        new CheckReporter({ db: w.db, auth, api, sleep: async () => {} });
      /** A run on main with jobs in the given terminal (or running) states, mode off. */
      async function finishedRun(states: Record<string, "success" | "failure" | "running">) {
        const run = await createRun(w.db, w.scope, {
          workflowPath: ".github/workflows/ci.yml",
          event: "push",
          ref: "refs/heads/main",
          sha: w.sha,
          repo: "acme/web",
        });
        for (const [key, state] of Object.entries(states)) {
          const job = (await createJob(w.db, w.scope, { runId: run.id, jobKey: key, name: key }))!;
          const a = (await createAttempt(w.db, w.scope, { jobId: job.id, provider: "fake" }))!;
          await transitionJob(w.db, w.scope, job.id, "running");
          await updateAttempt(w.db, w.scope, a.id, { state: "running" });
          if (state !== "running") {
            await transitionJob(w.db, w.scope, job.id, state, {
              exitCode: state === "success" ? 0 : 1,
            });
            await updateAttempt(w.db, w.scope, a.id, {
              state,
              exitCode: state === "success" ? 0 : 1,
            });
          }
        }
        return run;
      }
      return { ...w, rep, finishedRun };
    }

    test("off to live posts every job's current state; a later event updates it", async () => {
      const w = await world();
      const run = await w.finishedRun({ build: "success", test: "failure", lint: "running" });
      const { api, runs } = fakeApi();
      const r = w.rep(api);
      await setProjectChecksMode(w.db, w.scope, "live");
      r.tick();
      await r.idle();
      const named = (n: string) => [...runs.values()].filter((b) => b.name === `turntable / ${n}`);
      expect(named("build")[0]).toMatchObject({ status: "completed", conclusion: "success" });
      expect(named("test")[0]).toMatchObject({ status: "completed", conclusion: "failure" });
      expect(named("lint")[0]).toMatchObject({ status: "in_progress" });
      expect(runs.size).toBe(3);
      // the running job now finishes: its event updates the backfilled check, no duplicate
      const lintJob = (await w.db.run((h) => h.orm.select().from(jobsTable()))).find(
        (j) => j.runId === run.id && j.jobKey === "lint",
      )!;
      const [att] = await listAttempts(w.db, w.scope, lintJob.id);
      await transitionJob(w.db, w.scope, lintJob.id, "success", { exitCode: 0 });
      const done = (await updateAttempt(w.db, w.scope, att!.id, {
        state: "success",
        exitCode: 0,
      }))!;
      r.finished(
        { attempt: done, job: lintJob, run, scope: w.scope },
        { state: "success", reason: "ok" },
      );
      await r.idle();
      expect(runs.size).toBe(3);
      expect(named("lint")[0]).toMatchObject({ status: "completed", conclusion: "success" });
      const audit = (await listAudit(w.db, { orgId: w.scope.orgId })).filter(
        (a) => a.op === "checks_backfill",
      );
      expect(audit).toHaveLength(1);
    });

    test("a restart (a second reporter, more ticks) posts nothing again", async () => {
      const w = await world();
      await w.finishedRun({ build: "success", test: "failure" });
      const { api, runs } = fakeApi();
      await setProjectChecksMode(w.db, w.scope, "live");
      const r = w.rep(api);
      r.tick();
      await r.idle();
      const before = JSON.stringify([...runs]);
      for (const again of [w.rep(api), r]) {
        again.tick();
        await again.idle();
      }
      expect(JSON.stringify([...runs])).toBe(before);
      expect(runs.size).toBe(2);
    });

    test("a flip to off posts nothing, and a no-op flip neither", async () => {
      const w = await world();
      await w.finishedRun({ build: "success" });
      const { api, runs } = fakeApi();
      await setProjectChecksMode(w.db, w.scope, "off");
      const r = w.rep(api);
      r.tick();
      await r.idle();
      expect(runs.size).toBe(0);
      await setProjectChecksMode(w.db, w.scope, "live");
      await setProjectChecksMode(w.db, w.scope, "off");
      r.tick();
      await r.idle();
      expect(runs.size).toBe(0);
    });

    test("shadow to live posts real checks beside the neutral ones", async () => {
      const w = await world();
      await w.finishedRun({ build: "success", test: "failure" });
      const { api, runs } = fakeApi();
      await setProjectChecksMode(w.db, w.scope, "shadow");
      const r = w.rep(api);
      r.tick();
      await r.idle();
      const shadow = [...runs.values()].filter((b) => b.name?.startsWith("shadow / "));
      expect(shadow).toHaveLength(2);
      expect(shadow.every((b) => b.conclusion === "neutral")).toBe(true);
      await setProjectChecksMode(w.db, w.scope, "live");
      r.tick();
      await r.idle();
      const live = [...runs.values()].filter((b) => b.name?.startsWith("turntable / "));
      expect(live.map((b) => b.conclusion).toSorted()).toEqual(["failure", "success"]);
      expect(runs.size).toBe(4);
    });

    test("only the latest run per ref is backfilled", async () => {
      const w = await world();
      const old = await w.finishedRun({ build: "failure" });
      await w.finishedRun({ build: "success" });
      const { api, runs } = fakeApi();
      await setProjectChecksMode(w.db, w.scope, "live");
      const r = w.rep(api);
      r.tick();
      await r.idle();
      expect(runs.size).toBe(1);
      expect([...runs.values()][0]).toMatchObject({ conclusion: "success" });
      const jobs = (await w.db.run((h) => h.orm.select().from(jobsTable()))).filter(
        (j) => j.runId === old.id,
      );
      const [a] = await listAttempts(w.db, w.scope, jobs[0]!.id);
      expect(await getAttemptCheckRunId(w.db, w.scope, a!.id)).toBeNull();
    });
  });
}

import * as schema from "../src/db/schema";
function jobsTable() {
  return schema.jobs;
}
