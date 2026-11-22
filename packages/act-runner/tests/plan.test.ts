import { describe, expect, test } from "bun:test";
import { PlanError, planJob } from "../src/plan";

const CO = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
const wf = (job: string): string => `name: t\non: push\njobs:\n  j:\n${job}`;
const plan = (job: string) => planJob(wf(job), "j", { workflowPath: ".github/workflows/ci.yml" });
const feature = (job: string): string | undefined => {
  try {
    plan(job);
  } catch (e) {
    if (e instanceof PlanError) return e.feature;
    throw e;
  }
  return undefined;
};

describe("planJob accepts", () => {
  test("simple job: argv has -W, --concurrent-jobs, host mode, never -n", () => {
    const p = plan(
      `    runs-on: ubuntu-latest\n    steps:\n      - uses: ${CO}\n      - run: echo hi\n`,
    );
    expect(p.argv[0]).toBe("/tmp/tt-act/act");
    expect(p.argv).toContain("-W");
    expect(p.argv[p.argv.indexOf("-W") + 1]).toBe(".github/workflows/ci.yml");
    expect(p.argv[p.argv.indexOf("-j") + 1]).toBe("j");
    expect(p.argv).toContain("--concurrent-jobs");
    expect(p.argv).toContain("--json");
    expect(p.argv).toContain("--no-skip-checkout");
    expect(p.argv).toContain("ubuntu-latest=-self-hosted");
    for (const bad of ["-n", "--dryrun"]) expect(p.argv).not.toContain(bad);
    expect(p.checkoutRefs).toEqual([CO]);
    expect(p.argv).toContain(`${CO}=/tmp/tt-act/stubs/checkout-0`);
    expect(p.cwd).toBe("/tmp/tt-act/repo");
  });
  test("one --local-repository per distinct checkout ref", () => {
    const p = plan(
      `    runs-on: [self-hosted, linux]\n    steps:\n      - uses: ${CO}\n      - uses: ${CO}\n      - uses: actions/checkout@v4\n        with: { path: x }\n`,
    );
    expect(p.argv.filter((a) => a === "--local-repository")).toHaveLength(2);
  });
  test("empty needs is fine", () => {
    expect(feature("    runs-on: ubuntu-24.04\n    needs: []\n    steps: []\n")).toBeUndefined();
  });
});

describe("planJob rejects, naming the feature", () => {
  const base = "    runs-on: ubuntu-latest\n";
  test.each([
    ["needs", `${base}    needs: other\n    steps: []\n`],
    ["services", `${base}    services:\n      db:\n        image: postgres\n    steps: []\n`],
    ["container", `${base}    container: node:22\n    steps: []\n`],
    ["matrix", `${base}    strategy:\n      matrix:\n        n: [1, 2]\n    steps: []\n`],
    ["non-Linux runs-on", "    runs-on: windows-latest\n    steps: []\n"],
    ["non-Linux runs-on", "    runs-on: macos-14\n    steps: []\n"],
    ["runs-on expression", "    runs-on: ${{ matrix.os }}\n    steps: []\n"],
    ["docker:// action", `${base}    steps:\n      - uses: docker://alpine:3\n`],
    ["reusable workflow", "    uses: ./.github/workflows/x.yml\n"],
  ])("%s", (name, job) => {
    expect(feature(job)).toBe(name);
  });
  test("unknown job and bad yaml", () => {
    expect(() =>
      planJob(wf("    runs-on: ubuntu-latest\n    steps: []\n"), "nope", { workflowPath: "w" }),
    ).toThrow(PlanError);
    expect(() => planJob("a: [", "j", { workflowPath: "w" })).toThrow(PlanError);
  });
});
