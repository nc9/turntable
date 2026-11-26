import { describe, expect, test } from "bun:test";
import {
  ExprError,
  evaluate,
  evaluateCondition,
  interpolate,
  referencedContexts,
  type ExprContext,
  type Value,
} from "../src/expr";

const ctx = (
  contexts: Record<string, Value> = {},
  needs: string[] = [],
  cancelled = false,
): ExprContext => ({ contexts, status: { needs, cancelled } });

const github: Record<string, Value> = {
  event_name: "pull_request",
  ref: "refs/heads/feat",
  event: { pull_request: { base: { sha: "abc" }, draft: false, labels: [{ name: "a" }] } },
};

describe("literals and operators", () => {
  test.each([
    ["1 == 1", true],
    ["'ABC' == 'abc'", true],
    ["'a' != 'b'", true],
    ["1 < 2 && 2 <= 2", true],
    ["!false", true],
    ["null == ''", true],
    ["'1' == 1", true],
    ["true == 1", true],
    ["'x' || 'y'", "x"],
    ["'' || 'y'", "y"],
    ["0 && 'y'", 0],
    ["(1 == 2) || !(1 == 2)", true],
    ["'it''s'", "it's"],
    ["0x10 == 16", true],
    ["-1 < 0", true],
    ["'b' > 'a'", true],
  ])("%s", (e, want) => {
    expect(evaluate(e, ctx())).toBe(want as Value);
  });
});

describe("contexts", () => {
  test("property and index access, case-insensitive", () => {
    expect(evaluate("github.event_name", ctx({ github }))).toBe("pull_request");
    expect(evaluate("GitHub.Event_Name", ctx({ github }))).toBe("pull_request");
    expect(evaluate("github['ref']", ctx({ github }))).toBe("refs/heads/feat");
    expect(evaluate("github.event.pull_request.base.sha", ctx({ github }))).toBe("abc");
    expect(evaluate("github.event.pull_request.labels[0].name", ctx({ github }))).toBe("a");
    expect(evaluate("github.nope.deeper", ctx({ github }))).toBe(null);
  });
  test("needs outputs", () => {
    const c = ctx({ needs: { changes: { result: "success", outputs: { code: "true" } } } });
    expect(evaluate("needs.changes.outputs.code != 'false'", c)).toBe(true);
    expect(evaluate("needs.changes.result == 'success'", c)).toBe(true);
  });
});

describe("functions", () => {
  test("contains, startsWith, endsWith, join, format", () => {
    expect(evaluate("contains('Hello', 'ell')", ctx())).toBe(true);
    expect(evaluate("contains(fromJSON('[\"success\",\"skipped\"]'), 'skipped')", ctx())).toBe(
      true,
    );
    expect(evaluate("contains(fromJSON('[\"success\"]'), 'failure')", ctx())).toBe(false);
    expect(evaluate("startsWith('refs/heads/x', 'refs/heads/')", ctx())).toBe(true);
    expect(evaluate("endsWith('a.md', '.MD')", ctx())).toBe(true);
    expect(evaluate("join(fromJSON('[1,2,3]'), '-')", ctx())).toBe("1-2-3");
    expect(evaluate("format('{0}-{1} {{x}}', 'a', 2)", ctx())).toBe("a-2 {x}");
    expect(evaluate("toJSON(fromJSON('{\"a\":1}'))", ctx())).toBe('{\n  "a": 1\n}');
  });
  test("fromJSON of bad input fails loudly", () => {
    expect(() => evaluate("fromJSON('{')", ctx())).toThrow(ExprError);
  });
});

describe("status functions", () => {
  test("success() needs every need to have succeeded", () => {
    expect(evaluate("success()", ctx({}, []))).toBe(true);
    expect(evaluate("success()", ctx({}, ["success", "success"]))).toBe(true);
    expect(evaluate("success()", ctx({}, ["success", "skipped"]))).toBe(false);
    expect(evaluate("success()", ctx({}, ["failure"]))).toBe(false);
  });
  test("failure(), always(), cancelled()", () => {
    expect(evaluate("failure()", ctx({}, ["success", "failure"]))).toBe(true);
    expect(evaluate("always()", ctx({}, ["failure"]))).toBe(true);
    expect(evaluate("cancelled()", ctx({}, [], true))).toBe(true);
    expect(evaluate("!cancelled()", ctx({}, ["failure"]))).toBe(true);
  });
});

describe("evaluateCondition", () => {
  test("default is success()", () => {
    expect(evaluateCondition(undefined, ctx({}, ["success"]))).toBe(true);
    expect(evaluateCondition(undefined, ctx({}, ["failure"]))).toBe(false);
  });
  test("wrapped and bare forms, booleans", () => {
    expect(evaluateCondition("${{ github.event_name == 'pull_request' }}", ctx({ github }))).toBe(
      true,
    );
    expect(evaluateCondition("github.event_name == 'push'", ctx({ github }))).toBe(false);
    expect(evaluateCondition(false, ctx())).toBe(false);
  });
  test("the customer-style gate", () => {
    const e =
      "${{ !cancelled() && (needs.changes.result != 'success' || needs.changes.outputs.code != 'false') }}";
    const ok = ctx({ needs: { changes: { result: "success", outputs: { code: "true" } } } }, [
      "success",
    ]);
    const docs = ctx({ needs: { changes: { result: "success", outputs: { code: "false" } } } }, [
      "success",
    ]);
    expect(evaluateCondition(e, ok)).toBe(true);
    expect(evaluateCondition(e, docs)).toBe(false);
  });
  test("mixed text and expression fails loudly", () => {
    expect(() => evaluateCondition("x ${{ true }}", ctx())).toThrow(ExprError);
  });
});

describe("the object filter", () => {
  test.each([
    ["contains(github.event.pull_request.labels.*.name, 'a')", true],
    ["contains(github.event.pull_request.labels.*.name, 'b')", false],
    ["github.event.pull_request.nothing.*.name == ''", false],
  ])("%s", (e, want) => {
    expect(evaluateCondition(e, ctx({ github }))).toBe(want);
  });
});

describe("unsupported constructs name the feature", () => {
  test.each([
    ["hashFiles('**/x')", "function hashFiles"],
    ["github.event.*", "object filter"],
    ["unknownFn(1)", "function unknownFn"],
  ])("%s", (e, feature) => {
    try {
      evaluate(e, ctx({ github }));
      throw new Error("expected ExprError");
    } catch (err) {
      expect(err).toBeInstanceOf(ExprError);
      expect((err as ExprError).feature).toBe(feature);
    }
  });
  test("syntax errors", () => {
    for (const bad of ["1 +", "'open", "a b", "(1"]) {
      expect(() => evaluate(bad, ctx())).toThrow(ExprError);
    }
  });
});

describe("interpolate and referencedContexts", () => {
  test("interpolates every expression", () => {
    expect(interpolate("ci-${{ github.event_name }}-${{ github.ref }}", ctx({ github }))).toBe(
      "ci-pull_request-refs/heads/feat",
    );
  });
  test("lists referenced contexts", () => {
    expect(referencedContexts("github.event_name == 'x' && needs.a.result == 'success'")).toEqual(
      new Set(["github", "needs"]),
    );
    expect(referencedContexts("!cancelled()")).toEqual(new Set(["status"]));
  });
});
