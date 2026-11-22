import { describe, expect, test } from "bun:test";
import {
  jobReadiness,
  planJob,
  planWorkflow,
  resolveActions,
  splitJob,
  staticResolver,
  type NeedStatus,
  type WorkflowEvent,
} from "../src/index";

// Plan-only acceptance target: a real public ci.yml (see the headers of the fixtures for the
// source and pinned sha). It uses push/pull_request/merge_group with branch filters, workflow
// env and concurrency, job if/needs/outputs, continue-on-error, a local composite action with
// actions/setup-node, oven-sh/setup-bun and actions/cache, fromJSON, contains and !cancelled().
const ci = await Bun.file(`${import.meta.dir}/fixtures/squirrelscan-ci.yml`).text();
const setupBun = await Bun.file(`${import.meta.dir}/fixtures/squirrelscan-setup-bun.yml`).text();
const files: Record<string, string> = { ".github/actions/setup-bun/action.yml": setupBun };
const readFile = (p: string): string | undefined => files[p];

const push: WorkflowEvent = { name: "push", ref: "refs/heads/main" };
const pr: WorkflowEvent = {
  name: "pull_request",
  baseRef: "main",
  action: "opened",
  ref: "refs/pull/1/merge",
};
const mergeGroup: WorkflowEvent = { name: "merge_group", baseRef: "main" };
const github = { workflow: "CI" };

const JOBS = [
  "changes",
  "changelog-guard",
  "quality",
  "cli-tests-app",
  "cli-tests-packages",
  "cli-tests",
  "installer-scripts",
  "dependency-audit",
  "engine-tests",
  "release-tooling",
  "docs",
  "build",
  "psl-freshness",
];

const NEEDS: Record<string, string[]> = {
  changes: [],
  "changelog-guard": [],
  quality: ["changes"],
  "cli-tests-app": ["quality"],
  "cli-tests-packages": ["quality"],
  "cli-tests": ["quality", "cli-tests-app", "cli-tests-packages"],
  "installer-scripts": ["changes", "quality"],
  "dependency-audit": ["quality"],
  "engine-tests": ["changes", "quality"],
  "release-tooling": ["changes", "quality"],
  docs: [],
  build: ["changes", "cli-tests", "engine-tests", "release-tooling"],
  "psl-freshness": ["changes"],
};

describe("planning the real ci.yml", () => {
  test.each([
    ["push to main", push, ["changelog-guard"]],
    ["pull_request", pr, []],
    ["merge_group", mergeGroup, ["changelog-guard"]],
  ] as const)(
    "%s: job set, needs edges, nothing unsupported, static skips",
    (_n, event, staticSkips) => {
      const p = planWorkflow(ci, event, { readFile, github });
      expect(p.trigger.matched).toBe(true);
      expect(p.jobs.map((j) => j.id).sort()).toEqual([...JOBS].sort());
      for (const j of p.jobs) expect(j.needsIds).toEqual(NEEDS[j.id] as string[]);
      // Dependency order holds.
      const order = p.jobs.map((j) => j.key);
      for (const j of p.jobs)
        for (const n of j.needs) expect(order.indexOf(n)).toBeLessThan(order.indexOf(j.key));
      expect(p.jobs.filter((j) => j.unsupported).map((j) => [j.id, j.unsupported])).toEqual([]);
      expect(p.jobs.filter((j) => j.staticSkip).map((j) => j.id)).toEqual([...staticSkips]);
      expect(p.warnings).toEqual([]);
    },
  );

  test("workflow metadata and per-job facts", () => {
    const p = planWorkflow(ci, push, { readFile, github });
    expect(p.name).toBe("CI");
    expect(p.env).toEqual({ NO_TELEMETRY: "1" });
    expect(p.concurrency).toEqual({ group: "ci-CI-refs/heads/main", cancelInProgress: true });
    const job = (id: string) => p.jobs.find((j) => j.id === id)!;
    expect(Object.keys(job("changes").outputs)).toEqual([
      "code",
      "engine",
      "installer",
      "release",
      "build",
    ]);
    expect(job("psl-freshness").continueOnError).toBe(true);
    expect(job("changes").name).toBe("Classify changed files");
    expect(job("build").name).toBe("Compile CLI");
    expect(job("quality").ifExpr).toContain("needs.changes.outputs.code");
  });

  test("triggers: a push to another branch does not run", () => {
    expect(
      planWorkflow(ci, { name: "push", ref: "refs/heads/dev" }, { readFile }).trigger.matched,
    ).toBe(false);
    expect(
      planWorkflow(ci, { name: "pull_request", baseRef: "dev", action: "opened" }, { readFile })
        .trigger.matched,
    ).toBe(false);
    expect(planWorkflow(ci, { name: "workflow_dispatch" }, { readFile }).trigger.matched).toBe(
      false,
    );
  });
});

const ok = (outputs: Record<string, string> = {}): NeedStatus => ({ state: "success", outputs });
const CODE = { code: "true", engine: "true", installer: "true", release: "true", build: "true" };

/** Walks the graph with jobReadiness, giving every job the verdict `results[id]` (default success). */
function walk(
  event: WorkflowEvent,
  changes: Record<string, string>,
  results: Record<string, NeedStatus["state"]> = {},
) {
  const p = planWorkflow(ci, event, { readFile, github });
  const status: Record<string, NeedStatus> = {};
  const decisions: Record<string, string> = {};
  for (const j of p.jobs) {
    const needs = Object.fromEntries(j.needs.map((k) => [k, status[k] as NeedStatus]));
    const r = jobReadiness(j, needs, {
      contexts: { github: { event_name: event.name }, vars: {}, inputs: {}, env: {} },
    });
    decisions[j.id] = r.decision;
    if (r.decision === "ready") {
      const state = results[j.id] ?? "success";
      status[j.key] = {
        state,
        ...(j.id === "changes" ? { outputs: changes } : {}),
        continueOnError: j.continueOnError,
      };
    } else {
      status[j.key] = { state: r.decision === "cancel" ? "cancelled" : "skipped" };
    }
  }
  return decisions;
}

describe("scheduling the real ci.yml with jobReadiness", () => {
  test("a code change on a pull request runs everything", () => {
    const d = walk(pr, CODE);
    for (const id of JOBS) expect(d[id]).toBe("ready");
  });

  test("a docs-only change skips the code gates but still runs docs", () => {
    const d = walk(pr, {
      code: "false",
      engine: "false",
      installer: "false",
      release: "false",
      build: "false",
    });
    expect(d.docs).toBe("ready");
    expect(d.changes).toBe("ready");
    for (const id of [
      "quality",
      "cli-tests-app",
      "cli-tests-packages",
      "cli-tests",
      "dependency-audit",
      "installer-scripts",
      "engine-tests",
      "release-tooling",
      "build",
      "psl-freshness",
    ]) {
      expect(d[id]).toBe("skip");
    }
  });

  test("an engine-only change skips engine-tests' siblings but the build still runs", () => {
    const d = walk(push, {
      code: "true",
      engine: "true",
      installer: "false",
      release: "false",
      build: "true",
    });
    expect(d["installer-scripts"]).toBe("skip");
    expect(d["release-tooling"]).toBe("skip");
    expect(d["engine-tests"]).toBe("ready");
    // skipped release-tooling is accepted by the build's contains(fromJSON(['success','skipped']), ...)
    expect(d.build).toBe("ready");
  });

  test("a failing quality job skips the test jobs and the build", () => {
    const d = walk(pr, CODE, { quality: "failure" });
    expect(d["cli-tests-app"]).toBe("skip");
    expect(d["cli-tests"]).toBe("skip");
    expect(d.build).toBe("skip");
  });

  test("a failing continue-on-error job does not fail anything downstream", () => {
    const d = walk(pr, CODE, { "psl-freshness": "failure" });
    expect(d.build).toBe("ready");
  });
});

describe("splitJob and planJob for every supported job", () => {
  const p = planWorkflow(ci, pr, { readFile, github });
  const changesOut = {
    code: "true",
    engine: "true",
    installer: "true",
    release: "true",
    build: "true",
  };

  test.each(JOBS)("%s", async (id) => {
    const node = p.jobs.find((j) => j.id === id)!;
    expect(node.unsupported).toBeUndefined();
    const needs = Object.fromEntries(
      node.needsIds.map((n) => [
        n,
        { result: "success" as const, outputs: n === "changes" ? changesOut : {} },
      ]),
    );
    const yaml = splitJob(ci, node, needs, { event: "pull_request" });
    const plan = planJob(yaml, id, {
      workflowPath: `.turntable/jobs/${id}.yml`,
      event: "pull_request",
      readFile,
      split: true,
    });
    expect(plan.stubIds).toEqual(node.needsIds);
    expect(plan.outputNames).toEqual(Object.keys(node.outputs));
    // Every action, including those nested in the local composite, is sha-pinned or mapped.
    const resolved = await resolveActions(plan, staticResolver({}));
    expect(resolved.actions.every((a) => a.sha)).toBe(true);
    // cli-tests is a pure gate job with no checkout.
    if (id !== "cli-tests") {
      const uses = resolved.actions.map((a) => a.uses.split("@")[0]);
      expect(uses).toContain("actions/checkout");
    }
  });

  test("the composite's nested actions are found", async () => {
    const node = p.jobs.find((j) => j.id === "quality")!;
    const yaml = splitJob(
      ci,
      node,
      { changes: { result: "success", outputs: changesOut } },
      { event: "pull_request" },
    );
    const plan = planJob(yaml, "quality", {
      workflowPath: ".turntable/jobs/q.yml",
      readFile,
      split: true,
    });
    expect(plan.actions.map((a) => a.repo).sort()).toEqual([
      "actions/cache",
      "actions/checkout",
      "actions/setup-node",
      "oven-sh/setup-bun",
    ]);
  });
});
