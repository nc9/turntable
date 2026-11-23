// A skipped attempt the reporter found nothing to post for is dismissed in the database, so a
// restart does not sweep it again and a backlog of them cannot crowd out a real skip (#386).
import { eq, ne } from "drizzle-orm";
import { afterAll, describe, expect, test } from "bun:test";
import {
  adoptRepoBinding,
  bindRepo,
  createAttempt,
  createJob,
  createRun,
  type Db,
  getAttemptCheckRunId,
  listAttempts,
  listRepos,
  listJobs,
  listUnreportedSkips,
  openDatabase,
  setProjectChecksMode,
  unbindRepo,
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
      // dismissed two days ago, so turning checks on, then a restart (a new reporter), leaves it
      await w.db.run((h) =>
        h.orm.update(jobAttempts).set({ checkDismissedAt: Date.now() - 48 * 3600_000 }),
      );
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

    const dismissal = async (db: Db, id: string) => {
      const [r] = await db.run((h) =>
        h.orm
          .select({ at: jobAttempts.checkDismissedAt, why: jobAttempts.checkDismissedReason })
          .from(jobAttempts)
          .where(eq(jobAttempts.id, id)),
      );
      return r!;
    };

    test("a skip dismissed while checks were off gets a check once they turn on, within 24 h", async () => {
      const w = await world();
      const recent = await w.skip("recent");
      const old = await w.skip("old");
      await settle(w.db);
      const { api, runs } = fakeApi();
      await w.rep(api).sweepSkipped();
      expect((await dismissal(w.db, recent.attempt.id)).why).toBe("checks_off");
      // the second one was dismissed two days ago
      await w.db.run((h) =>
        h.orm
          .update(jobAttempts)
          .set({ checkDismissedAt: Date.now() - 48 * 3600_000 })
          .where(eq(jobAttempts.id, old.attempt.id)),
      );
      await setProjectChecksMode(w.db, w.scope, "live");
      await w.rep(api).sweepSkipped();
      expect(runs.size).toBe(1);
      expect(await getAttemptCheckRunId(w.db, w.scope, recent.attempt.id)).not.toBeNull();
      expect(await getAttemptCheckRunId(w.db, w.scope, old.attempt.id)).toBeNull();
      expect((await dismissal(w.db, old.attempt.id)).why).toBe("checks_off");
    });

    test("a skip dismissed for no binding or no installation gets a check after a claim or adoption", async () => {
      const w = await world();
      await setProjectChecksMode(w.db, w.scope, "live");
      const [b] = await listRepos(w.db, w.scope);
      await unbindRepo(w.db, w.scope, b!.id);
      const unbound = await w.skip("unbound");
      await settle(w.db);
      const { api, runs } = fakeApi();
      await w.rep(api).sweepSkipped();
      expect((await dismissal(w.db, unbound.attempt.id)).why).toBe("no_binding");
      // an installation claims the repo
      await bindRepo(w.db, w.scope, {
        forge: "github",
        owner: "acme",
        repo: "web",
        installationId: w.installationId,
      });
      await w.rep(api).sweepSkipped();
      expect(runs.size).toBe(1);
      expect(await getAttemptCheckRunId(w.db, w.scope, unbound.attempt.id)).not.toBeNull();

      // a polled binding (no installation) is adopted
      const [claimed] = await listRepos(w.db, w.scope);
      await unbindRepo(w.db, w.scope, claimed!.id);
      const polled = await bindRepo(w.db, w.scope, { forge: "github", owner: "acme", repo: "web" });
      const second = await w.skip("polled");
      await settle(w.db);
      await w.rep(api).sweepSkipped();
      expect((await dismissal(w.db, second.attempt.id)).why).toBe("no_installation");
      expect(
        await adoptRepoBinding(w.db, { orgId: w.scope.orgId }, polled.id, {
          installationId: w.installationId,
          forgeRepoId: "42",
        }),
      ).toBe(true);
      await w.rep(api).sweepSkipped();
      expect(await getAttemptCheckRunId(w.db, w.scope, second.attempt.id)).not.toBeNull();
    });

    test("a dismissal with an unrelated reason is not cleared", async () => {
      const w = await world();
      const [b] = await listRepos(w.db, w.scope);
      await unbindRepo(w.db, w.scope, b!.id);
      const off = await w.skip("off"); // checks off
      await settle(w.db);
      const { api, runs } = fakeApi();
      await w.rep(api).sweepSkipped();
      expect((await dismissal(w.db, off.attempt.id)).why).toBe("checks_off");
      // a claim does not resolve "checks off"
      await bindRepo(w.db, w.scope, {
        forge: "github",
        owner: "acme",
        repo: "web",
        installationId: w.installationId,
      });
      expect((await dismissal(w.db, off.attempt.id)).at).not.toBeNull();
      // and turning checks on does not resolve "no binding"
      await setProjectChecksMode(w.db, w.scope, "live");
      const [c] = await listRepos(w.db, w.scope);
      await unbindRepo(w.db, w.scope, c!.id);
      const nb = await w.skip("nb");
      await settle(w.db);
      await w.rep(api).sweepSkipped();
      expect((await dismissal(w.db, nb.attempt.id)).why).toBe("no_binding");
      await setProjectChecksMode(w.db, w.scope, "shadow");
      expect((await dismissal(w.db, nb.attempt.id)).why).toBe("no_binding");
      await w.rep(api).sweepSkipped();
      expect(runs.size).toBe(0);
    });
  });
}
