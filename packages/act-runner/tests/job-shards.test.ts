// An operator's split rule runs one job as several shards, each in its own sandbox, without
// editing the workflow. These tests use a job shaped like a real one: a setup step, three
// independent suite steps that each run even when another is red, and a dependent job.
import { describe, expect, test } from "bun:test";
import { parse } from "yaml";
import {
  foldShardStates,
  jobReadiness,
  planWorkflow,
  splitJob,
  splitRuleProblem,
  type NeedState,
  type PlannedJob,
  type SplitRule,
} from "../src/index";

const WF = `name: CI
on: [push]
jobs:
  tests:
    name: CLI tests (rules, engine and the rest)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
      - id: setup
        name: Setup
        run: echo setup
      - name: Rules tests
        if: \${{ !cancelled() && steps.setup.outcome == 'success' }}
        run: bun run scripts/test-suites.ts --run rules
      - name: Remaining package and script tests
        if: \${{ !cancelled() && steps.setup.outcome == 'success' }}
        run: bun run scripts/test-suites.ts --run rest
      - name: Audit engine tests
        if: \${{ !cancelled() && steps.setup.outcome == 'success' }}
        run: bun run scripts/test-suites.ts --run audit-engine
  gate:
    needs: [tests]
    runs-on: ubuntu-latest
    steps:
      - run: echo done
`;

const push = { name: "push", ref: "refs/heads/main" } as const;
const plan = (yaml: string, splits: SplitRule[]) =>
  planWorkflow(yaml, push, { readFile: () => undefined, splits });
const THREE: SplitRule = {
  job: "tests",
  shards: [
    { steps: ["Audit engine tests"] },
    { steps: ["Rules tests"] },
    { steps: ["Remaining package and script tests"] },
  ],
};
const TWO: SplitRule = {
  job: "tests",
  shards: [
    { steps: ["Rules tests", "Remaining package and script tests"] },
    { steps: ["Audit engine tests"] },
  ],
};

/** The legs of a split job's single-job workflow: step name to whether it is turned off. */
function legSteps(yaml: string, job: PlannedJob): Record<string, boolean> {
  const out = parse(splitJob(yaml, job, {}, { event: "push" })) as {
    jobs: { tests: { steps: { name?: string; if?: unknown }[] } };
  };
  return Object.fromEntries(
    out.jobs.tests.steps.map((s, i) => [s.name ?? `#${i + 1}`, s.if === false]),
  );
}

describe("planning a split", () => {
  test("three shards of one step each: three legs under one job id, named as the job, all run to the end", () => {
    const p = plan(WF, [THREE]);
    const legs = p.jobs.filter((j) => j.id === "tests");
    expect(legs.map((j) => j.key)).toEqual(["tests[0]", "tests[1]", "tests[2]"]);
    for (const [i, j] of legs.entries()) {
      expect(j.name).toBe("CLI tests (rules, engine and the rest)");
      expect(j.failFast).toBe(false);
      expect(j.matrix).toBeUndefined();
      expect(j.shard).toMatchObject({ index: i, total: 3 });
    }
    expect(p.splitNotices).toEqual([]);
    // the dependent waits for every shard
    expect(p.jobs.find((j) => j.id === "gate")!.needs).toEqual([
      "tests[0]",
      "tests[1]",
      "tests[2]",
    ]);
  });

  test("two shards work the same way", () => {
    const legs = plan(WF, [TWO]).jobs.filter((j) => j.id === "tests");
    expect(legs.map((j) => j.key)).toEqual(["tests[0]", "tests[1]"]);
    expect(legs[0]!.shard!.partition[0]).toEqual([
      "Rules tests",
      "Remaining package and script tests",
    ]);
  });

  test("no rule: the job is planned whole, exactly as before", () => {
    const p = plan(WF, []);
    expect(p.jobs.filter((j) => j.id === "tests").map((j) => j.key)).toEqual(["tests"]);
    expect(p.jobs.find((j) => j.id === "tests")!.shard).toBeUndefined();
  });

  test("a job with a matrix, or whose outputs read a partitioned step, is not split and says why", () => {
    const withMatrix = WF.replace(
      "    steps:\n      - uses: actions",
      "    strategy:\n      matrix:\n        n: [1, 2]\n    steps:\n      - uses: actions",
    );
    const m = plan(withMatrix, [TWO]);
    expect(m.jobs.filter((j) => j.id === "tests").every((j) => j.shard === undefined)).toBe(true);
    expect(m.splitNotices.join()).toContain("strategy.matrix");
    const withOutput = WF.replace(
      "      - name: Rules tests\n",
      "      - id: r\n        name: Rules tests\n",
    ).replace(
      "    runs-on: ubuntu-latest\n    steps:\n      - uses",
      "    runs-on: ubuntu-latest\n    outputs:\n      v: ${{ steps.r.outputs.v }}\n    steps:\n      - uses",
    );
    const o = plan(withOutput, [TWO]);
    expect(o.jobs.filter((j) => j.id === "tests")).toHaveLength(1);
    expect(o.splitNotices.join()).toContain("which only one shard runs");
  });

  test("a rule for a job that does not exist, or with a step that matches nothing, is noted", () => {
    expect(plan(WF, [{ ...TWO, job: "nope" }]).splitNotices.join()).toContain("no such job");
    const renamed = plan(WF, [
      { job: "tests", shards: [{ steps: ["Rules"] }, { steps: ["Audit engine tests"] }] },
    ]);
    expect(renamed.splitNotices.join()).toContain('"Rules" matches no step');
  });

  test("a bad rule is ignored with a notice, never half-applied", () => {
    const bad: SplitRule[] = [
      { job: "tests", shards: [{ steps: ["a"] }] }, // one shard
      { job: "tests", shards: Array.from({ length: 9 }, (_, i) => ({ steps: [`s${i}`] })) },
      { job: "tests", shards: [{ steps: [] }, { steps: ["a"] }] },
      { job: "tests", shards: [{ steps: ["a"] }, { steps: ["a"] }] }, // in two shards
      { job: "tests", shards: [{ steps: ["#0"] }, { steps: ["b"] }] },
      { job: "tests", shards: [{ steps: ["#x"] }, { steps: ["b"] }] },
      { job: "", shards: [{ steps: ["a"] }, { steps: ["b"] }] },
    ];
    for (const r of bad) {
      expect(splitRuleProblem(r), JSON.stringify(r).slice(0, 60)).toBeTypeOf("string");
      const p = plan(WF, [r]);
      expect(p.jobs.filter((j) => j.id === "tests")).toHaveLength(1);
      expect(p.splitNotices.length).toBeGreaterThan(0);
    }
    expect(splitRuleProblem(TWO)).toBeUndefined();
    expect(
      splitRuleProblem({ job: "t", shards: [{ steps: ["#3"] }, { steps: ["#4"] }] }),
    ).toBeUndefined();
  });
});

describe("what each shard runs", () => {
  test("each shard turns off exactly the steps another shard owns; setup and unlisted steps run everywhere", () => {
    const legs = plan(WF, [THREE]).jobs.filter((j) => j.id === "tests");
    const off = legs.map((j) => legSteps(WF, j));
    for (const o of off) {
      expect(o["#1"]).toBe(false); // checkout
      expect(o.Setup).toBe(false);
    }
    // each suite runs in exactly one shard
    for (const suite of [
      "Audit engine tests",
      "Rules tests",
      "Remaining package and script tests",
    ]) {
      expect(off.filter((o) => o[suite] === false)).toHaveLength(1);
    }
    expect(off[0]!["Audit engine tests"]).toBe(false);
    expect(off[0]!["Rules tests"]).toBe(true);
    expect(off[1]!["Rules tests"]).toBe(false);
    expect(off[2]!["Remaining package and script tests"]).toBe(false);
  });

  test("the two-shard example", () => {
    const legs = plan(WF, [TWO]).jobs.filter((j) => j.id === "tests");
    const [a, b] = legs.map((j) => legSteps(WF, j)) as [
      Record<string, boolean>,
      Record<string, boolean>,
    ];
    expect([
      a["Rules tests"],
      a["Remaining package and script tests"],
      a["Audit engine tests"],
    ]).toEqual([false, false, true]);
    expect([
      b["Rules tests"],
      b["Remaining package and script tests"],
      b["Audit engine tests"],
    ]).toEqual([true, true, false]);
  });

  test("a renamed step is owned by no shard, so it runs in every shard: coverage is never lost", () => {
    const renamed = WF.replace("name: Rules tests", "name: Rules tests (renamed)");
    const legs = plan(renamed, [THREE]).jobs.filter((j) => j.id === "tests");
    for (const j of legs) expect(legSteps(renamed, j)["Rules tests (renamed)"]).toBe(false);
  });

  test("a step can be named by its place, #<n> counted from 1", () => {
    const rule: SplitRule = { job: "tests", shards: [{ steps: ["#3"] }, { steps: ["#4", "#5"] }] };
    const legs = plan(WF, [rule]).jobs.filter((j) => j.id === "tests");
    const [a, b] = legs.map((j) => legSteps(WF, j)) as [
      Record<string, boolean>,
      Record<string, boolean>,
    ];
    expect(a["Rules tests"]).toBe(false);
    expect(a["Audit engine tests"]).toBe(true);
    expect(b["Rules tests"]).toBe(true);
    expect(b["Remaining package and script tests"]).toBe(false);
  });

  test("the rewrite only disables: no step is added or changed, and a steps `if` is kept on the steps that run", () => {
    const legs = plan(WF, [THREE]).jobs.filter((j) => j.id === "tests");
    const out = parse(splitJob(WF, legs[1]!, {}, { event: "push" })) as {
      jobs: { tests: { steps: { name?: string; run?: string; if?: unknown }[] } };
    };
    const steps = out.jobs.tests.steps;
    expect(steps).toHaveLength(5);
    const rules = steps.find((s) => s.name === "Rules tests")!;
    expect(rules.if).toContain("steps.setup.outcome");
    expect(rules.run).toBe("bun run scripts/test-suites.ts --run rules");
    expect(steps.find((s) => s.name === "Audit engine tests")!.run).toBe(
      "bun run scripts/test-suites.ts --run audit-engine",
    );
  });
});

describe("one job outward", () => {
  const legs = plan(WF, [THREE]).jobs;
  const gate = legs.find((j) => j.id === "gate")!;
  const ready = (states: string[]) =>
    jobReadiness(
      gate,
      Object.fromEntries(states.map((s, i) => [`tests[${i}]`, { state: s as NeedState }])),
    );

  test("a dependent waits for every shard, then sees the fold", () => {
    expect(ready(["success", "running", "success"]).decision).toBe("wait");
    expect(ready(["success", "success", "success"]).decision).toBe("ready");
    expect(ready(["success", "failure", "success"]).decision).toBe("skip");
    expect(ready(["success", "infra_error", "success"]).decision).toBe("skip");
  });

  test("the fold: failure, then infra_error, cancelled, skipped only when all, running while any runs", () => {
    expect(foldShardStates(["success", "success", "success"])).toBe("success");
    expect(foldShardStates(["success", "failure", "infra_error"])).toBe("failure");
    expect(foldShardStates(["success", "infra_error", "cancelled"])).toBe("infra_error");
    expect(foldShardStates(["success", "cancelled", "skipped"])).toBe("cancelled");
    expect(foldShardStates(["skipped", "skipped"])).toBe("skipped");
    expect(foldShardStates(["success", "skipped"])).toBe("success");
    expect(foldShardStates(["success", "running", "failure"])).toBe("running");
    expect(foldShardStates(["success", "queued"])).toBe("queued");
  });
});
