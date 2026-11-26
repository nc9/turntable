import { describe, expect, test } from "bun:test";
import { decide } from "../src/run-job";

const sum = (over: Record<string, unknown>) =>
  ({ started: true, finished: true, result: "failure", failedSteps: ["Test"], ...over }) as never;

describe("decide: out of memory", () => {
  test("exit 137 with a failed job is named", () => {
    const r = decide({ state: "exited", exitCode: 137 } as never, sum({}));
    expect(r.state).toBe("failure");
    expect(r.exitCode).toBe(137);
    expect(r.reason).toContain("killed: out of memory");
  });
  test("exit 137 without a job result is named, not infra_error", () => {
    const r = decide({ state: "exited", exitCode: 137 } as never, sum({ finished: false }));
    expect(r.state).toBe("failure");
    expect(r.reason).toContain("out of memory");
  });
  test("exit 1 stays a plain failure", () => {
    expect(decide({ state: "exited", exitCode: 1 } as never, sum({})).reason).toBe(
      "job failed: Test",
    );
  });
});
