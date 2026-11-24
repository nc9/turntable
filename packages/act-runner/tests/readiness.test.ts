import { describe, expect, test } from "bun:test";
import { jobReadiness, type NeedStatus } from "../src/readiness";
import { planWorkflow } from "../src/workflow-plan";

const wf = `on: push
jobs:
  a:
    runs-on: ubuntu-latest
    steps: []
  m:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        n: [1, 2]
    outputs:
      x: \${{ steps.s.outputs.x }}
    steps: []
  plain:
    needs: a
    runs-on: ubuntu-latest
    steps: []
  gate:
    needs: [a, m]
    if: \${{ !cancelled() && needs.m.outputs.x == 'go' }}
    runs-on: ubuntu-latest
    steps: []
  cleanup:
    needs: a
    if: \${{ always() }}
    runs-on: ubuntu-latest
    steps: []
  onfail:
    needs: a
    if: \${{ failure() }}
    runs-on: ubuntu-latest
    steps: []
  dock:
    runs-on: ubuntu-latest
    steps:
      - run: docker ps
  never:
    if: \${{ false }}
    runs-on: ubuntu-latest
    steps: []
`;
const plan = planWorkflow(
  wf,
  { name: "push", ref: "refs/heads/main" },
  { readFile: () => undefined },
);
const job = (id: string) => plan.jobs.find((j) => j.id === id)!;
const ok = (outputs: Record<string, string> = {}): NeedStatus => ({ state: "success", outputs });
const st = (state: NeedStatus["state"], extra: Partial<NeedStatus> = {}): NeedStatus => ({
  state,
  ...extra,
});

describe("jobReadiness", () => {
  test("waits until every need is terminal", () => {
    expect(jobReadiness(job("plain"), { a: st("running") }).decision).toBe("wait");
    expect(jobReadiness(job("plain"), { a: st("queued") }).decision).toBe("wait");
    expect(jobReadiness(job("plain"), {}).decision).toBe("wait");
  });

  test("default if is success(): ready after success, skipped after anything else", () => {
    expect(jobReadiness(job("plain"), { a: ok() }).decision).toBe("ready");
    for (const s of ["failure", "infra_error", "cancelled", "skipped"] as const) {
      expect(jobReadiness(job("plain"), { a: st(s) })).toMatchObject({ decision: "skip" });
    }
  });

  test("continue-on-error: a failed need counts as success", () => {
    expect(
      jobReadiness(job("plain"), { a: st("failure", { continueOnError: true }) }).decision,
    ).toBe("ready");
  });

  test("always() and failure() see the needs results", () => {
    expect(jobReadiness(job("cleanup"), { a: st("failure") }).decision).toBe("ready");
    expect(jobReadiness(job("onfail"), { a: st("failure") }).decision).toBe("ready");
    expect(jobReadiness(job("onfail"), { a: ok() })).toMatchObject({ decision: "skip" });
  });

  test("outputs of every leg of a matrix need are injected", () => {
    const needs = { a: ok(), "m[0]": ok({ x: "" }), "m[1]": ok({ x: "go" }) };
    expect(jobReadiness(job("gate"), needs).decision).toBe("ready");
    expect(jobReadiness(job("gate"), { ...needs, "m[1]": ok({ x: "stop" }) })).toMatchObject({
      decision: "skip",
    });
  });

  test("a cancelled run cancels queued jobs; unsupported and static skips skip", () => {
    expect(jobReadiness(job("plain"), { a: ok() }, { cancelled: true })).toMatchObject({
      decision: "cancel",
    });
    // an unsupported job is ready: the runner fails it with the reason, it is never skipped
    expect(jobReadiness(job("dock"), {})).toMatchObject({ decision: "ready" });
    expect(jobReadiness(job("never"), {})).toMatchObject({ decision: "skip" });
  });
});
