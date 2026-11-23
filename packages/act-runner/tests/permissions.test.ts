import { describe, expect, test } from "bun:test";
import { declaredPermissions, DEFAULT_PERMISSIONS, wantsIdToken } from "../src/permissions";

const wf = (body: string): string => `name: t\non: push\n${body}`;

describe("declaredPermissions", () => {
  test("nothing declared: the default, contents read", () => {
    const r = declaredPermissions(wf("jobs:\n  a:\n    runs-on: x\n    steps: []\n"), "a");
    expect(r).toEqual({ permissions: { ...DEFAULT_PERMISSIONS }, declared: false, notes: [] });
  });

  test("workflow level applies, job level replaces it (no merge)", () => {
    const y = wf(
      "permissions:\n  contents: write\n  issues: write\njobs:\n  a:\n    runs-on: x\n    steps: []\n  b:\n    runs-on: x\n    permissions:\n      pull-requests: read\n    steps: []\n",
    );
    expect(declaredPermissions(y, "a").permissions).toEqual({ contents: "write", issues: "write" });
    expect(declaredPermissions(y, "b").permissions).toEqual({ pull_requests: "read" });
  });

  test("read-all, write-all, an empty map and none", () => {
    const job = (p: string): string =>
      wf(`jobs:\n  a:\n    runs-on: x\n    permissions: ${p}\n    steps: []\n`);
    expect(declaredPermissions(job("read-all"), "a").permissions.contents).toBe("read");
    expect(declaredPermissions(job("write-all"), "a").permissions.contents).toBe("write");
    expect(declaredPermissions(job("{}"), "a")).toMatchObject({ permissions: {}, declared: true });
    expect(declaredPermissions(job("{ contents: none, issues: read }"), "a").permissions).toEqual({
      issues: "read",
    });
  });

  test("names that no installation token carries are dropped with a note, never mapped", () => {
    const y = wf(
      "permissions:\n  id-token: write\n  attestations: write\n  security-events: write\n  contents: read\n  bogus: yes\njobs:\n  a:\n    runs-on: x\n    steps: []\n",
    );
    const r = declaredPermissions(y, "a");
    expect(r.permissions).toEqual({ security_events: "write", contents: "read" });
    expect(r.notes.join("\n")).toContain("id-token");
    expect(r.notes.join("\n")).toContain("attestations");
    expect(r.notes.join("\n")).toContain("bogus");
  });

  test("a malformed value is treated as none, and broken YAML as the default", () => {
    expect(
      declaredPermissions(wf("permissions: 7\njobs:\n  a:\n    runs-on: x\n    steps: []\n"), "a"),
    ).toMatchObject({ permissions: {}, declared: true });
    expect(declaredPermissions("a: [", "a").permissions).toEqual({ ...DEFAULT_PERMISSIONS });
  });
});

describe("wantsIdToken", () => {
  const job = "jobs:\n  a:\n    runs-on: x\n    steps: []\n";
  test("only an explicit id-token: write asks for a token", () => {
    expect(wantsIdToken(wf(job), "a")).toBe(false);
    expect(wantsIdToken(wf(`permissions:\n  id-token: write\n${job}`), "a")).toBe(true);
    expect(wantsIdToken(wf(`permissions:\n  id-token: read\n${job}`), "a")).toBe(false);
    expect(wantsIdToken(wf(`permissions: write-all\n${job}`), "a")).toBe(true);
    expect(wantsIdToken(wf(`permissions: read-all\n${job}`), "a")).toBe(false);
  });
  test("a job's own block replaces the workflow's, in both directions", () => {
    const withJob = (p: string) =>
      `jobs:\n  a:\n    runs-on: x\n    permissions:\n      ${p}\n    steps: []\n`;
    expect(
      wantsIdToken(wf(`permissions:\n  id-token: write\n${withJob("contents: read")}`), "a"),
    ).toBe(false);
    expect(wantsIdToken(wf(withJob("id-token: write")), "a")).toBe(true);
  });
  test("broken YAML asks for nothing; the workflow's block applies to a job with none", () => {
    expect(wantsIdToken("a: [", "a")).toBe(false);
    expect(wantsIdToken(wf(`permissions:\n  id-token: write\n${job}`), "nope")).toBe(true);
  });
});
