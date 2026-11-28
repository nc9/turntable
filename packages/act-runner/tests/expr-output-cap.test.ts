import { describe, expect, test } from "bun:test";
import { planWorkflow } from "../src/workflow-plan";
import {
  EXPR_OUTPUT_MAX,
  ExprError,
  evaluate,
  evaluateCondition,
  evaluateJobCondition,
  interpolate,
  type ExprContext,
  type Value,
} from "../src/expr";

const big = "x".repeat(50_000);
const ctx: ExprContext = {
  contexts: { github: { event: { body: big, n: [1, 2, { a: null }], e: {}, f: [] } } },
  status: { needs: [], cancelled: false },
};

function refused(fn: () => unknown): void {
  const t = performance.now();
  expect(fn).toThrow(ExprError);
  expect(performance.now() - t).toBeLessThan(50);
}

describe("expression output cap", () => {
  test("format refuses a repeated huge argument", () => {
    refused(() => evaluate(`format('${"{0}".repeat(20_000)}', toJSON(github))`, ctx));
  });
  test("join, toJSON and interpolate refuse past the cap", () => {
    const wide: Value[] = Array.from({ length: 70_000 }, () => "ab");
    const c: ExprContext = { ...ctx, contexts: { v: wide } };
    refused(() => evaluate("join(v, ',')", c));
    refused(() => evaluate("toJSON(v)", c));
    refused(() => interpolate("${{ github.event.body }}${{ github.event.body }}", ctx));
  });
  test("if: conditions are capped too", () => {
    const e = `\${{ format('${"{0}".repeat(20_000)}', github.event.body) == 'a' }}`;
    refused(() => evaluateCondition(e, ctx));
    refused(() => evaluateJobCondition(e, ctx));
  });
  test("output at the cap passes and matches JSON.stringify", () => {
    const v = ctx.contexts.github as Value;
    expect(evaluate("toJSON(github)", ctx)).toBe(JSON.stringify(v, null, 2));
    const s = evaluate(`format('{0}', '${"y".repeat(EXPR_OUTPUT_MAX)}')`, ctx);
    expect((s as string).length).toBe(EXPR_OUTPUT_MAX);
  });
  test("format keeps escapes", () => {
    expect(evaluate("format('{{a}} {0}!', 'b')", ctx)).toBe("{a} b!");
  });
  test("run-name is trimmed after the length cut, and an oversized one falls back", () => {
    const wf = (rn: string): string =>
      `name: R\nrun-name: "${rn}"\non: workflow_dispatch\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo\n`;
    const ev = { name: "workflow_dispatch", ref: "refs/heads/main" } as const;
    const readFile = (): undefined => undefined;
    const p = planWorkflow(wf("  hi   "), ev, { readFile, github: {} });
    expect(p.runName).toBe("hi");
    const q = planWorkflow(wf(`${" ".repeat(199)}x`), ev, { readFile, github: {} });
    expect(q.runName).toBe("x");
    const h = planWorkflow(wf(`\${{ format('${"{0}".repeat(20_000)}', toJSON(github)) }}`), ev, {
      readFile,
      github: { body: big },
    });
    expect(h.runName).toBeUndefined();
    expect(h.runNameWarning).toContain("KiB limit");
  });
});
