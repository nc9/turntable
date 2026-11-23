import { parse as parseYaml } from "yaml";
import { buildActEvent } from "../src/run/act-event";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex, staticResolver, tarDirectory } from "@longshore/act-runner";
import { FakeWorld } from "@longshore/provider-sdk/testing";
import type { Provider } from "@longshore/provider-sdk";
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
  setProjectEgress,
  transitionJob,
  updateAttempt,
} from "../src/db";
import { dispatch, registry } from "../src/ops";
import {
  setEgressPolicy,
  setPolicy,
  setSandboxPolicy,
  showEgress,
  showPolicy,
} from "../src/ops/policy-cli";
import { egressForRun } from "../src/scheduler/egress";
import { credentialsFor } from "../src/trust";
import { mintToken } from "./ops-helpers";
import { GithubClient, pollConfigSchema, pollRepo, type PollRepoConfig } from "../src/poll";
import { createActRunner, reconcileExpired, Scheduler } from "../src/scheduler";
import { parseSandboxSizes } from "../src/scheduler/sandbox-size";
import { makeGithub, SHA } from "./github-stub";

const tmp = mkdtempSync(join(tmpdir(), "tt-worker-wf-"));
const world = new FakeWorld({ hostPaths: [tmp], exec: { tickSeconds: 1 } });
afterAll(() => {
  world.dispose();
  rmSync(tmp, { recursive: true, force: true });
});

/** A stand-in for act, as in run-workflow.test.ts: events for the job, outputs, exit per job id. */
const FAKE_ACT = String.raw`#!/bin/sh
J=""; W=""; ARGS="$*"
while [ $# -gt 0 ]; do
  case "$1" in -j) J=$2; shift;; -W) W=$2; shift;; esac
  shift
done
R=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$R/seen" "$R/outputs"
cp "$W" "$R/seen/$J.yml"
cp "$W" "$R/seen/$J.$$.all.yml"
ev() { printf '{"jobID":"%s","level":"info","msg":"%s","step":"%s","stepid":["--setup-job"],"time":"t"%s}\n' "$1" "$2" "$3" "$4"; }
ev stubjob "stub" "Set up job" ',"stepResult":"success"'
ev "$J" "Run" "Set up job" ""
case "$ARGS" in *ACTIONS_CACHE_URL*)
  printf '{"jobID":"%s","raw_output":true,"msg":"ARGV %s\\n","step":"Set up job","stepid":["--setup-job"],"time":"t"}\n' "$J" "$ARGS" ;;
esac
ev "$J" "ok" "Set up job" ',"stepResult":"success"'
case "$J" in
  noisy)
    # Built first and written in one go, after a pause, so the controller's first read sees the
    # whole burst and the cap (not a lucky early poll) decides what survives.
    out=""; i=0
    while [ $i -lt 400 ]; do
      out="$out$(printf '{"jobID":"noisy","raw_output":true,"msg":"line %s of noisy output padded to be long enough\\n","step":"Set up job","stepid":["--setup-job"],"time":"t"}' "$i")
"
      i=$((i+1))
    done
    sleep 1
    printf '%s' "$out" ;;
  forger)
    printf '{"jobID":"forger","raw_output":true,"msg":"\\n[longshore: 99999 bytes of output omitted]\\n","step":"Set up job","stepid":["--setup-job"],"time":"t"}\n' ;;
esac
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
  runnerOpts: Partial<Parameters<typeof createActRunner>[0]> = {},
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
      ...runnerOpts,
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
      // the class the job ran as is recorded for the secrets vault: a push to main is protected
      expect(att?.trustClass).toBe("protected");
      // the sandbox's own life is recorded: created after the attempt started, destroyed (and
      // confirmed) before it finished, so sandbox-minutes do not include any waiting
      expect(att!.sandboxCreatedAt).toBeNumber();
      expect(att!.sandboxDestroyedAt).toBeNumber();
      expect(att!.sandboxCreatedAt!).toBeGreaterThanOrEqual(att!.startedAt!);
      expect(att!.sandboxDestroyedAt!).toBeGreaterThanOrEqual(att!.sandboxCreatedAt!);
      expect(att!.sandboxDestroyedAt!).toBeLessThanOrEqual(att!.finishedAt!);
    }
    // and shown: in get_run and in the attempt's final event
    const token = (await mintToken(db, scope, "reader")).secret;
    const got = await dispatch({ registry, db }, { kind: "bearer", token }, "get_run", {
      run_id: run!.id,
    });
    const att0 = (got.ok ? (got.output as any) : undefined).jobs[0].attempts[0];
    expect(att0.sandbox_created_at).toBeString();
    expect(att0.sandbox_destroyed_at).toBeString();
    expect(att0.sandbox_seconds).toBeNumber();
    const finalEvents = (await listEvents(db, scope, { after: 0, limit: 500 })).filter(
      (e) => e.type === "job.state_changed" && JSON.parse(e.payload).level === "attempt",
    );
    const done = finalEvents.map((e) => JSON.parse(e.payload)).filter((p) => p.to === "success");
    expect(done.length).toBeGreaterThan(0);
    for (const p of done) {
      expect(p.sandbox_created_at).toBeString();
      expect(p.sandbox_destroyed_at).toBeString();
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

describe("sandbox size from runs-on labels", () => {
  const SIZED = `name: sized
on:
  push:
    branches: [main]
jobs:
  heavy:
    runs-on: ubuntu-latest-4-cores
    steps:
      - run: echo heavy
  light:
    runs-on: ubuntu-latest
    steps:
      - run: echo light
  odd:
    runs-on: ubuntu-latest-96-cores
    steps:
      - run: echo odd
`;
  const sizes = parseSandboxSizes(
    JSON.stringify({
      classes: {
        small: { cpus: 2, memoryMb: 4096 },
        large: { cpus: 4, memoryMb: 8192, snapshot: "snap-large" },
        huge: { cpus: 96 },
      },
      labels: { "ubuntu-latest-4-cores": "large", "ubuntu-latest-96-cores": "huge" },
      default: "small",
      maxCpus: 8,
    }),
    "test",
  );
  const run = async (opts: Parameters<typeof makeScheduler>[2]) => {
    const gh = makeGithub();
    gh.state.files.set("*", SIZED);
    await ingest(gh);
    const real = world.provider();
    const specs: { job: string; spec: Parameters<Provider["create"]>[0] }[] = [];
    const provider: Provider = Object.assign(Object.create(real) as Provider, {
      create: (spec: Parameters<Provider["create"]>[0]) => {
        specs.push({ job: spec.labels["longshore.job"] as string, spec });
        return real.create(spec);
      },
    });
    const sched = await makeScheduler(gh, provider, opts);
    await drain(sched);
    const jobs = await listJobs(db, scope, (await listRuns(db, scope))[0]!.id);
    const byKey = (k: string) => specs.find((s) => s.job === jobs.find((j) => j.jobKey === k)?.id)!;
    return { byKey, specs };
  };

  test("each job's sandbox gets the class its label maps to; an unknown label gets the default; the ceiling clamps", async () => {
    const { byKey } = await run({ sizes });
    expect(byKey("heavy").spec.resources).toEqual({ cpus: 4, memoryMb: 8192 });
    expect(byKey("heavy").spec.snapshot).toBe("snap-large");
    expect(byKey("light").spec.resources).toEqual({ cpus: 2, memoryMb: 4096 });
    expect(byKey("light").spec.snapshot).toBeUndefined();
    // a class past maxCpus is clamped to it
    expect(byKey("odd").spec.resources).toEqual({ cpus: 8 });
  });

  test("with no size map the spec carries no resources: the provider's own default", async () => {
    const { specs } = await run({});
    expect(specs.length).toBe(3);
    expect(
      specs.every((s) => s.spec.resources === undefined && s.spec.snapshot === undefined),
    ).toBe(true);
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

  test("a push stores the commit before it, and act is given ref, before and after", async () => {
    const gh = makeGithub();
    gh.state.files.set("*", PIPELINE);
    await ingest(gh);
    gh.state.head = { sha: SHA("c"), message: "feat: second", login: "octocat" };
    await ingest(gh);
    const second = (await listRuns(db, scope)).find((r) => r.sha === SHA("c"));
    expect(buildActEvent(second!)).toEqual({
      ref: "refs/heads/main",
      before: SHA("a"),
      after: SHA("c"),
      repository: { full_name: "acme/web" },
    });
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
    // the event act will be given carries the forge facts stored at ingest, base sha included
    const ev = buildActEvent(run!);
    expect(ev).toMatchObject({
      number: 5,
      repository: { full_name: "acme/web" },
      pull_request: {
        number: 5,
        base: { ref: "main", sha: SHA("b"), repo: { full_name: "acme/web" } },
        head: { sha: SHA("e"), repo: { full_name: "acme/web" } },
        draft: false,
      },
    });
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

    // the worker running the old job was told to stop at once, by the commit-time announcement
    // (no heartbeat needed: heartbeatMs is its default here and the lease is 60 s)
    await sched.idle();
    expect(sched.abort(res.superseded.map((r) => r.attemptId))).toBe(0); // already stopped
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

describe("local composite actions at ingest", () => {
  test("a docker step inside a local composite action marks its job unsupported at plan time; a path out of the repo is never requested", async () => {
    const gh = makeGithub();
    gh.state.files.set(
      "*",
      `on: push
jobs:
  dock:
    runs-on: ubuntu-latest
    steps:
      - uses: ./.github/actions/dockerish
  nested:
    runs-on: ubuntu-latest
    steps:
      - uses: ./.github/actions/outer
  plain:
    runs-on: ubuntu-latest
    steps:
      - uses: ./.github/actions/fine
  escape:
    runs-on: ubuntu-latest
    steps:
      - uses: ./../../../etc/x
`,
    );
    const composite = (steps: string) => `name: a\nruns:\n  using: composite\n  steps:\n${steps}`;
    gh.state.extra.set(
      ".github/actions/dockerish/action.yml",
      composite("    - shell: bash\n      run: docker build .\n"),
    );
    gh.state.extra.set(
      ".github/actions/outer/action.yml",
      composite("    - uses: ./.github/actions/dockerish\n"),
    );
    gh.state.extra.set(
      ".github/actions/fine/action.yml",
      composite("    - shell: bash\n      run: echo fine\n"),
    );
    await ingest(gh);
    const [run] = await listRuns(db, scope);
    const planned = Object.fromEntries(
      (await listJobs(db, scope, run!.id)).map((j) => [j.jobKey, JSON.parse(j.planned!)]),
    );
    expect(planned.dock.unsupported).toContain("docker");
    expect(planned.nested.unsupported).toContain("docker"); // found through the composite it uses
    expect(planned.plain.unsupported).toBeUndefined();
    expect(planned.escape.unsupported).toContain("outside the repository");
    // nothing outside the repo was ever requested, and every request was a read
    expect(gh.state.calls.some((c) => c.path.includes("..") || c.path.includes("etc/x"))).toBe(
      false,
    );
    expect(new Set(gh.state.calls.map((c) => c.method))).toEqual(new Set(["GET"]));

    // the unsupported jobs leave the queue with their reason as the log; the plain one runs
    const sched = await makeScheduler(gh);
    await drain(sched);
    const jobs = await listJobs(db, scope, run!.id);
    expect(Object.fromEntries(jobs.map((j) => [j.jobKey, j.state]))).toEqual({
      dock: "skipped",
      nested: "skipped",
      plain: "success",
      escape: "skipped",
    });
  });

  test("a workflow with no local actions fetches none", async () => {
    const gh = makeGithub();
    gh.state.files.set("*", PIPELINE);
    await ingest(gh);
    expect(
      gh.state.calls.some((c) => c.path.includes("/contents/") && !c.path.includes("ci.yml")),
    ).toBe(false);
  });
});

describe("concurrency groups without cancel-in-progress queue like GitHub's", () => {
  const WF = `on: push
concurrency:
  group: deploy
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

  /** A scheduler whose jobs finish only when the test says so. */
  function held() {
    const releases = new Map<string, () => void>();
    const sched = new Scheduler({
      db,
      providers: () => world.provider(),
      leaseMs: 60_000,
      globalCap: 10,
      perOrgCap: 10,
      runner: (ctx) =>
        new Promise((resolve) => {
          releases.set(`${ctx.run.id}/${ctx.job.jobKey}`, () =>
            resolve({ state: "success", reason: "ok" }),
          );
          ctx.signal.addEventListener("abort", () =>
            resolve({ state: "cancelled", reason: "stopped" }),
          );
        }),
    });
    return {
      sched,
      release: async (runId: string, key: string) => {
        releases.get(`${runId}/${key}`)?.();
        await Bun.sleep(30);
        await sched.idle();
      },
    };
  }

  const push = async (gh: ReturnType<typeof makeGithub>, c: string) => {
    gh.state.head = { sha: SHA(c), message: c, login: "octocat" };
    return ingest(gh);
  };

  test("a newer run waits for the running one; a newer pending run replaces the older pending one", async () => {
    const gh = makeGithub();
    gh.state.files.set("*", WF);
    const { sched, release } = held();
    await push(gh, "a");
    const [a] = await listRuns(db, scope);
    expect(await sched.tick()).toBe(1); // A's first job runs
    expect((await getRun(db, scope, a!.id))?.status).toBe("running");

    await push(gh, "b"); // pending behind A
    const res = await push(gh, "c"); // replaces B as the pending run
    expect(res.superseded).toEqual([]); // nothing was running in B
    const runs = await listRuns(db, scope);
    const bySha = Object.fromEntries(runs.map((r) => [r.sha, r]));
    expect(bySha[SHA("a")]?.status).toBe("running"); // the running run is never touched
    expect(bySha[SHA("b")]?.status).toBe("cancelled"); // the replaced pending run
    expect(bySha[SHA("c")]?.status).toBe("queued");
    const bAttempt = (
      await listAttempts(db, scope, (await listJobs(db, scope, bySha[SHA("b")]!.id))[0]!.id)
    )[0];
    expect(bAttempt?.errorClass).toBe("replaced by a newer pending run");

    // nothing of C starts while A is unfinished, even with free slots
    expect(await sched.tick()).toBe(0);
    await release(a!.id, "slow");
    expect(await sched.tick()).toBe(1); // A's second job: A is still the running run
    expect(
      (await listJobs(db, scope, bySha[SHA("c")]!.id)).every((j) => j.state === "queued"),
    ).toBe(true);
    await release(a!.id, "after");
    expect((await getRun(db, scope, a!.id))?.status).toBe("success");

    // A is done: C goes
    expect(await sched.tick()).toBe(1);
    expect((await getRun(db, scope, bySha[SHA("c")]!.id))?.status).toBe("running");
    expect((await getRun(db, scope, bySha[SHA("b")]!.id))?.status).toBe("cancelled"); // stays so
  });

  test("with nothing running, two queued runs are not replaced: the older goes first, the newer waits", async () => {
    const gh = makeGithub();
    gh.state.files.set("*", WF);
    const { sched, release } = held();
    await push(gh, "a");
    await push(gh, "b");
    const runs = await listRuns(db, scope);
    expect(runs.map((r) => r.status)).toEqual(["queued", "queued"]); // neither was cancelled
    const [newer, older] = runs as [(typeof runs)[number], (typeof runs)[number]];
    expect(await sched.tick()).toBe(1);
    expect((await getRun(db, scope, older.id))?.status).toBe("running");
    expect(await sched.tick()).toBe(0); // the newer waits
    await release(older.id, "slow");
    await sched.tick();
    await release(older.id, "after");
    expect(await sched.tick()).toBe(1);
    expect((await getRun(db, scope, newer.id))?.status).toBe("running");
  });

  test("runs in another group, or with no group, are never held back", async () => {
    const gh = makeGithub();
    gh.state.files.set("*", WF);
    const { sched } = held();
    await push(gh, "a");
    gh.state.files.set(SHA("b"), WF.replace("group: deploy", "group: other"));
    gh.state.files.set(SHA("c"), WF.replace("concurrency:\n  group: deploy\n", ""));
    await push(gh, "b");
    await push(gh, "c");
    expect(await sched.tick()).toBe(3); // all three first jobs start at once
  });
});

describe("manual cancel stops the worker at once", () => {
  test("cancelling a running run aborts its runner and destroys the sandbox, with no heartbeat needed", async () => {
    const { dispatch, registry } = await import("../src/ops");
    const { mintToken } = await import("./ops-helpers");
    const gh = makeGithub();
    gh.state.files.set(
      "*",
      "on: push\njobs:\n  slow:\n    runs-on: ubuntu-latest\n    steps:\n      - run: sleep 3\n",
    );
    await ingest(gh);
    const [run] = await listRuns(db, scope);
    const [job] = await listJobs(db, scope, run!.id);
    const provider = world.provider();
    const act = await actTarball();
    const sched = new Scheduler({
      db,
      providers: () => provider,
      heartbeatMs: 100_000, // a heartbeat would not notice for a very long time
      leaseMs: 600_000,
      runner: createActRunner({
        db,
        source: sourceFor(gh, await repoTarball()),
        resolver: staticResolver({}),
        act,
        planRoot: root,
        pollMs: 30,
      }),
    });
    expect(await sched.tick()).toBe(1);
    let attempt = (await listAttempts(db, scope, job!.id))[0]!;
    for (let i = 0; i < 200 && !(attempt.sandboxId && attempt.execId); i++) {
      await Bun.sleep(25);
      attempt = (await listAttempts(db, scope, job!.id))[0]!;
    }
    expect((await provider.list({})).length).toBe(1);

    const token = (await mintToken(db, { orgId: scope.orgId }, "operator")).secret;
    const t0 = Date.now();
    const res = await dispatch({ registry, db }, { kind: "bearer", token }, "cancel", {
      run_id: run!.id,
    });
    expect(res.ok).toBe(true);
    await sched.idle(); // the runner returned: it was aborted, not left to finish
    expect(Date.now() - t0).toBeLessThan(1500); // the job itself would have run for 3 s
    expect(await provider.list({})).toEqual([]); // the sandbox is gone
    expect((await listAttempts(db, scope, job!.id))[0]).toMatchObject({
      state: "cancelled",
      leaseOwner: null,
    });
    expect((await listJobs(db, scope, run!.id))[0]?.state).toBe("cancelled");
    expect((await getRun(db, scope, run!.id))?.status).toBe("cancelled");
  }, 20_000);

  const INJECT = `on:
  push:
  pull_request:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ github.event.pull_request.title }}"
`;

  test("the server path: a protected run fails lint on outside text in a script", async () => {
    const gh = makeGithub();
    gh.state.files.set("*", INJECT);
    expect((await ingest(gh)).created).toHaveLength(1);
    await drain(await makeScheduler(gh));
    const [run] = await listRuns(db, scope);
    const [job] = await listJobs(db, scope, run!.id);
    // A lint failure is deterministic and user-actionable: a failure with a policy reason, not
    // an infra_error (which would be retried).
    expect(job?.state).toBe("failure");
    const [att] = await listAttempts(db, scope, job!.id);
    expect(att).toMatchObject({ state: "failure", errorClass: null });
    const text = Buffer.concat((await readLog(db, scope, att!.id)).map((c) => c.bytes)).toString();
    expect(text).toContain("lint: workflow lint failed");
    expect(text).toContain("github.event.pull_request.title");
  });

  test("the server path: an untrusted pull request run only warns and holds no credentials", async () => {
    const gh = makeGithub();
    gh.state.files.set("*", INJECT);
    gh.state.pulls = [{ number: 5, user: "octocat", headSha: SHA("d"), baseRef: "main" }];
    gh.state.head = { sha: SHA("a"), message: "x", login: "octocat" };
    const res = await ingest(gh);
    const prRun = (await listRuns(db, scope)).find((r) => r.event === "pull_request");
    expect(res.created.length).toBeGreaterThan(0);
    expect(prRun).toBeDefined();
    await drain(await makeScheduler(gh));
    const jobs = await listJobs(db, scope, prRun!.id);
    expect(jobs.map((j) => j.state)).toEqual(["success"]);
  });
});

describe("trust classes and approval", () => {
  const SIMPLE = `name: ci
on: [push, pull_request]
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`;
  const ghWithWorkflow = () => {
    const gh = makeGithub();
    gh.state.files.set("*", SIMPLE);
    return gh;
  };
  const APPROVAL_CFG = (over: Partial<PollRepoConfig> = {}) =>
    CFG({ prMode: "approval", authors: [], ...over });
  // A client with a token, so the forge is asked about authors (the stub accepts any value).
  const ingestAs = (gh: ReturnType<typeof makeGithub>, cfg: PollRepoConfig = APPROVAL_CFG()) =>
    pollRepo(
      {
        db,
        github: new GithubClient({
          fetch: gh.fetch,
          baseUrl: "https://api.github.com",
          token: "stub-token",
        }),
        provider: "fake",
      },
      cfg,
    );
  const prRuns = async () => (await listRuns(db, scope)).filter((r) => r.event === "pull_request");
  const trustOf = (r: { trust: string | null }) => JSON.parse(r.trust!);
  const bearer = async (role: "reader" | "operator" | "release_operator") => ({
    kind: "bearer" as const,
    token: (await mintToken(db, { orgId: scope.orgId }, role)).secret,
  });
  const approve = async (
    cred: Awaited<ReturnType<typeof bearer>>,
    runId: string,
    over: Record<string, unknown> = {},
  ) => {
    const run = (await getRun(db, scope, runId))!;
    return dispatch({ registry, db }, cred, "approve_run", {
      run_id: runId,
      head_sha: run.sha,
      workflow_hash: trustOf(run).workflowHash,
      ...over,
    });
  };
  const PR = (over: Record<string, unknown> = {}) => ({
    number: 7,
    user: "stranger",
    headSha: SHA("d"),
    baseRef: "main",
    ...over,
  });

  test("a fork PR is created but never runs; the forge is not asked about its author", async () => {
    const gh = ghWithWorkflow();
    gh.state.roles.set("stranger", "write"); // would be trusted if it were same-repo
    gh.state.pulls = [PR({ headRepo: "evil/web" })];
    await ingestAs(gh);
    const [run] = await prRuns();
    expect(run!.status).toBe("awaiting_approval");
    expect(trustOf(run!)).toMatchObject({
      class: "untrusted_pr",
      facts: { sameRepo: false, actor: "stranger" },
    });
    expect(trustOf(run!).reasons.join(" ")).toContain("fork");
    expect((await listJobs(db, scope, run!.id)).map((j) => j.state)).toEqual(["awaiting_approval"]);
    expect(gh.state.calls.some((c) => c.path.includes("/collaborators/"))).toBe(false);
    // The scheduler claims the push run only, never the held one.
    await drain(await makeScheduler(gh));
    expect((await getRun(db, scope, run!.id))!.status).toBe("awaiting_approval");
    expect((await listJobs(db, scope, run!.id)).map((j) => j.state)).toEqual(["awaiting_approval"]);
  });

  test("a same-repo PR by a non-collaborator waits; so does one whose permission cannot be read", async () => {
    const gh = ghWithWorkflow();
    gh.state.roles.set("reader-only", "read");
    gh.state.pulls = [
      PR({ number: 1, user: "reader-only", headSha: SHA("1") }),
      PR({ number: 2, user: "nobody", headSha: SHA("2") }),
    ];
    await ingestAs(gh);
    const runs = await prRuns();
    expect(runs.map((r) => [r.prNumber, r.status, trustOf(r).class])).toEqual([
      [2, "awaiting_approval", "untrusted_pr"],
      [1, "awaiting_approval", "untrusted_pr"],
    ]);
    expect(trustOf(runs[1]!).facts.permission).toBe("read");
    expect(trustOf(runs[0]!).facts.permission).toBe("none");

    // A token that cannot ask (403) is "unknown": untrusted, and the reason says so.
    gh.state.permissionStatus = 403;
    gh.state.pulls = [PR({ number: 3, user: "maint", headSha: SHA("3") })];
    await ingestAs(gh);
    const unknown = (await prRuns()).find((r) => r.prNumber === 3)!;
    expect(unknown.status).toBe("awaiting_approval");
    expect(trustOf(unknown).facts.permission).toBe("unknown");
    expect(trustOf(unknown).reasons.join(" ")).toContain("could not be read");
  });

  test("a rate limit or server error on the permission call propagates so the poll retries", async () => {
    const gh = ghWithWorkflow();
    gh.state.pulls = [PR()];
    gh.state.permissionStatus = 500;
    await expect(ingestAs(gh)).rejects.toThrow();
    expect(await prRuns()).toHaveLength(0);
  });

  test("a collaborator with write runs at once as trusted_pr, with no secrets", async () => {
    const gh = ghWithWorkflow();
    gh.state.roles.set("dev", "write");
    gh.state.roles.set("boss", "maintain");
    gh.state.pulls = [
      PR({ number: 4, user: "dev", headSha: SHA("4") }),
      PR({ number: 5, user: "boss", headSha: SHA("5") }),
    ];
    await ingestAs(gh);
    const runs = await prRuns();
    expect(runs.map((r) => [r.status, trustOf(r).class])).toEqual([
      ["queued", "trusted_pr"],
      ["queued", "trusted_pr"],
    ]);
    expect(credentialsFor("trusted_pr")).toEqual({ secrets: false, writeToken: false });
    const sched = await makeScheduler(gh);
    await drain(sched);
    expect((await prRuns()).map((r) => r.status)).toEqual(["success", "success"]);
  });

  test("approval releases the run, is recorded, and never raises the class", async () => {
    const gh = ghWithWorkflow();
    gh.state.pulls = [PR({ headRepo: "evil/web" })];
    await ingestAs(gh);
    const [held] = await prRuns();
    const before = held!.trust;

    // Roles and the binding are enforced.
    expect((await approve(await bearer("operator"), held!.id)).ok).toBe(false);
    const rel = await bearer("release_operator");
    const wrongSha = await approve(rel, held!.id, { head_sha: SHA("e") });
    expect(!wrongSha.ok && wrongSha.error.code).toBe("conflict");
    const wrongHash = await approve(rel, held!.id, { workflow_hash: "0".repeat(64) });
    expect(!wrongHash.ok && wrongHash.error.code).toBe("conflict");
    expect((await getRun(db, scope, held!.id))!.status).toBe("awaiting_approval");

    const ok = await approve(rel, held!.id);
    expect(ok.ok && ok.output).toMatchObject({ state: "queued", released_jobs: 1 });
    await drain(await makeScheduler(gh));
    const after = (await getRun(db, scope, held!.id))!;
    expect(after.status).toBe("success");
    // The class is exactly what was decided, so credentials stay withheld.
    expect(after.trust).toBe(before);
    expect(trustOf(after).class).toBe("untrusted_pr");
    expect(credentialsFor(trustOf(after).class)).toEqual({ secrets: false, writeToken: false });
    // and what the job ran as is on its attempt, where the vault looks
    const [jobRow] = await listJobs(db, scope, held!.id);
    expect((await listAttempts(db, scope, jobRow!.id))[0]?.trustClass).toBe("untrusted_pr");
    expect(JSON.parse(after.approval!)).toMatchObject({
      head_sha: SHA("d"),
      workflow_hash: trustOf(after).workflowHash,
    });
    expect(JSON.parse(after.approval!).by).toStartWith("token:");

    // Nothing waits any more: a second approval is refused.
    const again = await approve(rel, held!.id);
    expect(!again.ok && again.error.code).toBe("conflict");
  });

  test("a new push needs its own approval, and the old sha cannot approve the new run", async () => {
    const gh = ghWithWorkflow();
    gh.state.pulls = [PR({ headRepo: "evil/web", headSha: SHA("d") })];
    await ingestAs(gh);
    const [first] = await prRuns();
    const rel = await bearer("release_operator");
    expect((await approve(rel, first!.id)).ok).toBe(true);

    gh.state.pulls = [PR({ headRepo: "evil/web", headSha: SHA("f") })];
    await ingestAs(gh);
    const second = (await prRuns()).find((r) => r.sha === SHA("f"))!;
    expect(second.status).toBe("awaiting_approval");
    expect(second.approval).toBeNull();
    // The approved sha is not the new run's sha.
    const stale = await approve(rel, second.id, { head_sha: SHA("d") });
    expect(!stale.ok && stale.error.code).toBe("conflict");
    await drain(await makeScheduler(gh));
    expect((await getRun(db, scope, second.id))!.status).toBe("awaiting_approval");

    // A waiting run of the same PR is replaced by the newer push, never left to approve.
    gh.state.pulls = [PR({ headRepo: "evil/web", headSha: SHA("9") })];
    await ingestAs(gh);
    expect((await getRun(db, scope, second.id))!.status).toBe("cancelled");
    const stale2 = await approve(rel, second.id);
    expect(!stale2.ok && stale2.error.code).toBe("conflict");
  });

  test("a held run's workflow cannot name another run's concurrency group", async () => {
    const gh = ghWithWorkflow();
    const GROUPED = (cancel: boolean) => `name: ci
on: [push, pull_request]
concurrency:
  group: ci
  cancel-in-progress: ${cancel}
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`;
    gh.state.files.set("*", GROUPED(false));
    await ingestAs(gh);
    const [push] = await listRuns(db, scope);
    expect(push!.concurrencyGroup).toBe("ci");

    // A fork's file asks for the same group with cancel-in-progress: it must not touch the push.
    gh.state.files.set(SHA("d"), GROUPED(true));
    gh.state.pulls = [PR({ headRepo: "evil/web" })];
    await ingestAs(gh);
    const [held] = await prRuns();
    expect(held!.concurrencyGroup).toBe("untrusted:pr-7:ci");
    expect((await getRun(db, scope, push!.id))!.status).toBe("queued");
    // Nor does it block later default-branch runs: its group is its own.
    gh.state.head = { sha: SHA("b"), message: "next", login: "octocat" };
    gh.state.files.set(SHA("b"), GROUPED(false));
    await ingestAs(gh);
    const sched = await makeScheduler(gh);
    await drain(sched);
    const pushes = (await listRuns(db, scope)).filter((r) => r.event === "push");
    expect(pushes.map((r) => r.status)).toEqual(["success", "success"]);
  });

  test("the worker refuses an untrusted run with no approval, or an approval that no longer matches", async () => {
    const gh = ghWithWorkflow();
    gh.state.pulls = [PR({ headRepo: "evil/web" })];
    await ingestAs(gh);
    const [held] = await prRuns();
    // Released by some other means than approve_run: no approval is on record.
    for (const j of await listJobs(db, scope, held!.id)) {
      await transitionJob(db, scope, j.id, "queued");
      const a = (await listAttempts(db, scope, j.id)).at(-1)!;
      await updateAttempt(db, scope, a.id, { state: "queued" });
    }
    await drain(await makeScheduler(gh));
    const [job] = await listJobs(db, scope, held!.id);
    expect(job!.state).toBe("infra_error");
    expect((await listAttempts(db, scope, job!.id))[0]!.errorClass).toContain("no approval");
  });

  test("a changed workflow file after approval is refused by its hash", async () => {
    const gh = ghWithWorkflow();
    gh.state.pulls = [PR({ headRepo: "evil/web" })];
    await ingestAs(gh);
    const [held] = await prRuns();
    expect((await approve(await bearer("release_operator"), held!.id)).ok).toBe(true);
    // The tree the worker reads now differs from what was approved.
    gh.state.files.set(SHA("d"), `${gh.state.files.get("*")}# changed\n`);
    await drain(await makeScheduler(gh));
    const [job] = await listJobs(db, scope, held!.id);
    expect(job!.state).toBe("infra_error");
    expect((await listAttempts(db, scope, job!.id))[0]!.errorClass).toContain("does not match");
  });

  test("runs waiting for approval are capped and do not use the hourly cap", async () => {
    const gh = ghWithWorkflow();
    gh.state.pulls = [
      PR({ number: 1, headSha: SHA("1"), headRepo: "evil/web" }),
      PR({ number: 2, headSha: SHA("2"), headRepo: "evil/web" }),
    ];
    const res = await ingestAs(gh, APPROVAL_CFG({ maxWaitingRuns: 1, maxRunsPerHour: 2 }));
    expect(res.refused.map((r) => r.reason)).toContain("too many runs are waiting for approval");
    // One push run and one held run: the held one does not count toward the hourly cap of 2,
    // so the next default-branch commit still runs.
    gh.state.head = { sha: SHA("b"), message: "next", login: "octocat" };
    const next = await ingestAs(gh, APPROVAL_CFG({ maxWaitingRuns: 1, maxRunsPerHour: 2 }));
    expect(next.refused.map((r) => r.reason)).not.toContain("hourly run cap reached");
    expect((await listRuns(db, scope)).filter((r) => r.event === "push")).toHaveLength(2);
  });

  test("the default branch push is protected, from the project's refs and the forge", async () => {
    const gh = ghWithWorkflow();
    await ingestAs(gh);
    const [push] = await listRuns(db, scope);
    expect(trustOf(push!)).toMatchObject({ class: "protected", facts: { forgeProtected: true } });
  });

  test("get_run shows the decision and the approval", async () => {
    const gh = ghWithWorkflow();
    gh.state.pulls = [PR({ headRepo: "evil/web" })];
    await ingestAs(gh);
    const [held] = await prRuns();
    const rd = await bearer("reader");
    const view = await dispatch({ registry, db }, rd, "get_run", { run_id: held!.id });
    expect(view.ok && view.output).toMatchObject({
      state: "awaiting_approval",
      trust_class: "untrusted_pr",
      trust: { class: "untrusted_pr", workflow_hash: trustOf(held!).workflowHash },
      approval: null,
    });
  });

  test("pull request numbers, groups and waiting caps are scoped by repo within one project", async () => {
    const GROUPED = `name: ci
on: [push, pull_request]
concurrency:
  group: ci
  cancel-in-progress: true
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`;
    const web = makeGithub("acme/web");
    const api = makeGithub("acme/api");
    for (const g of [web, api]) g.state.files.set("*", GROUPED);
    const cfgFor = (repo: string) => APPROVAL_CFG({ repo, maxWaitingRuns: 1 });
    const pr = (headSha: string) => [PR({ number: 7, headSha, headRepo: "evil/x" })];
    web.state.pulls = pr(SHA("1"));
    api.state.pulls = pr(SHA("2"));
    await ingestAs(web, cfgFor("acme/web"));
    const apiRes = await ingestAs(api, cfgFor("acme/api"));
    // The cap is per repo: web's waiting run does not stop api's.
    expect(apiRes.refused.map((r) => r.reason)).not.toContain(
      "too many runs are waiting for approval",
    );
    const held = (await prRuns()).filter((r) => r.prNumber === 7);
    expect(held.map((r) => r.repo).toSorted()).toEqual(["acme/api", "acme/web"]);

    // A new push to web's PR 7 replaces web's waiting run only.
    web.state.pulls = pr(SHA("3"));
    await ingestAs(web, cfgFor("acme/web"));
    const byRepo = (repo: string) =>
      Promise.all(
        held
          .filter((r) => r.repo === repo)
          .map(async (r) => (await getRun(db, scope, r.id))!.status),
      );
    expect(await byRepo("acme/web")).toEqual(["cancelled"]);
    expect(await byRepo("acme/api")).toEqual(["awaiting_approval"]);

    // A cancel-in-progress push in one repo does not cancel the other repo's run of the group.
    web.state.head = { sha: SHA("b"), message: "x", login: "octocat" };
    api.state.head = { sha: SHA("c"), message: "y", login: "octocat" };
    await ingestAs(api, cfgFor("acme/api"));
    const apiPush = (await listRuns(db, scope)).find(
      (r) => r.event === "push" && r.repo === "acme/api",
    )!;
    await ingestAs(web, cfgFor("acme/web"));
    expect((await getRun(db, scope, apiPush.id))!.status).toBe("queued");
  });

  test("run.plan carries the decided class and the egress: repo config, else project setting, else none", async () => {
    const plan = async () => JSON.parse((await listRuns(db, scope))[0]!.plan!);
    const gh1 = ghWithWorkflow();
    await ingestAs(gh1);
    expect(await plan()).toMatchObject({ trust: "protected", egress: "none" });

    const gh2 = ghWithWorkflow();
    gh2.state.head = { sha: SHA("b"), message: "x", login: "octocat" };
    await setProjectEgress(db, scope, "allowlist");
    await ingestAs(gh2);
    expect(await plan()).toMatchObject({ egress: "allowlist" });

    const gh3 = ghWithWorkflow();
    gh3.state.head = { sha: SHA("c"), message: "x", login: "octocat" };
    await ingestAs(gh3, APPROVAL_CFG({ egress: "open" }));
    expect(await plan()).toMatchObject({ trust: "protected", egress: "open" });

    // A held fork run records its class too.
    const gh4 = ghWithWorkflow();
    gh4.state.head = { sha: SHA("c"), message: "x", login: "octocat" };
    gh4.state.pulls = [PR({ headRepo: "evil/web" })];
    await ingestAs(gh4);
    const held = (await prRuns())[0]!;
    // The project allows an allowlist, but untrusted runs are held at none unless untrustedEgress says so.
    expect(JSON.parse(held.plan!)).toMatchObject({ trust: "untrusted_pr", egress: "none" });
  });

  test("a flood of fork PRs is bounded before any forge call: waiting cap first, a per-poll budget, a memo", async () => {
    const gh = ghWithWorkflow();
    const shaOf = (i: number) => (i + 1).toString(16).padStart(40, "0");
    gh.state.pulls = Array.from({ length: 100 }, (_, i) =>
      PR({ number: i + 1, user: `u${i}`, headSha: shaOf(i), headRepo: "evil/web" }),
    );
    const prShas = new Set(gh.state.pulls.map((p) => p.headSha));
    const cfg = APPROVAL_CFG({ maxWaitingRuns: 20, maxNewPrsPerPoll: 5 });
    const overCap = new Set<string>();
    const poll = () =>
      pollRepo(
        {
          db,
          github: new GithubClient({
            fetch: gh.fetch,
            baseUrl: "https://api.github.com",
            token: "stub-token",
          }),
          provider: "fake",
          overCap,
        },
        cfg,
      );
    const prFetches = () =>
      gh.state.calls.filter((c) => {
        const ref = /[?&]ref=([0-9a-f]{40})/.exec(c.path)?.[1];
        return c.path.includes("/contents/") && ref !== undefined && prShas.has(ref);
      }).length;

    // The first poll still ingests the default branch push, and only 5 PRs.
    const first = await poll();
    expect(prFetches()).toBe(5);
    expect((await listRuns(db, scope)).filter((r) => r.event === "push")).toHaveLength(1);
    expect(first.created).toHaveLength(6);
    for (let i = 0; i < 12; i++) await poll();
    // 20 held, and every fetch round beyond that was refused before it was spent.
    expect(await prRuns()).toHaveLength(20);
    expect(prFetches()).toBeLessThanOrEqual(25);
    expect(gh.state.calls.some((c) => c.path.includes("/collaborators/"))).toBe(false);
    // The memo means a full queue is not re-reported every poll.
    const again = await poll();
    expect(again.refused).toHaveLength(0);
    expect(overCap.size).toBeGreaterThan(0);
    // The default branch still gets its runs while the queue is full.
    gh.state.head = { sha: SHA("b"), message: "next", login: "octocat" };
    const next = await poll();
    expect(next.created).toHaveLength(1);

    // Room opens up: the memo clears and one more is admitted.
    const [one] = await prRuns();
    await dispatch({ registry, db }, await bearer("operator"), "cancel", { run_id: one!.id });
    await poll();
    expect(await prRuns()).toHaveLength(21);
  });

  test("untrusted and unclassified pull request markers never use the trusted hourly budget", async () => {
    // A workflow that never triggers for pull requests: every PR becomes a "skipped" marker.
    const gh = makeGithub();
    gh.state.files.set(
      "*",
      "name: ci\non:\n  push:\n    branches: [main]\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n",
    );
    gh.state.pulls = Array.from({ length: 12 }, (_, i) =>
      PR({
        number: i + 1,
        user: `u${i}`,
        headSha: (i + 1).toString(16).padStart(40, "0"),
        headRepo: "evil/web",
      }),
    );
    const cfg = APPROVAL_CFG({ maxRunsPerHour: 2, maxNewPrsPerPoll: 12 });
    await ingestAs(gh, cfg);
    const { countPolledSince } = await import("../src/db");
    expect(await countPolledSince(db, scope, "acme/web", 0)).toBe(1); // the push only
    gh.state.head = { sha: SHA("b"), message: "next", login: "octocat" };
    const res = await ingestAs(gh, cfg);
    expect(res.refused.map((r) => r.reason)).not.toContain("hourly run cap reached");
    expect((await listRuns(db, scope)).filter((r) => r.event === "push")).toHaveLength(2);
  });

  test("approve_run's minimum role is an org policy: release_operator by default, operator if lowered", async () => {
    const gh = ghWithWorkflow();
    gh.state.pulls = [PR({ headRepo: "evil/web" })];
    await ingestAs(gh);
    const [held] = await prRuns();
    const op = await bearer("operator");
    const reader = await bearer("reader");
    const denied = await approve(op, held!.id);
    expect(!denied.ok && denied.error.code).toBe("forbidden");

    expect(await showPolicy(db, "local")).toEqual({ approveRunMinRole: "release_operator" });
    await expect(setPolicy(db, "local", "approve-run-min-role", "admin")).rejects.toThrow();
    await expect(setPolicy(db, "local", "nope", "operator")).rejects.toThrow();
    expect(await setPolicy(db, "local", "approve-run-min-role", "operator")).toMatchObject({
      from: "release_operator",
      to: "operator",
    });
    expect(await showPolicy(db, "local")).toEqual({ approveRunMinRole: "operator" });
    // A reader is still refused; an operator may now approve.
    const noRead = await approve(reader, held!.id);
    expect(!noRead.ok && noRead.error.code).toBe("forbidden");
    const ok = await approve(op, held!.id);
    expect(ok.ok).toBe(true);
    const { listAudit } = await import("../src/db");
    expect((await listAudit(db, { orgId: scope.orgId })).map((a) => a.op)).toContain("policy_set");

    // The tool description tells agents the real requirement.
    const { mcpTools } = await import("../src/ops/mcp");
    const tool = mcpTools(registry).find((t) => t.name === "approve_run")!;
    expect(tool.description).toContain("release_operator, or operator if the org lowered it");
    expect(tool.description).not.toContain("Requires role operator.");
  });

  test("untrusted runs never get open egress, whatever the repo or project allows", async () => {
    const planOf = (r: { plan: string | null }) => JSON.parse(r.plan!);
    // Config says open for the repo and the project: trusted runs get it, the fork's run does not.
    await setProjectEgress(db, scope, "open");
    const gh = ghWithWorkflow();
    gh.state.pulls = [PR({ headRepo: "evil/web" })];
    await ingestAs(gh, APPROVAL_CFG({ egress: "open" }));
    const [push] = (await listRuns(db, scope)).filter((r) => r.event === "push");
    expect(planOf(push!)).toMatchObject({ trust: "protected", egress: "open" });
    const [held] = await prRuns();
    expect(planOf(held!)).toMatchObject({ trust: "untrusted_pr", egress: "none" });

    // An explicit untrustedEgress may allow an allowlist, never open.
    gh.state.pulls = [PR({ number: 8, headSha: SHA("8"), headRepo: "evil/web" })];
    await ingestAs(gh, APPROVAL_CFG({ egress: "open", untrustedEgress: "allowlist" }));
    const eight = (await prRuns()).find((r) => r.prNumber === 8)!;
    expect(planOf(eight).egress).toBe("allowlist");
    expect(() =>
      pollConfigSchema.parse({
        allowUnauthenticated: true,
        repos: [
          {
            repo: "acme/web",
            workflow: ".github/workflows/ci.yml",
            defaultBranch: "main",
            untrustedEgress: "open",
          },
        ],
      }),
    ).toThrow();

    // The worker applies the same cap to a plan that says otherwise.
    expect(egressForRun('{"trust":"untrusted_pr","egress":"open"}')).toBe("none");
    expect(egressForRun('{"trust":"untrusted_pr","egress":"allowlist"}')).toBe("allowlist");
    expect(egressForRun('{"trust":"trusted_pr","egress":"open"}')).toBe("open");
  });

  test("longshore policy set --egress sets a project's default, audited; plan.egress follows it", async () => {
    await expect(setEgressPolicy(db, "local", undefined, "wide")).rejects.toThrow();
    await expect(setEgressPolicy(db, "local", "nope", "open")).rejects.toThrow();
    const changed = await setEgressPolicy(db, "local", "local", "open");
    expect(changed).toEqual([{ project: "local", from: "none", to: "open" }]);
    expect(await showEgress(db, "local")).toEqual([{ project: "local", egress: "open" }]);
    const gh = ghWithWorkflow();
    await ingestAs(gh);
    expect(JSON.parse((await listRuns(db, scope))[0]!.plan!).egress).toBe("open");
    const { listAudit } = await import("../src/db");
    const audit = (await listAudit(db, scope)).filter((a) => a.op === "policy_set");
    expect(audit).toHaveLength(1);
    expect(audit[0]!.input).toContain('"to":"open"');
    // Every project of the org when none is named.
    expect((await setEgressPolicy(db, "local", undefined, "none"))[0]).toMatchObject({
      from: "open",
      to: "none",
    });
  });

  test("jobs that check out the PR head are listed in the plan for the isolation demotion", async () => {
    const gh = makeGithub();
    gh.state.files.set(
      "*",
      `name: ci
on: [push, pull_request]
jobs:
  risky:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: \${{ github.event.pull_request.head.sha }}
  safe:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`,
    );
    await ingestAs(gh);
    expect(JSON.parse((await listRuns(db, scope))[0]!.plan!).headCheckouts).toEqual(["risky"]);
  });
});

describe("the job cache credential", () => {
  test("it is never in the log act writes (act echoes its arguments), never stored with the plan, and ends with the attempt", async () => {
    const { CacheGrants } = await import("../src/cache/grants");
    const { jobCacheProvider } = await import("../src/cache/job");
    const { createCacheService } = await import("../src/cache/service");
    const { FsCacheStore } = await import("../src/cache/store");
    const service = createCacheService({
      db,
      store: new FsCacheStore(join(tmp, "cache-blobs")),
      grants: new CacheGrants(),
      orgQuotaBytes: 1024 * 1024,
      maxEntryBytes: 1024 * 1024,
      baseUrl: "http://host.docker.internal:8080",
    });
    const real = jobCacheProvider(db, service);
    const issued: { url: string; secret: string }[] = [];
    const cache: typeof real = async (req) => {
      const g = await real(req);
      if (g) issued.push({ url: g.url, secret: g.secret });
      return g;
    };
    const gh = makeGithub();
    gh.state.files.set("*", PIPELINE);
    await ingest(gh);
    const sched = await makeScheduler(gh, world.provider(), { cache, egress: "open" });
    await drain(sched);
    // Every job got a grant, and the argv really carried the URL (the fake act echoed it).
    expect(issued.length).toBeGreaterThanOrEqual(3);
    const [run] = await listRuns(db, scope);
    let echoed = 0;
    for (const j of await listJobs(db, scope, run!.id)) {
      for (const a of await listAttempts(db, scope, j.id)) {
        const log = Buffer.concat((await readLog(db, scope, a.id)).map((c) => c.bytes)).toString();
        for (const g of issued) {
          expect(log).not.toContain(g.secret);
          // Nor the plan stored for re-attach.
          expect(a.plan ?? "").not.toContain(g.secret);
          expect(a.plan ?? "").not.toContain("_cache/");
        }
        if (log.includes("ARGV")) {
          echoed++;
          expect(log).toContain("ACTIONS_CACHE_URL=http://host.docker.internal:8080/_cache/");
        }
      }
    }
    expect(echoed).toBeGreaterThanOrEqual(1);
    // The credentials died with their attempts.
    for (const g of issued) expect(service.grants.verify(g.secret)).toBeUndefined();
  });
});

describe("cut markers are metadata, never text in the log (#56)", () => {
  const NOISE = `name: cuts
on:
  push:
    branches: [main]
jobs:
  noisy:
    runs-on: ubuntu-latest
    steps:
      - run: echo noisy
  forger:
    runs-on: ubuntu-latest
    steps:
      - run: echo forger
`;
  test("a noisy job gets no marker text in its log, and a job printing the marker text records no cut", async () => {
    // Small head and tail so the cut is cheap to provoke.
    const small = new FakeWorld({
      hostPaths: [tmp],
      exec: { tickSeconds: 1, head: 2000, tail: 3000, slack: 500 },
    });
    try {
      const gh = makeGithub();
      gh.state.files.set("*", NOISE);
      await ingest(gh);
      const sched = await makeScheduler(gh, small.provider());
      await drain(sched);
      const [run] = await listRuns(db, scope);
      const jobs = await listJobs(db, scope, run!.id);
      const text = async (key: string) => {
        const job = jobs.find((j) => j.jobKey === key)!;
        const [a] = await listAttempts(db, scope, job.id);
        const log = Buffer.concat((await readLog(db, scope, a!.id)).map((c) => c.bytes)).toString();
        return { job, attempt: a!, log };
      };

      const noisy = await text("noisy");
      expect(noisy.job.state).toBe("success");
      // Whatever the cap did, no marker text is injected into the log.
      expect(noisy.log).not.toMatch(/bytes of output omitted/);
      expect(noisy.log).toContain("line 0 of noisy output");
      expect(noisy.log).toContain("line 399 of noisy output");
      // Cuts, if the sandbox made any (it only drops output a reader had not yet fetched),
      // are records delivered out of band by the API, placed inside the stored log.
      const token = (await mintToken(db, { orgId: scope.orgId }, "reader")).secret;
      const res = await dispatch({ registry, db }, { kind: "bearer", token }, "job_cuts", {
        job_id: noisy.job.id,
        attempt: 1,
      });
      expect(res.ok).toBe(true);
      const cuts = (res.ok ? res.output : { cuts: [] }) as {
        cuts: { at_offset: number; omitted_bytes: number; reason: string }[];
      };
      for (const c of cuts.cuts) {
        expect(c.omitted_bytes).toBeGreaterThan(0);
        expect(c.at_offset).toBeLessThanOrEqual(Buffer.byteLength(noisy.log));
        expect(c.reason).toBe("output cap");
      }

      // A job that prints the old marker text gets ordinary text and no cut.
      const forger = await text("forger");
      expect(forger.job.state).toBe("success");
      expect(forger.log).toContain("[longshore: 99999 bytes of output omitted]");
      const none = await dispatch({ registry, db }, { kind: "bearer", token }, "job_cuts", {
        job_id: forger.job.id,
        attempt: 1,
      });
      expect(none.ok ? (none.output as { cuts: unknown[] }).cuts : [1]).toEqual([]);
    } finally {
      small.dispose();
    }
  });
});

describe("a job split across sandboxes", () => {
  const SUITES = `name: CI
on:
  push:
    branches: [main]
jobs:
  tests:
    name: Tests
    runs-on: ubuntu-latest
    steps:
      - id: setup
        name: Setup
        run: echo setup
      - name: Rules tests
        run: echo rules
      - name: Rest tests
        run: echo rest
      - name: Audit engine tests
        run: echo audit
  gate:
    needs: [tests]
    runs-on: ubuntu-latest
    steps:
      - run: echo gate
`;
  const SPLITS = [
    {
      job: "tests",
      shards: [
        { steps: ["Audit engine tests"] },
        { steps: ["Rules tests"] },
        { steps: ["Rest tests"] },
      ],
    },
  ];

  test("three shards run in three sandboxes, each with only its own suite, and the dependent waits for all of them", async () => {
    const gh = makeGithub();
    gh.state.files.set("*", SUITES);
    await ingest(gh, CFG({ splits: SPLITS }));
    const [run] = await listRuns(db, scope);
    const jobs = await listJobs(db, scope, run!.id);
    expect(jobs.map((j) => j.jobKey).toSorted()).toEqual([
      "gate",
      "tests[0]",
      "tests[1]",
      "tests[2]",
    ]);
    expect(jobs.filter((j) => j.name === "Tests")).toHaveLength(3);
    const specs: string[] = [];
    const base = world.provider();
    const spy: Provider = Object.assign(Object.create(base) as Provider, {
      create: (spec: Parameters<Provider["create"]>[0]) => {
        specs.push(spec.name);
        return base.create(spec);
      },
    });
    await drain(await makeScheduler(gh, spy));
    const after = await listJobs(db, scope, run!.id);
    expect(after.map((j) => [j.jobKey, j.state]).toSorted()).toEqual([
      ["gate", "success"],
      ["tests[0]", "success"],
      ["tests[1]", "success"],
      ["tests[2]", "success"],
    ]);
    expect(new Set(specs).size).toBe(4); // one sandbox per shard, and one for the dependent
    // each shard's workflow runs exactly one suite
    const { readdirSync } = await import("node:fs");
    const files = readdirSync(join(root, "seen")).filter(
      (f) => f.startsWith("tests.") && f.endsWith(".all.yml"),
    );
    expect(files).toHaveLength(3);
    const ran = files.map((f) => {
      const wf = parseYaml(readFileSync(join(root, "seen", f), "utf8")) as {
        jobs: { tests: { steps: { name: string; if?: unknown }[] } };
      };
      return wf.jobs.tests.steps
        .filter((s) => s.name.endsWith(" tests") && s.if !== false)
        .map((s) => s.name);
    });
    expect(ran.map((r) => r.length)).toEqual([1, 1, 1]);
    expect(new Set(ran.flat()).size).toBe(3);
    // the gate ran after every shard finished
    const finished = Math.max(
      ...after.filter((j) => j.jobKey.startsWith("tests[")).map((j) => j.finishedAt ?? 0),
    );
    expect(after.find((j) => j.jobKey === "gate")!.startedAt!).toBeGreaterThanOrEqual(finished);
  });

  test("with no rule the same workflow runs as one job, as before", async () => {
    const gh = makeGithub();
    gh.state.files.set("*", SUITES);
    await ingest(gh, CFG());
    const [run] = await listRuns(db, scope);
    expect((await listJobs(db, scope, run!.id)).map((j) => j.jobKey).toSorted()).toEqual([
      "gate",
      "tests",
    ]);
  });

  test("a rule that cannot apply is recorded on the run, and the job runs whole", async () => {
    const gh = makeGithub();
    gh.state.files.set("*", SUITES);
    await ingest(
      gh,
      CFG({ splits: [{ job: "missing", shards: [{ steps: ["a"] }, { steps: ["b"] }] }] }),
    );
    const [run] = await listRuns(db, scope);
    expect(JSON.parse(run!.plan!).splitNotices.join()).toContain("no such job");
    expect((await listJobs(db, scope, run!.id)).map((j) => j.jobKey).toSorted()).toEqual([
      "gate",
      "tests",
    ]);
  });
});

describe("a project's sandbox snapshot", () => {
  const ONE = `name: one
on:
  push:
    branches: [main]
jobs:
  only:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`;
  async function specsFor(snapshot: string | undefined): Promise<{ snapshot?: string }[]> {
    if (snapshot !== undefined)
      await setSandboxPolicy(db, "local", "local", { sandboxSnapshot: snapshot });
    const gh = makeGithub();
    gh.state.files.set("*", ONE);
    await ingest(gh);
    const specs: { snapshot?: string }[] = [];
    const base = world.provider();
    const spy: Provider = Object.assign(Object.create(base) as Provider, {
      create: (spec: Parameters<Provider["create"]>[0]) => {
        specs.push(spec);
        return base.create(spec);
      },
    });
    await drain(await makeScheduler(gh, spy));
    return specs;
  }

  test("the project's snapshot is on the sandbox spec of its jobs; with none set the spec names none", async () => {
    const without = await specsFor(undefined);
    expect(without.length).toBeGreaterThan(0);
    expect(without.every((s) => s.snapshot === undefined)).toBe(true);
  });

  test("with a snapshot set, every sandbox of the project starts from it", async () => {
    const withSnap = await specsFor("daytona-large");
    expect(withSnap.length).toBeGreaterThan(0);
    expect(withSnap.every((s) => s.snapshot === "daytona-large")).toBe(true);
  });
});
