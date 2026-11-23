// A skipped attempt the reporter found nothing to post for is dismissed in the database, so a
// restart does not sweep it again and a backlog of them cannot crowd out a real skip (#386).
import { ne } from "drizzle-orm";
import { afterAll, describe, expect, test } from "bun:test";
import {
  createAttempt,
  createJob,
  createRun,
  type Db,
  getAttemptCheckRunId,
  listAttempts,
  listJobs,
  listUnreportedSkips,
  openDatabase,
  setProjectChecksMode,
} from "../src/db";
import { openPostgres } from "../src/db/pg";
import { CheckReporter, type TokenMinter } from "../src/checks/reporter";
import type { CheckRunBody, CheckRunsApi } from "../src/checks/client";
import { jobAttempts, jobs } from "../src/db/schema";
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
  let next = 900;
  const api: CheckRunsApi = {
    async create(_t, _repo, body) {
      const id = String(next++);
      runs.set(id, { ...body });
      return id;
    },
    async update(_t, _repo, id, body) {
      runs.set(id, { ...runs.get(id), ...body });
    },
    async findByExternalId() {
      return undefined;
    },
  };
  return { api, runs };
}
const auth: TokenMinter = { mint: async () => ({ token: "t" }) };

for (const [name, open] of dialects) {
  describe(`dismissed skips (${name})`, () => {
    async function world() {
      const w = await setupChecksWorld(() => {
        const db = open();
        opened.push(db);
        return db;
      });
      const rep = (api: CheckRunsApi) =>
        new CheckReporter({
          db: w.db,
          auth,
          api,
          publicUrl: "https://ci.example.com",
          sleep: async () => {},
        });
      const skip = async (key: string) => {
        const run = await createRun(w.db, w.scope, {
          workflowPath: ".github/workflows/ci.yml",
          event: "push",
          ref: "refs/heads/main",
          sha: w.sha,
          repo: "acme/web",
        });
        const job = (await createJob(w.db, w.scope, { runId: run.id, jobKey: key, name: key }))!;
        const attempt = (await createAttempt(w.db, w.scope, {
          jobId: job.id,
          provider: "fake",
        }))!;
        return { run, job, attempt };
      };
      return { ...w, rep, skip };
    }

    /** Every job and attempt in the database ends skipped, as the scheduler resolves them. */
    const settle = (db: Db) =>
      db.run(async (h) => {
        await h.orm.update(jobAttempts).set({ state: "skipped" });
        await h.orm.update(jobs).set({ state: "skipped" });
      });

    test("a dismissed skip is not selected again by a new reporter", async () => {
      const w = await world();
      const { job } = await w.skip("gated"); // checks are off: nothing to post
      await settle(w.db);
      const { api, runs } = fakeApi();
      const since = 0;
      expect(await listUnreportedSkips(w.db, { since, limit: 10 })).toHaveLength(1);
      await w.rep(api).sweepSkipped();
      expect(await listUnreportedSkips(w.db, { since, limit: 10 })).toHaveLength(0);
      // checks turned on, then a restart (a new reporter): the dismissed skip stays dismissed
      await setProjectChecksMode(w.db, w.scope, "live");
      await w.rep(api).sweepSkipped();
      expect(runs.size).toBe(0);
      const [a] = await listAttempts(w.db, w.scope, job.id);
      expect(await getAttemptCheckRunId(w.db, w.scope, a!.id)).toBeNull();
      expect((await listJobs(w.db, w.scope, job.runId))[0]!.state).toBe("skipped");
    });

    test("a backlog of dismissed skips does not delay a new real skip", async () => {
      const w = await world();
      const real = await w.skip("real");
      // 201 newer skips, already dismissed: more than one sweep batch of them
      for (let i = 0; i < 201; i++) await w.skip(`old-${i}`);
      await settle(w.db);
      await w.db.run((h) =>
        h.orm
          .update(jobAttempts)
          .set({ checkDismissedAt: 1 })
          // everything except the real skip's attempt
          .where(ne(jobAttempts.id, real.attempt.id)),
      );
      await setProjectChecksMode(w.db, w.scope, "live");
      const { api, runs } = fakeApi();
      const r = w.rep(api);
      await r.sweepSkipped(); // one tick
      expect(runs.size).toBe(1);
      expect(await getAttemptCheckRunId(w.db, w.scope, real.attempt.id)).not.toBeNull();
    });
  });
}
