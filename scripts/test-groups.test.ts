import { describe, expect, test } from "bun:test";
import { diff, resolveCommand } from "./compare-test-groups";
import { parseGroupCall, readGroup, resolveGroups, testScripts } from "./test-groups";

describe("test groups", () => {
  test("a group call parses with and without an env prefix", () => {
    expect(parseGroupCall("bun scripts/run-test-group.ts core3")).toEqual({
      env: [],
      group: "core3",
    });
    expect(parseGroupCall("TT_ACT_E2E=1 bun scripts/run-test-group.ts act-e2e")).toEqual({
      env: ["TT_ACT_E2E=1"],
      group: "act-e2e",
    });
    expect(parseGroupCall("bun test a.test.ts")).toBeUndefined();
  });

  test("every test:* script is a group call whose file lists tests", () => {
    for (const cmd of Object.values(testScripts())) expect(parseGroupCall(cmd)).toBeDefined();
    const groups = resolveGroups();
    expect(groups.size).toBeGreaterThan(30);
    for (const g of groups.values()) for (const f of g.files) expect(f).toMatch(/\.test\.tsx?$/);
  });

  test("a missing group file throws", () => {
    expect(() => readGroup("no-such-group")).toThrow("no test group file");
  });

  test("the comparison reads the old inline form and reports differences", () => {
    const old = resolveCommand("X=1 bun test a.test.ts b.test.ts", ".");
    expect(old).toEqual({ env: ["X=1"], files: ["a.test.ts", "b.test.ts"] });
    const m = (r: typeof old) => new Map([["test:x", r]]);
    expect(diff(m(old), m(old))).toEqual([]);
    expect(diff(m(old), m({ env: [], files: ["b.test.ts", "a.test.ts"] }))).toEqual([
      "test:x: env X=1 -> ",
      "test:x: files differ (2 -> 2)",
    ]);
  });
});
