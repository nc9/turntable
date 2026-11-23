// The exec wrapper's timeout watcher: it must fire when the command outlives its timeout, and it
// must never outlive a command that finished. The second one used to race: the watcher was a
// subshell with a TERM trap, and a TERM landing between starting its `sleep` and recording the
// sleep's pid left the sleep behind for the whole timeout (seen on a fast `true`, in CI).
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WRAPPER_SH } from "../src/wrapper";

const tmp = mkdtempSync(join(tmpdir(), "ls-wrapper-"));
const runSh = join(tmp, "run.sh");
writeFileSync(runSh, WRAPPER_SH);
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** The shells that can stand in for `sh` in a sandbox, where they exist here. */
const SHELLS = ["sh", "/bin/dash", "/bin/bash"].filter((s) => !s.startsWith("/") || existsSync(s));

let n = 0;
async function runExec(shell: string, command: string, timeoutSeconds: number): Promise<string> {
  const d = join(tmp, `e${n++}`);
  mkdirSync(d);
  writeFileSync(join(d, "out"), "");
  writeFileSync(join(d, "cmd.sh"), `${command}\n`);
  const p = Bun.spawn(
    [shell, runSh, d, String(timeoutSeconds), "1000000", "100", "100", "10", "1", "5"],
    {
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  await p.exited;
  return d;
}

const processes = (): string[] =>
  Bun.spawnSync(["ps", "-A", "-o", "command="])
    .stdout.toString()
    .split("\n")
    .map((l) => l.trim());

describe.each(SHELLS)("the timeout watcher under %s", (shell) => {
  test("a command past its timeout is stopped, marked timedout, and the exec ends", async () => {
    const t0 = Date.now();
    const d = await runExec(shell, "exec sleep 31343", 1);
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(existsSync(join(d, "timedout"))).toBe(true);
    const [code] = readFileSync(join(d, "exit"), "utf8").trim().split(" ");
    expect(code).not.toBe("0");
    expect(processes()).not.toContain("sleep 31343");
  }, 30_000);

  test("a timed-out script that runs a child WITHOUT exec leaves nothing behind (the whole group is stopped)", async () => {
    const t0 = Date.now();
    // `cmd.sh` is a shell that starts two sleeps and waits: the shell and both children must go.
    const d = await runExec(shell, "sleep 31344 & sleep 31344", 1);
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(existsSync(join(d, "timedout"))).toBe(true);
    // A child that is not in the signalled group would live on for its full 31344 seconds.
    const left = processes().filter((l) => l === "sleep 31344");
    for (const l of left) Bun.spawnSync(["pkill", "-x", "-f", l]); // do not leak from a failing test
    expect(left).toEqual([]);
  }, 30_000);

  test("a command that finishes first leaves no watcher behind, however fast it finishes", async () => {
    const base = 1_000_000 + Math.floor(Math.random() * 8_000_000);
    const N = 150;
    for (let i = 0; i < N; i += 1) {
      const d = await runExec(shell, "true", base + i);
      expect(existsSync(join(d, "timedout"))).toBe(false);
    }
    // Give a process that was just signalled a moment to be reaped.
    await Bun.sleep(300);
    const left = processes().filter(
      (l) => /^sleep \d+$/.test(l) && Number(l.slice(6)) >= base && Number(l.slice(6)) < base + N,
    );
    for (const l of left) Bun.spawnSync(["pkill", "-x", "-f", l]); // do not leak from a failing test
    expect(left).toEqual([]);
  }, 60_000);
});
