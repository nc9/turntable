import { describe, expect, test } from "bun:test";
import {
  assessJob,
  classifyRun,
  credentialsFor,
  isProtectedRef,
  isReleaseRef,
  lintFailsFor,
  workflowSourceRef,
} from "../src/trust";

describe("classification", () => {
  test.each([
    [{ event: "push", ref: "refs/heads/main" }, "protected"],
    [{ event: "push", ref: "refs/heads/release/1.2" }, "protected"],
    [{ event: "push", ref: "refs/tags/v1.0.0" }, "release"],
    [{ event: "push", ref: "refs/heads/feature/x" }, "trusted_pr"],
    [{ event: "schedule", ref: "refs/heads/main" }, "protected"],
    [{ event: "merge_group", ref: "refs/heads/gh-readonly-queue/main/pr-5" }, "trusted_pr"],
    [{ event: "pull_request", ref: "refs/pull/5/merge" }, "untrusted_pr"],
    [
      { event: "pull_request", ref: "refs/pull/5/merge", fork: false, authorTrusted: true },
      "trusted_pr",
    ],
    [
      { event: "pull_request", ref: "refs/pull/5/merge", fork: true, authorTrusted: true },
      "untrusted_pr",
    ],
    [{ event: "pull_request", ref: "refs/pull/5/merge", fork: false }, "untrusted_pr"],
    [{ event: "issue_comment", ref: "refs/heads/main" }, "untrusted_pr"],
    [{ event: "something_new", ref: "refs/heads/main" }, "untrusted_pr"],
  ] as const)("%j is %s", (facts, klass) => {
    expect(classifyRun(facts)).toBe(klass);
  });

  test("a tag is never protected by branch patterns, and bare branch names are accepted", () => {
    expect(isProtectedRef("refs/tags/main")).toBe(false);
    expect(isProtectedRef("main")).toBe(true);
    expect(isReleaseRef("refs/tags/v2")).toBe(true);
    expect(isReleaseRef("refs/heads/v2")).toBe(false);
  });
});

describe("workflow definition source", () => {
  test("a privileged trigger reads the workflow from the base, never from the head", () => {
    expect(
      workflowSourceRef({ event: "pull_request_target", ref: "refs/pull/5/head", baseRef: "main" }),
    ).toBe("refs/heads/main");
    expect(
      workflowSourceRef({ event: "workflow_run", ref: "refs/heads/evil", defaultBranch: "trunk" }),
    ).toBe("refs/heads/trunk");
    expect(workflowSourceRef({ event: "issue_comment", ref: "refs/pull/5/head" })).toBe(
      "refs/heads/main",
    );
    expect(workflowSourceRef({ event: "schedule", ref: "refs/heads/main" })).toBe(
      "refs/heads/main",
    );
  });

  test("pull_request reads the PR head (like GitHub), push reads the pushed commit", () => {
    expect(
      workflowSourceRef({ event: "pull_request", ref: "refs/pull/5/merge", baseRef: "main" }),
    ).toBe("refs/pull/5/merge");
    expect(workflowSourceRef({ event: "push", ref: "refs/heads/dev" })).toBe("refs/heads/dev");
  });
});

describe("demotion of privileged triggers", () => {
  test("a privileged trigger handed a non-protected ref is demoted before start", () => {
    const a = assessJob({
      event: "pull_request_target",
      ref: "refs/pull/9/head",
      fork: false,
      authorTrusted: true,
    });
    expect(a.klass).toBe("untrusted_pr");
    expect(a.demotedFrom).toBe("trusted_pr");
    expect(a.reasons.join(" ")).toContain("non-protected ref refs/pull/9/head");
    expect(credentialsFor(a.klass)).toEqual({ secrets: false, writeToken: false });
  });

  test("a privileged job whose own step checks out the head is demoted even on a protected ref", () => {
    const a = assessJob(
      { event: "pull_request_target", ref: "refs/heads/main", fork: false, authorTrusted: true },
      true,
    );
    expect(a.klass).toBe("untrusted_pr");
    expect(a.demotedFrom).toBe("trusted_pr");
    expect(a.reasons.join(" ")).toContain("checks out the pull request head");
    expect(credentialsFor(a.klass).secrets).toBe(false);
  });

  test("a privileged trigger working from a protected ref with no head checkout is left alone", () => {
    const a = assessJob({
      event: "pull_request_target",
      ref: "refs/heads/main",
      fork: false,
      authorTrusted: true,
    });
    expect(a).toMatchObject({ klass: "trusted_pr" });
    expect(a.demotedFrom).toBeUndefined();
  });

  test("workflow_run and issue_comment are privileged too", () => {
    for (const event of ["workflow_run", "issue_comment", "issues"]) {
      expect(assessJob({ event, ref: "refs/heads/feature" }).klass).toBe("untrusted_pr");
    }
  });

  test("a plain push or pull_request is not subject to the rule", () => {
    expect(assessJob({ event: "push", ref: "refs/heads/feature" }).demotedFrom).toBeUndefined();
    expect(assessJob({ event: "pull_request", ref: "refs/pull/1/merge" }).klass).toBe(
      "untrusted_pr",
    );
  });
});

describe("credentials and lint by class", () => {
  test("only protected and release hold credentials, and only they fail lint", () => {
    expect(credentialsFor("protected")).toEqual({ secrets: true, writeToken: true });
    expect(credentialsFor("release")).toEqual({ secrets: true, writeToken: true });
    expect(credentialsFor("trusted_pr")).toEqual({ secrets: false, writeToken: false });
    expect(credentialsFor("untrusted_pr")).toEqual({ secrets: false, writeToken: false });
    expect(lintFailsFor("protected")).toBe(true);
    expect(lintFailsFor("release")).toBe(true);
    expect(lintFailsFor("trusted_pr")).toBe(false);
    expect(lintFailsFor("untrusted_pr")).toBe(false);
  });
});
