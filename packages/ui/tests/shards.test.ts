// Shards of one split job are one job in the UI: grouped in order, the fold of their states, and
// the wall time from the first start to the last finish.
import { describe, expect, test } from "bun:test";
import { createFixture } from "../src/api/fixture/adapter";
import type { Job, JobState } from "../src/api/types";
import { foldShardStates, groupJobs, shardGroupId, shardLabel } from "../src/lib/shards";

const job = (over: Partial<Job> & Pick<Job, "jobKey">): Job => ({
  id: over.jobKey,
  orgId: "o",
  projectId: "p",
  runId: "r",
  name: over.jobKey,
  state: "success",
  needs: [],
  matrix: null,
  matrixGroup: null,
  shard: null,
  approval: null,
  exitCode: 0,
  createdAt: 0,
  startedAt: null,
  finishedAt: null,
  ...over,
});
const shard = (i: number, total: number, over: Partial<Job> = {}): Job =>
  job({
    jobKey: `tests[${i}]`,
    name: "CLI tests",
    shard: { job: "tests", index: i, total, steps: [`suite ${i}`] },
    ...over,
  });

describe("grouping", () => {
  test("the shards of a split job become one item at the first shard, in index order; other jobs are untouched", () => {
    const items = groupJobs([
      job({ jobKey: "lint" }),
      shard(2, 3),
      shard(0, 3),
      job({ jobKey: "build" }),
      shard(1, 3),
    ]);
    expect(items.map((i) => (i.kind === "job" ? i.job.jobKey : i.group.id))).toEqual([
      "lint",
      "shard:tests",
      "build",
    ]);
    const g = items[1]!;
    expect(g.kind === "shards" && g.group.shards.map((s) => s.shard!.index)).toEqual([0, 1, 2]);
    expect(g.kind === "shards" && g.group.name).toBe("CLI tests");
  });

  test("a matrix job is not a shard group", () => {
    const m = job({ jobKey: "t[0]", matrix: { os: "linux" }, matrixGroup: "t" });
    expect(shardGroupId(m)).toBeNull();
    expect(groupJobs([m, m]).every((i) => i.kind === "job")).toBe(true);
  });

  test("two split jobs make two groups", () => {
    const other = (i: number) =>
      job({ jobKey: `x[${i}]`, name: "X", shard: { job: "x", index: i, total: 2, steps: [] } });
    const items = groupJobs([shard(0, 2), other(0), shard(1, 2), other(1)]);
    expect(items.map((i) => (i.kind === "shards" ? i.group.id : "job"))).toEqual([
      "shard:tests",
      "shard:x",
    ]);
  });

  test("wall time is the first start to the last finish, never the sum; null until every shard is done", () => {
    const done = groupJobs([
      shard(0, 3, { startedAt: 1000, finishedAt: 7000 }),
      shard(1, 3, { startedAt: 1500, finishedAt: 4000 }),
      shard(2, 3, { startedAt: 1200, finishedAt: 3000 }),
    ])[0]!;
    expect(done.kind === "shards" && [done.group.startedAt, done.group.finishedAt]).toEqual([
      1000, 7000,
    ]);
    const going = groupJobs([
      shard(0, 2, { startedAt: 1000, finishedAt: 7000 }),
      shard(1, 2, { state: "running", startedAt: 2000, finishedAt: null }),
    ])[0]!;
    expect(going.kind === "shards" && [going.group.startedAt, going.group.finishedAt]).toEqual([
      1000,
      null,
    ]);
    const queued = groupJobs([
      shard(0, 2, { state: "queued" }),
      shard(1, 2, { state: "queued" }),
    ])[0]!;
    expect(queued.kind === "shards" && queued.group.startedAt).toBeNull();
  });
});

describe("the fold matches the server's", () => {
  const f = (...s: JobState[]) => foldShardStates(s);
  test("failure, then infra_error, cancelled, skipped only when all, else success", () => {
    expect(f("success", "success", "success")).toBe("success");
    expect(f("success", "failure", "infra_error")).toBe("failure");
    expect(f("success", "infra_error", "cancelled")).toBe("infra_error");
    expect(f("success", "cancelled", "skipped")).toBe("cancelled");
    expect(f("skipped", "skipped")).toBe("skipped");
    expect(f("success", "skipped")).toBe("success");
  });
  test("running while any shard runs, queued while any is waiting, even if another failed", () => {
    expect(f("failure", "running", "success")).toBe("running");
    expect(f("success", "queued")).toBe("queued");
    expect(f("success", "awaiting_approval")).toBe("awaiting_approval");
  });
});

test("shard labels count from 1", () => {
  expect(shardLabel(shard(0, 3))).toBe("Shard 1 of 3");
  expect(shardLabel(shard(2, 3))).toBe("Shard 3 of 3");
  expect(shardLabel(job({ jobKey: "a" }))).toBe("");
});

test("the fixture has a split job: three shards of one name, each with its step, that the build waits for", async () => {
  const fx = createFixture({ latency: [0, 0], tickMs: 1000, seed: "shards" });
  try {
    const run = [...fx.world.runs.values()].find((r) =>
      [...fx.world.jobs.values()].some((j) => j.runId === r.id && j.shard !== null),
    )!;
    const jobs = [...fx.world.jobs.values()].filter((j) => j.runId === run.id);
    const shards = jobs.filter((j) => j.shard !== null);
    expect(shards).toHaveLength(3);
    expect(new Set(shards.map((j) => j.name))).toEqual(new Set(["CLI tests"]));
    expect(shards.map((j) => j.shard!.steps)).toEqual([
      ["Audit engine tests"],
      ["Rules tests"],
      ["Remaining package and script tests"],
    ]);
    const build = jobs.find((j) => j.jobKey === "build")!;
    for (const s of shards) expect(build.needs).toContain(s.jobKey);
    expect(groupJobs(jobs).filter((i) => i.kind === "shards")).toHaveLength(1);
  } finally {
    fx.stop();
  }
});
