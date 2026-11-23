import { describe, expect, test } from "bun:test";
import { PlanError } from "../src/plan";
import { expandMatrix, planWorkflow, topoSort } from "../src/workflow-plan";

const customer = await Bun.file(`${import.meta.dir}/fixtures/customer-like.yml`).text();
const readFile = (): undefined => undefined;
const push = { name: "push", ref: "refs/heads/main" } as const;
const pr = {
  name: "pull_request",
  baseRef: "main",
  ref: "refs/pull/1/merge",
  action: "opened",
} as const;

describe("planWorkflow on a customer-style ci.yml", () => {
  const plan = planWorkflow(customer, push, { readFile });
  const job = (id: string) => plan.jobs.find((j) => j.id === id);

  test("trigger, name, env and concurrency", () => {
    expect(plan.trigger.matched).toBe(true);
    expect(plan.name).toBe("CI");
    expect(plan.env).toEqual({ NO_TELEMETRY: "1" });
    expect(plan.concurrency).toEqual({ group: "ci--refs/heads/main", cancelInProgress: true });
  });

  test("jobs are in dependency order with needs expanded to keys", () => {
    const order = plan.jobs.map((j) => j.id);
    for (const j of plan.jobs)
      for (const n of j.needs) expect(order.indexOf(n)).toBeLessThan(order.indexOf(j.id));
    expect(job("build")?.needsIds).toEqual(["changes", "tests-a", "engine-tests"]);
    expect(job("quality")?.needs).toEqual(["changes"]);
  });

  test("an if that reads event data is decided now; one that reads needs waits", () => {
    expect(job("changelog-guard")?.staticSkip?.reason).toContain("is false");
    expect(job("quality")?.staticSkip).toBeUndefined();
    expect(job("quality")?.ifExpr).toContain("needs.changes.outputs.code");
    const forPr = planWorkflow(customer, pr, { readFile });
    expect(forPr.jobs.find((j) => j.id === "changelog-guard")?.staticSkip).toBeUndefined();
  });

  test("outputs, continue-on-error and docker jobs", () => {
    expect(job("changes")?.outputs).toEqual({
      code: "${{ steps.classify.outputs.code }}",
      engine: "${{ steps.classify.outputs.engine }}",
    });
    expect(job("flaky")?.continueOnError).toBe(true);
    expect(job("images")?.unsupported).toContain("docker");
    expect(job("quality")?.unsupported).toBeUndefined();
  });

  test("an event the workflow does not trigger on is reported, not thrown", () => {
    const p = planWorkflow(customer, { name: "push", ref: "refs/heads/dev" }, { readFile });
    expect(p.trigger.matched).toBe(false);
  });
});

describe("matrix", () => {
  test("cartesian product, exclude, include (extends matches, appends non-matches)", () => {
    const combos = expandMatrix({
      os: ["linux", "mac"],
      node: [18, 20],
      exclude: [{ os: "mac", node: 18 }],
      include: [
        { os: "linux", extra: "yes" },
        { os: "win", node: 22 },
      ],
    });
    expect(combos).toEqual([
      { os: "linux", node: 18, extra: "yes" },
      { os: "linux", node: 20, extra: "yes" },
      { os: "mac", node: 20 },
      { os: "win", node: 22 },
    ]);
  });

  const mwf = `on: push
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      max-parallel: 2
      matrix:
        node: [18, 20]
    steps:
      - run: echo \${{ matrix.node }}
  after:
    needs: test
    runs-on: ubuntu-latest
    steps:
      - run: echo done
`;
  test("legs are separate jobs; dependents wait for every leg", () => {
    const p = planWorkflow(mwf, push, { readFile });
    expect(p.jobs.map((j) => j.key)).toEqual(["test[0]", "test[1]", "after"]);
    expect(p.jobs[0]).toMatchObject({
      matrix: { node: 18 },
      failFast: false,
      maxParallel: 2,
      name: "test (18)",
    });
    expect(p.jobs[2]?.needs).toEqual(["test[0]", "test[1]"]);
  });

  test("a matrix built from an expression is marked unsupported, not guessed", () => {
    const p = planWorkflow(
      `on: push
jobs:
  a:
    runs-on: ubuntu-latest
    strategy:
      matrix: \${{ fromJSON(needs.x.outputs.m) }}
    steps: []
`,
      push,
      { readFile },
    );
    expect(p.jobs[0]?.unsupported).toContain("fromJSON");
  });
});

describe("graph errors and unsupported jobs", () => {
  test("unknown need and cycles", () => {
    const unknown = `on: push\njobs:\n  a:\n    needs: nope\n    runs-on: ubuntu-latest\n    steps: []\n`;
    expect(() => planWorkflow(unknown, push, { readFile })).toThrow(PlanError);
    const cycle = `on: push\njobs:\n  a:\n    needs: b\n    runs-on: ubuntu-latest\n    steps: []\n  b:\n    needs: a\n    runs-on: ubuntu-latest\n    steps: []\n`;
    expect(() => planWorkflow(cycle, push, { readFile })).toThrow(/cycle/);
    expect(() => topoSort([])).not.toThrow();
  });

  test.each([
    ["container: node:22\n    steps: []", "container"],
    ["services:\n      db:\n        image: postgres\n    steps: []", "services"],
    ["steps:\n      - uses: docker://alpine", "docker://"],
    ["steps:\n      - uses: docker/build-push-action@v6", "docker daemon"],
  ])("docker-requiring job: %s", (body, reason) => {
    const p = planWorkflow(
      `on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    ${body}\n`,
      push,
      { readFile },
    );
    expect(p.jobs[0]?.unsupported).toContain(reason);
  });

  test("non-Linux and a local docker action", () => {
    const win = planWorkflow(
      `on: push\njobs:\n  a:\n    runs-on: windows-latest\n    steps: []\n`,
      push,
      { readFile },
    );
    expect(win.jobs[0]?.unsupported).toContain("not a Linux runner");
    const files: Record<string, string> = {
      ".github/actions/d/action.yml": "runs:\n  using: docker\n  image: Dockerfile\n",
    };
    const local = planWorkflow(
      `on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: ./.github/actions/d\n`,
      push,
      { readFile: (f) => files[f] },
    );
    expect(local.jobs[0]?.unsupported).toContain("docker action");
  });
});

describe("local actions outside the repository", () => {
  test("a job whose local action path leaves the repo is unsupported, and nothing is read for it", () => {
    const reads: string[] = [];
    const wp = planWorkflow(
      "on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: ./../../etc/x\n  b:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: ./.github/actions/ok\n",
      { name: "push", ref: "refs/heads/main" },
      { readFile: (p) => (reads.push(p), undefined) },
    );
    expect(wp.jobs.find((j) => j.id === "a")?.unsupported).toContain("outside the repository");
    expect(wp.jobs.find((j) => j.id === "b")?.unsupported).toBeUndefined();
    expect(reads.every((p) => p.startsWith(".github/actions/ok/"))).toBe(true);
  });
});

describe("job environment", () => {
  const wf = (env: string) => `
name: Release
on: push
jobs:
  deploy:
    runs-on: ubuntu-latest
    ${env}
    steps:
      - run: echo deploy
  plain:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`;
  const plan = (env: string) =>
    planWorkflow(wf(env), push, { readFile }).jobs.find((j) => j.id === "deploy")!;

  test("a literal name, or the name of a mapping, is recorded", () => {
    expect(plan("environment: production").environment).toBe("production");
    expect(plan("environment:\n      name: release\n      url: https://x").environment).toBe(
      "release",
    );
    expect(
      planWorkflow(wf("environment: production"), push, { readFile }).jobs.find(
        (j) => j.id === "plain",
      )?.environment,
    ).toBeUndefined();
  });

  test("an environment built from an expression cannot be gated, so the job is refused", () => {
    const j = plan("environment: ${{ github.ref_name }}");
    expect(j.environment).toBeUndefined();
    expect(j.unsupported).toContain("environment");
  });
});

describe("the id-token flag on a planned job", () => {
  const plan = (head: string, jobPerm: string) =>
    planWorkflow(
      `name: t\non: push\n${head}jobs:\n  a:\n    runs-on: ubuntu-latest\n${jobPerm}    steps:\n      - run: echo hi\n  b:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n`,
      push,
      { readFile },
    ).jobs;
  const flag = (jobs: ReturnType<typeof plan>, id: string) =>
    jobs.find((j) => j.id === id)!.idToken;

  test("set only for a job that asked, with the job block replacing the workflow's", () => {
    // Nothing asked: not set at all, so a stored plan stays as small as before.
    expect(flag(plan("", ""), "a")).toBeUndefined();
    // The workflow's block applies to a job with none of its own.
    const wfLevel = plan("permissions:\n  id-token: write\n", "");
    expect([flag(wfLevel, "a"), flag(wfLevel, "b")]).toEqual([true, true]);
    // A job's own block replaces it, in both directions.
    const off = plan(
      "permissions:\n  id-token: write\n",
      "    permissions:\n      contents: read\n",
    );
    expect([flag(off, "a"), flag(off, "b")]).toEqual([undefined, true]);
    const on = plan("", "    permissions:\n      id-token: write\n");
    expect([flag(on, "a"), flag(on, "b")]).toEqual([true, undefined]);
    // write-all counts; read-all and id-token: read do not.
    expect(flag(plan("permissions: write-all\n", ""), "a")).toBe(true);
    expect(flag(plan("permissions: read-all\n", ""), "a")).toBeUndefined();
    expect(flag(plan("permissions:\n  id-token: read\n", ""), "a")).toBeUndefined();
  });
});
