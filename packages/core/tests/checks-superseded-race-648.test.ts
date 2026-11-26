// #648 (P0 for required checks): GitHub takes the most recently CREATED check run of a name on a
// sha as that check's state. A superseded run's late `skipped` must never become the newest check
// for a name the newer run owns, `ci-ok` included, however the old sweep and the new run's
// creates interleave. Uses only the public reporter and scheduler. SQLite and Postgres (pglite).
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createAttempt, createJob, createRun, type Db, openDatabase } from "../src/db";
import { setProjectChecksMode } from "../src/db";
import { testDb } from "../src/db/dialect";
import { openPostgres } from "../src/db/pg";
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
          ? { url: t, schema: `lstest_superseded_race_648_${process.pid}` }
          : { pglite: true },
        { fresh: true },
      );
    },
  ],
];
const auth: TokenMinter = { mint: async () => ({ token: "t" }) };

/** A forge double that keeps creation order, and can hold one `skipped-` create open. */
function fakeApi() {
  const created: { id: string; body: CheckRunBody }[] = [];
  let hold: Promise<void> | undefined;
  let held: () => void = () => {};
  const heldP = new Promise<void>((r) => (held = r));
  const api: CheckRunsApi = {
    async create(_t, _repo, body) {
      if (hold && body.external_id?.startsWith("skipped-")) {
        held();
        await hold;
      }
      const id = String(700 + created.length);
      created.push({ id, body: { ...body } });
      return id;
    },
    async update(_t, _repo, id, body) {
      const c = created.find((x) => x.id === id)!;
      c.body = { ...c.body, ...body };
    },
    async findByExternalId(_t, _repo, _sha, name, externalId) {
      return created.find((c) => c.body.external_id === externalId && c.body.name === name)?.id;
    },
  };
  /** The newest-created check per name, as GitHub shows it. */
  const newest = () => {
    const m = new Map<string, CheckRunBody>();
    for (const c of created) m.set(c.body.name!, c.body);
    return m;
  };
  return {
    api,
    created,
    newest,
    holdSkips: () => {
      let release: () => void = () => {};
      hold = new Promise<void>((r) => (release = r));
      return { release, held: heldP };
    },
  };
}

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
  describe(`a superseded run never overrides the newest check (${dialect})`, () => {
    async function world() {
      const w = await setupChecksWorld(() => {
        const d = open();
        opened.push(d);
        return d;
      });
      await setProjectChecksMode(w.db, w.scope, "live");
      const fake = fakeApi();
      const reporter = new CheckReporter({
        db: w.db,
        auth,
        api: fake.api,
        publicUrl: "https://ci",
        sleep: async () => {},
      });
      const mkRun = async (jobs: Record<string, Record<string, unknown>>) => {
        const run = await createRun(w.db, w.scope, {
          workflowPath: ".github/workflows/ci.yml",
          event: "pull_request",
          ref: "refs/pull/1/merge",
          sha: w.sha,
          repo: "acme/web",
        });
        for (const [key, over] of Object.entries(jobs)) {
          const job = (await createJob(w.db, w.scope, {
            runId: run.id,
            jobKey: key,
            name: key,
            needs: [],
            planned: plan(key, over),
          }))!;
          await createAttempt(w.db, w.scope, { jobId: job.id, provider: "fake" });
        }
        return run;
      };
      const schedule = async (observer?: CheckReporter) => {
        const sched = new Scheduler({
          db: w.db,
          providers: () => ({}) as never,
          runner: async () => ({ state: "failure", exitCode: 1, reason: "boom" }),
          ...(observer ? { observer } : {}),
          pollMs: 10,
        });
        await sched.tick();
        await sched.idle();
        await sched.tick();
        if (observer) await observer.idle();
      };
      const skip = { ifExpr: "false" };
      /** The draft run: every job skipped without an attempt, its skips not yet swept. */
      const draft = async () => {
        await mkRun({ changes: skip, lint: skip, "ci-ok": skip });
        await schedule();
      };
      /** The ready re-ingest: `changes`, `lint` and `ci-ok` all run and FAIL. */
      const ready = () => mkRun({ changes: {}, lint: {}, "ci-ok": {} });
      return { ...w, fake, reporter, draft, ready, schedule };
    }
    const FAILING = ["turntable / changes", "turntable / ci-ok", "turntable / lint"];
    const expectNewestFailing = (n: Map<string, CheckRunBody>) => {
      for (const name of FAILING) expect(n.get(name)?.conclusion).toBe("failure");
    };

    test("positive control: the newer run's failing checks, then the old run's sweep", async () => {
      const w = await world();
      await w.draft();
      await w.ready();
      await w.schedule(w.reporter); // the newer run posts failing changes, lint and ci-ok
      expectNewestFailing(w.fake.newest());
      await w.reporter.sweepSkipped(); // the superseded run's sweep tries `skipped` per name
      await w.reporter.idle();
      expectNewestFailing(w.fake.newest());
    });

    test("interleaving A: the old sweep first, the newer run's checks after", async () => {
      const w = await world();
      await w.draft();
      await w.reporter.sweepSkipped();
      await w.reporter.idle();
      await w.ready();
      await w.schedule(w.reporter);
      expectNewestFailing(w.fake.newest());
    });

    test("interleaving C: the new run appears while the old sweep's create is in flight", async () => {
      const w = await world();
      await w.draft();
      const gate = w.fake.holdSkips();
      void w.reporter.sweepSkipped();
      await gate.held; // the old create is open at the forge
      await w.ready();
      const driven = w.schedule(w.reporter); // the new run wants to create the same names
      await new Promise((r) => setTimeout(r, 50));
      gate.release();
      await driven;
      await w.reporter.idle();
      expectNewestFailing(w.fake.newest());
    });

    test("a lone all-skipped run still posts its skips", async () => {
      const w = await world();
      await w.draft();
      await w.reporter.sweepSkipped();
      await w.reporter.idle();
      const n = w.fake.newest();
      for (const name of FAILING) expect(n.get(name)?.conclusion).toBe("skipped");
    });
  });
}
