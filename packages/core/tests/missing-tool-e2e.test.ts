import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planJob, resolveActions, staticResolver, tarDirectory } from "@longshore/act-runner";
import { DockerProvider } from "@longshore/provider-docker";
import { SecretRegistry } from "@longshore/redact";
import { DEFAULT_IMAGE, executeJob } from "../src/run/job-exec";
import type { RunStore } from "../src/run/store";

// CI only (TT_ACT_E2E=1): a real Docker daemon. A step that calls a tool the image lacks fails
// with exit 127, and the log names the tool instead of leaving a bare failure.
const enabled = process.env.TT_ACT_E2E === "1";
const IMAGE = process.env.TT_ACT_IMAGE ?? DEFAULT_IMAGE;
const tmp = mkdtempSync(join(tmpdir(), "tt-missing-tool-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

async function git(dir: string, ...args: string[]): Promise<void> {
  const p = Bun.spawn(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
    cwd: dir,
    stdout: "ignore",
    stderr: "inherit",
  });
  if ((await p.exited) !== 0) throw new Error(`git ${args.join(" ")} failed`);
}

describe.skipIf(!enabled)("a step that needs a tool the image lacks (docker)", () => {
  test("fails as a failure, and the log says which tool is not available", async () => {
    const repo = join(tmp, "repo");
    cpSync(join(import.meta.dir, "../../../examples/hello"), repo, { recursive: true });
    await git(repo, "init", "-q", "-b", "main");
    await git(repo, "add", "-A");
    await git(repo, "commit", "-q", "-m", "initial example commit");
    const repoTarball = await tarDirectory(repo);
    const yaml = readFileSync(join(repo, ".github/workflows/missing-tool.yml"), "utf8");
    const planned = planJob(yaml, "missing", {
      workflowPath: ".github/workflows/missing-tool.yml",
      readFile: (f) =>
        existsSync(join(repo, f)) ? readFileSync(join(repo, f), "utf8") : undefined,
    });
    const plan = await resolveActions(planned, staticResolver({}));
    let logText = "";
    const store = {
      setSandbox: async () => {},
      setExec: async () => {},
      resetOutput: async () => {},
      appendLog: async () => {},
      recordStep: async () => {},
      finishJob: async () => {},
    } as unknown as RunStore;
    const out = await executeJob(
      {
        provider: new DockerProvider(),
        store,
        image: IMAGE,
        repoTarball,
        out: (t) => {
          logText += t;
        },
        registry: new SecretRegistry(),
        timeoutSeconds: 240,
      },
      { runId: "r", jobId: "j", attemptId: "a" },
      plan,
    );
    if (out.state !== "failure") console.log(out, "\n" + logText);
    expect(out.state).toBe("failure");
    expect(logText).toContain("about to call a missing tool");
    expect(logText).toContain("longshore-missing-tool is not available on this image");
  }, 600_000);
});
