import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex, staticResolver, tarDirectory } from "@turntable/act-runner";
import { FakeWorld } from "@turntable/provider-sdk/testing";
import type { Provider } from "@turntable/provider-sdk";
import {
  type Db,
  ensureLocalTenant,
  getRun,
  listAttempts,
  listEvents,
  listJobs,
  listRuns,
  openDatabase,
  readLog,
  recordExec,
  type Scope,
} from "../src/db";
import { GithubClient, pollConfigSchema, pollRepo, type PollRepoConfig } from "../src/poll";
import { createActRunner, reconcileExpired, Scheduler } from "../src/scheduler";
import { makeGithub, SHA } from "./github-stub";

const tmp = mkdtempSync(join(tmpdir(), "tt-worker-wf-"));
const world = new FakeWorld({ hostPaths: [tmp], exec: { tickSeconds: 1 } });
afterAll(() => {
  world.dispose();
  rmSync(tmp, { recursive: true, force: true });
});

/** A stand-in for act, as in run-workflow.test.ts: events for the job, outputs, exit per job id. */
const FAKE_ACT = String.raw`#!/bin/sh
J=""; W=""
while [ $# -gt 0 ]; do
  case "$1" in -j) J=$2; shift;; -W) W=$2; shift;; esac
  shift
done
R=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$R/seen" "$R/outputs"
cp "$W" "$R/seen/$J.yml"
ev() { printf '{"jobID":"%s","level":"info","msg":"%s","step":"%s","stepid":["--setup-job"],"time":"t"%s}\n' "$1" "$2" "$3" "$4"; }
ev stubjob "stub" "Set up job" ',"stepResult":"success"'
ev "$J" "Run" "Set up job" ""
ev "$J" "ok" "Set up job" ',"stepResult":"success"'
case "$J" in
  build) printf '%s' '1.2.3' > "$R/outputs/version" ;;
  slow) sleep 1 ;;
esac
case "$J" in
  fail|mfail|flaky)
    printf '{"jobID":"%s","jobResult":"failure","msg":"failed","time":"t"}\n' "$J"
    exit 1 ;;
esac
printf '{"jobID":"%s","jobResult":"success","msg":"ok","time":"t"}\n' "$J"
exit 0
`;

async function actTarball() {
  const d = mkdtempSync(join(tmp, "a-"));
  writeFileSync(join(d, "act"), FAKE_ACT, { mode: 0o755 });
  const bytes = await tarDirectory(d, ["act"]);
  return { bytes, sha256: sha256Hex(bytes) };
}

async function repoTarball() {
  const d = mkdtempSync(join(tmp, "r-"));
  writeFileSync(join(d, "README.md"), "hi\n");
  return tarDirectory(d, ["README.md"]);
}

const CFG = (over: Partial<PollRepoConfig> = {}): PollRepoConfig =>
  pollConfigSchema.parse({
    allowUnauthenticated: true,
    repos: [
      {
        repo: "acme/web",
        workflow: ".github/workflows/ci.yml",
        defaultBranch: "main",
        prMode: "allowlist",
        authors: ["octocat"],
        ...over,
      },
    ],
  }).repos[0] as PollRepoConfig;

let db: Db;
let scope: Required<Scope>;
let root: string;
beforeEach(async () => {
  db = openDatabase(":memory:");
  scope = await ensureLocalTenant(db);
  root = join(mkdtempSync(join(tmp, "root-")), "tt");
});

const ingest = (gh: ReturnType<typeof makeGithub>, cfg = CFG()) =>
  pollRepo(
    {
      db,
      github: new GithubClient({ fetch: gh.fetch, baseUrl: "https://api.github.com" }),
      provider: "fake",
    },
    cfg,
  );

function sourceFor(gh: ReturnType<typeof makeGithub>, tarball: Uint8Array) {
  return {
    checkout: async (run: { sha: string | null }) => ({
      tarball,
      readFile: (p: string) =>
        p === ".github/workflows/ci.yml"
          ? (gh.state.files.get(run.sha ?? "") ?? gh.state.files.get("*"))
          : undefined,
    }),
  };
}

async function makeScheduler(
  gh: ReturnType<typeof makeGithub>,
  provider: Provider = world.provider(),
) {
  const act = await actTarball();
  const tarball = await repoTarball();
  const sched = new Scheduler({
    db,
    providers: () => provider,
    runner: createActRunner({
      db,
      source: sourceFor(gh, tarball),
      resolver: staticResolver({}),
      act,
      planRoot: root,
      pollMs: 30,
    }),
    // One at a time: the fake provider shares one host directory between sandboxes (planRoot).
    globalCap: 1,
    perOrgCap: 1,
    leaseMs: 60_000,
    pollMs: 20,
  });
  return sched;
}

/** Claims and runs until nothing is left to start. */
async function drain(sched: Scheduler): Promise<void> {
  for (let i = 0; i < 40; i++) {
    const started = await sched.tick();
    await sched.idle();
    if (started === 0) return;
  }
  throw new Error("scheduler never settled");
}

const seen = (job: string): string => readFileSync(join(root, "seen", `${job}.yml`), "utf8");

const PIPELINE = `name: pipeline
on:
  push:
    branches: [main]
jobs:
  build:
    runs-on: ubuntu-latest
    outputs:
      version: \${{ steps.v.outputs.version }}
    steps:
      - id: v
        run: echo "version=1.2.3" >> "$GITHUB_OUTPUT"
  test:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - run: echo \${{ needs.build.outputs.version }}
  deploy:
    needs: test
    runs-on: ubuntu-latest
    steps:
      - run: echo deploy
`;

describe("the server path: poll, plan, schedule, run", () => {
  test("a 3-job run with needs and outputs runs through the worker, in order, with outputs fed to dependents", async () => {
    const gh = makeGithub();
    gh.state.files.set("*", PIPELINE);
    const res = await ingest(gh);
    expect(res.created).toHaveLength(1);

    // every job is created up front, with its needs and its plan
    const [run] = await listRuns(db, scope);
    const queued = await listJobs(db, scope, run!.id);
    expect(queued.map((j) => [j.jobKey, JSON.parse(j.needs), j.state])).toEqual([
      ["build", [], "queued"],
      ["test", ["build"], "queued"],
      ["deploy", ["test"], "queued"],
    ]);
    expect(queued.every((j) => j.planned !== null)).toBe(true);
    expect(JSON.parse(run!.plan!)).toMatchObject({ env: {}, github: { sha: SHA("a") } });

    const sched = await makeScheduler(gh);
    // only build is ready at first: the others wait for their needs
    expect(await sched.tick()).toBe(1);
    await sched.idle();
    expect((await listJobs(db, scope, run!.id)).map((j) => j.state)).toEqual([
      "success",
      "queued",
      "queued",
    ]);
    await drain(sched);

    const jobs = await listJobs(db, scope, run!.id);
    expect(jobs.map((j) => j.state)).toEqual(["success", "success", "success"]);
    expect((await getRun(db, scope, run!.id))?.status).toBe("success");
    // outputs were stored on the finished job, and the dependent ran from a workflow whose stub
    // need carries the real output as a literal
    expect(JSON.parse(jobs[0]!.outputs!)).toEqual({ version: "1.2.3" });
    expect(seen("test")).toContain("${{ '1.2.3' }}");
    // strictly in order
    const t = (k: string) => jobs.find((j) => j.jobKey === k)!;
    expect(t("build").finishedAt!).toBeLessThanOrEqual(t("test").startedAt!);
    expect(t("test").finishedAt!).toBeLessThanOrEqual(t("deploy").startedAt!);
    // the plan was stored on each attempt when it started
    for (const j of jobs) {
      const [att] = await listAttempts(db, scope, j.id);
      expect(att?.plan).toBeString();
      expect(JSON.parse(att!.plan!)).toHaveProperty("layout");
      expect(att).toMatchObject({ state: "success", leaseOwner: null });
    }
  });

  test("a real graph: skipped by if, unsupported docker, failure, always() cleanup, continue-on-error", async () => {
    const gh = makeGithub();
    gh.state.files.set(
      "*",
      `on: push
jobs:
  build:
    runs-on: ubuntu-latest
    outputs:
      version: \${{ steps.v.outputs.version }}
    steps:
      - run: echo
  skipme:
    needs: build
    if: \${{ needs.build.outputs.version == 'nope' }}
    runs-on: ubuntu-latest
    steps:
      - run: echo never
  images:
    runs-on: ubuntu-latest
    steps:
      - run: docker build .
  fail:
    runs-on: ubuntu-latest
    steps:
      - run: exit 1
  after-fail:
    needs: fail
    runs-on: ubuntu-latest
    steps:
      - run: echo never
  cleanup:
    needs: fail
    if: \${{ always() }}
    runs-on: ubuntu-latest
    steps:
      - run: echo cleanup
  flaky:
    runs-on: ubuntu-latest
    continue-on-error: true
    steps:
      - run: exit 1
  after-flaky:
    needs: flaky
    runs-on: ubuntu-latest
    steps:
      - run: echo ok
`,
    );
    await ingest(gh);
    const sched = await makeScheduler(gh);
    await drain(sched);
    const [run] = await listRuns(db, scope);
    const jobs = await listJobs(db, scope, run!.id);
    const st = Object.fromEntries(jobs.map((j) => [j.jobKey, j.state]));
    expect(st).toMatchObject({
      build: "success",
      skipme: "skipped", // its if: is false
      images: "skipped", // docker cannot run here
      fail: "failure",
      "after-fail": "skipped", // default if: success()
      cleanup: "success", // always() runs behind the failure
    });
    const afterFlaky = jobs.find((j) => j.jobKey === "after-flaky")!;
    expect((await listAttempts(db, scope, afterFlaky.id))[0]?.errorClass).toBeNull();
    expect(st["after-flaky"]).toBe("success");
    // the reason a job did not run is its log
    const logOf = async (key: string) => {
      const job = jobs.find((j) => j.jobKey === key)!;
      const [att] = await listAttempts(db, scope, job.id);
      return Buffer.concat((await readLog(db, scope, att!.id)).map((c) => c.bytes)).toString();
    };
    expect(await logOf("images")).toContain("unsupported");
    expect(await logOf("skipme")).toContain("is false");
    // the run fails because of `fail`, not because of the continue-on-error job
    expect((await getRun(db, scope, run!.id))?.status).toBe("failure");
    // the stub for the failed need really fails, so cleanup's needs.fail.result is failure
    expect(seen("cleanup")).toContain("exit 1");
  });

  test("matrix legs are separate jobs and fail-fast cancels the legs that have not started", async () => {
    const gh = makeGithub();
    gh.state.files.set(
      "*",
      `on: push
jobs:
  mfail:
    runs-on: ubuntu-latest
    strategy:
      max-parallel: 1
      matrix:
        n: [1, 2, 3]
    steps:
      - run: exit 1
`,
    );
    await ingest(gh);
    const [run] = await listRuns(db, scope);
    expect((await listJobs(db, scope, run!.id)).map((j) => j.jobKey)).toEqual([
      "mfail[0]",
      "mfail[1]",
      "mfail[2]",
    ]);
    const sched = await makeScheduler(gh);
    await drain(sched);
    const jobs = await listJobs(db, scope, run!.id);
    // max-parallel 1: the first leg ran alone, failed, and fail-fast cancelled the others
    expect(jobs.map((j) => j.state)).toEqual(["failure", "cancelled", "cancelled"]);
    const [att] = await listAttempts(db, scope, jobs[1]!.id);
    expect(att?.errorClass).toBe("matrix fail-fast");
    expect((await getRun(db, scope, run!.id))?.status).toBe("failure");
  });
});

describe("trigger router at ingest", () => {
  const PATHS =
    "on:\n  push:\n    paths: ['src/**']\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo\n";

  test("a docs-only change creates no run; a source change does; the verdict is remembered", async () => {
    const gh = makeGithub();
    gh.state.files.set("*", PATHS);
    // first sight of the branch: no base to compare, so the filter cannot be applied and it runs
    expect((await ingest(gh)).created).toHaveLength(1);

    gh.state.head = { sha: SHA("b"), message: "docs: typo", login: "octocat" };
    gh.state.compare.set(`${SHA("a")}...${SHA("b")}`, ["docs/readme.md", "README.md"]);
    const docs = await ingest(gh);
    expect(docs.created).toEqual([]);
    expect(docs.refused[0]?.reason).toContain("not triggered");
    expect(await listRuns(db, scope)).toHaveLength(1);
    const calls = gh.state.calls.filter((c) => c.path.includes("/compare/")).length;
    await ingest(gh); // the same sha again: remembered, no new compare call
    expect(gh.state.calls.filter((c) => c.path.includes("/compare/")).length).toBe(calls);

    gh.state.head = { sha: SHA("c"), message: "feat: code", login: "octocat" };
    gh.state.compare.set(`${SHA("b")}...${SHA("c")}`, ["src/a.ts"]);
    expect((await ingest(gh)).created).toHaveLength(1);
    expect(await listRuns(db, scope)).toHaveLength(2);
    // every request was a read
    expect(new Set(gh.state.calls.map((c) => c.method))).toEqual(new Set(["GET"]));
  });

  test("a pull request compares its base branch to its head", async () => {
    const gh = makeGithub();
    gh.state.files.set("*", PATHS.replace("push:", "pull_request:"));
    gh.state.pulls = [{ number: 5, user: "octocat", headSha: SHA("d"), baseRef: "main" }];
    gh.state.compare.set(`main...${SHA("d")}`, ["docs/guide.md"]);
    const docsOnly = await ingest(gh);
    expect(docsOnly.created).toEqual([]);
    expect(docsOnly.refused.some((r) => r.reason.startsWith("not triggered"))).toBe(true);

    gh.state.pulls = [{ number: 5, user: "octocat", headSha: SHA("e"), baseRef: "main" }];
    gh.state.compare.set(`main...${SHA("e")}`, ["src/new.ts"]);
    expect((await ingest(gh)).created).toHaveLength(1);
    const [run] = await listRuns(db, scope);
    expect(run).toMatchObject({ event: "pull_request", prNumber: 5, sha: SHA("e") });
  });

  test("an unreachable or oversized comparison runs the workflow (paths unknown)", async () => {
    const gh = makeGithub();
    gh.state.files.set("*", PATHS);
    await ingest(gh);
    gh.state.head = { sha: SHA("b"), message: "force push", login: "octocat" };
    // no compare entry: the stub answers 404, as GitHub does for a removed base
    expect((await ingest(gh)).created).toHaveLength(1);
  });

  test("a workflow with no path filter makes no compare request", async () => {
    const gh = makeGithub();
    gh.state.files.set("*", PIPELINE);
    await ingest(gh);
    gh.state.head = { sha: SHA("b"), message: "x", login: "octocat" };
    await ingest(gh);
    expect(gh.state.calls.some((c) => c.path.includes("/compare/"))).toBe(false);
  });
});

describe("concurrency groups", () => {
  const GROUP = (cancel: boolean) => `on: push
concurrency:
  group: ci-\${{ github.ref }}
  cancel-in-progress: ${cancel}
jobs:
  slow:
    runs-on: ubuntu-latest
    steps:
      - run: sleep 1
  after:
    needs: slow
    runs-on: ubuntu-latest
    steps:
      - run: echo
`;

  test("cancel-in-progress: the newer run is inserted first, then the older run's jobs are cancelled and its workers told to stop", async () => {
    const gh = makeGithub();
    gh.state.files.set("*", GROUP(true));
    await ingest(gh);
    const [older] = await listRuns(db, scope);
    expect(older?.concurrencyGroup).toBe("ci-refs/heads/main");

    // the older run's first job is running, held by a worker that never finishes it
    const abortedBy: string[] = [];
    const sched = new Scheduler({
      db,
      providers: () => world.provider(),
      runner: (ctx) =>
        new Promise((resolve) => {
          ctx.signal.addEventListener("abort", () => {
            abortedBy.push(String(ctx.signal.reason));
            resolve({ state: "cancelled", reason: "stopped" });
          });
        }),
      leaseMs: 60_000,
    });
    expect(await sched.tick()).toBe(1);
    const running = (await listJobs(db, scope, older!.id)).find((j) => j.state === "running")!;
    const [runningAttempt] = await listAttempts(db, scope, running.id);
    await recordExec(db, scope, runningAttempt!.id, sched.owner, { sandboxId: "sb-old" });

    // a newer push in the same group
    gh.state.head = { sha: SHA("b"), message: "newer", login: "octocat" };
    const res = await ingest(gh);
    expect(res.created).toHaveLength(1);
    expect(res.superseded).toEqual([
      expect.objectContaining({ attemptId: runningAttempt!.id, sandboxId: "sb-old" }),
    ]);

    const runs = await listRuns(db, scope);
    const newer = runs.find((r) => r.id !== older!.id)!;
    expect((await listJobs(db, scope, newer.id)).map((j) => j.state)).toEqual(["queued", "queued"]);
    expect((await listJobs(db, scope, older!.id)).map((j) => j.state)).toEqual([
      "cancelled",
      "cancelled",
    ]);
    expect((await getRun(db, scope, older!.id))?.status).toBe("cancelled");
    expect((await listAttempts(db, scope, running.id))[0]).toMatchObject({
      state: "cancelled",
      errorClass: "superseded by a newer run",
    });

    // R3: the new run's rows exist before anything of the old one is cancelled
    const events = await listEvents(db, scope, { after: 0, limit: 500 });
    const newQueued = events.find((e) => e.type === "run.queued" && e.runId === newer.id)!;
    const oldCancelled = events.find(
      (e) =>
        e.type === "job.state_changed" &&
        e.runId === older!.id &&
        e.payload.includes('"to":"cancelled"'),
    )!;
    expect(newQueued.id).toBeLessThan(oldCancelled.id);

    // the worker running the old job is told to stop at once
    expect(sched.abort(res.superseded.map((r) => r.attemptId))).toBe(1);
    await sched.idle();
    expect(abortedBy).toHaveLength(1);
    // and its late result cannot overwrite the cancel
    expect((await listAttempts(db, scope, running.id))[0]?.state).toBe("cancelled");
  });

  test("without cancel-in-progress both runs stay, and a group is per project", async () => {
    const gh = makeGithub();
    gh.state.files.set("*", GROUP(false));
    await ingest(gh);
    gh.state.head = { sha: SHA("b"), message: "newer", login: "octocat" };
    const res = await ingest(gh);
    expect(res.superseded).toEqual([]);
    const runs = await listRuns(db, scope);
    expect(runs).toHaveLength(2);
    expect(runs.map((r) => r.status)).toEqual(["queued", "queued"]);
  });

  test("a run in another group is left alone", async () => {
    const gh = makeGithub();
    gh.state.files.set("*", GROUP(true));
    await ingest(gh);
    gh.state.files.set(SHA("b"), GROUP(true).replace("ci-${{ github.ref }}", "other"));
    gh.state.head = { sha: SHA("b"), message: "different group", login: "octocat" };
    const res = await ingest(gh);
    expect(res.superseded).toEqual([]);
    expect((await listRuns(db, scope)).map((r) => r.status)).toEqual(["queued", "queued"]);
  });
});

describe("re-attach with the stored plan", () => {
  test("a worker that died after starting the job: the next boot replays the exec from the stored plan, with no repo fetch", async () => {
    const gh = makeGithub();
    gh.state.files.set(
      "*",
      "on: push\njobs:\n  slow:\n    runs-on: ubuntu-latest\n    steps:\n      - run: sleep 1\n",
    );
    await ingest(gh);
    const [run] = await listRuns(db, scope);
    const [job] = await listJobs(db, scope, run!.id);

    // Worker A runs the real runner but dies before cleaning up: its sandbox and exec survive,
    // and nothing is written about how it ended. (Provider destroy is a no-op, as after kill -9.)
    const provider = world.provider();
    const dying: Provider = Object.assign(Object.create(provider) as Provider, {
      destroy: async () => {},
    });
    const act = await actTarball();
    const tarball = await repoTarball();
    const inner = createActRunner({
      db,
      source: sourceFor(gh, tarball),
      resolver: staticResolver({}),
      act,
      planRoot: root,
      pollMs: 30,
    });
    const kill = new AbortController();
    const A = new Scheduler({
      db,
      providers: () => dying,
      heartbeatMs: 100_000,
      leaseMs: 800,
      runner: async (ctx) => {
        void inner({ ...ctx, signal: kill.signal });
        return new Promise(() => {}); // A never reports: it is dead
      },
    });
    expect(await A.tick()).toBe(1);
    // wait until the real runner has stored the plan and the exec
    let attempt = (await listAttempts(db, scope, job!.id))[0]!;
    for (let i = 0; i < 200 && !(attempt.plan && attempt.execId); i++) {
      await Bun.sleep(25);
      attempt = (await listAttempts(db, scope, job!.id))[0]!;
    }
    expect(attempt.plan).toBeString();
    expect(attempt.execId).toBeString();
    kill.abort(); // the inner runner stops watching, as if the process were gone
    await Bun.sleep(900); // the lease lapses

    // reboot: a new worker whose repo source must never be used and has no network
    let checkouts = 0;
    const B = new Scheduler({
      db,
      providers: () => provider,
      leaseMs: 60_000,
      runner: createActRunner({
        db,
        source: {
          checkout: async () => {
            checkouts++;
            throw new Error("no network: a re-attach must not fetch the repo");
          },
        },
        pollMs: 30,
      }),
    });
    const report = await reconcileExpired(db, () => provider, {
      owner: B.owner,
      leaseMs: 60_000,
      adopt: (c, r) => B.adopt(c, r),
    });
    expect(report.adopted).toHaveLength(1);
    await B.idle();
    expect(checkouts).toBe(0);

    const done = (await listAttempts(db, scope, job!.id))[0]!;
    expect(done).toMatchObject({ state: "success", exitCode: 0, leaseOwner: null });
    expect((await getRun(db, scope, run!.id))?.status).toBe("success");
    const log = Buffer.concat((await readLog(db, scope, done.id)).map((c) => c.bytes)).toString();
    expect(log).toContain("Set up job");
    expect(log).toContain("job success");
    expect(await provider.list({})).toEqual([]); // the sandbox is destroyed after the replay
  }, 30_000);
});
