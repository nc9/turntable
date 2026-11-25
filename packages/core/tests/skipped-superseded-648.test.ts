// #648: a skipped-without-attempt job of a SUPERSEDED run (a newer run for the same repo, sha and
// workflow, e.g. the re-ingest after a draft PR is marked ready, or one cancelled by a newer run)
// is dismissed with reason `superseded`, never posted after the newer run's checks. A lone
// all-skipped run still posts. Each case runs on SQLite and on Postgres (pglite).
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  createAttempt,
  createJob,
  createRun,
  type Db,
  isRunSuperseded,
  listAttempts,
  listJobs,
  openDatabase,
  setProjectChecksMode,
} from "../src/db";
import { eq } from "drizzle-orm";
import { testDb } from "../src/db/dialect";
import { openPostgres } from "../src/db/pg";
import { jobAttempts } from "../src/db/schema";
import { CheckReporter, type TokenMinter } from "../src/checks/reporter";
import type { CheckRunBody, CheckRunsApi } from "../src/checks/client";
import { Scheduler } from "../src/scheduler";
import { setupChecksWorld } from "./checks-helpers";

setDefaultTimeout(30_000);

const opened: Db[] = [];
afterAll(() => {
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
          ? { url: t, schema: `lstest_superseded_648_${process.pid}` }
          : { pglite: true },
        { fresh: true },
      );
    },
  ],
];

function fakeApi() {
  const runs = new Map<string, CheckRunBody>();
  let next = 700;
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

for (const [dialect, open] of dialects) {
  describe(`superseded run's skips (${dialect})`, () => {
    async function world() {
      const w = await setupChecksWorld(() => {
        const d = open();
        opened.push(d);
        return d;
      });
      await setProjectChecksMode(w.db, w.scope, "live");
      const { db, scope } = w;
      const mkRun = async (keys: Record<string, Record<string, unknown>>, sha = w.sha) => {
        const run = await createRun(db, scope, {
          workflowPath: ".github/workflows/ci.yml",
          event: "pull_request",
          ref: "refs/pull/1/merge",
          sha,
          repo: "acme/web",
        });
        for (const [key, over] of Object.entries(keys)) {
          const job = (await createJob(db, scope, {
            runId: run.id,
            jobKey: key,
            name: key,
            needs: [],
            planned: plan(key, over),
          }))!;
          await createAttempt(db, scope, { jobId: job.id, provider: "fake" });
        }
        return run;
      };
      const reporter = () =>
        new CheckReporter({
          db,
          auth,
          api: fake.api,
          publicUrl: "https://ci",
          sleep: async () => {},
        });
      const fake = fakeApi();
      const drive = async (r: CheckReporter) => {
        const sched = new Scheduler({
          db,
          providers: () => ({}) as never,
          runner: async () => ({ state: "success", exitCode: 0, reason: "ok" }),
          observer: r,
          pollMs: 10,
        });
        await sched.tick();
        await sched.idle();
        await sched.tick();
        await r.idle();
      };
      /** Plans the jobs (skipped ones get their attempts) without any reporting. */
      const planOnly = async () => {
        const sched = new Scheduler({
          db,
          providers: () => ({}) as never,
          runner: async () => ({ state: "success", exitCode: 0, reason: "ok" }),
          pollMs: 10,
        });
        await sched.tick();
        await sched.idle();
      };
      return { ...w, mkRun, reporter, drive, planOnly, fake };
    }
    const names = (runs: Map<string, CheckRunBody>) => [...runs.values()].map((b) => b.name).sort();
    const reasons = async (db: Db) =>
      (await db.run((h) => h.orm.select().from(jobAttempts))).map((a) => a.checkDismissedReason);

    test("draft all-skipped, then a ready re-ingest: only the new run's checks per name", async () => {
      const w = await world();
      const skip = { ifExpr: "false" };
      const draft = await w.mkRun({ changes: skip, "ci-ok": skip });
      await w.planOnly(); // the draft run ends all-skipped, its skips not yet swept
      const ready = await w.mkRun({ changes: {}, "ci-ok": skip });
      const r = w.reporter();
      await w.drive(r);
      await r.sweepSkipped();
      await r.idle();

      expect(names(w.fake.runs)).toEqual(["turntable / changes", "turntable / ci-ok"]);
      const byName = (n: string) => [...w.fake.runs.values()].find((b) => b.name === n)!;
      expect(byName("turntable / changes").conclusion).toBe("success");
      for (const b of w.fake.runs.values()) {
        expect(b.external_id).not.toContain(
          (await listJobs(w.db, w.scope, draft.id))
            .map((j) => j.id)
            .find((id) => b.external_id?.endsWith(id)) ?? "none",
        );
      }
      expect(await isRunSuperseded(w.db, draft)).toBe(true);
      expect(await isRunSuperseded(w.db, ready)).toBe(false);
      for (const j of await listJobs(w.db, w.scope, draft.id)) {
        const a = (await listAttempts(w.db, w.scope, j.id)).at(-1)!;
        expect(a.checkRunId).toBeNull();
        expect(a.checkDismissedReason).toBe("superseded");
      }
    });

    test("the dismissal is persisted: a restart does not re-sweep", async () => {
      const w = await world();
      const skip = { ifExpr: "false" };
      await w.mkRun({ changes: skip });
      await w.planOnly();
      await w.mkRun({ changes: {} });
      const r1 = w.reporter();
      await r1.sweepSkipped();
      await r1.idle();
      expect(await reasons(w.db)).toContain("superseded");
      const before = w.fake.runs.size;
      const r2 = w.reporter(); // a restart
      expect(await r2.sweepSkipped()).toBe(false);
      await r2.idle();
      expect(w.fake.runs.size).toBe(before);
    });

    test("a lone all-skipped run still posts its skips", async () => {
      const w = await world();
      const skip = { ifExpr: "false" };
      const run = await w.mkRun({ changes: skip, "ci-ok": skip });
      await w.planOnly();
      const r = w.reporter();
      await r.sweepSkipped();
      await r.idle();
      expect(await isRunSuperseded(w.db, run)).toBe(false);
      expect(names(w.fake.runs)).toEqual(["turntable / changes", "turntable / ci-ok"]);
      for (const b of w.fake.runs.values()) expect(b.conclusion).toBe("skipped");
    });

    test("a run at another sha or workflow does not supersede", async () => {
      const w = await world();
      const skip = { ifExpr: "false" };
      const run = await w.mkRun({ changes: skip });
      await w.mkRun({ changes: skip }, "b".repeat(40));
      expect(await isRunSuperseded(w.db, run)).toBe(false);
    });

    test("a run cancelled as superseded by a newer run is dismissed", async () => {
      const w = await world();
      const skip = { ifExpr: "false" };
      const run = await w.mkRun({ changes: skip, build: {} });
      await w.planOnly();
      // the group superseded its running job; its skipped job stays skipped
      const jobs = await listJobs(w.db, w.scope, run.id);
      const build = jobs.find((j) => j.jobKey === "build")!;
      const at = (await listAttempts(w.db, w.scope, build.id)).at(-1)!;
      await w.db.run((h) =>
        h.orm
          .update(jobAttempts)
          .set({ state: "cancelled", errorClass: "superseded by a newer run" })
          .where(eq(jobAttempts.id, at.id)),
      );
      expect(await isRunSuperseded(w.db, run)).toBe(true);
      const r = w.reporter();
      await r.sweepSkipped();
      await r.idle();
      expect(w.fake.runs.size).toBe(0);
    });
  });
}
