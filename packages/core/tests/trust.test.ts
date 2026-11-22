import { describe, expect, test } from "bun:test";
import {
  assessJob,
  decideRun,
  needsApproval,
  classifyRun,
  credentialsFor,
  isProtectedRef,
  isReleaseRef,
  lintFailsFor,
  workflowSourceRef,
  type ForgePermission,
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

describe("manual dispatch", () => {
  const dispatchOn = (ref: string, actorPermission?: ForgePermission) =>
    classifyRun({
      event: "workflow_dispatch",
      ref,
      ...(actorPermission ? { actorPermission } : {}),
    });

  test("only a maintainer's manual run is protected or release", () => {
    expect(dispatchOn("refs/heads/main", "admin")).toBe("protected");
    expect(dispatchOn("refs/heads/main", "maintain")).toBe("protected");
    expect(dispatchOn("refs/tags/v1.0.0", "maintain")).toBe("release");
    // Write access can start a manual run, but it never counts as protected.
    expect(dispatchOn("refs/heads/main", "write")).toBe("trusted_pr");
    expect(dispatchOn("refs/heads/main", "triage")).toBe("untrusted_pr");
    expect(dispatchOn("refs/heads/main", "read")).toBe("untrusted_pr");
    expect(dispatchOn("refs/heads/main", "none")).toBe("untrusted_pr");
    // An unknown actor is not a maintainer.
    expect(dispatchOn("refs/heads/main")).toBe("untrusted_pr");
  });
});

describe("decideRun", () => {
  const base = { workflowHash: "h".repeat(64), now: 1_800_000_000_000 };
  const pr = (over: Parameters<typeof decideRun>[0] extends infer T ? Partial<T> : never) =>
    decideRun({ event: "pull_request", ref: "refs/pull/5/head", ...base, ...over });

  test("a PR is trusted only when the head is in the repo and the author can write", () => {
    expect(pr({ sameRepo: true, permission: "write" }).class).toBe("trusted_pr");
    expect(pr({ sameRepo: true, permission: "maintain" }).class).toBe("trusted_pr");
    expect(pr({ sameRepo: true, permission: "read" }).class).toBe("untrusted_pr");
    expect(pr({ sameRepo: true, permission: "triage" }).class).toBe("untrusted_pr");
    expect(pr({ sameRepo: true, permission: "none" }).class).toBe("untrusted_pr");
    expect(pr({ sameRepo: true, permission: "unknown" }).class).toBe("untrusted_pr");
    expect(pr({ sameRepo: true }).class).toBe("untrusted_pr");
    // A fork is untrusted whatever the author's permission or allowlisting.
    expect(pr({ sameRepo: false, permission: "admin", allowlisted: true }).class).toBe(
      "untrusted_pr",
    );
    expect(pr({}).class).toBe("untrusted_pr");
    // The explicit trusted list works without asking the forge, for a same-repo PR only.
    expect(pr({ sameRepo: true, allowlisted: true }).class).toBe("trusted_pr");
  });

  test("the decision records its facts and reasons, and its JSON leads with the class", () => {
    const d = pr({ sameRepo: true, actor: "dev", permission: "read" });
    expect(d.facts).toMatchObject({ sameRepo: true, actor: "dev", permission: "read" });
    expect(d.reasons.join(" ")).toContain("read permission");
    expect(d.workflowHash).toBe(base.workflowHash);
    // The cap query matches on this prefix.
    expect(JSON.stringify(d).startsWith('{"class":"untrusted_pr"')).toBe(true);
  });

  test("pushes: the project's protected refs and the forge's protection decide", () => {
    const push = (ref: string, over = {}) =>
      decideRun({ event: "push", ref, sameRepo: true, ...base, ...over });
    expect(push("refs/heads/trunk", { protectedRefs: ["refs/heads/trunk"] }).class).toBe(
      "protected",
    );
    expect(push("refs/heads/trunk", { protectedRefs: [] }).class).toBe("trusted_pr");
    expect(push("refs/heads/staging", { protectedRefs: [], forgeProtected: true }).class).toBe(
      "protected",
    );
    expect(push("refs/tags/v1.2.3").class).toBe("release");
  });

  test("only untrusted_pr needs approval", () => {
    expect(needsApproval("untrusted_pr")).toBe(true);
    for (const k of ["protected", "release", "trusted_pr"] as const) {
      expect(needsApproval(k)).toBe(false);
    }
  });
});
