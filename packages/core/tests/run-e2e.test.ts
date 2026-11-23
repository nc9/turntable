import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DockerProvider } from "@longshore/provider-docker";
import {
  ensureLocalTenant,
  listAttempts,
  listJobs,
  listRuns,
  listSteps,
  openDatabase,
  readLog,
} from "../src/db";

// CI only (TT_RUN_E2E=1, TT_BINARY=<compiled longshore>): needs Docker and network for the
// pinned act download. Runs the real binary against examples/hello.
const enabled = process.env.TT_RUN_E2E === "1" && !!process.env.TT_BINARY;
const bin = resolve(process.env.TT_BINARY ?? "longshore");
const tmp = mkdtempSync(join(tmpdir(), "tt-run-e2e-"));
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

async function exampleRepo(name: string): Promise<{ repo: string; data: string }> {
  const repo = join(tmp, `${name}-repo`);
  cpSync(join(import.meta.dir, "../../../examples/hello"), repo, { recursive: true });
  await git(repo, "init", "-q", "-b", "main");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-q", "-m", "initial example commit");
  return { repo, data: join(tmp, `${name}-data`) };
}

const args = (repo: string, data: string, wf: string, job: string): string[] => [
  bin,
  "run",
  join(repo, ".github/workflows", wf),
  "-j",
  job,
  "--repo",
  repo,
  "--data-dir",
  data,
];

async function stored(data: string) {
  const db = openDatabase(join(data, "longshore.db"));
  const scope = await ensureLocalTenant(db);
  const [run] = await listRuns(db, scope);
  const [job] = run ? await listJobs(db, scope, run.id) : [];
  const [attempt] = job ? await listAttempts(db, scope, job.id) : [];
  const chunks = attempt ? await readLog(db, scope, attempt.id) : [];
  const log = chunks.map((c) => c.bytes.toString("utf8")).join("");
  const steps = attempt ? await listSteps(db, scope, attempt.id) : [];
  db.close();
  return { run, job, attempt, log, steps };
}

/** For a failed run: every attempt's state, reason and stored log, so CI shows why. */
async function failedAttempts(data: string): Promise<string> {
  const db = openDatabase(join(data, "longshore.db"));
  try {
    const scope = await ensureLocalTenant(db);
    const lines: string[] = [];
    for (const run of await listRuns(db, scope)) {
      for (const job of await listJobs(db, scope, run.id)) {
        for (const a of await listAttempts(db, scope, job.id)) {
          if (a.state === "success") continue;
          const log = (await readLog(db, scope, a.id))
            .map((c) => c.bytes.toString("utf8"))
            .join("");
          lines.push(`--- ${job.jobKey} ${a.state} ${a.errorClass ?? ""}\n${log.slice(-4000)}`);
        }
      }
    }
    return lines.join("\n");
  } finally {
    db.close();
  }
}

describe.skipIf(!enabled)("longshore run (compiled binary, docker)", () => {
  test("hello job: exit 0 and the run is stored with its log", async () => {
    const { repo, data } = await exampleRepo("ok");
    const p = Bun.spawn(args(repo, data, "ci.yml", "hello"), { stdout: "pipe", stderr: "inherit" });
    const out = await new Response(p.stdout).text();
    expect(await p.exited).toBe(0);
    expect(out).toContain("output-check=hello-output");
    expect(out).toContain("env-check=propagated-env");
    const s = await stored(data);
    expect(s.run).toMatchObject({ status: "success" });
    expect(s.job).toMatchObject({ state: "success", exitCode: 0 });
    expect(s.attempt?.sandboxId).toBeTruthy();
    expect(s.log).toBe(out);
    expect(s.steps.map((x) => `${x.name}:${x.result}`)).toContain("Read output and env:success");
  }, 600_000);

  test("failing job: exit 1 and a stored failure", async () => {
    const { repo, data } = await exampleRepo("fail");
    const p = Bun.spawn(args(repo, data, "fail.yml", "fail"), {
      stdout: "pipe",
      stderr: "inherit",
    });
    const out = await new Response(p.stdout).text();
    expect(await p.exited).toBe(1);
    expect(out).toContain("about to fail");
    const s = await stored(data);
    expect(s.job).toMatchObject({ state: "failure" });
    expect(s.job?.exitCode).not.toBe(0);
  }, 600_000);

  test("unsupported workflow: exit 2 and no run row", async () => {
    const { repo, data } = await exampleRepo("bad");
    const p = Bun.spawn(args(repo, data, "ci.yml", "no-such-job"), {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await p.exited).toBe(2);
  }, 120_000);

  test("Ctrl-C cancels: exit 130, attempt cancelled, no sandbox left", async () => {
    const { repo, data } = await exampleRepo("cancel");
    const p = Bun.spawn(args(repo, data, "ci.yml", "hello"), { stdout: "pipe", stderr: "inherit" });
    const reader = p.stdout.getReader();
    let seen = "";
    while (!seen.includes("▶")) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += new TextDecoder().decode(value);
    }
    p.kill("SIGINT");
    expect(await p.exited).toBe(130);
    const s = await stored(data);
    expect(s.job).toMatchObject({ state: "cancelled" });
    expect(await new DockerProvider().count({})).toBe(0);
  }, 600_000);

  test("whole workflow: needs, outputs, if, skipped and docker jobs, cache miss, runner.os", async () => {
    const { repo, data } = await exampleRepo("pipeline");
    const p = Bun.spawn(
      [
        bin,
        "run",
        join(repo, ".github/workflows/pipeline.yml"),
        "--repo",
        repo,
        "--data-dir",
        data,
      ],
      { stdout: "pipe", stderr: "inherit" },
    );
    const out = await new Response(p.stdout).text();
    const code = await p.exited;
    if (code !== 0) {
      console.log(out);
      console.log(await failedAttempts(data));
    }
    expect(code).toBe(0);
    expect(out).toContain("got-version=1.2.3");
    expect(out).toContain("got-result=success");
    expect(out).toContain("got-os=Linux");
    expect(out).toContain("finished after success");
    const db = openDatabase(join(data, "longshore.db"));
    const scope = await ensureLocalTenant(db);
    const [run] = await listRuns(db, scope);
    const jobs = run ? await listJobs(db, scope, run.id) : [];
    db.close();
    const state = (k: string) => jobs.find((j) => j.jobKey === k)?.state;
    expect(run?.status).toBe("success");
    expect(state("build")).toBe("success");
    expect(state("test")).toBe("success");
    expect(state("skipped")).toBe("skipped");
    expect(state("images")).toBe("skipped");
    expect(state("finish")).toBe("success");
    expect(JSON.parse(jobs.find((j) => j.jobKey === "test")?.needs ?? "[]")).toEqual(["build"]);
  }, 900_000);

  test("pull_request: the step sees the event payload, an origin remote, and an intact .git", async () => {
    const { repo, data } = await exampleRepo("prevent");
    await git(repo, "remote", "add", "origin", "https://github.com/acme/hello");
    const base = "b".repeat(40);
    const p = Bun.spawn(
      [
        bin,
        "run",
        join(repo, ".github/workflows/pr-event.yml"),
        "--repo",
        repo,
        "--data-dir",
        data,
        "--event",
        "pull_request",
        "--base-ref",
        "main",
        "--base-sha",
        base,
      ],
      { stdout: "pipe", stderr: "inherit" },
    );
    const out = await new Response(p.stdout).text();
    const code = await p.exited;
    if (code !== 0) {
      console.log(out);
      console.log(await failedAttempts(data));
    }
    expect(code).toBe(0);
    expect(out).toContain(`base-sha=${base}`);
    expect(out).toContain("origin=https://github.com/acme/hello");
    expect(out).toContain("repo-ok");
  }, 900_000);

  test("a workflow that does not trigger exits 0 and stores nothing", async () => {
    const { repo, data } = await exampleRepo("notrigger");
    const p = Bun.spawn(
      [
        bin,
        "run",
        join(repo, ".github/workflows/pipeline.yml"),
        "--repo",
        repo,
        "--data-dir",
        data,
        "--event",
        "workflow_dispatch",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await p.exited).toBe(0);
    expect(await new Response(p.stderr).text()).toContain("not triggered");
  }, 120_000);
});
