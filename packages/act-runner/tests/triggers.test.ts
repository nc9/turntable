import { describe, expect, test } from "bun:test";
import { matchTrigger, matchesPatterns, patternToRegExp } from "../src/triggers";

describe("patterns", () => {
  test.each([
    ["*.js", "app.js", true],
    ["*.js", "src/app.js", false],
    ["**/*.js", "app.js", true],
    ["**/*.js", "src/deep/app.js", true],
    ["docs/**", "docs/a/b.md", true],
    ["docs/**", "src/docs/a.md", false],
    ["releases/v[12].*", "releases/v1.3", true],
    ["feat/*", "feat/x", true],
    ["feat/*", "feat/x/y", false],
    ["feat/**", "feat/x/y", true],
    ["v1.?", "v1.", true],
    ["a+b", "aaab", true],
  ])("%s vs %s", (p, v, want) => {
    expect(patternToRegExp(p).test(v)).toBe(want);
  });
  test("last matching pattern wins, with negation", () => {
    const p = ["docs/**", "!docs/private/**", "docs/private/ok.md"];
    expect(matchesPatterns(p, "docs/a.md")).toBe(true);
    expect(matchesPatterns(p, "docs/private/x.md")).toBe(false);
    expect(matchesPatterns(p, "docs/private/ok.md")).toBe(true);
  });
});

const ci = {
  push: { branches: ["main"] },
  pull_request: { branches: ["main"] },
  merge_group: null,
};

describe("matchTrigger", () => {
  test("the customer-style triggers", () => {
    expect(matchTrigger(ci, { name: "push", ref: "refs/heads/main" }).matched).toBe(true);
    expect(matchTrigger(ci, { name: "push", ref: "refs/heads/dev" }).matched).toBe(false);
    expect(
      matchTrigger(ci, { name: "pull_request", baseRef: "main", action: "opened" }).matched,
    ).toBe(true);
    expect(matchTrigger(ci, { name: "pull_request", baseRef: "dev" }).matched).toBe(false);
    expect(matchTrigger(ci, { name: "merge_group", baseRef: "main" }).matched).toBe(true);
    expect(matchTrigger(ci, { name: "schedule" }).matched).toBe(false);
  });
  test("string and list forms", () => {
    expect(matchTrigger("push", { name: "push", ref: "refs/heads/x" }).matched).toBe(true);
    expect(matchTrigger(["push", "workflow_dispatch"], { name: "workflow_dispatch" }).matched).toBe(
      true,
    );
    expect(matchTrigger(["push"], { name: "pull_request" }).matched).toBe(false);
  });
  test("branches-ignore, tags, and branch/tag mismatch", () => {
    const on = { push: { "branches-ignore": ["wip/**"] } };
    expect(matchTrigger(on, { name: "push", ref: "refs/heads/wip/x" }).matched).toBe(false);
    expect(matchTrigger(on, { name: "push", ref: "refs/heads/main" }).matched).toBe(true);
    const tags = { push: { tags: ["v*"] } };
    expect(matchTrigger(tags, { name: "push", ref: "refs/tags/v1" }).matched).toBe(true);
    expect(matchTrigger(tags, { name: "push", ref: "refs/heads/main" }).matched).toBe(false);
    expect(matchTrigger(ci, { name: "push", ref: "refs/tags/v1" }).matched).toBe(false);
  });
  test("pull_request activity types", () => {
    const on = { pull_request: { types: ["labeled"] } };
    expect(matchTrigger(on, { name: "pull_request", action: "opened" }).matched).toBe(false);
    expect(matchTrigger(on, { name: "pull_request", action: "labeled" }).matched).toBe(true);
    expect(
      matchTrigger({ pull_request: null }, { name: "pull_request", action: "synchronize" }).matched,
    ).toBe(true);
    expect(
      matchTrigger({ pull_request: null }, { name: "pull_request", action: "closed" }).matched,
    ).toBe(false);
  });
  test("paths: at least one changed file must match", () => {
    const on = { push: { paths: ["src/**", "!src/gen/**"] } };
    const ev = (files: string[]) =>
      matchTrigger(on, { name: "push", ref: "refs/heads/m", changedFiles: files });
    expect(ev(["README.md"]).matched).toBe(false);
    expect(ev(["src/a.ts"]).matched).toBe(true);
    expect(ev(["src/gen/x.ts"]).matched).toBe(false);
    expect(ev(["README.md", "src/a.ts"]).matched).toBe(true);
  });
  test("paths-ignore: runs unless every file is ignored", () => {
    const on = { pull_request: { "paths-ignore": ["docs/**", "*.md"] } };
    const ev = (files: string[]) =>
      matchTrigger(on, { name: "pull_request", action: "opened", changedFiles: files });
    expect(ev(["docs/a.md", "README.md"]).matched).toBe(false);
    expect(ev(["docs/a.md", "src/x.ts"]).matched).toBe(true);
  });
  test("path filters with unknown changed files do not drop the run, and say so", () => {
    const r = matchTrigger({ push: { paths: ["src/**"] } }, { name: "push", ref: "refs/heads/m" });
    expect(r).toMatchObject({ matched: true, pathsUnknown: true });
  });
});
