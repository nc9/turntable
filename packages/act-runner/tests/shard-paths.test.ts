// Shards limited by `paths`: selection at plan time from the changed files, and what the rest of
// the workflow sees when shards are skipped.
import { describe, expect, test } from "bun:test";
import {
  foldShardStates,
  jobReadiness,
  planWorkflow,
  splitRuleProblem,
  type NeedState,
  type SplitRule,
} from "../src/index";

const WF = `on: [push]
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
      - run: echo done
`;

const RULE: SplitRule = {
  job: "tests",
  shards: [
    { steps: ["Core tests"], paths: ["packages/core/**"] },
    { steps: ["UI tests"], paths: ["packages/ui/**", "!packages/ui/docs/**"] },
  ],
};

const plan = (files: string[] | undefined, rule: SplitRule = RULE) =>
  planWorkflow(
    WF,
    { name: "push", ref: "refs/heads/main", ...(files ? { changedFiles: files } : {}) },
    { readFile: () => undefined, splits: [rule], changedSource: "push a1b2c3d..d4e5f6a" },
  );
const skipped = (files: string[] | undefined, rule?: SplitRule) =>
  plan(files, rule)
    .jobs.filter((j) => j.id === "tests")
    .map((j) => j.staticSkip !== undefined);

describe("selecting shards by changed paths", () => {
  test("a match runs the shard; no match skips it with a reason that names the source", () => {
    expect(skipped(["packages/core/src/a.ts"])).toEqual([false, true]);
    expect(skipped(["packages/ui/src/a.tsx"])).toEqual([true, false]);
    expect(skipped(["packages/core/a.ts", "packages/ui/b.ts"])).toEqual([false, false]);
    const leg = plan(["README.md"]).jobs.find((j) => j.key === "tests[0]")!;
    expect(leg.staticSkip?.reason).toContain("no shard paths changed");
    expect(leg.staticSkip?.reason).toContain("push a1b2c3d..d4e5f6a");
  });

  test("a shard with no paths always runs", () => {
    const rule: SplitRule = {
      job: "tests",
      shards: [{ steps: ["Core tests"] }, { steps: ["UI tests"], paths: ["packages/ui/**"] }],
    };
    expect(skipped(["README.md"], rule)).toEqual([false, true]);
  });

  test("unknown changed files run every shard, and the plan says so", () => {
    expect(skipped(undefined)).toEqual([false, false]);
    expect(plan(undefined).splitNotices[0]).toContain("changed files unknown");
    // an empty list is never read as "nothing changed"
    expect(skipped([])).toEqual([false, false]);
  });

  test("the notice names the source and the number of files", () => {
    expect(plan(["a", "b", "c"]).splitNotices).toEqual([
      "shards selected by changed paths (push a1b2c3d..d4e5f6a, 3 files)",
    ]);
  });

  test("a deleted file or either side of a rename matches by its path", () => {
    // the ingest lists a rename's old and new path, and a deletion by its path
    expect(skipped(["packages/core/old.ts", "docs/new.ts"])).toEqual([false, true]);
    expect(skipped(["docs/old.ts", "packages/ui/new.ts"])).toEqual([true, false]);
  });

  test("! negation: the last matching pattern decides", () => {
    expect(skipped(["packages/ui/docs/guide.md"])).toEqual([true, true]);
    expect(skipped(["packages/ui/docs/guide.md", "packages/ui/x.ts"])).toEqual([true, false]);
  });

  test("no rule has paths: no notice, nothing skipped", () => {
    const rule: SplitRule = {
      job: "tests",
      shards: [{ steps: ["Core tests"] }, { steps: ["UI tests"] }],
    };
    const p = plan(["README.md"], rule);
    expect(p.splitNotices).toEqual([]);
    expect(p.jobs.every((j) => j.staticSkip === undefined)).toBe(true);
  });

  test("a merge group's files can be given apart from the event's", () => {
    const p = planWorkflow(
      WF,
      { name: "merge_group", ref: "refs/heads/q" },
      { readFile: () => undefined, splits: [RULE], shardChangedFiles: ["packages/ui/a.ts"] },
    );
    expect(p.jobs.filter((j) => j.id === "tests").map((j) => j.staticSkip !== undefined)).toEqual([
      true,
      false,
    ]);
  });
});

describe("what the rest of the workflow sees", () => {
  const gate = plan(["README.md"]).jobs.find((j) => j.id === "gate")!;
  const needs = (states: string[]) =>
    Object.fromEntries(states.map((s, i) => [`tests[${i}]`, { state: s as NeedState }]));

  test("some shards skipped: the fold ignores them", () => {
    expect(foldShardStates(["skipped", "success"])).toBe("success");
    expect(foldShardStates(["skipped", "failure"])).toBe("failure");
  });

  test("every shard skipped: the folded job is skipped, and a dependent is skipped as for a skipped job", () => {
    expect(foldShardStates(["skipped", "skipped"])).toBe("skipped");
    expect(jobReadiness(gate, needs(["skipped", "skipped"])).decision).toBe("skip");
    expect(jobReadiness(gate, needs(["skipped", "success"])).decision).toBe("ready");
  });
});

describe("validating paths", () => {
  const rule = (paths: string[] | undefined): SplitRule => ({
    job: "tests",
    shards: [{ steps: ["a"], ...(paths ? { paths } : {}) }, { steps: ["b"] }],
  });

  test("good lists pass: globs, negation, no paths", () => {
    expect(splitRuleProblem(rule(["src/**", "!src/docs/**", "*.md", "a/[bc]/x"]))).toBeUndefined();
    expect(splitRuleProblem(rule(undefined))).toBeUndefined();
  });

  test("an empty list is an error, not 'never run'", () => {
    expect(splitRuleProblem(rule([]))).toContain("empty paths list");
  });

  test("bad globs are refused", () => {
    for (const bad of [[""], ["!"], ["a[b"], ["!only/negated/**"], ["x".repeat(201)], ["a\nb"]])
      expect(splitRuleProblem(rule(bad)), JSON.stringify(bad)).toBeDefined();
    expect(splitRuleProblem(rule(Array.from({ length: 51 }, (_, i) => `d${i}/**`)))).toContain(
      "more than 50",
    );
  });
});
