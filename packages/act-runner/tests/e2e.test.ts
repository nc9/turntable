import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DockerProvider } from "@turntable/provider-docker";
import {
  drain,
  planJob,
  resolveActions,
  runJob,
  staticResolver,
  tarDirectory,
  type RunEvent,
} from "../src/index";

// CI only (TT_ACT_E2E=1): needs a Docker daemon, network for the pinned act download, and an
// image with bash, git and node (host mode runs steps on the sandbox itself). The pinned image
// is node:22-bookworm, which has all three. ubuntu:24.04 has none of them and would need an
// apt-get step with open egress, so we pick the image instead.
const IMAGE = process.env.TT_ACT_IMAGE ?? "node:22-bookworm";
const enabled = process.env.TT_ACT_E2E === "1";
const tmp = mkdtempSync(join(tmpdir(), "tt-act-e2e-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

async function git(dir: string, ...args: string[]): Promise<void> {
  const p = Bun.spawn(
    [
      "git",
      "-c",
      "gc.auto=0",
      "-c",
      "maintenance.auto=false",
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.com",
      ...args,
    ],
    {
      cwd: dir,
      stdout: "ignore",
      stderr: "inherit",
    },
  );
  if ((await p.exited) !== 0) throw new Error(`git ${args.join(" ")} failed`);
}

async function runExample(workflow: string, jobId: string, egress: "open" | "none" = "none") {
  const repo = join(tmp, `${jobId}-${egress}-repo`);
  cpSync(join(import.meta.dir, "../../../examples/hello"), repo, { recursive: true });
  await git(repo, "init", "-q", "-b", "main");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-q", "-m", "initial example commit");
  const repoTarball = await tarDirectory(repo);
  const yaml = await Bun.file(join(repo, ".github/workflows", workflow)).text();
  const planned = planJob(yaml, jobId, {
    workflowPath: `.github/workflows/${workflow}`,
    readFile: (f) => (existsSync(join(repo, f)) ? readFileSync(join(repo, f), "utf8") : undefined),
  });
  // Everything in the example is already sha-pinned, so the resolver is never consulted.
  const plan = await resolveActions(planned, staticResolver({}));

  const provider = new DockerProvider();
  const { id } = await provider.create({
    name: `tt-act-e2e-${jobId}-${egress}-${Date.now()}`,
    labels: { tt_act_e2e: jobId },
    image: IMAGE,
    ttlSeconds: 1800,
    network: { egress },
  });
  try {
    const events: RunEvent[] = [];
    const result = await drain(
      runJob(provider, id, plan, { repoTarball }, { timeoutSeconds: 240 }),
      (e) => {
        events.push(e);
        // Live progress so a hang is diagnosable from the CI log.
        if (e.kind === "phase") console.log(`[${jobId}] phase ${e.phase}`);
        if (e.kind === "act" && e.event.type === "step-end") {
          console.log(`[${jobId}] step ${e.event.name}: ${e.event.result}`);
        }
      },
    );
    const log = events
      .filter((e) => e.kind === "log")
      .map((e) => new TextDecoder().decode(e.bytes))
      .join("");
    const act = events.flatMap((e) => (e.kind === "act" ? [e.event] : []));
    return { result, log, act };
  } finally {
    await provider.destroy(id);
  }
}

describe.skipIf(!enabled)("act runner end to end (docker provider)", () => {
  test("hello job succeeds: step events, output, env propagation, composite, summary", async () => {
    const { result, log, act } = await runExample("ci.yml", "hello");
    if (result.state !== "success") console.log(JSON.stringify(result), "\n" + log);
    expect(result).toMatchObject({ state: "success", exitCode: 0 });
    const names = act.filter((e) => e.type === "step-end").map((e) => `${e.name}:${e.result}`);
    expect(names).toContain("Set up job:success");
    expect(names.some((n) => n.startsWith("actions/checkout@") && n.endsWith(":success"))).toBe(
      true,
    );
    expect(names).toContain("Read output and env:success");
    expect(names).toContain("Write a summary:success");
    expect(act.at(-1)).toMatchObject({ type: "job-end", result: "success" });
    expect(log).toContain("output-check=hello-output");
    expect(log).toContain("env-check=propagated-env");
    expect(log).toContain("composite-check=hello turntable");
    expect(log).toContain("initial example commit");
  }, 600_000);

  // The checkout stub works from the delivered repository: ref, path and fetch-depth are honoured,
  // and a ref that was not delivered fails the step instead of reaching for the network.
  test("checkout honours ref, path and fetch-depth, and refuses an undelivered ref", async () => {
    const { result, log } = await runExample("checkout.yml", "checkout");
    if (result.state !== "success") console.log(JSON.stringify(result), "\n" + log);
    expect(result.state).toBe("success");
    expect(log).toContain("branch=main");
    expect(log).toContain("count=1");
    expect(log).toContain("missing-outcome=failure");
    expect(log).toContain("is not in the delivered repository");
  }, 600_000);

  test("failing job is a failure, not infra_error", async () => {
    const { result, log } = await runExample("fail.yml", "fail");
    if (result.state !== "failure") console.log(result, log);
    expect(result.state).toBe("failure");
    expect(result.exitCode).not.toBe(0);
    expect(log).toContain("about to fail");
  }, 600_000);

  // act is fetched controller-side and the checkout stub copies a local dir, so the job itself
  // should not need the network. This variant proves it (it matters for locked-down sandboxes).
  test("hello job also succeeds with egress open", async () => {
    const { result, log } = await runExample("ci.yml", "hello", "open");
    if (result.state !== "success") console.log(JSON.stringify(result), "\n" + log);
    expect(result).toMatchObject({ state: "success", exitCode: 0 });
    expect(log).toContain("output-check=hello-output");
  }, 600_000);

  // Parity with a GitHub hosted runner (README, assumptions P1 to P4). act gives every host-mode
  // command a pty, so without the step shims a program that checks isatty or isTTY (colour,
  // tables, escape handling) behaves differently here than it does on GitHub.
  test("steps see no terminal, CI=true, GITHUB_ACTIONS=true, TERM unset and a UTF-8 locale", async () => {
    const { result, log } = await runExample("parity.yml", "parity");
    if (result.state !== "success") console.log(JSON.stringify(result), "\n" + log);
    expect(result).toMatchObject({ state: "success", exitCode: 0 });
    expect(log).toContain("stdin-check=notty");
    expect(log).toContain("stdout-check=notty");
    expect(log).toContain("stderr-check=notty");
    expect(log).not.toMatch(/(stdin|stdout|stderr|sh)-check=tty/);
    expect(log).toContain("node-stdout-istty=false");
    expect(log).toContain("node-stderr-istty=false");
    expect(log).toContain("sh-check=notty");
    expect(log).toContain("ci=true");
    expect(log).toContain("github-actions=true");
    // TERM is not set (bash reports `dumb` for an unset TERM, as on a hosted runner): never xterm.
    expect(log).toMatch(/term=(unset|dumb)/);
    expect(log).not.toMatch(/term=xterm/);
    expect(log).toContain("lang=C.UTF-8");
    expect(log).toContain("lc-all=C.UTF-8");
    expect(log).toContain("pager=cat");
  }, 600_000);

  // act kills a timed-out step by SIGKILL of the direct child, which is the step shim. The shim's
  // watcher must then take the interpreter and its children down (README P1).
  test("a step past timeout-minutes ends on time, the job fails, and nothing is left running", async () => {
    const started = Date.now();
    const { result, log, act } = await runExample("timeout.yml", "timeout");
    const took = Date.now() - started;
    expect(result.state).toBe("failure");
    // act's own reason for the failed step (v0.2.97): the shim was killed by the step timeout.
    expect(log).toContain("this step has been cancelled: signal: killed");
    expect(log).toContain("hang-started");
    expect(log).not.toContain("hang-not-reached");
    // One minute of timeout plus setup and the cleanup step, nowhere near the 600 s sleep.
    expect(took).toBeLessThan(200_000);
    const ends = act.flatMap((e) => (e.type === "step-end" ? [`${e.name}:${e.result}`] : []));
    expect(ends).toContain("Hang past the step timeout:failure");
    // The `if: always()` step ran and found no `sleep 600` left in the sandbox.
    expect(log).toContain("left=0");
    expect(ends).toContain("Nothing is left running:success");
  }, 400_000);
});
