import { describe, expect, test } from "bun:test";
import {
  InfraError,
  SandboxNotFoundError,
  SpecError,
  TransientError,
  createWrappedExec,
  retryTransient,
  type ShellRunner,
} from "../src/index";
import { KILL_SH, LAUNCH_SH, LOGS_SH, STATUS_SH } from "../src/wrapper";

/** A clock the tests move by sleeping. */
function clock() {
  let t = 1_000_000;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
    advance: (ms: number) => (t += ms),
  };
}

describe("retryTransient", () => {
  test("transient failures are retried until the call works", async () => {
    const c = clock();
    const logs: string[] = [];
    let calls = 0;
    const r = await retryTransient(
      "status",
      async () => {
        calls += 1;
        if (calls < 4) throw new TransientError("timeout");
        return "ok";
      },
      { ...c, random: () => 0.5, log: (m) => logs.push(m) },
    );
    expect(r).toBe("ok");
    expect(calls).toBe(4);
    expect(logs.length).toBe(3);
    expect(logs[0]).toContain("status: attempt 1");
    // exponential with jitter: 0.75 * 500, 0.75 * 1000, 0.75 * 2000
    expect(c.sleeps).toEqual([375, 750, 1500]);
  });

  test("a call that never recovers becomes an InfraError with the attempts and the last error", async () => {
    const c = clock();
    let calls = 0;
    const err = await retryTransient(
      "exec status",
      async () => {
        calls += 1;
        throw new TransientError(`timeout #${calls}`);
      },
      { ...c, budgetMs: 60_000, random: () => 1 },
    ).catch((e) => e);
    expect(err).toBeInstanceOf(InfraError);
    expect(err).not.toBeInstanceOf(TransientError);
    expect(err.message).toMatch(
      /exec status: still failing after \d+ attempts over \d+s; last error: timeout #\d+/,
    );
    expect(calls).toBeGreaterThan(3);
    expect(c.sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(60_000);
  });

  test("anything not transient passes straight through, once", async () => {
    for (const e of [
      new SandboxNotFoundError("gone"),
      new SpecError("bad"),
      new InfraError("auth"),
      new Error("x"),
    ]) {
      let calls = 0;
      await expect(
        retryTransient(
          "x",
          async () => {
            calls += 1;
            throw e;
          },
          clock(),
        ),
      ).rejects.toBe(e);
      expect(calls).toBe(1);
    }
  });

  test("a zero budget does not retry", async () => {
    let calls = 0;
    await expect(
      retryTransient(
        "x",
        async () => {
          calls += 1;
          throw new TransientError("t");
        },
        { ...clock(), budgetMs: 0 },
      ),
    ).rejects.toBeInstanceOf(InfraError);
    expect(calls).toBe(1);
  });
});

/**
 * A sandbox that remembers which exec dirs were launched, and a runner that can fail transiently
 * on chosen helper scripts, before or after the sandbox acted on them.
 */
function fakeSandbox() {
  const launched: string[] = [];
  const faults = {
    launch: [] as ("before" | "after")[],
    status: 0,
    logs: 0,
    kill: 0,
  };
  const runner: ShellRunner = {
    async run(_id, argv) {
      const script = argv[2];
      const args = argv.slice(4);
      const ok = (out: string) => ({
        exitCode: 0,
        stdout: new TextEncoder().encode(out),
        stderr: new Uint8Array(),
      });
      if (script === LAUNCH_SH) {
        const fault = faults.launch.shift();
        if (fault === "before") throw new TransientError("timeout before the sandbox saw it");
        launched.push(args[0]!);
        if (fault === "after") throw new TransientError("timeout after the sandbox started it");
        return ok("");
      }
      if (script === STATUS_SH) {
        if (faults.status-- > 0) throw new TransientError("status timeout");
        return ok(launched.includes(args[0]!) ? "running 0 0 0 -\n" : "lost 0 0 0 -\n");
      }
      if (script === LOGS_SH) {
        if (faults.logs-- > 0) throw new TransientError("logs timeout");
        return ok("R 0 0 0\n");
      }
      if (script === KILL_SH) {
        if (faults.kill-- > 0) throw new TransientError("kill timeout");
        return ok("");
      }
      throw new Error("unexpected script");
    },
  };
  return { runner, launched, faults };
}

const START = { argv: ["true"], timeoutSeconds: 60 };

describe("wrapped exec under a flaky control plane", () => {
  const mk = (runner: ShellRunner, budgetMs = 180_000) => {
    const c = clock();
    const exec = createWrappedExec(runner, {
      retry: { ...c, budgetMs, random: () => 0.5 },
      launchSettleMs: 5000,
    });
    return { exec, c };
  };

  test("status, logs and kill ride out transient failures", async () => {
    const f = fakeSandbox();
    const { exec } = mk(f.runner);
    const { execId } = await exec.start("sb", START);
    f.faults.status = 3;
    expect((await exec.status("sb", execId)).state).toBe("running");
    f.faults.logs = 2;
    expect((await exec.logs("sb", execId, { fromOffset: 0, maxBytes: 100 })).nextOffset).toBe(0);
    f.faults.kill = 2;
    await exec.kill("sb", execId, "TERM");
    expect(f.faults.status).toBeLessThan(0);
  });

  test("status that stays broken ends as an InfraError naming the attempts, only after the budget", async () => {
    const f = fakeSandbox();
    const { exec, c } = mk(f.runner, 30_000);
    const { execId } = await exec.start("sb", START);
    f.faults.status = 10_000;
    const err = await exec.status("sb", execId).catch((e) => e);
    expect(err).toBeInstanceOf(InfraError);
    expect(err.message).toMatch(/exec status: still failing after \d+ attempts/);
    expect(c.sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(30_000);
  });

  test("a launch that timed out but actually started is NOT launched again", async () => {
    const f = fakeSandbox();
    f.faults.launch = ["after"];
    const { exec } = mk(f.runner);
    const { execId } = await exec.start("sb", START);
    expect(f.launched).toHaveLength(1);
    expect(f.launched[0]!.endsWith(execId)).toBe(true);
  });

  test("a launch that never reached the sandbox is launched again, under a new id", async () => {
    const f = fakeSandbox();
    f.faults.launch = ["before", "before"];
    const { exec } = mk(f.runner);
    const { execId } = await exec.start("sb", START);
    expect(f.launched).toHaveLength(1);
    expect(f.launched[0]!.endsWith(execId)).toBe(true);
  });

  test("the launch check itself rides out transient failures", async () => {
    const f = fakeSandbox();
    f.faults.launch = ["after"];
    f.faults.status = 3;
    const { exec } = mk(f.runner);
    await exec.start("sb", START);
    expect(f.launched).toHaveLength(1);
  });

  test("a launch that keeps failing without starting gives up inside the budget, with the last error", async () => {
    const f = fakeSandbox();
    f.faults.launch = Array.from({ length: 1000 }, () => "before" as const);
    const { exec, c } = mk(f.runner, 30_000);
    const err = await exec.start("sb", START).catch((e) => e);
    expect(err).toBeInstanceOf(InfraError);
    expect(err.message).toContain("exec launch");
    expect(f.launched).toHaveLength(0);
    expect(c.sleeps.length).toBeGreaterThan(0);
  });

  test("a launch that fails for a real reason is not retried", async () => {
    const calls: string[] = [];
    const runner: ShellRunner = {
      async run(_id, argv) {
        calls.push(argv[2] === LAUNCH_SH ? "launch" : "other");
        throw new SpecError("bad argv");
      },
    };
    const { exec } = mk(runner);
    await expect(exec.start("sb", START)).rejects.toBeInstanceOf(SpecError);
    expect(calls).toEqual(["launch"]);
  });
});
