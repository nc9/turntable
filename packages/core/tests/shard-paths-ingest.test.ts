// Shards limited by `paths` (operator config): which changed set each event uses, and that an
// unknown, truncated or unusable set runs every shard. The decision is stored in the run's plan
// at ingest, so a rerun never recomputes it.
import { beforeEach, expect, test } from "bun:test";
import {
  listJobs,
  listRuns,
  openDatabase,
  ensureLocalTenant,
  type Db,
  type Scope,
} from "../src/db";
import { GithubClient, pollConfigSchema, pollRepo } from "../src/poll";
import { workflowReadiness } from "../src/scheduler";
import { SHA, makeGithub } from "./github-stub";

const WORKFLOW = `name: CI
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
  merge_group:
jobs:
  tests:
    runs-on: ubuntu-latest
    steps:
      - name: Core tests
        run: echo core
      - name: UI tests
        run: echo ui
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
      { steps: ["Core tests"], paths: ["packages/core/**", "!**/*.md"] },
      { steps: ["UI tests"], paths: ["packages/ui/**"] },
    ],
  },
];

let db: Db;
let scope: Required<Scope>;
beforeEach(async () => {
  db = openDatabase(":memory:");
  scope = await ensureLocalTenant(db);
});

const config = (over: Record<string, unknown> = {}) =>
  pollConfigSchema.parse({
    allowUnauthenticated: true,
    repos: [
      {
        repo: "acme/web",
        workflow: ".github/workflows/ci.yml",
        defaultBranch: "main",
        prMode: "allowlist",
        authors: ["octocat"],
        mergeQueue: true,
        splits: SPLITS,
        ...over,
      },
    ],
  }).repos[0]!;

const poll = (gh: ReturnType<typeof makeGithub>, cfg = config()) =>
  pollRepo(
    {
      db,
      github: new GithubClient({ baseUrl: "https://api.github.test", fetch: gh.fetch }),
      provider: "docker",
      now: () => 1_800_000_000_000,
    },
    cfg,
  );

const world = () => {
  const gh = makeGithub();
  gh.state.files.set("*", WORKFLOW);
  return gh;
};

/** What each shard of `tests` will do, by job key, read from the stored run. */
async function shardDecisions(event: string): Promise<Record<string, string>> {
  const run = (await listRuns(db, scope)).find((r) => r.event === event)!;
  expect(run).toBeDefined();
  const jobs = await listJobs(db, scope, run.id);
  return Object.fromEntries(
    jobs
      .filter((j) => j.jobKey.startsWith("tests["))
      .map((j) => [j.jobKey, workflowReadiness(j, [], run).decision]),
  );
}

const planOf = async (event: string) => {
  const run = (await listRuns(db, scope)).find((r) => r.event === event)!;
  return JSON.parse(run.plan!) as { splitNotices?: string[] };
};

const prWorld = (files: string[] | undefined) => {
  const gh = world();
  gh.state.pulls = [{ number: 5, user: "octocat", headSha: SHA("d"), baseRef: "main" }];
  if (files) gh.state.compare.set(`main...${SHA("d")}`, files);
  return gh;
};

test("pull_request: the PR's diff against its base picks the shards, and the notice names the source", async () => {
  await poll(prWorld(["packages/ui/src/a.tsx"]));
  expect(await shardDecisions("pull_request")).toEqual({
    "tests[0]": "skip",
    "tests[1]": "ready",
  });
  const notices = (await planOf("pull_request")).splitNotices ?? [];
  expect(notices).toEqual([expect.stringContaining("shards selected by changed paths (")]);
  expect(notices[0]).toContain("pull_request main..dddddddddddd");
  expect(notices[0]).toContain("1 files");
  // a skipped shard says why in its log
  const run = (await listRuns(db, scope)).find((r) => r.event === "pull_request")!;
  const skipped = (await listJobs(db, scope, run.id)).find((j) => j.jobKey === "tests[0]")!;
  const verdict = workflowReadiness(skipped, [], run);
  expect(verdict).toMatchObject({ decision: "skip" });
  expect((verdict as { reason: string }).reason).toContain("no shard paths changed");
});

test("a negated glob keeps a file out: a markdown change under core runs no core shard", async () => {
  await poll(prWorld(["packages/core/README.md"]));
  expect(await shardDecisions("pull_request")).toEqual({ "tests[0]": "skip", "tests[1]": "skip" });
});

test("every shard skipped: all shard jobs skip, and the job that needs them skips too", async () => {
  await poll(prWorld(["docs/guide.md"]));
  expect(await shardDecisions("pull_request")).toEqual({ "tests[0]": "skip", "tests[1]": "skip" });
});

test("unknown means every shard runs: the compare is missing (a force push or no base)", async () => {
  await poll(prWorld(undefined)); // 404 from compare
  expect(await shardDecisions("pull_request")).toEqual({
    "tests[0]": "ready",
    "tests[1]": "ready",
  });
  expect((await planOf("pull_request")).splitNotices?.[0]).toContain("changed files unknown");
});

test("unknown means every shard runs: a compare larger than one poll pages through is never used", async () => {
  const many = Array.from({ length: 300 }, (_, i) => `docs/f${i}.md`);
  await poll(prWorld(many));
  expect(await shardDecisions("pull_request")).toEqual({
    "tests[0]": "ready",
    "tests[1]": "ready",
  });
});

test("an empty changed set is treated as unknown, not as nothing changed", async () => {
  await poll(prWorld([]));
  expect(await shardDecisions("pull_request")).toEqual({
    "tests[0]": "ready",
    "tests[1]": "ready",
  });
});

test("push: before..after picks the shards; the first sight of a branch (no before) runs all", async () => {
  const gh = world();
  await poll(gh); // first sight of main: no before
  expect(await shardDecisions("push")).toEqual({ "tests[0]": "ready", "tests[1]": "ready" });

  gh.state.head = { sha: SHA("c"), message: "feat: ui", login: "octocat" };
  gh.state.compare.set(`${SHA("a")}...${SHA("c")}`, ["packages/ui/x.ts"]);
  await poll(gh);
  const runs = (await listRuns(db, scope)).filter((r) => r.event === "push");
  const latest = runs.find((r) => r.sha === SHA("c"))!;
  const jobs = await listJobs(db, scope, latest.id);
  expect(
    Object.fromEntries(
      jobs
        .filter((j) => j.jobKey.startsWith("tests["))
        .map((j) => [j.jobKey, workflowReadiness(j, [], latest).decision]),
    ),
  ).toEqual({ "tests[0]": "skip", "tests[1]": "ready" });
  const notices = (JSON.parse(latest.plan!) as { splitNotices: string[] }).splitNotices;
  expect(notices[0]).toContain(`push ${SHA("a").slice(0, 12)}..${SHA("c").slice(0, 12)}`);
});

test("push after a force push (the before is gone, compare answers 404): every shard runs", async () => {
  const gh = world();
  await poll(gh);
  gh.state.head = { sha: SHA("c"), message: "feat: x", login: "octocat" };
  // no compare entry for a...c: GitHub no longer has the old tip
  await poll(gh);
  const latest = (await listRuns(db, scope)).find((r) => r.sha === SHA("c"))!;
  const jobs = await listJobs(db, scope, latest.id);
  for (const j of jobs.filter((x) => x.jobKey.startsWith("tests[")))
    expect(workflowReadiness(j, [], latest).decision).toBe("ready");
});

test("merge_group: the group's own base is compared with the queue commit", async () => {
  const gh = world();
  gh.state.pulls.push({ number: 7, user: "octocat", headSha: SHA("d") });
  gh.state.queue.push({
    ref: `refs/heads/gh-readonly-queue/main/pr-7-${SHA("b")}`,
    sha: SHA("e"),
  });
  gh.state.compare.set(`${SHA("b")}...${SHA("e")}`, ["packages/core/src/x.ts"]);
  await poll(gh);
  expect(await shardDecisions("merge_group")).toEqual({ "tests[0]": "ready", "tests[1]": "skip" });
  expect((await planOf("merge_group")).splitNotices?.[0]).toContain("merge_group");
});

test("no shard has paths: nothing is fetched for selection and every shard runs", async () => {
  const gh = prWorld(["packages/ui/src/a.tsx"]);
  await poll(
    gh,
    config({
      splits: [{ job: "tests", shards: [{ steps: ["Core tests"] }, { steps: ["UI tests"] }] }],
    }),
  );
  expect(gh.state.calls.some((c) => c.path.includes("/compare/"))).toBe(false);
  expect(await shardDecisions("pull_request")).toEqual({
    "tests[0]": "ready",
    "tests[1]": "ready",
  });
});
