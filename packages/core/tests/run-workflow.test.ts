import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex, staticResolver, tarDirectory } from "@longshore/act-runner";
import { FakeWorld } from "@longshore/provider-sdk/testing";
import {
  ensureLocalTenant,
  listAttempts,
  listJobs,
  listRuns,
  openDatabase,
  readLog,
} from "../src/db";
import { runWorkflowLocal } from "../src/run/run-workflow";
import { dbRunStore } from "../src/run/store";

const tmp = mkdtempSync(join(tmpdir(), "tt-wf-test-"));
const world = new FakeWorld({ hostPaths: [tmp], exec: { tickSeconds: 1 } });
afterAll(() => {
  world.dispose();
  rmSync(tmp, { recursive: true, force: true });
});

/**
 * A stand-in for act. It reads `-j <job>` and `-W <workflow>`, keeps a copy of the generated
 * workflow, prints act-style JSON events (for the job and for a stub need, which runJob must
 * ignore), writes declared outputs, and exits per job id.
 */
const FAKE_ACT = String.raw`#!/bin/sh
J=""; W=""
while [ $# -gt 0 ]; do
  case "$1" in -j) J=$2; shift;; -W) W=$2; shift;; esac
  shift
done
R=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$R/seen" "$R/outputs"
cp "$W" "$R/seen/$J.yml"
ev() { printf '{"jobID":"%s","level":"info","msg":"%s","step":"%s","stepid":["--setup-job"],"time":"t"%s}\n' "$1" "$2" "$3" "$4"; }
ev stubjob "stub" "Set up job" ',"stepResult":"success"'
ev "$J" "Run" "Set up job" ""
ev "$J" "ok" "Set up job" ',"stepResult":"success"'
case "$J" in
  build) printf '%s' '1.2.3' > "$R/outputs/version" ;;
esac
case "$J" in
  fail|mfail|flaky)
    printf '{"jobID":"%s","level":"info","msg":"boom\\n","raw_output":true,"stage":"Main","step":"x","stepID":["0"],"time":"t"}\n' "$J"
    printf '{"jobID":"%s","jobResult":"failure","msg":"failed","time":"t"}\n' "$J"
    exit 1 ;;
esac
printf '{"jobID":"%s","jobResult":"success","msg":"ok","time":"t"}\n' "$J"
exit 0
`;

async function actTarball() {
  const d = mkdtempSync(join(tmp, "a-"));
  writeFileSync(join(d, "act"), FAKE_ACT, { mode: 0o755 });
  const bytes = await tarDirectory(d, ["act"]);
  return { bytes, sha256: sha256Hex(bytes) };
}

async function repoTarball() {
  const d = mkdtempSync(join(tmp, "r-"));
  writeFileSync(join(d, "README.md"), "hi\n");
  return tarDirectory(d, ["README.md"]);
}

const PIPELINE = `name: pipeline
on:
  push:
    branches: [main]
jobs:
  build:
    runs-on: ubuntu-latest
    outputs:
      version: \${{ steps.v.outputs.version }}
    steps:
      - id: v
        run: echo "version=1.2.3" >> "$GITHUB_OUTPUT"
  test:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - run: echo \${{ needs.build.outputs.version }}
  skipme:
    needs: build
    if: \${{ needs.build.outputs.version == 'nope' }}
    runs-on: ubuntu-latest
    steps:
      - run: echo never
  images:
    runs-on: ubuntu-latest
    steps:
      - run: docker build .
  fail:
    runs-on: ubuntu-latest
    steps:
      - run: exit 1
  after-fail:
    needs: fail
    runs-on: ubuntu-latest
    steps:
      - run: echo never
  cleanup:
    needs: fail
    if: \${{ always() }}
    runs-on: ubuntu-latest
    steps:
      - run: echo cleanup
`;

async function go(
  yaml: string,
  extra: Partial<Parameters<typeof runWorkflowLocal>[0]> = {},
  event: Parameters<typeof runWorkflowLocal>[0]["event"] = { name: "push", ref: "refs/heads/main" },
) {
  const db = openDatabase(":memory:");
  const scope = await ensureLocalTenant(db);
  const root = join(mkdtempSync(join(tmp, "root-")), "tt");
  const out: string[] = [];
  const result = await runWorkflowLocal({
    provider: world.provider(),
    providerName: "fake",
    store: dbRunStore(db, scope),
    workflowPath: ".github/workflows/ci.yml",
    workflowYaml: yaml,
    event,
    sha: "a".repeat(40),
    repoTarball: await repoTarball(),
    image: "unused",
    out: (t) => out.push(t),
    readFile: () => undefined,
    resolver: staticResolver({}),
    planRoot: root,
    act: await actTarball(),
    pollMs: 30,
    maxParallel: 1,
    ...extra,
  });
  const seen = (id: string): string => readFileSync(join(root, "seen", `${id}.yml`), "utf8");
  return { db, scope, root, result, out: out.join(""), seen };
}

describe("runWorkflowLocal", () => {
  test("graph: outputs flow into stub needs, skips, docker, failure and always()", async () => {
    const { db, scope, result, out, seen } = await go(PIPELINE);
    const by = Object.fromEntries(result.jobs.map((j) => [j.key, j]));
    expect(by.build).toMatchObject({ state: "success", outputs: { version: "1.2.3" } });
    expect(by.test?.state).toBe("success");
    expect(by.skipme).toMatchObject({ state: "skipped" });
    expect(by.skipme?.reason).toContain("is false");
    expect(by.images?.state).toBe("skipped");
    expect(by.images?.reason).toContain("unsupported");
    expect(by.images?.reason).toContain("docker");
    expect(by.fail?.state).toBe("failure");
    expect(by["after-fail"]?.state).toBe("skipped");
    expect(by.cleanup?.state).toBe("success");
    expect(result).toMatchObject({ triggered: true, state: "failure", exitCode: 1 });

    // The dependent job ran from a workflow whose stub carries the real output as a literal.
    expect(seen("test")).toContain("${{ '1.2.3' }}");
    // The stub need that failed fails, so cleanup's needs.fail.result is really failure.
    expect(seen("cleanup")).toContain("exit 1");

    // Stored: needs, states, and the reason of skipped jobs as their log.
    const [run] = await listRuns(db, scope);
    expect(run?.status).toBe("failure");
    const jobs = await listJobs(db, scope, result.runId as string);
    const row = (k: string) => jobs.find((j) => j.jobKey === k);
    expect(JSON.parse(row("test")?.needs ?? "[]")).toEqual(["build"]);
    expect(row("skipme")?.state).toBe("skipped");
    expect(row("images")?.state).toBe("skipped");
    expect(row("fail")).toMatchObject({ state: "failure" });
    const [att] = await listAttempts(db, scope, row("images")?.id as string);
    const log = await readLog(db, scope, att?.id as string);
    expect(Buffer.concat(log.map((c) => c.bytes)).toString()).toContain("unsupported");
    expect(out).toContain("[test] ");
    expect(out).not.toContain("stub"); // events of stub need jobs are not shown
  });

  test("a workflow that does not trigger runs nothing", async () => {
    const { db, scope, result } = await go(PIPELINE, {}, { name: "push", ref: "refs/heads/dev" });
    expect(result).toMatchObject({ triggered: false, jobs: [] });
    expect(result.triggerReason).toContain("branch dev");
    expect(await listRuns(db, scope)).toHaveLength(0);
  });

  test("path filters use the changed files", async () => {
    const wf =
      "on:\n  push:\n    paths: ['src/**']\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo\n";
    const ev = (files: string[]) => ({ name: "push", ref: "refs/heads/main", changedFiles: files });
    expect((await go(wf, {}, ev(["README.md"]))).result.triggered).toBe(false);
    expect((await go(wf, {}, ev(["src/a.ts"]))).result.triggered).toBe(true);
  });

  test("matrix legs are separate jobs; fail-fast cancels queued legs, fail-fast false does not", async () => {
    const mk = (ff: boolean) => `on: push
jobs:
  mfail:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: ${ff}
      matrix:
        n: [1, 2, 3]
    steps:
      - run: exit 1
`;
    const a = await go(mk(true));
    expect(a.result.jobs.map((j) => [j.key, j.state])).toEqual([
      ["mfail[0]", "failure"],
      ["mfail[1]", "cancelled"],
      ["mfail[2]", "cancelled"],
    ]);
    const b = await go(mk(false));
    expect(b.result.jobs.map((j) => j.state)).toEqual(["failure", "failure", "failure"]);
    const jobs = await listJobs(b.db, b.scope, b.result.runId as string);
    expect(jobs.map((j) => JSON.parse(j.matrix ?? "null"))).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    // each leg's generated workflow has just its own literal leg
    expect(existsSync(join(b.root, "repo/.longshore/jobs/mfail_2_.yml"))).toBe(true);
  });

  test("continue-on-error: a failed job still counts as success for dependents and the run", async () => {
    const wf = `on: push
jobs:
  flaky:
    continue-on-error: true
    runs-on: ubuntu-latest
    steps:
      - run: exit 1
  after:
    needs: flaky
    runs-on: ubuntu-latest
    steps:
      - run: echo
`;
    const { db, scope, result } = await go(wf);
    expect(result.jobs.map((j) => j.state)).toEqual(["failure", "success"]);
    expect(result).toMatchObject({ state: "success", exitCode: 0 });
    const [run] = await listRuns(db, scope);
    expect(run?.status).toBe("success");
  });

  test("a cancelled run cancels queued jobs and exits 130", async () => {
    const ac = new AbortController();
    ac.abort();
    const { result } = await go(PIPELINE, { signal: ac.signal });
    expect(result.state).toBe("cancelled");
    expect(result.exitCode).toBe(130);
    expect(result.jobs.every((j) => j.state === "cancelled" || j.state === "skipped")).toBe(true);
  });

  test("launch metadata records egress", async () => {
    const { db, scope } = await go(PIPELINE, { egress: "open" });
    const { listAudit } = await import("../src/db");
    const audit = await listAudit(db, scope);
    expect(audit[0]?.op).toBe("run_local");
    expect(audit[0]?.input).toContain('"egress":"open"');
  });
});
