import { describe, expect, test } from "bun:test";
import { parse } from "yaml";
import { planJob } from "../src/plan";
import { EXPORT_STEP_NAME, splitJob } from "../src/split";
import { planWorkflow } from "../src/workflow-plan";

const customer = await Bun.file(`${import.meta.dir}/fixtures/customer-like.yml`).text();
const readFile = (): undefined => undefined;
const push = { name: "push", ref: "refs/heads/main" } as const;
const wf = planWorkflow(customer, push, { readFile });
const node = (id: string) => wf.jobs.find((j) => j.id === id)!;

describe("splitJob", () => {
  test("stub need jobs carry real results and outputs as literals", () => {
    const yaml = splitJob(
      customer,
      node("engine-tests"),
      {
        changes: { result: "success", outputs: { code: "true", engine: 'it\'s "x" ${{ y }}' } },
        quality: { result: "skipped", outputs: {} },
      },
      { event: "push" },
    );
    const doc = parse(yaml) as { on: string; jobs: Record<string, any> };
    expect(doc.on).toBe("push");
    expect(Object.keys(doc.jobs).sort()).toEqual(["changes", "engine-tests", "quality"]);
    expect(doc.jobs.changes.outputs.code).toBe("${{ 'true' }}");
    expect(doc.jobs.changes.outputs.engine).toBe("${{ 'it''s \"x\" ${{ y }}' }}");
    expect(doc.jobs.quality.if).toBe("${{ false }}");
    expect(doc.jobs.changes.steps[0].run).toBe("true");
    expect(doc.jobs["engine-tests"].needs).toEqual(["changes", "quality"]);
    expect(doc.jobs["engine-tests"].if).toContain("needs.quality.result");
  });

  test("a failed need becomes a stub that fails", () => {
    const yaml = splitJob(
      customer,
      node("tests-a"),
      { quality: { result: "failure", outputs: {} } },
      { event: "push" },
    );
    const doc = parse(yaml) as { jobs: Record<string, any> };
    expect(doc.jobs.quality.steps[0].run).toBe("exit 1");
  });

  test("the declared outputs are exported by a final always() step", () => {
    const yaml = splitJob(customer, node("changes"), {}, { event: "push", root: "/r" });
    const doc = parse(yaml) as { jobs: Record<string, any> };
    const steps = doc.jobs.changes.steps as any[];
    const last = steps.at(-1);
    expect(last.name).toBe(EXPORT_STEP_NAME);
    expect(last.if).toBe("${{ always() }}");
    expect(last.env).toEqual({
      TT_OUT_0: "${{ steps.classify.outputs.code }}",
      TT_OUT_1: "${{ steps.classify.outputs.engine }}",
    });
    expect(last.run).toContain("printf '%s' \"$TT_OUT_0\" > '/r/outputs/code'");
    expect(steps).toHaveLength(3);
  });

  test("a matrix leg becomes one literal leg and runs-on is resolved", () => {
    const mwf = `on: push
jobs:
  test:
    runs-on: \${{ matrix.os }}
    strategy:
      matrix:
        os: [ubuntu-latest]
        node: [18, 20]
    steps:
      - run: echo \${{ matrix.node }}
`;
    const p = planWorkflow(mwf, push, { readFile });
    const yaml = splitJob(mwf, p.jobs[1]!, {}, { event: "push" });
    const doc = parse(yaml) as { jobs: Record<string, any> };
    expect(doc.jobs.test["runs-on"]).toBe("ubuntu-latest");
    expect(doc.jobs.test.strategy).toEqual({ matrix: { os: ["ubuntu-latest"], node: [20] } });
  });

  test("the generated workflow is a valid single-job plan", () => {
    const yaml = splitJob(
      customer,
      node("quality"),
      { changes: { result: "success", outputs: { code: "true" } } },
      { event: "push" },
    );
    const plan = planJob(yaml, "quality", {
      workflowPath: ".longshore/jobs/quality.yml",
      readFile,
      split: true,
    });
    expect(plan.stubIds).toEqual(["changes"]);
    expect(plan.outputNames).toEqual([]);
    expect(plan.files[0]?.path).toBe(".longshore/jobs/quality.yml");
    // Without the split flag the same file is refused: needs is not allowed in a user workflow.
    expect(() => planJob(yaml, "quality", { workflowPath: "x.yml", readFile })).toThrow(/needs/);
  });

  test("an output name that is not an identifier is refused", () => {
    const bad = `on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    outputs:\n      "x y": \${{ 1 }}\n    steps: []\n`;
    const p = planWorkflow(bad, push, { readFile });
    expect(() => splitJob(bad, p.jobs[0]!, {}, { event: "push" })).toThrow(/output name/);
  });
});
