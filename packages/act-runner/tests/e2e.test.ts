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
  const p = Bun.spawn(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
    cwd: dir,
    stdout: "ignore",
    stderr: "inherit",
  });
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
});
