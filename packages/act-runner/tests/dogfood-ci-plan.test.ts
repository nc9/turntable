// Our own .github/workflows/ci.yml, planned the way Turntable plans it. GitHub has no
// `vars.TURNTABLE_CI`, so there every job runs exactly as before; the Turntable project sets it to
// 'true', which turns off the jobs that need a docker daemon or service containers and turns on
// the PGlite stand-in for the Postgres job. This test pins both readings.
import { describe, expect, test } from "bun:test";
import { jobReadiness, planWorkflow, type WorkflowEvent } from "../src/index";

const ci = await Bun.file(`${import.meta.dir}/../../../.github/workflows/ci.yml`).text();
const push: WorkflowEvent = { name: "push", ref: "refs/heads/main" };
const pr: WorkflowEvent = {
  name: "pull_request",
  baseRef: "main",
  action: "opened",
  ref: "refs/pull/1/merge",
};

/** Every job's decision with `vars` as given and the event as `event` (no needs: all ready to be asked). */
function decisions(event: WorkflowEvent, vars: Record<string, string>): Record<string, string> {
  const wp = planWorkflow(ci, event, {
    readFile: () => undefined,
    vars,
    github: { workflow: "ci", event_name: event.name },
  });
  const out: Record<string, string> = {};
  for (const j of wp.jobs) {
    const r = jobReadiness(j, Object.fromEntries(j.needs.map((k) => [k, { state: "success" }])), {
      contexts: {
        github: { event_name: event.name },
        vars,
        inputs: {},
        env: {},
        secrets: {},
      },
    });
    out[j.key] = r.decision === "skip" ? `skip: ${r.reason}` : r.decision;
  }
  return out;
}

const GATED = ["postgres", "provider-docker", "act-runner-e2e", "runner-image", "docker"];
const EVERYWHERE = ["check", "release-golden"];

describe("our ci.yml with TURNTABLE_CI unset (as on GitHub)", () => {
  test.each([
    ["push", push],
    ["pull_request", pr],
  ])(
    "on %s every job that ran before still runs, and the Turntable-only job does not",
    (_n, ev) => {
      const d = decisions(ev, {});
      for (const k of EVERYWHERE) expect(d[k], k).toBe("ready");
      // The gate never skips them. (Turntable's planner itself skips the ones that use docker or
      // services as "unsupported", with or without the var; that is not the `if:`.)
      for (const k of GATED) expect(d[k], k).not.toMatch(/^skip: if:/);
      for (const k of ["provider-docker", "act-runner-e2e"]) expect(d[k], k).toBe("ready");
      expect(d["postgres-pglite"]).toMatch(/^skip: if:/);
    },
  );
  test("dep-age still runs on pull requests only", () => {
    expect(decisions(pr, {})["dep-age"]).toBe("ready");
    expect(decisions(push, {})["dep-age"]).toMatch(/^skip: if:/);
  });
});

describe("our ci.yml with TURNTABLE_CI=true (Turntable's own project)", () => {
  test("the docker and service jobs are skipped, the PGlite job and the plain jobs run", () => {
    const d = decisions(pr, { TURNTABLE_CI: "true" });
    for (const k of GATED) expect(d[k], k).toMatch(/^skip/);
    for (const k of ["provider-docker", "act-runner-e2e"]) expect(d[k], k).toMatch(/^skip: if:/);
    expect(d["postgres-pglite"]).toBe("ready");
    for (const k of [...EVERYWHERE, "dep-age"]) expect(d[k], k).toBe("ready");
  });
});
